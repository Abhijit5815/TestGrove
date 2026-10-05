/**
 * TestGrove — Playwright Parser (L1)
 *
 * Adapts Playwright's JSON reporter output into a canonical TestNode tree.
 *
 * Playwright JSON reporter schema (relevant subset):
 *   {
 *     "suites": [                            // top-level = spec files, grouped by dir
 *       {
 *         "title": "auth/login.spec.ts",
 *         "file":  "tests/auth/login.spec.ts",
 *         "specs": [                         // individual test() calls (may be
 *           { title, file, ok, tests: [...] } //  nested via describe blocks)
 *         ],
 *         "suites": [ ... ]                  // nested describe() blocks
 *       }
 *     ]
 *   }
 *
 * We normalize to:
 *   root(tests/) → folder(auth/) → spec(login.spec.ts) → [suite(describe)…] → test(leaf)
 *
 * NOTE: This parser is defensive — it doesn't crash on unknown shapes.
 *       Unknown fields are ignored. Missing children collapse gracefully.
 */

import { TestNode, TestStatus, TestError, TestMetadata } from '../domain/types';
import { createTestNode } from '../domain/TestNode';
import { TestParser } from './Parser';

// ============================================================================
// Playwright JSON reporter type surface (minimal, permissive)
// ============================================================================

export interface PwJsonReport {
  readonly suites?: readonly PwSuite[];
  readonly config?: unknown;
  readonly stats?: unknown;
}

export interface PwSuite {
  readonly title?: string;
  readonly file?: string;
  readonly specs?: readonly PwSpec[];
  readonly suites?: readonly PwSuite[];
}

export interface PwSpec {
  readonly title?: string;
  readonly file?: string;
  readonly ok?: boolean;
  readonly tests?: readonly PwTest[];
}

export interface PwTest {
  readonly projectId?: string;
  readonly status?: 'expected' | 'unexpected' | 'flaky' | 'skipped';
  readonly annotations?: readonly { type: string; description?: string }[];
  readonly results?: readonly PwResult[];
}

export interface PwResult {
  readonly status?: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';
  readonly duration?: number;
  readonly retry?: number;
  readonly error?: PwErrorShape;
  readonly errors?: readonly PwErrorShape[];
}

export interface PwErrorShape {
  readonly message?: string;
  readonly stack?: string;
  readonly location?: { file?: string; line?: number };
}

// ============================================================================
// Status mapping
// ============================================================================

function mapPwStatus(pw: PwTest | undefined): TestStatus {
  if (!pw) return 'pending';
  switch (pw.status) {
    case 'expected':   return 'passing';
    case 'unexpected': return 'failing';
    case 'flaky':      return 'flaky';
    case 'skipped':    return 'skipped';
    default:           return 'pending';
  }
}

function mapPwError(result: PwResult | undefined): TestError | undefined {
  if (!result) return undefined;
  const src = result.error ?? result.errors?.[0];
  if (!src) return undefined;
  return {
    message: src.message ?? 'Unknown error',
    stack:   src.stack,
    file:    src.location?.file,
    line:    src.location?.line,
  };
}

function mapPwMetadata(pw: PwTest | undefined): TestMetadata {
  const result = pw?.results?.[pw.results.length - 1]; // last attempt
  return {
    duration:    result?.duration,
    retryCount:  result?.retry,
    error:       mapPwError(result),
  };
}

// ============================================================================
// Path helpers
// ============================================================================

/** Normalize a file path to POSIX form and strip leading "./". */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Split "tests/auth/login.spec.ts" → ["tests", "auth", "login.spec.ts"]. */
function pathSegments(p: string): string[] {
  return normalizePath(p).split('/').filter(Boolean);
}

// ============================================================================
// Tree building
// ============================================================================

/**
 * Intermediate mutable node used only during construction.
 * Frozen into TestNode at the end.
 */
interface BuildNode {
  kind: 'root' | 'folder' | 'spec' | 'suite' | 'test';
  name: string;
  path: string;
  status: TestStatus;
  metadata: TestMetadata;
  children: Map<string, BuildNode>; // keyed by name for dedup
}

