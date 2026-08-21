// Span algebra. Substitution walks in REVERSE offset order so earlier
// replacements do not shift later indices. See docs/USER_FLOWS.md §1.

// A span: { start, end, cls, value, confidence }

export function sortSpans(spans) {
  return [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
}

// Overlaps are resolved by (1) higher confidence, (2) longer match.
// Fail-closed: a partial/ambiguous overlap widens to cover both.
export function mergeOverlapping(spans) {
  const out = [];
  for (const s of sortSpans(spans)) {
    const prev = out[out.length - 1];
    if (prev && s.start < prev.end) {
      const keep = s.confidence > prev.confidence ||
        (s.confidence === prev.confidence && s.end - s.start > prev.end - prev.start)
        ? s : prev;
      out[out.length - 1] = {
        ...keep,
        start: Math.min(prev.start, s.start),
        end: Math.max(prev.end, s.end)
      };
    } else {
      out.push(s);
    }
  }
  return out;
}

export function applySpans(text, spans, replacementFor) {
  let out = text;
  for (const s of mergeOverlapping(spans).reverse()) {
    out = out.slice(0, s.start) + replacementFor(s) + out.slice(s.end);
  }
  return out;
}

// Flatten a DOM subtree to a text projection plus a node/offset map so an
// entity may straddle element boundaries (`<b>Anna</b> Meier`).
export function projectNodes(root) {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const map = [];
  let text = '';
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    map.push({ node: n, start: text.length, end: text.length + n.data.length });
    text += n.data;
  }
  return { text, map };
}
