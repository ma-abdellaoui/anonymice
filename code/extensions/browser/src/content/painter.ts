/**
 * Painter — SPEC §4.
 *
 * Zero DOM mutation is the point: `getSelection().toString()` must be identical
 * to the untouched page, because the copy path depends on it. The overlay
 * fallback keeps that property too — it paints rectangles beside the text, never
 * inside it.
 */

export const HIGHLIGHT_NAME = 'anonymice-sensitive';
const FILL = '#ffdada';
const MARKER_ATTR = 'data-anonymice';

export interface Painter {
  readonly backend: 'highlight' | 'overlay';
  paint(ranges: readonly Range[]): void;
  /** One toggle for the whole page: a page of 400 highlights must stay readable. */
  setDimmed(dimmed: boolean): void;
  clear(): void;
}

interface HighlightRegistryLike {
  set(name: string, highlight: object): void;
  delete(name: string): void;
}

interface HighlightCtor {
  new (...ranges: Range[]): object;
}

function highlightApi(view: Window & typeof globalThis): {
  registry: HighlightRegistryLike;
  Highlight: HighlightCtor;
} | null {
  const css = (view as unknown as { CSS?: { highlights?: HighlightRegistryLike } }).CSS;
  const Highlight = (view as unknown as { Highlight?: HighlightCtor }).Highlight;
  if (!css?.highlights || !Highlight) return null;
  return { registry: css.highlights, Highlight };
}

export interface PainterOptions {
  /** `overlay` skips the Custom Highlight API even where it exists. */
  backend?: 'auto' | 'overlay';
}

export function createPainter(doc: Document, opts: PainterOptions = {}): Painter {
  if (opts.backend === 'overlay') return overlayPainter(doc);
  const view = doc.defaultView as (Window & typeof globalThis) | null;
  const api = view ? highlightApi(view) : null;
  return api ? highlightPainter(doc, api) : overlayPainter(doc);
}

/** Preferred backend: one Highlight object holds all N ranges. */
function highlightPainter(
  doc: Document,
  api: { registry: HighlightRegistryLike; Highlight: HighlightCtor },
): Painter {
  let painted: Range[] = [];
  let dimmed = false;

  const apply = () => {
    if (dimmed || painted.length === 0) {
      api.registry.delete(HIGHLIGHT_NAME);
      return;
    }
    api.registry.set(HIGHLIGHT_NAME, new api.Highlight(...painted));
  };

  return {
    backend: 'highlight',
    paint(ranges) {
      ensureHighlightStyle(doc);
      // Ranges into an open shadow root work, but the ::highlight() rule has to
      // exist in that tree as well (SPEC §4).
      for (const root of shadowRootsOf(ranges)) ensureHighlightStyle(root);
      painted = [...ranges];
      apply();
    },
    setDimmed(next) {
      dimmed = next;
      apply();
    },
    clear() {
      painted = [];
      api.registry.delete(HIGHLIGHT_NAME);
    },
  };
}

/**
 * Fallback for engines without the Custom Highlight API: absolutely-positioned
 * rectangles from Range.getClientRects(), repositioned on scroll and resize.
 */
function overlayPainter(doc: Document): Painter {
  let painted: Range[] = [];
  let dimmed = false;
  let layer: HTMLElement | null = null;
  let frame = 0;

  const ensureLayer = (): HTMLElement => {
    if (layer?.isConnected) return layer;
    layer = doc.createElement('div');
    layer.setAttribute(MARKER_ATTR, 'highlight-layer');
    layer.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:2147483646;';
    doc.body.appendChild(layer);
    return layer;
  };

  const draw = () => {
    frame = 0;
    const host = ensureLayer();
    host.textContent = '';
    if (dimmed) return;
    const view = doc.defaultView;
    const scrollX = view?.scrollX ?? 0;
    const scrollY = view?.scrollY ?? 0;
    for (const range of painted) {
      // Layout APIs are not universally present (headless DOMs, detached trees).
      const rects = typeof range.getClientRects === 'function' ? [...range.getClientRects()] : [];
      for (const rect of rects) {
        const box = doc.createElement('div');
        box.setAttribute(MARKER_ATTR, 'highlight');
        box.style.cssText =
          `position:absolute;left:${rect.left + scrollX}px;top:${rect.top + scrollY}px;` +
          `width:${rect.width}px;height:${rect.height}px;background:${FILL};` +
          'mix-blend-mode:multiply;pointer-events:none;';
        host.appendChild(box);
      }
    }
  };

  const schedule = () => {
    const view = doc.defaultView;
    if (!view?.requestAnimationFrame) return void draw();
    if (frame) return;
    frame = view.requestAnimationFrame(draw);
  };

  const view = doc.defaultView;
  view?.addEventListener('scroll', schedule, { passive: true, capture: true });
  view?.addEventListener('resize', schedule, { passive: true });

  return {
    backend: 'overlay',
    paint(ranges) {
      painted = [...ranges];
      schedule();
    },
    setDimmed(next) {
      dimmed = next;
      schedule();
    },
    clear() {
      painted = [];
      layer?.remove();
      layer = null;
    },
  };
}

/**
 * `::highlight()` only paints where the rule exists — inject once per tree.
 *
 * nodeType, not `instanceof Document`: the painter runs in a content script's
 * isolated world, where the page realm's globals are different objects.
 */
function ensureHighlightStyle(root: Document | ShadowRoot): void {
  const isDocument = root.nodeType === 9 /* DOCUMENT_NODE */;
  const doc = isDocument ? (root as Document) : (root as ShadowRoot).ownerDocument;
  const holder: ParentNode | null = isDocument
    ? ((root as Document).head ?? (root as Document).documentElement)
    : (root as ShadowRoot);
  if (!holder || !doc) return;
  if (holder.querySelector?.(`style[${MARKER_ATTR}="highlight-style"]`)) return;
  const style = doc.createElement('style');
  style.setAttribute(MARKER_ATTR, 'highlight-style');
  style.textContent = `::highlight(${HIGHLIGHT_NAME}) { background-color: ${FILL}; }`;
  holder.appendChild(style);
}

function shadowRootsOf(ranges: readonly Range[]): ShadowRoot[] {
  const roots = new Set<ShadowRoot>();
  for (const range of ranges) {
    const root = range.startContainer.getRootNode?.();
    if (root && root.nodeType === 11 /* DOCUMENT_FRAGMENT_NODE */ && 'host' in root) {
      roots.add(root as ShadowRoot);
    }
  }
  return [...roots];
}
