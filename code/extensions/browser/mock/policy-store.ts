/**
 * Mock trust-list distribution — the `GET /v1/policy` half of the backend
 * (ENDPOINTS.md §2).
 *
 * The lists live in `mock/policy.json` and are re-read on every request, so QA
 * can edit the file and watch the extension pick the change up on its next pull
 * without restarting anything.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const FILE = process.env.POLICY_FILE ?? new URL('./policy.json', import.meta.url).pathname;

export interface ServedPolicy {
  body: string;
  etag: string;
  maxAgeSeconds: number;
}

/**
 * A weak ETag would be wrong here: the client uses it to decide whether it may
 * keep serving the copy it already holds, so it has to mean byte equality.
 */
export function servePolicy(): ServedPolicy {
  const raw = JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, unknown>;
  const body = JSON.stringify(raw);
  const etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`;
  const maxAgeSeconds = typeof raw.maxAgeSeconds === 'number' ? raw.maxAgeSeconds : 300;
  return { body, etag, maxAgeSeconds };
}

export const POLICY_FILE = FILE;
