'use strict';
const test = require('node:test'), assert = require('node:assert');
const booking = require('../api/_booking.js');
const book = require('../api/book.js');
const apply = require('../api/apply.js');

const SECRET = 'test-secret-0123456789abcdef';
function env(extra) {
  for (const k of ['SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY', 'APPLY_WEBHOOK_URL',
    'CORPORATE_WEBHOOK_URL', 'BOOKING_LINK_SECRET', 'CAL_BOOKING_URL', 'CAL_PHONE_FIELD', 'PUBLIC_SITE_URL', 'DEFAULT_PHONE_COUNTRY_CODE']) delete process.env[k];
  Object.assign(process.env, { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key', BOOKING_LINK_SECRET: SECRET }, extra || {});
}
const LEAD = { lead_id: 'lead-abc-123', funnel: 'individual', full_name: 'Test Person', email: 'test@example.com', phone: '+91 98765 43210', qualified: true, lead_stage: 'qualified', booked_at: null };

/* PostgREST stand-in: GET returns `rows`, POST accepts. Records every call. */
function mockSupabase(rows, status = 200) {
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), method: opts.method, headers: opts.headers });
    if (opts.method === 'GET') return { ok: status < 400, status, json: async () => rows, text: async () => 'boom' };
    return { ok: true, status: 201 };
  };
  return calls;
}
function mockRes() {
  const r = { statusCode: 0, headers: {}, body: null, ended: false };
  r.status = c => { r.statusCode = c; return r; }; r.json = o => { r.body = o; r.ended = true; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; }; r.end = () => { r.ended = true; };
  return r;
}
async function open(query) { const res = mockRes(); const o = console.log; console.log = () => {}; const e = console.error; console.error = () => {};
  try { await book({ method: 'GET', query, headers: {} }, res); } finally { console.log = o; console.error = e; } return res; }
const signed = id => ({ lead: id, sig: booking.sign(id) });

/* ---------------------------------------------------------------- phone normalisation */
test('toE164 normalises the formats the form accepts and refuses to guess otherwise', () => {
  env();
  assert.equal(booking.toE164('+91 98765 43210'), '+919876543210');
  assert.equal(booking.toE164('+1 (415) 555-0100'), '+14155550100');
  assert.equal(booking.toE164('0091 98765-43210'), '+919876543210');
  assert.equal(booking.toE164('98765 43210'), '+919876543210');
  assert.equal(booking.toE164('098765 43210'), '+919876543210');
  assert.equal(booking.toE164('44 20 7946 0958'), '+442079460958');
  assert.equal(booking.toE164('12345'), '');
  assert.equal(booking.toE164(''), '');
  process.env.DEFAULT_PHONE_COUNTRY_CODE = '1';
  assert.equal(booking.toE164('415 555 0100'), '+14155550100');
});

/* ---------------------------------------------------------------- Cal.com URL */
test('calUrl prefills name, email, phone and the lead id on the configured event', () => {
  env({ CAL_BOOKING_URL: 'https://cal.com/shrinishkarsh/gtme-quick' });
  const u = new URL(booking.calUrl(LEAD));
  assert.equal(u.origin + u.pathname, 'https://cal.com/shrinishkarsh/gtme-quick');
  assert.equal(u.searchParams.get('name'), 'Test Person');
  assert.equal(u.searchParams.get('email'), 'test@example.com');
  assert.equal(u.searchParams.get('attendeePhoneNumber'), '+919876543210');
  assert.equal(u.searchParams.get('metadata[lead_id]'), 'lead-abc-123');
});
test('calUrl uses a custom phone field, can turn phone off, and drops an invalid email', () => {
  env({ CAL_PHONE_FIELD: 'whatsapp' });
  assert.equal(new URL(booking.calUrl(LEAD)).searchParams.get('whatsapp'), '+919876543210');
  process.env.CAL_PHONE_FIELD = 'none';
  const u = new URL(booking.calUrl(Object.assign({}, LEAD, { email: 'not-an-email' })));
  assert.equal(u.searchParams.has('none'), false);
  assert.equal(u.searchParams.has('attendeePhoneNumber'), false);
  assert.equal(u.searchParams.has('email'), false);
  assert.equal(u.searchParams.get('name'), 'Test Person');
});
test('calUrl defaults to the existing GTME.School event when CAL_BOOKING_URL is unset', () => {
  env();
  assert.match(booking.calUrl(LEAD), /^https:\/\/cal\.com\/shrinishkarsh\/gtme-school\?/);
});

/* ---------------------------------------------------------------- signing */
test('signed links verify, and a tampered lead id or signature does not', () => {
  env();
  const link = new URL(booking.signedLink('lead-abc-123', 'https://gtme-individual.vercel.app'));
  assert.equal(link.pathname, '/book');
  assert.equal(link.searchParams.get('lead'), 'lead-abc-123');
  assert.equal(booking.verify('lead-abc-123', link.searchParams.get('sig')), true);
  assert.equal(booking.verify('lead-abc-124', link.searchParams.get('sig')), false);
  assert.equal(booking.verify('lead-abc-123', 'x'), false);
  assert.equal(link.toString().includes('test@example.com'), false, 'no personal data in the link');
});
test('no secret, no links', () => {
  env(); delete process.env.BOOKING_LINK_SECRET;
  assert.equal(booking.signedLink('lead-abc-123'), '');
  process.env.BOOKING_LINK_SECRET = 'short';
  assert.equal(booking.isEnabled(), false, 'a short secret is treated as unset');
});

