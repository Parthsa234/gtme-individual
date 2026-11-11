'use strict';
/*
 * Cal.com ↔ Supabase booking sync: /api/apply (browser report, checked against the Cal.com API)
 * and /api/cal-webhook (signed Cal.com deliveries). Supabase and the Cal.com API are replaced by
 * an in-memory fake that understands the PostgREST requests these handlers make.
 */
const test = require('node:test'), assert = require('node:assert');
const crypto = require('crypto');
const { Readable } = require('stream');
const apply = require('../api/apply.js');
const webhook = require('../api/cal-webhook.js');

const SECRET = 'whsec_test_secret_value';
process.env.SUPABASE_URL = 'https://proj.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
process.env.CAL_API_KEY = 'cal_test_key';
process.env.CAL_WEBHOOK_SECRET = SECRET;
delete process.env.APPLY_WEBHOOK_URL;

/* ------------------------------------------------------------------ fakes */
let db, calBookings, calCalls;
function reset() { db = { applications: [], application_events: [] }; calBookings = {}; calCalls = 0; }

function filterRows(rows, params) {
  return rows.filter(r => {
    for (const [k, v] of params) {
      if (['select', 'order', 'limit', 'on_conflict'].includes(k)) continue;
      if (k === 'or') {
        // only the guard form: (booking_event_at.is.null,booking_event_at.lte."<iso>")
        const m = v.match(/^\(booking_event_at\.is\.null,booking_event_at\.lte\."(.+)"\)$/);
        assert.ok(m, 'unexpected or= filter ' + v);
        if (!(r.booking_event_at == null || r.booking_event_at <= m[1])) return false;
        continue;
      }
      assert.ok(v.startsWith('eq.'), 'unexpected filter ' + k + '=' + v);
      if (String(r[k]) !== v.slice(3)) return false;
    }
    return true;
  });
}
function withGenerated(row) { row.email_lower = row.email ? row.email.toLowerCase() : null; return row; }

global.fetch = async (url, opts) => {
  const u = new URL(String(url));
  const method = (opts && opts.method) || 'GET';
  const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

  if (u.hostname === 'api.cal.com') {
    calCalls++;
    assert.equal(opts.headers.Authorization, 'Bearer cal_test_key');
    const uid = decodeURIComponent(u.pathname.split('/').pop());
    return calBookings[uid] ? json(200, { status: 'success', data: calBookings[uid] }) : json(404, { status: 'error' });
  }
  assert.equal(u.hostname, 'proj.supabase.co');
  assert.equal(opts.headers.apikey, 'service-role-key');
  const table = u.pathname.split('/').pop();
  const rows = db[table];
  const params = [...u.searchParams.entries()];
  const prefer = (opts.headers && opts.headers.Prefer) || '';

  if (method === 'GET') {
    let out = filterRows(rows, params).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    const lim = u.searchParams.get('limit'); if (lim) out = out.slice(0, +lim);
    return json(200, out.map(r => Object.assign({}, r)));
  }
  const body = JSON.parse(opts.body);
  if (method === 'PATCH') {
    const hit = filterRows(rows, params);
    hit.forEach(r => withGenerated(Object.assign(r, body)));
    return json(200, hit.map(r => Object.assign({}, r)));
  }
  // POST (insert / upsert)
  const conflict = u.searchParams.get('on_conflict');
  if (conflict) {
    const existing = rows.find(r => r[conflict] != null && r[conflict] === body[conflict]);
    if (existing) {
      if (/ignore-duplicates/.test(prefer)) return json(201, []);
      withGenerated(Object.assign(existing, body));
      return json(201, [existing]);
    }
  }
  const row = withGenerated(Object.assign({ created_at: new Date(Date.now() + rows.length).toISOString() }, body));
  rows.push(row);
  return json(201, [row]);
};

