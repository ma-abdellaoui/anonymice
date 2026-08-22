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
 * live caret moves the caret, and a user mid-word will lose their place — so
 * the pass runs again on `focusout`, which is the only signal that the caret
 * has left. A blur emits no mutation record, so the observer cannot see it.
 *
 * ## Diagnostics
 *
 * Everything below the `note` calls is counting, not deciding. A pass that does
 * nothing has four different reasons for doing nothing — no token-shaped text,
 * skipped by tag, skipped because an editable has focus, or found but
 * unresolved — and "DOM nodes rewritten: 0" cannot tell them apart. That
 * distinction is the whole debugging question on a destination, so the pass
 * reports which one it was. Off unless the policy asks for debug (§10.8).
 */
import { detokenize, tokensIn } from '../lib/detokenize.ts';
import { looksLikeToken, scanTokens } from '../lib/tokens.ts';
import { alarm, isDebug, note } from '../lib/debug.ts';

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
  /** Reported when a paste was taken, so QA can see the fast path engage. */
  onPasteRevealed?: (tokens: number) => void;
}

/**
 * `TAG.class#id`, enough to recognise a specific editor in a console line and
 * no more. Never the node's text — a skip report must not become the leak the
 * reveal was avoiding.
 */
function describe(el: Element): string {
  const cls = el.classList.length ? `.${[...el.classList].slice(0, 2).join('.')}` : '';
  return `${el.tagName}${cls}${el.id ? `#${el.id}` : ''}`;
}

/**
 * Why this node was left alone, or `null` to walk it. A reason rather than a
 * boolean because the reason is the diagnostic: "skipped, focused editable
 * DIV.ProseMirror" is an answer, and `true` is not.
 */
/**
 * Whether the caret is genuinely live in this element.
 *
 * `activeElement` alone does not answer that. It keeps naming the last focused
 * element after the *window* loses focus, so clicking into DevTools — or any
 * other tab — leaves an editable looking focused for as long as the page is
 * open, and the node the caret was in is never revisited. On Confluence that is
 * the difference between a pasted token revealing on blur and staying a token
 * until reload: ProseMirror drops its own `ProseMirror-focused` class, but
 * `document.activeElement` still points at `#ak-editor-textarea`.
 *
 * `hasFocus()` separates "the user is typing here" from "this is merely where
 * they last were", and only the first is a caret worth protecting.
 */
function caretIsIn(el: Element): boolean {
  const doc = el.ownerDocument;
  return doc.activeElement === el && doc.hasFocus();
}

function skipReason(node: Text): string | null {
  for (let el = node.parentElement; el; el = el.parentElement) {
    if (SKIP_TAGS.has(el.tagName)) return `tag:${el.tagName}`;
    if (el.hasAttribute(OWNED)) return 'ours-already';
    // A focused editable is being typed in; moving its text moves the caret.
    if (el.isContentEditable && caretIsIn(el)) {
      return `focused-editable:${describe(el)}`;
    }
  }
  return null;
}

/** Counters for one logical pass, which may span many `revealIn` calls. */
interface Stats {
  tokenShaped: number;
  rewritten: number;
  skipped: Map<string, number>;
  unresolved: Set<string>;
  fieldsSeen: number;
  fieldsSkipped: Map<string, number>;
}

const newStats = (): Stats => ({
  tokenShaped: 0,
  rewritten: 0,
  skipped: new Map(),
  unresolved: new Set(),
  fieldsSeen: 0,
  fieldsSkipped: new Map(),
});

const bump = (counts: Map<string, number>, key: string): void => {
  counts.set(key, (counts.get(key) ?? 0) + 1);
};

const summarise = (counts: Map<string, number>): string =>
  [...counts].map(([key, n]) => `${key}×${n}`).join(', ');

/**
 * One line per pass, and only when the pass had something to be silent about.
 * Confluence mutates continuously; logging every empty walk would bury the one
 * line that matters under thousands that do not.
 */
function report(label: string, stats: Stats): void {
  if (!isDebug()) return;
  if (stats.tokenShaped === 0 && stats.fieldsSeen === 0) return;
  const parts = [
    `token-shaped nodes: ${stats.tokenShaped}`,
    `rewritten: ${stats.rewritten}`,
  ];
  if (stats.skipped.size) parts.push(`skipped: ${summarise(stats.skipped)}`);
  if (stats.fieldsSeen) parts.push(`fields with tokens: ${stats.fieldsSeen}`);
  if (stats.fieldsSkipped.size) parts.push(`fields skipped: ${summarise(stats.fieldsSkipped)}`);
  if (stats.unresolved.size) parts.push(`unresolved: ${[...stats.unresolved].join(' ')}`);
  note(`dom-reveal ${label} — ${parts.join(' | ')}`);
}

