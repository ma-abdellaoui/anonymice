/**
 * Fields — the gap the first real Confluence run found.
 *
 * Confluence's page title is a `<textarea>`. Its content is a *value*, not a
 * text node, so the text walk steps straight over it: every token on the page
 * resolves except the one in the title, which is exactly the symptom that was
 * reported (SPEC §10.9.4).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { revealFields, revealIn, tokensInDom } from '../src/content/dom-reveal.ts';
import { domFrom } from './helpers.ts';

const TOKEN = 'ANM1-IBAN-KH9YRPPR6V0BX38ZS';
const VALUE = 'CH93 0076 2011 6238 5295 7';
const valueFor = (t: string): string | undefined => (t === TOKEN ? VALUE : undefined);

test('a token in a textarea value is revealed', () => {
  const doc = domFrom('<textarea id="t"></textarea>');
  const field = doc.getElementById('t') as HTMLTextAreaElement;
  field.value = `Konto ${TOKEN}`;

  assert.equal(revealIn(doc, { valueFor }), 0, 'the text walk cannot see it');
  assert.equal(revealFields(doc, { valueFor }), 1);
  assert.equal(field.value, `Konto ${VALUE}`);
});

test('a token in a text input is revealed', () => {
  const doc = domFrom('<input id="i" type="text">');
  const field = doc.getElementById('i') as HTMLInputElement;
  field.value = TOKEN;
  assert.equal(revealFields(doc, { valueFor }), 1);
  assert.equal(field.value, VALUE);
});

test('an input event fires, so a framework notices', () => {
  const doc = domFrom('<input id="i" type="text">');
  const field = doc.getElementById('i') as HTMLInputElement;
  field.value = TOKEN;
  const seen: string[] = [];
  field.addEventListener('input', () => seen.push('input'));
  field.addEventListener('change', () => seen.push('change'));
  revealFields(doc, { valueFor });
  assert.deepEqual(seen, ['input', 'change']);
});

test('a password field is never touched', () => {
  const doc = domFrom('<input id="p" type="password">');
  const field = doc.getElementById('p') as HTMLInputElement;
  field.value = TOKEN;
  assert.equal(revealFields(doc, { valueFor }), 0);
  assert.equal(field.value, TOKEN);
});

test('a focused field is left alone — rewriting moves the caret', () => {
  const doc = domFrom('<textarea id="t"></textarea>');
  const field = doc.getElementById('t') as HTMLTextAreaElement;
  field.value = TOKEN;
  Object.defineProperty(doc, 'activeElement', { value: field, configurable: true });
  Object.defineProperty(doc, 'hasFocus', { value: () => true, configurable: true });
  assert.equal(revealFields(doc, { valueFor }), 0);

  Object.defineProperty(doc, 'activeElement', { value: doc.body, configurable: true });
  Object.defineProperty(doc, 'hasFocus', { value: () => false, configurable: true });
  assert.equal(revealFields(doc, { valueFor }), 1);
});

test('an unresolvable token in a field is reported so it can be warmed', () => {
  const other = 'ANM1-PERSON-TEKEGRP8XGW95ZV56';
  const doc = domFrom('<textarea id="t"></textarea>');
  (doc.getElementById('t') as HTMLTextAreaElement).value = other;
  const seen: string[][] = [];
  revealFields(doc, { valueFor, onUnresolved: (t) => seen.push(t) });
  assert.deepEqual(seen, [[other]]);
});

test('tokensInDom includes field values, or the vault is never asked', () => {
  const doc = domFrom('<textarea id="t"></textarea><p>nothing here</p>');
  (doc.getElementById('t') as HTMLTextAreaElement).value = TOKEN;
  assert.deepEqual(tokensInDom(doc), [TOKEN]);
});

test('the real reported tokens round-trip through a field', () => {
  const person = 'ANM1-PERSON-TEKEGRP8XGW95ZV56';
  const ahv = 'ANM1-AHV-TCYSX49BYJFG0NZF6';
  const vault: Record<string, string> = { [person]: 'Anna Meier', [ahv]: '756.1234.5678.97' };
  const doc = domFrom('<textarea id="t"></textarea>');
  const field = doc.getElementById('t') as HTMLTextAreaElement;
  field.value = `Annotated by the site   Name   ${person}   AHV-Nummer   ${ahv}`;

  assert.deepEqual(tokensInDom(doc).sort(), [ahv, person].sort());
  revealFields(doc, { valueFor: (t) => vault[t] });
  assert.equal(field.value, 'Annotated by the site   Name   Anna Meier   AHV-Nummer   756.1234.5678.97');
});
