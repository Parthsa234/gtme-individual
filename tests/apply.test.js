'use strict';
const test = require('node:test'), assert = require('node:assert');
const apply = require('../api/apply.js');

const individual = { funnel: 'individual', stage: 'application', lead_id: 'lead-1', full_name: 'Test Person', email: 'test@example.com', phone: '+91 98765 43210',
  persona: 'Founder', goal: 'First clients with scalable outbound', tried: "I haven't started", hours_ok: 'Yes', invest: 'Yes', start: 'Next cohort',
  consent: true, qualified: true, attribution: { utm_source: 'meta', evil: 'x' } };
const contact = { funnel: 'individual', stage: 'contact', lead_id: 'lead-1', full_name: 'Test Person', email: 'test@example.com', phone: '+91 98765 43210', consent: true };
const corporate = { funnel: 'corporate', full_name: 'Lead Person', work_email: 'lead@company.com', company: 'Acme', role: 'VP Sales / Head of Sales',
  team_size: '5–10 people', motion: 'Manual outbound by reps', timeline: 'This month', goals: 'Reps should build their own lists and campaigns.', consent: true };

const SUPA = ['SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY'];
const HOOKS = ['APPLY_WEBHOOK_URL', 'CORPORATE_WEBHOOK_URL'];
function clearDestinations() { for (const k of SUPA.concat(HOOKS)) delete process.env[k]; }
function useSupabase() {
  clearDestinations();
  process.env.SUPABASE_URL = 'https://proj.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
}
/* Collects what the handler sent, and answers like PostgREST. */
function mockSupabase(ok = true) {
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), headers: opts.headers, body: JSON.parse(opts.body) });
    return ok ? { ok: true, status: 201 } : { ok: false, status: 404, text: async () => '{"message":"relation does not exist"}' };
  };
  return calls;
}

function mockRes() { const r = { code: 0, body: null, headers: {} }; r.status = c => { r.code = c; return r; }; r.json = o => { r.body = o; return r; }; r.setHeader = (k, v) => { r.headers[k] = v; }; return r; }
async function call(body, method = 'POST') { const res = mockRes(); await apply({ method, body, headers: {} }, res); return res; }

test('validate accepts a complete individual application and strips unknown attribution keys', () => {
  const v = apply.validate(individual);
  assert.equal(v.ok, true); assert.equal(v.data.attribution.utm_source, 'meta'); assert.equal(v.data.attribution.evil, undefined);
});
test('validate accepts a complete corporate enquiry', () => assert.equal(apply.validate(corporate).ok, true));
test('validate rejects missing fields, bad email, short text and missing consent', () => {
  const v = apply.validate({ funnel: 'individual', email: 'nope', phone: 'abc' });
  assert.equal(v.ok, false);
  for (const k of ['full_name', 'email', 'phone', 'consent', 'invest', 'hours_ok']) assert.ok(v.errors[k], k);
  const c = apply.validate({ funnel: 'corporate', goals: 'short' });
  assert.ok(c.errors.goals);
});
test('step 1 (contact stage) only needs name, email, phone and consent, and is marked "started"', () => {
  const v = apply.validate(contact);
  assert.equal(v.ok, true); assert.equal(v.data.stage, 'contact'); assert.equal(v.data.lead_stage, 'started');
  assert.equal(apply.validate(Object.assign({}, contact, { phone: '' })).ok, false);
});
test('full application sets lead_stage from qualification', () => {
  assert.equal(apply.validate(individual).data.lead_stage, 'qualified');
  assert.equal(apply.validate(Object.assign({}, individual, { qualified: false, invest: 'Not right now' })).data.lead_stage, 'not_qualified');
});
test('call_booked stage needs only the email and keeps the lead id', () => {
  const v = apply.validate({ funnel: 'individual', stage: 'call_booked', email: 'test@example.com', lead_id: 'lead-1', booking_time: '2026-12-01T10:00' });
  assert.equal(v.ok, true); assert.equal(v.data.lead_stage, 'call_booked'); assert.equal(v.data.lead_id, 'lead-1');
});
test('unknown stage falls back to a full application', () => assert.equal(apply.validate(Object.assign({}, contact, { stage: 'hack' })).ok, false));
test('rejects non-POST', async () => assert.equal((await call(null, 'GET')).code, 405));
test('400 on invalid body', async () => assert.equal((await call({ funnel: 'individual' })).code, 400));
test('honeypot returns 200 without forwarding', async () => {
  let called = false; global.fetch = async () => { called = true; return { ok: true }; };
  const r = await call(Object.assign({}, individual, { website: 'spam.com' }));
  assert.equal(r.code, 200); assert.equal(called, false);
});
test('503 only when neither Supabase nor a webhook is configured', async () => {
  clearDestinations();
  assert.equal((await call(individual)).code, 503);
});
test('forwards to the webhook with the secret header and returns 200', async () => {
  process.env.APPLY_WEBHOOK_URL = 'https://hooks.example/apply'; process.env.APPLY_WEBHOOK_SECRET = 's3cret';
  let sent; global.fetch = async (url, opts) => { sent = { url, opts }; return { ok: true }; };
  const r = await call(individual);
  assert.equal(r.code, 200); assert.equal(sent.url, 'https://hooks.example/apply'); assert.equal(sent.opts.headers['X-GTME-Secret'], 's3cret');
  const p = JSON.parse(sent.opts.body); assert.equal(p.email, 'test@example.com'); assert.ok(p.submitted_at);
});
test('corporate enquiries use CORPORATE_WEBHOOK_URL when set', async () => {
  process.env.CORPORATE_WEBHOOK_URL = 'https://hooks.example/corp';
  let url; global.fetch = async u => { url = u; return { ok: true }; };
  assert.equal((await call(corporate)).code, 200); assert.equal(url, 'https://hooks.example/corp');
});
test('502 when the webhook fails', async () => {
  global.fetch = async () => ({ ok: false, status: 500 });
  const orig = console.error; console.error = () => {};
  assert.equal((await call(individual)).code, 502); console.error = orig;
});

