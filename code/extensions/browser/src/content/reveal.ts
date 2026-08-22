/**
 * Mounting the reveal surface — SPEC §8.3, §8.6.
 *
 * The page's field holds a token at every instant. This file never writes a
 * value into it; the only plaintext write in the whole design is
 * declassification (§8.5), and even that arrives from the frame rather than
 * being computed here.
 *
 * **Lazy, on paste.** Cloning every input on every page is where this design
 * dies. Mounting only for a paste we can prove is ours also removes two failure
 * modes outright: there is no typed-prefix leak, because paste is atomic and we
 * classify a complete value; and there is no autofill hazard, because autofill
 * is not a paste.
 *
 * **Failure direction.** If the frame fails to mount, fails to position, or is
 * torn out by the page, the field contains the token — which is what the
 * untrusted client is supposed to receive. Degraded UX, intact security (§8.6).
 *
 * Everything about the frame itself is behind `Surface`, so what remains here is
 * only the policy: when to mount, what to send, and what to do with the replies.
 */
import { scanTokens, type TokenMatch } from '../lib/tokens.ts';
import type { Command, MountCommand, Outbound } from '../ui/reveal.ts';

const FRAME_ATTR = 'data-anonymice';

/** Copied onto the clone so it does not look pasted on (SPEC §8.8 on fonts). */
const MIRRORED_STYLE = [
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'letter-spacing',
  'text-align',
  'color',
  'direction',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
] as const;

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The rendering surface, which in production is a `chrome-extension://` iframe —
 * the only thing on the page the page itself cannot read (SPEC §8.1).
 */
export interface Surface {
  send(command: Command): void;
  onMessage(handler: (message: Outbound) => void): void;
  /** Draw at these viewport coordinates; `null` hides it. */
  place(box: Box | null): void;
  dispose(): void;
}

export interface RevealOptions {
  /** Destination scope for anything minted from the frame (SPEC §6.3). */
  scopeId: string;
  country?: string;
  /** `chrome.runtime.getURL('reveal.html')`. Ignored when `surface` is given. */
  frameUrl?: string;
  /** Swappable so the mount logic can be tested without a browser frame. */
  surface?: Surface;
  onEvent?: (event: Outbound, field: HTMLInputElement) => void;
}

type Field = HTMLInputElement;

/**
 * The page's own `value` setter may be patched; the isolated world's is not.
 * Going through the prototype descriptor also makes React notice, which
 * assigning `el.value` alone does not.
 */
export function setFieldValue(field: Field, value: string): void {
  const proto = field.ownerDocument.defaultView?.HTMLInputElement?.prototype;
  const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : undefined;
  if (descriptor?.set) descriptor.set.call(field, value);
  else field.value = value;
  const view = field.ownerDocument.defaultView;
  if (!view) return;
  field.dispatchEvent(new view.Event('input', { bubbles: true }));
  field.dispatchEvent(new view.Event('change', { bubbles: true }));
}

/** `<label for>` cannot cross into the frame; the computed name can (§8.3). */
export function accessibleName(field: Field): string {
  const aria = field.getAttribute('aria-label');
  if (aria) return aria;
  const by = field.getAttribute('aria-labelledby');
  if (by) {
    const text = by
      .split(/\s+/)
      .map((id) => field.ownerDocument.getElementById(id)?.textContent ?? '')
      .join(' ')
      .trim();
    if (text) return text;
  }
  if (field.id) {
    const escaped = field.ownerDocument.defaultView?.CSS?.escape?.(field.id) ?? field.id;
    const label = field.ownerDocument.querySelector(`label[for="${escaped}"]`);
    if (label?.textContent) return label.textContent.trim();
  }
  const wrapping = field.closest('label');
  if (wrapping?.textContent) return wrapping.textContent.trim();
  return field.placeholder || field.title || '';
}

/**
 * Rewrite the tokens in a string into their canonical form, leaving everything
 * between them alone.
 *
 * A token that has been through a rich editor carries zero-width characters, a
 * non-breaking hyphen, or the wrong case. `scanTokens` still finds it (SPEC
 * §6.4), and writing the clean form into the field means the *next* reader can
 * resolve it too. This is the only edit made to pasted text, and it never
 * changes which token a string denotes (SPEC §8.10).
 */
export function canonicaliseTokens(text: string, found: readonly TokenMatch[]): string {
  let out = '';
  let cursor = 0;
  for (const match of found) {
    out += text.slice(cursor, match.start) + match.token;
    cursor = match.end;
  }
  return out + text.slice(cursor);
}

/**
 * Empty field, or a selection covering everything in it (SPEC §8.3).
 *
 * Pasting into the middle of existing content means reconciling mixed state —
 * some typed plaintext, some already tokenised — and there is no honest answer
 * to what the field then holds. Those pastes fall through untouched.
 */
export function isFullReplace(field: Field): boolean {
  if (field.value === '') return true;
  return field.selectionStart === 0 && field.selectionEnd === field.value.length;
}

