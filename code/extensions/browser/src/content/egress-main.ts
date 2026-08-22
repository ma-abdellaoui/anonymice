/**
 * The egress shim — SPEC §10.2, §10.3.
 *
 * Runs in the page's own JS realm (`world: "MAIN"`), because that is the only
 * place `fetch`, `XMLHttpRequest`, `WebSocket` and `sendBeacon` can be wrapped
 * before the application captures its own references to them. An isolated world
 * patches its own copies, which the page never calls.
 *
 * **What being in the page's realm costs, and why it is affordable here.** The
 * page can read this code, re-patch over it, or hand us a forged config. None of
 * those reach anything the page does not already hold:
 *
 *   - the token map is keyed by *digest*, so it names no value the shim has not
 *     already found in a body the page itself was sending;
 *   - `known` carries values the page's own DOM already contains (§10.2);
 *   - a forged config, or a re-patch, disables the gate — which is loud
 *     (`egress:health` stops arriving) and fails in the direction §10.4 requires.
 *
 * The vault is never reachable from here. No plaintext this shim did not already
 * see in the page's own outbound body ever crosses into it.
 */
import { inspect, type EgressMatch, type KnownValue, type Verdict } from '../lib/egress.ts';
import { sha256Bytes } from '../lib/sha256.ts';
import type { Cls } from '../lib/types.ts';

/** Both sides of the bridge agree on this; the page may see it and may forge it. */
export const CHANNEL = 'anonymice:egress';

export interface EgressConfig {
  /** `enforce` blocks; `report` forwards and reports. Managed policy (§10.6). */
  mode: 'enforce' | 'report';
  known: KnownValue[];
  /** `sha256(normalized + '|' + cls)` → token. Never a plaintext key. */
  tokens: Record<string, string>;
  country?: string;
}

export type ToShim = { channel: typeof CHANNEL; kind: 'config'; config: EgressConfig };

export type FromShim =
  | { channel: typeof CHANNEL; kind: 'blocked'; url: string; transport: Transport; missing: Owed[] }
  | { channel: typeof CHANNEL; kind: 'sent'; url: string; transport: Transport; replaced: number }
  | { channel: typeof CHANNEL; kind: 'health'; patched: Transport[] };

export type Transport = 'fetch' | 'xhr' | 'websocket' | 'beacon';

/** What the vault still owes us for a blocked body (§10.4). */
export interface Owed {
  cls: Cls;
  value: string;
  normalized: string;
}

const encoder = new TextEncoder();

/** Synchronous by necessity — `WebSocket.send` cannot await (§10.3). */
export function digestOf(normalized: string, cls: Cls): string {
  return sha256Bytes(encoder.encode(`${normalized}|${cls}`));
}

const owed = (matches: EgressMatch[]): Owed[] =>
  matches.map((m) => ({ cls: m.cls, value: m.value, normalized: m.normalized }));

/** Only bodies we can read as text are bodies we can gate (§10.7). */
function asText(body: unknown): string | null {
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  return null;
}

export interface ShimHandle {
  patched: Transport[];
  restore(): void;
}

