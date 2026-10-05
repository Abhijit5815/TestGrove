/**
 * TestGrove — TestNode factory + operations (L2)
 *
 * Nodes are constructed via factory functions, not classes. This keeps them
 * plain data that serialises cleanly and can flow across worker boundaries.
 *
 * All constructors return frozen objects (recursively frozen).
 */

import {
  TestNode,
  NodeKind,
  TestStatus,
  TestMetadata,
} from './types';

// ============================================================================
// ID generation — deterministic hash of path
// ============================================================================

/**
 * FNV-1a 32-bit hash. Fast, deterministic, good distribution for our purposes.
 * We do NOT need cryptographic strength — just stability across runs.
 */
function fnv1a(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // Convert to unsigned + hex
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Compute a stable ID for a node given its full path.
 * Same path across runs → same ID. This is critical for the layout
 * engine's determinism guarantee.
 */
export function computeNodeId(kind: NodeKind, path: string): string {
  return `${kind[0]}_${fnv1a(path)}`;
}

// ============================================================================
// Deep freeze helper
// ============================================================================

function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') return obj;
  Object.freeze(obj);
  for (const key of Object.keys(obj as object)) {
    const value = (obj as Record<string, unknown>)[key];
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }
  return obj;
}

// ============================================================================
// Factory
// ============================================================================

export interface CreateNodeInput {
  kind: NodeKind;
  name: string;
  path: string;
  status?: TestStatus;
  children?: TestNode[];
  metadata?: TestMetadata;
}

/**
 * Create a new immutable TestNode.
 * The returned object (and its children, recursively) is deep-frozen.
 */
export function createTestNode(input: CreateNodeInput): TestNode {
  // Invariant: non-leaf must have children
  if (input.kind !== 'test' && (!input.children || input.children.length === 0)) {
    throw new Error(
      `TestNode invariant violated: ${input.kind} "${input.name}" must have children. ` +
      `Only 'test' nodes are leaves.`
    );
  }
  // Invariant: leaf (test) has no children
  if (input.kind === 'test' && input.children && input.children.length > 0) {
    throw new Error(
      `TestNode invariant violated: 'test' node "${input.name}" cannot have children. ` +
      `Tests are atomic leaves.`
    );
  }

  const node: TestNode = {
    id: computeNodeId(input.kind, input.path),
    kind: input.kind,
    name: input.name,
    path: input.path,
    status: input.status ?? 'pending',
    children: Object.freeze([...(input.children ?? [])]),
    metadata: Object.freeze({ ...(input.metadata ?? {}) }),
  };

  return deepFreeze(node);
}

// ============================================================================
// Queries
// ============================================================================

/** True iff the node is a leaf (an actual test). */
export function isLeaf(node: TestNode): boolean {
  return node.kind === 'test';
}

/** Count leaves in a subtree. THIS IS THE ATOM COUNT. */
export function countLeaves(node: TestNode): number {
  if (isLeaf(node)) return 1;
  let sum = 0;
  for (const child of node.children) sum += countLeaves(child);
  return sum;
}

/** Depth-first traversal. Yields every node in the subtree, root first. */
export function* walk(node: TestNode): Generator<TestNode> {
  yield node;
  for (const child of node.children) yield* walk(child);
}

/** All leaves (tests) in a subtree, in DFS order. */
export function* leaves(node: TestNode): Generator<TestNode> {
  for (const n of walk(node)) {
    if (isLeaf(n)) yield n;
  }
}

/** Find a node by ID within a subtree. O(N). */
export function findById(root: TestNode, id: string): TestNode | null {
  for (const n of walk(root)) {
    if (n.id === id) return n;
  }
  return null;
}

// ============================================================================
// Structural update (immutable)
// ============================================================================

/**
 * Replace a node in a tree by ID, returning a new tree.
 * Nodes not on the path from root to the replaced node are structurally
 * shared with the original — no unnecessary allocation.
 */
export function replaceNode(
  root: TestNode,
  targetId: string,
  replacement: TestNode
): TestNode {
  if (root.id === targetId) return replacement;

  let anyChildChanged = false;
  const newChildren = root.children.map((child) => {
    const updated = replaceNode(child, targetId, replacement);
    if (updated !== child) anyChildChanged = true;
    return updated;
  });

  if (!anyChildChanged) return root;

  return deepFreeze({
    ...root,
    children: Object.freeze(newChildren),
  });
}

/**
 * Update a leaf's status (typical hot path — a test result comes in).
 * Returns a new tree with the status change propagated by aggregation.
 * Status aggregation is applied by StatusAggregator, called separately.
 */
export function updateLeafStatus(
  root: TestNode,
  leafId: string,
  status: TestStatus,
  metadata?: TestMetadata
): TestNode {
  const target = findById(root, leafId);
  if (!target || !isLeaf(target)) {
    throw new Error(`Cannot update leaf: ${leafId} not found or not a leaf`);
  }
  const updated = createTestNode({
    kind: target.kind,
    name: target.name,
    path: target.path,
    status,
    metadata: { ...target.metadata, ...(metadata ?? {}) },
  });
  return replaceNode(root, leafId, updated);
}
