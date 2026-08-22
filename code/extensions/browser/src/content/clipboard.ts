/**
 * Clipboard — SPEC §7.
 *
 * The clipboard has no reader identity: one buffer, and every consumer gets the
 * same bytes. Sanitising here is therefore the only decision that covers every
 * destination, all of them unknown at the moment it is made.
 *
 * The awkward part is that `clipboardData` is writable only while the `copy`
 * event is being dispatched, and minting is a round-trip to the vault through
 * the service worker. So the token is not minted during the copy — it is minted
 * while the user is still *selecting*, and the copy handler only spends what is
 * already in hand. `ensure()` on selection change, a synchronous cache read on
 * copy.
 *
 * When the cache misses anyway, the copy still fails closed: the event is
 * cancelled, the clipboard is set empty, and the token is written asynchronously
 * if it arrives. A locally-invented token is never the fallback — the vault
 * would have no record of it, so nothing could ever resolve it.
 */
import { normalizeValue } from '../lib/normalize.ts';
import type { RegistryEntry, SpanRegistry } from '../lib/registry.ts';
import type { Cls } from '../lib/types.ts';

/** `Range.compareBoundaryPoints` selectors, by value: the content script's
 *  isolated world does not share the page realm's `Range` object. */
const START_TO_START = 0;
const START_TO_END = 1;
const END_TO_END = 2;
const END_TO_START = 3;

export interface Replacement {
  /** Offsets into the emitted text, before substitution. */
  start: number;
  end: number;
  token: string;
  cls: Cls;
  /** False for a partial copy, which owes a child token to the vault (§7). */
  whole: boolean;
}

export interface CopyPlan {
  /** What goes on the clipboard. */
  text: string;
  replacements: Replacement[];
  /**
   * False when at least one value had no token yet. The text is then still safe
   * — the value is simply absent rather than substituted — but it is not what
   * should be pasted, so the caller waits rather than writing it.
   */
  ready: boolean;
}

/** What one occurrence in a selection needs a token for. */
export interface Need {
  cls: Cls;
  /** What the page displays, clipped to the selection. */
  value: string;
  normalized: string;
  whole: boolean;
}

export interface MintOutcome {
  ok: boolean;
  /** Why not, in a sentence — printed where the person who copied can see it. */
  reason?: string;
}

export interface Minter {
  /** The scope these tokens are minted under — `(source origin, session)` (§6.3). */
  readonly scopeId: string;
  /** The token for this need if it is already held, else null. Synchronous. */
  get(need: Need): string | null;
  /** Mint whatever is missing. `ok: false` carries why. */
  ensure(needs: readonly Need[]): Promise<MintOutcome>;
}

export interface MintRequest {
  cls: string;
  value: string;
  normalized: string;
  scopeId: string;
}

/**
 * Tokens come from the vault, through the worker. Held per page so that
 * re-copying the same value costs nothing, but never *invented* here: an entry
 * absent from this cache means the vault has not spoken yet.
 */
export interface MintReply {
  tokens: string[] | null;
  reason?: string;
}

export function createRemoteMinter(
  scopeId: string,
  request: (specs: MintRequest[]) => Promise<MintReply | null>,
  /**
   * Called for each token as it is minted, with the value it stands for.
   *
   * A mint is the one moment both halves of the pair are in hand without asking
   * anyone: the vault is being *told* the value, not asked for it. Handing that
   * to the reveal cache here is what lets a paste resolve synchronously later —
   * a `paste` is a user gesture and cannot await a round trip, so a cache that
   * is only filled by `resolve` is always one trip too late (SPEC §10.9.3).
   */
  onMinted?: (token: string, value: string) => void,
): Minter {
  const held = new Map<string, string>();
  const key = (need: Need): string => `${need.cls}|${need.normalized}`;

  return {
    scopeId,
    get(need) {
      return held.get(key(need)) ?? null;
    },
    async ensure(needs) {
      const missing: Need[] = [];
      const seen = new Set<string>();
      for (const need of needs) {
        const k = key(need);
        if (held.has(k) || seen.has(k)) continue;
        seen.add(k);
        missing.push(need);
      }
      if (missing.length === 0) return { ok: true };

      let reply: MintReply | null = null;
      try {
        reply = await request(
          missing.map((need) => ({
            cls: need.cls,
            value: need.value,
            normalized: need.normalized,
            scopeId,
          })),
        );
      } catch (err) {
        // `chrome.runtime.sendMessage` rejects when the worker is gone or the
        // extension was reloaded under a live page. That is a different failure
        // from "the vault said no", and it has a different remedy.
        return { ok: false, reason: reloadHint(err) };
      }
      if (!reply?.tokens) return { ok: false, ...(reply?.reason ? { reason: reply.reason } : {}) };
      const tokens = reply.tokens;
      missing.forEach((need, i) => {
        const token = tokens[i]!;
        held.set(key(need), token);
        onMinted?.(token, need.value);
      });
      return { ok: true };
    },
  };
}

