/**
 * Projection — SPEC §3.5.
 *
 * Turns read-only page text into chunks the backend can score, keeping an exact
 * map back to (node, offset) so a span can become a Range without re-reading the
 * DOM. Source whitespace is collapsed, because markup indentation must not stop
 * "<b>Anna</b>\n  Meier" from matching; the position index is what makes that
 * collapse reversible.
 */
import { toWireText } from './normalize.ts';

/** Skipped outright on NATIVE (SPEC §3.5). */
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION']);

/** Tags that end a chunk. Anything not listed is inline and continues the chunk. */
const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BODY', 'DD', 'DIV', 'DL', 'DT', 'FIELDSET',
  'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER',
  'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'SECTION', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH',
  'THEAD', 'TR', 'UL',
]);

/**
 * Elements that render as whitespace without holding any. Without them
 * "Grüsse<br>Peter Schmid" projects as "GrüssePeter Schmid" and every
 * word-boundary rule silently stops matching.
 */
const BREAK_TAGS = new Set(['BR', 'HR']);

/** Cap so one chunk cannot blow the request caps of SPEC §3.2. */
export const MAX_CHUNK_CHARS = 4000;

export interface Chunk {
  id: string;
  /** Index among the chunks this container produced, so a re-projection can find it again. */
  ordinal: number;
  /** NFC, whitespace-collapsed. Span offsets are UTF-16 code units into this. */
  text: string;
  /** The block element this chunk was projected from. */
  container: Element;
  /** One entry per code unit of `text`: where it came from. */
  positions: Position[];
}

export interface Position {
  node: Text;
  offset: number;
}

export interface ProjectOptions {
  /** Elements to skip entirely — our own UI, and anything the caller vetoes. */
  skip?: (el: Element) => boolean;
}

/**
 * No `instanceof` against realm globals: the projector runs in a content script,
 * in jsdom under the eval, and in tests, and `HTMLElement` is not the same object
 * (or present at all) in each. Attributes are.
 */
function isEditable(el: Element): boolean {
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  const editable = el.getAttribute('contenteditable');
  if (editable !== null && editable.toLowerCase() !== 'false') return true;
  // Browsers expose the inherited answer; jsdom does not, hence the attribute above.
  return (el as Partial<HTMLElement>).isContentEditable === true;
}

function isSkippable(el: Element, opts: ProjectOptions): boolean {
  if (SKIP_TAGS.has(el.tagName)) return true;
  if (isEditable(el)) return true;
  if (el.hasAttribute('data-anonymice')) return true; // our own UI
  if (el.getAttribute('aria-hidden') === 'true') return true;
  return opts.skip?.(el) ?? false;
}

/** Nearest ancestor that starts a chunk. */
function blockAncestor(node: Node, root: Element): Element {
  let el: Element | null = node.parentElement;
  while (el && el !== root.parentElement) {
    if (BLOCK_TAGS.has(el.tagName)) return el;
    el = el.parentElement;
  }
  return root;
}

/**
 * Project a subtree into chunks. Text nodes are visited in document order and
 * grouped by their nearest block ancestor, so an entity straddling inline
 * elements stays inside one chunk.
 */
