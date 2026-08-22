import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TextSelection } from 'prosemirror-state';
import { DOMSerializer } from 'prosemirror-model';
import { sendableSteps } from 'prosemirror-collab';
import { editor, overTheWire, IBAN_TOKEN, IBAN_VALUE } from './harness.ts';

test('the user sees the value; the model holds only the token', () => {
  const { view } = editor([`Account ${IBAN_TOKEN} for Q3.`]);

  // What the page renders — this is the part §8.1 said was impossible.
  assert.ok(view.dom.textContent?.includes(IBAN_VALUE), 'plaintext is visible in the DOM');

  // What Atlassian would store.
  assert.ok(!overTheWire(view).includes(IBAN_VALUE), 'no plaintext in the document model');
  assert.ok(overTheWire(view).includes(IBAN_TOKEN), 'the token is what the model carries');
  assert.ok(!view.state.doc.textContent.includes(IBAN_VALUE), 'no plaintext in doc text');
});

test('the concealed token is still in the DOM, just not painted', () => {
  const { view } = editor([`Account ${IBAN_TOKEN} for Q3.`]);
  const hidden = view.dom.querySelector('[data-anonymice="conceal"]');
  assert.ok(hidden, 'the token span is decorated, not removed');
  assert.match((hidden as HTMLElement).getAttribute('style') ?? '', /display:\s*none/);
});

test('collab steps carry no plaintext when editing around the token', () => {
  const { view } = editor([`Account ${IBAN_TOKEN} for Q3.`]);

  // Type at the very start of the paragraph, before the token.
  view.dispatch(view.state.tr.insertText('Ref 12 — ', 1));
  // And after it.
  const end = view.state.doc.content.size - 1;
  view.dispatch(view.state.tr.insertText(' (confirmed)', end));

  const sendable = sendableSteps(view.state);
  assert.ok(sendable, 'there are steps to ship');
  const wire = JSON.stringify(sendable!.steps.map((s) => s.toJSON()));
  assert.ok(!wire.includes(IBAN_VALUE), 'no plaintext in the transaction steps');
  assert.ok(!overTheWire(view).includes(IBAN_VALUE), 'still none in the model');
  assert.ok(view.dom.textContent?.includes(IBAN_VALUE), 'and the user can still read it');
});

test('deleting the token removes the reveal rather than stranding it', () => {
  const { view } = editor([`Account ${IBAN_TOKEN} for Q3.`]);
  const at = view.state.doc.textContent.indexOf(IBAN_TOKEN) + 1;
  view.dispatch(view.state.tr.delete(at, at + IBAN_TOKEN.length));

  assert.ok(!view.dom.textContent?.includes(IBAN_VALUE), 'the value stops being rendered');
  assert.ok(!overTheWire(view).includes(IBAN_TOKEN));
});

test('a token not in the vault renders as itself', () => {
  const stranger = 'ANM1-PERSON-A1B2C3D4E5F6G7H8J';
  const { view } = editor([`Docs example: ${stranger}`]);
  assert.equal(view.dom.querySelector('[data-anonymice="reveal"]'), null, 'no chip');
  assert.ok(view.dom.textContent?.includes(stranger), 'the token shows through');
});

test('copying out of the editor yields the token, not the value', () => {
  const { view, window } = editor([`Account ${IBAN_TOKEN} for Q3.`]);
  const from = 1;
  const to = view.state.doc.content.size - 1;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));

  const slice = view.state.selection.content();
  const serializer = DOMSerializer.fromSchema(view.state.schema);
  const fragment = serializer.serializeFragment(slice.content, { document: window.document });
  const holder = window.document.createElement('div');
  holder.appendChild(fragment);

  assert.ok(holder.textContent?.includes(IBAN_TOKEN), 'clipboard gets the token');
  assert.ok(!holder.textContent?.includes(IBAN_VALUE), 'clipboard gets no plaintext');
});

test('the frame variant puts no plaintext in the page at all', () => {
  const { view } = editor([`Account ${IBAN_TOKEN} for Q3.`], {
    render: 'frame',
    frameUrl: 'chrome-extension://abc/reveal.html',
  });

  assert.ok(!view.dom.textContent?.includes(IBAN_VALUE), 'no plaintext anywhere in the DOM');
  const frame = view.dom.querySelector('iframe[data-anonymice="reveal-frame"]');
  assert.ok(frame, 'an extension-origin frame is mounted inline');
  assert.match((frame as HTMLIFrameElement).getAttribute('src') ?? '', /reveal\.html#ANM1-IBAN-/);
  assert.ok(!overTheWire(view).includes(IBAN_VALUE));
});