function reloadHint(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return /context invalidated|receiving end does not exist/i.test(raw)
    ? 'the extension was reloaded — reload this page'
    : raw;
}

/** Null when the two ranges do not overlap. Touching is not overlapping. */
function intersect(a: Range, b: Range): Range | null {
  if (a.compareBoundaryPoints(END_TO_START, b) >= 0) return null;
  if (a.compareBoundaryPoints(START_TO_END, b) <= 0) return null;
  const out = a.cloneRange();
  if (a.compareBoundaryPoints(START_TO_START, b) < 0) out.setStart(b.startContainer, b.startOffset);
  if (a.compareBoundaryPoints(END_TO_END, b) > 0) out.setEnd(b.endContainer, b.endOffset);
  return out;
}

/** True when the selection swallows the whole occurrence. */
function contains(outer: Range, inner: Range): boolean {
  return (
    outer.compareBoundaryPoints(START_TO_START, inner) <= 0 &&
    outer.compareBoundaryPoints(END_TO_END, inner) >= 0
  );
}

/** How far into the selection's text the clipped range begins. */
function prefixLength(selection: Range, clipped: Range): number {
  const prefix = selection.cloneRange();
  prefix.setEnd(clipped.startContainer, clipped.startOffset);
  return prefix.toString().length;
}

interface Hit extends Need {
  start: number;
  end: number;
}

/**
 * Everything this selection covers that the registry knows about, in the
 * coordinates of the selection's own text.
 *
 * Shared by the copy handler and the pre-mint pass so the two cannot disagree
 * about what a copy would need — the pre-mint asking for a different set from
 * the one the copy spends is exactly how the cache would miss every time.
 */
export function collectHits(
  selectionRanges: readonly Range[],
  registry: SpanRegistry,
  country?: string,
): { hits: Hit[]; text: string } {
  const parts: string[] = [];
  const hits: Hit[] = [];
  let base = 0;

  for (const selection of selectionRanges) {
    if (parts.length > 0) base += 1; // the '\n' this part is joined on
    const text = selection.toString();
    const local: Hit[] = [];

    for (const entry of registry.entries()) {
      for (const occurrence of entry.ranges) {
        const clipped = intersect(selection, occurrence);
        if (!clipped) continue;
        const start = prefixLength(selection, clipped);
        const value = clipped.toString();
        const end = start + value.length;
        if (end <= start) continue;
        const whole = contains(selection, occurrence);
        local.push({
          start,
          end,
          cls: entry.cls,
          whole,
          // A whole copy is the registry's value, in the registry's normal form,
          // so that the vault collapses it onto the same record as the same value
          // seen on another page. A fragment is its own value and normalises here.
          value: whole ? entry.value : value,
          normalized: whole ? entry.normalized : normalizeValue(entry.cls, value, country ? { country } : {}),
        });
      }
    }

    // Longest-first at equal starts, then drop anything a kept hit already
    // covers: two entries can overlap after the union rule of §3.3 widened one,
    // and a token spliced inside another token is nonsense.
    local.sort((a, b) => a.start - b.start || b.end - a.end);
    let reach = -1;
    for (const hit of local) {
      if (hit.start < reach) continue;
      reach = hit.end;
      hits.push({ ...hit, start: base + hit.start, end: base + hit.end });
    }

    parts.push(text);
    base += text.length;
  }

  return { hits, text: parts.join('\n') };
}

