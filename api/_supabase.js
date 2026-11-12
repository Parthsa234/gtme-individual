/*
 * Supabase persistence for /api/apply.
 *
 * Uses the PostgREST HTTP API with the service-role key, so there is no npm dependency and no
 * build step — the same shape as the rest of this project. The credentials are read from the
 * environment variables the Vercel <-> Supabase integration already set on this project:
 *
 *   SUPABASE_URL              (or NEXT_PUBLIC_SUPABASE_URL)   e.g. https://xxxx.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY)        server-side only, never sent to the browser
 *
 * Two tables (see supabase/migrations/0001_applications.sql):
 *   applications        one row per applicant, keyed on lead_id, updated as they move through the stages
 *   application_events  append-only log of every POST, so nothing is ever overwritten or lost
 *
 * Row Level Security is on with no policies, so the anon key the browser holds cannot read or
 * write either table. Only this function (service role) and the Supabase dashboard can.
 */
'use strict';

const crypto = require('crypto');
const TIMEOUT_MS = 8000;

function baseUrl() {
  const u = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  return u.trim().replace(/\/+$/, '');
}
function serviceKey() {
  return (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '').trim();
}

/** True when this deployment can write to Supabase. */
function isConfigured() {
  return Boolean(baseUrl() && serviceKey());
}

/* The browser always sends a lead_id. If one is ever missing (a direct POST, a cleared session),
   derive a stable id from the email address so repeat submissions from the same person still
   merge onto one row instead of creating orphans. */
function fallbackLeadId(data) {
  const mail = String(data.email || data.work_email || '').trim().toLowerCase();
  if (mail) return 'lead-email-' + crypto.createHash('sha1').update(mail).digest('hex').slice(0, 24);
  return 'lead-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
}

/* Submission fields that map straight onto table columns. `start` is renamed to `start_when`
   because a bare "start" column reads badly in SQL; every other column keeps the form's own
   field name so the Supabase table explains itself. */
const DIRECT = ['funnel', 'stage', 'lead_stage', 'full_name', 'email', 'phone', 'work_email', 'company',
  'role', 'team_size', 'motion', 'timeline', 'goals', 'why', 'experience', 'hours', 'investment',
  'persona', 'goal', 'tried', 'hours_ok', 'invest', 'booking_time', 'booking_ref', 'page'];
const ATTRIBUTION = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'fbclid', 'gclid', 'wbraid', 'gbraid', 'landing_page', 'referrer'];
const STAGE_TIMESTAMP = { contact: 'contact_at', application: 'applied_at', call_booked: 'booked_at' };

/** Build the `applications` row for one validated submission. Exported for tests. */
function toRow(data, meta) {
  const m = meta || {};
  const row = { lead_id: data.lead_id || fallbackLeadId(data), updated_at: m.submitted_at || new Date().toISOString() };
  for (const k of DIRECT) if (data[k] !== undefined && data[k] !== '') row[k] = data[k];
  if (data.start !== undefined && data.start !== '') row.start_when = data.start;
  if (data.consent !== undefined) row.consent = data.consent;
  // A booked call says nothing new about qualification, so only the stages that decide it write it.
  if (data.stage === 'application') row.qualified = data.qualified;
  const a = (data.attribution && typeof data.attribution === 'object') ? data.attribution : {};
  for (const k of ATTRIBUTION) if (a[k]) row[k] = a[k];
  if (Object.keys(a).length) row.attribution = a;
  if (m.user_agent) row.user_agent = m.user_agent;
  const ts = STAGE_TIMESTAMP[data.stage];
  if (ts) row[ts] = row.updated_at;
  return row;
}

async function request(path, body, prefer, method) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const m = method || 'POST';
  const headers = { apikey: serviceKey(), Authorization: 'Bearer ' + serviceKey(), Accept: 'application/json' };
  if (m !== 'GET') headers['Content-Type'] = 'application/json';
  if (prefer) headers.Prefer = prefer;
  try {
    const r = await fetch(baseUrl() + '/rest/v1/' + path, {
      method: m,
      headers,
      body: m === 'GET' ? undefined : JSON.stringify(body),
      signal: ctrl.signal
    });
    if (r.ok) {
      // Only reads and return=representation writes carry a body worth parsing.
      let data = null;
      if (m === 'GET' || /return=representation/.test(prefer || '')) data = await r.json().catch(function () { return null; });
      return { ok: true, status: r.status, data };
    }
    const detail = await r.text().catch(function () { return ''; });
    return { ok: false, status: r.status, error: String(detail).slice(0, 400) };
  } catch (e) {
    return { ok: false, status: 0, error: (e && e.message) || 'request failed' };
  } finally {
    clearTimeout(t);
  }
}

