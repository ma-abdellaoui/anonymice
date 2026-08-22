import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  accessibleName,
  canonicaliseTokens,
  createRevealer,
  isFullReplace,
  isTextInput,
  setFieldValue,
  type Box,
  type Surface,
} from '../src/content/reveal.ts';
import { mintToken, scanTokens } from '../src/lib/tokens.ts';
import { revealSegments } from '../src/ui/reveal.ts';
import type { Command, MountCommand, Outbound } from '../src/ui/reveal.ts';
import type { Resolution } from '../src/background/vault-client.ts';
import { domFrom } from './helpers.ts';

interface FakeSurface extends Surface {
  readonly sent: Command[];
  readonly boxes: (Box | null)[];
  /** Push a message back to the content script, as the frame would. */
  reply(message: Outbound): void;
  readonly lastMount: MountCommand | undefined;
}

function fakeSurface(): FakeSurface {
  const sent: Command[] = [];
  const boxes: (Box | null)[] = [];
  let handler: ((m: Outbound) => void) | null = null;
  return {
    sent,
    boxes,
    send: (c) => void sent.push(c),
    onMessage: (h) => void (handler = h),
    place: (b) => void boxes.push(b),
    dispose: () => {},
    reply: (m) => handler?.(m),
    get lastMount() {
      return [...sent].reverse().find((c): c is MountCommand => c.type === 'mount');
    },
  };
}

const IBAN_VALUE = 'CH93 0076 2011 6238 5295 7';

function page(html: string) {
  const doc = domFrom(html);
  const surface = fakeSurface();
  const revealer = createRevealer(doc, { scopeId: 'destination:https://vendor.example', surface });
  return { doc, surface, revealer };
}

/** jsdom has no ClipboardEvent, so the event carries what the handler reads. */
function paste(doc: Document, field: HTMLInputElement, text: string) {
  const view = doc.defaultView!;
  const event = new view.Event('paste', { bubbles: true, cancelable: true });
  const state = { prevented: false, stopped: false };
  Object.defineProperty(event, 'clipboardData', { value: { getData: () => text } });
  Object.defineProperty(event, 'target', { value: field });
  const preventDefault = event.preventDefault.bind(event);
  Object.defineProperty(event, 'preventDefault', {
    value: () => {
      state.prevented = true;
      preventDefault();
    },
  });
  Object.defineProperty(event, 'stopImmediatePropagation', {
    value: () => void (state.stopped = true),
  });
  doc.dispatchEvent(event);
  return state;
}

// --- the §8.1 invariant -----------------------------------------------------

test('pasting a token leaves the token in the field, never the value (SPEC §8.1)', () => {
  const { doc, surface, revealer } = page('<input id="f">');
  const field = doc.querySelector<HTMLInputElement>('#f')!;
  const token = mintToken('IBAN');

  const state = paste(doc, field, token);
  assert.equal(state.prevented, true);
  assert.equal(state.stopped, true, 'a page handler must not get a live ClipboardEvent (§8.3)');
  assert.equal(field.value, token);

  // The frame resolves and the user edits; only tokens ever come back.
  surface.reply({ type: 'token', token: 'ANM1-IBAN-CHILDCHILDCHILDCH' });
  assert.equal(field.value, 'ANM1-IBAN-CHILDCHILDCHILDCH');
  assert.ok(!field.value.includes('CH93 '), 'the plaintext never enters the page tree');
  revealer.detach();
});

test('the page input is hidden while the clone stands over it, and restored after', () => {
  const { doc, surface, revealer } = page('<input id="f" style="visibility:visible">');
  const field = doc.querySelector<HTMLInputElement>('#f')!;

  paste(doc, field, mintToken('IBAN'));
  assert.equal(field.style.visibility, 'hidden');

  surface.reply({ type: 'done' });
  assert.equal(field.style.visibility, 'visible', 'the page gets its own inline style back');
  revealer.detach();
});

test('a declassified literal is the one plaintext write, and only on the frame\'s say-so', () => {
  const { doc, surface, revealer } = page('<input id="f">');
  const field = doc.querySelector<HTMLInputElement>('#f')!;
  paste(doc, field, mintToken('IBAN'));

  surface.reply({ type: 'declassify', literal: 'invoice ref 12' });
  assert.equal(field.value, 'invoice ref 12');
  revealer.detach();
});

