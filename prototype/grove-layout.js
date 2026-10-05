/**
 * TestGrove — Grove Layout (pure; no DOM)
 *
 * Decides WHERE everything goes. Rendering lives in tree-renderer.js and
 * leaf.js; this module only does geometry, so it runs in Node tests too.
 *
 *  1. STRUCTURE → SPACE
 *     Top-level folders own contiguous sectors of the canopy (left → right),
 *     sized by their test count. Spec files own sub-sectors inside their
 *     folder. A leaf grows inside its spec's sector. Failures therefore show
 *     up exactly where they live in the codebase, mixed with passes.
 *
 *  2. STABILITY
 *     Placement depends only on the test list, never on results. A leaf keeps
 *     the same place every run, so the tree works as a map.
 *
 *  3. NO OVERLAP (hard rule)
 *     Leaves never overlap each other, never lie across the tree body, never
 *     leave the visible painting, never hide under UI. Leaves shrink together
 *     if a suite doesn't fit — every test always gets its leaf.
 *
 *  4. VASCULAR NETWORK
 *     Sap paths run from the trunk base along the real branches (the painted
 *     tree's body mask) to every leaf. Paths share vessels until they diverge,
 *     so the network IS a tree: each vessel carries the leaves downstream of it.
 *
 *  5. JUNCTIONS
 *     A folder's / spec's node sits where its sap paths last share a vessel —
 *     the real branching point that feeds exactly that group.
 */
