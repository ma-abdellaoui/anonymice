/**
 * Activation — SPEC §4.
 *
 * The invariant this file exists to keep (SPEC §2.3): a sensitive value is never
 * present in any TextDocument, and never in any workspace file, at any instant.
 * Nothing here writes plaintext into a document. The reveal path renders to
 * decorations; the paste and tokenize paths write tokens.
 */
import * as vscode from 'vscode';
import { DetectController } from './ext/detect-controller.ts';
import { AnonymicePasteProvider } from './ext/paste-provider.ts';
import { RevealController } from './ext/reveal-controller.ts';
import { classify, mayReveal } from './lib/policy.ts';
import type { ResourceRule } from './lib/policy.ts';
import { quickClassify } from './lib/quick-rules.ts';
import { RemoteVault } from './lib/remote-vault.ts';
import { CLASSES } from './lib/types.ts';
import type { Cls, RevealMode } from './lib/types.ts';
import { Vault, emptyState } from './lib/vault.ts';
import type { VaultState } from './lib/vault.ts';

const KEY_SECRET = 'anonymice.vaultKey';
const STATE_KEY = 'anonymice.vaultState';

/**
 * Where the shared vault lives. Empty endpoint — the default — keeps this editor
 * entirely local: nothing is asked of anyone, and a token from elsewhere reads
 * as `foreign`, which is true.
 */
function remoteConfig(): { endpoint: string; token: string } {
  const cfg = vscode.workspace.getConfiguration('anonymice');
  return {
    endpoint: cfg.get<string>('vault.endpoint', '').replace(/\/$/, ''),
    token: cfg.get<string>('vault.token', ''),
  };
}

function rules(): ResourceRule[] {
  return vscode.workspace.getConfiguration('anonymice').get<ResourceRule[]>('resources', []);
}

function relPath(doc: vscode.TextDocument): string {
  return vscode.workspace.asRelativePath(doc.uri, false);
}

/**
 * Scope is the artifact destination (SPEC §1): where a token can travel. The
 * workspace folder — the axis that decides where the artifact ends up, not which
 * file it currently sits in.
 */
function scopeFor(doc: vscode.TextDocument): string {
  const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
  return folder ? folder.uri.toString() : 'anonymice:no-workspace';
}

