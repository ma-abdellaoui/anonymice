/**
 * The reveal surface — SPEC §8.
 *
 * An extension-origin document, embedded in the page as an iframe. It is the
 * only place the plaintext exists on a `TRUSTED` or activated `UNTRUSTED` page:
 * the page's own input holds a token at every instant (§8.1), and this frame is
 * cross-origin to it, so nothing the page runs can read what is drawn here.
 *
 * It talks to the service worker **directly** rather than relaying through the
 * content script. The page could not read the content script's world either, but
 * the plaintext having exactly one place to be is worth more than the symmetry.
 *
 * Two modes:
 *   `reveal` — a read-only popover next to the field. §8.9's first step, and
 *              most of the traffic: paste it, glance at it, move on.
 *   `clone`  — a real `<input>` over the hidden field, with a real value for the
 *              browser to run caret, selection, undo, RTL and IME against (§8.2).
 */
import { hasIntrinsicCheck, judgeEdit, stillClassifies } from '../lib/declassify.ts';
import { scanTokens } from '../lib/tokens.ts';
import { normalizeValue } from '../lib/normalize.ts';
import type { Resolution } from '../background/vault-client.ts';
import type { Cls } from '../lib/types.ts';

/** Everything the parent must tell us; none of it is the value itself. */
export interface MountCommand {
  type: 'mount';
  mode: 'reveal' | 'clone';
  /**
   * `clone`: the single token the field holds.
   * `reveal`: the field's whole text — prose with one or more tokens in it
   * (SPEC §8.10). A field holding nothing but a token is just the N=1 case, and
   * goes down the same path.
   */
  token: string;
  /** Destination scope for any child minted here (SPEC §6.3). */
  scopeId: string;
  /** ISO-3166 alpha-2, for normalising a PHONE (SPEC §5.1). */
  country?: string;
  /** Read off the real input at mount and applied here (SPEC §8.7.1). */
  constraints?: {
    type?: string;
    pattern?: string;
    maxLength?: number;
    minLength?: number;
    required?: boolean;
    inputMode?: string;
  };
  /** `<label for>` cannot cross the boundary; the computed name can (SPEC §8.3). */
  ariaLabel?: string;
  /** The page's computed text styling, so the clone does not look pasted on. */
  style?: Record<string, string>;
}

export type Command = MountCommand | { type: 'unmount' };

export type Outbound =
  /** Write this token into the page's field. */
  | { type: 'token'; token: string }
  /** The one deliberate plaintext write (SPEC §8.5). */
  | { type: 'declassify'; literal: string }
  /** Refused as a fragment of the secret — the field keeps its token. */
  | { type: 'refused'; reason: 'prefix' | 'fragment' }
  /** How much room this frame wants, in CSS pixels. */
  | { type: 'size'; width: number; height: number }
  | { type: 'done' };

/**
 * Looked up per render rather than at module load: the pure half of this file
 * (`revealSegments`) is imported by tests, and a module that reaches for the DOM
 * on import cannot be.
 */
function root(): HTMLElement {
  return document.getElementById('root')!;
}

let port: MessagePort | null = null;
let mounted: MountCommand | null = null;
/** The plaintext. Never posted anywhere except through `declassify`. */
let resolved = '';
let cls: Cls = 'UNKNOWN';
/** The child minted for this edit session, once the value has actually moved. */
let childToken: string | null = null;
let minting = false;

function send(message: Outbound): void {
  port?.postMessage(message);
}

async function ask(
  op: 'resolve' | 'child' | 'update' | 'commit',
  payload: Record<string, unknown>,
): Promise<unknown> {
  return chrome.runtime.sendMessage({ type: 'anonymice:vault', op, ...payload });
}

/**
 * The parent hands over one end of a `MessageChannel` and everything after runs
 * on it. A page can embed this document itself — the resource is web-accessible —
 * but a channel it did not create is not one it can reach, so it cannot listen
 * in on a real mount.
 */
if (typeof window !== 'undefined') {
  window.addEventListener('message', (event: MessageEvent) => {
    if ((event.data as { type?: string } | null)?.type !== 'anonymice:port') return;
    const incoming = event.ports[0];
    if (!incoming || port) return;
    port = incoming;
    port.onmessage = (e: MessageEvent) => void handle(e.data as Command);
    port.start();
  });
}

async function handle(command: Command): Promise<void> {
  if (command.type === 'unmount') return teardown();
  if (command.type !== 'mount') return;

  mounted = command;
  childToken = null;

  // A reveal is given the field's text, not a token: the ordinary case is prose
  // with two or three tokens in it (SPEC §8.10), and one bare token is N=1.
  if (command.mode === 'reveal') return renderMixed(command.token);

  const reply = (await ask('resolve', { token: command.token })) as
    | { resolution: Resolution }
    | null;

  // Null is "could not ask", which is not one of the resolution arms. Say so
  // rather than rendering it as though the vault had answered.
  if (!reply) return renderNote('the vault could not be reached');

  const resolution = reply.resolution;
  if (resolution.kind !== 'value') return renderDead(resolution);

  resolved = resolution.value;
  cls = resolution.cls;
  renderClone(command, resolution);
}

