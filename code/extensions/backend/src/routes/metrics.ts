/**
 * `GET /v1/metrics` — operational, and **not part of the client contract**.
 *
 * Nothing in the extension calls this; it exists because the three contract
 * endpoints answer "is it up" and "what did it say" but not "is the cache
 * earning its keep" or "is some client miscomputing its hashes". Authenticated,
 * because those counters describe the traffic of a service that sits inside the
 * vault's trust boundary — and it carries counts only, never text.
 */
import type { ServerResponse } from 'node:http';
import type { DetectEngine } from '../detect/engine.ts';
import { sendJson } from '../http.ts';
import type { PolicyStore } from '../policy/store.ts';

export interface Counters {
  requests: number;
  unauthorized: number;
  detectOk: number;
  detectRejected: number;
  detectFailed: number;
  policyServed: number;
  policyNotModified: number;
}

export function handleMetrics(res: ServerResponse, engine: DetectEngine, store: PolicyStore, counters: Counters, startedAt: number): void {
  const served = store.current();
  sendJson(res, 200, {
    modelVersion: engine.modelVersion,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    policy: {
      version: served?.policy.policyVersion ?? null,
      etag: served?.etag ?? null,
      native: served?.policy.native?.length ?? 0,
      trusted: served?.policy.trusted?.length ?? 0,
      rejected: served?.rejected ?? ['policy file unreadable'],
    },
    cache: engine.stats,
    counters,
  });
}
