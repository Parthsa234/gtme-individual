/*
 * GTME.School VSL — tracking hooks.
 *
 * One function, GTMETrack.event(name, params, opts), is the only way the page reports anything.
 * It fans out to:
 *   - Google Tag Manager  (dataLayer.push({ event: 'gtme_<name>', ... }))
 *   - Meta Pixel          (fbq('track', name) for standard events, fbq('trackCustom') otherwise)
 *   - Google Ads          (gtag('event', 'conversion') when a label is configured for that event)
 *
 * Scripts are only loaded when their ID is set in config.js. Events are de-duplicated:
 *   - in memory, per page load, for every event;
 *   - in sessionStorage for events marked { persist: true } (Lead, CompleteRegistration, Schedule),
 *     so a refresh or a second submit cannot report the same conversion twice.
 * Every event carries an eventID that can be reused for Meta Conversions API de-duplication.
 */
(function (w, d) {
  'use strict';
  var cfg = (w.GTME_CONFIG && w.GTME_CONFIG.tracking) || {};
  var debug = !!(w.GTME_CONFIG && w.GTME_CONFIG.debug) || /[?&]debug=1\b/.test(w.location.search);
  var META_STANDARD = { PageView: 1, ViewContent: 1, Lead: 1, CompleteRegistration: 1, Schedule: 1, Contact: 1 };
  var fired = {};
  w.__gtmeEvents = w.__gtmeEvents || [];
  w.dataLayer = w.dataLayer || [];

  function store(k, v) { try { if (v === undefined) return w.sessionStorage.getItem(k); w.sessionStorage.setItem(k, v); } catch (e) { return null; } }
  function uid() { return 'gtme-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }
  function script(src) { var s = d.createElement('script'); s.async = true; s.src = src; d.head.appendChild(s); }

  /* ---- loaders (only when configured) ---- */
  if (cfg.gtmId) {
    w.dataLayer.push({ 'gtm.start': Date.now(), event: 'gtm.js' });
    script('https://www.googletagmanager.com/gtm.js?id=' + encodeURIComponent(cfg.gtmId));
  }
  if (cfg.metaPixelId) {
    /* standard Meta Pixel bootstrap */
    (function (f, b, e, v, n, t, s) { if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
      if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = []; t = b.createElement(e); t.async = !0; t.src = v;
      s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s); })(w, d, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    w.fbq('init', cfg.metaPixelId);
  }
  var ads = cfg.googleAds || {};
  if (ads.id) {
    script('https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(ads.id));
    w.gtag = w.gtag || function () { w.dataLayer.push(arguments); };
    w.gtag('js', new Date()); w.gtag('config', ads.id);
  }

  /* ---- attribution: keep UTM / click IDs for the whole session ---- */
  var ATTR_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid', 'wbraid', 'gbraid'];
  (function captureAttribution() {
    var q = new URLSearchParams(w.location.search), saved = {};
    try { saved = JSON.parse(store('gtme_attr') || '{}'); } catch (e) { saved = {}; }
    ATTR_KEYS.forEach(function (k) { if (q.get(k)) saved[k] = q.get(k).slice(0, 200); });
    if (!saved.landing_page) saved.landing_page = w.location.pathname;
    if (!saved.referrer && d.referrer) saved.referrer = d.referrer.slice(0, 300);
    store('gtme_attr', JSON.stringify(saved));
  })();

  function attribution() { try { return JSON.parse(store('gtme_attr') || '{}'); } catch (e) { return {}; } }

  /**
   * Report an event.
   * @param {string} name   PageView | ViewContent | Lead | CompleteRegistration | Schedule | any custom name
   * @param {object} params extra parameters (no personal data: never pass names, emails or phone numbers)
   * @param {object} opts   { key: dedupe key suffix, persist: true to dedupe across the session }
   * @returns {boolean} true if the event fired, false if it was a duplicate
   */
  function event(name, params, opts) {
    params = params || {}; opts = opts || {};
    var funnel = d.body ? d.body.getAttribute('data-funnel') : '';
    var key = 'gtme_evt_' + funnel + '_' + name + (opts.key ? '_' + opts.key : '');
    if (fired[key] || (opts.persist && store(key))) { if (debug) console.info('[gtme] skipped duplicate', name); return false; }
    fired[key] = 1; if (opts.persist) store(key, '1');

    var eventID = uid();
    var payload = Object.assign({ funnel: funnel }, params);

    w.dataLayer.push(Object.assign({ event: 'gtme_' + name.replace(/[A-Z]/g, function (c, i) { return (i ? '_' : '') + c.toLowerCase(); }), event_id: eventID }, payload));
    if (w.fbq && cfg.metaPixelId) {
      if (META_STANDARD[name]) w.fbq('track', name, payload, { eventID: eventID });
      else w.fbq('trackCustom', name, payload, { eventID: eventID });
    }
    var label = ads.conversions && ads.conversions[name];
    if (w.gtag && ads.id && label) w.gtag('event', 'conversion', { send_to: ads.id + '/' + label, transaction_id: eventID });

    var rec = { name: name, params: payload, eventID: eventID, t: Date.now() };
    w.__gtmeEvents.push(rec);
    if (debug) console.info('[gtme] event', rec);
    return true;
  }

  w.GTMETrack = { event: event, attribution: attribution, _reset: function () { fired = {}; } };

  // PageView fires once per page load, as soon as this script runs.
  event('PageView', { page: w.location.pathname });
})(window, document);
