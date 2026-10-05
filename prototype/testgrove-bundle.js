"use strict";
var TestGrove = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/index.ts
  var src_exports = {};
  __export(src_exports, {
    LayoutEngine: () => LayoutEngine,
    PlaywrightParser: () => PlaywrightParser,
    aggregateStatuses: () => aggregateStatuses,
    computeLayout: () => computeLayout,
    computeNodeId: () => computeNodeId,
    computeStats: () => computeStats,
    countLeaves: () => countLeaves,
    createTestNode: () => createTestNode,
    findById: () => findById,
    generateMockTree: () => generateMockTree,
    isLeaf: () => isLeaf,
    leaves: () => leaves,
    moodFromHealth: () => moodFromHealth,
    propagateStatuses: () => propagateStatuses,
    replaceNode: () => replaceNode,
    updateLeafStatus: () => updateLeafStatus,
    walk: () => walk
  });

  // src/domain/types.ts
  function moodFromHealth(healthScore) {
    if (healthScore >= 0.9)
      return "peaceful";
    if (healthScore >= 0.7)
      return "unsettled";
    if (healthScore >= 0.5)
      return "stormy";
    return "eerie";
  }

  // src/domain/TestNode.ts
  function fnv1a(str) {
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }
  function computeNodeId(kind, path) {
    return `${kind[0]}_${fnv1a(path)}`;
  }
  function deepFreeze(obj) {
    if (obj === null || typeof obj !== "object")
      return obj;
    Object.freeze(obj);
    for (const key of Object.keys(obj)) {
      const value = obj[key];
      if (value && typeof value === "object" && !Object.isFrozen(value)) {
        deepFreeze(value);
      }
    }
    return obj;
  }
  function createTestNode(input) {
    if (input.kind !== "test" && (!input.children || input.children.length === 0)) {
      throw new Error(
        `TestNode invariant violated: ${input.kind} "${input.name}" must have children. Only 'test' nodes are leaves.`
      );
    }
    if (input.kind === "test" && input.children && input.children.length > 0) {
      throw new Error(
        `TestNode invariant violated: 'test' node "${input.name}" cannot have children. Tests are atomic leaves.`
      );
    }
    const node = {
      id: computeNodeId(input.kind, input.path),
      kind: input.kind,
      name: input.name,
      path: input.path,
      status: input.status ?? "pending",
      children: Object.freeze([...input.children ?? []]),
      metadata: Object.freeze({ ...input.metadata ?? {} })
    };
    return deepFreeze(node);
  }
  function isLeaf(node) {
    return node.kind === "test";
  }
  function countLeaves(node) {
    if (isLeaf(node))
      return 1;
    let sum = 0;
    for (const child of node.children)
      sum += countLeaves(child);
    return sum;
  }
  function* walk(node) {
    yield node;
    for (const child of node.children)
      yield* walk(child);
  }
  function* leaves(node) {
    for (const n of walk(node)) {
      if (isLeaf(n))
        yield n;
    }
  }
  function findById(root, id) {
    for (const n of walk(root)) {
      if (n.id === id)
        return n;
    }
    return null;
  }
  function replaceNode(root, targetId, replacement) {
    if (root.id === targetId)
      return replacement;
    let anyChildChanged = false;
    const newChildren = root.children.map((child) => {
      const updated = replaceNode(child, targetId, replacement);
      if (updated !== child)
        anyChildChanged = true;
      return updated;
    });
    if (!anyChildChanged)
      return root;
    return deepFreeze({
      ...root,
      children: Object.freeze(newChildren)
    });
  }
  function updateLeafStatus(root, leafId, status, metadata) {
    const target = findById(root, leafId);
    if (!target || !isLeaf(target)) {
      throw new Error(`Cannot update leaf: ${leafId} not found or not a leaf`);
    }
    const updated = createTestNode({
      kind: target.kind,
      name: target.name,
      path: target.path,
      status,
      metadata: { ...target.metadata, ...metadata ?? {} }
    });
    return replaceNode(root, leafId, updated);
  }

  // src/aggregation/StatusAggregator.ts
  function deepFreeze2(obj) {
    if (obj === null || typeof obj !== "object")
      return obj;
    Object.freeze(obj);
    for (const key of Object.keys(obj)) {
      const value = obj[key];
      if (value && typeof value === "object" && !Object.isFrozen(value))
        deepFreeze2(value);
    }
    return obj;
  }
  function aggregateStatuses(childStatuses) {
    if (childStatuses.length === 0)
      return "pending";
    let hasFailing = false;
    let hasFlaky = false;
    let hasPending = false;
    let hasPassing = false;
    let hasNonSkipped = false;
    for (const s of childStatuses) {
      if (s === "failing")
        hasFailing = true;
      else if (s === "flaky")
        hasFlaky = true;
      else if (s === "pending")
        hasPending = true;
      else if (s === "passing")
        hasPassing = true;
      if (s !== "skipped")
        hasNonSkipped = true;
    }
    if (hasFailing)
      return "failing";
    if (hasFlaky)
      return "flaky";
    if (hasPending)
      return "pending";
    if (!hasNonSkipped)
      return "skipped";
    if (hasPassing)
      return "passing";
    return "pending";
  }
  function propagateStatuses(root) {
    if (isLeaf(root))
      return root;
    const newChildren = root.children.map(propagateStatuses);
    const aggregatedStatus = aggregateStatuses(newChildren.map((c) => c.status));
    const childrenIdentical = newChildren.every((c, i) => c === root.children[i]);
    if (childrenIdentical && root.status === aggregatedStatus)
      return root;
    return deepFreeze2({
      ...root,
      status: aggregatedStatus,
      children: Object.freeze(newChildren)
    });
  }
  function computeStats(root) {
    let passing = 0;
    let failing = 0;
    let flaky = 0;
    let skipped = 0;
    let pending = 0;
    for (const node of walk(root)) {
      if (!isLeaf(node))
        continue;
      switch (node.status) {
        case "passing":
          passing++;
          break;
        case "failing":
          failing++;
          break;
        case "flaky":
          flaky++;
          break;
        case "skipped":
          skipped++;
          break;
        case "pending":
          pending++;
          break;
      }
    }
    const totalTests = passing + failing + flaky + skipped + pending;
    const healthScore = totalTests === 0 ? 1 : passing / totalTests;
    return Object.freeze({
      totalTests,
      passing,
      failing,
      flaky,
      skipped,
      pending,
      healthScore
    });
  }

  // src/parsers/PlaywrightParser.ts
  function mapPwStatus(pw) {
    if (!pw)
      return "pending";
    switch (pw.status) {
      case "expected":
        return "passing";
      case "unexpected":
        return "failing";
      case "flaky":
        return "flaky";
      case "skipped":
        return "skipped";
      default:
        return "pending";
    }
  }
  function mapPwError(result) {
    if (!result)
      return void 0;
    const src = result.error ?? result.errors?.[0];
    if (!src)
      return void 0;
    return {
      message: src.message ?? "Unknown error",
      stack: src.stack,
      file: src.location?.file,
      line: src.location?.line
    };
  }
  function mapPwMetadata(pw) {
    const result = pw?.results?.[pw.results.length - 1];
    return {
      duration: result?.duration,
      retryCount: result?.retry,
      error: mapPwError(result)
    };
  }
  function normalizePath(p) {
    return p.replace(/\\/g, "/").replace(/^\.\//, "");
  }
  function pathSegments(p) {
    return normalizePath(p).split("/").filter(Boolean);
  }
  function makeBuildNode(kind, name, path) {
    return {
      kind,
      name,
      path,
      status: "pending",
      metadata: {},
      children: /* @__PURE__ */ new Map()
    };
  }
  function ensureFolderPath(root, segments) {
    let current = root;
    let cumulative = root.path;
    for (const seg of segments) {
      cumulative = cumulative ? `${cumulative}/${seg}` : seg;
      let child = current.children.get(seg);
      if (!child) {
        child = makeBuildNode("folder", seg, cumulative);
        current.children.set(seg, child);
      }
      current = child;
    }
    return current;
  }
  function toTestNode(build) {
    const children = [];
    for (const child of build.children.values()) {
      children.push(toTestNode(child));
    }
    children.sort((a, b) => a.name.localeCompare(b.name));
    if (build.kind === "test") {
      return createTestNode({
        kind: "test",
        name: build.name,
        path: build.path,
        status: build.status,
        metadata: build.metadata
      });
    }
    return createTestNode({
      kind: build.kind,
      name: build.name,
      path: build.path,
      status: build.status,
      children,
      metadata: build.metadata
    });
  }
  function walkPwSuite(suite, parentPath, addTest) {
    for (const spec of suite.specs ?? []) {
      const specName = spec.title ?? "(unnamed)";
      const specFile = normalizePath(spec.file ?? suite.file ?? "");
      for (let i = 0; i < (spec.tests ?? []).length; i++) {
        addTest(specName, specFile, spec.tests[i], i);
      }
    }
    for (const child of suite.suites ?? []) {
      walkPwSuite(child, parentPath, addTest);
    }
  }
  var PlaywrightParser = class {
    frameworkName = "playwright";
    parse(input) {
      const root = makeBuildNode("root", "tests", "tests");
      for (const topSuite of input.suites ?? []) {
        walkPwSuite(topSuite, "", (specName, specFile, pwTest, index) => {
          if (!specFile)
            return;
          const segments = pathSegments(specFile);
          if (segments.length === 0)
            return;
          const specSegment = segments[segments.length - 1];
          const folderSegments = segments.slice(0, -1);
          const effectiveFolders = folderSegments[0] === "tests" ? folderSegments.slice(1) : folderSegments;
          const folder = ensureFolderPath(root, effectiveFolders);
          const specPath = `${folder.path}/${specSegment}`;
          let specNode = folder.children.get(specSegment);
          if (!specNode) {
            specNode = makeBuildNode("spec", specSegment, specPath);
            folder.children.set(specSegment, specNode);
          }
          const uniqueName = specNode.children.has(specName) ? `${specName} [${index}]` : specName;
          const testPath = `${specPath}::${uniqueName}`;
          const testNode = makeBuildNode("test", uniqueName, testPath);
          testNode.status = mapPwStatus(pwTest);
          testNode.metadata = mapPwMetadata(pwTest);
          specNode.children.set(uniqueName, testNode);
        });
      }
      return toTestNode(root);
    }
  };

  // src/layout/geometry.ts
  function polar(r, theta) {
    return { x: r * Math.cos(theta), y: r * Math.sin(theta) };
  }
  function makeRng(seed) {
    let state = seed >>> 0;
    return function() {
      state = state + 1831565813 >>> 0;
      let t = state;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function clamp(x, min, max) {
    return Math.max(min, Math.min(max, x));
  }

  // src/layout/LayoutEngine.ts
  var DEFAULT_ROOT_SPREAD = 160 * Math.PI / 180;
  var DEFAULT_CHILD_SPREAD_RATIO = 0.65;
  var DEFAULT_TAPER_RATIO = 0.68;
  var DEFAULT_TRUNK_LENGTH = 100;
  var DEFAULT_MAJOR_BRANCH_LENGTH = 70;
  var DEFAULT_JITTER_SEED = 1618;
  var DEFAULT_JITTER_AMOUNT = 0.08;
  var THICKNESS_BY_KIND = {
    root: 14,
    folder: 8,
    spec: 4,
    suite: 2.5,
    test: 1.2
  };
  var LayoutEngine = class _LayoutEngine {
    constructor() {
    }
    // static-only
    /**
     * Compute a full layout for a test tree.
     *
     * @param root  the tree root (immutable TestNode)
     * @param cfg   optional configuration overrides
     */
    static compute(root, cfg = {}) {
      const config = {
        rootSpread: cfg.rootSpread ?? DEFAULT_ROOT_SPREAD,
        childSpreadRatio: cfg.childSpreadRatio ?? DEFAULT_CHILD_SPREAD_RATIO,
        taperRatio: cfg.taperRatio ?? DEFAULT_TAPER_RATIO,
        trunkLength: cfg.trunkLength ?? DEFAULT_TRUNK_LENGTH,
        majorBranchLength: cfg.majorBranchLength ?? DEFAULT_MAJOR_BRANCH_LENGTH,
        jitterSeed: cfg.jitterSeed ?? DEFAULT_JITTER_SEED,
        jitterAmount: cfg.jitterAmount ?? DEFAULT_JITTER_AMOUNT
      };
      const rng = makeRng(config.jitterSeed);
      const nodes = [];
      const rootOrigin = { x: 0, y: 0 };
      const rootTip = { x: 0, y: config.trunkLength };
      const rootLayout = Object.freeze({
        id: root.id,
        kind: root.kind,
        status: root.status,
        name: root.name,
        path: root.path,
        origin: rootOrigin,
        position: rootTip,
        angle: Math.PI / 2,
        thickness: THICKNESS_BY_KIND[root.kind],
        depth: 0,
        leafCount: countLeaves(root)
      });
      nodes.push(rootLayout);
      _LayoutEngine.layoutChildren({
        children: root.children,
        parentTip: rootTip,
        parentAngle: Math.PI / 2,
        spread: config.rootSpread,
        length: config.majorBranchLength,
        depth: 1,
        config,
        rng,
        out: nodes
      });
      let minX = 0, minY = 0, maxX = 0, maxY = 0;
      for (const n of nodes) {
        if (n.position.x < minX)
          minX = n.position.x;
        if (n.position.x > maxX)
          maxX = n.position.x;
        if (n.position.y < minY)
          minY = n.position.y;
        if (n.position.y > maxY)
          maxY = n.position.y;
        if (n.origin.x < minX)
          minX = n.origin.x;
        if (n.origin.x > maxX)
          maxX = n.origin.x;
        if (n.origin.y < minY)
          minY = n.origin.y;
        if (n.origin.y > maxY)
          maxY = n.origin.y;
      }
      const byId = /* @__PURE__ */ new Map();
      for (const n of nodes)
        byId.set(n.id, n);
      return Object.freeze({
        nodes: Object.freeze(nodes),
        bounds: Object.freeze({ minX, minY, maxX, maxY }),
        byId
      });
    }
    /**
     * Recursive helper. Places `children` inside an angular slice of width
     * `spread` centered on `parentAngle`, growing from `parentTip`.
     *
     * The angular slice is allocated to children *proportionally to their leaf count* —
     * this is what keeps the tree balanced by content weight, not by naive child count.
     */
    static layoutChildren(args) {
      const { children, parentTip, parentAngle, spread, length, depth, config, rng, out } = args;
      if (children.length === 0)
        return;
      const sorted = [...children].sort((a, b) => a.id.localeCompare(b.id));
      const weights = sorted.map((c) => Math.max(1, countLeaves(c)));
      const totalWeight = weights.reduce((s, w) => s + w, 0);
      let cursorFraction = 0;
      for (let i = 0; i < sorted.length; i++) {
        const child = sorted[i];
        const weight = weights[i];
        const childSliceFraction = weight / totalWeight;
        const centerFraction = cursorFraction + childSliceFraction / 2;
        const angleOffset = (centerFraction - 0.5) * spread;
        const jitter = (rng() - 0.5) * 2 * config.jitterAmount;
        const childAngle = parentAngle + angleOffset + jitter;
        const isChildLeaf = isLeaf(child);
        const childLength = isChildLeaf ? Math.max(6, length * 0.35) : length;
        const delta = polar(childLength, childAngle);
        const childTip = { x: parentTip.x + delta.x, y: parentTip.y + delta.y };
        out.push(Object.freeze({
          id: child.id,
          kind: child.kind,
          status: child.status,
          name: child.name,
          path: child.path,
          origin: Object.freeze({ x: parentTip.x, y: parentTip.y }),
          position: Object.freeze(childTip),
          angle: childAngle,
          thickness: THICKNESS_BY_KIND[child.kind],
          depth,
          leafCount: isChildLeaf ? 1 : countLeaves(child)
        }));
        if (!isChildLeaf) {
          _LayoutEngine.layoutChildren({
            children: child.children,
            parentTip: childTip,
            parentAngle: childAngle,
            spread: spread * childSliceFraction * config.childSpreadRatio * // Scale up slightly when a child has only one child of its own,
            // so its subtree doesn't collapse to a line.
            clamp(1 + 1 / child.children.length, 1, 1.5),
            length: length * config.taperRatio,
            depth: depth + 1,
            config,
            rng,
            out
          });
        }
        cursorFraction += childSliceFraction;
      }
    }
  };

  // src/mock/generator.ts
  var DEFAULT_MOCK = {
    totalTests: 100,
    statusMix: { passing: 0.87, failing: 0.08, flaky: 0.05, skipped: 0 },
    seed: 42,
    setupFailures: []
  };
  var PROJECT_SHAPE = [
    {
      folder: "auth",
      specs: [
        { file: "login.spec.ts", tests: [
          "accepts valid credentials",
          "rejects invalid password",
          "locks after 5 attempts",
          "supports SSO redirect",
          "preserves redirect URL",
          "clears token on logout"
        ] },
        { file: "register.spec.ts", tests: [
          "creates new user",
          "validates email format",
          "requires strong password",
          "sends verification email",
          "prevents duplicate emails"
        ] },
        { file: "session.spec.ts", tests: [
          "persists across reload",
          "expires after timeout",
          "refreshes silently"
        ] }
      ]
    },
    {
      folder: "checkout",
      specs: [
        { file: "cart.spec.ts", tests: [
          "adds item",
          "removes item",
          "updates quantity",
          "calculates total",
          "applies discount code",
          "handles empty cart"
        ] },
        { file: "payment.spec.ts", tests: [
          "accepts saved card",
          "rejects expired card",
          "restores session after redirect",
          "handles 3DS redirect",
          "shows declined payment",
          "supports Apple Pay"
        ] },
        { file: "confirmation.spec.ts", tests: [
          "shows order number",
          "sends confirmation email",
          "redirects to orders page"
        ] },
        { file: "cart-recovery.spec.ts", tests: [
          "preserves cart after sign in",
          "restores after browser close"
        ] }
      ]
    },
    {
      folder: "user",
      specs: [
        { file: "profile.spec.ts", tests: [
          "displays user info",
          "edits name",
          "uploads avatar",
          "changes email",
          "validates avatar size",
          "shows edit history"
        ] },
        { file: "preferences.spec.ts", tests: [
          "saves theme preference",
          "toggles notifications",
          "sets language"
        ] }
      ]
    },
    {
      folder: "api",
      specs: [
        { file: "health.spec.ts", tests: [
          "GET /health returns 200",
          "reports uptime",
          "reports version"
        ] },
        { file: "endpoints.spec.ts", tests: [
          "GET /users",
          "POST /users",
          "GET /users/:id",
          "PATCH /users/:id",
          "DELETE /users/:id",
          "handles rate limit"
        ] },
        { file: "orders.spec.ts", tests: [
          "GET /orders",
          "POST /orders",
          "GET /orders/:id",
          "cancels order",
          "refunds order"
        ] }
      ]
    },
    {
      folder: "home",
      specs: [
        { file: "navigation.spec.ts", tests: [
          "renders hero",
          "nav links work",
          "search bar opens",
          "menu toggles on mobile"
        ] },
        { file: "settings.spec.ts", tests: [
          "opens settings drawer",
          "saves changes",
          "closes on escape"
        ] }
      ]
    }
  ];
  var ERRORS = [
    { message: 'expect(locator).toHaveText(expected)\n\nExpected: "3 items"\nReceived: "Your cart is empty"' },
    { message: "Timeout 5000ms exceeded.\nwaiting for getByRole('button', { name: 'Pay now' })" },
    { message: "expect(received).toBe(expected)\n\nExpected: 200\nReceived: 500" },
    { message: "locator.click: Target closed" },
    { message: 'expect(page).toHaveURL(expected)\n\nExpected: "/orders"\nReceived: "/login?next=/orders"' }
  ];
  function mockError(rng, specPath, hook) {
    const base = hook ? { message: "beforeAll hook failed: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/checkout" } : ERRORS[Math.floor(rng() * ERRORS.length)];
    return { ...base, file: specPath, line: 10 + Math.floor(rng() * 80) };
  }
  function pickStatus(rng, mix) {
    const r = rng();
    let cum = 0;
    cum += mix.passing;
    if (r < cum)
      return "passing";
    cum += mix.failing;
    if (r < cum)
      return "failing";
    cum += mix.flaky;
    if (r < cum)
      return "flaky";
    cum += mix.skipped;
    if (r < cum)
      return "skipped";
    return "passing";
  }
  function generateMockTree(cfg = {}) {
    const config = {
      totalTests: cfg.totalTests ?? DEFAULT_MOCK.totalTests,
      statusMix: cfg.statusMix ?? DEFAULT_MOCK.statusMix,
      seed: cfg.seed ?? DEFAULT_MOCK.seed,
      setupFailures: cfg.setupFailures ?? []
    };
    const rng = makeRng(config.seed);
    const rootPath = "tests";
    const declared = [];
    for (const f of PROJECT_SHAPE) {
      for (const s of f.specs) {
        for (const t of s.tests) {
          declared.push({ folder: f.folder, spec: s.file, test: t });
        }
      }
    }
    const target = Math.max(1, config.totalTests);
    const tests = [];
    for (let i = 0; i < target; i++) {
      const base = declared[i % declared.length];
      const suffix = Math.floor(i / declared.length);
      tests.push({
        folder: base.folder,
        spec: base.spec,
        test: suffix === 0 ? base.test : `${base.test} #${suffix + 1}`
      });
    }
    const folderMap = /* @__PURE__ */ new Map();
    for (const t of tests) {
      if (!folderMap.has(t.folder))
        folderMap.set(t.folder, /* @__PURE__ */ new Map());
      const specMap = folderMap.get(t.folder);
      if (!specMap.has(t.spec))
        specMap.set(t.spec, []);
      specMap.get(t.spec).push(t.test);
    }
    const folderNodes = [];
    const sortedFolders = [...folderMap.keys()].sort();
    for (const folderName of sortedFolders) {
      const specMap = folderMap.get(folderName);
      const folderPath = `${rootPath}/${folderName}`;
      const specNodes = [];
      const sortedSpecs = [...specMap.keys()].sort();
      for (const specName of sortedSpecs) {
        const specPath = `${folderPath}/${specName}`;
        const testNames = specMap.get(specName);
        const setupBroken = config.setupFailures.includes(specName);
        const testNodes = testNames.map((testName, i) => {
          const testPath = `${specPath}::${testName}`;
          let status = pickStatus(rng, config.statusMix);
          const duration = Math.round(20 + rng() * 4800);
          if (setupBroken)
            status = i === 0 ? "failing" : "skipped";
          return createTestNode({
            kind: "test",
            name: testName,
            path: testPath,
            status,
            metadata: {
              duration: status === "skipped" ? 0 : duration,
              ...status === "flaky" ? { retryCount: 1 + Math.floor(rng() * 3) } : {},
              ...status === "failing" ? { error: mockError(rng, specPath, setupBroken && i === 0) } : {}
            }
          });
        });
        specNodes.push(createTestNode({
          kind: "spec",
          name: specName,
          path: specPath,
          children: testNodes
        }));
      }
      folderNodes.push(createTestNode({
        kind: "folder",
        name: folderName,
        path: folderPath,
        children: specNodes
      }));
    }
    return createTestNode({
      kind: "root",
      name: "tests",
      path: rootPath,
      children: folderNodes
    });
  }

  // src/index.ts
  var computeLayout = (root, cfg) => LayoutEngine.compute(root, cfg);
  return __toCommonJS(src_exports);
})();
