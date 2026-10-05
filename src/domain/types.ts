/**
 * TestGrove — Domain Types (L2)
 *
 * Framework-agnostic core types. Zero external dependencies.
 * These types are the vocabulary the rest of the system speaks.
 *
 * INVARIANT: Every `test()` call in source maps to exactly one Leaf node.
 */

/**
 * The atomic status of a test. Mutually exclusive.
 */
export type TestStatus =
  | 'passing'
  | 'failing'
  | 'flaky'
  | 'skipped'
  | 'pending';

/**
 * The kind of node in the test tree.
 *
 * - `root`   : the trunk. There is exactly one per tree.
 * - `folder` : a directory under tests/  (e.g. tests/auth/)
 * - `spec`   : a test file  (e.g. login.spec.ts)
 * - `suite`  : a describe() block within a spec
 * - `test`   : a single test() call  — THE ATOM. THE LEAF.
 */
export type NodeKind = 'root' | 'folder' | 'spec' | 'suite' | 'test';

/**
 * Error attached to a failing test.
 * Kept minimal — enrichment (source snippets, AI hints) happens above.
 */
export interface TestError {
  readonly message: string;
  readonly stack?: string;
  readonly expected?: string;
  readonly actual?: string;
  readonly file?: string;
  readonly line?: number;
}

/**
 * Metadata attached to any node. All fields optional.
 */
export interface TestMetadata {
  readonly duration?: number;      // milliseconds
  readonly error?: TestError;
  readonly lastRun?: number;       // epoch ms
  readonly flakinessScore?: number; // 0-1
  readonly retryCount?: number;
}

/**
 * A node in the test tree.
 *
 * IMMUTABILITY:
 * - All fields are `readonly`
 * - `children` is `readonly` array of `readonly` nodes
 * - Callers should treat instances as frozen. Constructors freeze them.
 *
 * DETERMINISM:
 * - `id` is a deterministic hash of the node's path from root.
 *   Same tests → same IDs across runs.
 */
export interface TestNode {
  readonly id: string;
  readonly kind: NodeKind;
  readonly name: string;
  readonly path: string;                    // dotted path from root, e.g. "tests/auth/login.spec.ts/valid"
  readonly status: TestStatus;
  readonly children: readonly TestNode[];
  readonly metadata: TestMetadata;
}

/**
 * Aggregate stats over a tree (or subtree).
 */
export interface TreeStats {
  readonly totalTests: number;
  readonly passing: number;
  readonly failing: number;
  readonly flaky: number;
  readonly skipped: number;
  readonly pending: number;
  /** Health score in [0, 1]. passing / totalTests. */
  readonly healthScore: number;
}

/**
 * Overall mood derived from health score. Drives the background world.
 * Thresholds match the four Figma frames.
 */
export type WorldMood = 'peaceful' | 'unsettled' | 'stormy' | 'eerie';

export function moodFromHealth(healthScore: number): WorldMood {
  if (healthScore >= 0.9) return 'peaceful';
  if (healthScore >= 0.7) return 'unsettled';
  if (healthScore >= 0.5) return 'stormy';
  return 'eerie';
}
