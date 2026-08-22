/**
 * SPIKE — the rich-editor path (SPEC §8.3's deferred case).
 *
 * The claim under test: in a ProseMirror-backed editor the *document model* and
 * the *rendered DOM* are separate, and what a collaborative destination receives
 * is the model. If that holds, a decoration can render plaintext into the page
 * while the model — and therefore every transaction step, every autosave and
 * everything Atlassian stores — carries only the token.
 *
 * This is the inverse of an `<input>`, where `value` is both the render and the
 * submitted thing, which is what forced §8.1's conclusion that plaintext cannot
 * live in the page at all.
 *
 * Decorations are the right primitive rather than a custom node type: ADF is
 * validated server-side and an unknown node would be stripped. A decoration
 * never enters the schema, never serialises and is not shared with other
 * collaborators in the room.
 *
 * NOT SHIPPABLE. No vault, no trust gate, no lifecycle.
 */
import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';

export const anonymiceKey = new PluginKey<DecorationSet>('anonymice-reveal');

/** Copied from src/lib/tokens.ts rather than imported — spike stays standalone. */
const SCAN = /\bANM1-([A-Z]{2,10})-((?:[0-9A-Z]-?){16}[0-9A-Z])\b/g;

/** Marks every DOM node we own, so a reparse can be told to skip it. */
export const OWNED = 'data-anonymice';

export type Resolve = (token: string) => string | null;

/**
 * `plaintext` puts the real value in the page DOM — closes the server-side leak,
 * leaves it readable by page JS and by session replay (§8.8).
 * `frame` renders an extension-origin iframe instead — closes both, at the cost
 * of one frame per revealed token.
 */
export type Render = 'plaintext' | 'frame';

export interface RevealOptions {
  resolve: Resolve;
  render?: Render;
  /** `chrome.runtime.getURL('reveal.html')` in production. */
  frameUrl?: string;
}

function chip(view: EditorView, value: string, token: string, opts: RevealOptions): HTMLElement {
  const doc = view.dom.ownerDocument;
  const el = doc.createElement('span');
  el.setAttribute(OWNED, 'reveal');
  // Without this the editor treats the widget's text as editable content and
  // the caret can land inside something the model does not know about.
  el.setAttribute('contenteditable', 'false');
  el.setAttribute('data-token', token);

  if ((opts.render ?? 'plaintext') === 'frame') {
    const frame = doc.createElement('iframe');
    frame.setAttribute(OWNED, 'reveal-frame');
    frame.setAttribute('title', 'protected value');
    // The editor lays this out inline, which is the whole point: no rAF
    // tracking, no clipping, no z-index war (§8.8's list mostly evaporates).
    frame.style.cssText = 'border:0;vertical-align:baseline;background:transparent;';
    frame.src = `${opts.frameUrl ?? 'about:blank'}#${encodeURIComponent(token)}`;
    el.appendChild(frame);
  } else {
    el.textContent = value;
  }
  return el;
}

function build(doc: PMNode, opts: RevealOptions): DecorationSet {
  const decorations: Decoration[] = [];

  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    const text = node.text ?? '';
    SCAN.lastIndex = 0;
    for (const match of text.matchAll(SCAN)) {
      const token = match[0];
      const value = opts.resolve(token);
      // Not in the vault: leave the token showing. A token-shaped string in
      // documentation must not render as a value (§8.3).
      if (value == null) continue;

      const from = pos + (match.index ?? 0);
      const to = from + token.length;

      // The token stays in the model and stays in the DOM — just not visible.
      // Hiding rather than removing is what keeps model and view positions in
      // step, so mapping through a transaction stays trivial.
      decorations.push(
        Decoration.inline(from, to, { style: 'display:none', [OWNED]: 'conceal' }),
      );
      decorations.push(
        Decoration.widget(from, (view) => chip(view, value, token, opts), {
          side: -1,
          key: `anonymice:${token}:${opts.render ?? 'plaintext'}`,
          ignoreSelection: true,
          stopEvent: () => true,
          marks: [],
        }),
      );
    }
    return false;
  });

  return DecorationSet.create(doc, decorations);
}

export function tokenReveal(opts: RevealOptions): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: anonymiceKey,
    state: {
      init: (_config, state) => build(state.doc, opts),
      apply: (tr, set) => (tr.docChanged ? build(tr.doc, opts) : set),
    },
    props: {
      decorations: (state) => anonymiceKey.getState(state),
    },
  });
}