function mockRes() {
  const r = { code: 0, body: null, headers: {} };
  r.status = c => { r.code = c; return r; };
  r.json = o => { r.body = o; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.end = s => { r.body = s ? JSON.parse(s) : null; };
  Object.defineProperty(r, 'statusCode', { set(c) { r.code = c; }, get() { return r.code; } });
  return r;
}
async function post(body) { const res = mockRes(); await apply({ method: 'POST', body, headers: {} }, res); return res; }
async function deliver(obj, opts) {
  const o = opts || {};
  const raw = Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj));
  const sig = o.sig !== undefined ? o.sig : crypto.createHmac('sha256', o.secret || SECRET).update(raw).digest('hex');
  const req = Readable.from([raw]); req.method = 'POST'; req.headers = sig ? { 'x-cal-signature-256': sig } : {};
  const res = mockRes(); await webhook(req, res); return res;
}

const LEAD = 'lead-abc-123';
const application = { funnel: 'individual', stage: 'application', lead_id: LEAD, full_name: 'Asha Rao', email: 'Asha@Example.com', phone: '+91 98765 43210',
  persona: 'Founder', goal: 'First clients', tried: 'Nothing yet', hours_ok: 'Yes', invest: 'Yes', start: 'Next cohort', consent: true, qualified: true,
  attribution: { utm_source: 'meta', utm_medium: 'paid_social', utm_campaign: 'nov_launch', utm_term: 'gtm engineer', utm_content: 'vsl_a', fbclid: 'fb.1' } };
function calBooking(over) {
  return Object.assign({ id: 9001, uid: 'uidAAA111', status: 'accepted', start: '2026-11-20T10:00:00.000Z', end: '2026-11-20T10:40:00.000Z',
    eventType: { id: 7791132, slug: 'gtme-school' }, attendees: [{ name: 'Asha Rao', email: 'asha@example.com' }],
    metadata: { lead_id: LEAD, utm_source: 'meta' }, createdAt: '2026-11-11T09:00:00.000Z', updatedAt: '2026-11-11T09:00:00.000Z' }, over || {});
}
function hook(trigger, over, createdAt) {
  return { triggerEvent: trigger, createdAt: createdAt || '2026-11-11T09:00:05.000Z', payload: Object.assign({ bookingId: 9001, uid: 'uidAAA111', type: 'gtme-school',
    status: 'ACCEPTED', startTime: '2026-11-20T10:00:00.000Z', endTime: '2026-11-20T10:40:00.000Z',
    attendees: [{ name: 'Asha Rao', email: 'asha@example.com' }], metadata: { lead_id: LEAD } }, over || {}) };
}
const row = () => db.applications.find(r => r.lead_id === LEAD);

/* ------------------------------------------------------------------ application + UTMs */

test('the application and all five UTM parameters are stored on one row', async () => {
  reset();
  assert.equal((await post(application)).code, 200);
  const r = row();
  assert.equal(r.full_name, 'Asha Rao');
  for (const [k, v] of Object.entries({ utm_source: 'meta', utm_medium: 'paid_social', utm_campaign: 'nov_launch', utm_term: 'gtm engineer', utm_content: 'vsl_a' })) assert.equal(r[k], v, k);
  assert.equal(r.lead_stage, 'qualified');
});

test('a repeat application from the same email (new session, new lead_id) merges onto the first row', async () => {
  reset();
  await post(application);
  const res = await post(Object.assign({}, application, { lead_id: 'lead-other-session', email: 'asha@example.com' }));
  assert.equal(res.code, 200);
  assert.equal(res.body.lead_id, LEAD, 'the browser is told the canonical lead_id');
  assert.equal(db.applications.length, 1);
  assert.equal(db.application_events.at(-1).payload.merged_from_lead_id, 'lead-other-session');
});

/* ------------------------------------------------------------------ browser report → Cal.com API */

test('a browser-reported booking is confirmed with Cal.com and its id, time and status are stored', async () => {
  reset();
  await post(application);
  calBookings.uidAAA111 = calBooking();
  const res = await post({ funnel: 'individual', stage: 'call_booked', lead_id: LEAD, email: 'asha@example.com', booking_ref: 'uidAAA111', booking_time: 'whatever the browser says' });
  assert.equal(res.code, 200); assert.equal(res.body.booking_confirmed, true);
  const r = row();
  assert.equal(r.cal_booking_id, 9001);
  assert.equal(r.cal_booking_uid, 'uidAAA111');
  assert.equal(r.booking_start, '2026-11-20T10:00:00.000Z');
  assert.equal(r.booking_end, '2026-11-20T10:40:00.000Z');
  assert.equal(r.booking_status, 'accepted');
  assert.equal(r.booking_time, '2026-11-20T10:00:00.000Z', 'Cal.com time wins over the browser value');
  assert.equal(r.lead_stage, 'call_booked');
  assert.equal(r.booking_source, 'api');
  assert.equal(r.utm_campaign, 'nov_launch', 'UTMs survive the booking update');
});

