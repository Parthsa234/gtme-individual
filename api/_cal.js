/*
 * Cal.com helpers for the booking sync. Server-side only: nothing here is ever sent to the browser.
 *
 *   getBooking(uid)          → reads one booking from the Cal.com API v2 (the source of truth)
 *   verifySignature(raw, sig)→ checks a webhook's X-Cal-Signature-256 (HMAC-SHA256 of the raw body)
 *   fromApi(b) / fromWebhook(trigger, payload)
 *                            → the same normalised shape from either source:
 *       { id, uid, status, start, end, event_type, event_type_id, attendee_email, attendee_name,
 *         metadata, cancel_reason, previous_uid }
 *   leadStageFor(status)     → the applications.lead_stage a booking status maps to
 *
 * Environment variables:
 *   CAL_API_KEY          Cal.com API key (Settings → Developer → API keys). Used to confirm every
 *                        booking before it is written, so a forged browser request or webhook can
 *                        never mark someone as booked.
 *   CAL_WEBHOOK_SECRET   The secret set on the Cal.com webhook. Required: /api/cal-webhook answers
 *                        503 without it rather than accept unsigned deliveries.
 *   CAL_EVENT_SLUGS      Optional comma-separated list of event slugs to sync (default:
 *                        gtme-school,gtme-school-copy). Bookings of other event types are ignored.
 */
'use strict';

const crypto = require('crypto');

const API = 'https://api.cal.com/v2';
const API_VERSION = '2024-08-13'; // bookings endpoints
const TIMEOUT_MS = 8000;
const DEFAULT_SLUGS = 'gtme-school,gtme-school-copy';

function apiKey() { return (process.env.CAL_API_KEY || '').trim(); }
function webhookSecret() { return (process.env.CAL_WEBHOOK_SECRET || '').trim(); }
function hasApi() { return Boolean(apiKey()); }
function allowedSlugs() {
  return (process.env.CAL_EVENT_SLUGS || DEFAULT_SLUGS).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}
function isOurEvent(slug) { return !slug || allowedSlugs().indexOf(slug) > -1; }

/** Constant-time check of X-Cal-Signature-256 against the raw request body. */
function verifySignature(raw, signature) {
  const secret = webhookSecret();
  if (!secret || typeof signature !== 'string' || !signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(signature.trim().toLowerCase());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const UID = /^[A-Za-z0-9_-]{6,64}$/;

/**
 * Read a booking by uid. Returns { ok:true, booking } (normalised), { ok:false, status:404 } when
 * Cal.com has no such booking, or { ok:false, status, error } on any other failure. Never throws.
 */
async function getBooking(uid) {
  if (!hasApi()) return { ok: false, status: 0, error: 'not_configured' };
  if (!UID.test(String(uid || ''))) return { ok: false, status: 400, error: 'bad_uid' };
  const ctrl = new AbortController();
  const t = setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS);
  try {
    const r = await fetch(API + '/bookings/' + encodeURIComponent(uid), {
      headers: { Authorization: 'Bearer ' + apiKey(), 'cal-api-version': API_VERSION, Accept: 'application/json' },
      signal: ctrl.signal
    });
    if (r.status === 404) return { ok: false, status: 404, error: 'not_found' };
    if (!r.ok) {
      const detail = await r.text().catch(function () { return ''; });
      return { ok: false, status: r.status, error: String(detail).slice(0, 300) };
    }
    const j = await r.json();
    const b = j && j.data;
    if (!b || !b.uid) return { ok: false, status: 502, error: 'unexpected_response' };
    return { ok: true, booking: fromApi(b) };
  } catch (e) {
    return { ok: false, status: 0, error: (e && e.message) || 'request failed' };
  } finally {
    clearTimeout(t);
  }
}

function iso(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}
function str(v, max) { return typeof v === 'string' && v ? v.slice(0, max || 300) : null; }
function cleanMeta(m) {
  const out = {};
  if (!m || typeof m !== 'object') return out;
  for (const k of Object.keys(m).slice(0, 50)) if (typeof m[k] === 'string' || typeof m[k] === 'number') out[k.slice(0, 40)] = String(m[k]).slice(0, 300);
  return out;
}
function firstAttendee(list) {
  const a = Array.isArray(list) && list.length ? list[0] : {};
  return { email: str(a.email, 160) ? a.email.trim().toLowerCase() : null, name: str(a.name, 120) };
}

/** Normalise a booking from GET /v2/bookings/{uid}. */
function fromApi(b) {
  const a = firstAttendee(b.attendees);
  return {
    id: Number.isFinite(Number(b.id)) ? Number(b.id) : null,
    uid: str(b.uid, 64),
    status: String(b.status || '').toLowerCase() || null,
    start: iso(b.start || b.startTime),
    end: iso(b.end || b.endTime),
    event_type: str(b.eventType && b.eventType.slug, 120),
    event_type_id: (b.eventType && b.eventType.id) || b.eventTypeId || null,
    attendee_email: a.email,
    attendee_name: a.name,
    metadata: cleanMeta(b.metadata),
    cancel_reason: str(b.cancellationReason, 500),
    previous_uid: str(b.rescheduledFromUid || b.fromReschedule, 64),
    updated_at: iso(b.updatedAt || b.createdAt)
  };
}

/* Webhook triggers that change a booking, and the status each one implies when the payload does
   not say. Everything else (MEETING_STARTED, FORM_SUBMITTED, ...) is acknowledged and ignored. */
const TRIGGER_STATUS = {
  BOOKING_CREATED: 'accepted',
  BOOKING_RESCHEDULED: 'accepted',
  BOOKING_REQUESTED: 'pending',
  BOOKING_CANCELLED: 'cancelled',
  BOOKING_REJECTED: 'rejected'
};

/** Normalise the `payload` of a Cal.com webhook delivery. */
function fromWebhook(trigger, p) {
  const a = firstAttendee(p.attendees);
  let status = String(p.status || '').toLowerCase();
  // The trigger is authoritative for cancellations and rejections whatever `status` says.
  if (trigger === 'BOOKING_CANCELLED' || trigger === 'BOOKING_REJECTED' || !status) status = TRIGGER_STATUS[trigger] || status;
  return {
    id: Number.isFinite(Number(p.bookingId)) ? Number(p.bookingId) : null,
    uid: str(p.uid, 64),
    status: status || null,
    start: iso(p.startTime),
    end: iso(p.endTime),
    event_type: str(p.type || (p.eventType && p.eventType.slug), 120),
    event_type_id: p.eventTypeId || null,
    attendee_email: a.email,
    attendee_name: a.name,
    metadata: cleanMeta(p.metadata),
    cancel_reason: str(p.cancellationReason, 500),
    previous_uid: str(p.rescheduleUid || p.fromReschedule, 64),
    updated_at: null
  };
}

const LEAD_STAGE = { accepted: 'call_booked', pending: 'call_requested', cancelled: 'call_cancelled', rejected: 'call_rejected' };
function leadStageFor(status) { return LEAD_STAGE[status] || null; }

module.exports = {
  hasApi, getBooking, verifySignature, fromApi, fromWebhook, leadStageFor, isOurEvent, webhookSecret,
  TRIGGER_STATUS
};