/** Every non-value arm of §6.7's table, rendered as something legible. */
function renderDead(resolution: Resolution): void {
  switch (resolution.kind) {
    case 'tombstone': {
      const t = resolution.tombstone;
      const when = new Date(t.endedAt).toLocaleDateString();
      renderNote(
        t.state === 'revoked'
          ? `${t.cls} token — revoked on ${when}`
          : `${t.cls} token from ${t.sourceScope} — expired ${when}`,
      );
      return;
    }
    case 'foreign':
      renderNote(`a ${resolution.cls} token from another vault or profile`);
      return;
    case 'damaged':
      renderNote(
        resolution.cls
          ? `this looks like a damaged ${resolution.cls} token — it may have been truncated`
          : 'this looks like a damaged token — it may have been truncated',
      );
      return;
    default:
      renderNote('not a token');
  }
}

function renderNote(text: string): void {
  root().replaceChildren(el('div', { class: 'popover muted' }, text));
  measure();
}

/**
 * Draw the field's text with every token replaced by what it stands for.
 *
 * The prose between the tokens is carried through untouched — it was never
 * sensitive, it is what the user selected *around* the values, and a reveal that
 * dropped it would be unreadable. Each substituted value is marked so the reader
 * can see which parts of the line came out of the vault.
 *
 * Resolutions are fetched in parallel and deduplicated: one value quoted twice in
 * a sentence is one round trip, and a resolve is a write on the far side
 * (SPEC §6.7) rather than something to issue per occurrence.
 */
export type Segment =
  /** The user's own prose. Never sensitive — it is what surrounded the values. */
  | { kind: 'text'; text: string }
  | { kind: 'value'; text: string; cls: string; expiresAt?: number }
  /** Expired, revoked, foreign, damaged, or unreachable — legible, in place. */
  | { kind: 'dead'; text: string };

/**
 * Interleave the field's text with what its tokens stand for.
 *
 * Pure, and separate from drawing it, because this is the part with a rule in it:
 * the prose between tokens is carried through byte for byte, and a token that
 * does not resolve says why *where it sits* rather than collapsing the whole line
 * into one failure (SPEC §8.10).
 */
export function revealSegments(
  text: string,
  answers: ReadonlyMap<string, Resolution | null>,
): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;
  for (const match of scanTokens(text)) {
    if (match.start > cursor) segments.push({ kind: 'text', text: text.slice(cursor, match.start) });
    const resolution = answers.get(match.token) ?? null;
    if (!resolution) segments.push({ kind: 'dead', text: '[vault unreachable]' });
    else if (resolution.kind === 'value') {
      segments.push({
        kind: 'value',
        text: resolution.value,
        cls: resolution.cls,
        ...(resolution.expiringSoon ? { expiresAt: resolution.expiresAt } : {}),
      });
    } else segments.push({ kind: 'dead', text: `[${deadText(resolution)}]` });
    cursor = match.end;
  }
  if (cursor < text.length) segments.push({ kind: 'text', text: text.slice(cursor) });
  return segments;
}

/**
 * Draw the field's text with every token replaced by what it stands for.
 *
 * Resolutions are fetched in parallel and deduplicated: one value quoted twice in
 * a sentence is one round trip, and a resolve is a write on the far side
 * (SPEC §6.7) rather than something to issue per occurrence.
 */
async function renderMixed(text: string): Promise<void> {
  const found = scanTokens(text);
  if (found.length === 0) return renderNote('nothing here to resolve');

  const answers = new Map<string, Resolution | null>();
  await Promise.all(
    [...new Set(found.map((m) => m.token))].map(async (token) => {
      const reply = (await ask('resolve', { token })) as { resolution: Resolution } | null;
      answers.set(token, reply?.resolution ?? null);
    }),
  );

  const box = el('div', { class: 'popover' });
  for (const segment of revealSegments(text, answers)) {
    if (segment.kind === 'text') {
      box.append(document.createTextNode(segment.text));
      continue;
    }
    if (segment.kind === 'dead') {
      box.append(el('span', { class: 'muted' }, segment.text));
      continue;
    }
    const span = el('span', { class: 'value', title: segment.cls }, segment.text);
    if (segment.expiresAt !== undefined) {
      span.title = `${segment.cls} — expires ${new Date(segment.expiresAt).toLocaleDateString()}`;
      span.classList.add('expiring');
    }
    box.append(span);
  }

  root().replaceChildren(box);
  measure();
}

function deadText(resolution: Resolution): string {
  switch (resolution.kind) {
    case 'tombstone': {
      const t = resolution.tombstone;
      const when = new Date(t.endedAt).toLocaleDateString();
      return t.state === 'revoked'
        ? `${t.cls} — revoked ${when}`
        : `${t.cls} from ${t.sourceScope} — expired ${when}`;
    }
    case 'foreign':
      return `${resolution.cls} from another vault`;
    case 'damaged':
      return `damaged ${resolution.cls ?? ''} token — may be truncated`.replace('  ', ' ');
    default:
      return 'not a token';
  }
}

