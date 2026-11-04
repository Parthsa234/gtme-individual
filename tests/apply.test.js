'use strict';
const test = require('node:test'), assert = require('node:assert');
const apply = require('../api/apply.js');

const individual = { funnel: 'individual', stage: 'application', lead_id: 'lead-1', full_name: 'Test Person', email: 'test@example.com', phone: '+91 98765 43210',
  persona: 'Founder', goal: 'First clients with scalable outbound', tried: "I haven't started", hours_ok: 'Yes', invest: 'Yes', start: 'Next cohort',
  consent: true, qualified: true, attribution: { utm_source: 'meta', evil: 'x' } };
const contact = { funnel: 'individual', stage: 'contact', lead_id: 'lead-1', full_name: 'Test Person', email: 'test@example.com', phone: '+91 98765 43210', consent: true };
const corporate = { funnel: 'corporate', full_name: 'Lead Person', work_email: 'lead@company.com', company: 'Acme', role: 'VP Sales / Head of Sales',
  team_size: '5–10 people', motion: 'Manual outbound by reps', timeline: 'This month', goals: 'Reps should build their own lists and campaigns.', consent: true };

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
test('503 when the webhook is not configured', async () => {
  delete process.env.APPLY_WEBHOOK_URL; delete process.env.CORPORATE_WEBHOOK_URL;
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
