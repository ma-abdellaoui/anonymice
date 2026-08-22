import { JSDOM } from 'jsdom';
import { Schema } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { collab } from 'prosemirror-collab';
import { schema as basic } from 'prosemirror-schema-basic';
import { tokenReveal, type RevealOptions } from '../src/token-decorations.ts';

export const schema: Schema = basic;

/** A stand-in for the vault: one token, one value. */
export const IBAN_TOKEN = 'ANM1-IBAN-K3F9QW2MX7VBNC4H8';
export const IBAN_VALUE = 'CH93 0076 2011 6238 5295 7';
export const VAULT: Record<string, string> = { [IBAN_TOKEN]: IBAN_VALUE };
export const resolve = (token: string): string | null => VAULT[token] ?? null;

export function editor(paragraphs: string[], opts: Partial<RevealOptions> = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="editor"></div></body></html>', {
    url: 'https://example.atlassian.net/wiki/spaces/ENG/pages/1',
  });
  const { window } = dom;
  // prosemirror-view reaches for these as globals in a few places.
  // `navigator` is getter-only on modern Node, so define rather than assign.
  for (const [name, value] of [
    ['window', window],
    ['document', window.document],
    ['navigator', window.navigator],
    ['getSelection', () => window.getSelection()],
    ['getComputedStyle', (el: Element) => window.getComputedStyle(el)],
  ] as const) {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }

  const doc = schema.node(
    'doc',
    null,
    paragraphs.map((text) =>
      schema.node('paragraph', null, text ? [schema.text(text)] : []),
    ),
  );

  const state = EditorState.create({
    doc,
    plugins: [collab({ version: 0 }), tokenReveal({ resolve, ...opts })],
  });

  const view = new EditorView(window.document.getElementById('editor')!, { state });
  return { view, window, dom };
}

/** Everything the destination would receive, as one string to grep. */
export function overTheWire(view: EditorView): string {
  return JSON.stringify(view.state.doc.toJSON());
}
