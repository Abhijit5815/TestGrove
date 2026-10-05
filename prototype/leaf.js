/**
 * TestGrove — Glass Leaf (v0.5)
 *
 * One leaf = one test. This module owns how a leaf LOOKS.
 *
 * Colour language (deep at the stem → luminous at the edges, like thick
 * coloured glass catching light along its rim):
 *
 *   passing  FRESH      deep forest green at the stem → luminous emerald edges
 *   failing  WITHERED   deep burgundy → sharp crimson; curled, jagged, cracked
 *   flaky    TURNING    warm amber, quieter than pass/fail; lit on one half only
 *   skipped  DORMANT    muted slate, hollow (outline only), faint
 *   pending  BUD        small, closed, a sweep of pale light passes through
 *
 * No neon halos. A leaf draws the eye by colour, shape and a crisp edge light
 * — failing leaves by withering, not by glowing. Flaky and skipped leaves sit
 * at lower luminance so they never compete with failures.
 *
 * Every status also has its own SHAPE, so it reads without colour vision:
 *   passing smooth · failing jagged + cracked · flaky split-lit · skipped
 *   hollow dashed · pending closed bud.
 *
 * API
 *   leafVisual(test)                 pure: test result → visual parameters
 *   installLeafDefs(svg | document)  gradients + clips (once per document)
 *   drawLeaf(parent, visual, {x, y, rotate, scale, wind?, hover?})
 *   legendIcon(status, size)         the same leaf as a tiny inline <svg> string
 *
 * Local coordinates: anchor (0,0) is where the stem meets the branch; the
 * blade hangs toward +y, tip at (0,48).
 */