export function projectSubtree(root: Element, opts: ProjectOptions = {}): Chunk[] {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, 0x01 | 0x04 /* ELEMENT | TEXT */, {
    acceptNode(node: Node) {
      if (node.nodeType === 1) {
        const el = node as Element;
        if (isSkippable(el, opts)) return 2 /* REJECT: prune the subtree */;
        return BREAK_TAGS.has(el.tagName) ? 1 /* ACCEPT: emits a separator */ : 3 /* SKIP: descend */;
      }
      return 1 /* ACCEPT */;
    },
  });

  const chunks: Chunk[] = [];
  let current: { container: Element; parts: string[]; positions: Position[] } | null = null;
  let seq = 0;

  const flush = () => {
    if (!current) return;
    const raw = current.parts.join('');
    if (raw.trim().length > 0) {
      const container = current.container;
      chunks.push({
        id: `c${seq++}`,
        ordinal: chunks.filter((c) => c.container === container).length,
        text: raw,
        container,
        positions: current.positions,
      });
    }
    current = null;
  };

  let pendingBreak = false;
  let node = walker.nextNode();
  while (node) {
    if (node.nodeType === 1) {
      pendingBreak = true; // a <br> between two text nodes is a space, not nothing
      node = walker.nextNode();
      continue;
    }
    const text = node as Text;
    const container = blockAncestor(text, root);
    if (!current || current.container !== container || current.positions.length >= MAX_CHUNK_CHARS) {
      flush();
      current = { container, parts: [], positions: [] };
      pendingBreak = false; // a fresh chunk needs no leading separator
    }
    if (pendingBreak && !endsWithSpace(current.parts)) {
      current.parts.push(' ');
      current.positions.push({ node: text, offset: 0 });
    }
    pendingBreak = false;
    appendCollapsed(current, text);
    node = walker.nextNode();
  }
  flush();

  // Trim the trailing collapse-space each chunk may have picked up.
  return chunks.map(trimChunk).filter((c) => c.text.trim().length > 0);
}

/**
 * Append one text node, collapsing whitespace runs to a single space and
 * recording, for every emitted code unit, the (node, offset) it came from.
 */
function appendCollapsed(
  acc: { parts: string[]; positions: Position[] },
  node: Text,
): void {
  const data = toWireText(node.data);
  // Leading whitespace collapses into whatever the previous node emitted, so a
  // fresh chunk starts "already spaced" and drops its indentation.
  let lastEmittedIsSpace = endsWithSpace(acc.parts);

  for (let i = 0; i < data.length; i++) {
    const ch = data[i]!;
    const isSpace = /\s/.test(ch);
    if (isSpace) {
      if (lastEmittedIsSpace) continue;
      acc.parts.push(' ');
      acc.positions.push({ node, offset: i });
      lastEmittedIsSpace = true;
    } else {
      acc.parts.push(ch);
      acc.positions.push({ node, offset: i });
      lastEmittedIsSpace = false;
    }
  }
}

function endsWithSpace(parts: string[]): boolean {
  const last = parts[parts.length - 1];
  return last === undefined || last === ' ';
}

function trimChunk(chunk: Chunk): Chunk {
  let start = 0;
  let end = chunk.text.length;
  while (start < end && chunk.text[start] === ' ') start++;
  while (end > start && chunk.text[end - 1] === ' ') end--;
  if (start === 0 && end === chunk.text.length) return chunk;
  return {
    ...chunk,
    text: chunk.text.slice(start, end),
    positions: chunk.positions.slice(start, end),
  };
}

/**
 * Re-project a chunk's container and return what this chunk's text is *now*.
 * Null when the container is gone or no longer produces that chunk.
 *
 * The staleness guard of SPEC §3.2 has to read the DOM again: re-hashing the
 * text captured at projection time would compare a value with itself and pass
 * unconditionally.
 */
export function currentTextOf(chunk: Chunk, opts: ProjectOptions = {}): string | null {
  if (!chunk.container.isConnected) return null;
  const fresh = projectSubtree(chunk.container, opts).filter((c) => c.container === chunk.container);
  return fresh[chunk.ordinal]?.text ?? null;
}

/**
 * Turn chunk offsets back into a live DOM Range. `end` is exclusive, matching
 * the wire contract (SPEC §3.2).
 */
export function rangeFor(chunk: Chunk, start: number, end: number): Range | null {
  const first = chunk.positions[start];
  const last = chunk.positions[end - 1];
  if (!first || !last) return null;
  const range = chunk.container.ownerDocument.createRange();
  range.setStart(first.node, first.offset);
  range.setEnd(last.node, last.offset + 1);
  return range;
}
