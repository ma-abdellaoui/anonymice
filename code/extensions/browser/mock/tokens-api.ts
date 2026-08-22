/**
 * The vault endpoints of ENDPOINTS.md §6, for local work and QA.
 *
 *   POST   /v1/tokens               mint (batched — one selection can hold several values)
 *   POST   /v1/tokens/resolve       resolve, and optionally re-scope to a destination
 *   POST   /v1/tokens/child         mint a child for an edit in progress (§8.4)
 *   PATCH  /v1/tokens/{token}       move a draft's value as the user types (§8.4)
 *   POST   /v1/tokens/{token}/commit  promote a draft on blur or submit (§8.4)
 *   DELETE /v1/tokens/{token}       revoke, immediately and with its children
 *
 * These exist so the browser extension and the VS Code extension resolve
 * against **one** vault. Without that they mint into two, and a token copied in
 * Chrome reads as `foreign` in the editor — which is the correct answer to the
 * wrong question.
 *
 * A resolve is a **write**: retention rolls from the last successful one
 * (SPEC §6.7), so a client may not cache the answer and skip the call.
 *
 * Handlers are pure `(body) -> Reply` so the contract can be tested without a
 * socket; `detect-server.ts` is the only thing that knows about HTTP.
 */
import { CLASSES, type Cls } from '../src/lib/types.ts';
import { Vault, type Resolution } from './vault.ts';

export interface Reply {
  status: number;
  body: unknown;
}

/** A dead token is a legible answer, not an error — hence the extra field. */
export type ResolveReply = Resolution & { alias?: string };

