/**
 * TestGrove — Mock Test Tree Generator (dev/demo utility)
 *
 * Generates a realistic-looking test tree for the prototype and tests.
 * Deterministic when given a seed. Not part of the shipped library — this
 * lives here so demos and tests can share the same shape.
 */

import { TestNode, TestStatus } from '../domain/types';
import { createTestNode } from '../domain/TestNode';
import { makeRng } from '../layout/geometry';

interface MockConfig {
  /** Approximate total number of test leaves to generate. */
  totalTests: number;

  /** Approximate distribution of statuses. Must sum to ~1.0. */
  statusMix: {
    passing: number;
    failing: number;
    flaky: number;
    skipped: number;
  };

  /** Seed for the RNG. Same seed → same tree. */
  seed: number;

  /**
   * Spec files whose beforeAll hook fails. Playwright reports this as the
   * first test failing (with the hook error) and the rest never running
   * (skipped). Opt-in, so default trees are unchanged.
   */
  setupFailures: string[];
}

const DEFAULT_MOCK: MockConfig = {
  totalTests: 100,
  statusMix: { passing: 0.87, failing: 0.08, flaky: 0.05, skipped: 0.0 },
  seed: 42,
  setupFailures: [],
};

/**
 * A realistic project shape — feature folders, each with a few spec files,
 * each with several tests. Structure taken from the Figma mockup.
 */
const PROJECT_SHAPE: {
  folder: string;
  specs: { file: string; tests: string[] }[];
}[] = [
  {
    folder: 'auth',
    specs: [
      { file: 'login.spec.ts', tests: [
        'accepts valid credentials', 'rejects invalid password', 'locks after 5 attempts',
        'supports SSO redirect', 'preserves redirect URL', 'clears token on logout',
      ] },
      { file: 'register.spec.ts', tests: [
        'creates new user', 'validates email format', 'requires strong password',
        'sends verification email', 'prevents duplicate emails',
      ] },
      { file: 'session.spec.ts', tests: [
        'persists across reload', 'expires after timeout', 'refreshes silently',
      ] },
    ],
  },
  {
    folder: 'checkout',
    specs: [
      { file: 'cart.spec.ts', tests: [
        'adds item', 'removes item', 'updates quantity', 'calculates total',
        'applies discount code', 'handles empty cart',
      ] },
      { file: 'payment.spec.ts', tests: [
        'accepts saved card', 'rejects expired card', 'restores session after redirect',
        'handles 3DS redirect', 'shows declined payment', 'supports Apple Pay',
      ] },
      { file: 'confirmation.spec.ts', tests: [
        'shows order number', 'sends confirmation email', 'redirects to orders page',
      ] },
      { file: 'cart-recovery.spec.ts', tests: [
        'preserves cart after sign in', 'restores after browser close',
      ] },
    ],
  },
  {
    folder: 'user',
    specs: [
      { file: 'profile.spec.ts', tests: [
        'displays user info', 'edits name', 'uploads avatar', 'changes email',
        'validates avatar size', 'shows edit history',
      ] },
      { file: 'preferences.spec.ts', tests: [
        'saves theme preference', 'toggles notifications', 'sets language',
      ] },
    ],
  },
  {
    folder: 'api',
    specs: [
      { file: 'health.spec.ts', tests: [
        'GET /health returns 200', 'reports uptime', 'reports version',
      ] },
      { file: 'endpoints.spec.ts', tests: [
        'GET /users', 'POST /users', 'GET /users/:id',
        'PATCH /users/:id', 'DELETE /users/:id', 'handles rate limit',
      ] },
      { file: 'orders.spec.ts', tests: [
        'GET /orders', 'POST /orders', 'GET /orders/:id',
        'cancels order', 'refunds order',
      ] },
    ],
  },
  {
    folder: 'home',
    specs: [
      { file: 'navigation.spec.ts', tests: [
        'renders hero', 'nav links work', 'search bar opens', 'menu toggles on mobile',
      ] },
      { file: 'settings.spec.ts', tests: [
        'opens settings drawer', 'saves changes', 'closes on escape',
      ] },
    ],
  },
];

const ERRORS = [
  { message: 'expect(locator).toHaveText(expected)\n\nExpected: "3 items"\nReceived: "Your cart is empty"' },
  { message: 'Timeout 5000ms exceeded.\nwaiting for getByRole(\'button\', { name: \'Pay now\' })' },
  { message: 'expect(received).toBe(expected)\n\nExpected: 200\nReceived: 500' },
  { message: 'locator.click: Target closed' },
  { message: 'expect(page).toHaveURL(expected)\n\nExpected: "/orders"\nReceived: "/login?next=/orders"' },
];

