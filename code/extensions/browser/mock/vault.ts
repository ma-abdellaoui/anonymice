/**
 * The vault — SPEC §5.2, §6.3, §6.7.
 *
 * VENDORED from `vscode/src/lib/vault.ts`, which is where it was written and
 * where it still runs for VS Code's own mints. `diff` the two; they must match
 * apart from the two import paths and this note — `vscode/dev/vault-parity.mjs`
 * checks it. Extracting a shared package would put a build step between the
 * mock and `node mock/detect-server.ts`, which is the one thing the mock exists
 * to avoid.
 *
 * Mock-grade in one respect only, and it is the process boundary rather than
 * the code: this state lives in memory and dies with the server. The retention
 * clocks, tombstones and revocation below are all real, and all pointless
 * across a restart.
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
import { mintToken, parseToken } from '../src/lib/tokens.ts';
import type { Cls } from '../src/lib/types.ts';

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
  /**
   * A child is born `draft` and is promoted on blur or submit (SPEC §8.4).
   * Absent means committed — every record minted before drafts existed, and
   * every record that was never an edit in progress.
   */
  state?: 'draft' | 'committed';
  /** Draft clock, reset on each keystroke. Only meaningful while `draft`. */
  draftUntil?: number;
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
  /**
   * How long an untouched draft survives (SPEC §8.4). Short, because a draft is
   * an edit in progress and an abandoned one should not outlive the sitting.
   */
  draftMs: number;
}

export const DEFAULT_POLICY: VaultPolicy = {
  idleMs: 12 * 60 * 60 * 1000,
  maxMs: 7 * 24 * 60 * 60 * 1000,
  retainMs: 90 * 24 * 60 * 60 * 1000,
  warnMs: 7 * 24 * 60 * 60 * 1000,
  draftMs: 15 * 60 * 1000,
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

  /**
   * A second alias for an existing token's value, under another scope — stage
   * two of SPEC §6.3, reached once the destination is finally known.
   *
   * By record id, deliberately. Re-minting through `mint()` would need the
   * caller to hand back the `normalized` form, which a resolve does not return;
   * passing the plaintext in its place indexes to a different digest and forks
   * the record in two — same value, twice, no lineage, and revoking one leaves
   * the other alive.
   *
   * Null when the token is not live here: a dead or foreign token has no value
   * to re-scope, and inventing a record for it is the one thing §6.7 forbids.
   */
  rescope(token: string, scopeId: string): string | null {
    const alias = this.#state.aliases[token];
    if (!alias) return null;
    const rec = this.#state.records[alias.valueId];
    if (!rec) return null;

    const now = this.#now();
    const existing = this.#aliasFor(rec.id, scopeId, now);
    if (existing) {
      existing.lastUsedAt = now;
      return existing.token;
    }
    const minted = mintToken(rec.cls);
    this.#state.aliases[minted] = {
      token: minted,
      scopeId,
      valueId: rec.id,
      mintedAt: now,
      lastUsedAt: now,
    };
    return minted;
  }

  /**
   * A child of an existing token — SPEC §8.4. The edit path: the user changes a
   * revealed value, and the field must hold *a* token throughout, so one is
   * minted for the value being typed rather than the field reverting to
   * plaintext while it is unclassifiable.
   *
   * **Depth 1, always.** A child edited again reparents to the root rather than
   * extending the chain: lineage stays readable and revocation stays a single
   * pass rather than a graph traversal.
   *
   * **Not indexed while it is a draft.** The value is about to change on the
   * next keystroke, and an index entry for a value that no longer exists is
   * worse than none. `commit` indexes it once it has stopped moving.
   */
  mintChild(parentToken: string, value: string, normalized: string, scopeId: string): string | null {
    const parentAlias = this.#state.aliases[parentToken];
    if (!parentAlias) return null;
    const parent = this.#state.records[parentAlias.valueId];
    if (!parent) return null;

    const now = this.#now();
    const id = randomId();
    this.#state.records[id] = {
      id,
      cls: parent.cls,
      value,
      normalized,
      mintedAt: now,
      lastResolvedAt: now,
      // The root, not the parent — a child of a child is still a child of the root.
      parentId: parent.parentId ?? parent.id,
      userModified: true,
      state: 'draft',
      draftUntil: now + this.#policy.draftMs,
    };
    const token = mintToken(parent.cls);
    this.#state.aliases[token] = { token, scopeId, valueId: id, mintedAt: now, lastUsedAt: now };
    return token;
  }

  /**
   * Move a draft's value as the user types. One token for the whole edit, not
   * one per keystroke: per-keystroke tokens would explode the vault and leak the
   * edit cadence through the churn (SPEC §8.4).
   */
  updateDraft(token: string, value: string, normalized: string): boolean {
    const rec = this.#draftFor(token);
    if (!rec) return false;
    const now = this.#now();
    rec.value = value;
    rec.normalized = normalized;
    rec.lastResolvedAt = now;
    rec.draftUntil = now + this.#policy.draftMs;
    return true;
  }

  /**
   * Blur or submit. The record stops moving, joins the value index, and picks up
   * the ordinary retention clock (SPEC §8.4).
   */
  async commitDraft(token: string): Promise<boolean> {
    const rec = this.#draftFor(token);
    if (!rec) return false;
    const now = this.#now();
    rec.state = 'committed';
    delete rec.draftUntil;
    rec.lastResolvedAt = now;
    // Indexed only now. If the typed value happens to match a record that
    // already exists, both stay: merging them would silently move this token's
    // lineage onto a record it was never derived from.
    const idx = await hmacIndex(this.#key, rec.normalized);
    this.#state.index[idx] ??= rec.id;
    return true;
  }

  /**
   * Collect drafts whose clock ran out — SPEC §8.4. Leaves a tombstone rather
   * than nothing: a draft token can escape before it is ever committed, because
   * an autosaving page may submit the field mid-edit.
   */
  sweepDrafts(): number {
    const now = this.#now();
    let collected = 0;
    for (const rec of Object.values(this.#state.records)) {
      if (rec.state !== 'draft' || rec.draftUntil === undefined || rec.draftUntil > now) continue;
      for (const alias of Object.values(this.#state.aliases)) {
        if (alias.valueId !== rec.id) continue;
        this.#expire(alias, rec, now);
        collected++;
      }
    }
    return collected;
  }

  #draftFor(token: string): ValueRecord | undefined {
    const alias = this.#state.aliases[token];
    if (!alias) return undefined;
    const rec = this.#state.records[alias.valueId];
    return rec?.state === 'draft' ? rec : undefined;
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
