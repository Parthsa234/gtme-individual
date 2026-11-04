/*
 * POST /api/apply — receives VSL applications and forwards them to the team's system.
 *
 * Environment variables (set in Vercel → Project → Settings → Environment Variables):
 *   APPLY_WEBHOOK_URL            required. Where applications are sent (Zapier, Make, n8n, a CRM webhook, Slack…).
 *   CORPORATE_WEBHOOK_URL        optional. Separate destination for /corporate-vsl enquiries. Falls back to APPLY_WEBHOOK_URL.
 *   APPLY_WEBHOOK_SECRET         optional. Sent as the X-GTME-Secret header so the receiver can reject forged requests.
 *
 * Nothing secret ever reaches the browser. Without APPLY_WEBHOOK_URL the endpoint answers 503
 * and the page falls back to a pre-filled email.
 */
'use strict';

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
  if (!url) return res.status(503).json({ ok: false, error: 'not_configured' });

  const payload = Object.assign({}, v.data, {
    submitted_at: new Date().toISOString(),
    user_agent: String(req.headers['user-agent'] || '').slice(0, 300)
  });
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.APPLY_WEBHOOK_SECRET) headers['X-GTME-Secret'] = process.env.APPLY_WEBHOOK_SECRET;

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) throw new Error('webhook ' + r.status);
    return res.status(200).json({ ok: true, stage: v.data.stage, qualified: v.data.qualified });
  } catch (e) {
    console.error('[apply] forward failed:', e && e.message);
    return res.status(502).json({ ok: false, error: 'upstream', message: 'We couldn’t save your application just now. Please try again in a minute, or email hello@gtme.school.' });
  }
}

module.exports = handler;
module.exports.validate = validate;
