/**
 * The trust-list pull — `GET /v1/policy`, ENDPOINTS.md §2.
 *
 * The lists decide where a content script exists at all (SPEC §1), so this is a
 * security path, not a config path. Three properties it exists to hold:
 *
 *  - **Delegated, not authoritative.** The managed policy is the enrollment and
 *    still outranks whatever comes back; the pull only keeps the lists current
 *    between administrator pushes.
 *  - **Fails closed, on a clock.** A pull that fails serves the last good copy
 *    until it expires, then serves nothing. Losing the list means fewer hosts
 *    scanned and hosts falling back to `UNTRUSTED` — the safe direction in both
 *    cases, and it happens on a bounded schedule rather than never.
 *  - **Nothing is trusted as it arrives.** Every field goes through
 *    `sanitizeRemotePolicy` before it is merged.
 */
import { sanitizeRemotePolicy, type Policy } from '../lib/policy.ts';

/** Default life of a cached copy when the server states none. */
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
/** Ceiling on what a server may ask us to hold, however long it says. */
export const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface CachedPolicy {
  policy: Partial<Policy>;
  etag?: string;
  fetchedAt: number;
  /** After this the copy is not used at all, however the pull is going. */
  expiresAt: number;
}

/** Storage is injected so this is testable without a browser. */
export interface PolicyStore {
  read(): Promise<CachedPolicy | null>;
  write(value: CachedPolicy): Promise<void>;
  clear(): Promise<void>;
}

export type PolicyStatus =
  | 'disabled'
  | 'fresh'
  | 'not-modified'
  | 'cached'
  | 'expired'
  | 'unauthorized'
  | 'error';

export interface PolicyResult {
  /** The part of the pull to merge, or null when there is nothing usable. */
  policy: Partial<Policy> | null;
  status: PolicyStatus;
  /** Values the sanitiser refused, so a shortened list is never silent. */
  rejected: string[];
  expiresAt?: number;
}

export interface PolicyClientOptions {
  endpoint: string;
  token: string;
  /** The locally-configured detect endpoint; the pull may not leave its origin. */
  pin: string;
  store: PolicyStore;
  fetchImpl?: typeof fetch;
  now?: () => number;
  maxAttempts?: number;
}

export class PolicyClient {
  readonly #opts: Required<Omit<PolicyClientOptions, 'fetchImpl'>> & PolicyClientOptions;

  constructor(opts: PolicyClientOptions) {
    this.#opts = { now: () => Date.now(), maxAttempts: 2, ...opts };
  }

  /** What to boot with before the network has answered. */
  async cached(): Promise<PolicyResult> {
    if (!this.#opts.endpoint) return { policy: null, status: 'disabled', rejected: [] };
    const entry = await this.#opts.store.read().catch(() => null);
    if (!entry) return { policy: null, status: 'error', rejected: [] };
    if (this.#opts.now() >= entry.expiresAt) {
      await this.#opts.store.clear().catch(() => {});
      return { policy: null, status: 'expired', rejected: [] };
    }
    return { policy: entry.policy, status: 'cached', rejected: [], expiresAt: entry.expiresAt };
  }

  async refresh(): Promise<PolicyResult> {
    const { endpoint, token, pin, store, now } = this.#opts;
    if (!endpoint) return { policy: null, status: 'disabled', rejected: [] };

    const entry = await store.read().catch(() => null);
    const doFetch = this.#opts.fetchImpl ?? fetch;
    let unauthorized = false;

    for (let attempt = 1; attempt <= this.#opts.maxAttempts; attempt++) {
      try {
        const headers: Record<string, string> = {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
        };
        if (entry?.etag) headers['if-none-match'] = entry.etag;
        const res = await doFetch(endpoint, { method: 'GET', headers });

        if (res.status === 304 && entry) {
          // Unchanged, so the copy we hold is good for another life of the same
          // length — a bare 304 must not silently extend it to the default.
          const previous = entry.expiresAt - entry.fetchedAt;
          const renewed: CachedPolicy = {
            ...entry,
            fetchedAt: now(),
            expiresAt: now() + ttlFrom(res, undefined, previous > 0 ? previous : undefined),
          };
          await store.write(renewed).catch(() => {});
          return { policy: renewed.policy, status: 'not-modified', rejected: [], expiresAt: renewed.expiresAt };
        }
        if (res.status === 401 || res.status === 403) {
          // Wrong or revoked enrollment. Retrying will not fix it, and the held
          // copy stays valid until it expires on its own.
          unauthorized = true;
          break;
        }
        if (!res.ok) throw new Error(`policy ${res.status}`);

        const body = (await res.json()) as unknown;
        const { policy, rejected } = sanitizeRemotePolicy(body, pin);
        const fetchedAt = now();
        const fresh: CachedPolicy = {
          policy,
          etag: res.headers?.get?.('etag') ?? undefined,
          fetchedAt,
          expiresAt: fetchedAt + ttlFrom(res, body),
        };
        await store.write(fresh).catch(() => {});
        return { policy, status: 'fresh', rejected, expiresAt: fresh.expiresAt };
      } catch {
        if (attempt < this.#opts.maxAttempts) await delay(2 ** attempt * 200);
      }
    }

    // Nothing usable came back. Serve the held copy while it is still in date.
    if (entry && now() < entry.expiresAt) {
      return {
        policy: entry.policy,
        status: unauthorized ? 'unauthorized' : 'cached',
        rejected: [],
        expiresAt: entry.expiresAt,
      };
    }
    if (entry) await store.clear().catch(() => {});
    return { policy: null, status: unauthorized ? 'unauthorized' : entry ? 'expired' : 'error', rejected: [] };
  }
}

/** `Cache-Control: max-age` first, then the body's own `maxAgeSeconds`. */
function ttlFrom(res: { headers?: Headers }, body: unknown, fallbackMs = DEFAULT_TTL_MS): number {
  const header = res.headers?.get?.('cache-control') ?? '';
  const match = /max-age\s*=\s*(\d+)/i.exec(header);
  const stated =
    match !== null
      ? Number(match[1])
      : body && typeof body === 'object' && typeof (body as { maxAgeSeconds?: unknown }).maxAgeSeconds === 'number'
        ? (body as { maxAgeSeconds: number }).maxAgeSeconds
        : null;
  if (stated === null || !Number.isFinite(stated) || stated <= 0) return Math.min(fallbackMs, MAX_TTL_MS);
  return Math.min(stated * 1000, MAX_TTL_MS);
}

/** chrome.storage.local under one key, kept apart from the developer override. */
export const CACHE_KEY = 'policyCache';

export function chromeStore(): PolicyStore {
  return {
    async read() {
      const got = await chrome.storage.local.get(CACHE_KEY);
      return (got as Record<string, CachedPolicy | undefined>)[CACHE_KEY] ?? null;
    },
    async write(value) {
      await chrome.storage.local.set({ [CACHE_KEY]: value });
    },
    async clear() {
      await chrome.storage.local.remove(CACHE_KEY);
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