function eq(v) { return 'eq.' + encodeURIComponent(String(v)); }

/** First row of applications matching a PostgREST filter, or null. { ok, row }. */
async function findOne(filter, columns) {
  const r = await request('applications?select=' + (columns || 'lead_id') + '&' + filter + '&order=created_at.desc&limit=1', null, null, 'GET');
  if (!r.ok) return { ok: false, status: r.status, error: r.error };
  return { ok: true, row: Array.isArray(r.data) && r.data.length ? r.data[0] : null };
}

/*
 * Which row a submission belongs to. Duplicate protection across sessions: the browser keeps one
 * lead_id per tab session, so the same person applying again from another device or a new tab
 * would otherwise get a second row. Order:
 *   1. a row with this lead_id already exists      → that row
 *   2. a row in the same funnel with the same email → that row (the repeat is merged onto it)
 *   3. otherwise                                    → this lead_id (a new row)
 * Lookups that fail (Supabase down, migration 0002 not applied yet) fall through to 3, so a
 * submission is never lost because the de-duplication could not run.
 */
async function resolveLeadId(data) {
  const own = data.lead_id || '';
  const mail = String(data.email || data.work_email || '').trim().toLowerCase();
  if (own) {
    const byId = await findOne('lead_id=' + eq(own));
    if (byId.ok && byId.row) return { lead_id: own, merged: false };
  }
  if (mail && data.funnel) {
    const byEmail = await findOne('funnel=' + eq(data.funnel) + '&email_lower=' + eq(mail));
    if (byEmail.ok && byEmail.row) return { lead_id: byEmail.row.lead_id, merged: byEmail.row.lead_id !== own };
  }
  return { lead_id: own || fallbackLeadId(data), merged: false };
}

/**
 * Save one submission:
 *   - upsert the applicant into `applications` on lead_id, so step 1, the full application and the
 *     booked call all land on a single row that reads top to bottom
 *   - append the whole payload to `application_events`, which is never updated or deleted
 * Returns { ok, lead_id, error, status }. A failed event log is logged but does not fail the save.
 */
async function save(data, meta) {
  if (!isConfigured()) return { ok: false, error: 'not_configured' };
  const resolved = await resolveLeadId(data);
  const row = toRow(Object.assign({}, data, { lead_id: resolved.lead_id }), meta);

  const upsert = await request('applications?on_conflict=lead_id', row, 'resolution=merge-duplicates,return=minimal');
  if (!upsert.ok) return { ok: false, lead_id: row.lead_id, status: upsert.status, error: upsert.error };

  const logged = await request('application_events', {
    lead_id: row.lead_id,
    funnel: data.funnel,
    stage: data.stage,
    lead_stage: data.lead_stage,
    payload: Object.assign({}, data, meta, resolved.merged ? { merged_from_lead_id: data.lead_id || null } : {})
  }, 'return=minimal');
  if (!logged.ok) console.error('[apply] event log failed:', logged.status, logged.error);

  return { ok: true, lead_id: row.lead_id, merged: resolved.merged };
}

/* ------------------------------------------------------------------ Cal.com booking sync */

const BOOKING_COLUMNS = 'lead_id,funnel,email,cal_booking_uid,booking_status,booking_event_at';

/**
 * The application a Cal.com booking belongs to. Tried in order of certainty:
 *   lead_id from the booking metadata (set by our embed) → the booking uid (or, for a reschedule,
 *   the uid it replaced) → the attendee's email, newest individual application first.
 * Returns { ok, row } with row null when nothing matches.
 */
async function findForBooking(b, hintLeadId) {
  const ids = [hintLeadId, b.metadata && b.metadata.lead_id].filter(Boolean);
  for (const id of ids) {
    const r = await findOne('lead_id=' + eq(id), BOOKING_COLUMNS);
    if (!r.ok) return r;
    if (r.row) return r;
  }
  for (const uid of [b.uid, b.previous_uid].filter(Boolean)) {
    const r = await findOne('cal_booking_uid=' + eq(uid), BOOKING_COLUMNS);
    if (!r.ok) return r;
    if (r.row) return r;
  }
  if (b.attendee_email) {
    const r = await findOne('funnel=eq.individual&email_lower=' + eq(b.attendee_email), BOOKING_COLUMNS);
    if (!r.ok) return r;
    if (r.row) return r;
  }
  return { ok: true, row: null };
}