test('a forged booking report (uid unknown to Cal.com) is rejected and changes nothing', async () => {
  reset();
  await post(application);
  const res = await post({ funnel: 'individual', stage: 'call_booked', lead_id: LEAD, email: 'asha@example.com', booking_ref: 'uidFORGED1' });
  assert.equal(res.code, 400); assert.equal(res.body.error, 'booking_not_verified');
  assert.equal(row().lead_stage, 'qualified'); assert.equal(row().cal_booking_id, undefined);
});

test('a real booking belonging to someone else cannot be claimed', async () => {
  reset();
  await post(application);
  calBookings.uidBBB222 = calBooking({ uid: 'uidBBB222', attendees: [{ email: 'someone@else.com' }], metadata: {} });
  const res = await post({ funnel: 'individual', stage: 'call_booked', lead_id: LEAD, email: 'asha@example.com', booking_ref: 'uidBBB222' });
  assert.equal(res.code, 400);
});

/* ------------------------------------------------------------------ webhook */

test('webhook: unsigned or wrongly signed deliveries get 401 and change nothing', async () => {
  reset();
  await post(application);
  assert.equal((await deliver(hook('BOOKING_CREATED'), { sig: '' })).code, 401);
  assert.equal((await deliver(hook('BOOKING_CREATED'), { secret: 'wrong' })).code, 401);
  assert.equal(row().cal_booking_id, undefined);
});

test('webhook: 503 (not an open door) when CAL_WEBHOOK_SECRET is unset', async () => {
  reset();
  delete process.env.CAL_WEBHOOK_SECRET;
  try { assert.equal((await deliver(hook('BOOKING_CREATED'))).code, 503); } finally { process.env.CAL_WEBHOOK_SECRET = SECRET; }
});

test('webhook: PING and unrelated triggers are acknowledged without writing', async () => {
  reset();
  assert.equal((await deliver({ triggerEvent: 'PING', payload: {} })).body.ping, true);
  assert.equal((await deliver(hook('MEETING_STARTED'))).body.ignored, true);
  assert.equal((await deliver(hook('BOOKING_CREATED', { type: '30min' }))).body.ignored, true);
  assert.equal(db.applications.length, 0);
});

test('webhook: BOOKING_CREATED syncs the booking onto the application found by metadata lead_id', async () => {
  reset();
  await post(application);
  calBookings.uidAAA111 = calBooking();
  const res = await deliver(hook('BOOKING_CREATED'));
  assert.equal(res.code, 200); assert.equal(res.body.updated, true);
  const r = row();
  assert.equal(r.cal_booking_id, 9001); assert.equal(r.booking_status, 'accepted'); assert.equal(r.lead_stage, 'call_booked');
  assert.equal(r.booking_source, 'webhook+api'); assert.equal(r.booking_last_trigger, 'BOOKING_CREATED'); assert.ok(r.booked_at);
});

test('webhook: falls back to the attendee email when the booking carries no lead_id', async () => {
  reset();
  await post(application);
  calBookings.uidAAA111 = calBooking({ metadata: {} });
  await deliver(hook('BOOKING_CREATED', { metadata: {} }));
  assert.equal(row().cal_booking_uid, 'uidAAA111');
});

test('webhook: the same delivery twice is logged once and leaves the row unchanged', async () => {
  reset();
  await post(application);
  calBookings.uidAAA111 = calBooking();
  await deliver(hook('BOOKING_CREATED'));
  const before = JSON.stringify(row());
  const again = await deliver(hook('BOOKING_CREATED'));
  assert.equal(again.code, 200); assert.equal(again.body.duplicate, true);
  assert.equal(db.application_events.filter(e => e.stage === 'cal_booking_created').length, 1);
  assert.equal(JSON.stringify(row()).replace(/"updated_at":"[^"]+"/, ''), before.replace(/"updated_at":"[^"]+"/, ''));
});

