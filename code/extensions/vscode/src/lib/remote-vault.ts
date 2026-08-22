/**
 * A read-through client for the shared vault — ENDPOINTS.md §6.
 *
 * The local `Vault` owns what this editor minted. This owns nothing: it asks the
 * shared vault about tokens that arrived from somewhere else — most obviously a
 * value copied in the browser extension, whose token this editor has never seen
 * and cannot resolve on its own. Without it, that token reads as `foreign`,
 * which is the correct answer to the wrong question.
 *
 * Deliberately **not** a second vault. Nothing is adopted into the local value
 * index: a remote record stays remote, and this holds only what the remote said,
 * for as long as this window is open. Two vaults that both believe they own a
 * value is the failure this avoids — revoking it in one would leave the other
 * happily resolving it.
 *
 * Resolution is a write on the far side (retention rolls from the last one,
 * SPEC §6.7), so the cache here is a render cache: it exists so that decorating
 * a document does not issue one request per token per keystroke, not to spare
 * the vault the truth.
 */
import type { Cls } from './types.ts';
import type { Resolution } from './vault.ts';

export interface RemoteConfig {
  /** Empty disables every remote lookup — the editor is then local-only. */
  endpoint: string;
  token: string;
}

export interface RemoteReply {
  resolution: Resolution;
  /** Present when a `scopeId` was sent and the token resolved (SPEC §6.3). */
  alias?: string;
}

type Fetch = typeof fetch;

export class RemoteVault {
  #config: RemoteConfig;
  readonly #fetch: Fetch;
  /** token -> what the shared vault last said. */
  readonly #cache = new Map<string, Resolution>();
  /** Tokens with a lookup in flight or already answered, so a redraw is free. */
  readonly #asked = new Set<string>();

  constructor(config: RemoteConfig, fetchImpl: Fetch = fetch) {
    this.#config = config;
    this.#fetch = fetchImpl;
  }

  get enabled(): boolean {
    return this.#config.endpoint !== '';
  }

  configure(config: RemoteConfig): void {
    if (config.endpoint === this.#config.endpoint && config.token === this.#config.token) return;
    // Pointing at a different vault invalidates every answer the old one gave.
    this.#config = config;
    this.#cache.clear();
    this.#asked.clear();
  }

  /** What we already know, without going anywhere. Synchronous by design. */
  cached(token: string): Resolution | undefined {
    return this.#cache.get(token);
  }

  /**
   * Ask about a token we have not asked about before. Returns true when the
   * cache changed and the caller should redraw.
   *
   * One lookup per token per window: a token the shared vault does not know is
   * not going to start knowing it, and re-asking on every keystroke would turn a
   * document full of foreign tokens into a request storm.
   */
  async lookup(token: string, scopeId?: string): Promise<boolean> {
    if (!this.enabled || this.#asked.has(token)) return false;
    this.#asked.add(token);
    const reply = await this.#post(token, scopeId);
    if (!reply) {
      // A failed lookup is not an answer. Allow a retry rather than caching a
      // silence as though the vault had spoken.
      this.#asked.delete(token);
      return false;
    }
    this.#cache.set(token, reply.resolution);
    return true;
  }

  /**
   * Resolve and re-scope in one call, for the paste path where the answer is
   * needed now rather than at the next redraw (SPEC §6.3, stage two).
   */
  async resolveForPaste(token: string, scopeId: string): Promise<RemoteReply | null> {
    if (!this.enabled) return null;
    const reply = await this.#post(token, scopeId);
    if (!reply) return null;
    this.#cache.set(token, reply.resolution);
    this.#asked.add(token);
    // The alias is the token that will actually sit in the buffer, so it has to
    // resolve too — and it stands for the same value.
    if (reply.alias) {
      this.#cache.set(reply.alias, reply.resolution);
      this.#asked.add(reply.alias);
    }
    return reply;
  }

  async #post(token: string, scopeId?: string): Promise<RemoteReply | null> {
    try {
      const res = await this.#fetch(`${this.#config.endpoint}/resolve`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.#config.token}`,
        },
        body: JSON.stringify(scopeId ? { token, scopeId } : { token }),
      });
      if (!res.ok) throw new Error(`resolve ${res.status}`);
      const body = (await res.json()) as Record<string, unknown>;
      const resolution = readResolution(body);
      if (!resolution) throw new Error('resolve: malformed response');
      const reply: RemoteReply = { resolution };
      if (typeof body['alias'] === 'string') reply.alias = body['alias'];
      return reply;
    } catch (err) {
      console.error('anonymice: shared vault lookup failed', err);
      return null;
    }
  }
}

/**
 * Trust nothing about the shape. A malformed reply must read as "no answer",
 * never as a value — the one field here that reaches a decoration is `value`.
 */
function readResolution(body: Record<string, unknown>): Resolution | null {
  const kind = body['kind'];
  if (kind === 'value') {
    const value = body['value'];
    const cls = body['cls'];
    if (typeof value !== 'string' || typeof cls !== 'string') return null;
    return {
      kind: 'value',
      value,
      cls: cls as Cls,
      expiresAt: typeof body['expiresAt'] === 'number' ? body['expiresAt'] : 0,
      expiringSoon: body['expiringSoon'] === true,
    };
  }
  if (kind === 'tombstone') {
    const t = body['tombstone'];
    if (typeof t !== 'object' || t === null) return null;
    return { kind: 'tombstone', tombstone: t as Resolution extends { tombstone: infer T } ? T : never };
  }
  if (kind === 'foreign') return { kind: 'foreign', cls: String(body['cls'] ?? '') };
  if (kind === 'damaged') {
    return { kind: 'damaged', cls: typeof body['cls'] === 'string' ? body['cls'] : null };
  }
  if (kind === 'none') return { kind: 'none' };
  return null;
}
