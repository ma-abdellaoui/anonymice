/**
 * The adversarial half of the spike.
 *
 * ProseMirror does not only *write* the DOM — on a mutation it did not make
 * (IME composition, autocorrect, spellcheck, drag-and-drop) it reparses a region
 * of the DOM back into the model. If the widget's plaintext survived that read,
 * it would enter the model and ship to the destination, and the whole design
 * would be worse than useless: it would leak exactly when the user is typing.
 *
 * prosemirror-view's `ruleFromNode` consults `dom.pmViewDesc`, and
 * `WidgetViewDesc.parseRule()` returns `{ ignore: true }`. These tests check
 * that the marker is actually present on our chip, and what happens when it is
 * not.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DOMParser } from 'prosemirror-model';
import { editor, schema, IBAN_TOKEN, IBAN_VALUE } from './harness.ts';

/**
 * What prosemirror-view installs on the reparse (dist/index.js `ruleFromNode`).
 *
 * `ruleFromNode` is a real `ParseOptions` field at runtime but is absent from
 * prosemirror-model's published types, so the cast below is deliberate. We only
 * need it to *mimic* the view in a test; production code never passes it — the
 * view applies its own.
 */
const ruleFromNode = (dom: Node): { ignore: true } | null => {
  const desc = (dom as { pmViewDesc?: { parseRule(): unknown } }).pmViewDesc;
  return desc ? (desc.parseRule() as { ignore: true } | null) : null;
};

type ParseOpts = Parameters<InstanceType<typeof DOMParser>['parse']>[1];
const mimicView = (): ParseOpts =>
  ({ ruleFromNode, preserveWhitespace: true }) as unknown as ParseOpts;

test('the chip carries the pmViewDesc marker that makes reparse skip it', () => {
  const { view } = editor([`Account ${IBAN_TOKEN} for Q3.`]);
  const chip = view.dom.querySelector('[data-anonymice="reveal"]')!;
  const desc = (chip as { pmViewDesc?: { parseRule(): unknown } }).pmViewDesc;
  assert.ok(desc, 'ProseMirror owns the widget node');
  assert.deepEqual(desc!.parseRule(), { ignore: true }, 'and declares it unparseable');
});

test('a reparse of the live DOM recovers the token, never the value', () => {
  const { view, window } = editor([`Account ${IBAN_TOKEN} for Q3.`]);

  const parsed = DOMParser.fromSchema(schema).parse(view.dom, mimicView());

  assert.ok(parsed.textContent.includes(IBAN_TOKEN), 'the concealed token reads back');
  assert.ok(!parsed.textContent.includes(IBAN_VALUE), 'the rendered value does not');
  assert.ok(!JSON.stringify(parsed.toJSON()).includes(IBAN_VALUE));
  void window;
});

test('WITHOUT the marker the plaintext is pulled straight into the model', () => {
  const { view } = editor([`Account ${IBAN_TOKEN} for Q3.`]);

  // Exactly what happens if anything strips `pmViewDesc` — a page script that
  // clones and re-inserts the editor subtree, or a sanitiser that unwraps spans.
  const naive = DOMParser.fromSchema(schema).parse(view.dom, { preserveWhitespace: true });

  assert.ok(
    naive.textContent.includes(IBAN_VALUE),
    'this is the failure mode the marker is holding back',
  );
});

test('text moved out of the chip is no longer protected', () => {
  const { view } = editor([`Account ${IBAN_TOKEN} for Q3.`]);
  const chip = view.dom.querySelector('[data-anonymice="reveal"]')! as HTMLElement;

  // Unwrap the chip, as an over-eager sanitiser or a DOM-mangling extension might.
  const text = chip.ownerDocument.createTextNode(chip.textContent ?? '');
  chip.parentNode!.replaceChild(text, chip);

  const parsed = DOMParser.fromSchema(schema).parse(view.dom, mimicView());
  assert.ok(
    parsed.textContent.includes(IBAN_VALUE),
    'the marker protects the node, not the characters',
  );
});

/**
 * The tests above mimic `ruleFromNode`. This one drives prosemirror-view's own
 * `readDOMChange` by mutating the DOM behind its back, which is what autocorrect
 * and IME actually do, and lets its `DOMObserver` flush.
 */
test('the real readDOMChange path leaves the model token-only', async () => {
  const { view } = editor([`Account ${IBAN_TOKEN} for Q3.`]);

  // Find the visible trailing text node and "autocorrect" it, exactly as the
  // browser would: rewrite the character data, tell nobody.
  const walker = view.dom.ownerDocument.createTreeWalker(view.dom, 4 /* TEXT */);
  let tail: Text | null = null;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (node.data.includes('for Q3')) tail = node;
  }
  assert.ok(tail, 'found the text node the user is typing in');
  tail!.data = tail!.data.replace('Q3', 'Q4');

  // Let the MutationObserver fire and ProseMirror reconcile.
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.ok(view.state.doc.textContent.includes('Q4'), 'the edit reached the model');
  assert.ok(
    !JSON.stringify(view.state.doc.toJSON()).includes(IBAN_VALUE),
    'and it did not drag the revealed value in with it',
  );
  assert.ok(view.state.doc.textContent.includes(IBAN_TOKEN), 'the token survived the reparse');
});
