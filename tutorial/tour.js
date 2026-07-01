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
  // A step target may be a single selector or an array (highlight several
  // elements at once, e.g. the temperature chart + the phenology chart).
  function resolveTargets(target) {
    if (!target) return [];
    var sels = Array.isArray(target) ? target : [target];
    var els = [];
    for (var i = 0; i < sels.length; i++) { var e = $(sels[i]); if (e) els.push(e); }
    return els;
  }
  // Wait for the primary (first) selector, then return every present target.
  function waitForTargets(target, timeout) {
    if (!target) return Promise.resolve([]);
    var sels = Array.isArray(target) ? target : [target];
    return waitForTarget(sels[0], timeout).then(function () { return resolveTargets(target); });
  }
  // Union bounding rect (viewport coords) of the elements, ignoring zero-size
  // (collapsed/hidden) ones. Returns null if nothing is visible.
  function unionRect(els) {
    var top = Infinity, left = Infinity, right = -Infinity, bottom = -Infinity, any = false;
    for (var i = 0; i < els.length; i++) {
      var r = els[i].getBoundingClientRect();
      if (!r.width && !r.height) continue;
      any = true;
      top = Math.min(top, r.top); left = Math.min(left, r.left);
      right = Math.max(right, r.right); bottom = Math.max(bottom, r.bottom);
    }
    return any ? { top: top, left: left, right: right, bottom: bottom, width: right - left, height: bottom - top } : null;
  }
  // Return the map to a clean state (clear species filter, close panel) so the
  // first step can point at the search bar with nothing else open.
  function toCleanMap() {
    try { if ($('#search-clear')) $('#search-clear').click(); } catch (e) {}
    try { if (typeof closePanel === 'function') closePanel(); } catch (e) {}
    return delay(150);
  }
  // Click an element on the page if present (used to open panels the next step
  // will point at, e.g. the species photo gallery).
  function clickTarget(sel) {
    var el = $(sel); if (el) el.click();
    return delay(150);
  }
  // "What can I grow?" demo location — Los Angeles. Keep the place name here in
  // sync with grow.results copy.
  function matchDemoLocation() {
    if (typeof runMatchForLocation === 'function') return runMatchForLocation(34.0522, -118.2437, 'Los Angeles');
  }
  // Open the Köppen colour-key panel (map control) so a step can highlight it.
  function openKoppenLegend() {
    var panel = $('.koppen-legend-panel');
    if (panel && panel.classList.contains('open')) return delay(0);
    var btn = $('.koppen-legend-wrap .map-btn'); if (btn) btn.click();
    return delay(150);
  }
  // Close the Köppen colour-key panel (map control).
  function closeKoppenLegend() {
    var panel = $('.koppen-legend-panel'); if (panel) panel.classList.remove('open');
    var btn = $('.koppen-legend-wrap .map-btn'); if (btn) btn.classList.remove('active');
    return delay(80);
  }
  // Open a species, expand its All-Observations section, and scroll the panel so
  // the list is framed at the top. scrollIntoView under-scrolls here, so set the
  // scroll offset directly (by the measured delta), twice, to survive reflow.
  function scrollSectionToTop(secId) {
    var sec = document.getElementById(secId), sc = document.getElementById('panel-scroll');
    if (sec && sc) { sc.scrollTop += sec.getBoundingClientRect().top - sc.getBoundingClientRect().top - 10; }
  }
  function openObsList(name) {
    return openSpeciesByName(name).then(function () {
      var sec = document.getElementById('sp-obs-section');
      if (sec && !sec.open) sec.open = true;   // fires the toggle handler → lazy renders
      return waitForTarget('#sp-obs-list', 3000);
    }).then(function () { return delay(150); })
      .then(function () { scrollSectionToTop('sp-obs-section'); return delay(200); })
      .then(function () { scrollSectionToTop('sp-obs-section'); return delay(60); });
  }
  // "What can I grow?" hemisphere-shift demo — a southern-hemisphere species
  // (Cephalotus, SW Australia) scored against Los Angeles shows the seasonal
  // shift, so the scores + shift-toggle steps have something to point at.
  function openCompareForShiftDemo() {
    if (typeof runReverseMatch !== 'function' || typeof inatSpeciesData === 'undefined') return;
    var tid = taxonIdByName('Cephalotus follicularis');
    var entry = tid != null ? inatSpeciesData[tid] : null;
    if (!entry) return;
    return runReverseMatch(entry, 34.0522, -118.2437, 'Los Angeles');
  }

  // ── the path definitions (text comes from tour-content) ────────────────
  var PATHS = {
    needs: {
      titleKey: 'needs',
      steps: [
        { id: 'entry',    before: function () { return toCleanMap(); }, target: '#search-container' },
        { id: 'intro',    before: function () { return openSpeciesByName('Drosera rotundifolia'); }, target: '.sp-header' },
        { id: 'stats',    target: '.sp-stats-grid' },
        // chart + phenology (both mentioned in the copy) highlighted together.
        { id: 'chart',    target: ['#sp-chart-container', '#sp-pheno-section'] },
        // climate zones + soils highlighted together (soil section expanded first).
        { id: 'zones',    before: function () { expandSection('Soil'); }, target: ['#sp-koppen-body', '#soil-section-body'] },
        { id: 'obscured', before: function () { return openSpeciesByName('Nepenthes edwardsiana'); }, target: '.sp-refine-note' },
      ],
    },

    browse: {
      titleKey: 'browse',
      steps: [
        { id: 'entry',   before: function () { return toCleanMap(); }, target: '#search-container' },
        { id: 'species', before: function () { return openSpeciesByName('Dionaea muscipula'); }, target: ['.sp-header', '.sp-quick-actions'] },
        // Interactive: let the user scroll the gallery and click a photo (which
        // opens the full-screen lightbox — the tour hides itself while it's up).
        { id: 'gallery', before: function () { return clickTarget('#sp-gallery-top'); }, target: '#side-panel', interactive: true },
        // Reopen the species, expand the All Observations list, scroll it into frame.
        { id: 'obs',     before: function () { return openObsList('Dionaea muscipula'); }, target: '#side-panel', interactive: true },
      ],
    },

    grow: {
      titleKey: 'grow',
      steps: [
        { id: 'entry',   before: function () { return toCleanMap(); }, target: '#search-container' },
        // Fetches the location's climate from the network, so allow extra time.
        { id: 'results', before: function () { return matchDemoLocation(); }, target: '.match-panel-header', timeout: 9000 },
        { id: 'card',    target: '.match-card' },
        { id: 'filter',  target: '.match-filter-row' },
        // Drill into a species' full score breakdown (uses a southern-hemisphere
        // species so the seasonal-shift row/toggle is present).
        { id: 'scores',  before: function () { return openCompareForShiftDemo(); }, target: '.cmp-sub-list', timeout: 9000 },
        { id: 'shift',   target: ['.cmp-shift-note', '.cmp-shift-toggle'] },
      ],
    },

    explore: {
      titleKey: 'explore',
      steps: [
        { id: 'search', before: function () { return toCleanMap(); }, target: '#search-container' },
        { id: 'layers', target: '.leaflet-top.leaflet-right' },
        { id: 'zones',  before: function () { return openKoppenLegend(); }, target: '.koppen-legend-panel' },
        // Minimize the key before the final (map-wide) step.
        { id: 'click',  before: function () { return closeKoppenLegend(); }, target: null },
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
      '.bmg-tour-pcard .t{display:block;font-weight:600;font-size:14px}',
      '.bmg-tour-pcard .s{display:block;font-size:12px;color:var(--text-muted,#8b949e);margin-top:5px;line-height:1.4}',
      '.bmg-tour-pcard .soon{display:block;font-size:10px;color:var(--accent,#3fb950);margin-top:6px;opacity:0;transition:opacity .2s}',
      '.bmg-tour-pcard.show-soon .soon{opacity:1}',
      '.bmg-tour-picknote{margin:14px 0 0;color:var(--text-muted,#8b949e);font-size:12px;text-align:center}',
      '.bmg-tour-skip{display:block;width:100%;text-align:center;margin-top:12px;background:none;border:none;color:var(--text-muted,#8b949e);font:13px system-ui,sans-serif;cursor:pointer}',
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
    watchLightbox(false);
    ['bmg-tour-block', 'bmg-tour-dim', 'bmg-tour-spot', 'bmg-tour-card', 'bmg-tour-pick'].forEach(function (id) {
      var el = document.getElementById(id); if (el) el.remove();
    });
    window.removeEventListener('resize', onResize);
    document.removeEventListener('keydown', onKey, true);
  }

  // ── interactive steps ───────────────────────────────────────────────────
  // Some steps invite the user to actually use the feature (scroll the gallery,
  // click a photo). For those we let clicks pass through the full-screen block,
  // and — because the photo lightbox sits *below* the tour's z-index — hide the
  // tour while the lightbox is open so it isn't occluded.
  var lightboxObs = null;
  function setOverlayHidden(hidden) {
    ['bmg-tour-block', 'bmg-tour-dim', 'bmg-tour-spot', 'bmg-tour-card'].forEach(function (id) {
      var el = document.getElementById(id); if (el) el.style.visibility = hidden ? 'hidden' : '';
    });
  }
  function watchLightbox(on) {
    if (lightboxObs) { lightboxObs.disconnect(); lightboxObs = null; }
    if (!on) { setOverlayHidden(false); return; }
    var lb = document.getElementById('gallery-lightbox');
    if (!lb) return;
    lightboxObs = new MutationObserver(function () { setOverlayHidden(lb.classList.contains('open')); });
    lightboxObs.observe(lb, { attributes: true, attributeFilter: ['class'] });
  }
  function applyInteractive(interactive) {
    var block = $('#bmg-tour-block');
    if (block) block.style.pointerEvents = interactive ? 'none' : 'auto';
    watchLightbox(interactive);
  }

  function positionSpot(els) {
    var spot = $('#bmg-tour-spot'), dim = $('#bmg-tour-dim');
    var r = (els && els.length) ? unionRect(els) : null;
    if (!r) { spot.style.display = 'none'; dim.style.display = 'block'; return; }  // no target → plain dim
    dim.style.display = 'none';
    var pad = 6;
    spot.style.display = 'block';
    spot.style.top = (r.top - pad) + 'px';
    spot.style.left = (r.left - pad) + 'px';
    spot.style.width = (r.width + pad * 2) + 'px';
    spot.style.height = (r.height + pad * 2) + 'px';
  }
  function positionCard(els) {
    var card = $('#bmg-tour-card');
    if (isMobile()) { card.classList.add('bmg-tour-card--bottom'); return; }
    card.classList.remove('bmg-tour-card--bottom');
    var cw = card.offsetWidth, ch = card.offsetHeight, m = 14;
    var r = (els && els.length) ? unionRect(els) : null;
    if (!r) {  // centered
      card.style.left = Math.round((window.innerWidth - cw) / 2) + 'px';
      card.style.top = Math.round((window.innerHeight - ch) / 2) + 'px';
      return;
    }
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
    var els = resolveTargets(state.steps[state.i].target);
    positionSpot(els); positionCard(els);
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
        else if (a === 'next') { if (last) finishToPicker(); else go(state.i + 1); }
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
      .then(function () { return waitForTargets(step.target, step.timeout || 2500); })
      .then(function (els) {
        var first = els && els[0];
        if (first && first.scrollIntoView) { first.scrollIntoView({ block: 'center' }); return delay(160); }
      })
      .then(function () {
        // Position synchronously — reading getBoundingClientRect after renderCard()
        // forces layout, so we don't need (throttled) requestAnimationFrame.
        renderCard();
        applyInteractive(!!step.interactive);
        var place = function () { if (!state || state.i !== i) return; positionSpot(resolveTargets(step.target)); positionCard(resolveTargets(step.target)); };
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

  // Finishing a path drops you back on the 4-goal picker (instead of a dead-end
  // "the end" step) so it's easy to try another walkthrough.
  function finishToPicker() {
    state = null;
    removeOverlay();
    openPicker();
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
        (p.note ? '<p class="bmg-tour-picknote">' + esc(p.note) + '</p>' : '') +
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
