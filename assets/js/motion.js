/* GTME.School VSL — motion layer (v2 design).
   Pure presentation: scroll progress, counters, the sticky engine, the live-build simulation,
   tabs, carousels and the calculator. Page behaviour (video, form, tracking) stays in vsl.js.
   Everything degrades to a readable static page without JS or with reduced motion. */
(function (w, d) {
  'use strict';
  var root = d.documentElement;
  root.classList.remove('no-js'); root.classList.add('js');
  var reduce = w.matchMedia && w.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var fine = w.matchMedia && w.matchMedia('(pointer: fine)').matches;
  function $(s, c) { return (c || d).querySelector(s); }
  function $$(s, c) { return Array.prototype.slice.call((c || d).querySelectorAll(s)); }
  function onView(els, cb, opts) {
    if (!('IntersectionObserver' in w)) { els.forEach(function (el) { cb(el, true); }); return null; }
    var io = new IntersectionObserver(function (es) { es.forEach(function (e) { cb(e.target, e.isIntersecting, e); }); }, opts || { threshold: .25 });
    els.forEach(function (el) { io.observe(el); });
    return io;
  }
  var raf = w.requestAnimationFrame || function (f) { return setTimeout(f, 16); };

  /* ---------------------------------------------------------- header, progress, nav */
  var top = $('.top'), prog = $('.progress');
  var navLinks = $$('.top nav a[href^="#"]');
  var scrollers = [];
  function onScroll() {
    var y = w.scrollY || w.pageYOffset, h = root.scrollHeight - w.innerHeight;
    if (top) top.classList.toggle('scrolled', y > 10);
    if (prog) prog.style.setProperty('--p', h > 0 ? (y / h).toFixed(4) : 0);
    scrollers.forEach(function (f) { f(y); });
  }
  var ticking = false;
  w.addEventListener('scroll', function () { if (!ticking) { ticking = true; raf(function () { ticking = false; onScroll(); }); } }, { passive: true });
  w.addEventListener('resize', onScroll);
  if (navLinks.length) {
    var secs = navLinks.map(function (a) { return d.getElementById(a.getAttribute('href').slice(1)); });
    onView(secs.filter(Boolean), function (el, inV) {
      if (!inV) return;
      navLinks.forEach(function (a) { a.classList.toggle('on', a.getAttribute('href') === '#' + el.id); });
    }, { rootMargin: '-45% 0px -50% 0px' });
  }

  /* ---------------------------------------------------------- countdown notice */
  $$('[data-deadline]').forEach(function (el) {
    var end = new Date(el.getAttribute('data-deadline'));
    var days = Math.ceil((end - new Date()) / 864e5);
    var bar = el.closest('.notice');
    if (isNaN(days) || days < 0) { if (bar) bar.hidden = true; return; }
    el.textContent = days === 0 ? 'last day' : days + (days === 1 ? ' day left' : ' days left');
  });

  /* ---------------------------------------------------------- hero: glow, tilt, rotator, toasts */
  var hero = $('.hero'), mon = $('.monitor'), hv0 = $('.hero-v');
  if (hero && fine && !reduce) {
    hero.addEventListener('mousemove', function (e) {
      var r = hero.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
      hero.style.setProperty('--mx', (x * 100).toFixed(1) + '%'); hero.style.setProperty('--my', (y * 100).toFixed(1) + '%');
      if (mon && !hv0) { mon.style.setProperty('--ry', ((x - .5) * -10 - 4).toFixed(2) + 'deg'); mon.style.setProperty('--rx', ((y - .5) * 8 + 4).toFixed(2) + 'deg'); }
    });
    hero.addEventListener('mouseleave', function () { if (mon && !hv0) { mon.style.removeProperty('--rx'); mon.style.removeProperty('--ry'); } });
  }
  /* centred hero: the screen starts tilted back and settles flat as you scroll */
  var hv = $('.hero-v .monitor');
  if (hv) {
    if (reduce) hv.style.setProperty('--rx', '0deg');
    else scrollers.push(function (y) { var k = Math.max(0, Math.min(1, y / 360)); hv.style.setProperty('--rx', (12 * (1 - k)).toFixed(2) + 'deg'); });
  }
  var floats = $$('.float-logo');
  if (floats.length && !reduce) scrollers.push(function (y) { floats.forEach(function (f, i) { f.style.setProperty('--py', (y * (i % 2 ? -.08 : .06)).toFixed(1) + 'px'); }); });

  $$('[data-rotate]').forEach(function (r) {
    var items = $$('span', r); if (items.length < 2) return;
    var i = 0; items[0].classList.add('on');
    if (reduce) return;
    setInterval(function () {
      var cur = items[i]; cur.classList.remove('on'); cur.classList.add('out');
      setTimeout(function () { cur.classList.remove('out'); }, 600);
      i = (i + 1) % items.length; items[i].classList.add('on');
    }, 2600);
  });

  $$('[data-toasts]').forEach(function (box) {
    var ts = $$('.toast', box); if (!ts.length) return;
    if (reduce) { ts.forEach(function (t) { t.classList.add('on'); }); return; }
    var k = 0;
    function step() {
      if (k < ts.length) { ts[k].classList.add('on'); k++; setTimeout(step, 1400); }
      else { setTimeout(function () { ts.forEach(function (t) { t.classList.remove('on'); }); k = 0; setTimeout(step, 900); }, 5200); }
    }
    setTimeout(step, 1100);
  });

  /* ---------------------------------------------------------- counters */
  function fmt(n, dec) { return n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec }); }
  onView($$('[data-count]'), function (el, inV) {
    if (!inV || el.__done) return; el.__done = true;
    var to = parseFloat(el.getAttribute('data-count')), from = parseFloat(el.getAttribute('data-from') || 0);
    var dec = parseInt(el.getAttribute('data-dec') || 0, 10), pre = el.getAttribute('data-pre') || '', suf = el.getAttribute('data-suf') || '';
    if (reduce) { el.textContent = pre + fmt(to, dec) + suf; return; }
    var t0 = null, dur = parseFloat(el.getAttribute('data-dur') || 1600);
    function tick(t) { if (!t0) t0 = t; var k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 4);
      el.textContent = pre + fmt(from + (to - from) * e, dec) + suf; if (k < 1) raf(tick); }
    raf(tick);
  }, { threshold: .6 });

  /* things that animate in once (.chart, .kpi, etc.) */
  onView($$('[data-in]'), function (el, inV) { if (inV) el.classList.add('in'); }, { threshold: .3 });

  /* ---------------------------------------------------------- before / after switch */
  $$('[data-switch]').forEach(function (sw) {
    var target = d.getElementById(sw.getAttribute('data-switch')); if (!target) return;
    var btns = $$('button', sw), knob = $('.knob', sw);
    function place(btn) { if (!knob) return; knob.style.setProperty('--kw', btn.offsetWidth + 'px'); knob.style.setProperty('--kx', (btn.offsetLeft - 5) + 'px'); }
    function set(eng, user) {
      target.classList.toggle('eng', eng); sw.classList.toggle('eng', eng);
      btns.forEach(function (b) { b.setAttribute('aria-pressed', String((b.getAttribute('data-v') === 'eng') === eng)); if (b.getAttribute('aria-pressed') === 'true') place(b); });
      $$('.old', target).forEach(function (f) { f.setAttribute('aria-hidden', String(eng)); });
      $$('.new', target).forEach(function (f) { f.setAttribute('aria-hidden', String(!eng)); });
      if (user) sw.__user = true;
    }
    btns.forEach(function (b) { b.addEventListener('click', function () { set(b.getAttribute('data-v') === 'eng', true); }); });
    set(false); w.addEventListener('resize', function () { var on = $('button[aria-pressed=true]', sw); if (on) place(on); });
    onView([target], function (el, inV) { if (inV && !sw.__user && !sw.__auto) { sw.__auto = true; setTimeout(function () { if (!sw.__user) set(true); }, 1600); } }, { threshold: .45 });
  });

  /* ---------------------------------------------------------- sticky engine */
  $$('[data-engine]').forEach(function (eng) {
    var steps = $$('.stp', eng), nodes = $$('.node', eng), vis = $('.engine-vis', eng);
    var rd = $('.ev-read b', eng), rs = $('.ev-read span', eng), rl = $('.ev-read .lbl', eng);
    function activate(i) {
      steps.forEach(function (s, j) { s.classList.toggle('on', j === i); });
      nodes.forEach(function (n, j) { n.classList.toggle('on', j === i); n.classList.toggle('done', j < i); });
      if (vis) vis.style.setProperty('--step', i + 1);
      var s = steps[i];
      if (s && rd) { rd.textContent = s.getAttribute('data-read') || ''; rs.textContent = s.getAttribute('data-sub') || ''; if (rl) rl.textContent = 'M' + (i + 1) + ' · the one number'; }
    }
    activate(0);
    onView(steps, function (el, inV) { if (inV) activate(steps.indexOf(el)); }, { rootMargin: '-40% 0px -45% 0px' });
    nodes.forEach(function (n, j) { n.style.cursor = 'pointer'; n.addEventListener('click', function () { steps[j] && steps[j].scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' }); }); });
  });

  /* ---------------------------------------------------------- live build simulation */
  $$('[data-sim]').forEach(function (sim) {
    var rows = $$('tbody tr', sim), type = $('[data-type]', sim), seq = $$('.seq li', sim), reply = $('.reply', sim);
    var text = type ? type.getAttribute('data-type') : '', out = type ? $('.out', type) : null;
    var timers = [], running = false;
    function clear() { timers.forEach(clearTimeout); timers = []; }
    function at(ms, f) { timers.push(setTimeout(f, ms)); }
    function reset() { rows.forEach(function (r) { r.classList.remove('on'); }); seq.forEach(function (s) { s.classList.remove('on', 'done'); }); if (reply) reply.classList.remove('on'); if (out) out.textContent = ''; }
    function finalState() { rows.forEach(function (r) { r.classList.add('on'); }); seq.forEach(function (s) { s.classList.add('done'); }); if (reply) reply.classList.add('on'); if (out) out.textContent = text; }
    function run() {
      clear(); reset(); var t = 300;
      rows.forEach(function (r) { at(t, function () { r.classList.add('on'); }); t += 450; });
      t += 200;
      for (var i = 1; i <= text.length; i++) (function (i) { at(t + i * 22, function () { if (out) out.textContent = text.slice(0, i); }); })(i);
      t += text.length * 22 + 500;
      seq.forEach(function (s, j) { at(t, function () { if (j > 0) seq[j - 1].classList.replace('on', 'done'); s.classList.add('on'); }); t += 900; });
      at(t, function () { seq[seq.length - 1] && seq[seq.length - 1].classList.replace('on', 'done'); if (reply) reply.classList.add('on'); });
      at(t + 4200, function () { if (running) run(); });
    }
    if (reduce) { finalState(); return; }
    onView([sim], function (el, inV) { if (inV && !running) { running = true; run(); } else if (!inV && running) { running = false; clear(); finalState(); } }, { threshold: .3 });
  });

  /* ---------------------------------------------------------- card spotlight */
  if (fine && !reduce) $$('.card, .track').forEach(function (c) {
    c.addEventListener('mousemove', function (e) { var r = c.getBoundingClientRect(); c.style.setProperty('--cx', (e.clientX - r.left) + 'px'); c.style.setProperty('--cy', (e.clientY - r.top) + 'px'); });
  });

  /* ---------------------------------------------------------- journey progress */
  $$('[data-journey]').forEach(function (j) {
    var items = $$('.jt', j);
    function upd() {
      var r = j.getBoundingClientRect(), vh = w.innerHeight;
      var p = Math.max(0, Math.min(1, (vh * .75 - r.top) / (r.height + vh * .25)));
      if (w.innerWidth >= 960) p = Math.max(0, Math.min(1, (vh * .8 - r.top) / (vh * .55)));
      j.style.setProperty('--jp', p.toFixed(3));
      items.forEach(function (it, i) { it.classList.toggle('on', p >= (i / Math.max(1, items.length - 1)) - .001 || reduce); });
    }
    scrollers.push(upd); upd();
  });

  /* ---------------------------------------------------------- results rail */
  $$('[data-rail]').forEach(function (rail) {
    var nav = d.querySelector('[data-rail-nav="' + rail.id + '"]');
    var down = false, sx = 0, sl = 0, moved = false;
    rail.addEventListener('pointerdown', function (e) { if (e.pointerType !== 'mouse') return; down = true; moved = false; sx = e.clientX; sl = rail.scrollLeft; rail.classList.add('drag'); });
    w.addEventListener('pointermove', function (e) { if (!down) return; var dx = e.clientX - sx; if (Math.abs(dx) > 4) moved = true; rail.scrollLeft = sl - dx; });
    w.addEventListener('pointerup', function () { if (!down) return; down = false; rail.classList.remove('drag'); });
    rail.addEventListener('click', function (e) { if (moved) { e.preventDefault(); e.stopPropagation(); moved = false; } }, true);
    if (nav) $$('button', nav).forEach(function (b) { b.addEventListener('click', function () { var card = $('.shot', rail); var step = card ? card.offsetWidth + 16 : 400; rail.scrollBy({ left: b.getAttribute('data-dir') === 'prev' ? -step : step, behavior: reduce ? 'auto' : 'smooth' }); }); });
  });

  /* ---------------------------------------------------------- quote rotator */
  $$('[data-quotes]').forEach(function (box) {
    var qs = $$('blockquote', box), dots = $$('.qdots button', box.parentNode), i = 0, timer;
    function show(n) { i = n; qs.forEach(function (q, j) { q.classList.toggle('on', j === n); q.setAttribute('aria-hidden', String(j !== n)); });
      dots.forEach(function (b, j) { b.classList.remove('on'); void b.offsetWidth; b.classList.toggle('on', j === n); b.setAttribute('aria-current', String(j === n)); }); }
    function loop() { clearTimeout(timer); if (reduce) return; timer = setTimeout(function () { show((i + 1) % qs.length); loop(); }, 6000); }
    dots.forEach(function (b, j) { b.addEventListener('click', function () { show(j); loop(); }); });
    show(0); onView([box], function (el, inV) { if (inV) loop(); else clearTimeout(timer); }, { threshold: .3 });
  });

  /* ---------------------------------------------------------- tabs */
  $$('[role=tablist]').forEach(function (list) {
    var tabs = $$('[role=tab]', list);
    function sel(t, focus) {
      tabs.forEach(function (o) { var on = o === t; o.setAttribute('aria-selected', String(on)); o.tabIndex = on ? 0 : -1; var p = d.getElementById(o.getAttribute('aria-controls')); if (p) p.hidden = !on; });
      if (focus) t.focus();
    }
    tabs.forEach(function (t, i) {
      t.addEventListener('click', function () { sel(t); });
      t.addEventListener('keydown', function (e) { var k = e.key, n = null; if (k === 'ArrowRight') n = tabs[(i + 1) % tabs.length]; if (k === 'ArrowLeft') n = tabs[(i - 1 + tabs.length) % tabs.length]; if (n) { e.preventDefault(); sel(n, true); } });
    });
    sel(tabs.filter(function (t) { return t.getAttribute('aria-selected') === 'true'; })[0] || tabs[0]);
  });

  /* ---------------------------------------------------------- portrait parallax */
  var por = $('.portrait img');
  if (por && !reduce) scrollers.push(function () { var r = por.parentNode.getBoundingClientRect(); var k = Math.max(-1, Math.min(1, (r.top + r.height / 2 - w.innerHeight / 2) / w.innerHeight)); por.style.setProperty('--py', (k * -24).toFixed(1) + 'px'); });

  /* ---------------------------------------------------------- calculator (corporate) */
  $$('[data-calc]').forEach(function (c) {
    var ins = $$('input[type=range]', c);
    function v(n) { var el = $('[name=' + n + ']', c); return el ? parseFloat(el.value) : 0; }
    function upd() {
      ins.forEach(function (i) { var o = $('output[for=' + i.id + ']', c); if (o) o.textContent = i.value; });
      var weekly = v('reps') * v('accounts') * v('minutes') / 60, yearly = weekly * 46, fte = yearly / 1840;
      var a = $('[data-o=weekly]', c), b = $('[data-o=yearly]', c), f = $('[data-o=fte]', c);
      if (a) a.textContent = Math.round(weekly).toLocaleString('en-US');
      if (b) b.textContent = Math.round(yearly).toLocaleString('en-US');
      if (f) f.textContent = fte.toFixed(1);
    }
    ins.forEach(function (i) { i.addEventListener('input', upd); }); upd();
  });

  /* ---------------------------------------------------------- stagger helper: data-stagger on a parent */
  $$('[data-stagger]').forEach(function (p) { $$('.rv', p).forEach(function (c, i) { c.style.setProperty('--d', (i * 0.07).toFixed(2) + 's'); }); });

  onScroll();
})(window, document);
