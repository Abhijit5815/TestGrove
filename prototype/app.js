/**
 * TestGrove — App controller
 *
 * Owns the state and the ONE refresh path. Everything on screen — the tree,
 * the status card, the list, the stats and the detail panel — reads the same
 * state, so they can never disagree.
 *
 *   state.tree     the whole suite (statuses propagated)
 *   state.scopeId  what you are looking at: the suite, a folder or a file.
 *                  Flying in / out changes only this — every folder is a tree
 *                  of its own (its files become the major branches).
 *   state.view     'tree' | 'list' | 'stats'
 *
 * Public hook (demos, screenshots, the VS Code extension):
 *   TestGroveApp.load(tree, opts)   → { ok, drawn }  (the legend guard)
 *   TestGroveApp.flyTo(id) / .back() / .setView(v)
 */
(function () {
  const TG = window.TestGrove;
  const Leaf = window.TestGroveLeaf;
  const $ = (s) => document.querySelector(s);
  const STATUSES = ['passing', 'failing', 'flaky', 'skipped'];
  const ORDER = ['failing', 'flaky', 'passing', 'skipped'];      // part-to-whole bars: problems first
  const MOOD = {
    peaceful: { label: 'Peaceful', dot: '#3BD69B' }, unsettled: { label: 'Unsettled', dot: '#E0A23C' },
    stormy: { label: 'Stormy', dot: '#86A9CF' }, eerie: { label: 'Eerie', dot: '#E23A55' },
  };
  const SHAPE = {   // the non-colour cue for each result, spelled out
    passing: 'smooth, full leaf', failing: 'withered, jagged leaf', flaky: 'half-lit leaf',
    skipped: 'hollow outline', pending: 'closed bud',
  };

  const state = {
    tree: null, scopeId: null, scope: null, stats: null, mood: 'peaceful', layout: null,
    selectedId: null, view: 'tree', focusStatus: null, legendCheck: null, running: false,
  };

  Leaf.installLeafDefs(document);
  const renderer = new window.TreeImageRenderer($('#svg-host'));
  // UI that sits over the painting — no leaf may ever hide under it
  const OVERLAYS = '#scene .status-card, #scene .toolbar, #scene .nav, #scene .hint';

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmtMs = (ms) => ms == null ? '—' : ms >= 60000 ? `${(ms / 60000).toFixed(1)}m` : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
  const icon = (s, z) => Leaf.legendIcon(s, z || 14);
  const stripScope = (id) => (id && id.endsWith('~scope') ? id.slice(0, -6) : id);

  // ── Tree index ───────────────────────────────────────────────────
  let parentOf = new Map();
  function indexTree() {
    parentOf = new Map();
    (function visit(n) { for (const c of n.children || []) { parentOf.set(c.id, n.id); visit(c); } })(state.tree);
  }
  const node = (id) => (id ? TG.findById(state.tree, stripScope(id)) : null);
  function lineage(id) { const out = []; let k = id; while (k) { out.unshift(k); k = parentOf.get(k); } return out; }
  function countTests(n) { let c = 0; for (const x of TG.walk(n)) if (x.kind === 'test') c++; return c; }

  /** What the renderer draws for a scope. A spec file becomes the single limb of its own tree. */
  function asRoot(n) {
    if (n.kind === 'root' || n.kind === 'folder') return n;
    return { id: `${n.id}~scope`, kind: 'root', name: n.name, path: n.path, status: n.status, metadata: {}, children: [n] };
  }

  // ── The one refresh path ─────────────────────────────────────────
  function refresh(opts) {
    opts = opts || {};
    state.tree = TG.propagateStatuses(state.tree);
    indexTree();
    state.scope = node(state.scopeId) || state.tree;
    state.scopeId = state.scope.id;
    state.stats = TG.computeStats(state.scope);
    state.mood = TG.moodFromHealth(state.stats.healthScore);
    const computeLayout = TG.computeLayout || (TG.LayoutEngine && TG.LayoutEngine.compute);
    state.layout = computeLayout ? computeLayout(state.scope) : null;
    state.running = !!opts.animate;
    updateChrome();                       // BEFORE layout: label text changes their size
    const renderOpts = { avoid: [...document.querySelectorAll(OVERLAYS)], onProgress: runChrome };
    const tree = asRoot(state.scope);
    if (opts.animate) {
      runChrome({ passing: 0, failing: 0, flaky: 0, skipped: 0 }, 0, state.stats.totalTests);
      renderer.runAnimation(tree, state.mood, TG, renderOpts, () => {
        state.running = false; updateChrome(); checkLegend(); applyFocus(); views.refresh();
      });
    } else {
      renderer.render(tree, state.mood, TG, renderOpts);
      checkLegend();
      applyFocus();
    }
    // Large scopes hang one pod per file. (Never longer than the default hint:
    // the hint is UI that leaves were placed around.)
    $('#hint').innerHTML = renderer.grain === 'spec'
      ? 'Each glass <b>pod</b> is a file · double-click one to <b>fly in</b> · <b>Esc</b> to go back'
      : HINT;
    views.refresh();
  }
  const HINT = document.getElementById('hint').innerHTML;

  /** Guard: count what is actually drawn and compare with the legend. */
  function checkLegend() {
    const drawn = {};
    for (const s of [...STATUSES, 'pending']) drawn[s] = document.querySelectorAll(`#svg-host .tgl-${s}`).length;
    for (const pod of document.querySelectorAll('#svg-host .tgp')) {      // a pod holds a whole file's results
      const [p, f, fl, sk, pe] = pod.dataset.counts.split(',').map(Number);
      drawn.passing += p; drawn.failing += f; drawn.flaky += fl; drawn.skipped += sk; drawn.pending += pe;
    }
    const ok = STATUSES.every((s) => drawn[s] === state.stats[s]);
    state.legendCheck = { ok, drawn };
    if (!ok) console.error('TestGrove: legend does not match the drawn leaves', drawn, state.stats);
    return state.legendCheck;
  }

  // ── Status card ──────────────────────────────────────────────────
  function updateChrome() {
    const s = state.stats;
    const pct = Math.round(s.healthScore * 100);
    $('#health-pct').textContent = state.running ? '…' : `${pct}%`;
    $('#health-txt').textContent = state.running ? `running ${s.totalTests} tests` : 'passing';
    const m = MOOD[state.mood];
    $('#mood-dot').style.background = m.dot;
    $('#mood-label').textContent = m.label;
    $('#meter').replaceChildren(...ORDER.filter((k) => s[k]).map((k) => {
      const seg = document.createElement('span');
      seg.style.cssText = `flex:${s[k]} 1 0; background: var(--${k})`;
      seg.title = `${s[k]} ${k}`;
      return seg;
    }));
    $('#meter').setAttribute('aria-label', ORDER.filter((k) => s[k]).map((k) => `${s[k]} ${k}`).join(', '));
    for (const k of STATUSES) {
      $(`#n-${k}`).textContent = s[k];
      document.querySelector(`.lg[data-status="${k}"]`).disabled = !s[k] || state.running;
    }
    $('#status-card .legend').style.opacity = state.running ? 0.5 : 1;
    const where = state.scope.kind === 'root' ? `${state.tree.name}/` : state.scope.path;
    $('#brand-sub').textContent = `Playwright · ${where} · ${s.totalTests} test${s.totalTests === 1 ? '' : 's'}`;
    // Breadcrumbs (only when flown in)
    const ids = lineage(state.scopeId);
    const crumbs = $('#crumbs');
    crumbs.hidden = ids.length < 2;
    crumbs.replaceChildren();
    ids.forEach((id, i) => {
      if (i) crumbs.append(Object.assign(document.createElement('span'), { className: 'chev', textContent: '›' }));
      const b = document.createElement('button');
      b.textContent = node(id).name;
      b.dataset.id = id;
      if (i === ids.length - 1) b.setAttribute('aria-current', 'page');
      crumbs.append(b);
    });
    $('#btn-simulate').setAttribute('aria-busy', String(state.running));
  }
  /** While a run is in flight the card counts results as they arrive — no spoilers. */
  function runChrome(c, done, total) {
    $('#health-pct').textContent = String(done);
    $('#health-txt').textContent = `of ${total} done`;
    $('#mood-dot').style.background = 'var(--pending)';
    $('#mood-label').textContent = 'Running';
    const segs = ORDER.filter((k) => c[k]).map((k) => {
      const seg = document.createElement('span');
      seg.style.cssText = `flex:${c[k]} 1 0; background: var(--${k})`;
      return seg;
    });
    if (total > done) {
      const rest = document.createElement('span');
      rest.style.cssText = `flex:${total - done} 1 0; background: rgba(255,255,255,.12)`;
      segs.push(rest);
    }
    $('#meter').replaceChildren(...segs);
    for (const k of STATUSES) $(`#n-${k}`).textContent = c[k] || 0;
  }

  $('#crumbs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-id]');
    if (b && !b.hasAttribute('aria-current')) flyOut(b.dataset.id);
  });

  // Legend = focus filter: click a result to light only those leaves
  $('#legend').addEventListener('click', (e) => {
    const b = e.target.closest('.lg');
    if (!b || b.disabled) return;
    state.focusStatus = state.focusStatus === b.dataset.status ? null : b.dataset.status;
    applyFocus();
  });
  function applyFocus() {
    if (state.focusStatus && !state.stats[state.focusStatus]) state.focusStatus = null;
    for (const b of document.querySelectorAll('.lg')) b.setAttribute('aria-pressed', String(b.dataset.status === state.focusStatus));
    $('#legend').classList.toggle('has-focus', !!state.focusStatus);
    renderer.focusStatus(state.focusStatus);
  }
  for (const b of document.querySelectorAll('.lg')) b.querySelector('.ic').innerHTML = icon(b.dataset.status, 16);
  $('#logo').innerHTML = icon('passing', 22);
  $('#empty-icons').innerHTML = STATUSES.map((s) => icon(s, 22)).join('');

  // ── Tooltip ──────────────────────────────────────────────────────
  const tooltip = $('#tooltip');
  function showTip(html, x, y) {
    tooltip.innerHTML = html;
    tooltip.classList.add('show');
    const pad = 12, r = tooltip.getBoundingClientRect();
    let tx = x + 16, ty = y + 14;
    if (tx + r.width > window.innerWidth - pad) tx = x - r.width - 16;
    if (ty + r.height > window.innerHeight - pad) ty = y - r.height - 14;
    tooltip.style.left = `${Math.max(pad, tx)}px`;
    tooltip.style.top = `${Math.max(pad, ty)}px`;
  }
  function hideTip() { tooltip.classList.remove('show'); }
  const pill = (status, label) => `<span class="pill">${icon(status === 'ruptured' ? 'failing' : status, 14)}${esc(label || status)}</span>`;
  function countsOf(n) {
    const c = { total: 0, passing: 0, failing: 0, flaky: 0, skipped: 0, pending: 0 };
    for (const x of TG.walk(n)) if (x.kind === 'test') { c.total++; c[x.status]++; }
    return c;
  }
  function tooltipHtml(n) {
    if (n.kind === 'test') {
      const md = n.metadata || {};
      const err = md.error ? `<div class="t-err">${esc(md.error.message.split('\n').slice(0, 3).join('\n'))}</div>` : '';
      const extra = n.status === 'flaky' && md.retryCount ? ` · passed on retry ${md.retryCount}` : '';
      return `<div class="t-name">${esc(n.name)}</div>
        <div class="t-meta">${esc(n.path.split('::')[0])}</div>
        <div class="t-row">${pill(n.status)}<span class="t-dim">${md.duration ? fmtMs(md.duration) + ' · ' : ''}${SHAPE[n.status]}${extra}</span></div>${err}`;
    }
    const c = countsOf(n);
    const ruptured = renderer.rupturedSpecs && renderer.rupturedSpecs.has(n.id);
    const parts = ORDER.filter((k) => c[k]).map((k) => `${icon(k, 12)} ${c[k]} ${k}`).join('&nbsp;&nbsp;');
    let setup = '';
    if (ruptured) {
      const first = [...TG.walk(n)].find((x) => x.kind === 'test' && x.metadata && x.metadata.error);
      setup = `<div class="t-err">Setup failed — the flow stops here; ${c.skipped} test${c.skipped === 1 ? '' : 's'} below never ran.\n${first ? esc(first.metadata.error.message.split('\n')[0]) : ''}</div>`;
    }
    const kind = n.kind === 'root' ? 'the whole suite' : n.kind === 'spec' ? 'file' : 'folder';
    const canFly = n.id !== state.scopeId && c.total > 0;
    return `<div class="t-name"><span class="t-big">${Math.round((c.passing / Math.max(1, c.total)) * 100)}%</span>&nbsp;${esc(n.name)}</div>
      <div class="t-meta">${esc(kind)} · ${c.total} test${c.total === 1 ? '' : 's'}</div>
      <div class="t-row t-dim">${parts}</div>${setup}
      ${canFly ? '<div class="t-hint">Double-click to fly in · click for details</div>' : ''}`;
  }
  renderer.hoverListeners.add((id, ev) => {
    if (!id || state.view !== 'tree') { hideTip(); return; }
    const n = node(id);
    if (!n) { hideTip(); return; }
    showTip(tooltipHtml(n), ev.clientX, ev.clientY);
    $('#hint').classList.add('gone');
  });

  // ── Detail panel ─────────────────────────────────────────────────
  function clearDetail() {
    $('#empty').hidden = false;
    $('#detail-content').hidden = true;
    state.selectedId = null;
  }
  function showDetail(id) {
    const n = node(id);
    if (!n) return;
    state.selectedId = n.id;
    $('#empty').hidden = true;
    const el = $('#detail-content');
    el.hidden = false;
    if (n.kind === 'test') {
      const md = n.metadata || {};
      const [file] = n.path.split('::');
      el.innerHTML = `
        <div><h3>${icon(n.status, 18)}<span>${esc(n.name)}</span></h3>
          <div class="path">${esc(file)}${md.error && md.error.line ? ':' + md.error.line : ''}</div></div>
        <div>${pill(n.status)} <span style="color:var(--ink-3); font-size:12px; margin-left:4px">${SHAPE[n.status]}</span></div>
        <div class="stat-grid">
          <div class="stat"><div class="k">Duration</div><div class="v">${fmtMs(md.duration)}</div></div>
          <div class="stat"><div class="k">${n.status === 'flaky' ? 'Passed on retry' : 'Retries'}</div><div class="v">${md.retryCount || 0}</div></div>
        </div>
        ${md.error ? `<div><div class="k-label">Error</div><pre class="err">${esc(md.error.message)}</pre></div>` : ''}
        <div class="actions">
          ${n.status !== 'passing' ? `<button class="btn primary" data-act="ai">✦ Ask AI why it ${n.status === 'failing' ? 'failed' : 'is ' + n.status}</button>` : ''}
          <div class="btn-row"><button class="btn" data-act="rerun">↻ Rerun</button><button class="btn" data-act="open">Open file</button></div>
        </div>`;
    } else {
      const c = countsOf(n);
      const fails = [...TG.walk(n)].filter((x) => x.kind === 'test' && x.status === 'failing').slice(0, 6);
      const kind = n.kind === 'root' ? 'Suite' : n.kind === 'spec' ? 'File' : 'Folder';
      el.innerHTML = `
        <div><h3><span>${esc(n.name)}</span></h3><div class="path">${esc(kind)} · ${esc(n.path)}</div></div>
        <div class="stat-grid">
          <div class="stat"><div class="k">Pass rate</div><div class="v">${Math.round((c.passing / Math.max(1, c.total)) * 100)}%</div></div>
          <div class="stat"><div class="k">Tests</div><div class="v">${c.total}</div></div>
        </div>
        <div class="meter" style="height:8px">${ORDER.filter((k) => c[k]).map((k) => `<span style="flex:${c[k]} 1 0; background:var(--${k})" title="${c[k]} ${k}"></span>`).join('')}</div>
        <div style="display:flex; gap:12px; flex-wrap:wrap; font-size:12px; color:var(--ink-2)">${ORDER.filter((k) => c[k]).map((k) => `<span style="display:inline-flex;gap:5px;align-items:center">${icon(k, 13)}${c[k]} ${k}</span>`).join('')}</div>
        ${renderer.rupturedSpecs && renderer.rupturedSpecs.has(n.id) ? `<div><div class="k-label">Setup failed — the tests below never ran</div><pre class="err">${esc(([...TG.walk(n)].find((x) => x.metadata && x.metadata.error) || { metadata: { error: { message: '' } } }).metadata.error.message)}</pre></div>` : ''}
        ${fails.length ? `<div><div class="k-label">Failing here</div>${fails.map((f) => `<button class="btn" style="width:100%; justify-content:flex-start; margin-bottom:4px" data-go="${esc(f.id)}">${icon('failing', 13)}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(f.name)}</span></button>`).join('')}</div>` : ''}
        <div class="actions">
          ${n.id !== state.scopeId ? `<button class="btn primary" data-act="fly">Fly into ${esc(n.name)} →</button>` : ''}
          <button class="btn" data-act="list">Show as list</button>
        </div>`;
    }
  }
  $('#detail-content').addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]');
    if (go) { select(go.dataset.go); return; }
    const a = e.target.closest('[data-act]');
    if (!a) return;
    const n = node(state.selectedId);
    if (!n) return;
    if (a.dataset.act === 'fly') flyInto(n.id);
    else if (a.dataset.act === 'list') setView('list');
    else if (a.dataset.act === 'open') openFile(n);
    else if (a.dataset.act === 'ai') post({ type: 'askAi', testName: n.name, path: n.path, error: n.metadata && n.metadata.error }, 'AI explanations arrive in v0.7');
    else if (a.dataset.act === 'rerun') post({ type: 'rerun', path: n.path }, 'Re-running a single test arrives with live Playwright runs');
  });

  function select(id) {
    const n = node(id);
    if (!n) return;
    showDetail(n.id);
    renderer.select(n.id);
    if (state.view === 'list') views.refresh();
  }
  renderer.onSelect = (id) => select(id);
  renderer.onZoom = (id, anchor) => flyInto(stripScope(id), anchor);

  // ── VS Code bridge (no-op in the browser prototype) ──────────────
  function post(msg, fallback) {
    if (window.vscode) window.vscode.postMessage(msg);
    else if (fallback) toast(fallback);
  }
  function openFile(row) {
    const n = row && row.node ? row.node : row;
    if (!n) return;
    const [file] = n.path.split('::');
    post({ type: 'openFile', file, line: (n.metadata && n.metadata.error && n.metadata.error.line) || 1 }, `Would open ${file}`);
  }
  let toastTimer = null;
  function toast(msg) {
    const hint = $('#hint');
    hint.textContent = msg;
    hint.classList.remove('gone');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => hint.classList.add('gone'), 2600);
  }

  // ── Views ────────────────────────────────────────────────────────
  const views = window.TestGroveViews.create({
    TG, Leaf, esc, fmtMs, showTip, hideTip, openFile,
    scope: () => state.scope || state.tree,
    selectedId: () => state.selectedId,
    onSelect: (id) => select(id),
    setView: (v) => setView(v),
    fly: (id) => { setView('tree'); setTimeout(() => flyInto(id), 260); },
    showInTree: (ids) => { setView('tree'); state.focusStatus = null; applyFocus(); renderer.focusLeaves(new Set(ids)); },
  });
  function setView(v) {
    if (state.view === v) return;
    state.view = v;
    $('#scene').className = `view-${v}`;
    for (const b of document.querySelectorAll('.seg [role="tab"]')) b.setAttribute('aria-selected', String(b.dataset.view === v));
    moveThumb();
    hideTip();
    views.show(v);
  }
  function moveThumb() {
    const b = document.querySelector(`.seg [data-view="${state.view}"]`), t = $('#seg-thumb');
    t.style.left = `${b.offsetLeft}px`;
    t.style.width = `${b.offsetWidth}px`;
  }
  document.querySelector('.seg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]');
    if (b) setView(b.dataset.view);
  });

  // ── Fly in / fly out (semantic zoom) ─────────────────────────────
  let flying = false;
  function canFly(id) {
    const n = node(id);
    return !!n && n.kind !== 'test' && n.id !== state.scopeId && countTests(n) > 0;
  }
  function flyInto(id, anchor) {
    if (flying || state.running || !canFly(id)) return;
    flying = true;
    hideTip();
    const host = $('#svg-host'), ghost = $('#fly-ghost'), box = host.getBoundingClientRect();
    const old = host.firstElementChild;
    anchor = anchor || renderer.anchorOf(id);
    if (old) {
      ghost.replaceChildren(old);
      old.style.transformOrigin = `${anchor.x - box.left}px ${anchor.y - box.top}px`;
      old.animate([{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(2.8)', opacity: 0 }],
        { duration: 620, easing: 'cubic-bezier(.55,0,.85,.25)', fill: 'forwards' });
    }
    state.scopeId = id;
    state.focusStatus = null;
    clearDetail();
    refresh();
    const fresh = host.firstElementChild;
    if (fresh) fresh.animate([{ transform: 'scale(.72)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }],
      { duration: 700, delay: 220, easing: 'cubic-bezier(.2,.75,.2,1)', fill: 'backwards' });
    setTimeout(() => { ghost.replaceChildren(); flying = false; }, 960);
  }
  function flyOut(toId) {
    if (flying || state.running) return;
    const from = state.scopeId;
    toId = toId || parentOf.get(from);
    if (!toId) return;
    flying = true;
    hideTip();
    const host = $('#svg-host'), ghost = $('#fly-ghost'), box = host.getBoundingClientRect();
    const old = host.firstElementChild;
    if (old) {
      ghost.replaceChildren(old);
      old.style.transformOrigin = '50% 45%';
      old.animate([{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(.62)', opacity: 0 }],
        { duration: 520, easing: 'cubic-bezier(.45,0,.8,.3)', fill: 'forwards' });
    }
    state.scopeId = toId;
    state.focusStatus = null;
    clearDetail();
    refresh();
    // arrive close-up on the branch we came from, then pull back
    const path = lineage(from);
    const child = path[path.indexOf(toId) + 1] || from;
    const a = renderer.anchorOf(child);
    const fresh = host.firstElementChild;
    if (fresh) {
      fresh.style.transformOrigin = `${a.x - box.left}px ${a.y - box.top}px`;
      fresh.animate([{ transform: 'scale(2.6)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }],
        { duration: 760, delay: 140, easing: 'cubic-bezier(.2,.75,.2,1)', fill: 'backwards' });
    }
    renderer.select(child);
    setTimeout(() => { ghost.replaceChildren(); flying = false; }, 920);
  }

  // ── Actions ──────────────────────────────────────────────────────
  // Simulate a run: same tests, fresh results. Leaves keep their places
  // (layout ignores results); spec files run in parallel workers.
  let runCount = 0;
  function simulate() {
    if (state.running || flying) return;
    runCount++;
    const totalNow = TG.computeStats(state.tree).totalTests;
    state.tree = TG.generateMockTree({
      totalTests: totalNow,
      seed: 1000 + runCount * 7919,
      statusMix: { passing: 0.84, failing: 0.07, flaky: 0.06, skipped: 0.03 },
      setupFailures: runCount % 2 ? [] : ['payment.spec.ts'],
    });
    setView('tree');
    refresh({ animate: true });
  }
  $('#btn-simulate').onclick = simulate;
  // Until live Playwright runs land, Run all plays a simulated run (and tells the extension).
  $('#btn-run').onclick = () => { post({ type: 'runAll' }); simulate(); };
  $('#btn-config').onclick = () => post({ type: 'openConfig' }, 'Config (test dir, config path, projects) arrives with live runs');
  $('#btn-framework').onclick = () => post({ type: 'addFramework' }, 'Jest and Vitest adapters plug in through the TestParser interface');
  // Add 20 more tests — the tree grows
  $('#btn-grow').onclick = () => {
    if (state.running || flying) return;
    const totalNow = TG.computeStats(state.tree).totalTests;
    state.tree = TG.generateMockTree({
      totalTests: totalNow + 20, seed: 42,
      statusMix: { passing: 0.87, failing: 0.07, flaky: 0.06, skipped: 0.0 },
      setupFailures: ['payment.spec.ts'],
    });
    refresh();
  };

  // ── Keyboard ─────────────────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    const typing = e.target.closest && e.target.closest('input, textarea, [contenteditable]');
    if (e.key === 'Escape') {
      if (typing) { e.target.blur(); return; }
      if (state.view !== 'tree') setView('tree');
      else if (state.focusStatus) { state.focusStatus = null; applyFocus(); }
      else if (parentOf.get(state.scopeId)) flyOut();
      else { renderer.select(null); clearDetail(); }
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '1') setView('tree');
    else if (e.key === '2') setView('list');
    else if (e.key === '3') setView('stats');
    else if (e.key === '/' && state.view === 'list') { e.preventDefault(); views.focusSearch(); }
    else if (e.key === 'Backspace' && state.view === 'tree' && parentOf.get(state.scopeId)) flyOut();
  });

  // ── Messages from the VS Code extension ──────────────────────────
  window.addEventListener('message', (e) => {
    const msg = e.data || {};
    if (msg.type === 'command' && msg.name === 'runAll') simulate();
    else if (msg.type === 'load' && msg.tree) window.TestGroveApp.load(msg.tree);   // live results (v0.6)
  });

  // ── Public hook ──────────────────────────────────────────────────
  // Demos, screenshots and the VS Code extension load data through here,
  // so they can never bypass the legend.
  window.TestGroveApp = {
    load(tree, opts) { state.tree = tree; if (!node(state.scopeId)) state.scopeId = null; refresh(opts); return state.legendCheck; },
    flyTo(id) { flyInto(id); },
    back() { flyOut(); },
    setView,
    get state() { return state; },
    get renderer() { return renderer; },
  };

  // ── Boot ─────────────────────────────────────────────────────────
  state.tree = TG.generateMockTree({
    totalTests: 100, seed: 42,
    statusMix: { passing: 0.87, failing: 0.07, flaky: 0.06, skipped: 0.0 },
    setupFailures: ['payment.spec.ts'],
  });
  refresh();
  moveThumb();

  // The visible part of the painting depends on the panel's shape, so re-place
  // leaves when it changes (every leaf must stay fully visible).
  let resizeTimer = null;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (!state.running && !flying) { refresh(); moveThumb(); } }, 150);
  }).observe($('#scene'));
})();
