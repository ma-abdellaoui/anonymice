/**
 * The vault client — ENDPOINTS.md §6, SPEC §6.3.
 *
 * Lives in the worker for the same reason `DetectClient` does: the credential is
 * here, and a page must not be able to influence a mint. The content script asks
 * for tokens by message and never learns the bearer.
 *
 * The endpoint is derived from `detectEndpoint`, not configured separately.
 * ENDPOINTS.md §6 puts every one of these on the same origin and inside the same
 * trust boundary, and deriving it means a policy pull that is already forbidden
 * from moving the detector (ENDPOINTS.md §2.4) cannot move the vault either.
 */
import type { Cls } from '../lib/types.ts';
import type { Policy } from '../lib/policy.ts';

export interface Tombstone {
  token: string;
  cls: string;
  mintedAt: number;
  endedAt: number;
  state: 'expired' | 'revoked';
  sourceScope: string;
}

/**
 * Mirrors the vault's own `Resolution` (see `mock/vault.ts`). A failure to
 * resolve is never a bare "unknown": every arm below says something the reveal
 * surface can render (SPEC §6.7).
 */
export type Resolution =
  | { kind: 'value'; value: string; cls: Cls; expiresAt: number; expiringSoon: boolean }
  | { kind: 'tombstone'; tombstone: Tombstone }
  | { kind: 'foreign'; cls: string }
  | { kind: 'damaged'; cls: string | null }
  | { kind: 'none' };

export interface ResolveReply {
  resolution: Resolution;
  /** The destination's own alias, when a `scopeId` was sent (SPEC §6.3). */
  alias?: string;
}

export interface MintSpec {
  cls: string;
  /** What the page displays. */
  value: string;
  /** Canonical form; the vault's value index is built from it (SPEC §5.1). */
  normalized: string;
  scopeId: string;
}

export interface VaultClientOptions {
  policy: Policy;
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
}

/** Same-origin by construction — see the note above. */
export function vaultEndpointFor(detectEndpoint: string): string {
  return new URL('/v1/tokens', detectEndpoint).href;
}

export class VaultClient {
  readonly #policy: Policy;
  readonly #fetch: typeof fetch | undefined;
  readonly #maxAttempts: number;

  constructor(opts: VaultClientOptions) {
    this.#policy = opts.policy;
    this.#fetch = opts.fetchImpl;
    this.#maxAttempts = opts.maxAttempts ?? 2;
  }

  /**
   * Tokens for these values, positionally. Null on any failure.
   *
   * Null must stay null all the way to the clipboard: a locally invented token
   * would be one the vault never recorded, so nothing could ever resolve it and
   * the value it stands for would be gone. An empty clipboard is recoverable;
   * that is not.
   */
  async mint(specs: MintSpec[]): Promise<string[] | null> {
    if (specs.length === 0) return [];
    const doFetch = this.#fetch ?? fetch;
    const endpoint = vaultEndpointFor(this.#policy.detectEndpoint);

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt++) {
      try {
        const res = await doFetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.#policy.detectToken}`,
          },
          body: JSON.stringify({ mints: specs }),
        });
        if (!res.ok) throw new Error(`mint ${res.status}`);
        const body = (await res.json()) as { tokens?: unknown };
        const tokens = body.tokens;
        if (!Array.isArray(tokens) || tokens.length !== specs.length) {
          throw new Error('mint: malformed response');
        }
        if (tokens.some((t) => typeof t !== 'string')) throw new Error('mint: malformed response');
        return tokens as string[];
      } catch (err) {
        if (attempt === this.#maxAttempts) {
          console.error('anonymice: mint failed — no token will be put on the clipboard', err);
          return null;
        }
        await new Promise((r) => setTimeout(r, 100 * attempt));
      }
    }
    return null;
  }

  /**
   * What a token stands for, and optionally this destination's own alias for it.
   *
   * Null is "we could not ask", which is not the same as any of the `Resolution`
   * arms — those are all answers. The reveal surface has to tell the difference:
   * an unreachable vault is a retry, a tombstone is not.
   */
  async resolve(token: string, scopeId?: string): Promise<ResolveReply | null> {
    const body = await this.#call('/resolve', 'POST', scopeId ? { token, scopeId } : { token });
    if (!body) return null;
    const resolution = body['kind'] === undefined ? null : (body as unknown as Resolution);
    if (!resolution) return null;
    const reply: ResolveReply = { resolution };
    if (typeof body['alias'] === 'string') reply.alias = body['alias'];
    return reply;
  }

  /** A token for the value an edit is producing (SPEC §8.4). */
  async mintChild(
    parentToken: string,
    value: string,
    normalized: string,
    scopeId: string,
  ): Promise<string | null> {
    const body = await this.#call('/child', 'POST', { parentToken, value, normalized, scopeId });
    return typeof body?.['token'] === 'string' ? body['token'] : null;
  }

  /** Move a draft as the user types. One token for the edit, not one per key. */
  async updateDraft(token: string, value: string, normalized: string): Promise<boolean> {
    const body = await this.#call(`/${encodeURIComponent(token)}`, 'PATCH', { value, normalized });
    return body?.['ok'] === true;
  }

  /** Blur or submit: the draft stops moving and joins the retention clock. */
  async commitDraft(token: string): Promise<boolean> {
    const body = await this.#call(`/${encodeURIComponent(token)}/commit`, 'POST', {});
    return body?.['ok'] === true;
  }

  async #call(
    path: string,
    method: 'POST' | 'PATCH',
    payload: unknown,
  ): Promise<Record<string, unknown> | null> {
    const doFetch = this.#fetch ?? fetch;
    const base = vaultEndpointFor(this.#policy.detectEndpoint);
    try {
      const res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.#policy.detectToken}`,
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`${method} ${path} ${res.status}`);
      return (await res.json()) as Record<string, unknown>;
    } catch (err) {
      console.error(`anonymice: vault ${method} ${path} failed`, err);
      return null;
    }
  }
}
