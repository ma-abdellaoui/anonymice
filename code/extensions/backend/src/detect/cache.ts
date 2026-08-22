/**
 * Bounded LRU of detection results.
 *
 * The service worker caches too (SPEC §3.2), so why cache here? Because the
 * worker's cache is per-profile: ten people opening the same internal page pay
 * for ten model passes on identical text. The key is the same shape as the
 * client's, which keeps one invariant true on both sides — a `modelVersion` bump
 * misses every entry rather than serving spans the current passes would not
 * produce.
 *
 * `locale` is in the key here and not on the client because normalisation
 * depends on it (SPEC §5.1): the same digits are a different `normalized` under
 * `de-CH` than under `de-DE`, and serving one for the other would put two values
 * onto one vault entry.
 */
export interface CacheStats {
  size: number;
  hits: number;
  misses: number;
  evictions: number;
}

export class LruCache<V> {
  readonly #max: number;
  readonly #map = new Map<string, V>();
  #hits = 0;
  #misses = 0;
  #evictions = 0;

  constructor(max: number) {
    this.#max = Math.max(0, max);
  }

  get(key: string): V | undefined {
    const hit = this.#map.get(key);
    if (hit === undefined) {
      this.#misses++;
      return undefined;
    }
    // Re-insert to make it the most recent.
    this.#map.delete(key);
    this.#map.set(key, hit);
    this.#hits++;
    return hit;
  }

  set(key: string, value: V): void {
    if (this.#max === 0) return;
    if (this.#map.has(key)) this.#map.delete(key);
    this.#map.set(key, value);
    while (this.#map.size > this.#max) {
      const oldest = this.#map.keys().next().value;
      if (oldest === undefined) break;
      this.#map.delete(oldest);
      this.#evictions++;
    }
  }

  get stats(): CacheStats {
    return { size: this.#map.size, hits: this.#hits, misses: this.#misses, evictions: this.#evictions };
  }
}

/** `hash|modelVersion|policyVersion|locale` — see the note above on `locale`. */
export function detectCacheKey(hash: string, modelVersion: string, policyVersion: string, locale: string): string {
  return `${hash}|${modelVersion}|${policyVersion}|${locale}`;
}
