/**
 * Span algebra — SPEC §3.3.
 *
 * Precedence is annotation > rule > model, then extent. On an overlap the class
 * comes from the higher-precedence origin but the extent is the union: a span is
 * never narrowed by a higher-ranked one. Fail-closed by construction.
 */
import { precedenceOf, type Span } from './types.ts';

/** True when the two spans share at least one code unit. Touching is not overlapping. */
function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end;
}

/** The span whose class and origin survive a merge. */
function dominant(a: Span, b: Span): Span {
  const pa = precedenceOf(a.origin);
  const pb = precedenceOf(b.origin);
  if (pa !== pb) return pa > pb ? a : b;
  const la = a.end - a.start;
  const lb = b.end - b.start;
  if (la !== lb) return la > lb ? a : b;
  return a.start <= b.start ? a : b;
}

/**
 * Merge every overlapping cluster into one span. Runs to a fixpoint: widening a
 * cluster can pull in a span that did not overlap either input on its own.
 */
export function mergeSpans(input: readonly Span[]): Span[] {
  const sorted = [...input]
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start || b.end - a.end);

  const out: Span[] = [];
  for (const span of sorted) {
    const last = out[out.length - 1];
    if (last && overlaps(last, span)) {
      const winner = dominant(last, span);
      out[out.length - 1] = {
        start: Math.min(last.start, span.start),
        end: Math.max(last.end, span.end),
        cls: winner.cls,
        origin: winner.origin,
        ...(winner.normalized !== undefined ? { normalized: winner.normalized } : {}),
      };
    } else {
      out.push({ ...span });
    }
  }
  return out;
}

/** Slice the chunk text a span covers. */
export function textOf(chunkText: string, span: Span): string {
  return chunkText.slice(span.start, span.end);
}
