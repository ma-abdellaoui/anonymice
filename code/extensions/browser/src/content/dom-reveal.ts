/**
 * DOM ingress — SPEC §10.9.4.
 *
 * The network hooks in `egress-main.ts` cover what an application *fetches*.
 * They do not cover what arrived in the document itself: server-rendered HTML,
 * an embedded `__INITIAL_STATE__` blob, anything painted before the first XHR.
 * On such a page the tokens are already in the tree by the time any of our code
 * runs, and `reveal: 'dom'` would show them raw.
 *
 * So this walks text nodes and substitutes. It runs in the **isolated** world:
 * it needs no page JS, and the plaintext it writes is going into the page DOM
 * anyway — which is the whole premise of this mode, and its whole cost (§10.11).
 *
 * Never touches an editable region while it has focus. Rewriting text under a
 * live caret moves the caret, and a user mid-word will lose their place.
 */
import { detokenize, tokensIn } from '../lib/detokenize.ts';
import { looksLikeToken } from '../lib/tokens.ts';

const OWNED = 'data-anonymice';

/**
 * Never walked as text. `TEXTAREA` and `INPUT` are here because their value is
 * a *property*, not a text node — they are handled separately by `revealFields`.
 */
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'INPUT']);

/** Field types whose value is free text worth revealing. */
const FIELD_TYPES = new Set(['text', 'search', 'tel', 'url', 'email', '']);

export interface DomRevealOptions {
  /** Synchronous cache read. A miss leaves the token showing (SPEC §10.9.3). */
  valueFor: (token: string) => string | undefined;
  /** Tokens we could not resolve, so the caller can warm the cache and re-run. */
  onUnresolved?: (tokens: string[]) => void;
}

function shouldSkip(node: Text): boolean {
  for (let el = node.parentElement; el; el = el.parentElement) {
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.hasAttribute(OWNED)) return true;
    // A focused editable is being typed in; moving its text moves the caret.
    if (el.isContentEditable && el.ownerDocument.activeElement === el) return true;
  }
  return false;
}

/**
 * One pass over a subtree. Returns how many nodes changed, so a caller can tell
 * "nothing to do" from "did work" without re-walking.
 */
export function revealIn(root: Node, opts: DomRevealOptions): number {
  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, 4 /* SHOW_TEXT */);
  const pending: Text[] = [];
  const unresolved = new Set<string>();

  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    // Cheap reject before the expensive normalising scan; most text is not ours.
    if (!looksLikeToken(node.data)) continue;
    if (shouldSkip(node)) continue;
    pending.push(node);
  }

  let changed = 0;
  for (const node of pending) {
    const result = detokenize(node.data, opts.valueFor);
    for (const token of result.unresolved) unresolved.add(token);
    if (result.replaced.length === 0) continue;
    node.data = result.text;
    changed++;
  }

  if (unresolved.size) opts.onUnresolved?.([...unresolved]);
  return changed;
}

/**
 * Form fields — SPEC §10.9.4.
 *
 * A `<textarea>`'s content is its `value`, so the text walk above steps straight
 * over it. That is not a corner case: Confluence's page title is a `<textarea>`,
 * so a token pasted into a document's title is invisible to the walk and stays
 * showing as a token while every other token on the page resolves.
 *
 * Skipped while focused, for the caret reason, and skipped for `password` and
 * the structured input types, whose values are not free text.
 */
export function revealFields(root: ParentNode, opts: DomRevealOptions): number {
  const fields = root.querySelectorAll('textarea, input');
  const unresolved = new Set<string>();
  let changed = 0;

  for (const el of fields) {
    const field = el as HTMLInputElement | HTMLTextAreaElement;
    if (field.tagName === 'INPUT') {
      const type = (field.getAttribute('type') ?? 'text').toLowerCase();
      if (!FIELD_TYPES.has(type)) continue;
    }
    if (field.closest(`[${OWNED}]`)) continue;
    if (field.ownerDocument.activeElement === field) continue;
    const value = field.value;
    if (!value || !looksLikeToken(value)) continue;

    const result = detokenize(value, opts.valueFor);
    for (const token of result.unresolved) unresolved.add(token);
    if (result.replaced.length === 0) continue;

    // Through the native setter, for the same reason §8.3 uses it: the page's
    // own setter may be patched, and React has to notice the change.
    setFieldValue(field, result.text);
    changed++;
  }

  if (unresolved.size) opts.onUnresolved?.([...unresolved]);
  return changed;
}

/**
 * The page's own `value` setter may be patched; the isolated world's is not.
 * Duplicated from `reveal.ts` rather than shared: that file is about a token
 * going *in*, this one is about a value coming *out*, and folding them together
 * would couple two paths that have no reason to change together.
 */
function setFieldValue(field: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const view = field.ownerDocument.defaultView;
  const proto = field.tagName === 'TEXTAREA' ? view?.HTMLTextAreaElement : view?.HTMLInputElement;
  const descriptor = proto ? Object.getOwnPropertyDescriptor(proto.prototype, 'value') : undefined;
  if (descriptor?.set) descriptor.set.call(field, value);
  else field.value = value;
  if (!view) return;
  field.dispatchEvent(new view.Event('input', { bubbles: true }));
  field.dispatchEvent(new view.Event('change', { bubbles: true }));
}

/** Every token currently visible in the tree, resolvable or not. */
export function tokensInDom(root: Node): string[] {
  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, 4);
  const found = new Set<string>();
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (!looksLikeToken(node.data) || shouldSkip(node)) continue;
    for (const token of tokensIn(node.data)) found.add(token);
  }
  // Fields too, or the title's token is never even asked about.
  const parent = (root as ParentNode).querySelectorAll ? (root as ParentNode) : doc;
  for (const el of parent.querySelectorAll('textarea, input')) {
    const value = (el as HTMLInputElement).value;
    if (!value || !looksLikeToken(value)) continue;
    for (const token of tokensIn(value)) found.add(token);
  }
  return [...found];
}

export function attachDomReveal(doc: Document, opts: DomRevealOptions) {
  let queued = false;
  // The document's own constructor, not the ambient global: a content script has
  // both, but only one of them exists under jsdom — and a seam that needs the
  // global is a seam that cannot be tested.
  const Observer = doc.defaultView?.MutationObserver;
  const observer = Observer
    ? new Observer((records) => {
        if (queued) return;
        queued = true;
        // Coalesced: an SPA render produces hundreds of records for one paint,
        // and re-walking per record is how this becomes the page's performance
        // problem.
        queueMicrotask(() => {
          queued = false;
          for (const record of records) {
            for (const added of record.addedNodes) revealIn(added, opts);
            if (record.type === 'characterData' && record.target) {
              revealIn(record.target.parentNode ?? record.target, opts);
            }
          }
          // Fields are not text nodes, so no mutation record describes them
          // changing value — they need a sweep, not a diff.
          revealFields(doc, opts);
        });
      })
    : null;

  const pass = (): number => revealIn(doc, opts) + revealFields(doc, opts);

  pass();
  observer?.observe(doc, { childList: true, subtree: true, characterData: true });

  return {
    /** Re-run after the cache has been warmed with what `onUnresolved` reported. */
    rerun: pass,
    detach: () => observer?.disconnect(),
  };
}