(function (root) {
  // ── Tunables ─────────────────────────────────────────────────────
  const LEAF_BASE_SCALE = 1.05;   // blade ≈ 50px on the 1376px painting
  const MARGIN = 2.0;             // gap between leaves at full size (px), scales down, min 1
  const SHRINK = 0.9;
  const MAX_ATTEMPTS = 14;
  const TREE_GRAZE = 0.12;        // blade may graze the tree by this fraction of its half-width
  const ATTACH_RADIUS = 12;       // px around the attachment point exempt from the tree check
  const LIFT_MIN = 30, LIFT_MAX = 160;
  const SNAP_WINDOW = 0.3;        // a sector boundary may move this share of the smaller sector to reach a real fork
  const HOVER_MAX = 1.2;          // hover lift: at most this much bigger, and never touching anything

  // ── Helpers ──────────────────────────────────────────────────────
  function hash01(str, salt) {
    let h = 0x811c9dc5 ^ (salt || 0);
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return ((h >>> 0) % 100000) / 100000;
  }

  function decodeB64(s) {
    if (typeof atob === 'function') {
      const bin = atob(s); const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return new Uint8Array(Buffer.from(s, 'base64'));
  }

  const _fields = new WeakMap();
  /** Decoded clearance field for a mood: { cell, w, h, data } (0 = tree body). */
  function fieldOf(mood) {
    if (!mood || !mood.clearance) return null;
    let f = _fields.get(mood);
    if (!f) {
      const c = mood.clearance;
      f = { cell: c.cell, w: c.w, h: c.h, data: decodeB64(c.data), axis: null };
      if (c.axis) {                       // packed bits, row-major, MSB first
        const bits = decodeB64(c.axis), N = c.w * c.h, axis = new Uint8Array(N);
        for (let k = 0; k < N; k++) axis[k] = (bits[k >> 3] >> (7 - (k & 7))) & 1;
        f.axis = axis;
      }
      _fields.set(mood, f);
    }
    return f;
  }
  function clearanceAt(f, x, y) {
    const i = Math.floor(x / f.cell), j = Math.floor(y / f.cell);
    if (i < 0 || j < 0 || i >= f.w || j >= f.h) return 0;            // outside the painting: never
    return f.data[j * f.w + i];
  }

  // ── Collision shape (status-independent) ─────────────────────────
  /** World-space circles covering a leaf blade. Every status's drawing fits inside. */
  function leafCircles(collider, v, x, y, rotateDeg, scale) {
    const r = (rotateDeg * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
    const out = [];
    for (const [ly, hw0] of collider) {
      const hw = Math.max(hw0 * v.turnX, 1.6);
      const sy = ly * scale;
      out.push({ x: x - sy * sin, y: y + sy * cos, r: hw * scale });
    }
    return out;
  }

  class Grid {
    constructor(cell) { this.cell = cell; this.map = new Map(); }
    key(i, j) { return i * 100003 + j; }
    add(c) {
      const i0 = Math.floor((c.x - c.r) / this.cell), i1 = Math.floor((c.x + c.r) / this.cell);
      const j0 = Math.floor((c.y - c.r) / this.cell), j1 = Math.floor((c.y + c.r) / this.cell);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const k = this.key(i, j);
        (this.map.get(k) || this.map.set(k, []).get(k)).push(c);
      }
    }
    hits(c, margin, ignoreOwner) {
      const R = c.r + margin;
      const i0 = Math.floor((c.x - R) / this.cell), i1 = Math.floor((c.x + R) / this.cell);
      const j0 = Math.floor((c.y - R) / this.cell), j1 = Math.floor((c.y + R) / this.cell);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const list = this.map.get(this.key(i, j));
        if (!list) continue;
        for (const o of list) {
          if (ignoreOwner !== undefined && o.owner === ignoreOwner) continue;
          const d = c.r + o.r + margin, dx = c.x - o.x, dy = c.y - o.y;
          if (dx * dx + dy * dy < d * d) return true;
        }
      }
      return false;
    }
  }

  function visible(c, view) {
    const b = view.bounds, pad = 3;
    if (c.x - c.r < b.x0 + pad || c.x + c.r > b.x1 - pad || c.y - c.r < b.y0 + pad || c.y + c.r > b.y1 - pad) return false;
    for (const r of view.avoid) {
      const nx = Math.max(r.x0, Math.min(c.x, r.x1)), ny = Math.max(r.y0, Math.min(c.y, r.y1));
      if ((c.x - nx) ** 2 + (c.y - ny) ** 2 < (c.r + pad) ** 2) return false;
    }
    return true;
  }
  const pointVisible = (x, y, view) => visible({ x, y, r: 0 }, view);

  // ── Structure ────────────────────────────────────────────────────
  /**
   * Limbs = top-level groups under the root (usually folders). Each limb has
   * spec groups; each spec group has its tests. Nested folders are flattened
   * into their top-level limb. Order is by path (deterministic).
   */
  function structureOf(tree, walk) {
    const byPath = (a, b) => a.path.localeCompare(b.path);
    const testsUnder = (n) => { const out = []; for (const x of walk(n)) if (x.kind === 'test') out.push(x); return out.sort(byPath); };
    const limbs = [];
    for (const top of [...tree.children].sort(byPath)) {
      const specs = [];
      if (top.kind === 'test') { limbs.push({ node: top, specs: [{ node: top, tests: [top] }] }); continue; }
      const stack = [top];
      const seen = [];
      while (stack.length) {
        const n = stack.pop();
        if (n.kind === 'spec') seen.push(n);
        else for (const c of n.children) if (c.kind !== 'test') stack.push(c);
      }
      if (!seen.length) seen.push(top);               // a folder with tests but no spec files
      for (const sp of seen.sort(byPath)) specs.push({ node: sp, tests: testsUnder(sp) });
      limbs.push({ node: top, specs: specs.filter((s) => s.tests.length) });
    }
    return limbs.filter((l) => l.specs.length);
  }

  // ── Placement ────────────────────────────────────────────────────
  /** Lifts to try for a leaf, starting at its own preferred pose. */
  function liftCandidates(pref) {
    pref = Math.min(LIFT_MAX, Math.max(LIFT_MIN, pref));
    const out = [pref];
    for (let d = 10; d <= LIFT_MAX - LIFT_MIN; d += 10) {
      if (pref + d <= LIFT_MAX) out.push(pref + d);
      if (pref - d >= LIFT_MIN) out.push(pref - d);
    }
    return out;
  }

  /**
   * Split an ordered slot list into contiguous chunks proportional to weights,
   * then SNAP each cut to the nearest real branch boundary: the cut between two
   * neighbouring slots whose sap paths part closest to the trunk. So a folder
   * owns whole limbs (its junction sits at the base of its own branch, not on
   * the trunk) whenever the sizes allow — the tree's anatomy IS the data map.
   * @param split (slotA, slotB) → depth where their sap paths part (smaller = more major)
   */
  function chunkBy(list, weights, split) {
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    const cuts = [];
    let acc = 0;
    for (let k = 0; k < weights.length - 1; k++) { acc += weights[k]; cuts.push(Math.round((acc / total) * list.length)); }
    if (split && list.length > 2) {
      let prev = 0;
      for (let k = 0; k < cuts.length; k++) {
        const next = k + 1 < cuts.length ? cuts[k + 1] : list.length;
        const w = Math.floor(SNAP_WINDOW * Math.min(cuts[k] - prev, next - cuts[k]));
        let best = cuts[k], bestD = Infinity;
        for (let b = Math.max(prev + 1, cuts[k] - w); b <= Math.min(next - 1, cuts[k] + w); b++) {
          const d = split(list[b - 1], list[b]);
          if (d < bestD || (d === bestD && Math.abs(b - cuts[k]) < Math.abs(best - cuts[k]))) { bestD = d; best = b; }
        }
        cuts[k] = best;
        prev = best;
      }
    }
    const out = [];
    let start = 0;
    for (const c of [...cuts, list.length]) { const end = Math.max(c, start); out.push(list.slice(start, end)); start = end; }
    return out;
  }

  /** Depth (hops from the root) at which two slots' sap paths part. Cached per mood. */
  function splitDepthOf(mood) {
    const vf = fieldOf(mood) ? vascularField(mood) : null;
    if (!vf) return null;
    const memo = vf.splitMemo || (vf.splitMemo = new Map());
    const N = vf.parent.length;
    return (a, b) => {
      let x = a.cell, y = b.cell;
      if (x < 0 || y < 0) return Infinity;
      const key = x * N + y;
      const hit = memo.get(key);
      if (hit !== undefined) return hit;
      const { parent, hops } = vf;
      while (hops[x] > hops[y]) x = parent[x];
      while (hops[y] > hops[x]) y = parent[y];
      while (x !== y) { x = parent[x]; y = parent[y]; }
      memo.set(key, hops[x]);
      return hops[x];
    };
  }

  const _slotMeta = new WeakMap();
  /** Per-slot constants that never change for a mood: position, tree order, rank. */
  function slotMeta(mood, W, H) {
    let m = _slotMeta.get(mood);
    if (m) return m;
    const field = fieldOf(mood);
    const vf = field ? vascularField(mood) : null;
    const cx = W * 0.5, cy = H * 0.62, cy2 = H * 0.42, R = Math.hypot(W * 0.5, H * 0.42);
    m = mood.slots.map((s, i) => {
      const x = s.x * W, y = s.y * H;
      let t, cell = -1;
      if (vf) { cell = nearestReached(vf, x, y); t = cell >= 0 ? vf.order[cell] : 1e9; }
      else t = -Math.atan2(cy - y, x - cx) * 1e4;
      const kind = s.kind === 'tip' ? 0 : s.kind === 'twig' ? 0.15 : 0.45;
      const rank = hash01(`${s.x},${s.y}`, 11) - (Math.hypot(x - cx, y - cy2) / R) * 0.9 + kind;
      return { s, i, x, y, t, rank, cell };
    });
    _slotMeta.set(mood, m);
    return m;
  }

  /**
   * What gets placed for one spec file: one leaf per test, or — when a scope
   * is too big to show every test legibly — ONE glass pod for the whole file.
   */
  function itemsOf(spec, grain) {
    if (grain !== 'spec') return spec.tests;
    if (!spec._pod) spec._pod = [{ id: spec.node.id, kind: 'pod', node: spec.node, tests: spec.tests }];
    return spec._pod;
  }

  function tryLayout(limbs, mood, env, globalScale, view, grain) {
    const { W, H } = env;
    const visualOf = (it) => (it.kind === 'pod' ? env.podVisual(it) : env.leafVisual(it));
    const colliderOf = (it) => (it.kind === 'pod' ? env.podCollider : env.collider);
    const probes = new Map();
    const probeOf = (col) => probes.get(col) || probes.set(col, [col.reduce((a, b) => (b[1] > a[1] ? b : a))]).get(col);
    const field = fieldOf(mood);
    const grid = new Grid(48);
    const margin = Math.max(1, MARGIN * globalScale);

    // Usable slots, ordered by their position in the sap tree (depth-first,
    // left → right), so contiguous chunks are whole sub-branches.
    const meta = slotMeta(mood, W, H);           // per-slot constants, cached per mood
    const slots = meta
      .filter((o) => o.t < 1e9)                        // sap must reach it: no leaves on detached fragments
      .filter((o) => pointVisible(o.x, o.y, view))
      .sort((a, b) => a.t - b.t || a.i - b.i);
    // Limbs own contiguous sectors; specs own sub-sectors — cut at real branch boundaries.
    const split = splitDepthOf(mood);
    const limbCount = (l) => l.specs.reduce((n, sp) => n + itemsOf(sp, grain).length, 0);
    const limbChunks = chunkBy(slots, limbs.map(limbCount), split);

    // Within a sector: tips first, then twigs, then limb-edge shoots; outer first.
    const byRank = (list) => [...list].sort((a, b) => a.rank - b.rank);
    const byNearTree = (t) => [...slots].sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t));

    const placements = [];
    const exhausted = new Map();                // slot index → leaves that found no pose there
    let failed = false;
    limbs.forEach((limb, li) => {
      if (failed) return;
      const limbSlots = limbChunks[li];
      const specChunks = chunkBy(limbSlots, limb.specs.map((sp) => itemsOf(sp, grain).length), split);
      limb.specs.forEach((spec, si) => {
        if (failed) return;
        const home = specChunks[si].length ? specChunks[si] : limbSlots;
        const homeT = home.length ? home[Math.floor(home.length / 2)].t : 0;
        // Try: own spec sector → own limb → nearest neighbours by angle (spill over)
        const ids = new Set();
        const order = [];
        for (const o of [...byRank(home), ...byRank(limbSlots), ...byNearTree(homeT)])
          if (!ids.has(o.i)) { ids.add(o.i); order.push(o); }

        let cursor = 0;
        const SPILL = 600;                                   // nearest other slots a leaf may spill to
        const limit = Math.min(order.length, home.length + limbSlots.length + SPILL);
        for (const test of itemsOf(spec, grain)) {
          const v = visualOf(test);
          const collider = colliderOf(test);
          const PROBE = probeOf(collider);
          const scale = LEAF_BASE_SCALE * v.scale * globalScale;
          const lifts = liftCandidates(v.lift).filter((l) => !v.maxLift || l <= v.maxLift);   // pods hang, never point up
          let done = false;
          for (let n = 0; n < limit && !done; n++) {
            // cursor rotates within the home sector so a spec's leaves spread over it
            const o = n < home.length ? order[(cursor + n) % home.length] : order[n];
            if ((exhausted.get(o.i) || 0) >= 4) continue;    // this spot is full
            const outward = Math.cos((o.s.angle * Math.PI) / 180) >= 0 ? 1 : -1;
            for (const side of [v.side * outward, -v.side * outward]) {
              for (const lift of lifts) {
                const rotate = -side * lift;      // SVG rotate(+) is clockwise; blade hangs along +y
                // cheap probe: the widest circle rejects most poses on its own
                const probe = leafCircles(PROBE, v, o.x, o.y, rotate, scale)[0];
                if (!visible(probe, view) || grid.hits(probe, margin)) continue;
                if (field && Math.hypot(probe.x - o.x, probe.y - o.y) > ATTACH_RADIUS &&
                    clearanceAt(field, probe.x, probe.y) < probe.r * (1 - TREE_GRAZE)) continue;
                const circles = leafCircles(collider, v, o.x, o.y, rotate, scale);
                if (circles.some((c) => !visible(c, view))) continue;
                if (circles.some((c) => grid.hits(c, margin))) continue;
                if (field && circles.some((c) => Math.hypot(c.x - o.x, c.y - o.y) > ATTACH_RADIUS &&
                    clearanceAt(field, c.x, c.y) < c.r * (1 - TREE_GRAZE))) continue;
                circles.forEach((c) => grid.add(c));
                placements.push({ test, limb: limb.node, spec: spec.node, slot: o.s, x: o.x, y: o.y, rotate, scale, circles });
                if (n < home.length) cursor = (cursor + n + 1) % Math.max(1, home.length);
                done = true; break;
              }
              if (done) break;
            }
            if (!done) exhausted.set(o.i, (exhausted.get(o.i) || 0) + 1);
          }
          if (!done) { failed = true; return; }
        }
      });
    });
    if (failed) return null;
    return placements.length === limbs.reduce((n, l) => n + limbCount(l), 0) ? placements : null;
  }

  /**
   * Place every test's leaf (or every file's pod). Status-independent,
   * deterministic, overlap-free.
   * @param env  { W, H, walk, leafVisual, collider, podVisual?, podCollider? }
   * @param opts.grain     'test' (default): one leaf per test · 'spec': one pod per file
   * @param opts.minScale  smallest legible size. Given → returns null when even
   *                       that does not fit (the caller clusters). Omitted → shrink
   *                       as far as needed, throw only if nothing fits.
   */
  function layoutGrove(tree, mood, env, view, opts) {
    opts = opts || {};
    view = view || { bounds: { x0: 0, y0: 0, x1: env.W, y1: env.H }, avoid: [] };
    const grain = opts.grain || 'test';
    const floor = opts.minScale != null ? opts.minScale : 0.06;
    const limbs = structureOf(tree, env.walk);
    // Full size if it fits; otherwise bisect for the largest size that does.
    let best = tryLayout(limbs, mood, env, 1, view, grain);
    if (best) return { placements: best, globalScale: 1, limbs, grain };
    let lo = 0, hi = 1;                       // hi: known not to fit
    for (let g = 0.5; ; g *= 0.5) {           // find any scale that fits, never below the floor
      const gg = Math.max(g, floor);
      const p = tryLayout(limbs, mood, env, gg, view, grain);
      if (p) { lo = gg; best = p; break; }
      hi = gg;
      if (gg <= floor) break;
    }
    if (!best) {
      if (opts.minScale != null) return null;
      throw new Error('TestGrove: could not place every leaf without overlap');
    }
    for (let i = 0; i < 5 && hi - lo > 0.04; i++) {   // refine between lo (fits) and hi (doesn't)
      const mid = (lo + hi) / 2;
      const p = tryLayout(limbs, mood, env, mid, view, grain);
      if (p) { lo = mid; best = p; } else hi = mid;
    }
    return { placements: best, globalScale: lo, limbs, grain };
  }

  // ── Vascular network ─────────────────────────────────────────────
  class Heap {
    constructor() { this.a = []; }
    push(k, v) { const a = this.a; a.push([k, v]); let i = a.length - 1;
      while (i) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
    pop() { const a = this.a, top = a[0], last = a.pop();
      if (a.length) { a[0] = last; let i = 0;
        for (;;) { const l = 2 * i + 1, r = l + 1; let m = i;
          if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r;
          if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } }
      return top; }
    get size() { return this.a.length; }
  }

  const _vascular = new WeakMap();
  /**
   * Shortest sap paths from the trunk base to every cell of the tree body,
   * preferring each branch's centre line. Cached per mood.
   * @returns { parent: Int32Array, f } — parent[cell] = previous cell toward the root
   */
  function vascularField(mood) {
    let v = _vascular.get(mood);
    if (v) return v;
    const f = fieldOf(mood);
    const { w, h, data } = f;
    const N = w * h;
    const wood = new Uint8Array(N);
    for (let k = 0; k < N; k++) wood[k] = data[k] === 0 ? 1 : 0;
    // depth inside the wood (chamfer distance to the nearest non-wood cell)
    const depth = new Float32Array(N);
    for (let k = 0; k < N; k++) depth[k] = wood[k] ? 1e9 : 0;
    const D1 = 1, D2 = Math.SQRT2;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { const k = j * w + i; if (!wood[k]) continue;
      if (i > 0) depth[k] = Math.min(depth[k], depth[k - 1] + D1);
      if (j > 0) { depth[k] = Math.min(depth[k], depth[k - w] + D1);
        if (i > 0) depth[k] = Math.min(depth[k], depth[k - w - 1] + D2);
        if (i < w - 1) depth[k] = Math.min(depth[k], depth[k - w + 1] + D2); } }
    for (let j = h - 1; j >= 0; j--) for (let i = w - 1; i >= 0; i--) { const k = j * w + i; if (!wood[k]) continue;
      if (i < w - 1) depth[k] = Math.min(depth[k], depth[k + 1] + D1);
      if (j < h - 1) { depth[k] = Math.min(depth[k], depth[k + w] + D1);
        if (i < w - 1) depth[k] = Math.min(depth[k], depth[k + w + 1] + D2);
        if (i > 0) depth[k] = Math.min(depth[k], depth[k + w - 1] + D2); } }
    // ONE root: the deepest point of the trunk at the bottom of the canopy band.
    // A single source makes every sap path merge into one branching tree;
    // a band of sources would give each leaf its own parallel pipe.
    let maxJ = 0;
    for (let k = 0; k < N; k++) if (wood[k]) maxJ = Math.max(maxJ, (k / w) | 0);
    let rootK = -1, best = -1;
    for (let j = maxJ - 3; j <= maxJ; j++) for (let i = Math.floor(w * 0.40); i < Math.ceil(w * 0.60); i++) {
      const k = j * w + i; if (wood[k] && depth[k] > best) { best = depth[k]; rootK = k; } }
    const dist = new Float64Array(N).fill(Infinity);
    const parent = new Int32Array(N).fill(-1);
    const heap = new Heap();
    if (rootK >= 0) { dist[rootK] = 0; parent[rootK] = rootK; heap.push(0, rootK); }
    const nb = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, D2], [1, -1, D2], [-1, 1, D2], [-1, -1, D2]];
    while (heap.size) {
      const [d, k] = heap.pop();
      if (d > dist[k]) continue;
      const i = k % w, j = (k / w) | 0;
      for (const [di, dj, len] of nb) {
        const ni = i + di, nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
        const q = nj * w + ni; if (!wood[q]) continue;
        // Sap runs along the medial axis; other wood only to hop onto it.
        const nd = d + len * (f.axis ? (f.axis[q] ? 1 : 30) : (1 + 24 / (1 + depth[q] * depth[q])));
        if (nd < dist[q]) { dist[q] = nd; parent[q] = k; heap.push(nd, q); }
      }
    }
    // Preorder index of every cell in the sap tree, children visited left → right.
    // Slots sorted by this index form CONTIGUOUS SUBTREES when chunked — so a
    // folder owns whole sub-branches, never a wedge straddling two limbs.
    const kids = new Map();
    for (let k = 0; k < N; k++) {
      const p = parent[k];
      if (p >= 0 && p !== k) (kids.get(p) || kids.set(p, []).get(p)).push(k);
    }
    const angle = (from, to) => Math.atan2(((from / w) | 0) - ((to / w) | 0), (to % w) - (from % w));
    const order = new Int32Array(N).fill(-1);
    const hops = new Int32Array(N).fill(-1);       // tree depth: steps from the root
    let idx = 0;
    if (rootK >= 0) {
      const stack = [rootK];
      while (stack.length) {
        const k = stack.pop();
        order[k] = idx++;
        hops[k] = k === rootK ? 0 : hops[parent[k]] + 1;   // preorder: parent first
        const ch = kids.get(k);
        if (ch) {
          ch.sort((a, b) => angle(k, b) - angle(k, a));          // left (π) first …
          for (let i = ch.length - 1; i >= 0; i--) stack.push(ch[i]);   // … so push right-most first
        }
      }
    }
    v = { parent, f, wood, order, hops, depth, rootK };
    _vascular.set(mood, v);
    return v;
  }

  /** Nearest reachable wood cell to a painting point. */
  function nearestReached(vf, x, y) {
    const { f, parent } = vf;
    const ci = Math.floor(x / f.cell), cj = Math.floor(y / f.cell);
    for (let r = 0; r <= 8; r++)
      for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
        const i = ci + di, j = cj + dj;
        if (i < 0 || j < 0 || i >= f.w || j >= f.h) continue;
        const k = j * f.w + i;
        if (parent[k] >= 0) return k;
      }
    return -1;
  }

  /**
   * Build the vascular network for placed leaves.
   * @returns {
   *   segments: [{ id, cells:[k...] (root→tip), leafIds:[...] }],
   *   leafPath: Map(leafId → [cell...] root→leaf),
   *   nodes: [{ id (TestNode id), kind:'limb'|'spec', x, y, leafIds:[...] }],
   *   cellXY(k) → {x,y}
   * }
   */
  function buildNetwork(mood, placements) {
    const vf = vascularField(mood);
    const { f, parent } = vf;
    const cellXY = (k) => ({ x: (k % f.w + 0.5) * f.cell, y: (((k / f.w) | 0) + 0.5) * f.cell });

    // Root → leaf path for every leaf
    const leafPath = new Map();
    for (const p of placements) {
      let k = nearestReached(vf, p.x, p.y);
      const path = [];
      let guard = 0;
      while (k >= 0 && parent[k] !== k && guard++ < 100000) { path.push(k); k = parent[k]; }
      if (k >= 0) path.push(k);
      leafPath.set(p.test.id, path.reverse());
    }

    // Union of paths as a tree; count children per cell
    const children = new Map();     // cell → Set(child cells)
    const leavesAt = new Map();     // cell → [leafIds ending here]
    const roots = new Set();
    for (const [id, path] of leafPath) {
      if (!path.length) continue;
      roots.add(path[0]);
      for (let i = 0; i < path.length - 1; i++) {
        let set = children.get(path[i]); if (!set) children.set(path[i], set = new Set());
        set.add(path[i + 1]);
      }
      const end = path[path.length - 1];
      (leavesAt.get(end) || leavesAt.set(end, []).get(end)).push(id);
    }

    // Downstream leaves per cell (post-order)
    const down = new Map();
    const visit = (k) => {
      if (down.has(k)) return down.get(k);
      const ids = [...(leavesAt.get(k) || [])];
      for (const c of (children.get(k) || [])) ids.push(...visit(c));
      down.set(k, ids);
      return ids;
    };
    // iterative-safe: paths are at most a few hundred cells deep
    for (const r of roots) visit(r);

    // Segments: chains between branch points
    const segments = [];
    const isJoint = (k) => (children.get(k) || new Set()).size !== 1 || leavesAt.has(k);
    for (const r of roots) {
      const stack = [[r, null]];
      while (stack.length) {
        const [start, from] = stack.pop();
        for (const first of (children.get(start) || [])) {
          const cells = [start, first];
          let k = first;
          while (!isJoint(k)) { k = [...children.get(k)][0]; cells.push(k); }
          segments.push({ id: `seg${segments.length}`, cells, leafIds: down.get(first) || [] });
          stack.push([k, start]);
        }
      }
    }

    // Junction nodes: the deepest cell shared by all of a group's leaf paths
    const lca = (ids) => {
      const paths = ids.map((id) => leafPath.get(id)).filter((p) => p && p.length);
      if (!paths.length) return null;
      let n = Math.min(...paths.map((p) => p.length));
      let depth = 0;
      while (depth < n && paths.every((p) => p[depth] === paths[0][depth])) depth++;
      // single-leaf group: back off from the leaf's own attachment point
      if (ids.length === 1) depth = Math.max(1, depth - 6);
      return { cell: paths[0][Math.max(0, depth - 1)], depth };
    };
    const groups = new Map();      // node id → { kind, node, leafIds }
    for (const p of placements) {
      for (const [kind, node] of [['limb', p.limb], ['spec', p.spec]]) {
        if (!node || node.kind === 'test' || node.id === p.test.id) continue;   // a pod is its own spec
        const g = groups.get(node.id) || groups.set(node.id, { kind, node, leafIds: [] }).get(node.id);
        g.leafIds.push(p.test.id);
      }
    }
    const nodes = [];
    for (const [id, g] of groups) {
      const at = lca(g.leafIds);
      if (!at) continue;
      const { x, y } = cellXY(at.cell);
      nodes.push({ id, kind: g.kind, name: g.node.name, path: g.node.path, x, y, depth: at.depth, leafIds: g.leafIds });
    }
    // Settle junctions: a node must never be covered by a leaf (it has to stay
    // visible and clickable) and must not touch another node. If it is, slide it
    // back TOWARD THE TRUNK along its group's shared path — still on the exact
    // vessel that feeds that group.
    const allCircles = placements.flatMap((p) => p.circles);
    const NODE_R = { limb: 10, spec: 8 };            // body + selection ring + gap, px
    const blocked = (x, y, R, others) =>
      allCircles.some((c) => Math.hypot(c.x - x, c.y - y) < c.r + R) ||
      others.some((o) => Math.hypot(o.x - x, o.y - y) < R + NODE_R[o.kind]);
    nodes.sort((a, b) => (a.kind === 'limb' ? 0 : 1) - (b.kind === 'limb' ? 0 : 1) || a.depth - b.depth);
    const settled = [];
    for (const nd of nodes) {
      const path = leafPath.get(nd.leafIds[0]) || [];
      const R = NODE_R[nd.kind];
      let d = Math.min(nd.depth - 1, path.length - 1);
      while (d > 1 && blocked(nd.x, nd.y, R, settled)) { d -= 1; const q = cellXY(path[d]); nd.x = q.x; nd.y = q.y; }
      nd.clear = !blocked(nd.x, nd.y, R, settled);
      settled.push(nd);
    }
    // Branch half-width at a cell (px): how far its centre line is from the bark/glass edge
    const radiusAt = (k) => Math.max(1.5, vf.depth[k] * f.cell - 1);
    // Position of a cell in the sap tree's depth-first, left → right order
    const orderAt = (k) => vf.order[k];
    return { segments, leafPath, nodes, cellXY, radiusAt, orderAt, roots: [...roots] };
  }

  /**
   * Which group a branch SEGMENT belongs to: the one spec file whose tests it
   * alone feeds, else the one folder, else the whole suite (rootId). Hovering a
   * branch therefore names exactly what flows through it.
   */
  function segmentOwners(net, placements, rootId) {
    const byLeaf = new Map(placements.map((p) => [p.test.id, p]));
    const owners = new Map();
    for (const seg of net.segments) {
      const specs = new Set(), limbs = new Set();
      for (const id of seg.leafIds) {
        const p = byLeaf.get(id);
        if (!p) continue;
        specs.add(p.spec.id);
        limbs.add(p.limb.id);
      }
      owners.set(seg.id, specs.size === 1 ? [...specs][0] : limbs.size === 1 ? [...limbs][0] : rootId);
    }
    return owners;
  }

  /**
   * Hover lift per leaf: the largest scale (≤ HOVER_MAX) about its stem at
   * which the blade still touches no other leaf and no junction. A hovered
   * leaf grows — and still never overlaps anything (hard rule).
   */
  function hoverScales(placements, nodes) {
    const grid = new Grid(48);
    placements.forEach((p, i) => p.circles.forEach((c) => grid.add({ x: c.x, y: c.y, r: c.r, owner: i })));
    const NODE_R = { limb: 10, spec: 8 };
    for (const nd of nodes || []) grid.add({ x: nd.x, y: nd.y, r: NODE_R[nd.kind] || 8, owner: -1 });
    const GAP = 1;
    return placements.map((p, i) => {
      const fits = (s) => p.circles.every((c) =>
        !grid.hits({ x: p.x + (c.x - p.x) * s, y: p.y + (c.y - p.y) * s, r: c.r * s }, GAP, i));
      if (fits(HOVER_MAX)) return HOVER_MAX;
      let lo = 1, hi = HOVER_MAX;
      for (let k = 0; k < 7; k++) { const mid = (lo + hi) / 2; if (fits(mid)) lo = mid; else hi = mid; }
      return lo;
    });
  }

  // ── Status over the network ──────────────────────────────────────
  const SEVERITY = { failing: 4, flaky: 3, pending: 2, passing: 1, skipped: 0 };
  /** Worst status among a set of leaf statuses (what a vessel or node "carries"). */
  function worst(statuses) {
    let best = null, sv = -1;
    for (const s of statuses) if ((SEVERITY[s] ?? 2) > sv) { sv = SEVERITY[s] ?? 2; best = s; }
    if (best === 'skipped' && statuses.some((s) => s !== 'skipped')) best = 'passing';
    return best || 'pending';
  }

  /**
   * What a VESSEL shows: the share of the tests it feeds, not the single worst.
   * A trunk feeding 100 tests with 3 failures stays healthy; the vessel turns
   * red only where at least half of what it feeds is failing — so red appears
   * where the failure IS, not all the way down from the root.
   */
  function vesselStatus(statuses) {
    const c = { passing: 0, failing: 0, flaky: 0, skipped: 0, pending: 0 };
    for (const s of statuses) if (s in c) c[s]++;
    return vesselStatusOf(c);
  }
  /** vesselStatus over counts ({passing, failing, flaky, skipped, pending}). */
  function vesselStatusOf(c) {
    const n = (c.passing || 0) + (c.failing || 0) + (c.flaky || 0) + (c.skipped || 0) + (c.pending || 0) || 1;
    c = { failing: c.failing || 0, flaky: c.flaky || 0, skipped: c.skipped || 0, pending: c.pending || 0 };
    if (c.pending === n) return 'pending';
    if (c.skipped === n) return 'skipped';
    if (c.failing / n >= 0.5) return 'failing';
    if ((c.failing + c.flaky) / n >= 0.5) return 'flaky';
    return 'passing';
  }

  /**
   * A spec "ruptures" when none of its tests ran clean: ≥2 tests, at least one
   * failing, the rest failing or skipped. That is the signature of a setup /
   * beforeAll failure — the flow stops at that junction.
   */
  function isRuptured(statuses) {
    return statuses.length >= 2 && statuses.includes('failing') &&
           statuses.every((s) => s === 'failing' || s === 'skipped');
  }

  const api = {
    layoutGrove, buildNetwork, structureOf, leafCircles, fieldOf, clearanceAt,
    worst, vesselStatus, vesselStatusOf, isRuptured, hash01, segmentOwners, hoverScales,
    constants: { LEAF_BASE_SCALE, MARGIN, TREE_GRAZE, ATTACH_RADIUS, LIFT_MIN, LIFT_MAX, SNAP_WINDOW, HOVER_MAX },
  };
  root.GroveLayout = api;
})(typeof window !== 'undefined' ? window : globalThis);