export function installEgressShim(win: Window & typeof globalThis): ShimHandle {
  const patched: Transport[] = [];
  const undo: Array<() => void> = [];

  // Scoped to the window we were installed on rather than a module global: the
  // shim is one-per-realm in production, but a seam that only works against the
  // ambient `window` is a seam that cannot be tested.
  let config: EgressConfig = { mode: 'enforce', known: [], tokens: {} };

  const tokenFor = (normalized: string, cls: Cls): string | undefined =>
    config.tokens[digestOf(normalized, cls)];

  const report = (message: FromShim): void => {
    win.postMessage(message, win.origin === 'null' ? '*' : win.origin);
  };

  /**
   * One decision, made the same way for every transport.
   *
   * Returns the body to send, or `null` to drop the send entirely. `report` mode
   * still substitutes where it can — a tokenised body is strictly better than
   * the original even when we are not willing to block on a miss.
   */
  const decide = (body: string, url: string, transport: Transport): string | null => {
    let verdict: Verdict;
    try {
      verdict = inspect(body, config.known, tokenFor, { country: config.country });
    } catch {
      // A gate that throws is a gate that is not gating. In `enforce` that means
      // the send does not happen (§10.4); in `report` it means we got out of the way.
      return config.mode === 'enforce' ? null : body;
    }

    if (verdict.kind === 'clean') return body;

    if (verdict.kind === 'substituted') {
      report({ channel: CHANNEL, kind: 'sent', url, transport, replaced: verdict.replaced.length });
      return verdict.body;
    }

    report({ channel: CHANNEL, kind: 'blocked', url, transport, missing: owed(verdict.missing) });
    if (config.mode === 'report') return body;
    return null;
  };

  // --- fetch -------------------------------------------------------------
  // The one transport that could await a round trip. It deliberately does not:
  // one decision path is worth more than one transport's extra capability, and
  // a gate that behaves differently per transport is a gate nobody can reason
  // about (§10.3).
  const originalFetch = win.fetch;
  if (typeof originalFetch === 'function') {
    win.fetch = function patchedFetch(this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const text = asText(init?.body);
      if (text !== null) {
        const decided = decide(text, url, 'fetch');
        if (decided === null) {
          return Promise.reject(new DOMException('Blocked by anonymice (SPEC §10.4)', 'AbortError'));
        }
        if (decided !== text) return originalFetch.call(this, input, { ...init, body: decided });
      }
      return originalFetch.call(this, input, init);
    } as typeof win.fetch;
    patched.push('fetch');
    undo.push(() => {
      win.fetch = originalFetch;
    });
  }

  // --- XMLHttpRequest ----------------------------------------------------
  const xhrProto = win.XMLHttpRequest?.prototype;
  const originalOpen = xhrProto?.open;
  const originalXhrSend = xhrProto?.send;
  if (xhrProto && originalOpen && originalXhrSend) {
    const urls = new WeakMap<XMLHttpRequest, string>();
    xhrProto.open = function patchedOpen(this: XMLHttpRequest, method: string, url: string | URL) {
      urls.set(this, String(url));
      // eslint-disable-next-line prefer-rest-params
      return originalOpen.apply(this, arguments as never);
    } as typeof xhrProto.open;
    xhrProto.send = function patchedSend(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      const text = asText(body);
      if (text !== null) {
        const decided = decide(text, urls.get(this) ?? '', 'xhr');
        if (decided === null) return;
        return originalXhrSend.call(this, decided);
      }
      return originalXhrSend.call(this, body as XMLHttpRequestBodyInit);
    };
    patched.push('xhr');
    undo.push(() => {
      xhrProto.open = originalOpen;
      xhrProto.send = originalXhrSend;
    });
  }

  // --- WebSocket ---------------------------------------------------------
  // The transport that matters on a collaborative destination, and the one that
  // proves the gate has to be synchronous: `send` returns void.
  const wsProto = win.WebSocket?.prototype;
  const originalWsSend = wsProto?.send;
  if (wsProto && originalWsSend) {
    wsProto.send = function patchedWsSend(this: WebSocket, data: Parameters<WebSocket['send']>[0]) {
      const text = asText(data);
      if (text !== null) {
        const decided = decide(text, this.url, 'websocket');
        // Dropping one frame desynchronises the app's own protocol. That is the
        // intended outcome: a desynchronised editor is recoverable, a leaked
        // value is not (§10.4).
        if (decided === null) return;
        return originalWsSend.call(this, decided);
      }
      return originalWsSend.call(this, data);
    };
    patched.push('websocket');
    undo.push(() => {
      wsProto.send = originalWsSend;
    });
  }

  // --- sendBeacon --------------------------------------------------------
  // Fires on pagehide, when nothing can be retried and nobody is watching.
  const nav = win.navigator;
  const originalBeacon = nav?.sendBeacon;
  if (nav && typeof originalBeacon === 'function') {
    nav.sendBeacon = function patchedBeacon(this: Navigator, url: string | URL, data?: BodyInit | null) {
      const text = asText(data);
      if (text !== null) {
        const decided = decide(text, String(url), 'beacon');
        if (decided === null) return false;
        return originalBeacon.call(this, url, decided);
      }
      return originalBeacon.call(this, url, data);
    };
    patched.push('beacon');
    undo.push(() => {
      nav.sendBeacon = originalBeacon;
    });
  }

  /**
   * A frame filter, not a security boundary — the header is explicit that the
   * page can forge anything on this channel. It exists to ignore chatter posted
   * up from an embedded iframe. A null source is accepted because a same-window
   * post reports one only in a real browser; jsdom leaves it null.
   */
  const onMessage = (event: MessageEvent): void => {
    const data = event.data as ToShim | null;
    if (event.source && event.source !== win) return;
    if (data?.channel !== CHANNEL || data.kind !== 'config') return;
    config = data.config;
  };
  win.addEventListener('message', onMessage);
  undo.push(() => win.removeEventListener('message', onMessage));

  report({ channel: CHANNEL, kind: 'health', patched });

  return {
    patched,
    restore(): void {
      for (const fn of undo.reverse()) fn();
    },
  };
}

// Bundled as its own entry and injected at `document_start`; running on import
// is the point, since anything later has already lost the race for the original
// references (§10.2).
if (typeof window !== 'undefined' && !(window as { __anonymiceEgress?: boolean }).__anonymiceEgress) {
  (window as { __anonymiceEgress?: boolean }).__anonymiceEgress = true;
  installEgressShim(window);
}
