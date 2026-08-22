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
import { detokenize, safeToSubstitute, tokensIn } from '../lib/detokenize.ts';
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
  /**
   * `dom` turns on ingress: a token arriving in a response is rewritten to its
   * value before the application sees it, so the page renders real data while
   * the wire carries tokens (SPEC §10.9). `off` leaves responses untouched.
   */
  reveal?: 'off' | 'dom';
  /** token → value, for ingress. Only ever tokens this page has already received. */
  values?: Record<string, string>;
}

export type ToShim = { channel: typeof CHANNEL; kind: 'config'; config: EgressConfig };

export type Transport = 'fetch' | 'xhr' | 'websocket' | 'beacon' | 'form';

export type FromShim =
  | { channel: typeof CHANNEL; kind: 'blocked'; url: string; transport: Transport; missing: Owed[] }
  | { channel: typeof CHANNEL; kind: 'sent'; url: string; transport: Transport; replaced: number }
  | { channel: typeof CHANNEL; kind: 'health'; patched: Transport[] }
  /** Tokens seen on the way in that we hold no value for (SPEC §10.9.3). */
  | { channel: typeof CHANNEL; kind: 'unresolved'; tokens: string[] };

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

/**
 * Bodies we can read **synchronously**. `WebSocket.send`, `XHR.send` and
 * `sendBeacon` cannot await, so for them this is the whole story (§10.3).
 */
