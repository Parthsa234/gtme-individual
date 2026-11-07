/*
 * GET /book?lead=<lead_id>&sig=<signature>   (rewritten to /api/book in vercel.json)
 *
 * The personalised booking link. When a lead opens it, this function:
 *   1. checks the signature, so only links this deployment issued work (no lead_id guessing)
 *   2. reads that lead's row from Supabase (applications, by lead_id)
 *   3. redirects to the Cal.com event with name, email and phone prefilled
 *
 * The lead still picks a date and time and confirms the booking themselves. Nothing is booked here.
 *
 * Where it sends people instead:
 *   - already booked (booked_at set)         → /apply/booked, so one lead does not book twice
 *   - marked not qualified (qualified=false) → /apply/not-a-fit, same rule as the application form
 *   - row missing or Supabase unreachable    → the Cal.com event with nothing prefilled, so a real
 *                                              lead can always still book
 *   - bad or missing signature, or BOOKING_LINK_SECRET unset → 404
 *
 * Logs carry the lead_id and outcome only, never names, emails or phone numbers.
 */
'use strict';

const store = require('./_supabase.js');
const booking = require('./_booking.js');

const LEAD_ID = /^[A-Za-z0-9._-]{1,64}$/;

function log(outcome, leadId, extra) {
  console.log('[book]', JSON.stringify(Object.assign({ outcome: outcome, lead_id: leadId || null }, extra || {})));
}

function redirect(res, url) {
  res.statusCode = 302;
  res.setHeader('Location', url);
  res.end();
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const q = req.query || {};
  const leadId = typeof q.lead === 'string' ? q.lead : '';
  const sig = typeof q.sig === 'string' ? q.sig : '';

  if (!booking.isEnabled() || !LEAD_ID.test(leadId) || !booking.verify(leadId, sig)) {
    log('rejected', LEAD_ID.test(leadId) ? leadId : null, { reason: booking.isEnabled() ? 'bad_signature' : 'disabled' });
    return res.status(404).json({ ok: false, error: 'not_found' });
  }

  const found = await store.getLead(leadId);
  if (!found.ok) {
    console.error('[book] supabase read failed:', found.status, found.error);
    log('fallback_unprefilled', leadId, { reason: 'read_failed' });
    return redirect(res, booking.plainCalUrl());
  }
  const lead = found.lead;
  if (!lead) {
    log('fallback_unprefilled', leadId, { reason: 'lead_not_found' });
    return redirect(res, booking.plainCalUrl());
  }
  if (lead.booked_at) {
    log('already_booked', leadId);
    return redirect(res, '/apply/booked');
  }
  if (lead.qualified === false) {
    log('not_qualified', leadId);
    return redirect(res, '/apply/not-a-fit');
  }

  const url = booking.calUrl(lead);
  const u = new URL(url);
  log('redirected', leadId, {
    prefilled: ['name', 'email', process.env.CAL_PHONE_FIELD || 'attendeePhoneNumber'].filter(function (k) { return u.searchParams.has(k); })
  });
  return redirect(res, url);
};
