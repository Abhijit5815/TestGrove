/**
 * TestGrove — Layout Engine (L3)
 *
 * The L-system + weighted radial allocation algorithm.
 *
 * INPUT:  an immutable TestTree (a TestNode root)
 * OUTPUT: an immutable TreeLayout with 2D coordinates for every node
 *
 * PROPERTIES:
 *   - Pure: same input → identical output
 *   - Deterministic: no wall-clock, no Date, no Math.random directly
 *   - Stable: adding a leaf under one branch does not reshuffle other branches
 *   - O(N) in number of nodes
 *
 * COORDINATE SYSTEM:
 *   - Origin (0, 0) is the base of the trunk.
 *   - Y axis grows UP (positive = higher on the tree).
 *   - X axis grows RIGHT.
 *   - Renderers must flip Y for screen space (SVG has Y-down).
 */

import { TestNode, NodeKind } from '../domain/types';
import { isLeaf, countLeaves } from '../domain/TestNode';
import {
  LayoutNode,
  TreeLayout,
  LayoutConfig,
} from './types';
import { polar, makeRng, clamp } from './geometry';

// ============================================================================
// Constants (defaults)
// ============================================================================

const DEFAULT_ROOT_SPREAD = (160 * Math.PI) / 180;    // 160° total spread for major branches
const DEFAULT_CHILD_SPREAD_RATIO = 0.65;              // children inherit 65% of parent's slice
const DEFAULT_TAPER_RATIO = 0.68;                     // 1/φ — natural branch shortening
const DEFAULT_TRUNK_LENGTH = 100;
const DEFAULT_MAJOR_BRANCH_LENGTH = 70;
const DEFAULT_JITTER_SEED = 1618;                     // φ×1000, because we're that person
const DEFAULT_JITTER_AMOUNT = 0.08;                   // ~4.5° max jitter — subtle

/** Thickness at each kind, in layout units. Renderers scale as they wish. */
const THICKNESS_BY_KIND: Record<NodeKind, number> = {
  root:   14,
  folder:  8,
  spec:    4,
  suite:   2.5,
  test:    1.2,
};

// ============================================================================
// Engine
// ============================================================================

export class LayoutEngine {
  private constructor() {} // static-only

  /**
   * Compute a full layout for a test tree.
   *
   * @param root  the tree root (immutable TestNode)
   * @param cfg   optional configuration overrides
   */
  static compute(root: TestNode, cfg: LayoutConfig = {}): TreeLayout {
    const config = {
      rootSpread:        cfg.rootSpread        ?? DEFAULT_ROOT_SPREAD,
      childSpreadRatio:  cfg.childSpreadRatio  ?? DEFAULT_CHILD_SPREAD_RATIO,
      taperRatio:        cfg.taperRatio        ?? DEFAULT_TAPER_RATIO,
      trunkLength:       cfg.trunkLength       ?? DEFAULT_TRUNK_LENGTH,
      majorBranchLength: cfg.majorBranchLength ?? DEFAULT_MAJOR_BRANCH_LENGTH,
      jitterSeed:        cfg.jitterSeed        ?? DEFAULT_JITTER_SEED,
      jitterAmount:      cfg.jitterAmount      ?? DEFAULT_JITTER_AMOUNT,
    };

    const rng = makeRng(config.jitterSeed);
    const nodes: LayoutNode[] = [];

    // Step 1: place the trunk (root). It grows straight up from (0, 0).
    const rootOrigin = { x: 0, y: 0 };
    const rootTip    = { x: 0, y: config.trunkLength };
    const rootLayout: LayoutNode = Object.freeze({
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
      leafCount: countLeaves(root),
    });
    nodes.push(rootLayout);

    // Step 2: recursively lay out children of root, fanning out from rootTip.
    // Major branches start with the configured spread.
    LayoutEngine.layoutChildren({
      children: root.children,
      parentTip: rootTip,
      parentAngle: Math.PI / 2,
      spread: config.rootSpread,
      length: config.majorBranchLength,
      depth: 1,
      config,
      rng,
      out: nodes,
    });

    // Compute bounding box in one pass.
    let minX = 0, minY = 0, maxX = 0, maxY = 0;
    for (const n of nodes) {
      if (n.position.x < minX) minX = n.position.x;
      if (n.position.x > maxX) maxX = n.position.x;
      if (n.position.y < minY) minY = n.position.y;
      if (n.position.y > maxY) maxY = n.position.y;
      if (n.origin.x < minX) minX = n.origin.x;
      if (n.origin.x > maxX) maxX = n.origin.x;
      if (n.origin.y < minY) minY = n.origin.y;
      if (n.origin.y > maxY) maxY = n.origin.y;
    }

    // Build ID index.
    const byId = new Map<string, LayoutNode>();
    for (const n of nodes) byId.set(n.id, n);

    return Object.freeze({
      nodes: Object.freeze(nodes),
      bounds: Object.freeze({ minX, minY, maxX, maxY }),
      byId,
    });
  }