/** Does this selection touch anything sensitive at all? */
export function intersectsRegistry(
  selectionRanges: readonly Range[],
  registry: SpanRegistry,
): boolean {
  for (const entry of registry.entries()) {
    for (const occurrence of entry.ranges) {
      for (const selection of selectionRanges) {
        if (intersect(selection, occurrence)) return true;
      }
    }
  }
  return false;
}

/**
 * Map offsets from our reconstruction onto the string the browser itself would
 * have put on the clipboard.
 *
 * `Selection.toString()` is that string, and it inserts line breaks at block
 * boundaries that `Range.toString()` does not. Rather than guess where, walk the
 * two: ours is the browser's minus some inserted whitespace, so a greedy match
 * gives an exact map. Null when they disagree on a character that is not
 * whitespace — the caller then emits its own text, which costs the line breaks
 * and leaks nothing.
 *
 * One entry per character of `mine`, holding where that character sits in
 * `native`. An exclusive end is therefore `map[end - 1] + 1`, not `map[end]`:
 * the latter is the start of the *next* character, and any break the browser
 * inserted between them would be swallowed into the substitution.
 */
function alignToNative(mine: string, native: string): number[] | null {
  const map = new Array<number>(mine.length);
  let n = 0;
  for (let m = 0; m < mine.length; m++) {
    while (n < native.length && native[n] !== mine[m] && /\s/.test(native[n]!)) n++;
    if (n >= native.length || native[n] !== mine[m]) return null;
    map[m] = n;
    n++;
  }
  return map;
}

/**
 * Decide what a copy of this selection should put on the clipboard.
 *
 * Null means "nothing sensitive here" — the caller must then leave the event
 * alone rather than re-emit the same text, so that an ordinary copy keeps every
 * flavour the browser would have given it.
 */
export function planCopy(
  selectionRanges: readonly Range[],
  nativeText: string,
  registry: SpanRegistry,
  minter: Minter,
  country?: string,
): CopyPlan | null {
  const { hits, text: mine } = collectHits(selectionRanges, registry, country);
  if (hits.length === 0) return null;

  const map = alignToNative(mine, nativeText);
  const text = map ? nativeText : mine;

  let ready = true;
  const replacements: Replacement[] = [];
  for (const hit of hits) {
    const token = minter.get(hit);
    if (token === null) {
      ready = false;
      continue;
    }
    replacements.push({
      start: map ? map[hit.start]! : hit.start,
      end: map ? map[hit.end - 1]! + 1 : hit.end,
      cls: hit.cls,
      whole: hit.whole,
      token,
    });
  }

  // One value short of a full substitution is not a usable clipboard, and a
  // half-substituted string is the one shape worth being careful about: it still
  // holds the values that had no token. Return nothing rather than something a
  // caller might write by mistake.
  if (!ready) return { text: '', replacements, ready: false };

  let out = '';
  let cursor = 0;
  for (const replacement of replacements) {
    out += text.slice(cursor, replacement.start) + replacement.token;
    cursor = replacement.end;
  }
  out += text.slice(cursor);

  return { text: out, replacements, ready: true };
}

export interface ClipboardGuardOptions {
  registry: SpanRegistry;
  minter: Minter;
  /** ISO-3166 alpha-2, for normalising a partial PHONE (SPEC §5.1). */
  country?: string;
  onCopy?: (plan: CopyPlan) => void;
  /**
   * A copy was cancelled and nothing could be put in its place. The clipboard is
   * safe and empty, which is invisible — so this exists to make it not be.
   */
  onFailure?: (reason: string) => void;
  /** How long after the selection settles before tokens are requested. */
  preMintDelayMs?: number;
}

/**
 * Intercept copy and cut, and keep the vault a step ahead of them.
 *
 * Capture phase, so we see the event before a page handler that might call
 * `stopPropagation()` on its way to reading the selection itself.
 */
