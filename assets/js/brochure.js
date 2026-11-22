/*
 * GTME.School VSL — brochure download.
 *
 * [data-brochure-open] buttons open the #brochure drawer. The form is validated here, then POSTed to
 * /api/brochure, which validates again, stores the lead and a 'requested' download event in
 * Supabase, and answers with the file URL. Only then does the download start:
 *   - the PDF is fetched and handed to the browser as a download → event marked 'initiated'
 *   - the fetch fails                                            → event marked 'failed', and the
 *                                                                   manual button stays in view
 *   - in-app browsers (Instagram, Facebook, ...) can't save blobs → no auto-download; the manual
 *                                                                   button opens the PDF and marks
 *                                                                   the event 'initiated' when tapped
 * "Initiated" means the browser was handed the file. No browser reports that it was saved, so the
 * event never claims more than that.
 *
 * Tracking (assets/js/track.js, once each): BrochureFormOpened (per page load),
 * BrochureLeadSubmitted and BrochureDownloadInitiated (per download event). No personal data.
 */
(function (w, d) {
  'use strict';
  var root = d.getElementById('brochure');
  if (!root) return;
  var CFG = w.GTME_CONFIG || {};
  var track = (w.GTMETrack && w.GTMETrack.event) || function () { return false; };
  var ENDPOINT = CFG.brochureEndpoint || '/api/brochure';
  var EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/;
  var IN_APP = /FBAN|FBAV|FB_IAB|Instagram|Line\/|LinkedInApp|Snapchat|; wv\)/i.test(navigator.userAgent || '');

  function $(s, c) { return (c || d).querySelector(s); }
  function $$(s, c) { return Array.prototype.slice.call((c || d).querySelectorAll(s)); }

  var panel = $('.bro-panel', root), form = $('#brochure-form', root), done = $('.bro-done', root);
  var btn = $('button[type=submit]', form), summary = $('.form-error', form);
  var statusEl = $('.bro-status', done), fileLink = $('[data-bro-file]', done);
  var fields = { full_name: $('#bro-name', form), email: $('#bro-email', form), phone: $('#bro-phone', form), profession: $('#bro-prof', form) };
  var cc = $('#bro-cc', form);
  var opener = null, busy = false, current = null, scrollY = 0, closeTimer = null;

  /* ------------------------------------------------------------------ open / close */
  function lockScroll(on) {
    var b = d.body;
    if (on) {
      scrollY = w.scrollY || w.pageYOffset || 0;
      b.style.position = 'fixed'; b.style.top = -scrollY + 'px'; b.style.left = '0'; b.style.right = '0'; b.style.width = '100%';
    } else {
      b.style.position = ''; b.style.top = ''; b.style.left = ''; b.style.right = ''; b.style.width = '';
      try { w.scrollTo({ top: scrollY, behavior: 'instant' }); } catch (e) { w.scrollTo(0, scrollY); }
    }
  }
  function open(e) {
    if (!root.hidden && root.classList.contains('open')) return;
    clearTimeout(closeTimer);
    opener = e && e.currentTarget;
    root.hidden = false; lockScroll(true);
    w.requestAnimationFrame(function () { w.requestAnimationFrame(function () { root.classList.add('open'); }); });
    // Focus the first field on desktop; on touch screens focus the panel so the keyboard doesn't jump up.
    var fine = w.matchMedia && w.matchMedia('(pointer:fine)').matches;
    setTimeout(function () { (current ? done : (fine ? fields.full_name : panel)).focus({ preventScroll: true }); }, 60);
    track('BrochureFormOpened', { content_name: 'brochure', location: (opener && opener.getAttribute('data-brochure-open')) || 'unknown' });
  }
  function close(evt) {
    if (root.hidden) return;
    root.classList.remove('open');
    var reduce = w.matchMedia && w.matchMedia('(prefers-reduced-motion: reduce)').matches;
    closeTimer = setTimeout(function () { root.hidden = true; }, reduce ? 0 : 320);
    lockScroll(false);
    // A link inside the drawer (e.g. "Apply now") navigates; otherwise give focus back to the opener.
    var a = evt && evt.currentTarget && evt.currentTarget.getAttribute('href');
    if (a && a.charAt(0) === '#') { var t = d.querySelector(a); if (t) { evt.preventDefault(); setTimeout(function () { t.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 40); } }
    else if (opener && opener.focus) opener.focus({ preventScroll: true });
  }

  $$('[data-brochure-open]').forEach(function (b) { b.hidden = false; b.addEventListener('click', open); });
  $$('[data-bro-close]', root).forEach(function (b) { b.addEventListener('click', close); });
  d.addEventListener('keydown', function (e) {
    if (root.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    // Keep keyboard focus inside the dialog.
    var f = $$('button, [href], input:not([tabindex="-1"]), select, textarea, [tabindex]:not([tabindex="-1"])', panel)
      .filter(function (el) { return !el.disabled && el.offsetParent !== null; });
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (d.activeElement === first || d.activeElement === panel)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && d.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  /* ------------------------------------------------------------------ validation (mirrors /api/brochure) */
  function phoneValue() {
    var raw = fields.phone.value.trim();
    var full = raw.charAt(0) === '+' ? raw : cc.value + raw.replace(/^0+/, '');
    return '+' + full.replace(/\D/g, '');
  }
  function phoneMsg() {
    var raw = fields.phone.value.trim();
    if (!raw) return 'Please enter your phone number.';
    if (!/^\+?[0-9 ()\-.]{6,24}$/.test(raw)) return 'Use digits only, like 98765 43210.';
    var p = phoneValue();
    if (!/^\+[1-9][0-9]{6,14}$/.test(p)) return 'That number looks too short or too long.';
    if (p.indexOf('+91') === 0 && !/^\+91[6-9][0-9]{9}$/.test(p)) return 'Enter a 10-digit Indian mobile number.';
    if (p.indexOf('+1') === 0 && !/^\+1[2-9][0-9]{9}$/.test(p)) return 'Enter a 10-digit number.';
    return '';
  }
  var RULES = {
    full_name: function (v) { return !v ? 'Please enter your name.' : (v.length < 2 || !/[A-Za-zÀ-￿]/.test(v)) ? 'Please enter your full name.' : ''; },
    email: function (v) { return !v ? 'Please enter your email.' : !EMAIL.test(v) ? 'Enter a valid email address, like name@company.com.' : ''; },
    phone: phoneMsg,
    profession: function (v) { return v ? '' : 'Please choose the option that best describes you.'; }
  };
  function check(name) {
    var el = fields[name], m = RULES[name](el.value.trim());
    var out = d.getElementById(el.id + '-err'); if (out) out.textContent = m;
    el.setAttribute('aria-invalid', m ? 'true' : 'false');
    el.closest('.f').classList.toggle('bad', !!m);
    return !m;
  }
  Object.keys(fields).forEach(function (k) {
    var el = fields[k];
    el.addEventListener('blur', function () { if (el.value || el.getAttribute('aria-invalid')) check(k); });
    el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', function () { if (el.getAttribute('aria-invalid') === 'true') check(k); });
  });
  cc.addEventListener('change', function () { if (fields.phone.value) check('phone'); });

  /* ------------------------------------------------------------------ submit */
  function setBusy(on) {
    busy = on; btn.disabled = on; btn.setAttribute('aria-busy', on ? 'true' : 'false');
    $('.lbl', btn).textContent = on ? 'Preparing your brochure…' : btn.getAttribute('data-label');
  }
  function showError(t) { summary.textContent = t; summary.hidden = false; summary.focus(); }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (busy) return; // duplicate-submit guard
    summary.hidden = true;
    var bad = Object.keys(fields).filter(function (k) { return !check(k); });
    if (bad.length) { showError('Please fix the highlighted fields.'); fields[bad[0]].focus(); return; }

    var attr = (w.GTMETrack && w.GTMETrack.attribution && w.GTMETrack.attribution()) || {};
    var body = {
      full_name: fields.full_name.value.trim(),
      email: fields.email.value.trim(),
      phone: phoneValue(),
      profession: fields.profession.value,
      website: $('#bro-website', form).value,
      page: w.location.pathname,
      attribution: {
        utm_source: attr.utm_source, utm_medium: attr.utm_medium, utm_campaign: attr.utm_campaign,
        utm_content: attr.utm_content, utm_term: attr.utm_term,
        landing_page: attr.landing_page || w.location.pathname, referrer: attr.referrer
      }
    };
    setBusy(true);
    var ctrl = 'AbortController' in w ? new AbortController() : null;
    var to = setTimeout(function () { if (ctrl) ctrl.abort(); }, 15000);
    fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) {
        clearTimeout(to);
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (r.ok && j && j.ok && j.download_url) return success(j, body);
          setBusy(false);
          if (j && j.fields) Object.keys(j.fields).forEach(function (k) { if (fields[k]) check(k); });
          showError((j && j.message) || 'Something went wrong. Please try again in a moment.');
        });
      })
      .catch(function () {
        clearTimeout(to); setBusy(false);
        showError('We couldn’t reach the server. Check your connection and try again. Your details are still here.');
      });
  });

  /* ------------------------------------------------------------------ success + download */
  function report(status, reason) {
    if (!current || !current.event_id) return; // honeypot answers carry no event
    try {
      fetch(ENDPOINT, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'status', event_id: current.event_id, token: current.token, status: status, reason: reason || undefined }) }).catch(function () {});
    } catch (e) {}
  }
  function initiated(method) {
    if (!current || current.initiated) return;
    current.initiated = true;
    report('initiated');
    if (current.event_id) track('BrochureDownloadInitiated', { content_name: 'brochure', method: method }, { key: current.event_id, eventId: 'brochure-dl-' + current.event_id });
  }

  function success(j, body) {
    current = { event_id: j.event_id, token: j.token, initiated: false };
    setBusy(false);
    if (j.event_id) track('BrochureLeadSubmitted', { content_name: 'brochure', profession: body.profession }, { key: j.event_id, eventId: 'brochure-lead-' + j.event_id });
    fileLink.href = j.download_url; fileLink.setAttribute('download', j.filename || '');
    $('#bro-h', root).textContent = 'Your GTME brochure';
    form.hidden = true; done.hidden = false; done.focus({ preventScroll: true });

    if (IN_APP) {
      statusEl.textContent = 'Tap the button below to open your brochure.';
      return;
    }
    fetch(j.download_url, { credentials: 'same-origin' })
      .then(function (r) {
        var type = r.headers.get('content-type') || '';
        if (!r.ok || type.indexOf('pdf') === -1) throw new Error('http_' + r.status);
        return r.blob();
      })
      .then(function (blob) {
        var url = URL.createObjectURL(blob), a = d.createElement('a');
        a.href = url; a.download = j.filename || 'GTME-School-Brochure.pdf'; a.style.display = 'none';
        d.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
        statusEl.textContent = 'Your download should start automatically. If it doesn’t, use the button below.';
        initiated('auto');
      })
      .catch(function (err) {
        statusEl.textContent = 'Your download didn’t start automatically. Use the button below to get the brochure.';
        statusEl.classList.add('warn');
        report('failed', (err && err.message) || 'fetch_failed');
      });
  }
  fileLink.addEventListener('click', function () { initiated('manual'); });
})(window, document);
