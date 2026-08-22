/**
 * The isolated-world half of the egress gate — SPEC §10.5.
 *
 * The shim (`egress-main.ts`) can decide but cannot mint: it has no `chrome.*`
 * and no route to the vault. This side owns both, and keeps the shim's
 * synchronous cache warm so that the decision at `send` never needs to wait.
 *
 * That is the same shape as §7: the token is minted while the value is being
 * *found*, not while the request is being sent. Here the trigger is a scan
 * completing rather than a selection changing, and the fallback when a value was
 * never scanned is a block-then-mint-then-retry, which costs one round trip once
 * per value (§10.4).
 */
import { digestOf, CHANNEL, type EgressConfig, type FromShim, type Owed, type ToShim } from './egress-main.ts';
import type { Minter, Need } from './clipboard.ts';
import type { KnownValue } from '../lib/egress.ts';
import type { SpanRegistry } from '../lib/registry.ts';
import type { Cls } from '../lib/types.ts';

export interface BridgeOptions {
  registry: SpanRegistry;
  minter: Minter;
  mode: 'enforce' | 'report';
  /** `dom` turns on ingress in both the shim and the DOM pass (SPEC §10.9). */
  reveal?: 'off' | 'dom';
  /** Resolve tokens to values. Returns only what the vault answered for. */
  resolve?: (tokens: string[]) => Promise<Record<string, string>>;
  /** Called when new values land, so a DOM pass can be re-run (SPEC §10.9.4). */
  onValues?: (values: Record<string, string>) => void;
  country?: string;
  /** Badge, pill and audit all hang off this (SPEC §10.8). */
  onBlocked?: (event: { url: string; transport: string; missing: Owed[] }) => void;
  onSent?: (event: { url: string; transport: string; replaced: number }) => void;
  onHealth?: (patched: string[]) => void;
}

const needOf = (owed: Owed): Need => ({
  cls: owed.cls,
  value: owed.value,
  normalized: owed.normalized,
  // Egress always sees a complete value in the body, never a clipped selection,
  // so this is never the partial-copy child of §7.
  whole: true,
});

export function attachEgressBridge(win: Window, opts: BridgeOptions) {
  /**
   * Values the page's own DOM already contains. Sending these into the page's
   * realm exposes nothing the page cannot read for itself — which is the whole
   * argument for why the shim may hold them (§10.2).
   */
  function known(): KnownValue[] {
    return opts.registry
      .entries()
      .map((entry) => ({ cls: entry.cls, value: entry.value, normalized: entry.normalized }));
  }

  /** Digest-keyed, so the map names nothing the shim has not already found. */
  function tokens(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const entry of opts.registry.entries()) {
      const token = opts.minter.get({
        cls: entry.cls,
        value: entry.value,
        normalized: entry.normalized,
        whole: true,
      });
      if (token) out[digestOf(entry.normalized, entry.cls)] = token;
    }
    for (const [key, token] of extra) out[key] = token;
    return out;
  }

  /** Tokens for values that were never in the registry — the typed-in-place case. */
  const extra = new Map<string, string>();

  /** token → value, for ingress. Only tokens this page has actually received. */
  const values = new Map<string, string>();
  /** Asked about already, so a token the vault will not answer for is asked once. */
  const asked = new Set<string>();

  function push(): void {
    const config: EgressConfig = {
      mode: opts.mode,
      known: known(),
      tokens: tokens(),
      ...(opts.reveal ? { reveal: opts.reveal } : {}),
      ...(opts.reveal === 'dom' ? { values: Object.fromEntries(values) } : {}),
      ...(opts.country ? { country: opts.country } : {}),
    };
    const message: ToShim = { channel: CHANNEL, kind: 'config', config };
    win.postMessage(message, win.origin === 'null' ? '*' : win.origin);
  }

  /**
   * A blocked request is a request the vault owes us a token for. Mint, warm the
   * cache, and push — the app's own retry then goes out tokenised.
   *
   * We do not resend on the app's behalf. Replaying someone else's request means
   * guessing its headers, its ordering and its idempotency, and getting any of
   * that wrong is worse than the retry the app already knows how to do.
   */
  async function settle(missing: Owed[]): Promise<void> {
    const needs = missing.map(needOf);
    const ok = await opts.minter.ensure(needs);
    if (!ok) return; // Vault unreachable: stay blocked. That is the safe arm.
    for (const need of needs) {
      const token = opts.minter.get(need);
      if (token) extra.set(digestOf(need.normalized, need.cls as Cls), token);
    }
    push();
  }

  /**
   * Ingress cache. The shim and the DOM pass both read synchronously, so this is
   * what makes that possible: resolve once, hold, push down (SPEC §10.9.3).
   *
   * A token the vault will not answer for is asked about exactly once. Retrying
   * on every frame of a collab stream would be a request storm on the one case
   * that is already known to fail — a dead token (§6.7).
   */
  async function warm(tokens: string[]): Promise<void> {
    if (opts.reveal !== 'dom' || !opts.resolve) return;
    const fresh = tokens.filter((t) => !values.has(t) && !asked.has(t));
    if (fresh.length === 0) return;
    for (const token of fresh) asked.add(token);

    const resolved = await opts.resolve(fresh);
    let learned = false;
    for (const [token, value] of Object.entries(resolved)) {
      if (!value) continue;
      values.set(token, value);
      learned = true;
    }
    if (!learned) return;
    push();
    opts.onValues?.(Object.fromEntries(values));
  }

  /** Same frame filter as the shim's, and the same caveat (SPEC §10.2). */
  const onMessage = (event: MessageEvent): void => {
    const data = event.data as FromShim | null;
    if (event.source && event.source !== win) return;
    if (data?.channel !== CHANNEL) return;
    switch (data.kind) {
      case 'health':
        opts.onHealth?.(data.patched);
        // The shim is up; hand it a config before the app's first request.
        push();
        break;
      case 'blocked':
        opts.onBlocked?.({ url: data.url, transport: data.transport, missing: data.missing });
        void settle(data.missing);
        break;
      case 'sent':
        opts.onSent?.({ url: data.url, transport: data.transport, replaced: data.replaced });
        break;
      case 'unresolved':
        void warm(data.tokens);
        break;
    }
  };

  win.addEventListener('message', onMessage);

  return {
    /** Call when the registry changes — a scan completing, a mutation settling. */
    refresh: push,
    /** Resolve these tokens and push the values down (SPEC §10.9.4). */
    warm,
    detach(): void {
      win.removeEventListener('message', onMessage);
    },
  };
}