interface MintSpec {
  cls: Cls;
  value: string;
  normalized: string;
  scopeId: string;
  parentId?: string;
  userModified?: boolean;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function readMint(raw: unknown): MintSpec | string {
  if (typeof raw !== 'object' || raw === null) return 'not an object';
  const o = raw as Record<string, unknown>;
  const cls = str(o['cls']);
  const value = str(o['value']);
  const scopeId = str(o['scopeId']);
  // `normalized` decides identity (SPEC §5.1) and the caller computes it, so a
  // missing one is a client bug worth naming rather than silently defaulting.
  const normalized = str(o['normalized']);
  if (!cls || !(CLASSES as readonly string[]).includes(cls)) return `cls: ${String(o['cls'])}`;
  if (!value) return 'value: missing';
  if (!normalized) return 'normalized: missing';
  if (!scopeId) return 'scopeId: missing';
  const spec: MintSpec = { cls: cls as Cls, value, normalized, scopeId };
  if (typeof o['parentId'] === 'string') spec.parentId = o['parentId'];
  if (o['userModified'] === true) spec.userModified = true;
  return spec;
}

export interface TokenApi {
  /** `{ parentToken, value, normalized, scopeId }` -> `{ token }` (SPEC §8.4). */
  child(body: unknown): Reply;
  /** `{ value, normalized }` against a draft token. */
  update(token: string, body: unknown): Reply;
  commit(token: string): Promise<Reply>;
  /** `{ mints: [...] }` -> `{ tokens: [...] }`, positionally. */
  mint(body: unknown): Promise<Reply>;
  /** `{ token, scopeId? }` -> a Resolution, always 200. */
  resolve(body: unknown): Promise<Reply>;
  revoke(token: string): Reply;
  /** Counters for the QA page; holds no plaintext. */
  stats(): { records: number; aliases: number; tombstones: number };
}

export function createTokenApi(vault: Vault): TokenApi {
  /**
   * SPEC §8.4 wants a sweep on vault open and on an hourly alarm. The mock has
   * neither a lifecycle nor alarms, so it sweeps on touch: cheap at this size,
   * and it keeps the collected-draft path exercised rather than theoretical.
   */
  const sweep = (): void => {
    const collected = vault.sweepDrafts();
    if (collected) console.log(`[tokens] collected ${collected} abandoned draft(s)`);
  };

  return {
    async mint(body) {
      sweep();
      const o = body as { mints?: unknown };
      if (!Array.isArray(o?.mints)) return { status: 400, body: { error: 'expected { mints: [...] }' } };
      if (o.mints.length === 0 || o.mints.length > 64) {
        return { status: 400, body: { error: 'mints: expected 1..64' } };
      }
      const specs: MintSpec[] = [];
      for (const [i, raw] of o.mints.entries()) {
        const spec = readMint(raw);
        if (typeof spec === 'string') return { status: 400, body: { error: `mints[${i}] ${spec}` } };
        specs.push(spec);
      }
      const tokens: string[] = [];
      for (const spec of specs) tokens.push(await vault.mint(spec));
      console.log(`[tokens] minted ${tokens.length} for ${specs[0]!.scopeId}`);
      return { status: 200, body: { tokens } };
    },

    async resolve(body) {
      sweep();
      const o = (body ?? {}) as Record<string, unknown>;
      const token = str(o['token']);
      if (!token) return { status: 400, body: { error: 'token: missing' } };

      const resolution = vault.resolve(token);
      const reply: ResolveReply = { ...resolution };

      // Stage two of §6.3: the clipboard token was scoped to wherever it was
      // copied from, so a destination that has a handler swaps in its own alias
      // and the source token never lands in the artifact.
      const scopeId = str(o['scopeId']);
      if (resolution.kind === 'value' && scopeId) {
        const alias = vault.rescope(token, scopeId);
        if (alias) reply.alias = alias;
      }
      console.log(`[tokens] resolve ${token} -> ${resolution.kind}`);
      return { status: 200, body: reply };
    },

    child(body) {
      sweep();
      const o = (body ?? {}) as Record<string, unknown>;
      const parentToken = str(o['parentToken']);
      const value = o['value'];
      const normalized = str(o['normalized']);
      const scopeId = str(o['scopeId']);
      if (!parentToken) return { status: 400, body: { error: 'parentToken: missing' } };
      if (typeof value !== 'string') return { status: 400, body: { error: 'value: missing' } };
      if (!normalized) return { status: 400, body: { error: 'normalized: missing' } };
      if (!scopeId) return { status: 400, body: { error: 'scopeId: missing' } };

      const token = vault.mintChild(parentToken, value, normalized, scopeId);
      // A child of a token this vault does not hold would be a record with an
      // invented ancestor. Refuse rather than orphan it (SPEC §8.4).
      if (!token) return { status: 404, body: { error: 'parent not held here' } };
      console.log(`[tokens] child of ${parentToken} -> ${token}`);
      return { status: 200, body: { token } };
    },

    update(token, body) {
      const o = (body ?? {}) as Record<string, unknown>;
      const value = o['value'];
      const normalized = str(o['normalized']);
      if (typeof value !== 'string') return { status: 400, body: { error: 'value: missing' } };
      if (!normalized) return { status: 400, body: { error: 'normalized: missing' } };
      const ok = vault.updateDraft(token, value, normalized);
      return ok ? { status: 200, body: { ok } } : { status: 404, body: { error: 'not a draft' } };
    },

    async commit(token) {
      const ok = await vault.commitDraft(token);
      if (ok) console.log(`[tokens] commit ${token}`);
      return ok ? { status: 200, body: { ok } } : { status: 404, body: { error: 'not a draft' } };
    },

    revoke(token) {
      const killed = vault.revoke(token);
      console.log(`[tokens] revoke ${token} -> ${killed} alias(es)`);
      return { status: 200, body: { revoked: killed } };
    },

    stats() {
      const s = vault.state;
      return {
        records: Object.keys(s.records).length,
        aliases: Object.keys(s.aliases).length,
        tombstones: Object.keys(s.tombstones).length,
      };
    },
  };
}

export async function openMockVault(): Promise<Vault> {
  return Vault.open(Vault.newKey());
}