function makeBuildNode(kind: BuildNode['kind'], name: string, path: string): BuildNode {
  return {
    kind,
    name,
    path,
    status: 'pending',
    metadata: {},
    children: new Map(),
  };
}

function ensureFolderPath(root: BuildNode, segments: string[]): BuildNode {
  let current = root;
  let cumulative = root.path;
  for (const seg of segments) {
    cumulative = cumulative ? `${cumulative}/${seg}` : seg;
    let child = current.children.get(seg);
    if (!child) {
      child = makeBuildNode('folder', seg, cumulative);
      current.children.set(seg, child);
    }
    current = child;
  }
  return current;
}

function toTestNode(build: BuildNode): TestNode {
  const children: TestNode[] = [];
  for (const child of build.children.values()) {
    children.push(toTestNode(child));
  }
  // Sort by name for deterministic ordering
  children.sort((a, b) => a.name.localeCompare(b.name));

  if (build.kind === 'test') {
    return createTestNode({
      kind: 'test',
      name: build.name,
      path: build.path,
      status: build.status,
      metadata: build.metadata,
    });
  }
  return createTestNode({
    kind: build.kind,
    name: build.name,
    path: build.path,
    status: build.status,
    children,
    metadata: build.metadata,
  });
}

// ============================================================================
// Recursive suite walker
// ============================================================================

function walkPwSuite(
  suite: PwSuite,
  parentPath: string,
  addTest: (specName: string, specFile: string, test: PwTest, index: number) => void
): void {
  // A "suite" here represents either a spec file or a describe block.
  // Its "specs" are individual test declarations.
  for (const spec of suite.specs ?? []) {
    const specName = spec.title ?? '(unnamed)';
    const specFile = normalizePath(spec.file ?? suite.file ?? '');
    for (let i = 0; i < (spec.tests ?? []).length; i++) {
      addTest(specName, specFile, spec.tests![i], i);
    }
  }
  for (const child of suite.suites ?? []) {
    walkPwSuite(child, parentPath, addTest);
  }
}

// ============================================================================
// Parser class
// ============================================================================

export class PlaywrightParser implements TestParser<PwJsonReport> {
  readonly frameworkName = 'playwright';

  parse(input: PwJsonReport): TestNode {
    const root = makeBuildNode('root', 'tests', 'tests');

    for (const topSuite of input.suites ?? []) {
      walkPwSuite(topSuite, '', (specName, specFile, pwTest, index) => {
        if (!specFile) return; // skip tests with no file — can't place them

        const segments = pathSegments(specFile);
        if (segments.length === 0) return;

        // The last segment is the spec file; everything before is folders.
        const specSegment = segments[segments.length - 1];
        const folderSegments = segments.slice(0, -1);

        // Skip a leading "tests" segment if present, since our root IS tests/.
        const effectiveFolders = folderSegments[0] === 'tests'
          ? folderSegments.slice(1)
          : folderSegments;

        // Descend into folder hierarchy
        const folder = ensureFolderPath(root, effectiveFolders);

        // Ensure spec node
        const specPath = `${folder.path}/${specSegment}`;
        let specNode = folder.children.get(specSegment);
        if (!specNode) {
          specNode = makeBuildNode('spec', specSegment, specPath);
          folder.children.set(specSegment, specNode);
        }

        // Add the test as a leaf. Duplicate titles get an index suffix in the
        // path (deterministic) so their IDs stay unique.
        const uniqueName = specNode.children.has(specName)
          ? `${specName} [${index}]`
          : specName;
        const testPath = `${specPath}::${uniqueName}`;
        const testNode = makeBuildNode('test', uniqueName, testPath);
        testNode.status = mapPwStatus(pwTest);
        testNode.metadata = mapPwMetadata(pwTest);
        specNode.children.set(uniqueName, testNode);
      });
    }

    return toTestNode(root);
  }
}
