/**
 * Span registry — SPEC §5.
 *
 * The durable artifact: keyed by value, not by occurrence. Highlighting reads
 * `allRanges()`; the clipboard step reads entries. Nothing downstream re-reads
 * the DOM.
 */
import { spanIdFor } from './digest.ts';
import { normalizeValue } from './normalize.ts';
import { rangeFor, type Chunk } from './project.ts';
import type { Cls, Origin, Span } from './types.ts';
import { precedenceOf } from './types.ts';

export interface RegistryEntry {
  spanId: string;
  cls: Cls;
  /** What the page literally displays, in the first occurrence's formatting. */
  value: string;
  /** Canonical form. Its digest is the spanId (SPEC §5.1). */
  normalized: string;
  /** Live DOM locations of every occurrence. */
  ranges: Range[];
  origin: Origin;
  /**
   * Tokens are minted lazily and are per scope, so this is a map, not a field
   * (SPEC §5.2). Absent means "not copied yet", never "unknown".
   */
  tokens?: Record<string, string>;
}

export interface AddResult {
  entry: RegistryEntry;
  /** False when the span produced no live Range (chunk went stale). */
  placed: boolean;
}

export class SpanRegistry {
  readonly #entries = new Map<string, RegistryEntry>();

  get size(): number {
    return this.#entries.size;
  }

  entries(): RegistryEntry[] {
    return [...this.#entries.values()];
  }

  get(spanId: string): RegistryEntry | undefined {
    return this.#entries.get(spanId);
  }

  /** Every live Range, for one `new Highlight(...ranges)` (SPEC §4). */
  allRanges(): Range[] {
    return this.entries().flatMap((e) => e.ranges);
  }

  /**
   * Record one detected span. Two occurrences that normalise the same collapse
   * into one entry with two ranges.
   */
  async add(chunk: Chunk, span: Span, country?: string): Promise<AddResult> {
    const value = chunk.text.slice(span.start, span.end);
    const normalized = span.normalized ?? normalizeValue(span.cls, value, country ? { country } : {});
    const spanId = await spanIdFor(normalized);
    const range = rangeFor(chunk, span.start, span.end);

    let entry = this.#entries.get(spanId);
    if (!entry) {
      entry = { spanId, cls: span.cls, value, normalized, ranges: [], origin: span.origin };
      this.#entries.set(spanId, entry);
    } else if (precedenceOf(span.origin) > precedenceOf(entry.origin)) {
      // The class comes from the highest-precedence origin that matched (SPEC §5).
      entry.cls = span.cls;
      entry.origin = span.origin;
    }
    if (range) entry.ranges.push(range);
    return { entry, placed: range !== null };
  }

  /**
   * Drop ranges that no longer describe their value — SPEC §4: ranges go stale on
   * mutation, and the registry revalidates rather than trusting them. Entries
   * that lose every range are removed, so the painter never holds a phantom.
   */
  revalidate(): { dropped: number; removed: number } {
    let dropped = 0;
    let removed = 0;
    for (const [id, entry] of this.#entries) {
      const kept = entry.ranges.filter((r) => isLive(r, entry));
      dropped += entry.ranges.length - kept.length;
      entry.ranges = kept;
      if (kept.length === 0) {
        this.#entries.delete(id);
        removed++;
      }
    }
    return { dropped, removed };
  }

  /**
   * Forget everything painted inside a subtree, so re-scanning a mutated block
   * cannot stack a second Range over the same occurrence.
   */
  dropRangesWithin(container: Element): void {
    for (const [id, entry] of this.#entries) {
      entry.ranges = entry.ranges.filter((r) => !container.contains(r.startContainer));
      if (entry.ranges.length === 0) this.#entries.delete(id);
    }
  }

  clear(): void {
    this.#entries.clear();
  }
}

function isLive(range: Range, entry: RegistryEntry): boolean {
  const node = range.startContainer;
  if (!node.isConnected) return false;
  try {
    const text = range.toString();
    // Whitespace collapsed at projection time, so compare on the collapsed form.
    return text.replace(/\s+/g, ' ').trim() === entry.value.replace(/\s+/g, ' ').trim();
  } catch {
    return false;
  }
}