export function attachClipboardGuard(doc: Document, opts: ClipboardGuardOptions): () => void {
  const view = doc.defaultView;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const currentRanges = (): Range[] => {
    const selection = view?.getSelection?.();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return [];
    const ranges: Range[] = [];
    for (let i = 0; i < selection.rangeCount; i++) ranges.push(selection.getRangeAt(i));
    return ranges;
  };

  /**
   * Mint ahead of the copy. Dragging a selection fires this continuously, hence
   * the debounce; the user still has to release the mouse and reach for Ctrl+C,
   * which is several round-trips' worth of time on any reachable vault.
   */
  const onSelectionChange = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      try {
        const ranges = currentRanges();
        if (ranges.length === 0) return;
        const { hits } = collectHits(ranges, opts.registry, opts.country);
        if (hits.length === 0) return;
        void opts.minter.ensure(hits).then((outcome) => {
          // Silence here is what made a later empty clipboard inexplicable: the
          // vault was already unreachable while the user was still selecting.
          if (!outcome.ok) {
            console.warn(
              `anonymice: cannot mint for this selection — ${outcome.reason ?? 'the vault did not answer'}. ` +
                'Copying it will leave the clipboard empty rather than in the clear.',
            );
          }
        });
      } catch (err) {
        // Pre-minting is an optimisation. A stale Range or a registry mid-
        // revalidation must cost the copy a round-trip, not throw out of a timer
        // where nothing is listening.
        console.error('anonymice: pre-mint failed; the copy will mint inline', err);
      }
    }, opts.preMintDelayMs ?? 150);
  };

  const handler = (event: Event): void => {
    const ranges = currentRanges();
    if (ranges.length === 0) return;
    if (!intersectsRegistry(ranges, opts.registry)) return;

    const clipboardEvent = event as ClipboardEvent;
    // Before anything that can throw: from here the plaintext does not reach the
    // clipboard whatever happens next.
    clipboardEvent.preventDefault();

    const native = (view?.getSelection?.() ?? null)?.toString() ?? '';
    let text = '';
    let plan: CopyPlan | null = null;
    try {
      plan = planCopy(ranges, native, opts.registry, opts.minter, opts.country);
      // `intersectsRegistry` said yes and `planCopy` said no: every overlap was
      // empty. Nothing to protect, so put back what the browser would have.
      if (!plan) text = native;
      else if (plan.ready) {
        text = plan.text;
        opts.onCopy?.(plan);
      }
    } catch (err) {
      // An empty clipboard is a visible, recoverable failure. Falling back to
      // `native` here would hand over exactly what this handler exists to stop.
      console.error('anonymice: copy sanitisation failed — clipboard left empty', err);
    }

    // text/plain only, deliberately. Once the default is prevented the flavours
    // are ours to choose, and text/html would carry the same values through in
    // another form.
    clipboardEvent.clipboardData?.setData('text/plain', text);

    // The pre-mint had not landed. Finish the job out of band: the clipboard is
    // empty and safe either way, so the worst case is that the user pastes
    // nothing and copies again.
    if (plan && !plan.ready) finishLate(doc, ranges, native, opts);
  };

  doc.addEventListener('copy', handler, true);
  doc.addEventListener('cut', handler, true);
  doc.addEventListener('selectionchange', onSelectionChange);
  return () => {
    if (timer) clearTimeout(timer);
    doc.removeEventListener('copy', handler, true);
    doc.removeEventListener('cut', handler, true);
    doc.removeEventListener('selectionchange', onSelectionChange);
  };
}

/**
 * Write the sanitised text after the event is over.
 *
 * `navigator.clipboard.writeText` needs the document focused and, in some
 * configurations, a live user gesture that awaiting has already spent — so this
 * is a best effort by construction. It says so loudly when it fails, because a
 * silently empty clipboard after a deliberate Ctrl+C is the kind of thing users
 * work around by turning the extension off.
 */
function finishLate(
  doc: Document,
  ranges: readonly Range[],
  native: string,
  opts: ClipboardGuardOptions,
): void {
  void (async () => {
    const { hits } = collectHits(ranges, opts.registry, opts.country);
    const outcome = await opts.minter.ensure(hits);
    if (!outcome.ok) {
      const reason = outcome.reason ?? 'the vault did not answer';
      console.error(
        `anonymice: clipboard left empty rather than in the clear — ${reason}`,
      );
      opts.onFailure?.(reason);
      return;
    }
    const plan = planCopy(ranges, native, opts.registry, opts.minter, opts.country);
    if (!plan?.ready) return;
    try {
      await doc.defaultView?.navigator.clipboard.writeText(plan.text);
      opts.onCopy?.(plan);
    } catch (err) {
      console.error('anonymice: could not write the token to the clipboard — copy again', err);
    }
  })();
}
