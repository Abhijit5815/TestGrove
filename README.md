# TestGrove

> A Playwright test suite as a living tree. **Every leaf is exactly one test.**

## Status: v0.5 — the tree is the data map

The painted tree is no longer a background with lines drawn over it. Its glass
branches carry the results: each branch is lit from within in the colour of
the tests it feeds, the wooden trunk stays wood, and the world behind the tree
sits out of focus.

## Run it

```bash
npm install          # once
npm run build        # bundles src/ → prototype/testgrove-bundle.js + the extension
npm test             # invariant suite (node, no browser needed)
```

Then either:

- **Browser** — open `prototype/index.html` (or `npm run prototype` → http://localhost:8080)
- **VS Code** — open this folder, press **F5**, then in the new window run
  **TestGrove: Open the grove** from the command palette

Both show mock data until live Playwright runs land (v0.6).

## What you see

| | |
|---|---|
| **Leaves** | One per test. Passing: deep forest green at the stem → luminous emerald edges. Failing: burgundy → crimson, withered and jagged. Flaky: quieter amber, lit on one half. Skipped: slate, hollow. Running: a closed bud. Every status has its own *shape*, so it reads without colour vision. |
| **Branches** | Folders are major limbs, spec files sub-branches. Glass carries light in the share of what it feeds (red only where most of it fails). A thin filament inside the light is solid when healthy, broken when failing, dotted when flaky. Past a spec whose setup failed, the glass goes dark. |
| **World** | Peaceful → unsettled → stormy → eerie as the pass rate falls. Depth of field keeps the tree in focus and the world behind it quiet. |
| **Hover** | A leaf lifts (never touching a neighbour) and traces its sap path. A branch lights its whole subtree and the rest recedes. |
| **Fly in** | Double-click a branch, knot or pod: that folder or file becomes a tree of its own. Breadcrumbs or **Esc** fly back out. |
| **Pods** | When a scope has too many tests to show every leaf legibly, each spec file hangs as a glass pod filled with its results (failing at the bottom). Fly into a pod to see its leaves. |
| **List / Stats** | `2` / `3` (or the bottom bar). The tree recedes; a dense sortable grid (↑/↓, Enter, `/` to search) or the stats: pass rate, health by folder, failure clusters, slowest and flaky tests. Everything reads the same scope. |
| **Legend** | Click a result in the status card to light only those leaves. |

## Layout

```
testgrove/
├── src/                          TypeScript core — the single source of truth
│   ├── domain/                   TestNode, statuses, immutable tree ops
│   ├── aggregation/              status roll-up + stats
│   ├── parsers/                  Playwright JSON reporter → TestNode tree
│   ├── layout/                   L-system model (kept for parity)
│   └── mock/                     deterministic demo suites
├── prototype/                    the UI (also what the extension's webview loads)
│   ├── index.html                markup + styles
│   ├── app.js                    controller: state, the one refresh path, zoom, keys
│   ├── views.js                  List and Stats
│   ├── tree-renderer.js          world layer (scene + light in the glass) + glyph layer
│   ├── grove-layout.js           pure geometry: placement, sap network (Node-testable)
│   ├── leaf.js                   leaf and pod design (pure visual params + drawing)
│   ├── tree-anatomy.js           GENERATED — where leaves can grow, per mood
│   ├── tree-scene.js             GENERATED — which scene layers exist
│   └── assets/
│       ├── tree-*.png            source paintings
│       ├── scene-*.jpg           GENERATED — depth of field, frosted glass
│       └── glass-*.png           GENERATED — where the glass is (light mask)
├── tools/                        offline Python pipeline (numpy, scipy, scikit-image, opencv, scikit-learn)
│   ├── build_anatomy.py          branch detection → tree-anatomy.js
│   └── build_scene.py            glass/bark/sky classifier, depth of field → scene layers
├── extension/src/extension.ts    VS Code webview host
└── tests/invariants.test.js
```

Replacing a painting? Re-run both pipelines:

```bash
npm run anatomy    # leaf slots + clearance + sap axis
npm run scene      # depth of field + glass mask (~45 s per painting)
```

## Design rules the tests hold

1. **One leaf = one test**, and the legend always equals what is drawn (a runtime guard checks it).
2. **No overlap, ever** — not between leaves, not with the trunk, not under the UI, not when a leaf lifts on hover.
3. **A stable map** — a leaf's place depends only on its test's identity, never on its result.
4. **Folders own contiguous branches**; a junction sits where a group's sap really parts.
5. **Every scope is a tree** — flying into a folder makes its files the limbs.
6. **Too big to read → pods**, never a crash and never unreadable specks.

## Next

- **v0.6** live Playwright runs (stream the reporter into `renderer.startRun()` — the
  session API the simulated run already uses)
- **v0.7** "Ask AI why it failed" provider
- Extension 2: the project topology visualiser