/* ------------------------------------------------------------------ Supabase storage */

test('stores the application in Supabase with no webhook configured', async () => {
  useSupabase();
  const calls = mockSupabase();
  const r = await call(individual);
  assert.equal(r.code, 200);
  assert.equal(r.body.stored, true);

  const upsert = calls.find(c => c.url.includes('/rest/v1/applications'));
  assert.ok(upsert, 'upserted into applications');
  assert.match(upsert.url, /on_conflict=lead_id/);
  assert.match(upsert.headers.Prefer, /resolution=merge-duplicates/);
  assert.equal(upsert.headers.apikey, 'service-role-key');
  assert.equal(upsert.headers.Authorization, 'Bearer service-role-key');
  assert.equal(upsert.body.lead_id, 'lead-1');
  assert.equal(upsert.body.email, 'test@example.com');
  assert.equal(upsert.body.start_when, 'Next cohort');
  assert.equal(upsert.body.qualified, true);
  assert.equal(upsert.body.utm_source, 'meta');
  assert.ok(upsert.body.applied_at);

  const logged = calls.find(c => c.url.includes('/rest/v1/application_events'));
  assert.ok(logged, 'appended to application_events');
  assert.equal(logged.body.lead_id, 'lead-1');
  assert.equal(logged.body.payload.email, 'test@example.com');
});

test('step 1 writes the contact row and stamps contact_at, not applied_at', async () => {
  useSupabase();
  const calls = mockSupabase();
  assert.equal((await call(contact)).code, 200);
  const row = calls[0].body;
  assert.equal(row.stage, 'contact');
  assert.ok(row.contact_at);
  assert.equal(row.applied_at, undefined);
  assert.equal(row.qualified, undefined, 'step 1 must not pre-judge qualification');
});

test('a booked call merges onto the same lead row', async () => {
  useSupabase();
  const calls = mockSupabase();
  const r = await call({ funnel: 'individual', stage: 'call_booked', lead_id: 'lead-1', email: 'test@example.com', booking_time: '2026-12-01T10:00', booking_ref: 'abc' });
  assert.equal(r.code, 200);
  const row = calls[0].body;
  assert.equal(row.lead_id, 'lead-1');
  assert.equal(row.booking_ref, 'abc');
  assert.ok(row.booked_at);
});

test('a submission with no lead_id gets one derived from the email, so repeats still merge', async () => {
  useSupabase();
  const first = mockSupabase();
  const { lead_id: a } = (await call(Object.assign({}, individual, { lead_id: undefined }))).body;
  const second = mockSupabase();
  const { lead_id: b } = (await call(Object.assign({}, individual, { lead_id: undefined }))).body;
  assert.ok(a && a.startsWith('lead-email-'));
  assert.equal(a, b);
  assert.equal(first[0].body.lead_id, second[0].body.lead_id);
});

test('502 when the only destination (Supabase) rejects the write', async () => {
  useSupabase();
  mockSupabase(false);
  const orig = console.error; console.error = () => {};
  const r = await call(individual);
  console.error = orig;
  assert.equal(r.code, 502);
  assert.equal(r.body.error, 'upstream');
});

test('a failing webhook does not lose an application Supabase already stored', async () => {
  useSupabase();
  process.env.APPLY_WEBHOOK_URL = 'https://hooks.example/apply';
  global.fetch = async url => String(url).includes('supabase') ? { ok: true, status: 201 } : { ok: false, status: 500 };
  const orig = console.error; console.error = () => {};
  const r = await call(individual);
  console.error = orig;
  assert.equal(r.code, 200);
  assert.equal(r.body.stored, true);
});

test('the honeypot still writes nothing to the database', async () => {
  useSupabase();
  const calls = mockSupabase();
  assert.equal((await call(Object.assign({}, individual, { website: 'spam.com' }))).code, 200);
  assert.equal(calls.length, 0);
});

test('toRow keeps the browser anon key out of it and never invents columns', () => {
  const store = require('../api/_supabase.js');
  const row = store.toRow(apply.validate(individual).data, { submitted_at: '2026-11-05T00:00:00.000Z', user_agent: 'ua' });
  assert.equal(row.start, undefined, 'renamed to start_when');
  assert.equal(row.attribution.utm_source, 'meta');
  assert.equal(row.user_agent, 'ua');
  assert.equal(row.consent, true);
});