// --- what is and is not taken -----------------------------------------------

test('an ordinary paste is not touched', () => {
  const { doc, surface, revealer } = page('<input id="f">');
  const field = doc.querySelector<HTMLInputElement>('#f')!;
  const state = paste(doc, field, 'just some text');
  assert.equal(state.prevented, false);
  assert.deepEqual(surface.sent, []);
  revealer.detach();
});

test('a token-shaped string with a bad check character is not taken', () => {
  const { doc, surface, revealer } = page('<input id="f">');
  const field = doc.querySelector<HTMLInputElement>('#f')!;
  const state = paste(doc, field, 'ANM1-IBAN-AAAAAAAAAAAAAAAAA');
  assert.equal(state.prevented, false, 'damaged is not a mount — the vault decides, and this never gets there');
  assert.deepEqual(surface.sent, []);
  revealer.detach();
});

test('pasting into the middle of existing content falls through (SPEC §8.3)', () => {
  const { doc, surface, revealer } = page('<input id="f" value="already here">');
  const field = doc.querySelector<HTMLInputElement>('#f')!;
  field.setSelectionRange(3, 5);
  const state = paste(doc, field, mintToken('IBAN'));

  assert.equal(state.prevented, false, 'mixed state has no honest answer');
  assert.equal(field.value, 'already here');
  assert.deepEqual(surface.sent, []);
  revealer.detach();
});

test('a full-replace paste over existing content is taken', () => {
  const { doc, revealer } = page('<input id="f" value="old">');
  const field = doc.querySelector<HTMLInputElement>('#f')!;
  field.setSelectionRange(0, 3);
  const token = mintToken('IBAN');
  assert.equal(paste(doc, field, token).prevented, true);
  assert.equal(field.value, token);
  revealer.detach();
});

test('a password field is never cloned', () => {
  const { doc, surface, revealer } = page('<input id="f" type="password">');
  const field = doc.querySelector<HTMLInputElement>('#f')!;
  assert.equal(paste(doc, field, mintToken('IBAN')).prevented, false);
  assert.deepEqual(surface.sent, []);
  revealer.detach();
});

test('a textarea is a separate, harder problem and is left alone (SPEC §8.3)', () => {
  const { doc, surface, revealer } = page('<textarea id="t"></textarea>');
  const area = doc.querySelector<HTMLInputElement>('#t')!;
  assert.equal(paste(doc, area, mintToken('IBAN')).prevented, false);
  assert.deepEqual(surface.sent, []);
  revealer.detach();
});

// --- reveal on demand -------------------------------------------------------

test('focusing a field that already holds a token reveals it read-only', () => {
  const { doc, surface, revealer } = page('<input id="f">');
  const field = doc.querySelector<HTMLInputElement>('#f')!;
  const token = mintToken('PERSON');
  field.value = token;

  field.dispatchEvent(new doc.defaultView!.Event('focusin', { bubbles: true }));
  assert.equal(surface.lastMount?.mode, 'reveal');
  assert.equal(surface.lastMount?.token, token);
  assert.equal(field.style.visibility, '', 'a read-only reveal does not hide the field');
  revealer.detach();
});

test('focusing a field holding ordinary text reveals nothing', () => {
  const { doc, surface, revealer } = page('<input id="f" value="Anna Meier">');
  const field = doc.querySelector<HTMLInputElement>('#f')!;
  field.dispatchEvent(new doc.defaultView!.Event('focusin', { bubbles: true }));
  assert.equal(surface.lastMount, undefined);
  revealer.detach();
});

test('blurring tears down a reveal, but never a clone mid-decision', () => {
  const { doc, surface, revealer } = page('<input id="a"><input id="b">');
  const a = doc.querySelector<HTMLInputElement>('#a')!;
  a.value = mintToken('PERSON');

  a.dispatchEvent(new doc.defaultView!.Event('focusin', { bubbles: true }));
  assert.ok(revealer.anchor);
  a.dispatchEvent(new doc.defaultView!.Event('focusout', { bubbles: true }));
  assert.equal(revealer.anchor, null);

  // A clone has a declassification decision to make on its own blur (§8.5).
  const b = doc.querySelector<HTMLInputElement>('#b')!;
  paste(doc, b, mintToken('IBAN'));
  b.dispatchEvent(new doc.defaultView!.Event('focusout', { bubbles: true }));
  assert.equal(revealer.anchor, b, 'the frame decides when a clone is finished');
  revealer.detach();
});