function mockError(rng: () => number, specPath: string, hook: boolean) {
  const base = hook
    ? { message: 'beforeAll hook failed: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/checkout' }
    : ERRORS[Math.floor(rng() * ERRORS.length)];
  return { ...base, file: specPath, line: 10 + Math.floor(rng() * 80) };
}

function pickStatus(rng: () => number, mix: MockConfig['statusMix']): TestStatus {
  const r = rng();
  let cum = 0;
  cum += mix.passing;  if (r < cum) return 'passing';
  cum += mix.failing;  if (r < cum) return 'failing';
  cum += mix.flaky;    if (r < cum) return 'flaky';
  cum += mix.skipped;  if (r < cum) return 'skipped';
  return 'passing';
}

/**
 * Generate a realistic test tree.
 * Deterministic given the same config.
 */
export function generateMockTree(cfg: Partial<MockConfig> = {}): TestNode {
  const config: MockConfig = {
    totalTests: cfg.totalTests ?? DEFAULT_MOCK.totalTests,
    statusMix: cfg.statusMix ?? DEFAULT_MOCK.statusMix,
    seed: cfg.seed ?? DEFAULT_MOCK.seed,
    setupFailures: cfg.setupFailures ?? [],
  };

  const rng = makeRng(config.seed);
  const rootPath = 'tests';

  // Flatten desired-test list from shape, then downsample/upsample to hit totalTests.
  const declared: { folder: string; spec: string; test: string }[] = [];
  for (const f of PROJECT_SHAPE) {
    for (const s of f.specs) {
      for (const t of s.tests) {
        declared.push({ folder: f.folder, spec: s.file, test: t });
      }
    }
  }

  // If we want more tests than the shape provides, repeat with numeric suffixes.
  const target = Math.max(1, config.totalTests);
  const tests: { folder: string; spec: string; test: string }[] = [];
  for (let i = 0; i < target; i++) {
    const base = declared[i % declared.length];
    const suffix = Math.floor(i / declared.length);
    tests.push({
      folder: base.folder,
      spec: base.spec,
      test: suffix === 0 ? base.test : `${base.test} #${suffix + 1}`,
    });
  }

  // Group into folders → specs → tests.
  const folderMap = new Map<string, Map<string, string[]>>();
  for (const t of tests) {
    if (!folderMap.has(t.folder)) folderMap.set(t.folder, new Map());
    const specMap = folderMap.get(t.folder)!;
    if (!specMap.has(t.spec)) specMap.set(t.spec, []);
    specMap.get(t.spec)!.push(t.test);
  }

  // Build TestNodes bottom-up.
  const folderNodes: TestNode[] = [];
  const sortedFolders = [...folderMap.keys()].sort();
  for (const folderName of sortedFolders) {
    const specMap = folderMap.get(folderName)!;
    const folderPath = `${rootPath}/${folderName}`;
    const specNodes: TestNode[] = [];
    const sortedSpecs = [...specMap.keys()].sort();
    for (const specName of sortedSpecs) {
      const specPath = `${folderPath}/${specName}`;
      const testNames = specMap.get(specName)!;
      const setupBroken = config.setupFailures.includes(specName);
      const testNodes: TestNode[] = testNames.map((testName, i) => {
        const testPath = `${specPath}::${testName}`;
        let status = pickStatus(rng, config.statusMix);
        const duration = Math.round(20 + rng() * 4800);
        if (setupBroken) status = i === 0 ? 'failing' : 'skipped';
        return createTestNode({
          kind: 'test',
          name: testName,
          path: testPath,
          status,
          metadata: {
            duration: status === 'skipped' ? 0 : duration,
            ...(status === 'flaky' ? { retryCount: 1 + Math.floor(rng() * 3) } : {}),
            ...(status === 'failing' ? { error: mockError(rng, specPath, setupBroken && i === 0) } : {}),
          },
        });
      });
      specNodes.push(createTestNode({
        kind: 'spec',
        name: specName,
        path: specPath,
        children: testNodes,
      }));
    }
    folderNodes.push(createTestNode({
      kind: 'folder',
      name: folderName,
      path: folderPath,
      children: specNodes,
    }));
  }

  return createTestNode({
    kind: 'root',
    name: 'tests',
    path: rootPath,
    children: folderNodes,
  });
}
