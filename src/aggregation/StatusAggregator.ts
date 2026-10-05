/**
 * TestGrove — Status Aggregator (L2)
 *
 * Bottom-up propagation of leaf statuses to parent nodes.
 * Pure function. No side effects.
 *
 * The rule (in priority order):
 *   1. any child failing         → failing
 *   2. any child flaky           → flaky
 *   3. any child pending         → pending
 *   4. all children skipped      → skipped
 *   5. otherwise                 → passing
 */

import { TestNode, TestStatus, TreeStats } from '../domain/types';
import { isLeaf, walk } from '../domain/TestNode';

function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') return obj;
  Object.freeze(obj);
  for (const key of Object.keys(obj as object)) {
    const value = (obj as Record<string, unknown>)[key];
    if (value && typeof value === 'object' && !Object.isFrozen(value)) deepFreeze(value);
  }
  return obj;
}

/**
 * Aggregate children statuses to a parent status.
 * @internal exported for unit tests
 */
export function aggregateStatuses(childStatuses: readonly TestStatus[]): TestStatus {
  if (childStatuses.length === 0) return 'pending';

  let hasFailing = false;
  let hasFlaky = false;
  let hasPending = false;
  let hasPassing = false;
  let hasNonSkipped = false;

  for (const s of childStatuses) {
    if (s === 'failing') hasFailing = true;
    else if (s === 'flaky') hasFlaky = true;
    else if (s === 'pending') hasPending = true;
    else if (s === 'passing') hasPassing = true;
    if (s !== 'skipped') hasNonSkipped = true;
  }

  if (hasFailing) return 'failing';
  if (hasFlaky) return 'flaky';
  if (hasPending) return 'pending';
  if (!hasNonSkipped) return 'skipped';
  if (hasPassing) return 'passing';
  return 'pending';
}

/**
 * Recursively compute aggregated statuses. Returns a new tree.
 * Leaves are untouched. Non-leaves have their `status` derived from children.
 */
export function propagateStatuses(root: TestNode): TestNode {
  if (isLeaf(root)) return root;

  const newChildren = root.children.map(propagateStatuses);
  const aggregatedStatus = aggregateStatuses(newChildren.map((c) => c.status));

  // Structural sharing: only allocate if something actually changed.
  const childrenIdentical = newChildren.every((c, i) => c === root.children[i]);
  if (childrenIdentical && root.status === aggregatedStatus) return root;

  return deepFreeze({
    ...root,
    status: aggregatedStatus,
    children: Object.freeze(newChildren),
  });
}

/**
 * Compute tree-wide statistics.
 * Pure. O(N) over the tree.
 */
export function computeStats(root: TestNode): TreeStats {
  let passing = 0;
  let failing = 0;
  let flaky = 0;
  let skipped = 0;
  let pending = 0;

  for (const node of walk(root)) {
    if (!isLeaf(node)) continue;
    switch (node.status) {
      case 'passing': passing++; break;
      case 'failing': failing++; break;
      case 'flaky':   flaky++;   break;
      case 'skipped': skipped++; break;
      case 'pending': pending++; break;
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
    healthScore,
  });
}
