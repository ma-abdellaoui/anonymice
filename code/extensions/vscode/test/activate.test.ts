/**
 * Activation smoke test — runs the real bundled extension against a stubbed
 * VS Code API. Catches the wiring faults a unit test cannot: a command declared
 * in package.json but never registered, a crash during activate, and — the one
 * that matters — plaintext reaching the document (SPEC §2.3, §11).
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import Module from 'node:module';
import { test } from 'node:test';
import { scanTokens } from '../src/lib/tokens.ts';

interface Edit { range: { start: { character: number }; end: { character: number } }; newText: string }

const require_ = createRequire(import.meta.url);

// Route the bundle's `require('vscode')` at the stub.
const stubPath = require_.resolve('./stub/vscode.cjs');
const origLoad = (Module as unknown as { _load: (r: string, p: unknown, m: boolean) => unknown })._load;
(Module as unknown as { _load: unknown })._load = function (request: string, parent: unknown, isMain: boolean) {
  return request === 'vscode' ? require_(stubPath) : origLoad.call(this, request, parent, isMain);
};

/** The slice of the stub this test drives. Declared here so the .cjs needs no .d.ts. */
interface Stub {
  Position: new (line: number, character: number) => { line: number; character: number };
  Selection: new (a: unknown, b: unknown) => unknown;
  window: { activeTextEditor: unknown };
  commands: { executeCommand: (id: string, ...args: unknown[]) => Promise<unknown> };
  __test: {
    registered: Map<string, unknown>;
    clipboard: { text: string };
    state: {
      warningAnswer?: string;
      applyEdit?: (e: Edit[]) => void;
      messages: string[];
      config: Record<string, unknown>;
    };
  };
}

const vscode = require_(stubPath) as Stub;
const ext = require_('../dist/extension.cjs') as {
  activate: (c: unknown) => Promise<void>;
  deactivate: () => void;
};

function makeContext() {
  const secrets = new Map<string, string>();
  const global = new Map<string, unknown>();
  const ws = new Map<string, unknown>();
  return {
    subscriptions: [] as { dispose(): void }[],
    secrets: {
      get: (k: string) => Promise.resolve(secrets.get(k)),
      store: (k: string, v: string) => { secrets.set(k, v); return Promise.resolve(); },
    },
    globalState: {
      get: (k: string, d: unknown) => (global.has(k) ? global.get(k) : d),
      update: (k: string, v: unknown) => { global.set(k, v); return Promise.resolve(); },
    },
    workspaceState: {
      get: (k: string, d: unknown) => (ws.has(k) ? ws.get(k) : d),
      update: (k: string, v: unknown) => { ws.set(k, v); return Promise.resolve(); },
    },
  };
}

/** A minimal editable document + editor the stub can hand to the extension. */
function makeEditor(text: string, selStart: number, selEnd: number) {
  const doc = {
    _text: text,
    uri: { scheme: 'file', toString: () => 'file:///demo/.env' },
    getText(range?: unknown) {
      if (!range) return doc._text;
      const r = range as { start: { character: number }; end: { character: number } };
      return doc._text.slice(r.start.character, r.end.character);
    },
    positionAt: (o: number) => new vscode.Position(0, o),
    offsetAt: (p: { character: number }) => p.character,
  };
  const selection = new vscode.Selection(new vscode.Position(0, selStart), new vscode.Position(0, selEnd));
  return {
    document: doc,
    selection,
    selections: [selection],
    setDecorations() {},
    edit(cb: (b: { replace: (r: unknown, s: string) => void }) => void) {
      cb({
        replace: (r, s) => {
          const rr = r as { start: { character: number }; end: { character: number } };
          doc._text = doc._text.slice(0, rr.start.character) + s + doc._text.slice(rr.end.character);
        },
      });
      return Promise.resolve(true);
    },
  };
}

test('activate() completes and registers every command package.json declares', async () => {
  const ctx = makeContext();
  await ext.activate(ctx);

  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    contributes: { commands: { command: string }[] };
  };
  for (const { command } of pkg.contributes.commands) {
    assert.ok(
      vscode.__test.registered.has(command),
      `${command} is contributed but never registered — "command not found" at runtime`,
    );
  }
  assert.ok(ctx.subscriptions.length > 0, 'nothing was subscribed; disposal would leak');
});