/** The walk itself, accumulating into a caller-owned counter set. */
function walkInto(root: Node, opts: DomRevealOptions, stats: Stats): number {
  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, 4 /* SHOW_TEXT */);
  const pending: Text[] = [];
  const unresolved = new Set<string>();

  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    // Cheap reject before the expensive normalising scan; most text is not ours.
    if (!looksLikeToken(node.data)) continue;
    stats.tokenShaped++;
    const skip = skipReason(node);
    if (skip) {
      bump(stats.skipped, skip);
      continue;
    }
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

  stats.rewritten += changed;
  for (const token of unresolved) stats.unresolved.add(token);
  if (unresolved.size) opts.onUnresolved?.([...unresolved]);
  return changed;
}

/**
 * One pass over a subtree. Returns how many nodes changed, so a caller can tell
 * "nothing to do" from "did work" without re-walking.
 */
export function revealIn(root: Node, opts: DomRevealOptions): number {
  const stats = newStats();
  const changed = walkInto(root, opts, stats);
  report('text walk', stats);
  return changed;
}

/** The field sweep, accumulating into a caller-owned counter set. */
function fieldsInto(root: ParentNode, opts: DomRevealOptions, stats: Stats): number {
  const fields = root.querySelectorAll('textarea, input');
  const unresolved = new Set<string>();
  let changed = 0;

  for (const el of fields) {
    const field = el as HTMLInputElement | HTMLTextAreaElement;
    if (field.tagName === 'INPUT') {
      const type = (field.getAttribute('type') ?? 'text').toLowerCase();
      if (!FIELD_TYPES.has(type)) continue;
    }
    const value = field.value;
    // Counted before the skips, so a field holding a token that we declined to
    // touch is visible in the log rather than indistinguishable from no field.
    if (!value || !looksLikeToken(value)) continue;
    stats.fieldsSeen++;
    if (field.closest(`[${OWNED}]`)) {
      bump(stats.fieldsSkipped, `ours-already:${describe(field)}`);
      continue;
    }
    if (caretIsIn(field)) {
      bump(stats.fieldsSkipped, `focused:${describe(field)}`);
      continue;
    }

    const result = detokenize(value, opts.valueFor);
    for (const token of result.unresolved) unresolved.add(token);
    if (result.replaced.length === 0) continue;

    // Through the native setter, for the same reason §8.3 uses it: the page's
    // own setter may be patched, and React has to notice the change.
    setFieldValue(field, result.text);
    changed++;
  }

  stats.rewritten += changed;
  for (const token of unresolved) stats.unresolved.add(token);
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
  const stats = newStats();
  const changed = fieldsInto(root, opts, stats);
  report('field sweep', stats);
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
    if (!looksLikeToken(node.data) || skipReason(node)) continue;
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

/**
 * Tokens the walk *declined* to look at, with the reason. `tokensInDom` is what
 * the bridge asks the vault about, so anything only visible here is a token the
 * vault is never told about — which is silent by construction and is exactly
 * the failure this instrumentation exists to name.
 */
function tokensSkipped(doc: Document): Array<{ token: string; why: string }> {
  const walker = doc.createTreeWalker(doc, 4);
  const out: Array<{ token: string; why: string }> = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (!looksLikeToken(node.data)) continue;
    const why = skipReason(node);
    if (!why || why.startsWith('tag:') || why === 'ours-already') continue;
    for (const token of tokensIn(node.data)) out.push({ token, why });
  }
  return out;
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
          // One counter set for the whole batch, so a paint that touches forty
          // subtrees is one console line rather than forty.
          const stats = newStats();
          for (const record of records) {
            for (const added of record.addedNodes) walkInto(added, opts, stats);
            if (record.type === 'characterData' && record.target) {
              walkInto(record.target.parentNode ?? record.target, opts, stats);
            }
          }
          // Fields are not text nodes, so no mutation record describes them
          // changing value — they need a sweep, not a diff.
          fieldsInto(doc, opts, stats);
          report(`mutation batch (${records.length} records)`, stats);
        });
      })
    : null;

  const pass = (): number => {
    const stats = newStats();
    const changed = walkInto(doc, opts, stats) + fieldsInto(doc, opts, stats);
    report('full pass', stats);
    return changed;
  };

  /**
   * Take the paste itself — SPEC §10.9.4.
   *
   * Rewriting after the fact is what all the trouble came from: the editor owns
   * its DOM, so a text node we substitute is either reverted on the next render
   * or read back into the document model, and either way the caret has moved
   * under the user. Here the token has not entered the editor yet. We resolve
   * the clipboard, cancel the event, and let the *editor* insert — so it does
   * the caret arithmetic and writes its own undo entry, and its DOM observer
   * sees nothing it did not do itself.
   *
   * Everything is synchronous by construction. `getData` is sync, and the cache
   * was warmed at mint (`createRemoteMinter`'s `onMinted`), so the common case —
   * copied in this browser — needs no round trip. A miss is not an error: warm
   * the vault, decline the paste, and today's observer pass picks it up as it
   * always did.
   */
  const onPasteReveal = (event: Event): boolean => {
    const data = (event as ClipboardEvent).clipboardData;
    if (!data) return false;

    // Fields are `reveal.ts`'s paste path, and it mounts a whole frame for them
    // (SPEC §8.3). Two handlers cancelling one event is not a thing.
    const target = event.target as (Element & { isContentEditable?: boolean }) | null;
    if (!target || target.isContentEditable !== true) return false;

    const text = data.getData('text/plain');
    if (!text || !looksLikeToken(text)) return false;

    // Our own copy writes text/plain only, deliberately. A token arriving with a
    // rich flavour came from somewhere else, and replacing it with bare text
    // would silently drop the formatting the user pasted.
    if (data.getData('text/html')) return false;

    const result = detokenize(text, opts.valueFor);
    if (result.replaced.length === 0) {
      if (result.unresolved.length) opts.onUnresolved?.(result.unresolved);
      return false;
    }
    if (result.unresolved.length) {
      // A partial reveal would put half the values in and leave half as tokens,
      // with no second pass able to tell which is which. Warm and decline.
      opts.onUnresolved?.(result.unresolved);
      return false;
    }

    const view = doc.defaultView;
    // Checked before cancelling, not after: once the default is prevented, a
    // failed insert has eaten the user's paste with nothing to show for it.
    if (typeof doc.execCommand !== 'function' || !view?.getSelection()?.rangeCount) return false;

    event.preventDefault();
    // The page's own paste handler is still on the propagation path and would
    // read the untouched clipboard for itself (SPEC §8.3).
    event.stopImmediatePropagation();

    if (!doc.execCommand('insertText', false, result.text)) {
      alarm('paste reveal could not insert — the paste was lost, reload the page');
      return true;
    }
    opts.onPasteRevealed?.(result.replaced.length);
    return true;
  };

  /**
   * Diagnostics only — passive, and it never reads the clipboard's text into a
   * log. A paste is the moment the user is testing, and silence afterwards has
   * two very different causes: the observer never fired, or it fired and every
   * node was skipped. This says which, at the two moments that matter — the
   * synchronous insert, and after the editor has had a frame to settle.
   */
  const onPaste = (event: Event): void => {
    if (onPasteReveal(event)) return;
    if (!isDebug()) return;
    const clip = (event as ClipboardEvent).clipboardData?.getData('text/plain') ?? '';
    // Duck-typed rather than `instanceof Element`: the isolated world and the
    // page have different realms, and jsdom has neither global under test.
    const target = event.target as (Element & { isContentEditable?: boolean }) | null;
    const active = doc.activeElement as (Element & { isContentEditable?: boolean }) | null;
    note('paste seen', {
      'tokens in clipboard': scanTokens(clip).length,
      target: target?.tagName ? describe(target) : '(not an element)',
      'target editable': target?.isContentEditable === true,
      activeElement: active?.tagName ? describe(active) : '(none)',
      'active is editable': active?.isContentEditable === true,
    });
    const after = (when: string) => () => {
      note(`paste +${when}`, {
        'tokens the walk can see': tokensInDom(doc),
        'tokens the walk skips': tokensSkipped(doc),
      });
    };
    doc.defaultView?.setTimeout(after('0ms'), 0);
    doc.defaultView?.setTimeout(after('500ms'), 500);
  };

  /**
   * The blur trigger. The focus guard is right — rewriting under a live caret
   * moves the caret — but a paste into a focused editable is then skipped, and
   * a blur is not a mutation, so without this nothing ever revisits it. That is
   * the whole reason a pasted token stayed showing until a reload.
   *
   * Deferred a tick: at `focusout` the caret has left but has not landed, so
   * `skipReason` would be judging against a focus state that is still moving.
   */
  const onFocusOut = (): void => {
    doc.defaultView?.setTimeout(() => {
      const changed = pass();
      if (!isDebug()) return;
      if (changed) {
        note(`focusout — re-pass rewrote ${changed} node(s) the caret had been blocking`);
        return;
      }
      const stuck = tokensInDom(doc);
      const skipped = tokensSkipped(doc);
      if (!stuck.length && !skipped.length) return;
      note('focusout — re-pass changed nothing', {
        'tokens still showing': stuck,
        'still skipped': skipped,
      });
    }, 0);
  };

  pass();
  observer?.observe(doc, { childList: true, subtree: true, characterData: true });
  doc.addEventListener('paste', onPaste, true);
  doc.addEventListener('focusout', onFocusOut, true);

  return {
    /** Re-run after the cache has been warmed with what `onUnresolved` reported. */
    rerun: pass,
    detach: () => {
      observer?.disconnect();
      doc.removeEventListener('paste', onPaste, true);
      doc.removeEventListener('focusout', onFocusOut, true);
    },
  };
}
