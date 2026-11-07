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

async function request(path, body, prefer) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(baseUrl() + '/rest/v1/' + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: serviceKey(),
        Authorization: 'Bearer ' + serviceKey(),
        Prefer: prefer
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    if (r.ok) return { ok: true, status: r.status };
    const detail = await r.text().catch(function () { return ''; });
    return { ok: false, status: r.status, error: String(detail).slice(0, 400) };
  } catch (e) {
    return { ok: false, status: 0, error: (e && e.message) || 'request failed' };
  } finally {
    clearTimeout(t);
  }
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
  const row = toRow(data, meta);

  const upsert = await request('applications?on_conflict=lead_id', row, 'resolution=merge-duplicates,return=minimal');
  if (!upsert.ok) return { ok: false, lead_id: row.lead_id, status: upsert.status, error: upsert.error };

  const logged = await request('application_events', {
    lead_id: row.lead_id,
    funnel: data.funnel,
    stage: data.stage,
    lead_stage: data.lead_stage,
    payload: Object.assign({}, data, meta)
  }, 'return=minimal');
  if (!logged.ok) console.error('[apply] event log failed:', logged.status, logged.error);

  return { ok: true, lead_id: row.lead_id };
}

/**
 * Read one applicant by lead_id, for the personalised booking link (/api/book).
 * Selects only the columns the link needs. Returns { ok, lead } where lead is null when no row
 * matches, or { ok:false, status, error } when Supabase could not be read.
 */
async function getLead(leadId) {
  if (!isConfigured()) return { ok: false, error: 'not_configured' };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const path = 'applications?select=lead_id,funnel,full_name,email,phone,qualified,lead_stage,booked_at' +
    '&lead_id=eq.' + encodeURIComponent(leadId) + '&limit=1';
  try {
    const r = await fetch(baseUrl() + '/rest/v1/' + path, {
      method: 'GET',
      headers: { apikey: serviceKey(), Authorization: 'Bearer ' + serviceKey(), Accept: 'application/json' },
      signal: ctrl.signal
    });
    if (!r.ok) {
      const detail = await r.text().catch(function () { return ''; });
      return { ok: false, status: r.status, error: String(detail).slice(0, 400) };
    }
    const rows = await r.json();
    return { ok: true, lead: Array.isArray(rows) && rows.length ? rows[0] : null };
  } catch (e) {
    return { ok: false, status: 0, error: (e && e.message) || 'request failed' };
  } finally {
    clearTimeout(t);
  }
}

module.exports = { isConfigured, save, toRow, getLead, fallbackLeadId };