(function () {
  const NS = 'http://www.w3.org/2000/svg';

  // ── Palettes ─────────────────────────────────────────────────────
  // deep: at the stem · mid: body · bright: toward the edges · rim: light
  // caught in the glass edge · vein: light channels · alpha: overall presence
  const PALETTE = {
    passing: { deep: '#073A20', mid: '#128C4F', bright: '#2DD482', rim: '#9BFFC9', vein: '#C2FFE0', alpha: 0.96 },
    failing: { deep: '#2E040C', mid: '#7A0C20', bright: '#D81E37', rim: '#FF6E7C', vein: '#FFC2C8', alpha: 0.97 },
    flaky:   { deep: '#46280A', mid: '#8A5A12', bright: '#D08E2A', rim: '#FFC777', vein: '#FFE3B0', alpha: 0.88 },
    skipped: { deep: '#1E252D', mid: '#3B4651', bright: '#6E7B88', rim: '#AAB5C0', vein: '#C9D2DB', alpha: 0.62 },
    pending: { deep: '#2B4A66', mid: '#7EA6CC', bright: '#CFE6FF', rim: '#FFFFFF', vein: '#FFFFFF', alpha: 0.95 },
  };

  // ── Geometry ─────────────────────────────────────────────────────
  // An elongated, gently asymmetric blade with a drip tip — a linden/birch
  // leaf, not an icon.
  const OUTLINE =
    'M 0 6 C -6 8 -10.5 14 -10.8 21 C -11 28 -7 35 -3 40.5 C -1.6 42.6 -0.6 45 0 48 ' +
    'C 0.9 44.8 2.2 42.4 3.6 40.4 C 7.8 34.6 11.4 27.4 10.9 20.4 C 10.4 13.6 6.2 8.2 0 6 Z';
  // The shadow side of the fold (right half, closed along the midrib)
  const HALF_R =
    'M 0 6 C 6.2 8.2 10.4 13.6 10.9 20.4 C 11.4 27.4 7.8 34.6 3.6 40.4 C 2.2 42.4 0.9 44.8 0 48 Z';
  const PETIOLE = 'M -0.45 0 C -0.3 2 -0.5 4 -0.95 6.6 L 0.95 6.6 C 0.5 4 0.3 2 0.45 0 Z';
  const MIDRIB = 'M -0.7 6.4 C -0.42 20 -0.18 34 0 47 C 0.18 34 0.42 20 0.7 6.4 Z';
  const VEINS = [
    'M -0.2 12 C -3 13 -6 14.6 -8.6 17.6',
    'M 0.2 15 C 3.2 16 6.4 17.8 8.9 21',
    'M -0.15 19 C -3.4 20.2 -6.6 22.4 -9.3 25.8',
    'M 0.15 22 C 3.2 23.4 6.2 25.8 8.4 29.2',
    'M -0.1 26 C -3 27.4 -5.6 29.8 -7.6 33',
    'M 0.1 29 C 2.6 30.6 4.8 32.8 6.2 35.6',
    'M -0.05 33 C -1.8 34.4 -3.2 36.2 -4.2 38.4',
    'M 0.05 36 C 1.4 37.4 2.4 39 3 40.8',
  ];
  // Collision profile: [y along midrib, blade half-width] sampled from OUTLINE.
  // Placement covers the blade with circles of these radii (× turnX).
  const COLLIDER = [[5, 1.3], [9, 4.6], [12.5, 7.4], [16, 9.6], [19.5, 10.7], [23, 10.9], [26.5, 10.4],
                    [30, 9.2], [33.5, 7.6], [37, 5.6], [40.5, 3.4], [44, 1.9], [47, 0.8]];
  // Withering: a real fracture through the blade, and the blade curls in.
  const CRACK = 'M -7.2 16.4 C -6.4 17.6 -5.8 18.4 -5.1 19.8 L -4.3 21.6 C -3.6 23 -3.1 23.8 -2.3 25.4 L -1.6 27.6 C -1.1 28.8 -0.8 29.6 -0.3 31';
  const CRACK_BRANCH = 'M -5.1 19.8 C -3.9 19.9 -3.1 20.4 -2.4 21.4 M -2.3 25.4 C -3.2 26.2 -3.8 27.1 -4.2 28.4';
  const WILT = 'translate(0 1) scale(0.86 0.92)';

  // ── Deterministic noise ──────────────────────────────────────────
  function hash01(str, salt) {
    let h = 0x811c9dc5 ^ (salt || 0);
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return ((h >>> 0) % 100000) / 100000;
  }

  function el(tag, attrs, parent) {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) if (attrs[k] !== undefined && attrs[k] !== null) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }

  // ── leafVisual: test result → visual parameters (pure) ────────────
  /**
   * @param test { id, status, metadata?: { duration?, retryCount?, flakinessScore? } }
   * @returns plain object — everything drawLeaf needs, nothing it has to infer.
   */
  function leafVisual(test) {
    const status = PALETTE[test.status] ? test.status : 'pending';
    const md = test.metadata || {};
    const n = (salt) => hash01(String(test.id), salt);

    // GEOMETRY depends only on the test's identity — never its result or
    // duration — so a leaf keeps the same place, size and angle every run.
    const base = {
      id: String(test.id),
      status,
      palette: PALETTE[status],
      scale: 0.94 + (n(2) - 0.5) * 0.16,
      lift: 40 + Math.pow(n(6), 0.85) * 115,      // preferred pose (deg from hanging)
      turnX: 0.5 + n(7) * 0.5,                     // 3D turn: 1 face-on … 0.5 edge-on
      side: n(12) < 0.72 ? 1 : -1,                 // 1 = grow outward (preferred)
      sway: 1.6 + n(3) * 1.4,
      swayDelay: -n(4) * 7,
      hue: (n(8) - 0.5) * 14,                      // natural variety, never a status shift
      bright: 0.93 + n(9) * 0.12,
      // APPEARANCE defaults (status overrides below)
      veinLight: 0.7, lit: true,
      wilt: false, brokenVeins: false, jagged: false, hollow: false,
      turn: 0, turnLevel: 0, bud: false, splitLight: false,
    };

    switch (status) {
      case 'passing':
        return base;
      case 'flaky': {
        const retries = md.retryCount || 1;
        const turn = Math.min(1, md.flakinessScore != null ? md.flakinessScore : 0.2 + retries * 0.2);
        const turnLevel = turn >= 0.75 ? 3 : turn >= 0.5 ? 2 : 1;
        return { ...base, turn, turnLevel, veinLight: 0.55, hue: base.hue * 0.3, splitLight: true };
      }
      case 'failing':
        return { ...base, veinLight: 0.4, wilt: true, brokenVeins: true, jagged: true, hue: base.hue * 0.25 };
      case 'skipped':
        return { ...base, veinLight: 0.3, lit: false, hollow: true, hue: 0 };
      default: // pending / running
        return { ...base, bud: true, veinLight: 0.5, hue: 0 };
    }
  }

  /** Jagged (crumpled) outline for failing leaves, always INSIDE the normal
   *  blade, built from the collider's width profile with alternating insets. */
  const JAGGED = (() => {
    const prof = [[6, 0], [9, 4.6], [12.5, 7.4], [16, 9.6], [19.5, 10.7], [23, 10.9], [26.5, 10.4],
                  [30, 9.2], [33.5, 7.6], [37, 5.6], [40.5, 3.4], [44, 1.9], [48, 0]];
    const hw = (y) => {
      for (let i = 1; i < prof.length; i++) if (y <= prof[i][0]) {
        const [y0, w0] = prof[i - 1], [y1, w1] = prof[i]; return w0 + (w1 - w0) * (y - y0) / (y1 - y0);
      }
      return 0;
    };
    const L = [], R = [];
    let k = 0;
    for (let y = 7; y <= 47; y += 2.2, k++) {
      const inset = k % 2 ? 0.74 : 0.97;
      L.push(`${(-hw(y) * inset).toFixed(2)} ${y.toFixed(2)}`);
      R.push(`${(hw(y) * (k % 2 ? 0.97 : 0.74)).toFixed(2)} ${y.toFixed(2)}`);
    }
    return `M 0 6 L ${L.join(' L ')} L 0 47.6 L ${R.reverse().join(' L ')} Z`;
  })();

  // ── Shared defs ───────────────────────────────────────────────────
  // userSpaceOnUse gradients and clips are in LEAF-LOCAL coordinates, so one
  // set of definitions serves every leaf wherever it hangs — and every legend
  // icon in the page, which reference the same ids.
  const STYLE = `
    .tgl { cursor: pointer; pointer-events: visiblePainted; }
    .tgl-lift { transition: transform .18s cubic-bezier(.2,.7,.2,1), filter .18s ease; transform-box: view-box; transform-origin: 0 0; }
    .tgl:hover .tgl-lift, .tgl.is-hot .tgl-lift { transform: scale(var(--tgl-hover, 1)); filter: brightness(1.12) saturate(1.08); }
    .tgl-select { opacity: 0; transition: opacity .2s ease; }
    .tgl.is-selected .tgl-select { opacity: 1; }
    .tg-dimmed .tgl:not(.is-hot) { opacity: .28; transition: opacity .25s ease; }
    .tgl { transition: opacity .25s ease; }
    @media (prefers-reduced-motion: no-preference) {
      .tgl-sway { animation: tgl-sway var(--tgl-dur, 7s) ease-in-out infinite; transform-origin: 0 0; }
      .tgl-bud-shimmer { animation: tgl-shimmer 2.4s linear infinite; }
    }
    @keyframes tgl-sway { 0%,100% { transform: rotate(calc(var(--tgl-amp) * -1)); } 50% { transform: rotate(var(--tgl-amp)); } }
  `;

  function installInto(svg) {
    const defs = el('defs', { id: 'tgl-defs' }, svg);
    const U = { gradientUnits: 'userSpaceOnUse' };

    // Body: deep at the stem, opening to the bright body colour toward the
    // tip and the far edges.
    for (const [st, P] of Object.entries(PALETTE)) {
      const g = el('radialGradient', { id: `tgl-body-${st}`, ...U, cx: 0, cy: 9, r: 42, fx: 0, fy: 5 }, defs);
      const a = st === 'skipped' ? 0.32 : 1;
      [[0, P.deep, 0.98 * a], [0.28, P.mid, 0.95 * a], [0.62, P.bright, 0.93 * a], [1, P.bright, 0.95 * a]]
        .forEach(([o, c, op]) => el('stop', { offset: o, 'stop-color': c, 'stop-opacity': op }, g));
      // Edge light: the thick glass rim catches light — brightest on the lit
      // (upper-left) side, fading toward the shadow side.
      const r = el('linearGradient', { id: `tgl-rim-${st}`, ...U, x1: -11, y1: 6, x2: 11, y2: 46 }, defs);
      [[0, 1], [0.5, 0.75], [1, 0.35]].forEach(([o, op]) => el('stop', { offset: o, 'stop-color': P.rim, 'stop-opacity': op }, r));
    }

    // Fold: the right half sits in shadow, darkest at the midrib crease.
    const fold = el('linearGradient', { id: 'tgl-fold', ...U, x1: 0, y1: 0, x2: 11, y2: 0 }, defs);
    el('stop', { offset: 0, 'stop-color': '#000', 'stop-opacity': 0.34 }, fold);
    el('stop', { offset: 0.6, 'stop-color': '#000', 'stop-opacity': 0.12 }, fold);
    el('stop', { offset: 1, 'stop-color': '#000', 'stop-opacity': 0.0 }, fold);

    // Specular sheen
    const sheen = el('radialGradient', { id: 'tgl-sheen' }, defs);
    el('stop', { offset: 0, 'stop-color': '#fff', 'stop-opacity': 0.7 }, sheen);
    el('stop', { offset: 1, 'stop-color': '#fff', 'stop-opacity': 0 }, sheen);

    // Bud shimmer: a pale band sweeping along the blade
    const shimmer = el('linearGradient', { id: 'tgl-shimmer', ...U, x1: 0, y1: 0, x2: 0, y2: 48 }, defs);
    [[0, 0], [0.42, 0], [0.5, 0.9], [0.58, 0], [1, 0]].forEach(([o, a]) =>
      el('stop', { offset: o, 'stop-color': '#fff', 'stop-opacity': a }, shimmer));
    el('animateTransform', { attributeName: 'gradientTransform', type: 'translate',
      values: '0 -48; 0 48', dur: '2.4s', repeatCount: 'indefinite' }, shimmer);

    // Clips: the edge light is a stroke clipped to the blade → an INNER rim
    // (never outside the blade, so it can't make a leaf touch its neighbour).
    const c1 = el('clipPath', { id: 'tgl-clip-smooth', clipPathUnits: 'userSpaceOnUse' }, defs);
    el('path', { d: OUTLINE }, c1);
    const c2 = el('clipPath', { id: 'tgl-clip-jagged', clipPathUnits: 'userSpaceOnUse' }, defs);
    el('path', { d: JAGGED }, c2);
    const c3 = el('clipPath', { id: 'tgp-clip', clipPathUnits: 'userSpaceOnUse' }, defs);
    el('path', { d: POD_BULB }, c3);
    // Pod liquid: rounder in the middle (a glass cylinder of light)
    for (const k of LIQUID) {
      const P = PALETTE[k];
      const lg = el('linearGradient', { id: `tgp-liquid-${k}`, ...U, x1: -8.6, y1: 0, x2: 8.6, y2: 0 }, defs);
      [[0, P.deep], [0.32, P.bright], [0.6, P.bright], [1, P.mid]].forEach(([o, col]) => el('stop', { offset: o, 'stop-color': col }, lg));
    }

    el('style', { 'data-tgl': '1' }, svg).textContent = STYLE;
  }

  /**
   * Install the shared leaf defs. Pass a document to install once into a
   * hidden host <svg> that every leaf and legend icon in the page can use.
   */
  function installLeafDefs(target) {
    const doc = target && target.nodeType === 9 ? target : null;
    if (doc) {
      if (doc.getElementById('tgl-defs')) return;
      const host = doc.createElementNS(NS, 'svg');
      host.setAttribute('id', 'tgl-defs-host');
      host.setAttribute('width', '0');
      host.setAttribute('height', '0');
      host.setAttribute('aria-hidden', 'true');
      host.style.position = 'absolute';
      host.style.width = '0';
      host.style.height = '0';
      host.style.overflow = 'hidden';
      doc.body.appendChild(host);
      installInto(host);
      return;
    }
    if (!target.querySelector('#tgl-defs') && !document.getElementById('tgl-defs')) installInto(target);
  }

  // ── drawLeaf ─────────────────────────────────────────────────────
  /**
   * @param parent  <g> or <svg>
   * @param v       result of leafVisual()
   * @param place   { x, y, rotate (deg, 0 = hanging straight down), scale,
   *                  wind?: {delay, dur}, hover?: max lift scale (never overlaps) }
   */
  function drawLeaf(parent, v, place) {
    const p = v.palette;
    const s = (place.scale || 1) * v.scale;
    const rot = place.rotate || 0;

    const g = el('g', {
      class: `tgl tgl-${v.status}`,
      'data-node-id': v.id,
      transform: `translate(${place.x.toFixed(2)} ${place.y.toFixed(2)}) rotate(${rot.toFixed(2)}) scale(${s.toFixed(3)})`,
      style: `--tgl-hover:${(place.hover || 1.12).toFixed(3)}`,
    }, parent);
    const sway = el('g', {
      class: 'tgl-sway',
      style: place.wind
        ? `--tgl-amp:1.4deg; --tgl-dur:${place.wind.dur}s; animation-delay:${place.wind.delay.toFixed(2)}s`
        : `--tgl-amp:${v.sway.toFixed(2)}deg; --tgl-dur:${(6 + (v.sway % 1) * 3).toFixed(2)}s; animation-delay:${v.swayDelay.toFixed(2)}s`,
    }, g);
    const lift = el('g', { class: 'tgl-lift' }, sway);

    // Stem first — it stays straight even when the blade curls.
    el('path', { d: PETIOLE, fill: v.lit ? p.mid : p.bright, opacity: v.lit ? 0.9 : 0.5 }, lift);

    let t = el('g', {
      transform: `scale(${v.turnX.toFixed(3)} 1)`,
      opacity: p.alpha,
      style: v.hue || v.bright !== 1 ? `filter: hue-rotate(${v.hue.toFixed(1)}deg) brightness(${v.bright.toFixed(3)})` : null,
    }, lift);
    if (v.wilt) t = el('g', { transform: WILT }, t);
    if (v.bud) t = el('g', { transform: 'translate(0 2) scale(0.62 0.58)' }, t);

    const shape = v.jagged ? JAGGED : OUTLINE;
    const clip = v.jagged ? 'url(#tgl-clip-jagged)' : 'url(#tgl-clip-smooth)';

    // 1. Glass body: deep at the stem → bright toward the edges
    el('path', { class: 'tgl-body', d: shape, fill: `url(#tgl-body-${v.status})` }, t);

    // 2. Fold shadow on the right half. Flaky leaves are SPLIT: one half lit,
    //    the other dark — a shape cue that reads without colour vision.
    el('path', { d: HALF_R, fill: 'url(#tgl-fold)' }, t);
    if (v.splitLight) el('path', { d: HALF_R, fill: '#120a00', opacity: 0.5 }, t);

    // 3. Veins — light channels from the stem
    const veins = el('g', { class: 'tgl-veins', opacity: v.veinLight }, t);
    el('path', { d: MIDRIB, fill: p.vein, opacity: v.lit ? 0.8 : 0.5 }, veins);
    VEINS.forEach((d, i) => {
      if (v.brokenVeins && i % 3 === 1) return;                   // withered: some veins dead
      el('path', { d, fill: 'none', stroke: p.vein, 'stroke-width': 0.42 - (i >> 1) * 0.04,
        'stroke-linecap': 'round', opacity: 0.55 - (i >> 1) * 0.08 }, veins);
    });

    // 4. Fracture (withering): a crisp pale crack
    if (v.status === 'failing') {
      el('path', { d: CRACK, fill: 'none', stroke: '#FFE3E6', 'stroke-width': 0.34, opacity: 0.85,
        'stroke-linecap': 'round' }, t);
      el('path', { d: CRACK_BRANCH, fill: 'none', stroke: '#FFE3E6', 'stroke-width': 0.22, opacity: 0.6,
        'stroke-linecap': 'round' }, t);
    }

    // 5. Edge light — an inner rim, crisp, brightest on the lit side
    if (!v.hollow) {
      el('path', { class: 'tgl-rim', d: shape, fill: 'none', stroke: `url(#tgl-rim-${v.status})`,
        'stroke-width': 2.2, 'clip-path': clip, opacity: v.status === 'flaky' ? 0.8 : 0.95 }, t);
    } else {
      el('path', { d: shape, fill: 'none', stroke: p.rim, 'stroke-width': 0.85, opacity: 0.8,
        'stroke-dasharray': '3 1.6' }, t);
    }

    // 6. Specular sheen on the lit half
    el('ellipse', { cx: -5.4, cy: 15.5, rx: 1.6, ry: 5.4, fill: 'url(#tgl-sheen)',
      transform: 'rotate(16 -5.4 15.5)', opacity: v.lit ? 0.55 : 0.4 }, t);

    // 7. Bud shimmer
    if (v.bud) el('path', { d: shape, fill: 'url(#tgl-shimmer)' }, t);

    // Selection: a bright rim ON the leaf's own outline (never outside it)
    el('path', { class: 'tgl-select', d: shape, fill: 'none', stroke: '#fff', 'stroke-width': 1.4,
      'clip-path': clip }, t);

    return g;
  }

  // ── Pod: one spec FILE, when a scope is too big to show every leaf ──
  // A hanging glass bulb filled with its results as liquid layers — failing at
  // the bottom, then flaky, then passing; skipped/pending leave the glass empty.
  // Layer ORDER carries the status as well as colour (reads without colour
  // vision); a star-cut stopper marks any failure, like the junction knots.
  // Pods are not leaves: double-click one to fly into the file and see a leaf
  // per test.
  const POD_BULB = 'M 0 6.5 C 3.6 7 8.6 10.6 8.6 15.6 C 8.6 20.6 4.7 24 0 24 C -4.7 24 -8.6 20.6 -8.6 15.6 C -8.6 10.6 -3.6 7 0 6.5 Z';
  const POD_COLLIDER = [[2.5, 1.2], [6.5, 3.2], [9.5, 6.4], [13, 8.5], [16.5, 8.7], [20, 7.3], [23, 4.2]];
  const LIQUID = ['failing', 'flaky', 'passing'];

  /** Pure: a pod's visual parameters. Geometry depends only on the file's identity and size. */
  function podVisual(pod) {
    const counts = { passing: 0, failing: 0, flaky: 0, skipped: 0, pending: 0 };
    for (const t of pod.tests) counts[PALETTE[t.status] ? t.status : 'pending']++;
    const n = pod.tests.length;
    const id = String(pod.id);
    const h = (salt) => hash01(id, salt);
    return {
      id, kind: 'pod', counts, n,
      status: counts.failing ? 'failing' : counts.flaky ? 'flaky' : counts.pending === n ? 'pending'
        : counts.skipped === n ? 'skipped' : 'passing',
      ruptured: n >= 2 && counts.failing > 0 && counts.failing + counts.skipped === n,
      scale: 0.85 + Math.min(0.8, Math.log2(Math.max(1, n)) * 0.12),   // a fuller file hangs a bigger pod
      lift: 6 + h(6) * 26, maxLift: 100, turnX: 1, side: h(12) < 0.5 ? 1 : -1,
      sway: 1 + h(3), swayDelay: -h(4) * 7,
    };
  }

  function drawPod(parent, v, place) {
    const s = (place.scale || 1) * v.scale;
    const c = v.counts;
    const g = el('g', {
      class: `tgl tgp tgp-${v.status}${v.ruptured ? ' tgp-ruptured' : ''}`,
      'data-node-id': v.id,
      'data-counts': [c.passing, c.failing, c.flaky, c.skipped, c.pending].join(','),
      transform: `translate(${place.x.toFixed(2)} ${place.y.toFixed(2)}) rotate(${(place.rotate || 0).toFixed(2)}) scale(${s.toFixed(3)})`,
      style: `--tgl-hover:${(place.hover || 1.1).toFixed(3)}`,
    }, parent);
    const sway = el('g', { class: 'tgl-sway', style: place.wind
      ? `--tgl-amp:1deg; --tgl-dur:${place.wind.dur}s; animation-delay:${place.wind.delay.toFixed(2)}s` : null }, g);
    const lift = el('g', { class: 'tgl-lift' }, sway);
    el('path', { d: 'M -0.5 0 C -0.4 2.5 -0.6 4.8 -0.9 7 L 0.9 7 C 0.6 4.8 0.4 2.5 0.5 0 Z', fill: '#C9D3DC', opacity: 0.8 }, lift);
    const body = el('g', { 'clip-path': 'url(#tgp-clip)' }, lift);
    el('path', { d: POD_BULB, fill: v.ruptured ? '#2a1418' : '#DDE7F0', opacity: v.ruptured ? 0.55 : 0.12 }, body);
    // liquid fills at most 82% of the bulb, so the glass always shows above it
    const bottom = 24, span = (bottom - 7.2) * 0.82;
    let y = bottom;
    const liquid = el('g', { opacity: 0.86 }, body);
    for (const k of LIQUID) {
      if (!c[k]) continue;
      const hgt = (span * c[k]) / Math.max(1, v.n);
      el('rect', { x: -9, y: (y - hgt).toFixed(2), width: 18, height: (hgt + 0.06).toFixed(2), fill: `url(#tgp-liquid-${k})` }, liquid);
      y -= hgt;
    }
    if (y < bottom - 0.3) el('rect', { x: -9, y: (y - 0.25).toFixed(2), width: 18, height: 0.5, fill: '#fff', opacity: 0.6 }, body);
    el('path', { d: POD_BULB, fill: 'none', stroke: '#05070a', 'stroke-width': 2.4, opacity: 0.3 }, body);   // glass thickness
    el('path', { d: POD_BULB, fill: 'none', stroke: '#F2F7FF', 'stroke-width': 0.8, opacity: 0.85 }, lift);
    el('ellipse', { cx: -4.1, cy: 12.6, rx: 1.5, ry: 3.6, fill: 'url(#tgl-sheen)', transform: 'rotate(20 -4.1 12.6)', opacity: 0.85 }, lift);
    if (c.failing) {
      const pts = [];
      for (let i = 0; i < 10; i++) { const a = (i / 10) * Math.PI * 2 - Math.PI / 2, r = i % 2 ? 1.2 : 2.6;
        pts.push(`${(Math.cos(a) * r).toFixed(2)},${(7 + Math.sin(a) * r).toFixed(2)}`); }
      el('polygon', { points: pts.join(' '), fill: PALETTE.failing.bright, stroke: '#FFE3E6', 'stroke-width': 0.4 }, lift);
    }
    if (v.ruptured) el('path', { d: 'M -7 13 L -2.6 15.4 L -0.4 12.4 L 3.4 16.8 L 7.6 14.6', fill: 'none', stroke: '#FFB3BC', 'stroke-width': 0.6 }, lift);
    el('path', { class: 'tgl-select', d: POD_BULB, fill: 'none', stroke: '#fff', 'stroke-width': 1.4 }, lift);
    return g;
  }

  /** The leaf as a tiny standalone <svg> string (legend, list rows). */
  function legendIcon(status, size) {
    const v = leafVisual({ id: 'legend', status });
    const z = size || 16;
    const p = v.palette;
    const shape = v.jagged ? JAGGED : OUTLINE;
    const body = v.hollow
      ? `<path d="${shape}" fill="${p.bright}" fill-opacity=".22" stroke="${p.rim}" stroke-width="2.2" stroke-dasharray="5 3"/>`
      : `<path d="${shape}" fill="url(#tgl-body-${status})"/>` +
        (v.splitLight ? `<path d="${HALF_R}" fill="#120a00" opacity=".55"/>` : '') +
        `<path d="${MIDRIB}" fill="${p.vein}" opacity=".7"/>` +
        (status === 'failing' ? `<path d="${CRACK}" fill="none" stroke="#FFE3E6" stroke-width=".9"/>` : '') +
        `<path d="${shape}" fill="none" stroke="${p.rim}" stroke-width="1.6" opacity=".9"/>`;
    const tf = v.bud ? 'translate(0 8) scale(.7)' : v.wilt ? 'translate(0 2) scale(.92)' : '';
    return `<svg class="tg-icon tg-icon-${status}" width="${z}" height="${z}" viewBox="-24 2 48 48" aria-hidden="true">` +
      `<g transform="rotate(-38 0 26) ${tf}">${body}</g></svg>`;
  }

  window.TestGroveLeaf = { leafVisual, installLeafDefs, drawLeaf, legendIcon, podVisual, drawPod,
                           PALETTE, COLLIDER, OUTLINE, JAGGED, POD_COLLIDER };
})();
