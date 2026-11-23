/*
 * POST /api/brochure — brochure download lead capture.
 *
 * Two actions, both POST with a JSON body:
 *
 *   (default) request   { full_name, email, phone, profession, website (honeypot), page, attribution }
 *       → validated and normalised here, then public.brochure_capture() (Supabase, service role)
 *         rate-limits, upserts the lead on lower(email) and creates a download event 'requested'.
 *       ← { ok, event_id, token, download_url, filename }
 *         Nothing about the lead is echoed back. The browser only starts the download after this.
 *
 *   status              { action:'status', event_id, token, status:'initiated'|'failed', reason }
 *       → public.brochure_set_status(). `token` is an HMAC of event_id the request answer carried,
 *         so only the browser that made the request can report on its event.
 *
 * Environment: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (already set by the Vercel ↔ Supabase
 * integration). Nothing secret reaches the browser. Logs never contain names, emails or phones.
 */
'use strict';

const crypto = require('crypto');
const store = require('./_supabase.js');

// The brochure itself. The server decides what is recorded, so a client can't log another file.
const BROCHURE = {
  name: 'GTME-School-Brochure.pdf',
  version: '2026-27',
  url: '/assets/docs/GTME-School-Brochure.pdf'
};
const PROFESSIONS = ['Student', 'Working Professional', 'Agency Owner', 'Freelancer', 'Founder / Business Owner', 'Other'];
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/;
const ATTR = { utm_source: 200, utm_medium: 200, utm_campaign: 200, utm_content: 200, utm_term: 200, landing_page: 300, referrer: 300 };