/**
 * A genuine `<input>` holding the genuine value. The length mismatch with the
 * token stops being a caret problem — there is a real value for the browser to
 * operate on — and becomes a sync problem, solved by re-tokenising the whole
 * value rather than mapping characters (SPEC §8.2).
 */
function renderClone(command: MountCommand, resolution: Extract<Resolution, { kind: 'value' }>): void {
  document.body.classList.add('clone');
  const input = document.createElement('input');
  input.id = 'field';
  input.value = resolution.value;

  const c = command.constraints ?? {};
  // Whatever the page declared, the clone enforces — zero per-destination
  // maintenance (SPEC §8.7.1).
  if (c.type && c.type !== 'password') input.type = c.type;
  if (c.pattern) input.pattern = c.pattern;
  if (typeof c.maxLength === 'number' && c.maxLength >= 0) input.maxLength = c.maxLength;
  if (typeof c.minLength === 'number' && c.minLength >= 0) input.minLength = c.minLength;
  if (c.required) input.required = true;
  if (c.inputMode) input.inputMode = c.inputMode;
  if (command.ariaLabel) input.setAttribute('aria-label', command.ariaLabel);
  // Chrome's own autofill would write plaintext straight into a field we manage.
  input.autocomplete = 'off';
  input.setAttribute('data-1p-ignore', '');

  for (const [prop, value] of Object.entries(command.style ?? {})) {
    input.style.setProperty(prop, value);
  }

  input.addEventListener('input', () => void onInput(input));
  input.addEventListener('blur', () => void onBlur(input));
  input.addEventListener('keydown', (e) => {
    // Escape abandons the edit. The page's field still holds a token, so this
    // costs the user the edit and nothing else.
    if (e.key === 'Escape') send({ type: 'done' });
  });

  root().replaceChildren(input);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  validate(input);
}

/**
 * Mint on first divergence, not on focus (SPEC §8.4). Focusing a field and
 * typing nothing must not create a record; the keystroke that actually changes
 * the value is what mints the child and swaps the field's token, exactly once.
 */
async function onInput(input: HTMLInputElement): Promise<void> {
  validate(input);
  if (!mounted) return;
  const next = input.value;

  if (childToken) {
    await ask('update', {
      token: childToken,
      value: next,
      normalized: normalizeValue(cls, next, mounted.country ? { country: mounted.country } : {}),
    });
    return;
  }
  if (next === resolved || minting) return;

  minting = true;
  const token = (await ask('child', {
    token: mounted.token,
    value: next,
    normalized: normalizeValue(cls, next, mounted.country ? { country: mounted.country } : {}),
    scopeId: mounted.scopeId,
  })) as string | null;
  minting = false;

  // No child means no token to swap in, and the field keeps the parent's — still
  // a token, still not plaintext. The edit is simply not recorded.
  if (!token) return;
  childToken = token;
  send({ type: 'token', token });
}

/**
 * Blur is where the decision is made. Judging mid-word would refuse every edit
 * at the moment it is half-typed (SPEC §8.5).
 */
async function onBlur(input: HTMLInputElement): Promise<void> {
  if (!mounted) return;
  const verdict = judgeEdit(cls, input.value, resolved, mounted.country);

  if (verdict.kind === 'declassify') {
    // The one operation that deliberately puts plaintext into the page. Only a
    // real user can reach it: page JS cannot type into a cross-origin frame.
    send({ type: 'declassify', literal: input.value });
    send({ type: 'done' });
    return;
  }

  if (childToken) await ask('commit', { token: childToken });
  if (verdict.kind === 'refuse') send({ type: 'refused', reason: verdict.reason });
  send({ type: 'done' });
}

/**
 * The field's own constraints plus the class checksum, and nothing that is the
 * destination's business (SPEC §8.7.3). "This customer already exists" runs at
 * submit, against the token, and the destination reports it.
 */
function validate(input: HTMLInputElement): void {
  // 1. Whatever the page declared — pattern, maxlength, type — read off the real
  //    input at mount and enforced here.
  const declared = input.checkValidity();
  // 2. The class checksum, from the same library the backend's rule pass runs, so
  //    the clone cannot disagree with the detector about what a valid IBAN is.
  //    A class with no checksum is not invalid; it is unjudged.
  const intrinsic =
    input.value === '' ||
    !hasIntrinsicCheck(cls) ||
    stillClassifies(cls, input.value, mounted?.country);
  document.body.classList.toggle('invalid', !declared || !intrinsic);
}

function teardown(): void {
  root().replaceChildren();
  document.body.classList.remove('clone', 'invalid');
  mounted = null;
  childToken = null;
  resolved = '';
}

function measure(): void {
  const rect = root().firstElementChild?.getBoundingClientRect();
  if (rect) send({ type: 'size', width: Math.ceil(rect.width), height: Math.ceil(rect.height) });
}

function el(tag: string, attrs: Record<string, string> = {}, text?: string): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}