// --- what the frame is told -------------------------------------------------

test('the clone is told the constraints the page declared (SPEC §8.7.1)', () => {
  const { doc, surface, revealer } = page(
    '<label for="f">Empfänger IBAN</label>' +
      '<input id="f" pattern="CH.*" maxlength="26" required inputmode="numeric">',
  );
  const field = doc.querySelector<HTMLInputElement>('#f')!;
  paste(doc, field, mintToken('IBAN'));

  const mount = surface.lastMount!;
  assert.equal(mount.mode, 'clone');
  assert.equal(mount.constraints?.pattern, 'CH.*');
  assert.equal(mount.constraints?.maxLength, 26);
  assert.equal(mount.constraints?.required, true);
  assert.equal(mount.constraints?.inputMode, 'numeric');
  assert.equal(mount.ariaLabel, 'Empfänger IBAN', '<label for> cannot cross, the name can');
  assert.equal(mount.scopeId, 'destination:https://vendor.example');
  revealer.detach();
});

test('nothing sent to the frame is ever the value', () => {
  const { doc, surface, revealer } = page('<input id="f">');
  const field = doc.querySelector<HTMLInputElement>('#f')!;
  field.value = IBAN_VALUE;
  field.setSelectionRange(0, IBAN_VALUE.length);
  paste(doc, field, mintToken('IBAN'));

  const serialised = JSON.stringify(surface.sent);
  assert.ok(!serialised.includes('CH93'), 'the frame resolves the token itself');
  revealer.detach();
});

test('unmounting tells the frame to clear, not just to hide', () => {
  const { doc, surface, revealer } = page('<input id="f">');
  const field = doc.querySelector<HTMLInputElement>('#f')!;
  paste(doc, field, mintToken('IBAN'));
  revealer.unmount();

  assert.equal(surface.sent.at(-1)?.type, 'unmount');
  assert.equal(surface.boxes.at(-1), null, 'and to stop drawing');
  revealer.detach();
});

test('moving to a second field unmounts the first', () => {
  const { doc, revealer } = page('<input id="a"><input id="b">');
  const a = doc.querySelector<HTMLInputElement>('#a')!;
  const b = doc.querySelector<HTMLInputElement>('#b')!;
  paste(doc, a, mintToken('IBAN'));
  paste(doc, b, mintToken('PERSON'));

  assert.equal(revealer.anchor, b);
  assert.equal(a.style.visibility, '', 'the first field is not left invisible');
  revealer.detach();
});

// --- helpers ----------------------------------------------------------------

test('the native setter is used, so a page-patched one cannot intercept', () => {
  const doc = domFrom('<input id="f">');
  const field = doc.querySelector<HTMLInputElement>('#f')!;
  let intercepted: string | null = null;
  // What a hostile or merely framework-heavy page might have done.
  Object.defineProperty(field, 'value', {
    set: (v: string) => void (intercepted = v),
    get: () => '',
    configurable: true,
  });

  setFieldValue(field, 'ANM1-IBAN-K3F9QW2MX7VBNC4H8');
  assert.equal(intercepted, null, 'the own-property setter must be bypassed');
});

test('setting the value fires the events a framework listens for', () => {
  const doc = domFrom('<input id="f">');
  const field = doc.querySelector<HTMLInputElement>('#f')!;
  const seen: string[] = [];
  for (const type of ['input', 'change']) field.addEventListener(type, () => seen.push(type));
  setFieldValue(field, 'x');
  assert.deepEqual(seen, ['input', 'change']);
});

test('the accessible name falls back through every route it has', () => {
  const doc = domFrom(
    '<input id="a" aria-label="Direct">' +
      '<span id="n">By reference</span><input id="b" aria-labelledby="n">' +
      '<label for="c">For attribute</label><input id="c">' +
      '<label>Wrapping <input id="d"></label>' +
      '<input id="e" placeholder="Placeholder">' +
      '<input id="f">',
  );
  const name = (id: string) => accessibleName(doc.querySelector<HTMLInputElement>(`#${id}`)!);
  assert.equal(name('a'), 'Direct');
  assert.equal(name('b'), 'By reference');
  assert.equal(name('c'), 'For attribute');
  assert.equal(name('d'), 'Wrapping');
  assert.equal(name('e'), 'Placeholder');
  assert.equal(name('f'), '');
});

