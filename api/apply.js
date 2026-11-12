/*
 * POST /api/apply — receives VSL applications, stores them in Supabase and (optionally)
 * forwards them to the team's CRM or automation tool.
 *
 * Destinations, in order:
 *   1. Supabase  — the applications / application_events tables. Active as soon as the
 *                   Vercel ↔ Supabase integration has set SUPABASE_URL and a service-role key,
 *                   which is the normal case for this project. No extra configuration needed.
 *   2. Webhook   — only if APPLY_WEBHOOK_URL is set. Best-effort: a webhook failure does not
 *                   lose the application, because Supabase already has it.
 *
 * Environment variables (Vercel → Project → Settings → Environment Variables):
 *   SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL              set by the Supabase integration
 *   SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SECRET_KEY       set by the Supabase integration
 *   APPLY_WEBHOOK_URL            optional. Zapier / Make / n8n / CRM / Slack webhook.
 *   CORPORATE_WEBHOOK_URL        optional. Separate destination for corporate enquiries.
 *   APPLY_WEBHOOK_SECRET         optional. Sent as X-GTME-Secret so the receiver can reject forged posts.
 *   CAL_API_KEY                  Cal.com API key. When set, a "call_booked" report from the browser is
 *                                checked against Cal.com before it is stored (see api/_cal.js), and the
 *                                confirmed booking id, time and status are written to the row.
 *
 * Nothing secret ever reaches the browser. If neither Supabase nor a webhook is configured the
 * endpoint answers 503 and the page falls back to a pre-filled email.
 */
'use strict';

const store = require('./_supabase.js');
const cal = require('./_cal.js');

const LIMITS = { full_name: 120, email: 160, work_email: 160, phone: 30, company: 160, role: 80, experience: 40, hours: 40,
  investment: 120, why: 1500, goals: 1500, team_size: 40, motion: 80, timeline: 40,
  // individual multi-step application
  persona: 80, goal: 120, tried: 160, hours_ok: 20, invest: 80, start: 80, lead_id: 64, booking_time: 80, booking_ref: 120 };
/*
 * Individual applications arrive in stages, all with the same lead_id so a CRM can upsert one record:
 *   contact      step 1 only (name, email, phone) — saved the moment step 1 is completed, so abandoned forms can be followed up
 *   application  every question answered; carries qualified true/false
 *   call_booked  the qualified applicant booked a call on the confirmation page
 * Corporate enquiries are a single stage ("application").
 */
const REQUIRED = {
  individual: {
    contact: ['full_name', 'email', 'phone'],
    application: ['full_name', 'email', 'phone', 'persona', 'goal', 'tried', 'hours_ok', 'invest', 'start'],
    call_booked: ['email']
  },
  corporate: { application: ['full_name', 'work_email', 'company', 'role', 'team_size', 'motion', 'timeline', 'goals'] }
};
const STAGE_TO_LEAD_STAGE = { contact: 'started', call_booked: 'call_booked' };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE = /^\+?[0-9 ()\-]{7,20}$/;

function clean(v, max) { return typeof v === 'string' ? v.trim().slice(0, max) : ''; }

