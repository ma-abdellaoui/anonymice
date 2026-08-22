/**
 * Scanning loop — SPEC §3.5.
 *
 * MutationObserver -> debounce -> dirty set -> idle callback, viewport first.
 * The registry is the single source of truth across rescans: ranges inside a
 * dirty block are dropped before it is re-projected, so a re-render cannot stack
 * duplicate highlights over one occurrence.
 */
import { runPipeline, type Detector } from '../lib/pipeline.ts';
import { SpanRegistry } from '../lib/registry.ts';
import { createPainter, type Painter } from './painter.ts';

export interface ScanState {
  /** Distinct values found — one entry is one real value, however often it appears. */
  values: number;
  /** Painted occurrences. */
  occurrences: number;
  /** Detection failed: the badge must say "not scanned", not stay silent (SPEC §3.2). */
  unscanned: boolean;
  /** Distinct values per class, for the notification's breakdown line. */
  byClass: Record<string, number>;
}

export interface ScannerOptions {
  detector: Detector;
  root?: Element;
  locale?: string;
  painter?: Painter;
  /** Forces the fallback backend when set to 'overlay'. */
  painterBackend?: 'auto' | 'overlay';
  onUpdate?: (state: ScanState) => void;
  debounceMs?: number;
}

const BLOCKISH = 'p,div,li,td,th,section,article,h1,h2,h3,h4,h5,h6,dd,dt,blockquote,main,aside,header,footer';

export class Scanner {
  readonly registry = new SpanRegistry();
  readonly #opts: ScannerOptions;
  readonly #doc: Document;
  readonly #root: Element;
  readonly #painter: Painter;
  #observer: MutationObserver | null = null;
  #dirty = new Set<Element>();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #unscanned = false;

  constructor(opts: ScannerOptions) {
    this.#opts = opts;
    this.#root = opts.root ?? document.body;
    this.#doc = this.#root.ownerDocument;
    this.#painter =
      opts.painter ?? createPainter(this.#doc, opts.painterBackend ? { backend: opts.painterBackend } : {});
  }

  get painterBackend(): Painter['backend'] {
    return this.#painter.backend;
  }

  /** Full pass over the root. */
  async scan(): Promise<ScanState> {
    const result = await runPipeline(this.#root, this.#opts.detector, {
      registry: this.registry,
      ...(this.#opts.locale ? { locale: this.#opts.locale } : {}),
    });
    this.#unscanned = result.unscanned;
    return this.#repaint();
  }

  /** Re-scan only the blocks that changed. */
  async rescan(containers: Iterable<Element>): Promise<ScanState> {
    this.registry.revalidate();
    for (const container of containers) {
      if (!container.isConnected) continue;
      this.registry.dropRangesWithin(container);
      const result = await runPipeline(container, this.#opts.detector, {
        registry: this.registry,
        ...(this.#opts.locale ? { locale: this.#opts.locale } : {}),
      });
      this.#unscanned = result.unscanned || this.#unscanned;
    }
    return this.#repaint();
  }

  observe(): void {
    if (this.#observer) return;
    const view = this.#doc.defaultView;
    if (!view?.MutationObserver) return;
    this.#observer = new view.MutationObserver((records) => {
      for (const record of records) {
        const el =
          record.target.nodeType === 1
            ? (record.target as Element)
            : record.target.parentElement;
        const block = el?.closest(BLOCKISH) ?? el;
        if (block && !isOurs(block)) this.#dirty.add(block);
      }
      this.#schedule();
    });
    this.#observer.observe(this.#root, { childList: true, characterData: true, subtree: true });
  }

  stop(): void {
    this.#observer?.disconnect();
    this.#observer = null;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#painter.clear();
  }

  setDimmed(dimmed: boolean): void {
    this.#painter.setDimmed(dimmed);
  }

  #schedule(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      const dirty = [...this.#dirty];
      this.#dirty.clear();
      if (dirty.length === 0) return;
      whenIdle(this.#doc, () => void this.rescan(dirty));
    }, this.#opts.debounceMs ?? 250);
  }

  #repaint(): ScanState {
    this.registry.revalidate();
    const ranges = this.registry.allRanges();
    this.#painter.paint(ranges);
    const byClass: Record<string, number> = {};
    for (const entry of this.registry.entries()) byClass[entry.cls] = (byClass[entry.cls] ?? 0) + 1;
    const state: ScanState = {
      values: this.registry.size,
      occurrences: ranges.length,
      unscanned: this.#unscanned,
      byClass,
    };
    this.#opts.onUpdate?.(state);
    return state;
  }
}

function isOurs(el: Element): boolean {
  return el.closest('[data-anonymice]') !== null;
}

function whenIdle(doc: Document, fn: () => void): void {
  const view = doc.defaultView as (Window & { requestIdleCallback?: (cb: () => void) => number }) | null;
  if (view?.requestIdleCallback) view.requestIdleCallback(fn);
  else setTimeout(fn, 0);
}
