/**
 * TestGrove — Layout Types (L3)
 *
 * The output of the layout engine — a pure geometric description of the tree
 * ready to be rendered by any renderer (SVG, Canvas, WebGL, VS Code webview).
 */

import { NodeKind, TestStatus } from '../domain/types';

/**
 * A single positioned node in the layout.
 * All coordinates are in the layout engine's normalized space
 * (units are arbitrary; the renderer scales them to pixels).
 */
export interface LayoutNode {
  readonly id: string;
  readonly kind: NodeKind;
  readonly status: TestStatus;
  readonly name: string;
  readonly path: string;

  /** Position of this node's tip (where its own segment ends). */
  readonly position: { readonly x: number; readonly y: number };

  /** Position of this node's origin (where its segment starts — the parent's tip). */
  readonly origin: { readonly x: number; readonly y: number };

  /** Growth direction in radians. 0 = right, π/2 = up. */
  readonly angle: number;

  /** Segment thickness. Trunk is thickest; leaves are effectively 0. */
  readonly thickness: number;

  /** Depth from root. Root = 0. */
  readonly depth: number;

  /** Number of leaves in this subtree — the "weight" this node carries. */
  readonly leafCount: number;
}

/**
 * Complete layout output.
 */
export interface TreeLayout {
  readonly nodes: readonly LayoutNode[];

  /** Bounding box of the entire layout, useful for viewport fitting. */
  readonly bounds: {
    readonly minX: number;
    readonly minY: number;
    readonly maxX: number;
    readonly maxY: number;
  };

  /** Map from node ID to LayoutNode for O(1) lookup. */
  readonly byId: ReadonlyMap<string, LayoutNode>;
}

/**
 * Configuration for the layout engine. All optional with sensible defaults.
 */
export interface LayoutConfig {
  /** Total angular spread of the root (in radians). Default: 160° (leaves 100° sky). */
  readonly rootSpread?: number;

  /** How much of parent's slice each child level inherits. Default: 0.65 (golden-ish). */
  readonly childSpreadRatio?: number;

  /** How much branch length shrinks at each depth. Default: 0.68 ≈ 1/φ. */
  readonly taperRatio?: number;

  /** Length of the trunk in layout units. Default: 100. */
  readonly trunkLength?: number;

  /** Length of major branches in layout units. Default: 70. */
  readonly majorBranchLength?: number;

  /** Random seed for deterministic organic jitter. Default: fixed constant. */
  readonly jitterSeed?: number;

  /** Amount of jitter in radians. Default: 0 (perfect symmetry). Higher = more organic. */
  readonly jitterAmount?: number;
}
