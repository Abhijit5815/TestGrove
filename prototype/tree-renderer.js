/**
 * TestGrove — Tree Renderer (v0.5)
 *
 * The tree IS the data map. Two stacked SVGs share one viewBox and the same
 * 'slice' fit, so they line up exactly:
 *
 *   WORLD   (static)  the scene — the painting with depth of field, its glass
 *           branches frosted — and the LIGHT INSIDE THE GLASS. Every vessel of
 *           the sap network lights the actual glass branch it runs through:
 *             tint      the glass body takes the status colour (colour blend)
 *             core      a brighter channel of light along the branch's centre
 *             filament  a thin line in the core — solid when healthy, broken
 *                       when failing, flickering dots when flaky (non-colour cue)
 *           Light is masked to the glass, so it follows the branch's own curves
 *           and never touches bark or sky. The wooden trunk stays wood: the
 *           constant anchor. Nothing in this layer animates while idle.
 *   GLYPHS  junction knots (one per folder / spec file), one leaf per test,
 *           and invisible hit-targets along every branch.
 *
 * Interaction: hover a leaf, a knot or a BRANCH — the branch's whole subtree
 * lights up and the rest recedes. Click selects; double-click asks the app to
 * fly into a folder or file (onZoom).
 *
 * Runs stream through a session (the same calls a live Playwright reporter
 * will make):
 *     const run = renderer.startRun(tree, mood, TG, opts)
 *     run.specStarted(specId)   the spec's branches light up, sap flows
 *     run.testFinished(test)    that leaf opens to its result
 *     run.specFinished(specId)  its branches settle into their status colour
 *     run.finish()              final state, identical positions
 */
