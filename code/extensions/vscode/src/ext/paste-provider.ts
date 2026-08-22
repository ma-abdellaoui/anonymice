/**
 * Paste — SPEC §8.1.
 *
 * `DocumentPasteEditProvider` runs before insertion and what it returns *is* the
 * inserted text, which makes it the one place we still control content on its
 * way into a buffer.
 *
 * Note the asymmetry with copy: `prepareDocumentPaste` looks like a copy hook and
 * is not one — VS Code stores that DataTransfer in memory against a handle and
 * never writes it to the system clipboard (SPEC §8.2). So this file handles the
 * inbound direction only.
 */
import * as vscode from 'vscode';
import { looksLikeToken, parseToken } from '../lib/tokens.ts';
import type { RemoteVault } from '../lib/remote-vault.ts';
import type { Cls } from '../lib/types.ts';
import type { Resolution, Vault } from '../lib/vault.ts';

/** What a synchronous, local-only classification can conclude. */
export interface QuickClassifier {
  (text: string): { cls: Cls; normalized: string } | undefined;
}

export const PASTE_KIND = vscode.DocumentDropOrPasteEditKind.Text.append('anonymice', 'tokenize');

export class AnonymicePasteProvider implements vscode.DocumentPasteEditProvider {
  readonly #vault: Vault;
  readonly #remote: RemoteVault | undefined;
  readonly #scopeFor: (doc: vscode.TextDocument) => string;
  readonly #classify: QuickClassifier;
  readonly #onRevealNeeded: (doc: vscode.TextDocument) => void;

  constructor(
    vault: Vault,
    scopeFor: (doc: vscode.TextDocument) => string,
    classify: QuickClassifier,
    onRevealNeeded: (doc: vscode.TextDocument) => void,
    remote?: RemoteVault,
  ) {
    this.#vault = vault;
    this.#remote = remote;
    this.#scopeFor = scopeFor;
    this.#classify = classify;
    this.#onRevealNeeded = onRevealNeeded;
  }

  async provideDocumentPasteEdits(
    document: vscode.TextDocument,
    _ranges: readonly vscode.Range[],
    dataTransfer: vscode.DataTransfer,
    _context: vscode.DocumentPasteEditContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.DocumentPasteEdit[] | undefined> {
    const item = dataTransfer.get('text/plain');
    if (!item) return undefined;
    const text = await item.asString();
    if (token.isCancellationRequested || text === '') return undefined;

    const scope = this.#scopeFor(document);

    // 1. An ANM1 token. Confirm against the vault before acting — pasted
    //    documentation containing an example token must mint nothing (SPEC §8.1).
    if (looksLikeToken(text)) {
      const parsed = parseToken(text.trim());
      if (parsed.kind === 'token') {
        const res: Resolution = this.#vault.resolve(parsed.token);
        if (res.kind === 'value') {
          // Re-scope to this document's destination (SPEC §6.3): the clipboard
          // token was scoped to wherever it was copied from. By token, not by
          // value — `resolve` returns the plaintext, not the normalised form the
          // value index is built from, and minting on the wrong one forks the
          // record.
          const alias = this.#vault.rescope(parsed.token, scope);
          this.#onRevealNeeded(document);
          return [this.#edit(alias ?? parsed.token, 'Paste as Anonymice token')];
        }
        // Not ours. It may still be a token from the browser extension, minted
        // into the shared vault — which is the whole point of there being one.
        // Re-scoping happens on that side, so what lands in the buffer is this
        // destination's alias, not the clipboard token (SPEC §6.3).
        if (res.kind === 'foreign' && this.#remote?.enabled) {
          const reply = await this.#remote.resolveForPaste(parsed.token, scope);
          if (token.isCancellationRequested) return undefined;
          if (reply?.resolution.kind === 'value') {
            this.#onRevealNeeded(document);
            return [this.#edit(reply.alias ?? parsed.token, 'Paste as Anonymice token')];
          }
        }
        // Dead, damaged, or from a vault nobody here can reach: paste it
        // literally. It stays legible (SPEC §6.7) and we must not invent a value.
        return undefined;
      }
      return undefined;
    }

    // 2. Plaintext that classifies synchronously. The backend is not synchronous,
    //    so this is the local rule pass only — a PERSON in bare text is not caught
    //    here and is picked up by the next detection sweep (SPEC §8.1).
    const hit = this.#classify(text);
    if (!hit) return undefined;

    const minted = await this.#vault.mint({
      cls: hit.cls,
      value: text,
      normalized: hit.normalized,
      scopeId: scope,
    });
    this.#onRevealNeeded(document);
    return [this.#edit(minted, `Paste ${hit.cls} as Anonymice token`)];
  }

  #edit(insertText: string, title: string): vscode.DocumentPasteEdit {
    const edit = new vscode.DocumentPasteEdit(insertText, title, PASTE_KIND);
    // Sort ahead of the plain-text paste so ours is the default applied edit.
    edit.yieldTo = [];
    return edit;
  }
}
