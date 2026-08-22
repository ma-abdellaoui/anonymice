/**
 * The trust-list source — the `GET /v1/policy` half of the service
 * (ENDPOINTS.md §2).
 *
 * Lists live in a JSON file so the deployment story is "edit a file, no
 * restart": the store re-reads it whenever its mtime or size changes, which
 * gives the live-edit behaviour QA relies on without a `stat`-plus-`read` on
 * every request of a fleet-wide one-minute refresh.
 *
 * Two behaviours are load-bearing rather than incidental:
 *
 *  - **The ETag means byte equality.** It is a strong ETag over the exact body
 *    served, because the client uses it to decide whether it may keep serving a
 *    copy it already holds (ENDPOINTS.md §2.2). A weak one would be wrong.
 *  - **A broken file does not empty the lists.** If the file goes missing or
 *    stops parsing while the service is up, the last good copy keeps being
 *    served and the failure is logged. Un-listing a host silently is the one
 *    outcome worth avoiding: it drops that host to `UNTRUSTED` and stops the
 *    extension protecting it. A file that is broken *at startup* is a different
 *    matter and refuses to boot.
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import type { Logger } from '../log.ts';
import { sanitizeServedPolicy, type ServedPolicy } from './sanitize.ts';

export const DEFAULT_MAX_AGE_SECONDS = 300;

export interface Served {
  body: string;
  etag: string;
  maxAgeSeconds: number;
  policy: ServedPolicy;
  rejected: string[];
}

export interface PolicyStoreOptions {
  file: string;
  logger: Logger;
}

export class PolicyStore {
  readonly #file: string;
  readonly #logger: Logger;
  #served: Served | null = null;
  #signature = '';

  constructor(opts: PolicyStoreOptions) {
    this.#file = opts.file;
    this.#logger = opts.logger;
  }

  get file(): string {
    return this.#file;
  }

  /** Called once at boot: a policy file that is absent or invalid is fatal here. */
  load(): Served {
    const served = this.#read();
    if (!served) throw new Error(`policy file ${this.#file} could not be read or did not parse`);
    return served;
  }

  /**
   * The copy to serve now. Re-reads only when the file has actually changed, so
   * a steady stream of `304`s costs one `stat` each.
   */
  current(): Served | null {
    const signature = this.#signatureOf();
    if (signature !== this.#signature || this.#served === null) {
      const fresh = this.#read(signature);
      if (fresh) return fresh;
      // Unreadable now, but we had a good copy: keep serving it (see the header).
    }
    return this.#served;
  }

  #signatureOf(): string {
    try {
      const stat = statSync(this.#file);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return 'missing';
    }
  }

  #read(signature = this.#signatureOf()): Served | null {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.#file, 'utf8'));
    } catch (err) {
      this.#logger.error('policy.read_failed', {
        file: this.#file,
        reason: err instanceof Error ? err.message : 'unknown',
        servingStale: this.#served !== null,
      });
      this.#signature = signature;
      return null;
    }

    const { policy, rejected } = sanitizeServedPolicy(raw);
    // The body is re-serialised from the sanitised object rather than passed
    // through: what the ETag covers and what the client receives are then the
    // same bytes by construction.
    const body = JSON.stringify(policy);
    const served: Served = {
      body,
      etag: `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`,
      maxAgeSeconds: policy.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS,
      policy,
      rejected,
    };

    for (const reason of rejected) this.#logger.warn('policy.rejected', { file: this.#file, reason });
    this.#logger.info('policy.loaded', {
      file: this.#file,
      policyVersion: policy.policyVersion ?? null,
      native: policy.native?.length ?? 0,
      trusted: policy.trusted?.length ?? 0,
      rejected: rejected.length,
      etag: served.etag,
    });

    this.#served = served;
    this.#signature = signature;
    return served;
  }
}
