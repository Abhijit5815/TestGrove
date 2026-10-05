/**
 * TestGrove — Public API
 *
 * Consumers import from this file only. The internal file structure
 * (domain/, layout/, parsers/, etc.) is an implementation detail and
 * may change; the exports here are the stable contract.
 */

// Domain (L2)
export type {
  TestNode,
  NodeKind,
  TestStatus,
  TestMetadata,
  TestError,
  TreeStats,
  WorldMood,
} from './domain/types';
export { moodFromHealth } from './domain/types';
export {
  createTestNode,
  isLeaf,
  countLeaves,
  walk,
  leaves,
  findById,
  replaceNode,
  updateLeafStatus,
  computeNodeId,
} from './domain/TestNode';

// Aggregation (L2)
export {
  propagateStatuses,
  computeStats,
  aggregateStatuses,
} from './aggregation/StatusAggregator';

// Parsers (L1)
export type { TestParser } from './parsers/Parser';
export { PlaywrightParser } from './parsers/PlaywrightParser';
export type {
  PwJsonReport,
  PwSuite,
  PwSpec,
  PwTest,
  PwResult,
  PwErrorShape,
} from './parsers/PlaywrightParser';

// Layout (L3)
import { LayoutEngine } from './layout/LayoutEngine';
import type { LayoutConfig as _LayoutConfig } from './layout/types';
import type { TestNode as _TestNode } from './domain/types';
export { LayoutEngine };
/** Convenience alias for LayoutEngine.compute — the browser prototype uses this. */
export const computeLayout = (root: _TestNode, cfg?: _LayoutConfig) => LayoutEngine.compute(root, cfg);
export type {
  LayoutNode,
  TreeLayout,
  LayoutConfig,
} from './layout/types';

// Mock (dev-only utility)
export { generateMockTree } from './mock/generator';