/* Strip control characters and angle brackets, collapse whitespace. */
function text(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001F\u007F<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/* "+91 98765-43210" → "+919876543210". Returns '' when it isn't a plausible international number. */
function normalisePhone(v) {
  if (typeof v !== 'string') return '';
  const raw = v.trim();
  if (!/^\+?[0-9 ()\-.]{7,24}$/.test(raw)) return '';
  const p = '+' + raw.replace(/\D/g, '');
  if (!/^\+[1-9][0-9]{6,14}$/.test(p)) return '';
  if (p.startsWith('+91') && !/^\+91[6-9][0-9]{9}$/.test(p)) return ''; // Indian mobile: 10 digits, starts 6–9
  if (p.startsWith('+1') && !/^\+1[2-9][0-9]{9}$/.test(p)) return '';   // US / Canada: 10 digits
  return p;
}

/** Validate and normalise a request. Returns { ok, errors, data }. Exported for tests. */
function validate(body) {
  const errors = {};
  if (!body || typeof body !== 'object') return { ok: false, errors: { body: 'invalid' }, data: {} };
  const data = {
    full_name: text(body.full_name, 120),
    email: text(body.email, 160).toLowerCase(),
    phone: normalisePhone(body.phone),
    profession: PROFESSIONS.indexOf(body.profession) > -1 ? body.profession : ''
  };
  if (data.full_name.length < 2 || !/\p{L}/u.test(data.full_name)) errors.full_name = data.full_name ? 'invalid' : 'required';
  if (!data.email) errors.email = 'required'; else if (!EMAIL.test(data.email)) errors.email = 'invalid';
  if (!data.phone) errors.phone = body.phone ? 'invalid' : 'required';
  if (!data.profession) errors.profession = body.profession ? 'invalid' : 'required';
  const a = body.attribution && typeof body.attribution === 'object' ? body.attribution : {};
  for (const k of Object.keys(ATTR)) data[k] = text(a[k], ATTR[k]) || null;
  if (!data.landing_page) data.landing_page = text(body.page, 300) || null;
  return { ok: Object.keys(errors).length === 0, errors, data };
}

function secret() { return (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '').trim(); }
function sign(eventId) { return crypto.createHmac('sha256', secret()).update('brochure-event:' + eventId).digest('hex').slice(0, 32); }
function tokenOk(eventId, token) {
  if (typeof token !== 'string' || token.length !== 32) return false;
  return crypto.timingSafeEqual(Buffer.from(sign(eventId)), Buffer.from(token));
}
/* Salted, truncated hash of the client IP, only for rate limiting. The IP itself is never stored. */
function ipHash(req) {
  const h = req.headers || {};
  const ip = String(h['x-forwarded-for'] || h['x-real-ip'] || (req.socket && req.socket.remoteAddress) || '').split(',')[0].trim();
  if (!ip) return null;
  return crypto.createHmac('sha256', secret()).update('brochure-ip:' + ip).digest('hex').slice(0, 32);
}
/* Reject cross-site posts. Browsers always send Origin on a cross-origin fetch POST. */
function sameOrigin(req) {
  const h = req.headers || {};
  if (!h.origin) return true;
  let host;
  try { host = new URL(h.origin).host; } catch (e) { return false; }
  /* gtme.school/vsl proxies to this project, so its pages post from the main site's host. */
  if (PROXY_HOSTS.indexOf(host) > -1) return true;
  return host === (h['x-forwarded-host'] || h.host);
}
const PROXY_HOSTS = ['gtme.school', 'www.gtme.school'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ ok: false, error: 'method_not_allowed' }); }
  if (!sameOrigin(req)) return res.status(403).json({ ok: false, error: 'forbidden' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || typeof body !== 'object') return res.status(400).json({ ok: false, error: 'invalid_body' });

  if (body.action === 'status') return status(body, res);

  // Honeypot: bots fill the hidden "website" field. Answer like a success, store nothing.
  if (typeof body.website === 'string' && body.website.trim()) {
    return res.status(200).json({ ok: true, download_url: BROCHURE.url, filename: BROCHURE.name });
  }

  const v = validate(body);
  if (!v.ok) return res.status(400).json({ ok: false, error: 'validation', fields: v.errors, message: 'Some fields need attention. Please check the form and try again.' });
  if (!store.isConfigured()) {
    console.error('[brochure] supabase not configured');
    return res.status(503).json({ ok: false, error: 'not_configured', message: 'Downloads are unavailable right now. Please try again shortly, or email hello@gtme.school.' });
  }

  const d = v.data;
  const r = await store.rpc('brochure_capture', {
    p_full_name: d.full_name, p_email: d.email, p_phone: d.phone, p_profession: d.profession,
    p_landing_page: d.landing_page, p_referrer: d.referrer,
    p_utm_source: d.utm_source, p_utm_medium: d.utm_medium, p_utm_campaign: d.utm_campaign,
    p_utm_content: d.utm_content, p_utm_term: d.utm_term,
    p_brochure_name: BROCHURE.name, p_brochure_version: BROCHURE.version, p_ip_hash: ipHash(req)
  });
  const out = r.ok && r.data;
  if (!out || out.ok !== true) {
    if (out && out.error === 'rate_limited') {
      console.warn('[brochure] rate limited');
      return res.status(429).json({ ok: false, error: 'rate_limited', message: 'Too many requests. Please wait a few minutes and try again.' });
    }
    // PostgREST error text can echo the row, so only the status code is logged.
    console.error('[brochure] capture failed:', r.status || 'no_status');
    return res.status(502).json({ ok: false, error: 'upstream', message: 'We couldn’t process your request just now. Please try again in a moment.' });
  }
  console.log('[brochure] captured', JSON.stringify({ event_id: out.event_id, new_lead: out.new_lead }));
  return res.status(200).json({
    ok: true,
    event_id: out.event_id,
    token: sign(out.event_id),
    download_url: BROCHURE.url,
    filename: BROCHURE.name
  });
}

async function status(body, res) {
  const id = String(body.event_id || '');
  const st = body.status === 'initiated' || body.status === 'failed' ? body.status : '';
  if (!UUID.test(id) || !st || !secret() || !tokenOk(id, body.token)) return res.status(400).json({ ok: false, error: 'invalid' });
  const r = await store.rpc('brochure_set_status', { p_event_id: id, p_status: st, p_reason: text(body.reason, 120) || null });
  if (!r.ok) { console.error('[brochure] status failed:', r.status || 'no_status'); return res.status(502).json({ ok: false, error: 'upstream' }); }
  return res.status(200).json({ ok: true, updated: r.data === true });
}

module.exports = handler;
module.exports.validate = validate;
module.exports.normalisePhone = normalisePhone;
module.exports.BROCHURE = BROCHURE;
