/**
 * The detection engine — both guessing passes, one authority (SPEC §3.1).
 *
 * Responsibilities, in the order they matter:
 *
 *  - **Compose the passes.** Rule pass then model pass, over the chunk text
 *    exactly as received. Nothing re-normalises the text: offsets are UTF-16
 *    code units into the string the client sent (SPEC §3.2), so re-normalising
 *    it here would shift every offset the client is about to paint with.
 *  - **Be deterministic.** Spans come back in a total order — start, end, class,
 *    origin — and exact duplicates collapse. Same text and versions ⇒ the same
 *    bytes, which is what `spanId` and both caches rest on.
 *  - **Fail loudly.** If a pass throws, the whole request fails and the route
 *    answers `502`. Returning `200` with the spans that did work would read to
 *    the client as "nothing sensitive here" — the one lie the product cannot
 *    tell (ENDPOINTS.md §3).
 *
 * On hashes: the client's `hash` is echoed back, because that is what binds a
 * response chunk to a request chunk and what the client keys its own cache on.
 * It is **not** trusted as this cache's key — the key is a hash computed here
 * over the text actually received. A client that miscomputes its hash would
 * otherwise write its wrong spans under a key another client reads.
 */
import { chunkHash } from '../lib/hash.ts';
import type { DetectChunkRequest, DetectChunkResponse, DetectRequest, DetectResponse, DetectSpan } from '../lib/protocol.ts';
import { precedenceOf } from '../lib/types.ts';
import { detectCacheKey, LruCache, type CacheStats } from './cache.ts';
import { GazetteerModelPass, type ModelPass } from './model.ts';
import { RULES_VERSION, rulePass } from './rules.ts';

/** A pass failed. The route turns this into a 5xx, never into an empty 200. */
export class DetectionUnavailable extends Error {}

export interface DetectEngineOptions {
  model?: ModelPass;
  cacheMaxEntries?: number;
}

export interface EngineStats extends CacheStats {
  /** Requests whose `hash` did not match the text they arrived with. */
  hashMismatches: number;
}

export class DetectEngine {
  readonly #model: ModelPass;
  readonly #cache: LruCache<DetectSpan[]>;
  #hashMismatches = 0;

  constructor(opts: DetectEngineOptions = {}) {
    this.#model = opts.model ?? new GazetteerModelPass();
    this.#cache = new LruCache<DetectSpan[]>(opts.cacheMaxEntries ?? 5_000);
  }

  /**
   * Composite on purpose: the client keys its cache on this string, so a change
   * to either pass has to be able to invalidate it. One version covering two
   * passes is how "we changed the regexes but not the model" stays expressible.
   */
  get modelVersion(): string {
    return `${RULES_VERSION}+${this.#model.version}`;
  }

  get stats(): EngineStats {
    return { ...this.#cache.stats, hashMismatches: this.#hashMismatches };
  }

  async detect(request: DetectRequest): Promise<DetectResponse> {
    const chunks: DetectChunkResponse[] = [];
    for (const chunk of request.chunks) {
      chunks.push({
        id: chunk.id,
        // Echoed verbatim: it is the client's binding and its cache key.
        hash: chunk.hash,
        spans: await this.#spansFor(chunk, request),
      });
    }
    return { modelVersion: this.modelVersion, policyVersion: request.policyVersion, chunks };
  }

  async #spansFor(chunk: DetectChunkRequest, request: DetectRequest): Promise<DetectSpan[]> {
    const canonical = chunkHash(chunk.text);
    if (canonical !== chunk.hash) this.#hashMismatches++;

    const key = detectCacheKey(canonical, this.modelVersion, request.policyVersion, request.locale);
    const hit = this.#cache.get(key);
    if (hit) return hit;

    const spans = canonicalise([
      ...rulePass(chunk.text, request.locale),
      ...(await this.#runModel(chunk.text, request.locale)),
    ]);
    this.#cache.set(key, spans);
    return spans;
  }

  async #runModel(text: string, locale: string): Promise<DetectSpan[]> {
    try {
      return await this.#model.detect(text, locale);
    } catch (err) {
      throw new DetectionUnavailable(
        `model pass ${this.#model.version} failed: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }
  }
}

/**
 * A total order plus exact-duplicate collapse. Overlaps are deliberately left
 * alone: the client merges by precedence with a union extent (SPEC §3.3), and
 * narrowing a span here would under-highlight, which is the direction that costs
 * the promise rather than a glance.
 */
export function canonicalise(spans: DetectSpan[]): DetectSpan[] {
  const byExtent = new Map<string, DetectSpan>();
  for (const span of spans) {
    const key = `${span.start}:${span.end}:${span.cls}`;
    const existing = byExtent.get(key);
    if (!existing || precedenceOf(span.origin) > precedenceOf(existing.origin)) byExtent.set(key, span);
  }
  return [...byExtent.values()].sort(
    (a, b) =>
      a.start - b.start ||
      a.end - b.end ||
      a.cls.localeCompare(b.cls) ||
      precedenceOf(b.origin) - precedenceOf(a.origin),
  );
}
