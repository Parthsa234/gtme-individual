/* GTME.School VSL — page behaviour. Works for both funnels; the funnel comes from <body data-funnel>. */
(function (w, d) {
  'use strict';
  var root = d.documentElement; root.classList.add('js');
  var CFG = w.GTME_CONFIG || {};
  var FUNNEL = d.body.getAttribute('data-funnel') || 'individual';
  var F = (CFG.funnels && CFG.funnels[FUNNEL]) || {};
  var track = (w.GTMETrack && w.GTMETrack.event) || function () { return false; };
  var reduce = w.matchMedia && w.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function $(s, c) { return (c || d).querySelector(s); }
  function $$(s, c) { return Array.prototype.slice.call((c || d).querySelectorAll(s)); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  /* ------------------------------------------------------------------ reveal */
  if (!reduce && 'IntersectionObserver' in w) {
    var io = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.remove('pre'); e.target.classList.add('in'); io.unobserve(e.target); } }); }, { rootMargin: '0px 0px -8% 0px' });
    var pending = $$('.rv').filter(function (el) { return el.getBoundingClientRect().top > w.innerHeight; });
    pending.forEach(function (el) { el.classList.add('pre'); io.observe(el); });
    // Safety net: anything already scrolled past (fast scroll, anchor jump) is revealed too.
    var ticking = false;
    function sweep() {
      ticking = false; var lim = w.innerHeight;
      pending = pending.filter(function (el) {
        if (!el.classList.contains('pre')) return false;
        if (el.getBoundingClientRect().top < lim) { el.classList.remove('pre'); el.classList.add('in'); io.unobserve(el); return false; }
        return true;
      });
      if (!pending.length) w.removeEventListener('scroll', onScroll);
    }
    function onScroll() { if (!ticking) { ticking = true; w.requestAnimationFrame(sweep); } }
    w.addEventListener('scroll', onScroll, { passive: true });
    w.addEventListener('hashchange', function () { setTimeout(sweep, 60); });
  }

  /* ------------------------------------------------------------------ VSL player */
  function embedUrl(src) {
    var m;
    if ((m = src.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{6,})/))) return 'https://www.youtube-nocookie.com/embed/' + m[1] + '?autoplay=1&rel=0&modestbranding=1&playsinline=1';
    if ((m = src.match(/vimeo\.com\/(?:video\/)?(\d+)/))) return 'https://player.vimeo.com/video/' + m[1] + '?autoplay=1';
    if (/wistia|loom\.com|embed/.test(src)) return src + (src.indexOf('?') > -1 ? '&' : '?') + 'autoplay=1';
    return null;
  }
  $$('[data-vsl]').forEach(function (box) {
    var src = F.videoSrc || '', poster = F.videoPoster || '';
    var btn = $('.vsl-play', box);
    if (!src) { box.classList.add('is-empty'); return; } // the labelled placeholder stays visible
    if (poster) { var img = $('.vsl-poster', box); if (img) { img.src = poster; img.hidden = false; } }
    var marks = { 25: 0, 50: 0, 75: 0, 100: 0 };
    function start() {
      var url = embedUrl(src), stage = $('.vsl-stage', box);
      stage.innerHTML = '';
      if (url) {
        var f = d.createElement('iframe');
        f.src = url; f.title = 'GTME.School video'; f.allow = 'autoplay; fullscreen; picture-in-picture; encrypted-media'; f.allowFullscreen = true;
        stage.appendChild(f);
        track('ViewContent', { content_name: 'vsl', content_category: FUNNEL });
      } else {
        var v = d.createElement('video');
        v.src = src; v.controls = true; v.playsInline = true; v.preload = 'auto'; if (poster) v.poster = poster;
        v.addEventListener('play', function () { track('ViewContent', { content_name: 'vsl', content_category: FUNNEL }); });
        v.addEventListener('timeupdate', function () {
          if (!v.duration) return; var p = v.currentTime / v.duration * 100;
          [25, 50, 75, 100].forEach(function (m) { if (p >= (m === 100 ? 98 : m) && !marks[m]) { marks[m] = 1; track('VideoProgress', { percent: m }, { key: String(m) }); } });
        });
        stage.appendChild(v); var pr = v.play(); if (pr && pr.catch) pr.catch(function () {});
      }
      box.classList.add('is-playing');
    }
    if (btn) btn.addEventListener('click', start);
  });
  $$('[data-play-vsl]').forEach(function (a) { a.addEventListener('click', function (e) { var b = $('[data-vsl] .vsl-play'); if (b && !$('[data-vsl]').classList.contains('is-empty')) { e.preventDefault(); $('[data-vsl]').scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' }); b.click(); } }); });

  /* ------------------------------------------------------------------ testimonial videos */
  $$('.tv-screen .tv-play').forEach(function (b) {
    b.addEventListener('click', function () {
      var s = b.parentNode, v = d.createElement('video');
      v.src = s.getAttribute('data-src'); v.controls = true; v.playsInline = true; v.preload = 'auto'; v.poster = s.getAttribute('data-poster');
      s.innerHTML = ''; s.appendChild(v); var p = v.play(); if (p && p.catch) p.catch(function () {});
      $$('.tv-screen video, .vsl-stage video').forEach(function (o) { if (o !== v) o.pause(); });
      track('TestimonialPlay', { name: s.getAttribute('data-name') || '' }, { key: s.getAttribute('data-name') || '' });
    });
  });

  /* ------------------------------------------------------------------ proof slots from config */
  var proof = CFG.proof || {};
  $$('[data-proof]').forEach(function (slot) {
    var kind = slot.getAttribute('data-proof'), items = proof[kind] || [];
    if (!items.length) return; // keep the labelled placeholder
    var html = '';
    if (kind === 'studentScreenshots') html = items.map(function (i) { return '<figure class="shot"><button type="button" class="zoom" data-zoom="' + esc(i.src) + '" data-cap="' + esc(i.caption || i.alt) + '"><img src="' + esc(i.src) + '" alt="' + esc(i.alt || '') + '" loading="lazy" decoding="async"></button>' + (i.caption ? '<figcaption>' + esc(i.caption) + '</figcaption>' : '') + '</figure>'; }).join('');
    if (kind === 'linkedinRecommendations' || kind === 'corporateTestimonials') html = items.map(function (i) { return '<blockquote class="rec"><p>' + esc(i.quote) + '</p><footer><b>' + esc(i.name) + '</b><span>' + esc(i.role || '') + '</span>' + (i.url ? '<a href="' + esc(i.url) + '" target="_blank" rel="noopener">View on LinkedIn ↗</a>' : '') + '</footer></blockquote>'; }).join('');
    if (kind === 'verifiedStats') html = items.map(function (i) { return '<div class="stat"><b>' + esc(i.value) + '</b><span>' + esc(i.label) + '</span></div>'; }).join('');
    slot.innerHTML = html; slot.classList.remove('ph-slot'); slot.classList.add('filled');
    bindZoom(slot);
  });

  /* ------------------------------------------------------------------ lightbox */
  var lb;
  function bindZoom(scope) {
    $$('[data-zoom]', scope).forEach(function (b) {
      b.addEventListener('click', function () {
        if (!lb) {
          lb = d.createElement('div'); lb.className = 'lb'; lb.setAttribute('role', 'dialog'); lb.setAttribute('aria-modal', 'true'); lb.setAttribute('aria-label', 'Enlarged image');
          lb.innerHTML = '<button type="button" aria-label="Close">×</button><figure><img alt=""><figcaption></figcaption></figure>';
          d.body.appendChild(lb);
          lb.addEventListener('click', function (e) { if (e.target === lb || e.target.tagName === 'BUTTON') lb.hidden = true; });
          d.addEventListener('keydown', function (e) { if (e.key === 'Escape' && lb) lb.hidden = true; });
        }
        $('img', lb).src = b.getAttribute('data-zoom'); $('img', lb).alt = b.getAttribute('data-cap') || '';
        $('figcaption', lb).textContent = b.getAttribute('data-cap') || ''; lb.hidden = false; $('button', lb).focus();
      });
    });
  }
  bindZoom(d);

  /* ------------------------------------------------------------------ sticky mobile CTA */
  var bar = $('.mbar'), hero = $('.hero'), apply = $('#apply');
  if (bar && hero && 'IntersectionObserver' in w) {
    var heroOut = false, applyIn = false;
    function upd() { bar.classList.toggle('show', heroOut && !applyIn); }
    new IntersectionObserver(function (e) { heroOut = !e[0].isIntersecting; upd(); }).observe(hero);
    if (apply) new IntersectionObserver(function (e) { applyIn = e[0].isIntersecting; upd(); }, { rootMargin: '0px 0px -20% 0px' }).observe(apply);
  }

  /* ------------------------------------------------------------------ application form */
  var form = $('#apply-form');
  if (form) setupForm(form);

  function setupForm(form) {
    var inv = $('[data-investment]', form);
    if (inv) {
      if (F.askInvestment && F.investmentOptions && F.investmentOptions.length) {
        var sel = $('select', inv);
        F.investmentOptions.forEach(function (o) { var op = d.createElement('option'); op.textContent = o; sel.appendChild(op); });
        sel.required = true; inv.hidden = false;
      } else inv.remove();
    }
    var btn = $('button[type=submit]', form), summary = $('.form-error', form), busy = false, done = false;
    var fields = $$('input:not([type=hidden]):not([name=website]), select, textarea', form);

    function msgFor(el) {
      var v = el.validity;
      if (v.valueMissing) return el.type === 'checkbox' ? 'Please tick this box to continue.' : 'This field is required.';
      if (v.typeMismatch && el.type === 'email') return 'Enter a valid email address, like name@company.com.';
      if (v.patternMismatch) return el.getAttribute('data-pattern-msg') || 'Please check the format.';
      if (v.tooShort) return 'Please write at least ' + el.minLength + ' characters (' + el.value.trim().length + ' so far).';
      if (v.tooLong) return 'Please keep this under ' + el.maxLength + ' characters.';
      if (el.getAttribute('data-work-email') !== null && /@(gmail|yahoo|hotmail|outlook|icloud|proton|aol)\./i.test(el.value)) return 'Please use your work email address.';
      return '';
    }
    function check(el) {
      if (el.value && el.type !== 'checkbox') el.value = el.value.replace(/^\s+/, '');
      el.setCustomValidity('');
      var m = msgFor(el);
      if (m && el.validity.valid) el.setCustomValidity(m); // custom rule (work email)
      var out = d.getElementById(el.id + '-err');
      if (out) out.textContent = m;
      el.setAttribute('aria-invalid', m ? 'true' : 'false');
      el.closest('.f') && el.closest('.f').classList.toggle('bad', !!m);
      return !m;
    }
    fields.forEach(function (el) {
      el.addEventListener('blur', function () { if (el.value || el.getAttribute('aria-invalid')) check(el); });
      el.addEventListener('input', function () { if (el.getAttribute('aria-invalid') === 'true') check(el); });
    });
    var cnt = $('[data-count-for]', form);
    if (cnt) { var ta = d.getElementById(cnt.getAttribute('data-count-for')); ta.addEventListener('input', function () { cnt.textContent = ta.value.trim().length + ' / ' + ta.maxLength; }); }

    function data() {
      var o = {};
      $$('input, select, textarea', form).forEach(function (el) {
        if (!el.name) return;
        if (el.type === 'checkbox') o[el.name] = el.checked; else o[el.name] = el.value.trim();
      });
      return o;
    }
    function qualifies(o) {
      var rules = (F.qualification && F.qualification.disqualifyIf) || [];
      return !rules.some(function (r) { return r.in && r.in.indexOf(o[r.field]) > -1; });
    }
    function setBusy(on) {
      busy = on; btn.disabled = on; btn.setAttribute('aria-busy', on ? 'true' : 'false');
      btn.querySelector('.lbl').textContent = on ? 'Sending…' : btn.getAttribute('data-label');
    }
    function showError(text) { summary.textContent = text; summary.hidden = false; summary.focus(); }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (busy || done) return; // duplicate-submit guard
      summary.hidden = true;
      var firstBad = null;
      fields.forEach(function (el) { if (!check(el) && !firstBad) firstBad = el; });
      if (firstBad) { showError('Please fix the highlighted fields.'); firstBad.focus(); return; }
      var o = data();
      if (o.website) { finish(o, true); return; } // honeypot: silently "succeed"
      o.funnel = FUNNEL; o.qualified = qualifies(o); o.page = w.location.pathname;
      o.attribution = (w.GTMETrack && w.GTMETrack.attribution()) || {};
      setBusy(true);

      var ctrl = 'AbortController' in w ? new AbortController() : null;
      var to = setTimeout(function () { ctrl && ctrl.abort(); }, 15000);
      fetch(CFG.formEndpoint || '/api/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o), signal: ctrl ? ctrl.signal : undefined })
        .then(function (r) {
          clearTimeout(to);
          if (r.ok) return r.json().catch(function () { return {}; }).then(function (j) { finish(o, false, j); });
          if ((r.status === 404 || r.status === 405 || r.status === 501 || r.status === 503) && CFG.mailtoFallback) return fallback(o);
          return r.json().catch(function () { return {}; }).then(function (j) {
            setBusy(false); showError((j && j.message) || 'Something went wrong sending your application. Please try again in a moment.');
          });
        })
        .catch(function () {
          clearTimeout(to); setBusy(false);
          showError('We couldn’t reach the server. Check your connection and try again — your answers are still here.');
        });
    });

    function fallback(o) {
      var lines = $$('input, select, textarea', form).filter(function (el) { return el.name && el.name !== 'website' && el.type !== 'checkbox'; })
        .map(function (el) { return (el.getAttribute('data-l') || el.name) + ': ' + el.value.trim(); });
      lines.push('Qualified: ' + (o.qualified ? 'yes' : 'no'), 'Funnel: ' + FUNNEL);
      var subject = FUNNEL === 'corporate' ? 'GTME.School team training enquiry' : 'GTME.School application';
      done = true; setBusy(false); btn.disabled = true;
      $('.form-fallback', form.parentNode).hidden = false;
      try { w.location.href = 'mailto:' + CFG.mailtoFallback + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(lines.join('\n')); } catch (err) {}
      track('ApplicationFallback', { qualified: o.qualified });
    }

    function finish(o, silent) {
      done = true; setBusy(false);
      var wrap = form.parentNode;
      form.hidden = true;
      var ok = $('.form-success', wrap); ok.hidden = false;
      if (silent) { ok.focus(); return; }
      var emailKey = (o.email || o.work_email || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
      track('Lead', { content_category: FUNNEL, qualified: o.qualified }, { persist: true, key: emailKey });
      if (o.qualified) {
        track('CompleteRegistration', { content_category: FUNNEL, status: 'qualified' }, { persist: true, key: emailKey });
        $('.ok-qualified', ok).hidden = false;
        openBooking(o);
      } else {
        track('Disqualified', { content_category: FUNNEL }, { persist: true, key: emailKey });
        $('.ok-other', ok).hidden = false;
      }
      ok.focus();
    }
  }

  /* ------------------------------------------------------------------ Calendly booking (qualified applicants only) */
  function openBooking(o) {
    var sec = $('#book'); if (!sec) return;
    sec.hidden = false;
    var box = $('.cal-embed', sec);
    if (F.calendlyUrl) {
      var u = new URL(F.calendlyUrl);
      if (o.full_name) u.searchParams.set('name', o.full_name);
      if (o.email || o.work_email) u.searchParams.set('email', o.email || o.work_email);
      var a = o.attribution || {};
      ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'].forEach(function (k) { if (a[k]) u.searchParams.set(k, a[k]); });
      u.searchParams.set('hide_gdpr_banner', '1');
      box.innerHTML = '<div class="calendly-inline-widget" data-url="' + esc(u.toString()) + '" style="min-width:300px;height:720px"></div>';
      var s = d.createElement('script'); s.src = 'https://assets.calendly.com/assets/external/widget.js'; s.async = true; d.body.appendChild(s);
      box.classList.add('live');
    }
    setTimeout(function () { sec.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' }); }, 400);
  }
  // Calendly posts messages to the parent window: https://help.calendly.com/hc/en-us/articles/223147027
  w.addEventListener('message', function (e) {
    if (!/^https:\/\/([a-z0-9-]+\.)?calendly\.com$/.test(e.origin) || !e.data || typeof e.data.event !== 'string') return;
    if (e.data.event === 'calendly.event_type_viewed') track('BookingView', { content_category: FUNNEL });
    if (e.data.event === 'calendly.event_scheduled') track('Schedule', { content_category: FUNNEL }, { persist: true });
  });

  /* ------------------------------------------------------------------ FAQ: one open at a time */
  $$('.faq details').forEach(function (dt) { dt.addEventListener('toggle', function () { if (dt.open) $$('.faq details').forEach(function (o) { if (o !== dt) o.open = false; }); }); });

  /* ------------------------------------------------------------------ year */
  $$('[data-year]').forEach(function (el) { el.textContent = new Date().getFullYear(); });
})(window, document);
