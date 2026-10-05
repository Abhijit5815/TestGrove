/**
 * TestGrove — Invariant tests.
 *
 * Loads the REAL build output (prototype/testgrove-bundle.js, produced by
 * `npm run build:core` from src/) in a sandbox, plus the prototype's
 * renderer + generated anatomy, and asserts the core invariants.
 * If any of these fail, we've broken the atom.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PROTO = path.join(__dirname, '..', 'prototype');
const sandbox = { console, Math, Date, Map, Set, Object, Array, JSON, Buffer, atob, WeakMap, Uint8Array, Int32Array, Float32Array, Float64Array };
sandbox.window = sandbox;          // browser scripts write to window.*
vm.createContext(sandbox);
for (const f of ['testgrove-bundle.js', 'tree-anatomy.js', 'tree-scene.js', 'leaf.js', 'grove-layout.js', 'tree-renderer.js', 'views.js']) {
  vm.runInContext(fs.readFileSync(path.join(PROTO, f), 'utf8'), sandbox, { filename: f });
}
// esbuild's IIFE declares `var TestGrove`, which lands on the sandbox global.
const TG = sandbox.TestGrove;
if (!TG || typeof TG.generateMockTree !== 'function') {
  console.error('Bundle did not expose TestGrove. Run `npm run build:core` first.');
  process.exit(1);
}
if (typeof TG.computeLayout !== 'function') {
  console.error('prototype/testgrove-bundle.js is older than src/ (no computeLayout export).\n' +
                'Rebuild it first:  npm run build:core');
  process.exit(1);
}
const ANATOMY = sandbox.TREE_ANATOMY;
const LEAF = sandbox.TestGroveLeaf;

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
  }
}

function assertEqual(a, b, msg = '') {
  if (a !== b) throw new Error(`${msg} — expected ${b}, got ${a}`);
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

console.log('\n== Domain invariants ==');

test('leaf count matches configured total', () => {
  const tree = TG.generateMockTree({ totalTests: 100, seed: 1 });
  assertEqual(TG.countLeaves(tree), 100, 'leaf count');
});

test('leaf count scales linearly with configured total', () => {
  for (const n of [1, 10, 50, 500, 5000]) {
    const tree = TG.generateMockTree({ totalTests: n, seed: 3 });
    assertEqual(TG.countLeaves(tree), n, `n=${n}`);
  }
});

test('same seed produces identical trees (determinism)', () => {
  const a = TG.generateMockTree({ totalTests: 200, seed: 99 });
  const b = TG.generateMockTree({ totalTests: 200, seed: 99 });
  const idsA = [];
  const idsB = [];
  for (const n of TG.walk(a)) idsA.push(n.id);
  for (const n of TG.walk(b)) idsB.push(n.id);
  assertEqual(idsA.join(','), idsB.join(','), 'ids differ');
});

test('cannot create a test node with children', () => {
  let threw = false;
  try {
    TG.createTestNode({
      kind: 'test', name: 't', path: 'x',
      children: [TG.createTestNode({ kind: 'test', name: 'c', path: 'y' })],
    });
  } catch { threw = true; }
  assert(threw, 'expected an invariant error');
});

test('cannot create a non-test node without children', () => {
  let threw = false;
  try { TG.createTestNode({ kind: 'folder', name: 'f', path: 'z' }); } catch { threw = true; }
  assert(threw, 'expected an invariant error');
});

test('nodes are deeply frozen', () => {
  const tree = TG.generateMockTree({ totalTests: 20, seed: 1 });
  assert(Object.isFrozen(tree), 'root not frozen');
  assert(Object.isFrozen(tree.children), 'children array not frozen');
  const first = tree.children[0];
  assert(Object.isFrozen(first), 'child not frozen');
});

console.log('\n== Status aggregation ==');

test('any failing child → parent failing', () => {
  const tree = TG.createTestNode({
    kind: 'spec', name: 's', path: 'p',
    children: [
      TG.createTestNode({ kind: 'test', name: 'a', path: 'p/a', status: 'passing' }),
      TG.createTestNode({ kind: 'test', name: 'b', path: 'p/b', status: 'failing' }),
      TG.createTestNode({ kind: 'test', name: 'c', path: 'p/c', status: 'passing' }),
    ],
  });
  const propagated = TG.propagateStatuses(tree);
  assertEqual(propagated.status, 'failing');
});

test('no failing, any flaky → parent flaky', () => {
  const tree = TG.createTestNode({
    kind: 'spec', name: 's', path: 'p',
    children: [
      TG.createTestNode({ kind: 'test', name: 'a', path: 'p/a', status: 'passing' }),
      TG.createTestNode({ kind: 'test', name: 'b', path: 'p/b', status: 'flaky' }),
    ],
  });
  assertEqual(TG.propagateStatuses(tree).status, 'flaky');
});

test('all passing → passing', () => {
  const tree = TG.createTestNode({
    kind: 'spec', name: 's', path: 'p',
    children: [
      TG.createTestNode({ kind: 'test', name: 'a', path: 'p/a', status: 'passing' }),
      TG.createTestNode({ kind: 'test', name: 'b', path: 'p/b', status: 'passing' }),
    ],
  });
  assertEqual(TG.propagateStatuses(tree).status, 'passing');
});

test('all skipped → skipped', () => {
  const tree = TG.createTestNode({
    kind: 'spec', name: 's', path: 'p',
    children: [
      TG.createTestNode({ kind: 'test', name: 'a', path: 'p/a', status: 'skipped' }),
      TG.createTestNode({ kind: 'test', name: 'b', path: 'p/b', status: 'skipped' }),
    ],
  });
  assertEqual(TG.propagateStatuses(tree).status, 'skipped');
});

test('stats health score matches passing/total', () => {
  const tree = TG.generateMockTree({
    totalTests: 100, seed: 1,
    statusMix: { passing: 0.8, failing: 0.1, flaky: 0.1, skipped: 0 },
  });
  const stats = TG.computeStats(tree);
  assertEqual(stats.totalTests, 100);
  const expected = stats.passing / stats.totalTests;
  assert(Math.abs(stats.healthScore - expected) < 1e-9, `health = ${stats.healthScore}, expected ${expected}`);
});

test('mood derives correctly from health', () => {
  assertEqual(TG.moodFromHealth(0.95), 'peaceful');
  assertEqual(TG.moodFromHealth(0.80), 'unsettled');
  assertEqual(TG.moodFromHealth(0.60), 'stormy');
  assertEqual(TG.moodFromHealth(0.30), 'eerie');
});

console.log('\n== Layout engine ==');

test('layout is deterministic for same tree', () => {
  const tree = TG.generateMockTree({ totalTests: 50, seed: 7 });
  const a = TG.computeLayout(tree);
  const b = TG.computeLayout(tree);
  assertEqual(a.nodes.length, b.nodes.length);
  for (let i = 0; i < a.nodes.length; i++) {
    assertEqual(a.nodes[i].position.x, b.nodes[i].position.x, `x mismatch at ${i}`);
    assertEqual(a.nodes[i].position.y, b.nodes[i].position.y, `y mismatch at ${i}`);
  }
});

test('layout node count === tree node count', () => {
  for (const n of [10, 100, 1000]) {
    const tree = TG.generateMockTree({ totalTests: n, seed: 3 });
    const layout = TG.computeLayout(tree);
    let treeCount = 0;
    for (const _ of TG.walk(tree)) treeCount++;
    assertEqual(layout.nodes.length, treeCount, `n=${n}`);
  }
});

test('layout leaf count === test count', () => {
  for (const n of [10, 100, 500]) {
    const tree = TG.generateMockTree({ totalTests: n, seed: 3 });
    const layout = TG.computeLayout(tree);
    const leaves = layout.nodes.filter(x => x.kind === 'test').length;
    assertEqual(leaves, n, `n=${n}`);
  }
});

test('root node is at (0,0) and grows straight up', () => {
  const tree = TG.generateMockTree({ totalTests: 50, seed: 1 });
  const layout = TG.computeLayout(tree);
  const root = layout.nodes[0];
  assertEqual(root.origin.x, 0);
  assertEqual(root.origin.y, 0);
  assertEqual(root.position.x, 0);
  assert(root.position.y > 0, 'trunk must grow up (positive Y)');
});

test('every non-root node has finite coordinates', () => {
  const tree = TG.generateMockTree({ totalTests: 300, seed: 5 });
  const layout = TG.computeLayout(tree);
  for (const n of layout.nodes) {
    assert(Number.isFinite(n.position.x) && Number.isFinite(n.position.y),
      `non-finite position for ${n.name}`);
    assert(Number.isFinite(n.origin.x) && Number.isFinite(n.origin.y),
      `non-finite origin for ${n.name}`);
  }
});

test('layout performance: 1000 tests < 100ms', () => {
  const tree = TG.generateMockTree({ totalTests: 1000, seed: 1 });
  const t0 = Date.now();
  const layout = TG.computeLayout(tree);
  const dt = Date.now() - t0;
  assert(layout.nodes.length > 1000, 'expected layout to be produced');
  assert(dt < 100, `expected < 100ms, took ${dt}ms`);
  console.log(`      (took ${dt}ms for 1000 tests, ${layout.nodes.length} total nodes)`);
});

test('layout performance: 5000 tests < 500ms', () => {
  const tree = TG.generateMockTree({ totalTests: 5000, seed: 1 });
  const t0 = Date.now();
  const layout = TG.computeLayout(tree);
  const dt = Date.now() - t0;
  assert(dt < 500, `expected < 500ms, took ${dt}ms`);
  console.log(`      (took ${dt}ms for 5000 tests)`);
});


console.log('\n== Grove layout: placement ==');

const GL = sandbox.GroveLayout;
const W = ANATOMY.imageWidth, H = ANATOMY.imageHeight;
const env = { W, H, walk: TG.walk, leafVisual: LEAF.leafVisual, collider: LEAF.COLLIDER,
              podVisual: LEAF.podVisual, podCollider: LEAF.POD_COLLIDER };
const MIX = { passing: 0.78, failing: 0.1, flaky: 0.07, skipped: 0.05 };
const treeOf = (n, seed, extra) => TG.propagateStatuses(TG.generateMockTree({ totalTests: n, seed, statusMix: MIX, ...(extra || {}) }));
const layoutOf = (tree, mood) => GL.layoutGrove(tree, ANATOMY.moods[mood], env);

function overlapping(placements, margin) {
  for (let i = 0; i < placements.length; i++)
    for (let j = i + 1; j < placements.length; j++)
      for (const a of placements[i].circles)
        for (const b of placements[j].circles)
          if (Math.hypot(a.x - b.x, a.y - b.y) < a.r + b.r + margin) return [i, j];
  return null;
}

for (const mood of Object.keys(ANATOMY.moods)) {
  for (const n of [25, 100, 250]) {
    test(`${mood} @ ${n} tests: one leaf per test, none overlap, all in open air`, () => {
      const tree = treeOf(n, 5);
      const { placements, globalScale } = layoutOf(tree, mood);
      assertEqual(placements.length, n, 'placement count');
      assertEqual(new Set(placements.map((p) => p.test.id)).size, n, 'a test was placed twice');
      const hit = overlapping(placements, Math.max(1, 2 * globalScale) - 0.01);
      assert(!hit, hit && `leaves ${placements[hit[0]].test.name} / ${placements[hit[1]].test.name} overlap`);
      const f = GL.fieldOf(ANATOMY.moods[mood]);
      for (const p of placements) for (const c of p.circles) {
        if (Math.hypot(c.x - p.x, c.y - p.y) <= GL.constants.ATTACH_RADIUS) continue;
        assert(GL.clearanceAt(f, c.x, c.y) >= c.r * (1 - GL.constants.TREE_GRAZE) - 1e-9, `${p.test.name} lies across the tree`);
      }
    });
  }
}

test('results never move a leaf (the tree is a stable map)', () => {
  const a = layoutOf(treeOf(100, 1), 'unsettled').placements;
  const b = layoutOf(treeOf(100, 999, { setupFailures: ['payment.spec.ts'] }), 'unsettled').placements;
  const at = new Map(b.map((p) => [p.test.id, p]));
  for (const p of a) {
    const q = at.get(p.test.id);
    assert(q && q.x === p.x && q.y === p.y && q.rotate === p.rotate && q.scale === p.scale, `${p.test.name} moved between runs`);
  }
});

test('a spec file\'s leaves grow together (closer to each other than to other files)', () => {
  const { placements } = layoutOf(treeOf(100, 3), 'unsettled');
  const bySpec = new Map();
  for (const p of placements) (bySpec.get(p.spec.id) || bySpec.set(p.spec.id, []).get(p.spec.id)).push(p);
  let intra = 0, ni = 0, inter = 0, nx = 0;
  for (let i = 0; i < placements.length; i++) for (let j = i + 1; j < placements.length; j++) {
    const d = Math.hypot(placements[i].x - placements[j].x, placements[i].y - placements[j].y);
    if (placements[i].spec.id === placements[j].spec.id) { intra += d; ni++; } else { inter += d; nx++; }
  }
  assert(intra / ni < 0.5 * (inter / nx), `same-file ${(intra / ni).toFixed(0)}px vs other-file ${(inter / nx).toFixed(0)}px`);
});

test('failures appear where their files live, not segregated on one limb', () => {
  const tree = treeOf(100, 42, { statusMix: { passing: 0.86, failing: 0.08, flaky: 0.06, skipped: 0 } });
  const { placements } = layoutOf(tree, 'unsettled');
  const limbsWithFailures = new Set(placements.filter((p) => p.test.status === 'failing').map((p) => p.limb.id));
  const failingFolders = new Set();
  for (const p of placements) if (p.test.status === 'failing') failingFolders.add(p.limb.name);
  assertEqual(limbsWithFailures.size, failingFolders.size, 'failures should sit on their own folder\'s limb');
  assert(limbsWithFailures.size >= 2, `failures on ${limbsWithFailures.size} limb(s) — expected them spread across folders`);
});

console.log('\n== Grove layout: vascular network ==');

test('one root; every leaf is fed by a sap path from it', () => {
  const { placements } = layoutOf(treeOf(100, 4), 'stormy');
  const net = GL.buildNetwork(ANATOMY.moods.stormy, placements);
  assertEqual(net.roots.length, 1, 'roots');
  for (const p of placements) {
    const path = net.leafPath.get(p.test.id);
    assert(path && path.length > 1 && path[0] === net.roots[0], `${p.test.name} has no sap path from the root`);
  }
});

test('one junction per folder and per spec file, none covered by a leaf', () => {
  const tree = treeOf(100, 4);
  const { placements } = layoutOf(tree, 'peaceful');
  const net = GL.buildNetwork(ANATOMY.moods.peaceful, placements);
  let groups = 0;
  for (const n of TG.walk(tree)) if (n.kind === 'folder' || n.kind === 'spec') groups++;
  assertEqual(net.nodes.length, groups, 'junction count');
  for (const nd of net.nodes) assert(nd.clear, `junction ${nd.name} is covered`);
});

test('vessels show proportion; junctions flag any failure', () => {
  const many = (o) => Object.entries(o).flatMap(([s, n]) => Array(n).fill(s));
  assertEqual(GL.vesselStatus(many({ passing: 97, failing: 3 })), 'passing', 'trunk with 3% failures');
  assertEqual(GL.vesselStatus(many({ passing: 1, failing: 1 })), 'failing', 'half failing');
  assertEqual(GL.vesselStatus(many({ passing: 2, flaky: 1, failing: 1 })), 'flaky', 'half unhealthy');
  assertEqual(GL.worst(many({ passing: 97, failing: 3 })), 'failing', 'junction roll-up');
});

test('a spec whose setup fails ruptures (and only that one)', () => {
  const tree = treeOf(100, 4, { setupFailures: ['payment.spec.ts'] });
  const { placements } = layoutOf(tree, 'unsettled');
  const bySpec = new Map();
  for (const p of placements) (bySpec.get(p.spec.name) || bySpec.set(p.spec.name, []).get(p.spec.name)).push(p.test.status);
  const ruptured = [...bySpec].filter(([, st]) => GL.isRuptured(st)).map(([n]) => n);
  assertEqual(ruptured.join(','), 'payment.spec.ts');
});

test('each folder owns a contiguous run of branches (never interleaved with another)', () => {
  for (const mood of Object.keys(ANATOMY.moods)) {
    const tree = treeOf(100, 5);
    const { placements } = layoutOf(tree, mood);
    const net = GL.buildNetwork(ANATOMY.moods[mood], placements);
    const at = (p) => { const path = net.leafPath.get(p.test.id); return net.orderAt(path[path.length - 1]); };
    const seq = [...placements].sort((a, b) => at(a) - at(b)).map((p) => p.limb.id);
    let runs = 1;
    for (let i = 1; i < seq.length; i++) if (seq[i] !== seq[i - 1]) runs++;
    const folders = new Set(seq).size;
    assert(runs <= folders + 2, `${mood}: ${folders} folders split into ${runs} runs along the tree`);
  }
});

test('hovering a leaf lifts it — and it still touches nothing', () => {
  for (const mood of Object.keys(ANATOMY.moods)) {
    const { placements } = layoutOf(treeOf(100, 7), mood);
    const net = GL.buildNetwork(ANATOMY.moods[mood], placements);
    const lift = GL.hoverScales(placements, net.nodes);
    assert(lift.every((k) => k >= 1 && k <= GL.constants.HOVER_MAX), 'lift out of range');
    assert(lift.filter((k) => k > 1.05).length > placements.length * 0.5, 'most leaves should get a visible lift');
    placements.forEach((p, i) => {
      const grown = p.circles.map((c) => ({ x: p.x + (c.x - p.x) * lift[i], y: p.y + (c.y - p.y) * lift[i], r: c.r * lift[i] }));
      placements.forEach((q, j) => {
        if (i === j) return;
        for (const a of grown) for (const b of q.circles)
          assert(Math.hypot(a.x - b.x, a.y - b.y) >= a.r + b.r, `${mood}: lifted ${p.test.name} touches ${q.test.name}`);
      });
      for (const nd of net.nodes) for (const a of grown)
        assert(Math.hypot(a.x - nd.x, a.y - nd.y) >= a.r + 8, `${mood}: lifted ${p.test.name} covers junction ${nd.name}`);
    });
  }
});

test('hovering a branch names exactly what flows through it', () => {
  const tree = treeOf(100, 4);
  const { placements } = layoutOf(tree, 'unsettled');
  const net = GL.buildNetwork(ANATOMY.moods.unsettled, placements);
  const owners = GL.segmentOwners(net, placements, tree.id);
  const under = (id) => { const n = TG.findById(tree, id); const s = new Set(); for (const x of TG.walk(n)) if (x.kind === 'test') s.add(x.id); return s; };
  for (const seg of net.segments) {
    if (!seg.leafIds.length) continue;
    const own = under(owners.get(seg.id));
    assert(seg.leafIds.every((id) => own.has(id)), `segment ${seg.id} feeds tests outside its owner`);
  }
});

console.log('\n== Semantic zoom: every scope is a tree ==');

test('flying into a folder: its files become the limbs, each test drawn once', () => {
  const tree = treeOf(100, 2);
  const folder = tree.children.find((c) => c.name === 'checkout');
  const { placements } = GL.layoutGrove(folder, ANATOMY.moods.stormy, env);
  let n = 0; for (const x of TG.walk(folder)) if (x.kind === 'test') n++;
  assertEqual(placements.length, n, 'placements');
  assertEqual(new Set(placements.map((p) => p.test.id)).size, n, 'each test once');
  assertEqual(new Set(placements.map((p) => p.limb.id)).size, folder.children.length, 'one limb per file');
});

test('too big to show legibly → null at the legible floor, then one glass pod per file', () => {
  const tree = treeOf(2000, 3);
  const mood = ANATOMY.moods.unsettled;
  assertEqual(GL.layoutGrove(tree, mood, env, null, { minScale: 0.32 }), null, 'leaves at the legible floor');
  const lay = GL.layoutGrove(tree, mood, env, null, { grain: 'spec' });
  let files = 0; for (const x of TG.walk(tree)) if (x.kind === 'spec') files++;
  assertEqual(lay.placements.length, files, 'one pod per file');
  assert(lay.placements.every((p) => p.test.kind === 'pod'), 'pods');
  const held = lay.placements.reduce((k, p) => k + p.test.tests.length, 0);
  assertEqual(held, 2000, 'pods hold every test exactly once');
  const hit = overlapping(lay.placements, 0.99);
  assert(!hit, 'pods overlap');
});

test('a pod shows its file\'s results — failing at the bottom, nothing invented', () => {
  const tests = [...Array(6)].map((_, i) => ({ id: 't' + i, status: ['passing', 'passing', 'failing', 'flaky', 'skipped', 'passing'][i] }));
  const v = LEAF.podVisual({ id: 'spec-x', tests });
  assertEqual(JSON.stringify(v.counts), JSON.stringify({ passing: 3, failing: 1, flaky: 1, skipped: 1, pending: 0 }), 'counts');
  assertEqual(v.status, 'failing', 'worst');
  const again = LEAF.podVisual({ id: 'spec-x', tests: tests.map((t) => ({ ...t, status: 'passing' })) });
  assertEqual([v.scale, v.lift, v.side].join(), [again.scale, again.lift, again.side].join(), 'pod geometry ignores results');
  assert(LEAF.podVisual({ id: 's', tests: [{ id: 'a', status: 'failing' }, { id: 'b', status: 'skipped' }] }).ruptured, 'setup failure ruptures the pod');
});

test('vessel status from counts equals vessel status from a list', () => {
  const many = (o) => Object.entries(o).flatMap(([st, n]) => Array(n).fill(st));
  for (const c of [{ passing: 97, failing: 3 }, { passing: 1, failing: 1 }, { passing: 2, flaky: 1, failing: 1 }, { skipped: 4 }, { pending: 3 }]) {
    assertEqual(GL.vesselStatusOf(c), GL.vesselStatus(many(c)), JSON.stringify(c));
  }
});

console.log('\n== List and Stats read the same data ==');

test('the list holds exactly the tests of the scope', () => {
  const tree = treeOf(100, 8);
  const rows = sandbox.TestGroveViews.testsUnder(TG, tree);
  assertEqual(rows.length, 100, 'rows');
  const folder = tree.children[0];
  let n = 0; for (const x of TG.walk(folder)) if (x.kind === 'test') n++;
  assertEqual(sandbox.TestGroveViews.testsUnder(TG, folder).length, n, 'scoped rows');
  assert(rows.filter((r) => r.status === 'skipped').every((r) => r.duration === null), 'skipped tests never ran: no duration');
});

test('failure clusters group the same failure, whatever the numbers', () => {
  const sig = sandbox.TestGroveViews.signature;
  assertEqual(sig('Timeout 5000ms exceeded.\nwaiting for x'), sig('Timeout 30000ms exceeded.'), 'timeouts');
  assertEqual(sig('expect(received).toBe(expected)\n\nExpected: 200\nReceived: 500'), 'expect(received).toBe(expected)', 'first line only');
  assert(sig('Expected "3 items"') === sig('Expected "Your cart is empty"'), 'quoted values');
});

console.log('\n== Leaf design language ==');

const leafOf = (status, extra) => LEAF.leafVisual({ id: 'x-' + status, status, ...(extra || {}) });

test('leafVisual is pure: same test → identical visual', () => {
  assertEqual(JSON.stringify(leafOf('passing', { metadata: { duration: 1200 } })),
              JSON.stringify(leafOf('passing', { metadata: { duration: 1200 } })));
});

test('geometry depends only on identity, never on the result', () => {
  const pose = (st) => { const v = LEAF.leafVisual({ id: 'same-test', status: st, metadata: { duration: st === 'failing' ? 9000 : 40 } });
                         return [v.scale, v.lift, v.turnX, v.side].join(','); };
  const ref = pose('passing');
  for (const st of ['failing', 'flaky', 'skipped', 'pending']) assertEqual(pose(st), ref, `${st} pose`);
});

test('every status has its own SHAPE, not just a colour', () => {
  const sig = (st) => { const v = leafOf(st); return [v.jagged, v.splitLight, v.hollow, v.bud, v.wilt].join(','); };
  const sigs = ['passing', 'failing', 'flaky', 'skipped', 'pending'].map(sig);
  assertEqual(new Set(sigs).size, 5, `shape signatures ${sigs.join(' | ')}`);
});

test('more retries → the flaky leaf turns further', () => {
  assert(leafOf('flaky', { metadata: { retryCount: 3 } }).turnLevel > leafOf('flaky', { metadata: { retryCount: 1 } }).turnLevel, 'turn level');
});

test('unknown status falls back safely to a bud', () => {
  assertEqual(LEAF.leafVisual({ id: 'q', status: 'weird' }).status, 'pending');
});

console.log(`\n== Result: ${passed} passed, ${failed} failed ==\n`);
process.exit(failed === 0 ? 0 : 1);