/** Validate and normalise a submission. Returns { ok, errors, data }. Exported for tests. */
function validate(body) {
  const errors = {};
  if (!body || typeof body !== 'object') return { ok: false, errors: { body: 'invalid' } };
  const funnel = body.funnel === 'corporate' ? 'corporate' : 'individual';
  const stages = REQUIRED[funnel];
  const stage = stages[body.stage] ? body.stage : 'application';
  const data = { funnel, stage };
  for (const k of Object.keys(LIMITS)) if (body[k] !== undefined) data[k] = clean(body[k], LIMITS[k]);
  for (const k of stages[stage]) if (!data[k]) errors[k] = 'required';
  const mail = funnel === 'corporate' ? 'work_email' : 'email';
  if (data[mail] && !EMAIL.test(data[mail])) errors[mail] = 'invalid';
  if (data.phone && !PHONE.test(data.phone)) errors.phone = 'invalid';
  if (funnel === 'corporate' && data.goals && data.goals.length < 30) errors.goals = 'too_short';
  if (stage !== 'call_booked' && body.consent !== true) errors.consent = 'required';
  data.consent = body.consent === true;
  data.qualified = body.qualified === true;
  // A single pipeline field for the CRM: started → qualified / not_qualified → call_booked
  data.lead_stage = STAGE_TO_LEAD_STAGE[stage] || (funnel === 'individual' ? (data.qualified ? 'qualified' : 'not_qualified') : 'enquiry');
  data.page = clean(body.page, 100);
  const a = body.attribution && typeof body.attribution === 'object' ? body.attribution : {};
  data.attribution = {};
  for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid', 'wbraid', 'gbraid', 'landing_page', 'referrer'])
    if (typeof a[k] === 'string') data.attribution[k] = a[k].slice(0, 300);
  return { ok: Object.keys(errors).length === 0, errors, data };
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ ok: false, error: 'method_not_allowed' }); }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  // Honeypot: bots fill the hidden "website" field. Pretend success, forward nothing.
  if (body && typeof body.website === 'string' && body.website.trim()) return res.status(200).json({ ok: true });

  const v = validate(body);
  if (!v.ok) return res.status(400).json({ ok: false, error: 'validation', fields: v.errors, message: 'Some fields need attention. Please check the form and try again.' });

  const url = (v.data.funnel === 'corporate' && process.env.CORPORATE_WEBHOOK_URL) || process.env.APPLY_WEBHOOK_URL;
  const toDatabase = store.isConfigured();
  // Nowhere to put it: let the page fall back to a pre-filled email rather than silently dropping it.
  if (!toDatabase && !url) return res.status(503).json({ ok: false, error: 'not_configured' });

  // A booking reported by the browser is only a hint. Confirm it with Cal.com before storing it.
  let confirmed = null;
  if (v.data.funnel === 'individual' && v.data.stage === 'call_booked') {
    const check = await confirmBooking(v.data);
    if (check.reject) {
      console.warn('[apply] call_booked rejected:', check.reject, v.data.lead_id || '-');
      return res.status(400).json({ ok: false, error: 'booking_not_verified', message: 'We couldn’t confirm that booking with the calendar.' });
    }
    if (check.booking) {
      confirmed = check.booking;
      v.data.booking_time = confirmed.start || v.data.booking_time;
      v.data.booking_ref = confirmed.uid;
      v.data.lead_stage = cal.leadStageFor(confirmed.status) || v.data.lead_stage;
    }
  }

  const meta = {
    submitted_at: new Date().toISOString(),
    user_agent: String(req.headers['user-agent'] || '').slice(0, 300)
  };
  const payload = Object.assign({}, v.data, meta);

  const [saved, forwarded] = await Promise.all([
    toDatabase ? store.save(v.data, meta) : Promise.resolve(null),
    url ? forward(url, payload) : Promise.resolve(null)
  ]);

  if (saved && !saved.ok) console.error('[apply] supabase save failed:', saved.status, saved.error);
  if (confirmed && saved && saved.ok) {
    const synced = await store.applyBooking(saved.lead_id, confirmed, {
      source: 'api', trigger: 'browser_report', eventAt: confirmed.updated_at || meta.submitted_at, leadStage: cal.leadStageFor(confirmed.status)
    });
    if (!synced.ok) console.error('[apply] booking sync failed:', synced.status, synced.error);
  }
  if (forwarded && !forwarded.ok) console.error('[apply] forward failed:', forwarded.error);

  // The application is safe if any destination we actually tried accepted it. Only ask the
  // applicant to retry when every configured destination failed.
  const attempted = [saved, forwarded].filter(Boolean);
  if (!attempted.some(function (r) { return r.ok; })) {
    return res.status(502).json({ ok: false, error: 'upstream', message: 'We couldn’t save your application just now. Please try again in a minute, or email hello@gtme.school.' });
  }
  return res.status(200).json({
    ok: true,
    stage: v.data.stage,
    qualified: v.data.qualified,
    lead_id: (saved && saved.lead_id) || v.data.lead_id || undefined,
    stored: Boolean(saved && saved.ok),
    booking_confirmed: confirmed ? true : undefined
  });
}

/*
 * Check a browser-reported booking against the Cal.com API.
 *   { booking }  Cal.com has it and it belongs to this applicant (same email, or our lead_id in its
 *                metadata) → store Cal.com's own id, time and status
 *   { reject }   Cal.com says no such booking, or it is someone else's / another event's → 400
 *   {}           can't check (no CAL_API_KEY, no uid, Cal.com unreachable) → store the report as
 *                before; the webhook will write the confirmed details when it arrives
 */
async function confirmBooking(data) {
  if (!cal.hasApi() || !data.booking_ref) return {};
  const r = await cal.getBooking(data.booking_ref);
  if (!r.ok) {
    if (r.status === 404 || r.status === 400) return { reject: 'not_found' };
    console.error('[apply] cal.com lookup failed:', r.status, r.error);
    return {};
  }
  const b = r.booking;
  if (!cal.isOurEvent(b.event_type)) return { reject: 'other_event_type' };
  const sameEmail = b.attendee_email && data.email && b.attendee_email === data.email.trim().toLowerCase();
  const sameLead = data.lead_id && b.metadata && b.metadata.lead_id === data.lead_id;
  if (!sameEmail && !sameLead) return { reject: 'not_this_applicant' };
  return { booking: b };
}

/** Best-effort POST to the team's webhook. Never throws. */
async function forward(url, payload) {
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.APPLY_WEBHOOK_SECRET) headers['X-GTME-Secret'] = process.env.APPLY_WEBHOOK_SECRET;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: ctrl.signal });
    if (!r.ok) return { ok: false, error: 'webhook ' + r.status };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'webhook unreachable' };
  } finally {
    clearTimeout(t);
  }
}

module.exports = handler;
module.exports.validate = validate;
