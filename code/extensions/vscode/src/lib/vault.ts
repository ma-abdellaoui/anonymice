/**
 * The vault — browser SPEC §5.2, §6.3, §6.7.
 *
 * Two keyspaces that never meet:
 *   - the **value index**, `HMAC-SHA256(k, normalized)`, is how the vault finds
 *     an existing record for a value. `k` never leaves this module.
 *   - the **token**, 80 CSPRNG bits, is what the outside world holds. It is
 *     never derived from the plaintext (SPEC §6.3).
 *
 * One value record may hold several aliases — one per scope — so the same
 * subject pasted into two destinations does not correlate (SPEC §6.3).
 */
import { mintToken, parseToken } from './tokens.ts';
import type { Cls } from './types.ts';

export interface ValueRecord {
  id: string;
  cls: Cls;
  /** Plaintext. Never leaves the vault except through an explicit resolve. */
  value: string;
  normalized: string;
  mintedAt: number;
  lastResolvedAt: number;
  /** Set when the value was produced by editing another (browser SPEC §8.4). */
  parentId?: string;
  userModified?: boolean;
}

export interface Alias {
  token: string;
  scopeId: string;
  valueId: string;
  mintedAt: number;
  lastUsedAt: number;
}

export interface Tombstone {
  token: string;
  cls: string;
  mintedAt: number;
  endedAt: number;
  state: 'expired' | 'revoked';
  sourceScope: string;
}

export type Resolution =
  | { kind: 'value'; value: string; cls: Cls; expiresAt: number; expiringSoon: boolean }
  | { kind: 'tombstone'; tombstone: Tombstone }
  /** Well-formed, no record and no tombstone — another vault or another profile. */
  | { kind: 'foreign'; cls: string }
  | { kind: 'damaged'; cls: string | null }
  | { kind: 'none' };

export interface VaultPolicy {
  /** An alias is reused while idle < T_idle and age < T_max (SPEC §6.3). */
  idleMs: number;
  maxMs: number;
  /** A record lives this long from its last successful resolve (SPEC §6.7). */
  retainMs: number;
  /** Resolves within this of expiry reveal the value and state the date. */
  warnMs: number;
}

export const DEFAULT_POLICY: VaultPolicy = {
  idleMs: 12 * 60 * 60 * 1000,
  maxMs: 7 * 24 * 60 * 60 * 1000,
  retainMs: 90 * 24 * 60 * 60 * 1000,
  warnMs: 7 * 24 * 60 * 60 * 1000,
};

export interface VaultState {
  records: Record<string, ValueRecord>;
  /** value index → record id. The index is HMAC'd, so this map holds no plaintext key. */
  index: Record<string, string>;
  aliases: Record<string, Alias>;
  tombstones: Record<string, Tombstone>;
}

export function emptyState(): VaultState {
  return { records: {}, index: {}, aliases: {}, tombstones: {} };
}

const encoder = new TextEncoder();

async function hmacIndex(key: CryptoKey, normalized: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(normalized.normalize('NFKC')));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export interface MintRequest {
  cls: Cls;
  value: string;
  normalized: string;
  /** Destination identity — a git remote, a workspace path, a model provider (SPEC §1). */
  scopeId: string;
  parentId?: string;
  userModified?: boolean;
}

export class Vault {
  readonly #state: VaultState;
  readonly #key: CryptoKey;
  readonly #policy: VaultPolicy;
  readonly #now: () => number;

  private constructor(state: VaultState, key: CryptoKey, policy: VaultPolicy, now: () => number) {
    this.#state = state;
    this.#key = key;
    this.#policy = policy;
    this.#now = now;
  }

  /** `keyMaterial` is the vault key `k`; it is never emitted and never indexed. */
  static async open(
    keyMaterial: Uint8Array,
    state: VaultState = emptyState(),
    policy: VaultPolicy = DEFAULT_POLICY,
    now: () => number = Date.now,
  ): Promise<Vault> {
    const key = await crypto.subtle.importKey(
      'raw',
      keyMaterial as unknown as ArrayBuffer,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    return new Vault(state, key, policy, now);
  }

  static newKey(): Uint8Array {
    const k = new Uint8Array(32);
    crypto.getRandomValues(k);
    return k;
  }

  get state(): VaultState {
    return this.#state;
  }

  /**
   * Find or create the value record, then find or create its alias for this
   * scope. Same value + same scope ⇒ same token; same value + different scope ⇒
   * a different token (SPEC §6.3).
   */
  async mint(req: MintRequest): Promise<string> {
    const now = this.#now();
    const idx = await hmacIndex(this.#key, req.normalized);

    let recordId = this.#state.index[idx];
    if (recordId === undefined || this.#state.records[recordId] === undefined) {
      recordId = randomId();
      this.#state.index[idx] = recordId;
      this.#state.records[recordId] = {
        id: recordId,
        cls: req.cls,
        value: req.value,
        normalized: req.normalized,
        mintedAt: now,
        lastResolvedAt: now,
        parentId: req.parentId,
        userModified: req.userModified,
      };
    }

    const existing = this.#aliasFor(recordId, req.scopeId, now);
    if (existing) {
      existing.lastUsedAt = now;
      return existing.token;
    }

    const token = mintToken(req.cls);
    this.#state.aliases[token] = {
      token,
      scopeId: req.scopeId,
      valueId: recordId,
      mintedAt: now,
      lastUsedAt: now,
    };
    return token;
  }

