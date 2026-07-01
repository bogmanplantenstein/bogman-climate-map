/* ─────────────────────────────────────────────────────────────────────────
   Bogman Climate Map — guided tour ENGINE.

   Self-contained. Drives the LIVE map only through its public functions
   (openSpeciesSidebar, closePanel, …) and reads the DOM — it never mutates map
   state, so a bug here cannot damage the map. All visible text lives in
   tour-content.js. Exposes window.BMG_TOUR with .openPicker() / .start(key).

   Phase 1: the engine + the "What do these plants need?" path + the picker
   (only that one card is wired; the others show a "coming soon" note).
   ───────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var C = window.BMG_TOUR_CONTENT;
  if (!C) { console.warn('[tour] tour-content.js not loaded'); return; }

  // ── small helpers ──────────────────────────────────────────────────────
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var delay = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var isMobile = function () { return window.matchMedia('(max-width: 768px)').matches; };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); };

  var ICONS = {
    camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8a2 2 0 0 1 2-2h2l1.5-2h7L19 6h0a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="12" cy="12.5" r="3.2"/></svg>',
    leaf:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19.2 2.96a1 1 0 0 1 1.8.5c0 9.94-3.34 16.04-11 16.5z"/><path d="M2 21c0-3 1.85-5.36 5.08-6"/></svg>',
    info:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 16.5v-5M12 8h.01"/></svg>',
    map:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z"/><path d="M9 4v14M15 6v14"/></svg>',
  };

  // Find a species' taxon id (string key) by scientific name. inatSpeciesData is a
  // `let` global on the map (not a window property), so reference it by bare name.
  function taxonIdByName(name) {
    var data = (typeof inatSpeciesData !== 'undefined' && inatSpeciesData) ? inatSpeciesData : {};
    for (var k in data) { if (data[k] && data[k].scientific_name === name) return +k; }
    return null;
  }
  // Open a species page (ensures species data is loaded first).
  function openSpeciesByName(name) {
    return Promise.resolve()
      .then(function () { return (typeof loadSpeciesData === 'function') ? loadSpeciesData() : null; })
      .then(function () {
        var tid = taxonIdByName(name);
        if (tid != null && typeof openSpeciesSidebar === 'function') return openSpeciesSidebar(tid, name);
      })
      .catch(function () {});
  }
  // Expand a collapsible species-page section whose summary contains `text`.
  function expandSection(text) {
    var secs = document.querySelectorAll('#panel-content .inat-section');
    for (var i = 0; i < secs.length; i++) {
      var sum = secs[i].querySelector('summary');
      if (sum && sum.textContent.toLowerCase().indexOf(text.toLowerCase()) !== -1) { secs[i].open = true; return; }
    }
  }
  // Poll for a selector to appear (after an async action re-renders the panel).
  function waitForTarget(sel, timeout) {
    if (!sel) return Promise.resolve(null);
    var t0 = Date.now();
    return new Promise(function (resolve) {
      (function poll() {
        var el = $(sel);
        if (el) return resolve(el);
        if (Date.now() - t0 > (timeout || 1500)) return resolve(null);
        requestAnimationFrame(poll);
      })();
    });
  }

  // ── the path definitions (text comes from tour-content) ────────────────
  var PATHS = {
    needs: {
      titleKey: 'needs',
      steps: [
        { id: 'intro',    before: function () { return openSpeciesByName('Drosera rotundifolia'); }, target: '.sp-header' },
        { id: 'stats',    target: '.sp-stats-grid' },
        { id: 'chart',    target: '#sp-chart-container' },
        { id: 'zones',    before: function () { expandSection('Soil'); }, target: '#sp-koppen-body' },
        { id: 'obscured', before: function () { return openSpeciesByName('Nepenthes edwardsiana'); }, target: '.sp-refine-note' },
        { id: 'end',      target: null },
      ],
    },
  };

  // ── styles (prefixed; injected once) ────────────────────────────────────
  function injectCss() {
    if ($('#bmg-tour-style')) return;
    var s = document.createElement('style');
    s.id = 'bmg-tour-style';
    s.textContent = [
      '.bmg-tour-block{position:fixed;inset:0;z-index:100000;pointer-events:auto;background:transparent}',
      '.bmg-tour-spot{position:fixed;border-radius:10px;pointer-events:none;z-index:100000;box-shadow:0 0 0 2px var(--accent,#3fb950),0 0 0 9999px rgba(0,0,0,.55);transition:top .25s ease,left .25s ease,width .25s ease,height .25s ease,opacity .2s}',
      '.bmg-tour-dim{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.55);pointer-events:none}',
      '.bmg-tour-card{position:fixed;z-index:100001;width:330px;max-width:calc(100vw - 24px);background:var(--bg-panel,#161b22);border:1px solid var(--border,#30363d);border-radius:12px;padding:14px 16px;color:var(--text-primary,#e6edf3);box-shadow:0 10px 34px rgba(0,0,0,.55);pointer-events:auto;font:14px/1.55 system-ui,-apple-system,sans-serif}',
      '.bmg-tour-card--bottom{left:0!important;right:0;bottom:0;top:auto!important;width:auto;max-width:none;border-radius:14px 14px 0 0;padding-bottom:calc(14px + env(safe-area-inset-bottom,0px))}',
      '.bmg-tour-prog{font-size:11px;color:var(--text-muted,#8b949e);margin-bottom:6px}',
      '.bmg-tour-body{font-size:14px;line-height:1.55}',
      '.bmg-tour-body b{color:var(--accent,#3fb950);font-weight:600}',
      '.bmg-tour-foot{display:flex;align-items:center;justify-content:space-between;margin-top:13px;gap:10px}',
      '.bmg-tour-dots{display:flex;gap:5px;align-items:center}',
      '.bmg-tour-dot{width:6px;height:6px;border-radius:50%;background:var(--border,#30363d)}',
      '.bmg-tour-dot.on{background:var(--accent,#3fb950);width:7px;height:7px}',
      '.bmg-tour-btns{display:flex;gap:8px;align-items:center}',
      '.bmg-tour-btn{font:13px system-ui,sans-serif;border-radius:6px;padding:5px 12px;cursor:pointer;border:1px solid var(--border,#30363d);background:transparent;color:var(--text-muted,#8b949e)}',
      '.bmg-tour-btn.ghost{border:none;padding:5px 6px}',
      '.bmg-tour-btn.go{border-color:var(--accent,#3fb950);color:var(--accent,#3fb950);font-weight:600}',
      '.bmg-tour-btn:hover{color:var(--text-primary,#e6edf3)}',
      '.bmg-tour-btn.go:hover{background:rgba(63,185,80,.12)}',
      // picker
      '.bmg-tour-pick{position:fixed;inset:0;z-index:100002;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6);pointer-events:auto;padding:20px}',
      '.bmg-tour-pickbox{width:480px;max-width:100%;background:var(--bg-panel,#161b22);border:1px solid var(--border,#30363d);border-radius:14px;padding:22px;color:var(--text-primary,#e6edf3);font:14px/1.5 system-ui,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.6)}',
      '.bmg-tour-pickbox h2{margin:0 0 4px;font-size:18px;font-weight:600}',
      '.bmg-tour-picksub{color:var(--text-muted,#8b949e);font-size:13px;margin:0 0 16px}',
      '.bmg-tour-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}',
      '.bmg-tour-pcard{text-align:left;background:var(--bg-elevated,#1f2937);border:1px solid var(--border,#30363d);border-radius:12px;padding:14px;cursor:pointer;color:inherit;font:inherit}',
      '.bmg-tour-pcard:hover{border-color:var(--accent,#3fb950)}',
      '.bmg-tour-pcard[disabled]{opacity:.55;cursor:default}',
      '.bmg-tour-pcard .ic{color:var(--accent,#3fb950);width:26px;height:26px;display:block;margin-bottom:8px}',
      '.bmg-tour-pcard .ic svg{width:26px;height:26px}',
      '.bmg-tour-pcard .t{font-weight:600;font-size:14px}',
      '.bmg-tour-pcard .s{font-size:12px;color:var(--text-muted,#8b949e);margin-top:3px;line-height:1.4}',
      '.bmg-tour-pcard .soon{font-size:10px;color:var(--accent,#3fb950);margin-top:6px;opacity:0;transition:opacity .2s}',
      '.bmg-tour-pcard.show-soon .soon{opacity:1}',
      '.bmg-tour-skip{display:block;width:100%;text-align:center;margin-top:16px;background:none;border:none;color:var(--text-muted,#8b949e);font:13px system-ui,sans-serif;cursor:pointer}',
    ].join('');
    document.head.appendChild(s);
  }

  // ── tour state + overlay ────────────────────────────────────────────────
  var state = null;   // { pathKey, steps, i, els:{} }

  function buildOverlay() {
    var block = document.createElement('div'); block.className = 'bmg-tour-block'; block.id = 'bmg-tour-block';
    var dim   = document.createElement('div'); dim.className = 'bmg-tour-dim'; dim.id = 'bmg-tour-dim'; dim.style.display = 'none';
    var spot  = document.createElement('div'); spot.className = 'bmg-tour-spot'; spot.id = 'bmg-tour-spot'; spot.style.display = 'none';
    var card  = document.createElement('div'); card.className = 'bmg-tour-card'; card.id = 'bmg-tour-card';
    document.body.appendChild(block); document.body.appendChild(dim); document.body.appendChild(spot); document.body.appendChild(card);
    return { block: block, dim: dim, spot: spot, card: card };
  }
  function removeOverlay() {
    ['bmg-tour-block', 'bmg-tour-dim', 'bmg-tour-spot', 'bmg-tour-card', 'bmg-tour-pick'].forEach(function (id) {
      var el = document.getElementById(id); if (el) el.remove();
    });
    window.removeEventListener('resize', onResize);
    document.removeEventListener('keydown', onKey, true);
  }

  function positionSpot(el) {
    var spot = $('#bmg-tour-spot'), dim = $('#bmg-tour-dim');
    if (!el) { spot.style.display = 'none'; dim.style.display = 'block'; return; }  // no target → plain dim
    dim.style.display = 'none';
    var r = el.getBoundingClientRect(), pad = 6;
    spot.style.display = 'block';
    spot.style.top = (r.top - pad) + 'px';
    spot.style.left = (r.left - pad) + 'px';
    spot.style.width = (r.width + pad * 2) + 'px';
    spot.style.height = (r.height + pad * 2) + 'px';
  }
  function positionCard(el) {
    var card = $('#bmg-tour-card');
    if (isMobile()) { card.classList.add('bmg-tour-card--bottom'); return; }
    card.classList.remove('bmg-tour-card--bottom');
    var cw = card.offsetWidth, ch = card.offsetHeight, m = 14;
    if (!el) {  // centered
      card.style.left = Math.round((window.innerWidth - cw) / 2) + 'px';
      card.style.top = Math.round((window.innerHeight - ch) / 2) + 'px';
      return;
    }
    var r = el.getBoundingClientRect();
    // Prefer left of the target (the side panel sits on the right); else below.
    var left = r.left - cw - 16;
    if (left < m) left = r.left;                              // not enough room left → align under
    var top = (left === r.left) ? r.bottom + 12 : r.top;
    if (top + ch > window.innerHeight - m) top = window.innerHeight - ch - m;
    top = Math.max(m, top);
    left = Math.min(Math.max(m, left), window.innerWidth - cw - m);
    card.style.left = left + 'px';
    card.style.top = top + 'px';
  }

  function onResize() { if (state) repositionCurrent(); }
  function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); end(); } }
  function repositionCurrent() {
    var step = state.steps[state.i];
    var el = step.target ? $(step.target) : null;
    positionSpot(el); positionCard(el);
  }

  function renderCard() {
    var path = C.paths[state.pathKey];
    var step = state.steps[state.i];
    var copy = (path.steps && path.steps[step.id]) || '';
    var n = state.steps.length, last = state.i === n - 1, first = state.i === 0;
    var dots = '';
    for (var d = 0; d < n; d++) dots += '<span class="bmg-tour-dot' + (d === state.i ? ' on' : '') + '"></span>';
    var card = $('#bmg-tour-card');
    card.innerHTML =
      '<div class="bmg-tour-prog">Step ' + (state.i + 1) + ' of ' + n + ' &middot; ' + esc(path.title) + '</div>' +
      '<div class="bmg-tour-body">' + copy + '</div>' +
      '<div class="bmg-tour-foot"><div class="bmg-tour-dots">' + dots + '</div>' +
      '<div class="bmg-tour-btns">' +
        (first ? '' : '<button class="bmg-tour-btn" data-act="back">Back</button>') +
        '<button class="bmg-tour-btn ghost" data-act="end">' + (last ? 'Close' : 'Skip') + '</button>' +
        '<button class="bmg-tour-btn go" data-act="next">' + (last ? 'Done' : 'Next &rarr;') + '</button>' +
      '</div></div>';
    card.querySelectorAll('[data-act]').forEach(function (b) {
      b.addEventListener('click', function () {
        var a = b.getAttribute('data-act');
        if (a === 'back') go(state.i - 1);
        else if (a === 'next') { if (last) end(); else go(state.i + 1); }
        else end();
      });
    });
  }

  function go(i) {
    if (!state || i < 0 || i >= state.steps.length) return;
    state.i = i;
    var step = state.steps[i];
    var card = $('#bmg-tour-card');
    card.style.opacity = '0.001';
    Promise.resolve()
      .then(function () { return step.before ? step.before() : null; })
      .then(function () { return waitForTarget(step.target, 2500); })
      .then(function (el) {
        if (el && el.scrollIntoView) { el.scrollIntoView({ block: 'center' }); return delay(160).then(function () { return el; }); }
        return el;
      })
      .then(function () {
        // Position synchronously — reading getBoundingClientRect after renderCard()
        // forces layout, so we don't need (throttled) requestAnimationFrame.
        renderCard();
        var place = function () { if (!state || state.i !== i) return; var t = step.target ? $(step.target) : null; positionSpot(t); positionCard(t); };
        place();
        card.style.opacity = '1';
        // Re-measure a couple of times to catch late layout shifts (the species
        // page renders its chart asynchronously and reflows after we position).
        setTimeout(place, 350);
        setTimeout(place, 950);
      });
  }

  function startPath(key) {
    closePicker();
    var path = C.paths[key], def = PATHS[key];
    if (!path || !def) { return; }
    injectCss();
    removeOverlay();
    buildOverlay();
    window.addEventListener('resize', onResize);
    document.addEventListener('keydown', onKey, true);
    state = { pathKey: key, steps: def.steps, i: -1 };
    go(0);
  }

  function end() {
    state = null;
    removeOverlay();
    // Return to a clean map: clear the species filter the tour applied, close panel.
    try { if ($('#search-clear')) $('#search-clear').click(); } catch (e) {}
    try { if (typeof closePanel === 'function') closePanel(); } catch (e) {}
  }

  // ── picker ──────────────────────────────────────────────────────────────
  function openPicker() {
    injectCss();
    closePicker();
    var p = C.picker;
    var wrap = document.createElement('div'); wrap.className = 'bmg-tour-pick'; wrap.id = 'bmg-tour-pick';
    var cards = p.cards.map(function (c) {
      return '<button class="bmg-tour-pcard" data-key="' + c.key + '" ' + (c.ready ? '' : 'data-soon="1"') + '>' +
        '<span class="ic">' + (ICONS[c.icon] || '') + '</span>' +
        '<span class="t">' + esc(c.label) + '</span>' +
        '<span class="s">' + esc(c.sub) + '</span>' +
        '<span class="soon">' + esc(p.soon) + '</span>' +
      '</button>';
    }).join('');
    wrap.innerHTML =
      '<div class="bmg-tour-pickbox" role="dialog" aria-label="Guided tour">' +
        '<h2>' + esc(p.title) + '</h2>' +
        '<p class="bmg-tour-picksub">' + esc(p.subtitle) + '</p>' +
        '<div class="bmg-tour-grid">' + cards + '</div>' +
        '<button class="bmg-tour-skip" data-skip="1">' + esc(p.skip) + '</button>' +
      '</div>';
    document.body.appendChild(wrap);
    wrap.addEventListener('click', function (e) {
      if (e.target === wrap || e.target.hasAttribute('data-skip')) { closePicker(); return; }
      var card = e.target.closest('.bmg-tour-pcard'); if (!card) return;
      var key = card.getAttribute('data-key');
      if (card.hasAttribute('data-soon')) { card.classList.add('show-soon'); return; }
      startPath(key);
    });
  }
  function closePicker() { var el = document.getElementById('bmg-tour-pick'); if (el) el.remove(); }

  window.BMG_TOUR = { openPicker: openPicker, start: startPath, end: end };
})();