async function loadKey(secrets: vscode.SecretStorage): Promise<Uint8Array> {
  const stored = await secrets.get(KEY_SECRET);
  if (stored) return Uint8Array.from(atob(stored), (c) => c.charCodeAt(0));
  const key = Vault.newKey();
  await secrets.store(KEY_SECRET, btoa(String.fromCharCode(...key)));
  return key;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // The vault key lives in SecretStorage — namespaced per extension id and
  // OS-keychain backed. See SPEC §2.1 for what that is and is not worth.
  const key = await loadKey(context.secrets);
  const persisted = context.globalState.get<VaultState>(STATE_KEY, emptyState());
  const vault = await Vault.open(key, persisted);
  const persist = (): void => void context.globalState.update(STATE_KEY, vault.state);

  /**
   * Files the user has opted into revealing. A file we minted into is added
   * automatically: having just turned a value into a token there, showing the
   * user only the token would be a worse default than showing them the value.
   */
  const optedIn = new Set<string>(context.workspaceState.get<string[]>('anonymice.optedIn', []));
  const rememberOptIn = (): void => void context.workspaceState.update('anonymice.optedIn', [...optedIn]);

  const modeFor = (doc: vscode.TextDocument): RevealMode => {
    const cls = classify(relPath(doc), rules());
    if (!mayReveal(cls, optedIn.has(doc.uri.toString()))) return 'off';
    return vscode.workspace
      .getConfiguration('anonymice', doc.uri)
      .get<RevealMode>('reveal.mode', 'annotate');
  };

  const detector = new DetectController(rules, relPath);

  /**
   * The shared vault (ENDPOINTS.md §6), off unless configured. It is what makes
   * a token minted in the browser resolvable here: the local vault has never
   * heard of it and correctly says `foreign`.
   */
  const remote = new RemoteVault(remoteConfig());
  const pendingLookups = new Set<string>();

  /**
   * Local first, always — this editor's own mints never leave the machine. Only
   * a token the local vault cannot place is worth a question, and the answer
   * arrives too late for this paint, so it schedules the next one.
   */
  const resolve = (token: string) => {
    const local = vault.resolve(token);
    if (local.kind !== 'foreign' || !remote.enabled) return local;
    const known = remote.cached(token);
    if (known) return known;
    if (!pendingLookups.has(token)) {
      pendingLookups.add(token);
      void remote.lookup(token).then((changed) => {
        pendingLookups.delete(token);
        if (changed) refreshAll();
      });
    }
    return local;
  };

  const reveal = new RevealController(resolve, modeFor);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'anonymice.revealToggleFile';
  context.subscriptions.push(reveal, detector, status);

  const refreshAll = (): void => {
    for (const e of vscode.window.visibleTextEditors) {
      detector.refresh(e);
      reveal.refresh(e);
    }
    updateStatus();
  };

  function updateStatus(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      status.hide();
      return;
    }
    const cls = classify(relPath(editor.document), rules());
    const on = modeFor(editor.document) !== 'off';
    const found = detector.describe(editor.document);
    status.text = reveal.isHidden
      ? '$(eye-closed) Anonymice: hidden'
      : found
        ? `$(warning) Anonymice: ${found} untokenized`
        : on
          ? `$(shield) Anonymice: ${cls.toLowerCase()}`
          : `$(shield) Anonymice: ${cls.toLowerCase()} · reveal off`;
    status.tooltip = new vscode.MarkdownString(
      [
        `Resource class **${cls}** (SPEC §3).`,
        found
          ? `Found **${found}** still in plaintext — run *Anonymice: Tokenize All in File*.`
          : '_Rule pass found nothing._ Rules cover checksummed classes and vendor-prefixed secrets only — **names, addresses and free text are not covered** and need the detection backend, which is not wired yet (SPEC §5.1).',
        'The buffer holds tokens; values render as decorations, which no other extension can read back (SPEC §2.2).',
      ].join('\n\n'),
    );
    status.show();
  }

  const paste = new AnonymicePasteProvider(vault, scopeFor, quickClassify, (doc) => {
    optedIn.add(doc.uri.toString());
    rememberOptIn();
    queueMicrotask(refreshAll);
    persist();
  }, remote);

  context.subscriptions.push(
    vscode.languages.registerDocumentPasteEditProvider({ scheme: 'file' }, paste, {
      providedPasteEditKinds: [vscode.DocumentDropOrPasteEditKind.Text.append('anonymice', 'tokenize')],
      pasteMimeTypes: ['text/plain'],
    }),
    vscode.window.onDidChangeVisibleTextEditors(refreshAll),
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      if (ed) {
        detector.refresh(ed);
        reveal.refresh(ed);
      }
      updateStatus();
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      for (const ed of vscode.window.visibleTextEditors) {
        if (ed.document !== e.document) continue;
        reveal.refresh(ed);
        detector.schedule(ed);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('anonymice')) return;
      remote.configure(remoteConfig());
      refreshAll();
    }),
    vscode.window.onDidChangeTextEditorSelection((e) => {
      // Arms the ctrl+c binding only where it has something to do, so ordinary
      // copy is never routed through us without reason.
      void vscode.commands.executeCommand(
        'setContext',
        'anonymice.armed',
        !e.selections[0]?.isEmpty && modeFor(e.textEditor.document) !== 'off',
      );
    }),

    vscode.commands.registerCommand('anonymice.hideAll', () => {
      reveal.setHiddenAll(true);
      updateStatus();
    }),
    vscode.commands.registerCommand('anonymice.showAll', () => {
      reveal.setHiddenAll(false);
      updateStatus();
    }),

    /**
     * The §6.1 tokenize action, reached by hand rather than from a detection
     * sweep. Mints a token for the selection and replaces it — an ordinary
     * WorkspaceEdit, so the editor's own undo reverses it.
     */
    vscode.commands.registerCommand('anonymice.tokenize', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        void vscode.window.showInformationMessage('Anonymice: select the value to tokenize first.');
        return;
      }
      const value = editor.document.getText(editor.selection);
      const hit = quickClassify(value);
      let cls: Cls | undefined = hit?.cls;
      if (!cls) {
        const picked = await vscode.window.showQuickPick([...CLASSES], {
          title: 'Anonymice: class for this value',
          placeHolder: 'The class label is carried inside the token (SPEC §6.4)',
        });
        if (!picked) return;
        cls = picked as Cls;
      }
      const token = await vault.mint({
        cls,
        value,
        normalized: hit?.normalized ?? value.trim(),
        scopeId: scopeFor(editor.document),
      });
      const ok = await editor.edit((b) => b.replace(editor.selection, token));
      if (!ok) {
        void vscode.window.showWarningMessage('Anonymice: could not write to this document.');
        return;
      }
      optedIn.add(editor.document.uri.toString());
      rememberOptIn();
      persist();
      refreshAll();
    }),

    /**
     * Copy-as-token. Bound to ctrl+c because there is no supported hook that can
     * change what a copy puts on the system clipboard — `prepareDocumentPaste`
     * never reaches it (SPEC §8.2). The context menu's Copy stays unhooked, and
     * that is survivable only because the buffer holds tokens already (SPEC §8.3).
     */
    vscode.commands.registerCommand('anonymice.copyToken', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const selected = editor.document.getText(editor.selection);
      try {
        const hit = quickClassify(selected);
        if (hit) {
          const token = await vault.mint({
            cls: hit.cls,
            value: selected,
            normalized: hit.normalized,
            scopeId: scopeFor(editor.document),
          });
          persist();
          await vscode.env.clipboard.writeText(token);
          void vscode.window.setStatusBarMessage(`$(shield) Copied as ${hit.cls} token`, 3000);
          return;
        }
        await vscode.env.clipboard.writeText(selected);
      } catch {
        // Never let a failure here cost the user their copy.
        await vscode.env.clipboard.writeText(selected);
      }
    }),

    /**
     * Tokenize every rule-pass finding in the file. One WorkspaceEdit, so the
     * editor's own undo reverses the whole rewrite (SPEC §6.1).
     */
    vscode.commands.registerCommand('anonymice.tokenizeAll', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      // Scan fresh: acting on a cached finding whose offsets have since moved
      // would rewrite the wrong range.
      detector.refresh(editor);
      const findings = detector.findingsFor(editor.document);
      if (findings.length === 0) {
        void vscode.window.showInformationMessage(
          'Anonymice: the rule pass found nothing here. It does not cover names, addresses or free text.',
        );
        return;
      }
      const summary = detector.describe(editor.document) ?? '';
      const go = await vscode.window.showWarningMessage(
        `Anonymice: replace ${summary} with tokens in this file?`,
        { modal: false },
        'Tokenize',
      );
      if (go !== 'Tokenize') return;

      // Mint first, then apply as one edit, so a mint failure never leaves the
      // file half-rewritten.
      const scope = scopeFor(editor.document);
      const replacements: { range: vscode.Range; token: string }[] = [];
      for (const f of findings) {
        const token = await vault.mint({ cls: f.cls, value: f.value, normalized: f.normalized, scopeId: scope });
        replacements.push({
          range: new vscode.Range(editor.document.positionAt(f.start), editor.document.positionAt(f.end)),
          token,
        });
      }
      const edit = new vscode.WorkspaceEdit();
      for (const r of replacements) edit.replace(editor.document.uri, r.range, r.token);
      const ok = await vscode.workspace.applyEdit(edit);
      if (!ok) {
        void vscode.window.showWarningMessage('Anonymice: the edit was rejected; nothing was changed.');
        return;
      }
      optedIn.add(editor.document.uri.toString());
      rememberOptIn();
      persist();
      refreshAll();
      void vscode.window.setStatusBarMessage(`$(shield) Tokenized ${summary}`, 4000);
    }),

    /**
     * Destroy every token and every value in the vault. Exists because vault
     * state is persisted (globalState + SecretStorage) and therefore survives a
     * window reload and an uninstall — without this there is no way back to a
     * clean slate for a repeatable test pass.
     */
    vscode.commands.registerCommand('anonymice.resetVault', async () => {
      const counts = Object.keys(vault.state.records).length;
      const go = await vscode.window.showWarningMessage(
        `Anonymice: destroy the vault? ${counts} value(s) and every token minted from them become unresolvable. Tokens already written into files will stay in those files and will no longer resolve.`,
        { modal: true },
        'Destroy vault',
      );
      if (go !== 'Destroy vault') return;
      await context.globalState.update(STATE_KEY, emptyState());
      await context.workspaceState.update('anonymice.optedIn', []);
      await context.secrets.delete(KEY_SECRET);
      void vscode.window.showInformationMessage(
        'Anonymice: vault destroyed. Reload the window (Developer: Reload Window) to start clean.',
      );
    }),

    vscode.commands.registerCommand('anonymice.revealToggleFile', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const uri = editor.document.uri.toString();
      if (optedIn.has(uri)) optedIn.delete(uri);
      else optedIn.add(uri);
      rememberOptIn();
      refreshAll();
    }),
  );

  refreshAll();
}

export function deactivate(): void {
  // Decorations are disposed through context.subscriptions; nothing is written back.
}