test('full-replace covers empty and whole-selection, and nothing else', () => {
  const doc = domFrom('<input id="f" value="abcdef">');
  const field = doc.querySelector<HTMLInputElement>('#f')!;
  field.setSelectionRange(0, 6);
  assert.equal(isFullReplace(field), true);
  field.setSelectionRange(0, 3);
  assert.equal(isFullReplace(field), false);
  field.setSelectionRange(2, 2);
  assert.equal(isFullReplace(field), false);
  field.value = '';
  assert.equal(isFullReplace(field), true);
});

test('only single-value text inputs are eligible', () => {
  const doc = domFrom(
    '<input id="text"><input id="email" type="email"><input id="tel" type="tel">' +
      '<input id="pw" type="password"><input id="cb" type="checkbox">' +
      '<input id="file" type="file"><textarea id="ta"></textarea><div id="div"></div>',
  );
  const eligible = (id: string) => isTextInput(doc.querySelector(`#${id}`));
  for (const id of ['text', 'email', 'tel']) assert.equal(eligible(id), true, id);
  for (const id of ['pw', 'cb', 'file', 'ta', 'div']) assert.equal(eligible(id), false, id);
});

// --- mixed content: prose with tokens in it (SPEC §8.10) --------------------

test('pasting prose with several tokens reveals it read-only, not as a clone', () => {
  const { doc, surface, revealer } = page('<input id="f">');
  const field = doc.querySelector<HTMLInputElement>('#f')!;
  const person = mintToken('PERSON');
  const iban = mintToken('IBAN');
  const pasted = `Kunde ${person}, IBAN ${iban}, bitte prüfen`;

  const state = paste(doc, field, pasted);
  assert.equal(state.prevented, true);
  assert.equal(field.value, pasted, 'prose and tokens both land in the field');
  assert.equal(surface.lastMount?.mode, 'reveal', 'N spans is not an editable case');
  assert.equal(surface.lastMount?.token, pasted, 'the frame is given the whole line');
  assert.equal(field.style.visibility, '', 'a read-only reveal does not hide the field');
  revealer.detach();
});

test('one bare token is still the editable clone', () => {
  const { doc, surface, revealer } = page('<input id="f">');
  const field = doc.querySelector<HTMLInputElement>('#f')!;
  const token = mintToken('IBAN');
  paste(doc, field, `  ${token}  `);
  assert.equal(surface.lastMount?.mode, 'clone');
  assert.equal(surface.lastMount?.token, token);
  revealer.detach();
});

test('one token with prose around it is a reveal, not a clone', () => {
  const { doc, surface, revealer } = page('<input id="f">');
  const field = doc.querySelector<HTMLInputElement>('#f')!;
  paste(doc, field, `IBAN ${mintToken('IBAN')}`);
  assert.equal(surface.lastMount?.mode, 'reveal', 'the prose is not ours to edit around');
  revealer.detach();
});

test('tokens mangled by a rich editor are written back clean (SPEC §8.10)', () => {
  const { doc, revealer } = page('<input id="f">');
  const field = doc.querySelector<HTMLInputElement>('#f')!;
  const token = mintToken('IBAN');
  // Lower case and a soft hyphen in the payload: still the same token (§6.4).
  const mangled = token.toLowerCase().replace(/(.{20})/, '$1­');

  paste(doc, field, `Ref ${mangled} ok`);
  assert.equal(field.value, `Ref ${token} ok`, 'the next reader can resolve it too');
  revealer.detach();
});

test('prose with no tokens in it is not intercepted', () => {
  const { doc, surface, revealer } = page('<input id="f">');
  const field = doc.querySelector<HTMLInputElement>('#f')!;
  const state = paste(doc, field, 'Kunde Anna Meier, bitte prüfen');
  assert.equal(state.prevented, false);
  assert.deepEqual(surface.sent, []);
  revealer.detach();
});

test('focusing a field holding prose with tokens reveals it', () => {
  const { doc, surface, revealer } = page('<input id="f">');
  const field = doc.querySelector<HTMLInputElement>('#f')!;
  field.value = `Konto ${mintToken('IBAN')} von ${mintToken('PERSON')}`;
  field.dispatchEvent(new doc.defaultView!.Event('focusin', { bubbles: true }));

  assert.equal(surface.lastMount?.mode, 'reveal');
  assert.equal(surface.lastMount?.token, field.value);
  revealer.detach();
});