(function () {
  const SVGNS = 'http://www.w3.org/2000/svg';
  const G = () => window.GroveLayout;
  const L = () => window.TestGroveLeaf;

  // Light inside the glass, per status: tint = glass body colour, core = inner light
  const LIGHT = {
    passing:  { tint: '#22B874', core: '#7CF2B8' },
    flaky:    { tint: '#E0952A', core: '#FFCB7A' },
    failing:  { tint: '#E3284A', core: '#FF7D8C' },
    skipped:  { tint: '#8D99A6', core: null },
    pending:  { tint: '#8EC2FF', core: '#DDEEFF' },
    ruptured: { tint: '#4A0812', core: null },
  };
  const WOOD_RADIUS = 26;
  const MIN_LEAF_SCALE = 0.32;
  const LIGHT_MAX_R = 30;        // px half-width: thicker is trunk wood — light never shows there   // below this a leaf is too small to read or hover — files become pods   // px: a junction on wood this thick is on the trunk — shown only in focus
  // Filament dash per status — the non-colour cue inside the light
  const FILAMENT = { passing: null, pending: null, flaky: '1.4 3', failing: '6 4', skipped: null, ruptured: '1 4' };
  const BEAD = {
    passing: ['#D6FFE9', '#19C46E', '#0A5A33'], flaky: ['#FFF0CC', '#E89A1C', '#6B4206'],
    failing: ['#FFD3D8', '#EE1F3D', '#5C0614'], skipped: ['#EEF2F6', '#8D99A6', '#3B4651'],
    pending: ['#FFFFFF', '#8EC2FF', '#2B4A66'], ruptured: ['#B2475A', '#4A0812', '#1A0206'],
  };

  let UID = 0;

  function el(tag, attrs, parent) {
    const n = document.createElementNS(SVGNS, tag);
    for (const k in attrs) if (attrs[k] !== undefined && attrs[k] !== null) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }

  // ── Geometry helpers ─────────────────────────────────────────────
  /** Moving average along a polyline (endpoints fixed): removes the grid's stair-steps. */
  function smooth(arr, passes, get, set) {
    let a = arr;
    for (let p = 0; p < passes; p++) {
      const b = a.map((v) => ({ ...v }));
      for (let i = 1; i < a.length - 1; i++) {
        const lo = Math.max(0, i - 2), hi = Math.min(a.length - 1, i + 2);
        let sx = 0, sy = 0, sr = 0, n = 0;
        for (let j = lo; j <= hi; j++) { sx += a[j].x; sy += a[j].y; sr += a[j].r; n++; }
        b[i].x = sx / n; b[i].y = sy / n; b[i].r = sr / n;
      }
      a = b;
    }
    return a;
  }

  /** Catmull-Rom through points → cubic Bézier path (organic, no corners). */
  function curve(pts) {
    if (pts.length < 2) return '';
    if (pts.length === 2) return `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)} L ${pts[1].x.toFixed(1)} ${pts[1].y.toFixed(1)}`;
    let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      d += ` C ${(p1.x + (p2.x - p0.x) / 6).toFixed(1)} ${(p1.y + (p2.y - p0.y) / 6).toFixed(1)}` +
           ` ${(p2.x - (p3.x - p1.x) / 6).toFixed(1)} ${(p2.y - (p3.y - p1.y) / 6).toFixed(1)}` +
           ` ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
    }
    return d;
  }

  /** Runs of a centre line that lie in glass, not in trunk-thick wood. */
  function glassRuns(pts) {
    const runs = [];
    let cur = [];
    for (const p of pts) {
      if (p.r <= LIGHT_MAX_R) cur.push(p);
      else if (cur.length) { if (cur.length > 1) runs.push(cur); cur = []; }
    }
    if (cur.length > 1) runs.push(cur);
    return runs;
  }

  /** A filled ribbon along the centre line, half-width k·r(s), round ends. */
  function ribbon(pts, k, min, max) {
    if (pts.length < 2) return '';
    const L = [], R = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      let tx = b.x - a.x, ty = b.y - a.y;
      const len = Math.hypot(tx, ty) || 1; tx /= len; ty /= len;
      const w = Math.min(max, Math.max(min, pts[i].r * k));
      L.push([pts[i].x - ty * w, pts[i].y + tx * w]);
      R.push([pts[i].x + ty * w, pts[i].y - tx * w]);
    }
    const f = (p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`;
    const end = pts[pts.length - 1], w1 = Math.min(max, Math.max(min, end.r * k));
    const start = pts[0], w0 = Math.min(max, Math.max(min, start.r * k));
    const tip = f(R[R.length - 1]);
    return `M ${L.map(f).join(' L ')} A ${w1.toFixed(1)} ${w1.toFixed(1)} 0 0 0 ${tip} ` +
           `L ${R.reverse().map(f).join(' L ')} A ${w0.toFixed(1)} ${w0.toFixed(1)} 0 0 0 ${f(L[0])} Z`;
  }

  const STYLE = `
    .tg-world, .tg-glyphs { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
    .tg-glyphs { pointer-events: none; }
    .tg-light-tint > *, .tg-light-core > *, .tg-light-fil > *, .tg-light-shade > * {
      opacity: var(--o, 1); transition: opacity .35s ease, fill .6s ease, stroke .6s ease; }
    .tg-dimmed .tg-light-tint > :not(.is-hot) { opacity: calc(var(--o, 1) * .3); }
    .tg-dimmed .tg-light-core > :not(.is-hot) { opacity: calc(var(--o, 1) * .1); }
    .tg-dimmed .tg-light-fil > :not(.is-hot)  { opacity: calc(var(--o, 1) * .15); }
    .tg-dimmed .tg-light-core > .is-hot { opacity: min(1, calc(var(--o, 1) * 1.3)); }
    .tg-light-core > .is-trace { opacity: min(1, calc(var(--o, 1) * 1.8)) !important; }
    .tg-light-fil > .is-trace { opacity: 1 !important; }
    .tg-hit { fill: none; stroke: transparent; pointer-events: stroke; cursor: pointer; }
    .tg-node { cursor: pointer; pointer-events: visiblePainted; transition: opacity .25s ease; }
    .tg-node .tg-node-body { transition: transform .18s ease; transform-box: fill-box; transform-origin: center; }
    .tg-node:hover .tg-node-body, .tg-node.is-hot .tg-node-body { transform: scale(1.35); }
    .tg-node-ring { opacity: 0; transition: opacity .2s ease; }
    .tg-node.is-selected .tg-node-ring, .tg-node:hover .tg-node-ring { opacity: .9; }
    .tg-dimmed .tg-node:not(.is-hot) { opacity: .35; }
    .tg-node-wood { opacity: 0; pointer-events: none; }
    .tg-node-wood.is-hot, .tg-node-wood.is-selected { opacity: 1; }
    .tg-dimmed .tg-node-wood:not(.is-hot) { opacity: 0; }
    .tg-hidden { display: none; }
    @media (prefers-reduced-motion: no-preference) {
      .tg-pulse { animation: tg-pulse 1.1s linear infinite; }
      .tg-node-ruptured .tg-node-crack { animation: tg-rupture 2.4s ease-in-out infinite; }
    }
    @keyframes tg-pulse   { to { stroke-dashoffset: -36; } }
    @keyframes tg-rupture { 0%,100% { opacity: .55; } 50% { opacity: 1; } }
  `;

  class TreeImageRenderer {
    constructor(container) {
      this.container = container;
      this.onSelect = null;
      this.onZoom = null;
      this.hoverListeners = new Set();
      this.selectedId = null;
      this._timers = [];
    }

    /**
     * @param tree  TestNode root (statuses already propagated)
     * @param mood  'peaceful' | 'unsettled' | 'stormy' | 'eerie'
     * @param TG    the TestGrove core API (walk, ...)
     * @param opts.avoid  UI elements no leaf may hide under
     */
    render(tree, mood, TG, opts) {
      opts = opts || {};
      this._cancelAnimation();
      const A = window.TREE_ANATOMY;
      const M = A.moods[mood] || A.moods.unsettled;
      const S = (window.TREE_SCENE && window.TREE_SCENE.moods[mood]) || null;
      const W = A.imageWidth, H = A.imageHeight;
      const uid = `tg${++UID}`;
      this.TG = TG;
      this.tree = tree;
      this.mood = mood;
      L().installLeafDefs(document);

      // ── Layout (status-independent) + network ──
      const view = this.viewInPainting(W, H, opts.avoid || []);
      const env = { W, H, walk: TG.walk, leafVisual: L().leafVisual, collider: L().COLLIDER,
                    podVisual: L().podVisual, podCollider: L().POD_COLLIDER };
      // Semantic zoom: one leaf per test while every leaf stays legible; past
      // that, each spec file hangs as one glass pod (fly in to see its leaves).
      const files = G().structureOf(tree, TG.walk).reduce((n, l) => n + l.specs.length, 0);
      let lay = files > 1 ? G().layoutGrove(tree, M, env, view, { minScale: MIN_LEAF_SCALE }) : null;
      if (!lay) lay = G().layoutGrove(tree, M, env, view, files > 1 ? { grain: 'spec' } : {});
      const { placements, globalScale } = lay;
      this.grain = lay.grain;
      const net = G().buildNetwork(M, placements);
      const hover = G().hoverScales(placements, net.nodes);
      this.globalScale = globalScale;
      this.placements = placements;
      this.network = net;
      this.owners = G().segmentOwners(net, placements, tree.id);
      this.nodeById = new Map(net.nodes.map((n) => [n.id, n]));

      // What each placed item carries: one test's result, or a whole file's results (pod)
      const countsOf = new Map(placements.map((p) => [p.test.id, p.test.kind === 'pod'
        ? L().podVisual(p.test).counts : { [p.test.status]: 1 }]));
      this.countsOf = countsOf;
      const statusesOf = (ids) => { const out = []; for (const id of ids) for (const k in countsOf.get(id)) if (countsOf.get(id)[k]) out.push(k); return out; };
      // Ruptured specs: the flow stops at their junction (or at the pod, when files are pods)
      const ruptured = new Set();
      for (const nd of net.nodes) {
        if (nd.kind === 'spec' && G().isRuptured(nd.leafIds.flatMap((id) => this._expand(id)))) ruptured.add(nd.id);
      }
      for (const p of placements) if (p.test.kind === 'pod' && L().podVisual(p.test).ruptured) ruptured.add(p.test.id);
      const rupturedLeaves = new Set();
      for (const nd of net.nodes) if (ruptured.has(nd.id)) nd.leafIds.forEach((id) => rupturedLeaves.add(id));
      for (const id of ruptured) if (countsOf.has(id)) rupturedLeaves.add(id);
      this.rupturedSpecs = ruptured;
      this.rupturedLeaves = rupturedLeaves;

      // ── WORLD: scene + light in the glass ──
      const frame = { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid slice' };
      const world = el('svg', { ...frame, class: 'tg-world', 'aria-hidden': 'true' });
      el('style', {}, world).textContent = STYLE;
      const defs = el('defs', {}, world);
      el('image', { href: S ? S.scene : M.image, x: 0, y: 0, width: W, height: H, preserveAspectRatio: 'none' }, world);
      let maskRef = null;
      if (S && S.glass) {
        const mask = el('mask', { id: `${uid}-glass`, maskUnits: 'userSpaceOnUse', x: 0, y: 0, width: W, height: H }, defs);
        el('image', { href: S.glass, x: 0, y: 0, width: W, height: H, preserveAspectRatio: 'none' }, mask);
        maskRef = `url(#${uid}-glass)`;
      }
      const blur = (id, sd) => { const f = el('filter', { id: `${uid}-${id}`, x: '-10%', y: '-10%', width: '120%', height: '120%' }, defs);
        el('feGaussianBlur', { stdDeviation: sd }, f); return `url(#${uid}-${id})`; };
      const soft = blur('soft', 1.1), glow = blur('glow', 2.6);
      const layer = (cls, blend, filter, opacity) => el('g', { class: cls, mask: maskRef, filter,
        opacity, style: blend ? `mix-blend-mode:${blend}` : null }, world);
      // Without the glass mask (older scene files) the light is kept narrow so it stays on the branch
      const kTint = maskRef ? 1.15 : 0.55;
      const shade = layer('tg-light-shade', 'multiply', soft, 0.9);
      const tint = layer('tg-light-tint', 'color', soft, 0.62);
      const core = layer('tg-light-core', 'screen', glow, 0.5);
      const fil = layer('tg-light-fil', 'screen', null, 0.62);
      const pulses = layer('tg-light-pulse', 'screen', null, 0.9);
      this.world = world;
      this.pulseLayer = pulses;

      // ── Vessels → light ──
      this.segEls = new Map();         // seg id → { tint, core, fil, shade, pts }
      const ordered = [...net.segments].filter((s) => s.leafIds.length).sort((a, b) => b.leafIds.length - a.leafIds.length);
      for (const seg of ordered) {
        const raw = seg.cells.map((k) => ({ ...net.cellXY(k), r: net.radiusAt(k) }));
        const pts = smooth(raw, 2);
        const mid = curve(pts);
        const st = this._segStatus(seg);
        const e = { pts, mid, seg };
        // Light lives only in glass: no ribbon where the wood is trunk-thick
        const lit = glassRuns(pts);
        const band = (k, lo, hi) => lit.map((run) => ribbon(run, k, lo, hi)).join(' ');
        e.tint = el('path', { d: band(kTint, 2.2, 18), 'data-seg': seg.id }, tint);
        e.core = el('path', { d: band(0.42, 0.9, 6.5), 'data-seg': seg.id }, core);
        e.litMid = lit.map(curve).join(' ');
        e.fil = el('path', { d: e.litMid, fill: 'none', 'stroke-width': 0.9, 'stroke-linecap': 'round', 'data-seg': seg.id }, fil);
        e.shade = el('path', { d: band(kTint, 2.2, 18), 'data-seg': seg.id }, shade);
        this.segEls.set(seg.id, e);
        this._paintSeg(e, st);
      }

      // ── GLYPHS: hit-targets, knots, leaves ──
      const glyphs = el('svg', { ...frame, class: 'tg-glyphs' });
      el('style', {}, glyphs).textContent = STYLE;
      const gdefs = el('defs', {}, glyphs);
      for (const [st, [hi, mid, lo]] of Object.entries(BEAD)) {
        const rg = el('radialGradient', { id: `${uid}-bead-${st}`, cx: '38%', cy: '34%', r: '70%' }, gdefs);
        el('stop', { offset: 0, 'stop-color': hi }, rg);
        el('stop', { offset: 0.55, 'stop-color': mid }, rg);
        el('stop', { offset: 1, 'stop-color': lo }, rg);
      }
      const hits = el('g', { class: 'tg-hits' }, glyphs);
      for (const e of this.segEls.values()) {
        const w = Math.max(10, Math.min(30, 2 * Math.max(...e.pts.map((p) => p.r)) * 0.9));
        el('path', { class: 'tg-hit', d: e.mid, 'stroke-width': w.toFixed(1), 'data-node-id': this.owners.get(e.seg.id),
          'data-seg': e.seg.id }, hits);
      }

      // Junction knots: small frosted beads where a folder's / file's sap parts ways.
      // Non-colour cue: failing = star-cut, flaky = half dark, ruptured = cracked.
      const nodes = el('g', { class: 'tg-nodes' }, glyphs);
      this.nodeEls = new Map();
      for (const nd of net.nodes) {
        const sts = statusesOf(nd.leafIds);
        const rup = ruptured.has(nd.id) || (nd.kind === 'limb' && nd.leafIds.every((id) => rupturedLeaves.has(id)));
        const st = rup ? 'ruptured' : G().worst(sts);
        const r = (nd.kind === 'limb' ? 4.4 : 3.3) * Math.max(0.8, globalScale);
        const f = G().fieldOf(M);
        const cellK = f ? Math.floor(nd.y / f.cell) * f.w + Math.floor(nd.x / f.cell) : -1;
        const onWood = cellK >= 0 && net.radiusAt(cellK) > WOOD_RADIUS;
        const g = el('g', { class: `tg-node tg-node-${nd.kind}${rup ? ' tg-node-ruptured' : ''}${onWood ? ' tg-node-wood' : ''}`,
          'data-node-id': nd.id, 'data-node-kind': nd.kind, transform: `translate(${nd.x.toFixed(1)} ${nd.y.toFixed(1)})` }, nodes);
        el('circle', { r: r * 2.4, fill: 'transparent' }, g);                       // generous hit area
        const body = el('g', { class: 'tg-node-body' }, g);
        el('circle', { r: r + 1.4, fill: '#06080b', opacity: 0.45 }, body);          // seat: separates it from the glass
        if (st === 'failing' || rup) {
          const pts = [];
          for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2 - Math.PI / 2, rr = i % 2 ? r * 0.6 : r * 1.18;
            pts.push(`${(Math.cos(a) * rr).toFixed(2)},${(Math.sin(a) * rr).toFixed(2)}`); }
          el('polygon', { points: pts.join(' '), fill: `url(#${uid}-bead-${st})`, stroke: rup ? '#FF8A96' : '#FFE3E6',
            'stroke-width': 0.7, 'stroke-linejoin': 'round' }, body);
        } else {
          el('circle', { r, fill: `url(#${uid}-bead-${st})`, stroke: '#ffffff', 'stroke-opacity': 0.75, 'stroke-width': 0.7 }, body);
          if (st === 'flaky') el('path', { d: `M 0 ${-r} A ${r} ${r} 0 0 1 0 ${r} Z`, fill: '#140b00', opacity: 0.55 }, body);
        }
        el('circle', { r: r * 0.32, cx: -r * 0.32, cy: -r * 0.36, fill: '#ffffff', opacity: rup ? 0.25 : 0.7 }, body);
        if (rup) el('path', { class: 'tg-node-crack', d: `M ${-r * 0.9} ${-r * 0.1} L ${-r * 0.15} ${r * 0.15} L ${r * 0.1} ${-r * 0.55} L ${r * 0.9} ${r * 0.3}`,
          fill: 'none', stroke: '#FFB3BC', 'stroke-width': 0.6 }, body);
        el('circle', { class: 'tg-node-ring', r: r + 3.4, fill: 'none', stroke: '#ffffff', 'stroke-width': 1, 'stroke-dasharray': '2.5 2' }, g);
        this.nodeEls.set(nd.id, g);
      }

      // Leaves: one per test
      const leaves = el('g', { class: 'tg-leaves' }, glyphs);
      this.leafLayer = leaves;
      this.leafEls = new Map();
      this.hoverScale = new Map();
      placements.forEach((p, i) => {
        const pod = p.test.kind === 'pod';
        const v = pod ? L().podVisual(p.test) : L().leafVisual(p.test);
        this.hoverScale.set(p.test.id, hover[i]);
        const node = (pod ? L().drawPod : L().drawLeaf)(leaves, v, { x: p.x, y: p.y, rotate: p.rotate, scale: p.scale / v.scale,
          wind: { delay: -(p.x / W) * 2.4, dur: 7 }, hover: hover[i] });
        this.leafEls.set(p.test.id, node);
      });

      // ── Interaction ──
      const idAt = (e) => { const t = e.target.closest && e.target.closest('[data-node-id]'); return t ? t.getAttribute('data-node-id') : null; };
      glyphs.addEventListener('click', (e) => {
        const id = idAt(e);
        if (!id) return;
        this.select(id);
        if (this.onSelect) this.onSelect(id);
      });
      glyphs.addEventListener('dblclick', (e) => {
        const id = idAt(e);
        if (id && this.onZoom) this.onZoom(id, this.anchorOf(id));
      });
      let hot = null;
      glyphs.addEventListener('mousemove', (e) => {
        const id = idAt(e);
        if (id !== hot) {
          hot = id;
          // a leaf traces its own sap path; a branch or knot lights its whole subtree
          if (id && this.leafEls.has(id)) this._trace(id); else this.highlight(id);
        }
        for (const fn of this.hoverListeners) fn(id, e);
      });
      glyphs.addEventListener('mouseleave', () => {
        hot = null; this.highlight(null);
        for (const fn of this.hoverListeners) fn(null, null);
      });

      // Swap in atomically: never a frame without a tree
      const stage = document.createElement('div');
      stage.className = 'tg-stage';
      stage.style.cssText = 'position:absolute; inset:0;';
      stage.append(world, glyphs);
      this.glyphs = glyphs;
      this.stage = stage;
      this.container.replaceChildren(stage);
      if (this.selectedId) this.select(this.selectedId, true);
      if (this.baseFocus) this.focusLeaves(new Set([...this.baseFocus].filter((x) => this.leafEls.has(x))));
    }

    // ── Status of a vessel ──
    _segStatus(seg) {
      const ids = seg.leafIds;
      if (ids.every((id) => this.rupturedLeaves.has(id))) return 'ruptured';
      const sum = { passing: 0, failing: 0, flaky: 0, skipped: 0, pending: 0 };
      for (const id of ids) {
        if (this.rupturedLeaves.has(id)) continue;
        const c = this.countsOf.get(id) || {};
        for (const k in sum) sum[k] += c[k] || 0;
      }
      return G().vesselStatusOf(sum);
    }

    /** The test statuses an item stands for: one for a leaf, all of a file's for a pod. */
    _expand(id) {
      const c = this.countsOf.get(id) || {};
      const out = [];
      for (const k in c) for (let i = 0; i < c[k]; i++) out.push(k);
      return out;
    }

    /** Light one vessel in a given state: a status, 'idle' (unlit glass) or 'running'. */
    _paintSeg(e, st) {
      const lit = st === 'running' ? 'pending' : st;
      const Lc = LIGHT[lit] || LIGHT.pending;
      const idle = st === 'idle';
      const o = (node, v) => node.style.setProperty('--o', v);
      e.tint.setAttribute('fill', Lc.tint);
      o(e.tint, idle ? 0 : st === 'skipped' ? 0.5 : 1);
      e.core.setAttribute('fill', Lc.core || Lc.tint);
      o(e.core, idle || !Lc.core ? 0 : st === 'running' ? 1 : 0.85);
      // Shade (multiply) gives the glass body its depth: failing glass turns a
      // deep crimson (withered), flaky a little warmer; dead glass goes dark —
      // no light flows past a ruptured spec, barely any where all is skipped.
      const SHADE = { failing: ['#B04256', 0.6], flaky: ['#C49A5E', 0.3], ruptured: ['#3a2a2e', 1], skipped: ['#6d7178', 0.5] };
      const [shadeFill, shadeO] = SHADE[st] || ['#ffffff', 0];
      e.shade.setAttribute('fill', shadeFill);
      o(e.shade, shadeO);
      const dash = FILAMENT[lit];
      e.fil.setAttribute('stroke', Lc.core || '#ffffff');
      // the filament is the non-colour cue: broken when failing, dotted when flaky — and bolder then
      e.fil.setAttribute('stroke-width', lit === 'failing' ? 1.6 : lit === 'flaky' ? 1.4 : 0.9);
      if (dash) e.fil.setAttribute('stroke-dasharray', dash); else e.fil.removeAttribute('stroke-dasharray');
      o(e.fil, idle || st === 'skipped' ? 0 : st === 'ruptured' ? 0.7 : 1);
      e.state = st;
    }

    // ── Focus ──
    /** Transient focus (hover): light one group's subtree — folder, spec, leaf
     *  or the whole suite — and let the rest recede. null restores the base focus. */
    highlight(id) {
      if (!this.glyphs) return;
      this._applyHot(id ? this._leavesOf(id) : this.baseFocus);
    }

    /** Persistent focus (legend filter, "show in tree"): a set of leaf ids, or null. */
    focusLeaves(set) {
      this.baseFocus = set && set.size ? set : null;
      this._applyHot(this.baseFocus);
    }

    /** Persistent focus on every leaf with one result ('failing', …), or null. */
    focusStatus(status) {
      if (!status) { this.focusLeaves(null); return; }
      this.focusLeaves(new Set((this.placements || []).filter((p) => (this.countsOf.get(p.test.id) || {})[status] > 0).map((p) => p.test.id)));
    }

    /** Hovering one leaf: brighten the sap path that feeds it, dim nothing. */
    _trace(leafId) {
      this._applyHot(this.baseFocus);
      for (const e of this.segEls.values()) {
        if (e.seg.leafIds.includes(leafId)) { e.core.classList.add('is-trace'); e.fil.classList.add('is-trace'); }
      }
    }

    _applyHot(hotLeaves) {
      if (!this.glyphs) return;
      this.world.querySelectorAll('.is-trace').forEach((n) => n.classList.remove('is-trace'));
      const isAll = !hotLeaves || hotLeaves.size >= this.placements.length;
      for (const svg of [this.world, this.glyphs]) svg.classList.toggle('tg-dimmed', !isAll);
      for (const e of this.segEls.values()) {
        const on = !isAll && e.seg.leafIds.some((x) => hotLeaves.has(x));
        for (const k of ['tint', 'core', 'fil']) e[k].classList.toggle('is-hot', on);
      }
      for (const [lid, node] of this.leafEls) node.classList.toggle('is-hot', !isAll && hotLeaves.has(lid));
      for (const [nid, node] of this.nodeEls) {
        const nd = this.nodeById.get(nid);
        node.classList.toggle('is-hot', !isAll && !!nd && nd.leafIds.some((x) => hotLeaves.has(x)));
      }
    }

    /** Leaf ids under a node id (a test, a spec, a folder, the root). */
    _leavesOf(id) {
      if (this.leafEls.has(id)) return new Set([id]);
      const nd = this.nodeById.get(id);
      if (nd) return new Set(nd.leafIds);
      if (this.tree && id === this.tree.id) return new Set(this.leafEls.keys());
      // a group without its own junction (e.g. a nested folder): walk the tree
      const node = this.TG.findById(this.tree, id);
      if (!node) return null;
      const out = new Set();
      for (const x of this.TG.walk(node)) if (x.kind === 'test') out.add(x.id);
      return out;
    }

    select(id, quiet) {
      if (!this.glyphs) return;
      this.glyphs.querySelectorAll('.is-selected').forEach((n) => n.classList.remove('is-selected'));
      const t = this.leafEls.get(id) || this.nodeEls.get(id);
      if (t) t.classList.add('is-selected');
      this.selectedId = id;
      if (!quiet && t && this.leafEls.has(id)) t.parentNode.appendChild(t);   // selected leaf draws on top
    }

    /** Where a node sits on screen (client px) — the anchor for fly-in / fly-out. */
    anchorOf(id) {
      const A = window.TREE_ANATOMY, W = A.imageWidth, H = A.imageHeight;
      let x = W / 2, y = H * 0.45;
      const nd = this.network && this.network.nodes.find((n) => n.id === id);
      if (nd) { x = nd.x; y = nd.y; }
      else { const p = this.placements && this.placements.find((q) => q.test.id === id); if (p) { x = p.x; y = p.y; } }
      const box = this.container.getBoundingClientRect();
      const k = Math.max(box.width / W, box.height / H);
      return { x: box.left + box.width / 2 + (x - W / 2) * k, y: box.top + box.height / 2 + (y - H / 2) * k };
    }

    // ── Runs ─────────────────────────────────────────────────────────
    /**
     * Begin a live run. Positions are final from the start (layout ignores
     * results); every leaf is a bud and the glass is unlit until its spec runs.
     */
    startRun(tree, mood, TG, opts) {
      this.render(tree, mood, TG, opts);
      const W = window.TREE_ANATOMY.imageWidth;
      const byId = new Map(this.placements.map((p) => [p.test.id, p]));
      const specOf = new Map(this.placements.map((p) => [p.test.id, p.spec.id]));
      // a test drawn inside a pod lives in its file's pod
      const podOf = new Map();
      const live = new Map();          // pod id → live counts
      for (const p of this.placements) if (p.test.kind === 'pod') {
        for (const t of p.test.tests) podOf.set(t.id, p.test.id);
        live.set(p.test.id, { passing: 0, failing: 0, flaky: 0, skipped: 0, pending: p.test.tests.length, done: 0 });
      }
      const running = new Set(), done = new Set();
      this.glyphs.classList.add('tg-running');
      this.glyphs.querySelector('.tg-nodes').classList.add('tg-hidden');
      const place = (p, v) => ({ x: p.x, y: p.y, rotate: p.rotate, scale: p.scale / v.scale,
        wind: { delay: -(p.x / W) * 2.4, dur: 7 }, hover: this.hoverScale.get(p.test.id) });
      const replace = (id, fresh) => { this.leafLayer.replaceChild(fresh, this.leafEls.get(id)); this.leafEls.set(id, fresh); };
      const swapLeaf = (id, test) => {
        const p = byId.get(id);
        if (!p || !this.leafEls.get(id)) return;
        const v = L().leafVisual(test);
        replace(id, L().drawLeaf(this.leafLayer, v, place(p, v)));
      };
      const fillPod = (podId) => {          // the pod fills with results as its tests finish
        const p = byId.get(podId), c = live.get(podId);
        const v = { ...L().podVisual(p.test), counts: c, ruptured: false };
        v.status = c.failing ? 'failing' : c.flaky ? 'flaky' : c.done ? 'passing' : 'pending';
        replace(podId, L().drawPod(this.leafLayer, v, place(p, v)));
      };
      for (const p of this.placements) {
        if (p.test.kind === 'pod') fillPod(p.test.id);
        else swapLeaf(p.test.id, { ...p.test, status: 'pending' });
      }
      const pulseOf = new Map();
      const refresh = (specId) => {
        for (const e of this.segEls.values()) {
          if (specId && !e.seg.leafIds.some((id) => specOf.get(id) === specId)) continue;
          const isLive = e.seg.leafIds.some((id) => running.has(specOf.get(id)));
          const finished = e.seg.leafIds.every((id) => done.has(id));
          this._paintSeg(e, isLive ? 'running' : finished ? this._segStatus(e.seg) : 'idle');
          // sap flows only through branches feeding a running spec
          if (isLive && !pulseOf.has(e.seg.id)) {
            if (e.litMid) pulseOf.set(e.seg.id, el('path', { class: 'tg-pulse', d: e.litMid, fill: 'none', stroke: LIGHT.pending.core,
              'stroke-width': Math.max(1.4, Math.min(4, e.pts[0].r * 0.5)), 'stroke-linecap': 'round',
              'stroke-dasharray': '5 31', style: `animation-delay:${(-(e.pts[0].y % 36) / 33).toFixed(2)}s` }, this.pulseLayer));
          } else if (!isLive && pulseOf.has(e.seg.id)) { pulseOf.get(e.seg.id).remove(); pulseOf.delete(e.seg.id); }
        }
      };
      refresh(null);
      const counts = { passing: 0, failing: 0, flaky: 0, skipped: 0, pending: 0 };
      const total = [...this.countsOf.values()].reduce((n, c) => n + Object.values(c).reduce((a, b) => a + b, 0), 0);
      let finishedTests = 0;
      const seen = new Set();
      const progress = () => opts && opts.onProgress && opts.onProgress({ ...counts }, finishedTests, total);
      const session = {
        specStarted: (specId) => { running.add(specId); refresh(specId); },
        testFinished: (test) => {
          if (seen.has(test.id)) return;
          seen.add(test.id);
          finishedTests++;
          counts[test.status] = (counts[test.status] || 0) + 1;
          const podId = podOf.get(test.id);
          if (podId) {
            const c = live.get(podId);
            c.pending--; c.done++; c[test.status] = (c[test.status] || 0) + 1;
            if (!c.pending) done.add(podId);
            fillPod(podId);
          } else {
            done.add(test.id);
            swapLeaf(test.id, test);
          }
          progress();
        },
        specFinished: (specId) => { running.delete(specId); refresh(specId); },
        finish: () => { this._cancelAnimation(); this.render(tree, mood, TG, opts); },
        specs: [...new Set(this.placements.map((p) => p.spec.id))],
      };
      return session;
    }

    /**
     * Demo run: plays results through a session the way Playwright would —
     * spec files spread over parallel workers, each test finishing in turn.
     */
    runAnimation(tree, mood, TG, opts, onDone) {
      const run = this.startRun(tree, mood, TG, opts);
      const specs = new Map();
      for (const p of this.placements) {
        const s = specs.get(p.spec.id) || specs.set(p.spec.id, { id: p.spec.id, tests: [] }).get(p.spec.id);
        s.tests.push(...(p.test.kind === 'pod' ? p.test.tests : [p.test]));
      }
      const WORKERS = 4, TOTAL = 6200;
      const dur = (t) => Math.max(120, (t.metadata && t.metadata.duration) || 600);
      const lanes = Array.from({ length: WORKERS }, () => 0);
      const plan = [];
      for (const s of specs.values()) {             // next free worker takes the next file
        const w = lanes.indexOf(Math.min(...lanes));
        const start = lanes[w];
        const total = s.tests.reduce((n, t) => n + dur(t), 0);
        lanes[w] += total;
        plan.push({ s, start, total });
      }
      const k = TOTAL / Math.max(...lanes);
      const at = (ms, fn) => this._timers.push(setTimeout(fn, 350 + ms * k));
      for (const { s, start, total } of plan) {
        at(start, () => run.specStarted(s.id));
        let t = start;
        for (const test of s.tests) { t += dur(test); at(t, () => run.testFinished(test)); }
        at(start + total + 1, () => run.specFinished(s.id));
      }
      at(Math.max(...lanes) + 500 / k, () => { run.finish(); if (onDone) onDone(); });
      return run;
    }

    _cancelAnimation() { this._timers.forEach(clearTimeout); this._timers = []; }

    /** Which part of the painting is on screen ('slice'), and where the UI sits, in painting coords. */
    viewInPainting(W, H, avoidEls) {
      const box = this.container.getBoundingClientRect();
      const cw = box.width || W, ch = box.height || H;
      const k = Math.max(cw / W, ch / H);
      const vw = cw / k, vh = ch / k;
      const ox = (W - vw) / 2, oy = (H - vh) / 2;
      const toPaint = (r) => ({ x0: ox + (r.left - box.left) / k, y0: oy + (r.top - box.top) / k,
                                x1: ox + (r.right - box.left) / k, y1: oy + (r.bottom - box.top) / k });
      return { bounds: { x0: ox, y0: oy, x1: ox + vw, y1: oy + vh },
               avoid: avoidEls.filter(Boolean).filter((e) => e.offsetParent !== null || e.getClientRects().length)
                 .map((e) => toPaint(e.getBoundingClientRect())) };
    }
  }

  window.TreeImageRenderer = TreeImageRenderer;
})();