/* ---------------------------------------------------------------- GET /book */
test('/book reads the lead from Supabase by lead_id and redirects to the prefilled event', async () => {
  env();
  const calls = mockSupabase([LEAD]);
  const res = await open(signed('lead-abc-123'));
  assert.equal(res.statusCode, 302);
  const u = new URL(res.headers.Location);
  assert.equal(u.searchParams.get('email'), 'test@example.com');
  assert.equal(u.searchParams.get('attendeePhoneNumber'), '+919876543210');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/rest\/v1\/applications\?select=.*&lead_id=eq\.lead-abc-123&limit=1$/);
  assert.equal(calls[0].headers.Authorization, 'Bearer service-role-key');
  assert.equal(res.headers['Cache-Control'], 'no-store');
});
test('/book answers 404 without touching Supabase for a bad signature, a bad id or no secret', async () => {
  env();
  const calls = mockSupabase([LEAD]);
  assert.equal((await open({ lead: 'lead-abc-123', sig: 'forged' })).statusCode, 404);
  assert.equal((await open({ lead: 'lead-abc-124', sig: booking.sign('lead-abc-123') })).statusCode, 404);
  assert.equal((await open({ lead: "x' or 1=1", sig: booking.sign("x' or 1=1") })).statusCode, 404);
  assert.equal((await open({})).statusCode, 404);
  delete process.env.BOOKING_LINK_SECRET;
  assert.equal((await open(signed('lead-abc-123'))).statusCode, 404);
  assert.equal(calls.length, 0);
});
test('/book sends an already-booked lead to the booked page instead of a second booking', async () => {
  env(); mockSupabase([Object.assign({}, LEAD, { booked_at: '2026-11-07T10:00:00Z' })]);
  const res = await open(signed('lead-abc-123'));
  assert.equal(res.statusCode, 302); assert.equal(res.headers.Location, '/apply/booked');
});
test('/book sends a not-qualified lead to the course offer, like the form does', async () => {
  env(); mockSupabase([Object.assign({}, LEAD, { qualified: false })]);
  assert.equal((await open(signed('lead-abc-123'))).headers.Location, '/apply/not-a-fit');
});
test('/book lets a contact-stage lead (qualified not decided yet) book', async () => {
  env(); mockSupabase([Object.assign({}, LEAD, { qualified: null, lead_stage: 'started' })]);
  assert.match((await open(signed('lead-abc-123'))).headers.Location, /^https:\/\/cal\.com\//);
});
test('/book still gets a real lead to the calendar when the row is missing or Supabase is down', async () => {
  env({ CAL_BOOKING_URL: 'https://cal.com/shrinishkarsh/gtme-quick' });
  mockSupabase([]);
  assert.equal((await open(signed('lead-abc-123'))).headers.Location, 'https://cal.com/shrinishkarsh/gtme-quick');
  mockSupabase(null, 500);
  assert.equal((await open(signed('lead-abc-123'))).headers.Location, 'https://cal.com/shrinishkarsh/gtme-quick');
});
test('/book rejects POST', async () => {
  env(); const res = mockRes(); await book({ method: 'POST', query: {}, headers: {} }, res);
  assert.equal(res.statusCode, 405);
});

/* ---------------------------------------------------------------- /api/apply issues the link */
async function submit(body, headers) { const res = mockRes(); await apply({ method: 'POST', body, headers: headers || {} }, res); return res; }
const individual = { funnel: 'individual', stage: 'application', lead_id: 'lead-abc-123', full_name: 'Test Person', email: 'test@example.com', phone: '+91 98765 43210',
  persona: 'Founder', goal: 'x', tried: 'y', hours_ok: 'Yes', invest: 'Yes', start: 'Next cohort', consent: true, qualified: true };

test('a qualified application returns a signed booking link and sends it to the webhook', async () => {
  env({ APPLY_WEBHOOK_URL: 'https://hooks.example/apply' });
  let hook; global.fetch = async (url, opts) => { if (String(url).includes('hooks.example')) hook = JSON.parse(opts.body); return { ok: true, status: 201 }; };
  const res = await submit(individual, { host: 'gtme-individual.vercel.app' });
  assert.equal(res.statusCode, 200);
  const link = new URL(res.body.booking_link);
  assert.equal(link.origin, 'https://gtme-individual.vercel.app');
  assert.equal(booking.verify('lead-abc-123', link.searchParams.get('sig')), true);
  assert.equal(hook.booking_link, res.body.booking_link);
});
test('step 1 (contact) also gets a link, so abandoned applications can be followed up', async () => {
  env(); mockSupabase([]);
  const res = await submit({ funnel: 'individual', stage: 'contact', lead_id: 'lead-abc-123', full_name: 'A', email: 'a@b.co', phone: '+91 98765 43210', consent: true });
  assert.ok(res.body.booking_link);
});
test('not-qualified applicants, corporate enquiries and deployments without the secret get no link', async () => {
  env(); mockSupabase([]);
  assert.equal((await submit(Object.assign({}, individual, { qualified: false, invest: 'Not right now' }))).body.booking_link, undefined);
  assert.equal((await submit({ funnel: 'corporate', full_name: 'L', work_email: 'l@c.com', company: 'C', role: 'R', team_size: '5', motion: 'm', timeline: 't',
    goals: 'Reps should build their own lists and campaigns.', consent: true })).body.booking_link, undefined);
  delete process.env.BOOKING_LINK_SECRET;
  const res = await submit(individual);
  assert.equal(res.statusCode, 200); assert.equal(res.body.booking_link, undefined);
});
