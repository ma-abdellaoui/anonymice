import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachDomReveal, revealIn, tokensInDom } from '../src/content/dom-reveal.ts';
import { domFrom } from './helpers.ts';

const TOKEN = 'ANM1-IBAN-KH9YRPPR6V0BX38ZS';
const VALUE = 'CH93 0076 2011 6238 5295 7';
const vault: Record<string, string> = { [TOKEN]: VALUE };
const valueFor = (t: string): string | undefined => vault[t];

/**
 * `caretIsIn` needs both halves — `activeElement` *and* a focused window — so a
 * test that only sets one is not describing a caret. jsdom reports `hasFocus()`
 * false, which is the blurred-window case, so it must be stated to simulate a
 * caret that is actually live.
 */
function setCaret(doc: Document, el: Element | null): void {
  Object.defineProperty(doc, 'activeElement', { value: el ?? doc.body, configurable: true });
  Object.defineProperty(doc, 'hasFocus', { value: () => el !== null, configurable: true });
}

test('a token rendered by the server becomes a value', () => {
  const doc = domFrom(`<p id="a">Konto ${TOKEN} bestätigt.</p>`);
  assert.equal(revealIn(doc, { valueFor }), 1);
  assert.equal(doc.querySelector('#a')!.textContent, `Konto ${VALUE} bestätigt.`);
});

test('an unresolvable token is left exactly as it is, and reported', () => {
  const stranger = 'ANM1-PERSON-KH9YRPPR6V0BX38ZS';
  const doc = domFrom(`<p id="a">${stranger}</p>`);
  const seen: string[][] = [];
  assert.equal(revealIn(doc, { valueFor, onUnresolved: (t) => seen.push(t) }), 0);
  assert.equal(doc.querySelector('#a')!.textContent, stranger);
  assert.deepEqual(seen, [[stranger]]);
});

test('script and style are never rewritten', () => {
  const doc = domFrom(`<script id="s">var x = "${TOKEN}";</script><p>${TOKEN}</p>`);
  revealIn(doc, { valueFor });
  assert.ok(doc.querySelector('#s')!.textContent!.includes(TOKEN), 'script left alone');
  assert.ok(doc.querySelector('p')!.textContent!.includes(VALUE), 'prose rewritten');
});

test('our own UI is skipped', () => {
  const doc = domFrom(`<div data-anonymice="pill"><span>${TOKEN}</span></div>`);
  assert.equal(revealIn(doc, { valueFor }), 0);
});

test('a focused editable is left alone — rewriting moves the caret', () => {
  const doc = domFrom(`<div id="e" contenteditable="true">${TOKEN}</div>`);
  const el = doc.getElementById('e')!;
  Object.defineProperty(el, 'isContentEditable', { value: true, configurable: true });
  setCaret(doc, el);
  assert.equal(revealIn(doc, { valueFor }), 0);

  setCaret(doc, null);
  assert.equal(revealIn(doc, { valueFor }), 1, 'and rewritten once it is not focused');
});

test('a token pasted into a focused editable is revealed when focus leaves', async () => {
  const doc = domFrom(`<div id="e" contenteditable="true"></div><input id="other">`);
  const el = doc.getElementById('e')!;
  Object.defineProperty(el, 'isContentEditable', { value: true, configurable: true });
  setCaret(doc, el);

  attachDomReveal(doc, { valueFor });
  // The paste itself: a mutation, but into a node holding the caret.
  el.textContent = TOKEN;
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(el.textContent, TOKEN, 'left alone while the caret is in it');

  setCaret(doc, null);
  el.dispatchEvent(new doc.defaultView!.Event('focusout', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(el.textContent, VALUE, 'and revealed once focus moves away');
});

test('a blurred window does not count as a live caret (Confluence/DevTools)', () => {
  const doc = domFrom(`<div id="e" contenteditable="true">${TOKEN}</div>`);
  const el = doc.getElementById('e')!;
  Object.defineProperty(el, 'isContentEditable', { value: true, configurable: true });

  // Exactly what the Confluence console showed: ProseMirror had dropped its own
  // `ProseMirror-focused` class, but `activeElement` still named the editor
  // because focus had gone to DevTools rather than to another element.
  Object.defineProperty(doc, 'activeElement', { value: el, configurable: true });
  Object.defineProperty(doc, 'hasFocus', { value: () => false, configurable: true });

  assert.equal(revealIn(doc, { valueFor }), 1, 'no window focus means no caret to protect');
  assert.equal(el.textContent, VALUE);
});

test('detach stops the focusout pass too', async () => {
  const doc = domFrom(`<div id="e" contenteditable="true">${TOKEN}</div>`);
  const el = doc.getElementById('e')!;
  Object.defineProperty(el, 'isContentEditable', { value: true, configurable: true });
  setCaret(doc, el);

  const handle = attachDomReveal(doc, { valueFor });
  handle.detach();

  setCaret(doc, null);
  el.dispatchEvent(new doc.defaultView!.Event('focusout', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(el.textContent, TOKEN);
});

test('tokensInDom is what the bridge asks the vault about', () => {
  const doc = domFrom(`<p>${TOKEN}</p><p>${TOKEN}</p><script>ANM1-IBAN-KH9YRPPR6V0BX38ZS</script>`);
  assert.deepEqual(tokensInDom(doc), [TOKEN], 'deduped, and not from a script');
});

test('content added later is revealed too', async () => {
  const doc = domFrom('<div id="root"></div>');
  attachDomReveal(doc, { valueFor });
  doc.getElementById('root')!.innerHTML = `<p id="late">${TOKEN}</p>`;
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(doc.querySelector('#late')!.textContent, VALUE);
});

test('re-running after the cache warms turns a shown token into a value', () => {
  const cache = new Map<string, string>();
  const doc = domFrom(`<p id="a">${TOKEN}</p>`);
  const handle = attachDomReveal(doc, { valueFor: (t) => cache.get(t) });
  assert.equal(doc.querySelector('#a')!.textContent, TOKEN, 'nothing to show yet');

  cache.set(TOKEN, VALUE);
  handle.rerun();
  assert.equal(doc.querySelector('#a')!.textContent, VALUE);
});