/**
 * Single-value inputs only, for now. A textarea holding three tokens gives three
 * spans to track through arbitrary edits, and there is no way to render an
 * atomic chip inside one to make them indivisible (SPEC §8.3).
 *
 * No `instanceof`: the isolated world's `HTMLInputElement` is not the page
 * realm's, and this also runs under jsdom.
 */
export function isTextInput(node: EventTarget | null): node is Field {
  if (!node || (node as Node).nodeType !== 1) return false;
  const el = node as Element;
  if (el.tagName !== 'INPUT') return false;
  const type = (el.getAttribute('type') ?? 'text').toLowerCase();
  return ['text', 'search', 'tel', 'url', 'email', ''].includes(type);
}

export interface Revealer {
  /** `payload` is the single token for a clone, the field's whole text for a reveal. */
  mount(field: Field, payload: string, mode: MountCommand['mode']): void;
  unmount(): void;
  readonly anchor: Field | null;
  detach(): void;
}

export function createRevealer(doc: Document, opts: RevealOptions): Revealer {
  const surface = opts.surface ?? iframeSurface(doc, opts.frameUrl ?? 'about:blank');
  let anchor: Field | null = null;
  /** Restored on teardown, so the page gets its own inline style back. */
  let anchorVisibility: string | null = null;
  let mode: MountCommand['mode'] = 'reveal';
  let popover = { width: 260, height: 40 };
  let raf = 0;
  let resizeObserver: ResizeObserver | null = null;

  surface.onMessage((message) => {
    const field = anchor;
    if (!field) return;
    switch (message.type) {
      case 'token':
        // The swap §8.4 allows exactly once per edit: parent token out, child in.
        setFieldValue(field, message.token);
        break;
      case 'declassify':
        setFieldValue(field, message.literal);
        break;
      case 'size':
        popover = { width: message.width, height: message.height };
        position();
        break;
      case 'done':
        unmount();
        break;
    }
    opts.onEvent?.(message, field);
  });

  function position(): void {
    raf = 0;
    if (!anchor?.isConnected) return surface.place(null);
    const rect = anchor.getBoundingClientRect();
    const viewportHeight = doc.defaultView?.innerHeight ?? 0;
    // Scrolled out of view, or collapsed by the page: stop drawing rather than
    // parking the frame over unrelated content.
    if (rect.width === 0 || rect.bottom < 0 || rect.top > viewportHeight) return surface.place(null);

    surface.place(
      mode === 'clone'
        ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
        : {
            left: rect.left,
            top: rect.bottom + 4,
            width: Math.max(popover.width, rect.width),
            height: popover.height,
          },
    );
  }

  const schedule = (): void => {
    const view = doc.defaultView;
    if (!view?.requestAnimationFrame) return void position();
    if (raf) return;
    raf = view.requestAnimationFrame(position);
  };

  function mount(field: Field, payload: string, next: MountCommand['mode']): void {
    if (anchor && anchor !== field) unmount();
    anchor = field;
    mode = next;

    const command: MountCommand = {
      type: 'mount',
      mode: next,
      token: payload,
      scopeId: opts.scopeId,
      ...(opts.country ? { country: opts.country } : {}),
      ariaLabel: accessibleName(field),
    };

    if (next === 'clone') {
      const computed = doc.defaultView?.getComputedStyle(field);
      const style: Record<string, string> = {};
      if (computed) for (const prop of MIRRORED_STYLE) style[prop] = computed.getPropertyValue(prop);
      command.style = style;
      command.constraints = {
        ...(field.type ? { type: field.type } : {}),
        ...(field.pattern ? { pattern: field.pattern } : {}),
        ...(field.maxLength >= 0 ? { maxLength: field.maxLength } : {}),
        ...(field.minLength >= 0 ? { minLength: field.minLength } : {}),
        ...(field.required ? { required: true } : {}),
        ...(field.inputMode ? { inputMode: field.inputMode } : {}),
      };
      // The token underneath must not show through a frame of scroll jitter.
      anchorVisibility = field.style.visibility;
      field.style.visibility = 'hidden';
    }

    surface.send(command);
    schedule();
    observe(field);
  }

  function unmount(): void {
    if (anchor && anchorVisibility !== null) {
      anchor.style.visibility = anchorVisibility;
      anchorVisibility = null;
    }
    anchor = null;
    surface.send({ type: 'unmount' });
    surface.place(null);
    resizeObserver?.disconnect();
    resizeObserver = null;
  }

  /**
   * §8.8 is honest that this still jitters on nested scroll containers, sticky
   * ancestors and virtualised lists that recycle nodes.
   */
  function observe(field: Field): void {
    const view = doc.defaultView;
    if (!view?.ResizeObserver) return;
    resizeObserver = new view.ResizeObserver(schedule);
    resizeObserver.observe(field);
  }

  /**
   * `getData('text/plain')` is synchronous, so the decision to take the paste is
   * made before we commit to `preventDefault()`. The vault confirmation happens
   * inside the frame, after — which is why a token-shaped string that turns out
   * to be documentation renders "from another vault" rather than a clone.
   */
  const onPaste = (event: Event): void => {
    const field = event.target;
    if (!isTextInput(field)) return;
    const text = (event as ClipboardEvent).clipboardData?.getData('text/plain') ?? '';
    const found = scanTokens(text);
    if (found.length === 0) return;
    // Merging into existing content has no honest answer for what the field then
    // holds (SPEC §8.3).
    if (!isFullReplace(field)) return;

    event.preventDefault();
    // Load-bearing, and separate from preventDefault: without it a page handler
    // still on the propagation path receives a live ClipboardEvent and calls
    // getData() itself (SPEC §8.3).
    event.stopImmediatePropagation();

    const canonical = canonicaliseTokens(text, found);
    setFieldValue(field, canonical);

    // One token and nothing else is the editable case. Prose with tokens in it is
    // read-only: N spans through arbitrary edits is a different problem, and a
    // plain input has nowhere to draw an atomic chip (SPEC §8.10).
    const bare = found.length === 1 && canonical.trim() === found[0]!.token;
    mount(field, bare ? found[0]!.token : canonical, bare ? 'clone' : 'reveal');
  };

  /**
   * Reveal-on-demand: whatever the field already holds, however it got there —
   * pasted, typed, or filled by the page (SPEC §8.9 step 1, §8.10).
   */
  const onFocusIn = (event: Event): void => {
    const field = event.target;
    if (!isTextInput(field) || field === anchor) return;
    if (scanTokens(field.value).length === 0) return;
    mount(field, field.value, 'reveal');
  };

  const onFocusOut = (event: Event): void => {
    // The clone owns its own blur — it has a decision to make first (§8.5).
    if (mode === 'clone') return;
    if (event.target === anchor) unmount();
  };

  const onScroll = (): void => schedule();

  doc.addEventListener('paste', onPaste, true);
  doc.addEventListener('focusin', onFocusIn, true);
  doc.addEventListener('focusout', onFocusOut, true);
  doc.defaultView?.addEventListener('scroll', onScroll, { passive: true, capture: true });
  doc.defaultView?.addEventListener('resize', onScroll, { passive: true });

  return {
    mount,
    unmount,
    get anchor(): Field | null {
      return anchor;
    },
    detach(): void {
      unmount();
      doc.removeEventListener('paste', onPaste, true);
      doc.removeEventListener('focusin', onFocusIn, true);
      doc.removeEventListener('focusout', onFocusOut, true);
      doc.defaultView?.removeEventListener('scroll', onScroll, true);
      doc.defaultView?.removeEventListener('resize', onScroll);
      surface.dispose();
    },
  };
}

