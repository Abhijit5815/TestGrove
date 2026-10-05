/**
 * TestGrove — Parser Interface (L1)
 *
 * All framework adapters implement this contract.
 *
 * Contract:
 *   - `parse(input)` MUST be pure. No I/O. No time. No mutation.
 *   - The returned tree MUST satisfy the domain invariants (see TestNode.ts).
 *   - The parser is responsible for stable path construction so that the same
 *     source tree produces the same node IDs across runs.
 */

import { TestNode } from '../domain/types';

export interface TestParser<TInput = unknown> {
  /** Human-readable name of this framework, e.g. "playwright". */
  readonly frameworkName: string;

  /** Parse framework output into an immutable TestNode tree. */
  parse(input: TInput): TestNode;
}