test('webhook: reschedule moves the row to the new uid and time; a late, older CREATED cannot roll it back', async () => {
  reset();
  await post(application);
  calBookings.uidAAA111 = calBooking({ status: 'cancelled' });
  calBookings.uidCCC333 = calBooking({ id: 9002, uid: 'uidCCC333', start: '2026-11-22T12:00:00.000Z', end: '2026-11-22T12:40:00.000Z', rescheduledFromUid: 'uidAAA111' });
  const res = await deliver(hook('BOOKING_RESCHEDULED', { bookingId: 9002, uid: 'uidCCC333', rescheduleUid: 'uidAAA111', startTime: '2026-11-22T12:00:00.000Z' }, '2026-11-11T10:00:00.000Z'));
  assert.equal(res.body.updated, true);
  assert.equal(row().cal_booking_uid, 'uidCCC333'); assert.equal(row().booking_start, '2026-11-22T12:00:00.000Z'); assert.equal(row().cal_booking_id, 9002);
  // the original CREATED arrives late (older createdAt)
  const late = await deliver(hook('BOOKING_CREATED', {}, '2026-11-11T09:00:05.000Z'));
  assert.equal(late.body.updated, false);
  assert.equal(row().cal_booking_uid, 'uidCCC333');
});

test('webhook: cancellation marks the booking cancelled with the reason', async () => {
  reset();
  await post(application);
  calBookings.uidAAA111 = calBooking();
  await deliver(hook('BOOKING_CREATED'));
  calBookings.uidAAA111 = calBooking({ status: 'cancelled', cancellationReason: 'Clash' });
  await deliver(hook('BOOKING_CANCELLED', { status: 'CANCELLED', cancellationReason: 'Clash' }, '2026-11-12T08:00:00.000Z'));
  assert.equal(row().booking_status, 'cancelled'); assert.equal(row().lead_stage, 'call_cancelled'); assert.equal(row().booking_cancel_reason, 'Clash');
});

test('webhook: uses the webhook body when the Cal.com API is unavailable', async () => {
  reset();
  await post(application);
  delete process.env.CAL_API_KEY;
  try {
    await deliver(hook('BOOKING_CREATED'));
    assert.equal(row().cal_booking_id, 9001); assert.equal(row().booking_source, 'webhook');
  } finally { process.env.CAL_API_KEY = 'cal_test_key'; }
});

test('webhook: a booking with no application (bare Cal.com link) still gets a row, with its UTM metadata', async () => {
  reset();
  calBookings.uidDDD444 = calBooking({ uid: 'uidDDD444', attendees: [{ name: 'Walk In', email: 'walkin@example.com' }], metadata: { utm_source: 'google', utm_campaign: 'brand' } });
  const res = await deliver(hook('BOOKING_CREATED', { uid: 'uidDDD444', attendees: [{ name: 'Walk In', email: 'walkin@example.com' }], metadata: {} }));
  assert.equal(res.body.created, true);
  const r = db.applications[0];
  assert.equal(r.email, 'walkin@example.com'); assert.equal(r.cal_booking_uid, 'uidDDD444'); assert.equal(r.utm_source, 'google'); assert.equal(r.lead_stage, 'call_booked');
  // applying later merges onto that row by email
  const later = await post(Object.assign({}, application, { lead_id: 'lead-new', email: 'walkin@example.com' }));
  assert.equal(later.body.lead_id, r.lead_id); assert.equal(db.applications.length, 1);
});

test('the browser report and the webhook for the same booking converge on one consistent row', async () => {
  reset();
  await post(application);
  calBookings.uidAAA111 = calBooking();
  await Promise.all([
    deliver(hook('BOOKING_CREATED')),
    post({ funnel: 'individual', stage: 'call_booked', lead_id: LEAD, email: 'asha@example.com', booking_ref: 'uidAAA111' })
  ]);
  assert.equal(db.applications.length, 1);
  assert.equal(row().cal_booking_id, 9001); assert.equal(row().booking_status, 'accepted');
});