/**
 * The production surface: one iframe per page, created hidden and reused.
 *
 * Mounting cold inside a paste handler is where the visible glitch comes from;
 * repositioning a warm frame is one frame (SPEC §8.3).
 *
 * The channel is a `MessageChannel` whose far end is handed over once, at load.
 * The page can see the iframe element and can embed the same document itself —
 * the resource is web-accessible — but it cannot obtain a port it did not
 * create, so it cannot listen in on a real mount.
 *
 * Appended to `<body>` to escape z-index wars, which means it no longer clips
 * inside an `overflow: hidden` ancestor and can bleed (SPEC §8.8).
 */
function iframeSurface(doc: Document, url: string): Surface {
  const frame = doc.createElement('iframe');
  frame.setAttribute(FRAME_ATTR, 'reveal');
  frame.setAttribute('aria-hidden', 'true');
  frame.src = url;
  frame.style.cssText =
    'position:fixed;border:0;display:none;z-index:2147483647;background:transparent;';
  doc.body.appendChild(frame);

  const channel = new (doc.defaultView as unknown as { MessageChannel: typeof MessageChannel })
    .MessageChannel();
  let queued: Command[] | null = [];
  let ready = false;

  frame.addEventListener('load', () => {
    frame.contentWindow?.postMessage({ type: 'anonymice:port' }, '*', [channel.port2]);
    ready = true;
    for (const command of queued ?? []) channel.port1.postMessage(command);
    queued = null;
  });

  return {
    send(command) {
      // A paste can beat the frame's first load. Queue rather than drop: the
      // field already holds the token, so the only thing at stake is the reveal.
      if (ready) channel.port1.postMessage(command);
      else queued?.push(command);
    },
    onMessage(handler) {
      channel.port1.onmessage = (e: MessageEvent) => handler(e.data as Outbound);
      channel.port1.start();
    },
    place(box) {
      if (!box) {
        frame.style.display = 'none';
        return;
      }
      frame.style.display = 'block';
      frame.style.left = `${box.left}px`;
      frame.style.top = `${box.top}px`;
      frame.style.width = `${box.width}px`;
      frame.style.height = `${box.height}px`;
    },
    dispose() {
      channel.port1.close();
      frame.remove();
    },
  };
}