function asText(body: unknown): string | null {
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  // Bytes are readable without awaiting; whether they are *text* is decided by
  // whether the decode round-trips, which rejects gzip and other binary framing.
  if (body instanceof ArrayBuffer) return decodeIfText(new Uint8Array(body));
  if (ArrayBuffer.isView(body)) {
    const view = body as ArrayBufferView;
    return decodeIfText(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  }
  return null;
}

const decoder = new TextDecoder('utf-8', { fatal: true });

/**
 * A body is text if it decodes as UTF-8 without error and carries no control
 * characters. gzip starts `1f 8b`, so it fails on the first count; a protobuf or
 * a JPEG fails on one or the other. This is what turns §10.7's "binary bodies
 * pass unexamined" from a blanket hole into one that only covers genuinely
 * opaque payloads.
 */
function decodeIfText(bytes: Uint8Array): string | null {
  if (bytes.byteLength === 0) return '';
  try {
    const text = decoder.decode(bytes);
    // eslint-disable-next-line no-control-regex
    return /[\u0000-\u0008\u000e-\u001f]/.test(text) ? null : text;
  } catch {
    return null;
  }
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
      verdict = inspect(body, config.known, tokenFor, {
        country: config.country,
        // Substituting into a positional payload corrupts the destination's
        // document, so such a body may be forwarded clean or held, never
        // rewritten (SPEC §10.9.2).
        allowSubstitute: safeToSubstitute(body),
      });
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

  /**
   * Ingress. Rewrites a token back to its value before the application sees it.
   *
   * Only ever applied to a body `safeToSubstitute` accepts, for the same offset
   * reason as egress — a collab step stream is read-only to us in both
   * directions (SPEC §10.9.2).
   */
  const reveal = (body: string): string => {
    if (config.reveal !== 'dom') return body;
    if (!safeToSubstitute(body)) return body;
    const values = config.values ?? {};
    const result = detokenize(body, (token) => values[token]);
    if (result.unresolved.length) {
      report({ channel: CHANNEL, kind: 'unresolved', tokens: result.unresolved });
    }
    return result.text;
  };

  /** What the bridge should go and resolve, whether or not we could rewrite now. */
  const noteTokens = (body: string): void => {
    if (config.reveal !== 'dom') return;
    const seen = tokensIn(body).filter((t) => !(config.values ?? {})[t]);
    if (seen.length) report({ channel: CHANNEL, kind: 'unresolved', tokens: seen });
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
        if (decided !== text) {
          return withReveal(originalFetch.call(this, input, { ...init, body: decided }));
        }
      }
      return withReveal(originalFetch.call(this, input, init));
    } as typeof win.fetch;
    patched.push('fetch');
    undo.push(() => {
      win.fetch = originalFetch;
    });
  }

  /**
   * `fetch` is the one place ingress can *await*, which is what makes an initial
   * page load render real values rather than tokens: the document's own API
   * calls are resolved before the application ever parses them (§10.9.3).
   */
  const withReveal = (promise: Promise<Response>): Promise<Response> => {
    if (config.reveal !== 'dom') return promise;
    return promise.then(async (response) => {
      const type = response.headers?.get?.('content-type') ?? '';
      if (!/json|text|javascript|xml/i.test(type)) return response;
      let text: string;
      try {
        text = await response.clone().text();
      } catch {
        return response;
      }
      noteTokens(text);
      const revealed = reveal(text);
      if (revealed === text) return response;
      return new Response(revealed, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    });
  };

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
    /**
     * `responseText` is a readonly accessor on the prototype, so ingress here
     * means shadowing it per instance once the response has landed. The
     * application reads the property, not the network, so this is the same
     * substitution `fetch` does — just at the only place XHR exposes.
     */
    const shadowResponse = (xhr: XMLHttpRequest): void => {
      let text: string;
      try {
        text = xhr.responseType === '' || xhr.responseType === 'text' ? xhr.responseText : '';
      } catch {
        return;
      }
      if (!text) return;
      noteTokens(text);
      const revealed = reveal(text);
      if (revealed === text) return;
      Object.defineProperty(xhr, 'responseText', { value: revealed, configurable: true });
      Object.defineProperty(xhr, 'response', { value: revealed, configurable: true });
    };
    const originalAdd = xhrProto.addEventListener;
    xhrProto.send = function patchedSendWithReveal(
      this: XMLHttpRequest,
      body?: Document | XMLHttpRequestBodyInit | null,
    ) {
      if (config.reveal === 'dom') {
        // Ahead of any handler the application registers later, because a
        // `readystatechange` listener added after ours still runs after ours.
        originalAdd.call(this, 'readystatechange', () => {
          if (this.readyState === 4) shadowResponse(this);
        });
      }
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
    /**
     * Incoming frames. `MessageEvent.data` is readonly, so the handler is
     * wrapped and handed a shallow stand-in rather than the event being edited.
     *
     * Ingress here uses only the warm cache — a listener cannot await. In
     * practice that is enough, because the tokens a collab stream carries were
     * almost always resolved during the page's own initial load (§10.9.3).
     */
    const originalWsAdd = wsProto.addEventListener;
    const wrapped = new WeakMap<object, EventListener>();
    const wrap = (listener: EventListener): EventListener => {
      const existing = wrapped.get(listener);
      if (existing) return existing;
      const fn: EventListener = (event) => {
        const data = (event as MessageEvent).data;
        if (config.reveal !== 'dom' || typeof data !== 'string') return listener(event);
        noteTokens(data);
        const revealed = reveal(data);
        if (revealed === data) return listener(event);
        return listener(
          new Proxy(event as MessageEvent, {
            get: (target, prop) => (prop === 'data' ? revealed : Reflect.get(target, prop, target)),
          }),
        );
      };
      wrapped.set(listener, fn);
      return fn;
    };
    wsProto.addEventListener = function patchedWsAdd(
      this: WebSocket,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) {
      if (type === 'message' && typeof listener === 'function') {
        return originalWsAdd.call(this, type, wrap(listener as EventListener), options);
      }
      return originalWsAdd.call(this, type, listener as EventListener, options);
    } as typeof wsProto.addEventListener;

    const onmessageDescriptor = Object.getOwnPropertyDescriptor(wsProto, 'onmessage');
    if (onmessageDescriptor?.set && onmessageDescriptor.get) {
      const { get, set } = onmessageDescriptor;
      Object.defineProperty(wsProto, 'onmessage', {
        configurable: true,
        enumerable: onmessageDescriptor.enumerable ?? true,
        get,
        set(this: WebSocket, listener: unknown) {
          set.call(this, typeof listener === 'function' ? wrap(listener as EventListener) : listener);
        },
      });
    }

    patched.push('websocket');
    undo.push(() => {
      wsProto.send = originalWsSend;
      wsProto.addEventListener = originalWsAdd;
      if (onmessageDescriptor) Object.defineProperty(wsProto, 'onmessage', onmessageDescriptor);
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
  // --- form submit / navigation ------------------------------------------
  /**
   * A `<form method="POST">` submit is a browser navigation, not a JS API call,
   * so none of the patches above are on its path. With a token in the field that
   * did not matter; with plaintext in the DOM (`reveal: 'dom'`) it is the
   * shortest leak there is (SPEC §10.10).
   *
   * Capture phase, so the decision is made before the application's own
   * `submit` handlers run — the same reason §8.3's paste handler captures.
   *
   * Fields are rewritten in place rather than the submit being rebuilt: the
   * browser serialises the form itself, and any attempt to reproduce that
   * encoding is a bug waiting for a `multipart` boundary.
   */
  const onSubmit = (event: Event): void => {
    if (config.mode === undefined) return;
    const form = event.target as HTMLFormElement | null;
    if (!form || typeof form.elements === 'undefined') return;

    const fields = [...form.elements].filter(
      (el): el is HTMLInputElement | HTMLTextAreaElement =>
        (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') &&
        typeof (el as HTMLInputElement).value === 'string' &&
        (el as HTMLInputElement).value !== '',
    );

    const held: Owed[] = [];
    for (const field of fields) {
      const verdict = inspect(field.value, config.known, tokenFor, {
        country: config.country,
        allowSubstitute: true,
      });
      if (verdict.kind === 'clean') continue;
      if (verdict.kind === 'substituted') {
        field.value = verdict.body;
        continue;
      }
      held.push(...owed(verdict.missing));
    }

    if (held.length === 0) return;
    report({
      channel: CHANNEL,
      kind: 'blocked',
      url: form.action || win.location.href,
      transport: 'form',
      missing: held,
    });
    if (config.mode === 'enforce') {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  win.addEventListener('submit', onSubmit, true);
  patched.push('form');
  undo.push(() => win.removeEventListener('submit', onSubmit, true));

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
