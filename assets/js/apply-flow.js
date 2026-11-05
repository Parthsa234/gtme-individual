/*
 * GTME.School individual VSL — multi-step application and the pages it routes to.
 *
 *   vsl.html                  [data-steps] form: one question per screen. Step 1 (name, email, phone) is saved
 *                             to /api/apply as stage "contact" the moment it is completed, so abandoned forms
 *                             can be followed up. The last step sends stage "application" and routes:
 *                               qualified     → routes.qualified   (calendar straight away)
 *                               not qualified → routes.notQualified (recorded-course offer)
 *   apply-qualified.html      body[data-page=qualified]  Cal.com / Calendly embed, prefilled; on booking sends
 *                             stage "call_booked" and goes to routes.booked
 *   apply-not-a-fit.html      body[data-page=not-a-fit]  links to the recorded course
 *   apply-booked.html         body[data-page=booked]     thank-you + what to prepare
 *
 * Every stage carries the same lead_id, so a CRM (via the webhook) can move one record through
 * started → qualified / not_qualified → call_booked. Tracking events never include personal data.
 */
(function (w, d) {
  'use strict';
  var CFG = w.GTME_CONFIG || {};
  var F = (CFG.funnels && CFG.funnels.individual) || {};
  var ROUTES = Object.assign({ qualified: '/apply/qualified', notQualified: '/apply/not-a-fit', booked: '/apply/booked' }, F.routes || {});
  var track = (w.GTMETrack && w.GTMETrack.event) || function () { return false; };
  var reduce = w.matchMedia && w.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var KEY = 'gtme_applicant';
  function $(s, c) { return (c || d).querySelector(s); }
  function $$(s, c) { return Array.prototype.slice.call((c || d).querySelectorAll(s)); }
  function load() { try { return JSON.parse(w.sessionStorage.getItem(KEY) || '{}'); } catch (e) { return {}; } }
  function save(o) { try { w.sessionStorage.setItem(KEY, JSON.stringify(o)); } catch (e) {} }
  function uid() { return 'lead-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10); }
  function emailKey(e) { return String(e || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40); }
  function attribution() { return (w.GTMETrack && w.GTMETrack.attribution()) || {}; }
  function post(body, keepalive) {
    body.funnel = 'individual'; body.page = w.location.pathname; body.attribution = attribution();
    return fetch(CFG.formEndpoint || '/api/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: !!keepalive });
  }
  function go(url) { setTimeout(function () { w.location.href = url; }, 450); } // a moment for pixels to send
  function qualifies(o) {
    var rules = (F.qualification && F.qualification.disqualifyIf) || [];
    return !rules.some(function (r) { return r.in && r.in.indexOf(o[r.field]) > -1; });
  }

  /* ================================================================ multi-step form */
  var form = $('[data-steps]');
  if (form) setupSteps(form);

  function setupSteps(form) {
    var steps = $$('.sf-step', form), total = steps.length, i = 0, busy = false;
    var bar = $('.sf-bar i', form), count = $('.sf-count b', form), back = $('.sf-back', form), err = $('.form-error', form);
    var box = form.parentNode;
    var state = load();
    if (!state.lead_id) { state.lead_id = uid(); save(state); }
    $('.sf-total', form) && ($('.sf-total', form).textContent = total);

    // restore anything already typed this session
    ['full_name', 'email', 'phone'].forEach(function (k) { var el = form.elements[k]; if (el && state[k]) el.value = state[k]; });
    if (state.consent && form.elements.consent) form.elements.consent.checked = true;
    $$('input[type=radio]', form).forEach(function (r) { if (state.answers && state.answers[r.name] === r.value) r.checked = true; });

    function show(n, focus) {
      i = Math.max(0, Math.min(total - 1, n));
      steps.forEach(function (s, j) { s.hidden = j !== i; s.classList.toggle('in', j === i); });
      if (bar) bar.style.width = ((i + 1) / total * 100) + '%';
      if (count) count.textContent = i + 1;
      if (back) back.hidden = i === 0;
      updateFwd();
      if (err) err.hidden = true;
      if (focus !== false) { var f = $('input:not([type=hidden]):not([tabindex="-1"])', steps[i]); var checked = $('input:checked', steps[i]); (checked || f) && (checked || f).focus({ preventScroll: true }); }
      track('ApplicationStep', { step: i + 1 }, { key: String(i + 1) });
    }

    var fwd = $('.sf-fwd', form);
    function updateFwd() { if (fwd) fwd.hidden = !(i > 0 && i < total - 1 && $('input:checked', steps[i])); }
    if (fwd) fwd.addEventListener('click', function () { show(i + 1); });

    /* ---- step 1 validation (same messages as the rest of the site) ---- */
    function msgFor(el) {
      var v = el.validity;
      if (v.valueMissing) return el.type === 'checkbox' ? 'Please tick this box to continue.' : 'This field is required.';
      if (v.typeMismatch && el.type === 'email') return 'Enter a valid email address, like name@company.com.';
      if (v.patternMismatch) return el.getAttribute('data-pattern-msg') || 'Please check the format.';
      return '';
    }
    function check(el) {
      if (el.value && el.type !== 'checkbox') el.value = el.value.replace(/^\s+/, '');
      var m = msgFor(el), out = d.getElementById(el.id + '-err');
      if (out) out.textContent = m;
      el.setAttribute('aria-invalid', m ? 'true' : 'false');
      el.closest('.f') && el.closest('.f').classList.toggle('bad', !!m);
      return !m;
    }
    $$('input', steps[0]).forEach(function (el) {
      el.addEventListener('blur', function () { if (el.value || el.getAttribute('aria-invalid')) check(el); });
      el.addEventListener('input', function () { if (el.getAttribute('aria-invalid') === 'true') check(el); });
    });

    function stepOneDone() {
      var bad = null;
      $$('input:not([name=website])', steps[0]).forEach(function (el) { if (!check(el) && !bad) bad = el; });
      if (bad) { bad.focus(); return false; }
      ['full_name', 'email', 'phone'].forEach(function (k) { state[k] = form.elements[k].value.trim(); });
      state.consent = form.elements.consent.checked; save(state);
      if (form.elements.website && form.elements.website.value) return true; // honeypot: carry on, send nothing
      // Save the contact now, without making the applicant wait for it.
      post({ stage: 'contact', lead_id: state.lead_id, full_name: state.full_name, email: state.email, phone: state.phone, consent: state.consent }, true)
        .then(function (r) { if (r.ok) { state.contact_saved = true; save(state); track('Lead', { stage: 'contact' }, { persist: true, key: emailKey(state.email) }); } })
        .catch(function () {});
      return true;
    }

    /* ---- choice steps: click / tap / letter key, then advance ---- */
    steps.forEach(function (s, j) {
      $$('input[type=radio]', s).forEach(function (r) {
        function pick() {
          state.answers = state.answers || {}; state.answers[r.name] = r.value; save(state);
          updateFwd();
          if (j < total - 1) setTimeout(function () { if (i === j) show(j + 1); }, reduce ? 0 : 320);
        }
        r.addEventListener('change', pick);
        // clicking the answer that is already selected (e.g. after Back) still moves on
        r.addEventListener('click', function () { if (r.__was) pick(); });
        r.addEventListener('pointerdown', function () { r.__was = r.checked; });
        r.closest('label').addEventListener('pointerdown', function () { r.__was = r.checked; });
      });
    });
    form.addEventListener('keydown', function (e) {
      if (i === 0 || e.altKey || e.ctrlKey || e.metaKey) return;
      var k = (e.key || '').toUpperCase();
      if (/^[A-Z]$/.test(k)) { var opt = $('input[type=radio][data-key="' + k + '"]', steps[i]); if (opt) { e.preventDefault(); var was = opt.checked; opt.checked = true; opt.__was = was; opt.dispatchEvent(new Event(was ? 'click' : 'change', { bubbles: true })); } }
    });

    $$('[data-next]', form).forEach(function (b) { b.addEventListener('click', function () {
      if (i === 0) { if (stepOneDone()) show(1); return; }
      if (!$('input:checked', steps[i])) { err.textContent = 'Pick one option to continue.'; err.hidden = false; return; }
      show(i + 1);
    }); });
    if (back) back.addEventListener('click', function () { show(i - 1); });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (i === 0) { if (stepOneDone()) show(1); return; }
      if (i < total - 1) { $('[data-next]', steps[i]) && $('[data-next]', steps[i]).click(); return; }
      submit();
    });

    function setBusy(on) {
      busy = on; var btn = $('button[type=submit]', steps[total - 1]);
      if (btn) { btn.disabled = on; btn.setAttribute('aria-busy', on ? 'true' : 'false'); $('.lbl', btn).textContent = on ? 'Sending…' : btn.getAttribute('data-label'); }
    }
    function submit() {
      if (busy) return;
      var missing = steps.slice(1).filter(function (s) { return !$('input:checked', s); })[0];
      if (missing) { show(steps.indexOf(missing)); err.textContent = 'Pick one option to continue.'; err.hidden = false; return; }
      var a = state.answers || {};
      var o = { stage: 'application', lead_id: state.lead_id, full_name: state.full_name, email: state.email, phone: state.phone, consent: state.consent,
        persona: a.persona, goal: a.goal, tried: a.tried, hours_ok: a.hours_ok, invest: a.invest, start: a.start };
      o.qualified = qualifies(o);
      state.qualified = o.qualified; save(state);
      var dest = o.qualified ? ROUTES.qualified : ROUTES.notQualified;
      if (form.elements.website && form.elements.website.value) { go(dest); return; }
      setBusy(true);
      post(o).then(function (r) {
        if (r.ok) {
          track('SubmitApplication', { qualified: o.qualified }, { persist: true, key: emailKey(o.email) });
          if (!state.contact_saved) track('Lead', { stage: 'application' }, { persist: true, key: emailKey(o.email) });
          state.submitted = true; save(state);
          box.classList.add('routing'); go(dest); return;
        }
        if ((r.status === 404 || r.status === 405 || r.status === 501 || r.status === 503) && CFG.mailtoFallback) return fallback(o, dest);
        return r.json().catch(function () { return {}; }).then(function (j) { setBusy(false); err.textContent = (j && j.message) || 'Something went wrong sending your application. Please try again in a moment.'; err.hidden = false; });
      }).catch(function () { setBusy(false); err.textContent = 'We couldn’t reach the server. Check your connection and try again — your answers are still here.'; err.hidden = false; });
    }
    function fallback(o, dest) {
      setBusy(false);
      var lines = ['Name: ' + o.full_name, 'Email: ' + o.email, 'Phone: ' + o.phone, 'Describes me: ' + o.persona, 'In 6 months: ' + o.goal, 'Tried so far: ' + o.tried,
        '6–10 hours a week: ' + o.hours_ok, 'Investment: ' + o.invest, 'Start: ' + o.start, 'Qualified: ' + (o.qualified ? 'yes' : 'no')];
      var fb = $('.form-fallback', box); if (fb) { fb.hidden = false; var c = $('[data-continue]', fb); if (c) c.href = dest; }
      form.hidden = true;
      try { w.location.href = 'mailto:' + CFG.mailtoFallback + '?subject=' + encodeURIComponent('GTME.School application') + '&body=' + encodeURIComponent(lines.join('\n')); } catch (e) {}
      track('ApplicationFallback', { qualified: o.qualified });
    }

    show(0, false);
    // "Apply now" buttons focus the first field once the form is in view
    $$('a[href="#apply"]').forEach(function (a) { a.addEventListener('click', function () { setTimeout(function () { if (i === 0) { var f = form.elements.full_name; f && f.focus({ preventScroll: true }); } }, reduce ? 0 : 700); }); });
  }

  /* ================================================================ destination pages */
  var page = d.body.getAttribute('data-page');
  var me = load();
  $$('[data-first-name]').forEach(function (el) { var n = (me.full_name || '').split(/\s+/)[0]; if (n) el.textContent = n; });

  if (page === 'qualified') {
    track('CompleteRegistration', { status: 'qualified' }, { persist: true, key: me.lead_id || 'direct' });
    mountBooking();
  }
  if (page === 'not-a-fit') {
    track('Disqualified', {}, { persist: true, key: me.lead_id || 'direct' });
    var ds = F.downsell || {};
    $$('[data-downsell]').forEach(function (a) {
      if (ds.url) a.href = ds.url; else { a.href = 'mailto:' + (CFG.mailtoFallback || 'hello@gtme.school') + '?subject=' + encodeURIComponent('The recorded GTM engineering course'); }
      a.addEventListener('click', function () { track('DownsellClick', { offer: 'course' }); });
    });
    $$('[data-downsell-price]').forEach(function (el) { if (ds.price) el.textContent = ds.price; });
    $$('[data-downsell-name]').forEach(function (el) { if (ds.name) el.textContent = ds.name; });
  }
  if (page === 'booked') {
    var v = F.prepVideoSrc, slot = $('[data-prep-video]');
    if (v && slot) {
      var m, url = null;
      if ((m = v.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{6,})/))) url = 'https://www.youtube-nocookie.com/embed/' + m[1] + '?rel=0&modestbranding=1&playsinline=1';
      else if ((m = v.match(/vimeo\.com\/(?:video\/)?(\d+)/))) url = 'https://player.vimeo.com/video/' + m[1];
      else if (/loom\.com\/share\//.test(v)) url = v.replace('/share/', '/embed/');
      slot.innerHTML = url ? '<iframe src="' + url + '" title="What to prepare for your call" allow="fullscreen; picture-in-picture" allowfullscreen></iframe>' : '<video src="' + v + '" controls playsinline preload="metadata"></video>';
      slot.hidden = false;
    }
  }

  /* ---------------------------------------------------------------- booking embed */
  function mountBooking() {
    var box = $('[data-booking]'); if (!box) return;
    var link = F.bookingUrl || F.calendlyUrl || '';
    if (!link) return; // the labelled placeholder stays
    var booked = false;
    function onBooked(info) {
      if (booked) return; booked = true;
      track('Schedule', { content_category: 'individual' }, { persist: true, key: me.lead_id || 'direct' });
      if (me.email) post({ stage: 'call_booked', lead_id: me.lead_id, email: me.email, full_name: me.full_name, booking_time: (info && info.time) || '', booking_ref: (info && info.ref) || '' }, true).catch(function () {});
      me.booked = true; save(me);
      var ok = $('[data-booked-msg]'); if (ok) ok.hidden = false;
      go(ROUTES.booked);
    }
    var u;
    try { u = new URL(link); } catch (e) { return; }
    box.innerHTML = '';
    if (/calendly\.com$/.test(u.hostname)) {
      if (me.full_name) u.searchParams.set('name', me.full_name);
      if (me.email) u.searchParams.set('email', me.email);
      u.searchParams.set('hide_gdpr_banner', '1');
      box.innerHTML = '<div class="calendly-inline-widget" data-url="' + u.toString().replace(/"/g, '&quot;') + '" style="min-width:300px;height:760px"></div>';
      var s = d.createElement('script'); s.src = 'https://assets.calendly.com/assets/external/widget.js'; s.async = true; d.body.appendChild(s);
      w.addEventListener('message', function (e) {
        if (!/^https:\/\/([a-z0-9-]+\.)?calendly\.com$/.test(e.origin) || !e.data || typeof e.data.event !== 'string') return;
        if (e.data.event === 'calendly.event_type_viewed') track('BookingView', { content_category: 'individual' });
        if (e.data.event === 'calendly.event_scheduled') onBooked({ ref: (e.data.payload && e.data.payload.event && e.data.payload.event.uri) || '' });
      });
    } else {
      /* Cal.com inline embed, in the namespaced form Cal's own embed snippet generates
         (https://cal.com/docs/developing/guides/embeds). calLink and the namespace both come from
         bookingUrl, so changing the link in config.js is enough. Note the handlers are registered
         on the namespace api, not on the global Cal — on a namespaced embed a booking is only
         reported back through Cal.ns[namespace], and without that the call would never reach
         /api/apply as stage "call_booked". */
      var calLink = u.pathname.replace(/^\/+|\/+$/g, '');                  // 'shrinishkarsh/gtme-school'
      var ns = F.bookingNamespace || calLink.split('/').pop() || 'booking'; // 'gtme-school'
      var el = d.createElement('div'); el.id = 'cal-inline'; el.style.cssText = 'width:100%;min-height:680px;overflow:auto'; box.appendChild(el);
      (function (C, A, L) { var p = function (a, ar) { a.q.push(ar); }; var doc = C.document;
        C.Cal = C.Cal || function () { var cal = C.Cal, ar = arguments; if (!cal.loaded) { cal.ns = {}; cal.q = cal.q || []; doc.head.appendChild(doc.createElement('script')).src = A; cal.loaded = true; }
          if (ar[0] === L) { var api = function () { p(api, arguments); }, nsArg = ar[1]; api.q = api.q || []; if (typeof nsArg === 'string') { cal.ns[nsArg] = cal.ns[nsArg] || api; p(cal.ns[nsArg], ar); p(cal, ['initNamespace', nsArg]); } else p(cal, ar); return; }
          p(cal, ar); };
      })(w, 'https://app.cal.com/embed/embed.js', 'init');
      w.Cal('init', ns, { origin: F.bookingOrigin || 'https://app.cal.com' });
      w.Cal.config = w.Cal.config || {};
      w.Cal.config.forwardQueryParams = true; // carries utm_* / fbclid through to the booking
      var cal = w.Cal.ns[ns];
      // theme is pinned light because the booking section of the page is light in both schemes
      var conf = { layout: 'month_view', useSlotsViewOnSmallScreen: 'true', theme: 'light' };
      if (me.full_name) conf.name = me.full_name;
      if (me.email) conf.email = me.email;
      cal('inline', { elementOrSelector: '#cal-inline', calLink: calLink, config: conf });
      cal('ui', { hideEventTypeDetails: false, layout: 'month_view' });
      cal('on', { action: 'linkReady', callback: function () { track('BookingView', { content_category: 'individual' }); } });
      ['bookingSuccessful', 'bookingSuccessfulV2'].forEach(function (action) {
        cal('on', { action: action, callback: function (e) { var dt = (e && e.detail && e.detail.data) || {}; onBooked({ time: dt.startTime || dt.date || '', ref: (dt.booking && dt.booking.uid) || dt.uid || '' }); } });
      });
    }
    box.classList.add('live');
  }
})(window, document);
