/**
 * Ground-truth coordinate space for the eval — deliberately NOT src/lib/project.ts.
 *
 * If the harness measured predictions in coordinates the projector invented, a
 * projector bug would cancel itself out and score perfectly. So this walks the
 * document independently, and predicted Ranges are mapped into its space.
 */

export interface Flat {
  text: string;
  /** node -> [nodeOffset, flatIndex][] for the code units this node contributed. */
  index: Map<Text, Array<[number, number]>>;
}

const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);

/** Whole-document text with whitespace collapsed, plus a reverse index. */
export function flatten(doc: Document): Flat {
  const parts: string[] = [];
  const index = new Map<Text, Array<[number, number]>>();
  let lastWasSpace = true;

  const walk = (node: Node): void => {
    if (node.nodeType === 1) {
      const el = node as Element;
      if (SKIP.has(el.tagName)) return;
      for (const child of [...el.childNodes]) walk(child);
      return;
    }
    if (node.nodeType !== 3) return;
    const text = node as Text;
    const data = text.data.normalize('NFC');
    const entries: Array<[number, number]> = [];
    for (let i = 0; i < data.length; i++) {
      const ch = data[i]!;
      if (/\s/.test(ch)) {
        if (lastWasSpace) continue;
        entries.push([i, parts.length]);
        parts.push(' ');
        lastWasSpace = true;
      } else {
        entries.push([i, parts.length]);
        parts.push(ch);
        lastWasSpace = false;
      }
    }
    if (entries.length) index.set(text, entries);
  };

  walk(doc.body);
  return { text: parts.join(''), index };
}

/** Map a live Range into flat coordinates. Null when it covers nothing indexed. */
export function rangeToFlat(flat: Flat, range: Range): { start: number; end: number } | null {
  const start = flatIndexAtOrAfter(flat, range.startContainer as Text, range.startOffset);
  const end = flatIndexAtOrBefore(flat, range.endContainer as Text, range.endOffset - 1);
  if (start === null || end === null || end < start) return null;
  return { start, end: end + 1 };
}

function flatIndexAtOrAfter(flat: Flat, node: Text, offset: number): number | null {
  const entries = flat.index.get(node);
  if (!entries) return null;
  for (const [nodeOffset, flatIndex] of entries) if (nodeOffset >= offset) return flatIndex;
  return null;
}

function flatIndexAtOrBefore(flat: Flat, node: Text, offset: number): number | null {
  const entries = flat.index.get(node);
  if (!entries) return null;
  let best: number | null = null;
  for (const [nodeOffset, flatIndex] of entries) {
    if (nodeOffset <= offset) best = flatIndex;
    else break;
  }
  return best;
}

/** Resolve `{value, nth}` ground truth to flat coordinates. */
export function locate(flat: Flat, value: string, nth: number): { start: number; end: number } | null {
  const needle = value.normalize('NFC').replace(/\s+/g, ' ').trim();
  let from = 0;
  for (let i = 0; i < nth; i++) {
    const at = flat.text.indexOf(needle, from);
    if (at < 0) return null;
    if (i === nth - 1) return { start: at, end: at + needle.length };
    from = at + 1;
  }
  return null;
}
