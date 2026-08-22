/**
 * Taking the paste itself — SPEC §10.9.4.
 *
 * The property under test is that the token never enters the editor: the event
 * is cancelled and the *editor* inserts the value, so nothing downstream has to
 * rewrite a live DOM or move a caret. Everything here is synchronous on purpose
 * — a paste is a user gesture, and a handler that awaits has already lost it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachDomReveal } from '../src/content/dom-reveal.ts';
import { domFrom } from './helpers.ts';

const TOKEN = 'ANM1-IBAN-KH9YRPPR6V0BX38ZS';
const VALUE = 'CH93 0076 2011 6238 5295 7';
const OTHER = 'ANM1-PERSON-KH9YRPPR6V0BX38ZS';

interface Fired {
  defaultPrevented: boolean;
  inserted: string | null;
  revealed: number | null;
  unresolved: string[];
}

/**
 * jsdom has neither ClipboardEvent nor execCommand, so both are supplied here.
 * `execCommand` records rather than inserts: what matters is *what* the editor
 * was asked to insert, not jsdom's idea of contenteditable.
 */
function paste(
  html: string,
  clipboard: Record<string, string>,
  vault: Record<string, string>,
  opts: { execCommand?: boolean; selection?: boolean } = {},
): Fired {
  const doc = domFrom(html);
  const el = doc.getElementById('e')!;
  Object.defineProperty(el, 'isContentEditable', { value: true, configurable: true });

  const fired: Fired = { defaultPrevented: false, inserted: null, revealed: null, unresolved: [] };

  if (opts.execCommand !== false) {
    Object.defineProperty(doc, 'execCommand', {
      configurable: true,
      value: (command: string, _ui: boolean, text: string) => {
        assert.equal(command, 'insertText');
        fired.inserted = text;
        return true;
      },
    });
  }
  Object.defineProperty(doc.defaultView!, 'getSelection', {
    configurable: true,
    value: () => ({ rangeCount: opts.selection === false ? 0 : 1 }),
  });

  attachDomReveal(doc, {
    valueFor: (t) => vault[t],
    onUnresolved: (t) => fired.unresolved.push(...t),
    onPasteRevealed: (n) => void (fired.revealed = n),
  });

  const event = new doc.defaultView!.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: { getData: (type: string) => clipboard[type] ?? '' },
  });
  Object.defineProperty(event, 'target', { value: el });
  Object.defineProperty(event, 'stopImmediatePropagation', { value: () => {} });
  el.dispatchEvent(event);

  fired.defaultPrevented = event.defaultPrevented;
  return fired;
}

const editor = '<div id="e" contenteditable="true"></div>';

test('a resolvable paste is taken, and the editor is handed the value', () => {
  const fired = paste(editor, { 'text/plain': `IBAN ${TOKEN} ok` }, { [TOKEN]: VALUE });
  assert.equal(fired.defaultPrevented, true, 'the token must not reach the editor');
  assert.equal(fired.inserted, `IBAN ${VALUE} ok`);
  assert.equal(fired.revealed, 1);
});

test('an unresolvable paste is declined and the vault warmed instead', () => {
  const fired = paste(editor, { 'text/plain': TOKEN }, {});
  assert.equal(fired.defaultPrevented, false, 'the paste goes through as a token');
  assert.equal(fired.inserted, null);
  assert.deepEqual(fired.unresolved, [TOKEN]);
});

test('a half-resolvable paste is declined whole — never half values, half tokens', () => {
  const fired = paste(editor, { 'text/plain': `${TOKEN} and ${OTHER}` }, { [TOKEN]: VALUE });
  assert.equal(fired.defaultPrevented, false);
  assert.equal(fired.inserted, null);
  assert.deepEqual(fired.unresolved, [OTHER], 'and the missing half is warmed');
});

test('a paste with no tokens is not ours', () => {
  const fired = paste(editor, { 'text/plain': 'just some prose' }, { [TOKEN]: VALUE });
  assert.equal(fired.defaultPrevented, false);
  assert.equal(fired.inserted, null);
});

test('a rich-flavour paste is left alone rather than flattened', () => {
  const fired = paste(
    editor,
    { 'text/plain': TOKEN, 'text/html': `<b>${TOKEN}</b>` },
    { [TOKEN]: VALUE },
  );
  assert.equal(fired.defaultPrevented, false, 'dropping the formatting is not ours to do');
  assert.equal(fired.inserted, null);
});

test('a paste into a plain field is reveal.ts\'s, not ours', () => {
  const doc = domFrom('<input id="f">');
  const field = doc.getElementById('f')!;
  let taken = false;
  attachDomReveal(doc, { valueFor: () => VALUE, onPasteRevealed: () => void (taken = true) });

  const event = new doc.defaultView!.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { getData: () => TOKEN } });
  Object.defineProperty(event, 'target', { value: field });
  field.dispatchEvent(event);

  assert.equal(event.defaultPrevented, false);
  assert.equal(taken, false);
});

test('no way to insert means the paste is not taken, rather than eaten', () => {
  const fired = paste(editor, { 'text/plain': TOKEN }, { [TOKEN]: VALUE }, { execCommand: false });
  assert.equal(fired.defaultPrevented, false, 'cancelling without inserting loses the paste');
  assert.equal(fired.revealed, null);
});

test('no selection to insert into is the same refusal', () => {
  const fired = paste(editor, { 'text/plain': TOKEN }, { [TOKEN]: VALUE }, { selection: false });
  assert.equal(fired.defaultPrevented, false);
  assert.equal(fired.revealed, null);
});
