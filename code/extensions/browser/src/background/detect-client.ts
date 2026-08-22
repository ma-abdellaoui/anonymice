/**
 * The one place that talks to the detection backend — SPEC §3.1.
 *
 * The content script never fetches: this holds the credential, owns the cache and
 * coalesces every tab into one connection. Cache, batching and failure semantics
 * are here so a page cannot influence any of them.
 */
import { cacheKey, LIMITS, type DetectChunkRequest, type DetectChunkResponse, type DetectRequest, type DetectResponse } from '../lib/protocol.ts';
import type { Policy } from '../lib/policy.ts';

export interface DetectClientOptions {
  policy: Policy;
  fetchImpl?: typeof fetch;
  /** Bounded LRU, so a long session cannot grow without limit (SPEC §3.2). */
  cacheSize?: number;
  maxAttempts?: number;
  /** Consecutive failures before the circuit opens. */
  breakerThreshold?: number;
  breakerCooldownMs?: number;
  now?: () => number;
}

export class DetectClient {
  readonly #opts: Required<Omit<DetectClientOptions, 'policy' | 'fetchImpl'>> & DetectClientOptions;
  readonly #cache = new Map<string, DetectChunkResponse['spans']>();
  #failures = 0;
  #openedAt = 0;
  /**
   * Learned from the first response. Entries are stored under the version that
   * produced them, so when the backend bumps, every lookup misses and the old
   * spans are never served again (SPEC §3.2).
   */
  #modelVersion = 'unknown';

  constructor(opts: DetectClientOptions) {
    this.#opts = {
      cacheSize: 500,
      maxAttempts: 3,
      breakerThreshold: 4,
      breakerCooldownMs: 30_000,
      now: () => Date.now(),
      ...opts,
    };
  }

  get circuitOpen(): boolean {
    if (this.#failures < this.#opts.breakerThreshold) return false;
    const elapsed = this.#opts.now() - this.#openedAt;
    if (elapsed > this.#opts.breakerCooldownMs) {
      this.#failures = 0;
      return false;
    }
    return true;
  }

  get cacheSize(): number {
    return this.#cache.size;
  }

  /**
   * Null means "not scanned" — the caller must say so rather than paint nothing
   * and let silence read as "nothing sensitive here" (SPEC §3.2).
   */
  async detect(
    chunks: DetectChunkRequest[],
    hostClass: DetectRequest['hostClass'] = 'native',
  ): Promise<DetectResponse | null> {
    const policy = this.#opts.policy;
    const modelVersion = this.#modelVersion;
    const cached: DetectChunkResponse[] = [];
    const misses: DetectChunkRequest[] = [];

    for (const chunk of chunks) {
      const hit = this.#cache.get(cacheKey(chunk.hash, modelVersion, policy.policyVersion));
      if (hit) cached.push({ id: chunk.id, hash: chunk.hash, spans: hit });
      else misses.push(chunk);
    }
    if (misses.length === 0) {
      return { modelVersion, policyVersion: policy.policyVersion, chunks: cached };
    }
    if (this.circuitOpen) return null;

    const batches = splitBatches(misses);
    const fresh: DetectChunkResponse[] = [];
    let modelSeen = modelVersion;

    for (const batch of batches) {
      const response = await this.#post(batch, hostClass);
      if (!response) return null;
      modelSeen = response.modelVersion;
      this.#modelVersion = response.modelVersion;
      for (const chunk of response.chunks) {
        this.#remember(cacheKey(chunk.hash, response.modelVersion, policy.policyVersion), chunk.spans);
        fresh.push(chunk);
      }
    }
    return { modelVersion: modelSeen, policyVersion: policy.policyVersion, chunks: [...cached, ...fresh] };
  }

  async #post(
    chunks: DetectChunkRequest[],
    hostClass: DetectRequest['hostClass'],
  ): Promise<DetectResponse | null> {
    const policy = this.#opts.policy;
    const doFetch = this.#opts.fetchImpl ?? fetch;
    for (let attempt = 1; attempt <= this.#opts.maxAttempts; attempt++) {
      try {
        const res = await doFetch(policy.detectEndpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${policy.detectToken}`,
          },
          body: JSON.stringify({
            policyVersion: policy.policyVersion,
            locale: policy.locale,
            hostClass,
            chunks,
          }),
        });
        if (res.status === 413) {
          // The server is telling us to re-split (SPEC §3.2).
          if (chunks.length === 1) return null;
          const mid = Math.ceil(chunks.length / 2);
          const left = await this.#post(chunks.slice(0, mid), hostClass);
          const right = await this.#post(chunks.slice(mid), hostClass);
          if (!left || !right) return null;
          return { ...left, chunks: [...left.chunks, ...right.chunks] };
        }
        if (!res.ok) throw new Error(`detect ${res.status}`);
        this.#failures = 0;
        return (await res.json()) as DetectResponse;
      } catch {
        if (attempt === this.#opts.maxAttempts) break;
        await delay(2 ** attempt * 100);
      }
    }
    this.#failures++;
    if (this.#failures >= this.#opts.breakerThreshold) this.#openedAt = this.#opts.now();
    return null;
  }

  #remember(key: string, spans: DetectChunkResponse['spans']): void {
    if (this.#cache.has(key)) this.#cache.delete(key);
    this.#cache.set(key, spans);
    while (this.#cache.size > this.#opts.cacheSize) {
      const oldest = this.#cache.keys().next().value;
      if (oldest === undefined) break;
      this.#cache.delete(oldest);
    }
  }
}

/** Respect the caps before the server has to (SPEC §3.2). */
function splitBatches(chunks: DetectChunkRequest[]): DetectChunkRequest[][] {
  const batches: DetectChunkRequest[][] = [];
  let batch: DetectChunkRequest[] = [];
  let chars = 0;
  for (const chunk of chunks) {
    const size = chunk.text.length;
    if (batch.length >= LIMITS.maxChunks || chars + size > LIMITS.maxTotalChars) {
      if (batch.length) batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(chunk);
    chars += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
