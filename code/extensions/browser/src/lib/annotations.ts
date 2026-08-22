/**
 * Site annotations — SPEC §3.4.
 *
 * The one detection layer that runs client-side, because `data-sensitive` is a
 * DOM fact the backend cannot see. Annotations only ever add spans: there is no
 * suppressing form, so a hostile page can at worst cause a false positive.
 */
import type { Chunk } from './project.ts';
import { isCls, type Cls, type Span } from './types.ts';

export const ANNOTATION_ATTR = 'data-sensitive';

/**
 * Annotation spans for one chunk, in chunk coordinates.
 *
 * Nested annotations resolve innermost-first: the deepest element wins the class
 * for the text it covers, and an outer annotation still contributes its own
 * extent, which the merge (SPEC §3.3) then widens into.
 */
export function annotationSpans(chunk: Chunk): Span[] {
  const annotated = chunk.container.querySelectorAll(`[${ANNOTATION_ATTR}]`);
  const candidates: Array<{ el: Element; depth: number }> = [];

  // The container itself may carry the attribute (<td data-sensitive="IBAN">).
  if (chunk.container.hasAttribute(ANNOTATION_ATTR)) {
    candidates.push({ el: chunk.container, depth: depthOf(chunk.container) });
  }
  for (const el of annotated) candidates.push({ el, depth: depthOf(el) });
  candidates.sort((a, b) => b.depth - a.depth); // innermost first

  const spans: Span[] = [];
  for (const { el } of candidates) {
    const extent = extentOf(chunk, el);
    if (!extent) continue;
    const raw = el.getAttribute(ANNOTATION_ATTR);
    spans.push({
      start: extent.start,
      end: extent.end,
      cls: classFor(raw),
      origin: 'annotation',
    });
  }
  return spans;
}

/**
 * A bare `data-sensitive` means "sensitive, class unknown" and is kept rather
 * than dropped; an unrecognised value is treated the same way (SPEC §3.4).
 */
function classFor(raw: string | null): Cls {
  if (raw === null) return 'UNKNOWN';
  const upper = raw.trim().toUpperCase();
  return isCls(upper) ? upper : 'UNKNOWN';
}

function depthOf(el: Element): number {
  let d = 0;
  let cur: Element | null = el;
  while ((cur = cur.parentElement)) d++;
  return d;
}

/** Chunk-coordinate extent of everything `el` contributed to this chunk. */
function extentOf(chunk: Chunk, el: Element): { start: number; end: number } | null {
  let start = -1;
  let end = -1;
  for (let i = 0; i < chunk.positions.length; i++) {
    const node = chunk.positions[i]!.node;
    if (!el.contains(node)) continue;
    if (start < 0) start = i;
    end = i + 1;
  }
  if (start < 0) return null;
  // Trim the collapse-space an element boundary may have contributed.
  while (start < end && chunk.text[start] === ' ') start++;
  while (end > start && chunk.text[end - 1] === ' ') end--;
  return end > start ? { start, end } : null;
}
