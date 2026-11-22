'use strict';
const test = require('node:test'), assert = require('node:assert');
const brochure = require('../api/brochure.js');

const good = { full_name: 'Asha Rao', email: 'Asha@Example.com', phone: '+91 98765-43210', profession: 'Founder / Business Owner',
  page: '/vsl', attribution: { utm_source: 'meta', utm_medium: 'paid', utm_campaign: 'c1', utm_content: 'ad1', utm_term: 't', landing_page: '/vsl?x=1', referrer: 'https://l.facebook.com/', evil: 'x' } };
const EVENT = '4873d8a8-d4c8-4779-bb9d-bb3db9a18133';

function useSupabase() { process.env.SUPABASE_URL = 'https://proj.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'; }
function noSupabase() { for (const k of ['SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY']) delete process.env[k]; }
/* Answers like PostgREST: rpc results come back as the function's JSON. */
function mockRpc(answer) {
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), headers: opts.headers, body: JSON.parse(opts.body) });
    const fn = String(url).split('/rpc/')[1];
    const a = typeof answer === 'function' ? answer(fn, JSON.parse(opts.body)) : answer;
    if (a && a.httpError) return { ok: false, status: a.httpError, text: async () => '{"message":"secret row data"}' };
    return { ok: true, status: 200, json: async () => a };
  };
  return calls;
}
function mockRes() { const r = { code: 0, body: null, headers: {} }; r.status = c => { r.code = c; return r; }; r.json = o => { r.body = o; return r; }; r.setHeader = (k, v) => { r.headers[k] = v; }; return r; }
async function call(body, headers = {}, method = 'POST') { const res = mockRes(); await brochure({ method, body, headers: Object.assign({ host: 'vsl.example' }, headers) }, res); return res; }

test('validate normalises a good request and drops unknown attribution keys', () => {
  const v = brochure.validate(good);
  assert.equal(v.ok, true);
  assert.equal(v.data.email, 'asha@example.com');
  assert.equal(v.data.phone, '+919876543210');
  assert.equal(v.data.utm_source, 'meta'); assert.equal(v.data.evil, undefined);
  assert.equal(v.data.landing_page, '/vsl?x=1');
});
test('validate requires all four fields and only the six professions', () => {
  const v = brochure.validate({});
  for (const k of ['full_name', 'email', 'phone', 'profession']) assert.equal(v.errors[k], 'required', k);
  assert.equal(brochure.validate(Object.assign({}, good, { profession: 'Hacker' })).errors.profession, 'invalid');
  assert.equal(brochure.validate(Object.assign({}, good, { email: 'nope@x' })).errors.email, 'invalid');
  assert.equal(brochure.validate(Object.assign({}, good, { full_name: '12' })).errors.full_name, 'invalid');
});
test('validate strips markup and control characters from the name', () => {
  assert.equal(brochure.validate(Object.assign({}, good, { full_name: '  <b>Asha</b>\n Rao ' })).data.full_name, 'bAsha/b Rao');
});
test('phone normalisation and country rules', () => {
  const n = brochure.normalisePhone;
  assert.equal(n('+91 98765 43210'), '+919876543210');
  assert.equal(n('+91 12345 67890'), '');   // Indian mobiles start 6–9
  assert.equal(n('+91 98765 4321'), '');    // 9 digits
  assert.equal(n('+1 (415) 555-0123'), '+14155550123');
  assert.equal(n('+44 7911 123456'), '+447911123456');
  assert.equal(n('12345'), '');
  assert.equal(n('call me'), '');
});
test('rejects non-POST and cross-site posts', async () => {
  assert.equal((await call(good, {}, 'GET')).code, 405);
  assert.equal((await call(good, { origin: 'https://evil.example' })).code, 403);
});
test('honeypot answers 200 without touching the database', async () => {
  useSupabase(); const calls = mockRpc({ ok: true });
  const r = await call(Object.assign({}, good, { website: 'spam.com' }));
  assert.equal(r.code, 200); assert.equal(calls.length, 0); assert.equal(r.body.event_id, undefined);
});
test('400 with field errors on invalid input, nothing stored', async () => {
  useSupabase(); const calls = mockRpc({ ok: true });
  const r = await call(Object.assign({}, good, { phone: '123' }));
  assert.equal(r.code, 400); assert.equal(r.body.fields.phone, 'invalid'); assert.equal(calls.length, 0);
});
test('503 when Supabase is not configured', async () => {
  noSupabase();
  assert.equal((await call(good)).code, 503);
});
test('stores through brochure_capture with the service key and returns only the download details', async () => {
  useSupabase();
  const calls = mockRpc({ ok: true, lead_id: 'lead-uuid', event_id: EVENT, new_lead: true });
  const r = await call(good, { origin: 'https://vsl.example', 'x-forwarded-for': '203.0.113.9, 10.0.0.1' });
  assert.equal(r.code, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://proj.supabase.co/rest/v1/rpc/brochure_capture');
  assert.equal(calls[0].headers.Authorization, 'Bearer service-role-key');
  const p = calls[0].body;
  assert.equal(p.p_email, 'asha@example.com'); assert.equal(p.p_phone, '+919876543210');
  assert.equal(p.p_brochure_name, 'GTME-School-Brochure.pdf'); assert.equal(p.p_brochure_version, '2026-27');
  assert.equal(p.p_utm_campaign, 'c1'); assert.match(p.p_ip_hash, /^[0-9a-f]{32}$/);
  assert.ok(!JSON.stringify(p).includes('203.0.113.9'), 'raw IP must not be sent');
  assert.deepEqual(Object.keys(r.body).sort(), ['download_url', 'event_id', 'filename', 'ok', 'token']);
  assert.equal(r.body.download_url, '/assets/docs/GTME-School-Brochure.pdf');
  assert.equal(r.headers['Cache-Control'], 'no-store');
});
test('429 when the database rate limit trips', async () => {
  useSupabase(); mockRpc({ ok: false, error: 'rate_limited' });
  assert.equal((await call(good)).code, 429);
});
test('502 on a database error, without echoing or logging the error body', async () => {
  useSupabase(); mockRpc({ httpError: 500 });
  const logged = []; const orig = console.error; console.error = (...a) => logged.push(a.join(' '));
  const r = await call(good);
  console.error = orig;
  assert.equal(r.code, 502); assert.ok(!JSON.stringify(r.body).includes('secret row data'));
  assert.ok(!logged.join('\n').includes('secret row data'));
});
test('status reports need the token from the request answer', async () => {
  useSupabase();
  mockRpc((fn) => fn === 'brochure_capture' ? { ok: true, lead_id: 'l', event_id: EVENT, new_lead: false } : true);
  const first = await call(good);
  const calls = mockRpc(true);
  const ok = await call({ action: 'status', event_id: EVENT, token: first.body.token, status: 'initiated' });
  assert.equal(ok.code, 200); assert.equal(ok.body.updated, true);
  assert.equal(calls[0].url, 'https://proj.supabase.co/rest/v1/rpc/brochure_set_status');
  assert.deepEqual(calls[0].body, { p_event_id: EVENT, p_status: 'initiated', p_reason: null });
  assert.equal((await call({ action: 'status', event_id: EVENT, token: 'f'.repeat(32), status: 'initiated' })).code, 400);
  assert.equal((await call({ action: 'status', event_id: EVENT, token: first.body.token, status: 'requested' })).code, 400);
  assert.equal((await call({ action: 'status', event_id: 'not-a-uuid', token: first.body.token, status: 'failed' })).code, 400);
  assert.equal(calls.length, 1);
});