  /**
   * Recursive helper. Places `children` inside an angular slice of width
   * `spread` centered on `parentAngle`, growing from `parentTip`.
   *
   * The angular slice is allocated to children *proportionally to their leaf count* —
   * this is what keeps the tree balanced by content weight, not by naive child count.
   */
  private static layoutChildren(args: {
    children: readonly TestNode[];
    parentTip: { x: number; y: number };
    parentAngle: number;
    spread: number;
    length: number;
    depth: number;
    config: Required<LayoutConfig>;
    rng: () => number;
    out: LayoutNode[];
  }): void {
    const { children, parentTip, parentAngle, spread, length, depth, config, rng, out } = args;
    if (children.length === 0) return;

    // Sort children by ID for determinism. (In practice IDs come from paths,
    // which are already deterministic, but sort defensively.)
    const sorted = [...children].sort((a, b) => a.id.localeCompare(b.id));

    // Weight each child by its leaf count. Minimum weight of 1 so a solitary
    // leaf still gets some angular slice.
    const weights = sorted.map((c) => Math.max(1, countLeaves(c)));
    const totalWeight = weights.reduce((s, w) => s + w, 0);

    // Cursor sweeps across the slice from one edge to the other.
    // Start at the leftmost edge of the slice, in the local frame of parent.
    // Then convert to world angle.
    let cursorFraction = 0; // 0..1 across the slice

    for (let i = 0; i < sorted.length; i++) {
      const child = sorted[i];
      const weight = weights[i];
      const childSliceFraction = weight / totalWeight;

      // The center of this child's slice, as a fraction along [0..1].
      const centerFraction = cursorFraction + childSliceFraction / 2;

      // Map fraction → offset from parentAngle in [-spread/2, +spread/2].
      const angleOffset = (centerFraction - 0.5) * spread;

      // Deterministic jitter: seeded RNG produces the same value for the same
      // traversal order. Zero if config.jitterAmount = 0.
      const jitter = (rng() - 0.5) * 2 * config.jitterAmount;

      const childAngle = parentAngle + angleOffset + jitter;

      // Length scales down as we go deeper.
      // Leaves get a small "petiole" so they visually attach off the branch tip.
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
        leafCount: isChildLeaf ? 1 : countLeaves(child),
      }));

      // Recurse — this child gets a fraction of the current slice.
      if (!isChildLeaf) {
        LayoutEngine.layoutChildren({
          children: child.children,
          parentTip: childTip,
          parentAngle: childAngle,
          spread: spread * childSliceFraction * config.childSpreadRatio *
                  // Scale up slightly when a child has only one child of its own,
                  // so its subtree doesn't collapse to a line.
                  clamp(1 + 1 / child.children.length, 1, 1.5),
          length: length * config.taperRatio,
          depth: depth + 1,
          config,
          rng,
          out,
        });
      }

      cursorFraction += childSliceFraction;
    }
  }
}
