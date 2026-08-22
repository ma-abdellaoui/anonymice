/**
 * The blocker, pinned as an assertion.
 *
 * The decoration mechanism works (see model.test.ts, reparse.test.ts). Getting
 * it *into* an editor we do not own is the open problem, and it reduces to one
 * question: can we reach the `EditorView` object from the DOM?
 *
 * We need the object, not the node — a plugin is added with
 * `view.updateState(view.state.reconfigure({ plugins: [...] }))`.
 *
 * Today the answer is no: `view.dom.pmViewDesc` is a `NodeViewDesc` constructed
 * without a view reference (prosemirror-view dist/index.js:1519). If a future
 * version adds one, this test fails and the Confluence path opens up — which is
 * why it is written as an assertion rather than a note in the README.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { editor, IBAN_TOKEN } from './harness.ts';

type Desc = Record<string, unknown>;

test('the EditorView is NOT reachable from its own DOM node', () => {
  const { view } = editor([`Account ${IBAN_TOKEN} for Q3.`]);
  const desc = (view.dom as unknown as { pmViewDesc?: Desc }).pmViewDesc;
  assert.ok(desc, 'the root node is owned by ProseMirror');

  assert.deepEqual(
    Object.keys(desc!).sort(),
    [
      'children',
      'contentDOM',
      'dirty',
      'dom',
      'innerDeco',
      'node',
      'nodeDOM',
      'outerDeco',
      'parent',
    ],
    'if this shape changed, re-check whether a view reference appeared',
  );

  assert.ok(!('view' in desc!), 'no back-reference to the EditorView');
  const holdsState = Object.values(desc!).some(
    (v) => v && typeof v === 'object' && 'state' in (v as object),
  );
  assert.ok(!holdsState, 'and nothing hanging off it holds an EditorState either');
});

test('the widget desc is equally a dead end', () => {
  const { view } = editor([`Account ${IBAN_TOKEN} for Q3.`]);
  const chip = view.dom.querySelector('[data-anonymice="reveal"]')!;
  const desc = (chip as unknown as { pmViewDesc?: Desc }).pmViewDesc;
  assert.ok(desc, 'our chip is owned by ProseMirror — this is what protects it');
  assert.ok(!('view' in desc!), 'but it is not a route to the view either');
});
