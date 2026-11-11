/*
 * POST /api/cal-webhook — Cal.com → Supabase booking sync.
 *
 * Cal.com calls this when a booking on the GTME.School event is created, rescheduled, requested,
 * cancelled or rejected. For each delivery it:
 *   1. checks X-Cal-Signature-256 (HMAC-SHA256 of the raw body with CAL_WEBHOOK_SECRET); anything
 *      unsigned or wrongly signed gets 401 and changes nothing
 *   2. re-reads the booking from the Cal.com API (CAL_API_KEY), so what is stored is Cal.com's
 *      current state even when deliveries arrive late or out of order
 *   3. finds the application (metadata lead_id → booking uid → attendee email) or, for someone who
 *      booked from the bare Cal.com link, creates a row for them
 *   4. logs the delivery once in application_events (re-deliveries are recognised and skipped)
 *   5. writes booking id, start/end, status and lead_stage onto the row, unless a newer state is
 *      already stored
 *
 * This is the reliable path: it does not depend on the applicant's browser staying open after
 * they book. /api/apply also records the booking when the browser reports it; both paths write the
 * same columns and the newer state wins.
 *
 * Logs carry lead_id, uid and trigger only — no names or emails.
 */
'use strict';

const cal = require('./_cal.js');
const store = require('./_supabase.js');

const MAX_BODY = 1024 * 1024;

/* The signature is over the exact bytes Cal.com sent, so read the raw stream. Vercel only parses
   req.body when it is read, which this function never does. */
function readRaw(req) {
  if (Buffer.isBuffer(req.rawBody)) return Promise.resolve(req.rawBody);
  if (typeof req.rawBody === 'string') return Promise.resolve(Buffer.from(req.rawBody));
  return new Promise(function (resolve, reject) {
    const chunks = []; let size = 0;
    req.on('data', function (c) {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', function () { resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

function send(res, code, body) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function log(outcome, extra) { console.log('[cal-webhook]', JSON.stringify(Object.assign({ outcome: outcome }, extra || {}))); }

async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return send(res, 405, { ok: false, error: 'method_not_allowed' }); }
  if (!cal.webhookSecret()) { log('not_configured'); return send(res, 503, { ok: false, error: 'not_configured' }); }

  let raw;
  try { raw = await readRaw(req); } catch (e) { return send(res, 413, { ok: false, error: 'too_large' }); }
  if (!cal.verifySignature(raw, req.headers['x-cal-signature-256'])) {
    log('bad_signature');
    return send(res, 401, { ok: false, error: 'bad_signature' });
  }

  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch (e) { return send(res, 400, { ok: false, error: 'invalid_json' }); }
  const trigger = String((body && body.triggerEvent) || '');
  if (trigger === 'PING') return send(res, 200, { ok: true, ping: true });
  if (!cal.TRIGGER_STATUS[trigger] || !body.payload || typeof body.payload !== 'object') {
    log('ignored', { trigger });
    return send(res, 200, { ok: true, ignored: true });
  }

  let b = cal.fromWebhook(trigger, body.payload);
  if (!b.uid) return send(res, 400, { ok: false, error: 'missing_uid' });
  if (!cal.isOurEvent(b.event_type)) { log('other_event_type', { trigger, uid: b.uid }); return send(res, 200, { ok: true, ignored: true }); }
  if (!store.isConfigured()) { log('db_not_configured', { uid: b.uid }); return send(res, 503, { ok: false, error: 'db_not_configured' }); }

  // Cal.com's API is the source of truth; the webhook body fills anything it lacks.
  let source = 'webhook';
  if (cal.hasApi()) {
    const fresh = await cal.getBooking(b.uid);
    if (fresh.ok) {
      const f = fresh.booking;
      b = Object.assign({}, b, f, {
        metadata: Object.assign({}, b.metadata, f.metadata),
        previous_uid: f.previous_uid || b.previous_uid,
        cancel_reason: f.cancel_reason || b.cancel_reason
      });
      source = 'webhook+api';
    } else if (fresh.status !== 404) {
      console.error('[cal-webhook] cal.com lookup failed, using the webhook body:', fresh.status, fresh.error);
    }
  }
  const eventAt = (body.createdAt && !isNaN(new Date(body.createdAt).getTime())) ? new Date(body.createdAt).toISOString() : new Date().toISOString();
  const opts = { source, trigger, eventAt, leadStage: cal.leadStageFor(b.status) };

  const found = await store.findForBooking(b);
  if (!found.ok) {
    console.error('[cal-webhook] lookup failed:', found.status, found.error);
    return send(res, 500, { ok: false, error: 'lookup_failed' });
  }
  let leadId = found.row && found.row.lead_id;
  let created = false;
  if (!leadId) {
    const c = await store.createFromBooking(b, opts);
    if (!c.ok) { console.error('[cal-webhook] create failed:', c.status, c.error); return send(res, 500, { ok: false, error: 'store_failed' }); }
    leadId = c.lead_id; created = true;
  }

  const logged = await store.logEvent({
    lead_id: leadId, funnel: 'individual', stage: 'cal_' + trigger.toLowerCase(), lead_stage: opts.leadStage,
    payload: { trigger, received_at: new Date().toISOString(), event_at: eventAt, source, booking: b }
  }, trigger + ':' + b.uid + ':' + eventAt);
  // A re-delivery is logged once but still applied: if the first attempt failed half-way, this
  // completes it, and if it succeeded the guarded update below is a no-op.
  const duplicate = Boolean(logged.ok && logged.duplicate);
  if (!logged.ok) console.error('[cal-webhook] event log failed:', logged.status, logged.error);

  if (created) { log('created_row', { trigger, uid: b.uid, lead_id: leadId }); return send(res, 200, { ok: true, lead_id: leadId, created: true }); }

  const applied = await store.applyBooking(leadId, b, opts);
  if (!applied.ok) {
    console.error('[cal-webhook] update failed:', applied.status, applied.error);
    return send(res, 500, { ok: false, error: 'store_failed' });
  }
  log(applied.updated ? 'synced' : 'stale_kept_newer', { trigger, uid: b.uid, lead_id: leadId, status: b.status, duplicate });
  return send(res, 200, { ok: true, lead_id: leadId, updated: applied.updated, duplicate: duplicate || undefined });
}

module.exports = handler;