/** The columns a booking writes onto its application row. */
function bookingRow(b, opts) {
  const o = opts || {};
  const row = {
    cal_booking_id: b.id,
    cal_booking_uid: b.uid,
    cal_event_type: b.event_type,
    booking_start: b.start,
    booking_end: b.end,
    booking_status: b.status,
    booking_cancel_reason: b.status === 'cancelled' || b.status === 'rejected' ? (b.cancel_reason || null) : null,
    booking_event_at: o.eventAt,
    booking_source: o.source,
    booking_last_trigger: o.trigger || null,
    booking_time: b.start,       // the older text columns stay in step for anything already reading them
    booking_ref: b.uid,
    updated_at: new Date().toISOString()
  };
  const stage = o.leadStage;
  if (stage) row.lead_stage = stage;
  if (b.status === 'accepted' && b.start) row.booked_at = o.bookedAt || o.eventAt;
  for (const k of Object.keys(row)) if (row[k] === undefined) delete row[k];
  return row;
}

/*
 * Write a booking onto an application row, only if it is at least as new as what is stored.
 * The filter makes the check and the write one atomic statement, so concurrent deliveries (the
 * browser report and the webhook for the same booking) and late re-deliveries cannot roll a
 * newer state back. Returns { ok, updated } where updated=false means a newer state was kept.
 */
async function applyBooking(leadId, b, opts) {
  if (!isConfigured()) return { ok: false, error: 'not_configured' };
  const row = bookingRow(b, opts);
  const guard = 'or=' + encodeURIComponent('(booking_event_at.is.null,booking_event_at.lte."' + opts.eventAt + '")');
  const r = await request('applications?lead_id=' + eq(leadId) + '&' + guard, row, 'return=representation', 'PATCH');
  if (!r.ok) return { ok: false, status: r.status, error: r.error };
  return { ok: true, updated: Array.isArray(r.data) && r.data.length > 0 };
}

/* A booking we cannot tie to any application (someone booked from the bare Cal.com link without
   applying). It still gets a row, keyed on their email, so no booking is ever missing from the
   database; if they apply later the form merges onto this same row by email. */
async function createFromBooking(b, opts) {
  const leadId = fallbackLeadId({ email: b.attendee_email || '' });
  const m = b.metadata || {};
  const row = Object.assign({
    lead_id: leadId,
    funnel: 'individual',
    stage: 'call_booked',
    full_name: b.attendee_name || undefined,
    email: b.attendee_email || undefined,
    page: 'cal.com'
  }, bookingRow(b, opts));
  for (const k of ATTRIBUTION) if (m[k]) row[k] = m[k];
  for (const k of Object.keys(row)) if (row[k] === undefined) delete row[k];
  const r = await request('applications?on_conflict=lead_id', row, 'resolution=merge-duplicates,return=minimal');
  if (!r.ok) return { ok: false, status: r.status, error: r.error };
  return { ok: true, lead_id: leadId };
}

/**
 * Append to application_events. With a dedupe_key, a second delivery of the same event is
 * dropped by the unique index and reported as { duplicate: true }.
 */
async function logEvent(entry, dedupeKey) {
  if (!isConfigured()) return { ok: false, error: 'not_configured' };
  const body = Object.assign({}, entry, dedupeKey ? { dedupe_key: dedupeKey } : {});
  if (!dedupeKey) return request('application_events', body, 'return=minimal');
  const r = await request('application_events?on_conflict=dedupe_key', body, 'resolution=ignore-duplicates,return=representation');
  if (!r.ok) return r;
  return { ok: true, duplicate: !(Array.isArray(r.data) && r.data.length) };
}

/** Non-personal booking-sync columns of one row, for the guarded check in /api/migrate. */
async function syncStatus(leadId) {
  return findOne('lead_id=' + eq(leadId), 'lead_id,funnel,stage,lead_stage,qualified,utm_source,utm_medium,utm_campaign,utm_term,utm_content,' +
    'cal_booking_id,cal_booking_uid,cal_event_type,booking_start,booking_end,booking_status,booking_source,booking_last_trigger,booking_event_at,booked_at,created_at,updated_at');
}

module.exports = { isConfigured, save, toRow, resolveLeadId, fallbackLeadId, findForBooking, applyBooking, createFromBooking, logEvent, bookingRow, syncStatus };
