/**
 * TestGrove — VS Code Extension Entry (L4-plus)
 *
 * Wraps the prototype webview in a VS Code panel. The prototype itself
 * doesn't know it's running in an extension — it still just reads/writes
 * TestTree state and renders. Playwright integration is a separate
 * message-passing layer added later.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

let currentPanel: vscode.WebviewPanel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const openCmd = vscode.commands.registerCommand('testgrove.open', () => {
    if (currentPanel) {
      currentPanel.reveal(vscode.ViewColumn.One);
      return;
    }

    currentPanel = vscode.window.createWebviewPanel(
      'testgrove.tree',
      'TestGrove',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.file(path.join(context.extensionPath, 'prototype')),
        ],
      }
    );

    currentPanel.webview.html = renderWebviewHtml(context, currentPanel.webview);

    // Message passing: webview -> extension
    currentPanel.webview.onDidReceiveMessage(
      (msg) => handleWebviewMessage(msg, currentPanel!),
      undefined,
      context.subscriptions
    );

    currentPanel.onDidDispose(
      () => { currentPanel = undefined; },
      undefined,
      context.subscriptions
    );
  });

  const runCmd = vscode.commands.registerCommand('testgrove.runAll', async () => {
    if (!currentPanel) {
      await vscode.commands.executeCommand('testgrove.open');
    }
    currentPanel?.webview.postMessage({ type: 'command', name: 'runAll' });
    // TODO: spawn Playwright process and stream results into the panel.
    vscode.window.showInformationMessage(
      'TestGrove: Playwright integration lands in v0.4 — for now the prototype uses mock data.'
    );
  });

  context.subscriptions.push(openCmd, runCmd);
}

export function deactivate(): void {
  currentPanel?.dispose();
  currentPanel = undefined;
}

// ============================================================================
// Webview HTML
// ============================================================================

/**
 * Load the prototype's index.html and rewrite its <script src> to a proper
 * webview URI so the CSP-restricted webview can load it.
 */
function renderWebviewHtml(
  context: vscode.ExtensionContext,
  webview: vscode.Webview
): string {
  const protoDir = path.join(context.extensionPath, 'prototype');
  const htmlPath = path.join(protoDir, 'index.html');
  let html = fs.readFileSync(htmlPath, 'utf8');

  // Give the page a <base> pointing at the prototype folder so EVERY relative
  // URL (scripts, tree-anatomy.js, tree-renderer.js, ./assets/*.png) resolves
  // to a webview-safe URI without rewriting each one.
  const baseUri = webview.asWebviewUri(vscode.Uri.file(protoDir)).toString();
  html = html.replace(/<head>/, `<head>\n  <base href="${baseUri}/">`);

  // Inject a Content Security Policy meta tag
  const nonce = generateNonce();
  const csp = [
    `default-src 'none'`,
    `script-src ${webview.cspSource} 'unsafe-inline'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `img-src ${webview.cspSource} data:`,
    `font-src ${webview.cspSource}`,
  ].join('; ');
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  html = html.replace(/<head>/, `<head>\n  ${cspMeta}`);

  // Inject the VS Code API acquisition script so the prototype can post
  // messages back to the extension. (Prototype uses window.vscode when present.)
  const vscodeScript = `
    <script nonce="${nonce}">
      window.vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
    </script>
  `;
  html = html.replace('</body>', `${vscodeScript}\n</body>`);

  return html;
}

function generateNonce(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// ============================================================================
// Message handling  (webview -> extension)
// ============================================================================

interface WebviewMessage {
  type: string;
  [k: string]: unknown;
}

function handleWebviewMessage(msg: WebviewMessage, panel: vscode.WebviewPanel): void {
  switch (msg.type) {
    case 'openFile': {
      const file = String(msg.file ?? '');
      const line = Number(msg.line ?? 1);
      if (!file) return;
      const uri = resolveWorkspaceFile(file);
      if (!uri) return;
      vscode.workspace.openTextDocument(uri).then((doc) => {
        vscode.window.showTextDocument(doc, {
          selection: new vscode.Range(line - 1, 0, line - 1, 0),
        });
      });
      break;
    }
    case 'askAi': {
      // Placeholder — v0.7 plugs in an LLM provider here.
      vscode.window.showInformationMessage(
        `TestGrove: AI failure explanation lands in v0.7. Test: ${String(msg.testName ?? 'unknown')}`
      );
      break;
    }
    case 'runAll':
    case 'rerun': {
      vscode.window.setStatusBarMessage(
        'TestGrove: live Playwright runs land in v0.6 — showing a simulated run', 4000
      );
      break;
    }
    case 'openConfig':
    case 'addFramework': {
      vscode.window.showInformationMessage(
        msg.type === 'openConfig'
          ? 'TestGrove: settings live under "testgrove.*" (Playwright config path, test dir).'
          : 'TestGrove: more frameworks (Jest, Vitest) plug in through the TestParser interface.'
      );
      if (msg.type === 'openConfig') void vscode.commands.executeCommand('workbench.action.openSettings', 'testgrove');
      break;
    }
    default:
      // Ignore unknown messages defensively
      break;
  }
}

function resolveWorkspaceFile(relPath: string): vscode.Uri | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;
  return vscode.Uri.file(path.join(folders[0].uri.fsPath, relPath));
}
