/**
 * Rule-pass detection in the editor — SPEC §5, §6.1.
 *
 * Detection paints; it never rewrites. The tokenize step stays an explicit
 * action that names what it found, because a file rewritten on open is not
 * something to do behind the user's back (SPEC §6.1).
 */
import * as vscode from 'vscode';
import { detect, summarize } from '../lib/detect.ts';
import type { Finding } from '../lib/detect.ts';
import { classify, mayScan } from '../lib/policy.ts';
import type { ResourceRule } from '../lib/policy.ts';

export class DetectController implements vscode.Disposable {
  /** Light-red, matching the browser extension's paint (browser SPEC §4). */
  readonly #sensitive = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(255, 120, 120, 0.28)',
    borderRadius: '2px',
    overviewRulerColor: 'rgba(255, 90, 90, 0.9)',
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });

  readonly #byDoc = new Map<string, Finding[]>();
  readonly #rules: () => ResourceRule[];
  readonly #relPath: (doc: vscode.TextDocument) => string;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(rules: () => ResourceRule[], relPath: (doc: vscode.TextDocument) => string) {
    this.#rules = rules;
    this.#relPath = relPath;
  }

  findingsFor(doc: vscode.TextDocument): Finding[] {
    return this.#byDoc.get(doc.uri.toString()) ?? [];
  }

  /** Debounced: a keystroke storm must not re-scan on every character. */
  schedule(editor: vscode.TextEditor, delayMs = 250): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.refresh(editor), delayMs);
  }

  refresh(editor: vscode.TextEditor): void {
    const doc = editor.document;
    const cls = classify(this.#relPath(doc), this.#rules());

    // The rule pass runs locally and sends nothing anywhere, so it is not gated
    // on workspace trust the way the backend pass is (SPEC §5.1, §5.3). It is
    // still gated on classification: an unclassified file is not our business.
    if (cls === 'UNTRUSTED' || doc.uri.scheme !== 'file') {
      this.#byDoc.delete(doc.uri.toString());
      editor.setDecorations(this.#sensitive, []);
      return;
    }
    void mayScan;

    const findings = detect(doc.getText());
    this.#byDoc.set(doc.uri.toString(), findings);
    editor.setDecorations(
      this.#sensitive,
      findings.map((f) => ({
        range: new vscode.Range(doc.positionAt(f.start), doc.positionAt(f.end)),
        hoverMessage: new vscode.MarkdownString(
          `**Anonymice**: ${f.cls} detected by rule \`${f.rule}\`.\n\nRun *Anonymice: Tokenize All in File* to replace it with a token.`,
        ),
      })),
    );
  }

  /**
   * The offer (SPEC §6.1): names the count and the classes. Deliberately not a
   * modal — a dialog on every open trains click-through.
   */
  describe(doc: vscode.TextDocument): string | undefined {
    const f = this.findingsFor(doc);
    return f.length === 0 ? undefined : summarize(f);
  }

  clear(editor: vscode.TextEditor): void {
    editor.setDecorations(this.#sensitive, []);
  }

  dispose(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#sensitive.dispose();
  }
}