test('tokenize replaces the selection with a token and leaves no plaintext behind (SPEC §2.3)', async () => {
  const ctx = makeContext();
  await ext.activate(ctx);

  const secret = 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const editor = makeEditor(`GITHUB_TOKEN=${secret}`, 13, 13 + secret.length);
  vscode.window.activeTextEditor = editor as never;

  await vscode.commands.executeCommand('anonymice.tokenize');

  const after = editor.document.getText();
  assert.ok(!after.includes(secret), `plaintext survived in the document: ${after}`);
  const found = scanTokens(after);
  assert.equal(found.length, 1, `expected exactly one token, got: ${after}`);
  assert.equal(found[0]!.cls, 'SECRET', 'vendor-prefixed key must classify without asking');
  assert.match(after, /^GITHUB_TOKEN=ANM1-SECRET-/);
});

test('copy-as-token puts the token, not the value, on the clipboard (SPEC §8.2)', async () => {
  const ctx = makeContext();
  await ext.activate(ctx);

  const iban = 'CH93 0076 2011 6238 5295 7';
  const editor = makeEditor(`iban = ${iban}`, 7, 7 + iban.length);
  vscode.window.activeTextEditor = editor as never;

  await vscode.commands.executeCommand('anonymice.copyToken');

  const onClipboard = vscode.__test.clipboard.text;
  assert.ok(!onClipboard.includes(iban), 'the value reached the clipboard');
  assert.equal(scanTokens(onClipboard).length, 1);
  assert.equal(scanTokens(onClipboard)[0]!.cls, 'IBAN');
});

test('copy of a non-sensitive selection is passed through untouched', async () => {
  const ctx = makeContext();
  await ext.activate(ctx);
  const editor = makeEditor('const x = 1;', 0, 12);
  vscode.window.activeTextEditor = editor as never;
  await vscode.commands.executeCommand('anonymice.copyToken');
  assert.equal(vscode.__test.clipboard.text, 'const x = 1;', 'ordinary copy must not be altered');
});

test('deactivate does not throw', async () => {
  await ext.activate(makeContext());
  assert.doesNotThrow(() => ext.deactivate());
});

test('tokenize-all rewrites every rule finding in one edit (SPEC §6.1)', async () => {
  const ctx = makeContext();
  await ext.activate(ctx);

  const iban = 'CH93 0076 2011 6238 5295 7';
  const email = 'anna.meier@example.org';
  const editor = makeEditor(`iban=${iban} mail=${email}`, 0, 0);
  vscode.window.activeTextEditor = editor as never;
  // Detection only runs on a classified resource (SPEC §5.1).
  vscode.__test.state.config['resources'] = [{ glob: '**', class: 'NATIVE' }];
  vscode.__test.state.warningAnswer = 'Tokenize';
  vscode.__test.state.applyEdit = (edits: Edit[]) => {
    for (const e of edits) {
      const t = editor.document._text;
      editor.document._text = t.slice(0, e.range.start.character) + e.newText + t.slice(e.range.end.character);
    }
  };

  // Detection is debounced off document change; drive it directly via the
  // command's own read of the current document.
  await vscode.commands.executeCommand('anonymice.tokenizeAll');

  const after = editor.document.getText();
  assert.ok(!after.includes(iban), `IBAN survived: ${after}`);
  assert.ok(!after.includes(email), `email survived: ${after}`);
  const found = scanTokens(after);
  assert.equal(found.length, 2, `expected two tokens, got: ${after}`);
  assert.deepEqual(found.map((f) => f.cls).sort(), ['EMAIL', 'IBAN']);
});

test('tokenize-all declines to imply coverage it does not have', async () => {
  const ctx = makeContext();
  await ext.activate(ctx);
  const editor = makeEditor('Kunde Anna Meier, Bahnhofstrasse 1', 0, 0);
  vscode.window.activeTextEditor = editor as never;
  vscode.__test.state.messages.length = 0;

  await vscode.commands.executeCommand('anonymice.tokenizeAll');

  assert.equal(editor.document.getText(), 'Kunde Anna Meier, Bahnhofstrasse 1', 'nothing was rewritten');
  const said = vscode.__test.state.messages.join(' ');
  assert.match(said, /does not cover names/, '"found nothing" must not read as "clean"');
});