test('canonicalising leaves everything between the tokens alone', () => {
  const a = mintToken('IBAN');
  const b = mintToken('PERSON');
  const text = `  Kunde ${b.toLowerCase()}, IBAN ${a}, Ende.  `;
  const out = canonicaliseTokens(text, scanTokens(text));
  assert.equal(out, `  Kunde ${b}, IBAN ${a}, Ende.  `);
});

// --- what the frame draws for mixed content (SPEC §8.10) --------------------

const value = (v: string, cls = 'IBAN'): Resolution => ({
  kind: 'value',
  value: v,
  cls: cls as never,
  expiresAt: 0,
  expiringSoon: false,
});

test('the prose between tokens is carried through byte for byte', () => {
  const a = mintToken('PERSON');
  const b = mintToken('IBAN');
  const text = `Kunde ${a}, IBAN ${b}, bitte prüfen`;
  const segments = revealSegments(
    text,
    new Map([
      [a, value('Anna Meier', 'PERSON')],
      [b, value(IBAN_VALUE)],
    ]),
  );

  assert.deepEqual(
    segments.map((s) => [s.kind, s.text]),
    [
      ['text', 'Kunde '],
      ['value', 'Anna Meier'],
      ['text', ', IBAN '],
      ['value', IBAN_VALUE],
      ['text', ', bitte prüfen'],
    ],
  );
});

test('a token that does not resolve says why in place, without losing the rest', () => {
  const alive = mintToken('IBAN');
  const gone = mintToken('PERSON');
  const text = `${alive} von ${gone}`;
  const segments = revealSegments(
    text,
    new Map<string, Resolution | null>([
      [alive, value(IBAN_VALUE)],
      [gone, { kind: 'foreign', cls: 'PERSON' }],
    ]),
  );

  assert.equal(segments[0]!.kind, 'value');
  assert.equal(segments[0]!.text, IBAN_VALUE, 'the live one still reads');
  assert.equal(segments[2]!.kind, 'dead');
  assert.match(segments[2]!.text, /another vault/);
});

test('an unreachable vault is not rendered as an answer', () => {
  const token = mintToken('IBAN');
  const segments = revealSegments(token, new Map([[token, null]]));
  assert.deepEqual(segments, [{ kind: 'dead', text: '[vault unreachable]' }]);
});

test('every dead arm of §6.7 renders as something a reader can act on', () => {
  const token = mintToken('IBAN');
  const say = (r: Resolution) => revealSegments(token, new Map([[token, r]]))[0]!.text;

  assert.match(
    say({
      kind: 'tombstone',
      tombstone: {
        token, cls: 'IBAN', mintedAt: 0, endedAt: 0,
        state: 'revoked', sourceScope: 'source:crm.example',
      },
    }),
    /revoked/,
  );
  assert.match(
    say({
      kind: 'tombstone',
      tombstone: {
        token, cls: 'IBAN', mintedAt: 0, endedAt: 0,
        state: 'expired', sourceScope: 'source:crm.example',
      },
    }),
    /expired.*crm\.example|crm\.example.*expired/,
  );
  assert.match(say({ kind: 'damaged', cls: 'IBAN' }), /damaged/);
  assert.match(say({ kind: 'foreign', cls: 'IBAN' }), /another vault/);
});

test('one value quoted twice renders twice from one answer', () => {
  const token = mintToken('PERSON');
  const segments = revealSegments(`${token} und ${token}`, new Map([[token, value('Anna Meier', 'PERSON')]]));
  assert.equal(segments.filter((s) => s.kind === 'value').length, 2);
});

test('text with no tokens comes back untouched', () => {
  assert.deepEqual(revealSegments('nothing here', new Map()), [
    { kind: 'text', text: 'nothing here' },
  ]);
});

test('a value near expiry carries its date so the reader can see the clock', () => {
  const token = mintToken('IBAN');
  const segments = revealSegments(
    token,
    new Map<string, Resolution>([
      [token, { kind: 'value', value: IBAN_VALUE, cls: 'IBAN', expiresAt: 1234, expiringSoon: true }],
    ]),
  );
  assert.equal(segments[0]!.kind === 'value' && segments[0]!.expiresAt, 1234);
});
