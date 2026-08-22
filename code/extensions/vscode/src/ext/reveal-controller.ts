/**
 * The decoration layer — SPEC §7.1.
 *
 * Decorations are the only in-editor rendering surface another extension cannot
 * read back: `TextEditor` exposes `setDecorations` and no getter,
 * `TextEditorDecorationType` exposes only `key` and `dispose`, and there is no
 * `vscode.executeDecorationProvider`. Everything rendered here is therefore
 * outside the reach of `vscode.execute*Provider`, which is what makes it safe
 * to draw a plaintext value at all (SPEC §2.2).
 *
 * Nothing in this file ever writes to a TextDocument.
 */
import * as vscode from 'vscode';
import { planReveal } from '../lib/reveal.ts';
import type { RevealMode } from '../lib/types.ts';
import type { Resolution } from '../lib/vault.ts';

export class RevealController implements vscode.Disposable {
  /** `annotate`: value rendered after the token. Nothing is hidden. */
  readonly #after = vscode.window.createTextEditorDecorationType({
    after: { margin: '0 0 0 0.75rem', color: new vscode.ThemeColor('editorCodeLens.foreground') },
  });

  /** Explanations — expired, revoked, foreign, damaged — render differently from values. */
  readonly #muted = vscode.window.createTextEditorDecorationType({
    after: { margin: '0 0 0 0.75rem', color: new vscode.ThemeColor('editorGhostText.foreground'), fontStyle: 'italic' },
  });

  /**
   * `substitute`: the token's own characters are hidden and the value is drawn
   * in their place. The hiding works by smuggling `display: none` through
   * `textDecoration`, which VS Code has never promised to keep working — hence
   * `annotate` is the default and this mode is opt-in (SPEC §7.2).
   */
  readonly #hidden = vscode.window.createTextEditorDecorationType({
    textDecoration: 'none; display: none',
  });

  readonly #before = vscode.window.createTextEditorDecorationType({
    before: { color: new vscode.ThemeColor('editor.foreground') },
  });

  #hiddenAll = false;

  readonly #resolve: (token: string) => Resolution;
  readonly #modeFor: (doc: vscode.TextDocument) => RevealMode;

  constructor(
    resolve: (token: string) => Resolution,
    modeFor: (doc: vscode.TextDocument) => RevealMode,
  ) {
    this.#resolve = resolve;
    this.#modeFor = modeFor;
  }

  get isHidden(): boolean {
    return this.#hiddenAll;
  }

  /** One gesture for screen sharing, not a per-value hunt (SPEC §7.1). */
  setHiddenAll(hidden: boolean): void {
    this.#hiddenAll = hidden;
    for (const e of vscode.window.visibleTextEditors) this.refresh(e);
  }

  refresh(editor: vscode.TextEditor): void {
    const doc = editor.document;
    const mode = this.#modeFor(doc);
    const plan = planReveal(doc.getText(), this.#resolve, { mode, hidden: this.#hiddenAll });

    const after: vscode.DecorationOptions[] = [];
    const muted: vscode.DecorationOptions[] = [];
    const hide: vscode.Range[] = [];
    const before: vscode.DecorationOptions[] = [];

    for (const d of plan) {
      const range = new vscode.Range(doc.positionAt(d.start), doc.positionAt(d.end));
      // `hoverMessage` is safe here and only here: it is attached to a decoration
      // rather than contributed by a HoverProvider, so `vscode.executeHoverProvider`
      // does not reach it. It carries no plaintext regardless (SPEC §7.4).
      const hoverMessage = d.webviewOnly
        ? new vscode.MarkdownString('Anonymice: multi-line value — open the isolated editor to view.')
        : undefined;

      if (d.hide) {
        hide.push(range);
        before.push({ range, renderOptions: { before: { contentText: d.contentText } }, hoverMessage });
      } else {
        (d.muted ? muted : after).push({
          range,
          renderOptions: { after: { contentText: d.contentText } },
          hoverMessage,
        });
      }
    }

    editor.setDecorations(this.#after, after);
    editor.setDecorations(this.#muted, muted);
    editor.setDecorations(this.#hidden, hide);
    editor.setDecorations(this.#before, before);
  }

  clear(editor: vscode.TextEditor): void {
    for (const t of [this.#after, this.#muted, this.#hidden, this.#before]) {
      editor.setDecorations(t, []);
    }
  }

  dispose(): void {
    for (const t of [this.#after, this.#muted, this.#hidden, this.#before]) t.dispose();
  }
}
