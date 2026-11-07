/*
 * Personalised Cal.com booking links, built from the lead's row in Supabase.
 *
 *   signedLink(leadId, origin)  → https://<site>/book?lead=<lead_id>&sig=<hmac>
 *                                 Safe to send by email / WhatsApp / CRM. Contains no personal data;
 *                                 the signature stops anyone from guessing other lead_ids.
 *   verify(leadId, sig)         → true when sig was issued by this deployment
 *   calUrl(lead)                → the Cal.com event URL with name, email, phone and lead_id prefilled
 *
 * Cal.com prefills any booking field from a query parameter named after the field's identifier
 * (https://cal.com/docs/core-features/event-types/booking-questions#prefill). The built-in fields
 * are `name` and `email`; the phone field is `attendeePhoneNumber` unless the event uses a custom
 * question with another identifier (set CAL_PHONE_FIELD). A phone field only accepts E.164, so the
 * number is normalised first and left out when it cannot be normalised safely.
 * `metadata[lead_id]` is stored on the booking, which ties the Cal.com booking back to this row.
 *
 * Environment variables:
 *   BOOKING_LINK_SECRET          required for signed links. Any long random string. Without it,
 *                                /book answers 404 and no links are issued.
 *   CAL_BOOKING_URL              the event to book. Default: the simplified copy, shrinishkarsh/gtme-school-copy.
 *   CAL_PHONE_FIELD              phone field identifier on that event. Default attendeePhoneNumber.
 *                                Set to "none" to never prefill the phone.
 *   DEFAULT_PHONE_COUNTRY_CODE   used only for a bare 10-digit number typed without a country
 *                                code. Default 91 (India), matching the form's placeholder.
 *   PUBLIC_SITE_URL              origin used in signed links when there is no request to read it
 *                                from. Default https://gtme-individual.vercel.app.
 */
'use strict';

const crypto = require('crypto');

const DEFAULT_CAL_URL = 'https://cal.com/shrinishkarsh/gtme-school-copy'; // simplified copy of the GTME.School event
const DEFAULT_SITE = 'https://gtme-individual.vercel.app';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function secret() { return (process.env.BOOKING_LINK_SECRET || '').trim(); }
function isEnabled() { return secret().length >= 16; }

function sign(leadId) {
  return crypto.createHmac('sha256', secret()).update('book:' + String(leadId)).digest('base64url').slice(0, 32);
}

function verify(leadId, sig) {
  if (!isEnabled() || !leadId || typeof sig !== 'string') return false;
  const a = Buffer.from(sign(leadId)), b = Buffer.from(sig);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** The link to send a lead. Returns '' when BOOKING_LINK_SECRET is not configured. */
function signedLink(leadId, origin) {
  if (!isEnabled() || !leadId) return '';
  const base = String(origin || process.env.PUBLIC_SITE_URL || DEFAULT_SITE).replace(/\/+$/, '');
  return base + '/book?lead=' + encodeURIComponent(leadId) + '&sig=' + sign(leadId);
}

/**
 * Normalise a phone number to E.164 (+<country><number>), or return '' when unsure.
 *   "+91 98765 43210" → "+919876543210"
 *   "0091 98765 43210" → "+919876543210"
 *   "98765 43210"      → "+919876543210" (bare 10 digits: DEFAULT_PHONE_COUNTRY_CODE)
 *   "44 20 7946 0958"  → "+442079460958" (11-15 digits: assumed to include the country code)
 */
function toE164(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  let digits = s.replace(/\D/g, '');
  if (s.startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? '+' + digits : '';
  if (digits.startsWith('00')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1); // trunk prefix, e.g. 098765 43210
  if (digits.length === 10) {
    const cc = String(process.env.DEFAULT_PHONE_COUNTRY_CODE || '91').replace(/\D/g, '');
    return cc ? '+' + cc + digits : '';
  }
  return digits.length >= 11 && digits.length <= 15 ? '+' + digits : '';
}

/** The Cal.com URL for this lead, with whatever could be prefilled safely. */
function calUrl(lead) {
  const u = new URL(process.env.CAL_BOOKING_URL || DEFAULT_CAL_URL);
  const l = lead || {};
  const name = String(l.full_name || '').trim();
  const email = String(l.email || '').trim();
  if (name) u.searchParams.set('name', name.slice(0, 120));
  if (email && EMAIL.test(email)) u.searchParams.set('email', email);
  const field = (process.env.CAL_PHONE_FIELD || 'attendeePhoneNumber').trim();
  const phone = toE164(l.phone);
  if (phone && field && field !== 'none') u.searchParams.set(field, phone);
  if (l.lead_id) u.searchParams.set('metadata[lead_id]', String(l.lead_id));
  return u.toString();
}

/** The event's own URL with nothing prefilled: the fallback when a lead can't be read. */
function plainCalUrl() { return process.env.CAL_BOOKING_URL || DEFAULT_CAL_URL; }

module.exports = { isEnabled, sign, verify, signedLink, toE164, calUrl, plainCalUrl };
