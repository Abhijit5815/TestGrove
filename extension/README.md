# TestGrove — VS Code Extension shell

Loaded via `main` in the root `package.json`:

```
extension/
├── src/
│   └── extension.ts     ← activate() / deactivate()
├── out/                 ← compiled JS (produced by npm run build)
├── tsconfig.json        ← extension-specific TS config
└── README.md
```

## Run in the Extension Development Host

1. `npm install` at project root
2. `npm run build` — bundles the core (webview JS) AND the extension (Node CJS)
3. In VS Code: press **F5** — opens the "Run Extension (dev host)" launch config
4. In the new VS Code window that opens, run `TestGrove: Open the grove` from the command palette

## Package as .vsix

```
npm run package
```

Produces `testgrove-0.1.0.vsix`. Install locally with:
```
code --install-extension testgrove-0.1.0.vsix
```

## Message passing model

The webview does NOT talk to Playwright directly. It posts messages to the
extension host, which owns the process spawn and file access.

Webview → Extension:
- `{ type: 'openFile', file, line }`   — jump to a test's source
- `{ type: 'askAi',    testName, ... }` — placeholder for AI failure explanation

Extension → Webview:
- `{ type: 'command', name: 'runAll' }` — trigger a run inside the webview
- `{ type: 'testResult', ... }`         — v0.4: stream Playwright results