  #aliasFor(valueId: string, scopeId: string, now: number): Alias | undefined {
    for (const a of Object.values(this.#state.aliases)) {
      if (a.valueId !== valueId || a.scopeId !== scopeId) continue;
      if (now - a.lastUsedAt >= this.#policy.idleMs) continue;
      if (now - a.mintedAt >= this.#policy.maxMs) continue;
      return a;
    }
    return undefined;
  }

  /**
   * Resolve a token to its plaintext, or to something legible about why not.
   * A bare failure is never an acceptable answer (SPEC §6.7).
   */
  resolve(candidate: string): Resolution {
    const parsed = parseToken(candidate);
    if (parsed.kind === 'none') return { kind: 'none' };
    if (parsed.kind === 'damaged') return { kind: 'damaged', cls: parsed.cls };

    const now = this.#now();
    const alias = this.#state.aliases[parsed.token];
    if (alias) {
      const rec = this.#state.records[alias.valueId];
      if (rec) {
        const expiresAt = rec.lastResolvedAt + this.#policy.retainMs;
        if (now <= expiresAt) {
          // Rolling retention: a token in active use cannot die mid-workflow.
          rec.lastResolvedAt = now;
          alias.lastUsedAt = now;
          return {
            kind: 'value',
            value: rec.value,
            cls: rec.cls,
            expiresAt: now + this.#policy.retainMs,
            expiringSoon: expiresAt - now <= this.#policy.warnMs,
          };
        }
        this.#expire(alias, rec, now);
      }
    }

    const tomb = this.#state.tombstones[parsed.token];
    if (tomb) return { kind: 'tombstone', tombstone: tomb };
    return { kind: 'foreign', cls: parsed.cls };
  }

  #expire(alias: Alias, rec: ValueRecord, now: number): void {
    this.#state.tombstones[alias.token] = {
      token: alias.token,
      cls: rec.cls,
      mintedAt: alias.mintedAt,
      endedAt: now,
      state: 'expired',
      sourceScope: alias.scopeId,
    };
    delete this.#state.aliases[alias.token];
    this.#destroyRecordIfOrphaned(rec);
  }

  /**
   * Revocation is immediate and independent of the retention clock, and it kills
   * every derivative: that inheritance is what makes the scheme defensible
   * (SPEC §8.4).
   */
  revoke(token: string): number {
    const now = this.#now();
    const alias = this.#state.aliases[token];
    if (!alias) return 0;
    const rootId = alias.valueId;
    const doomed = new Set<string>([rootId]);
    for (const r of Object.values(this.#state.records)) {
      if (r.parentId !== undefined && doomed.has(r.parentId)) doomed.add(r.id);
    }
    let killed = 0;
    for (const a of Object.values(this.#state.aliases)) {
      if (!doomed.has(a.valueId)) continue;
      const rec = this.#state.records[a.valueId];
      this.#state.tombstones[a.token] = {
        token: a.token,
        cls: rec ? rec.cls : 'UNKNOWN',
        mintedAt: a.mintedAt,
        endedAt: now,
        state: 'revoked',
        sourceScope: a.scopeId,
      };
      delete this.#state.aliases[a.token];
      killed++;
    }
    for (const id of doomed) {
      const rec = this.#state.records[id];
      if (rec) this.#destroyRecordIfOrphaned(rec);
    }
    return killed;
  }

  /** Destroy the plaintext *and* the value index; the tombstone holds neither. */
  #destroyRecordIfOrphaned(rec: ValueRecord): void {
    for (const a of Object.values(this.#state.aliases)) {
      if (a.valueId === rec.id) return;
    }
    delete this.#state.records[rec.id];
    for (const [idx, id] of Object.entries(this.#state.index)) {
      if (id === rec.id) delete this.#state.index[idx];
    }
  }
}
