/**
 * Walking back the "not reachable" conclusion.
 *
 * `attachment.test.ts` shows ProseMirror exposes no route from a *plain*
 * document's DOM to the `EditorView`. But a real app is not a plain document.
 * Any node rendered through a custom node view gets a `CustomNodeViewDesc`, and
 * that desc keeps the app's own NodeView object as `.spec`
 * (prosemirror-view dist/index.js:1589).
 *
 * ProseMirror does not put the view on `.spec` — but the app almost always does,
 * because the nodeView signature is `(node, view, getPos)` and an implementation
 * needs `view.dispatch` to do anything. Atlassian's `ReactNodeView` in
 * `@atlaskit/editor-common` follows exactly this pattern.
 *
 * This test models that app and checks whether the view leaks out. The point is
 * to characterise the route honestly, not to endorse it: it depends on someone
 * else's private field, so it is a maintenance liability, not an interface.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Schema } from 'prosemirror-model';
import { EditorState, Plugin } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { JSDOM } from 'jsdom';
import { tokenReveal } from '../src/token-decorations.ts';
import { resolve, IBAN_TOKEN, IBAN_VALUE } from './harness.ts';

/** A schema with a leaf node an app would render through a custom node view. */
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block', toDOM: () => ['p', 0] },
    text: { group: 'inline' },
    mention: {
      inline: true,
      group: 'inline',
      atom: true,
      attrs: { id: { default: '' } },
      toDOM: (n: PMNode) => ['span', { 'data-mention': n.attrs.id as string }],
    },
  },
});

/** Stands in for @atlaskit/editor-common's ReactNodeView. */
class AppNodeView {
  dom: HTMLElement;
  // The field that matters. Every real nodeView keeps this.
  view: EditorView;
  constructor(node: PMNode, view: EditorView, doc: Document) {
    this.view = view;
    this.dom = doc.createElement('span');
    this.dom.setAttribute('data-mention', node.attrs.id as string);
    this.dom.textContent = `@${node.attrs.id as string}`;
  }
}

function appEditor() {
  const dom = new JSDOM('<!doctype html><html><body><div id="e"></div></body></html>', {
    url: 'https://example.atlassian.net/wiki/',
  });
  const { window } = dom;
  for (const [name, value] of [
    ['window', window],
    ['document', window.document],
    ['navigator', window.navigator],
    ['getSelection', () => window.getSelection()],
    ['getComputedStyle', (el: Element) => window.getComputedStyle(el)],
  ] as const) {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }

  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, [
      schema.text('Account '),
      schema.node('mention', { id: 'anna' }),
      schema.text(` owns ${IBAN_TOKEN}.`),
    ]),
  ]);

  // The app builds its own editor. We are not involved at this point.
  const state = EditorState.create({
    doc,
    plugins: [
      new Plugin({
        props: {
          nodeViews: {
            mention: (node, view) => new AppNodeView(node, view, window.document),
          },
        },
      }),
    ],
  });
  const view = new EditorView(window.document.getElementById('e')!, { state });
  return { view, window };
}

/** What a MAIN-world shim would actually run. */
function findEditorView(root: ParentNode): EditorView | null {
  for (const el of root.querySelectorAll('*')) {
    const desc = (el as unknown as { pmViewDesc?: { spec?: unknown } }).pmViewDesc;
    const spec = desc?.spec as Record<string, unknown> | undefined;
    if (!spec) continue;
    for (const value of Object.values(spec)) {
      // Duck-typed, because the field name is the app's choice, not ours.
      if (value && typeof value === 'object' && 'state' in value && 'dispatch' in value) {
        return value as EditorView;
      }
    }
  }
  return null;
}

test('a custom node view leaks the EditorView, and that is the whole route', () => {
  const { view } = appEditor();
  const found = findEditorView(view.dom);
  assert.ok(found, 'the view is reachable once any node uses a custom node view');
  assert.equal(found, view, 'and it is the real one');
});

test('reaching the view is enough to inject the reveal plugin into a running editor', () => {
  const { view } = appEditor();
  const found = findEditorView(view.dom)!;

  // Exactly what the shim would do: reconfigure a live editor we did not build.
  found.updateState(
    found.state.reconfigure({
      plugins: [...found.state.plugins, tokenReveal({ resolve })],
    }),
  );

  assert.ok(found.dom.textContent?.includes(IBAN_VALUE), 'the user now sees the value');
  assert.ok(
    !JSON.stringify(found.state.doc.toJSON()).includes(IBAN_VALUE),
    'and the model still carries only the token',
  );
  assert.ok(JSON.stringify(found.state.doc.toJSON()).includes(IBAN_TOKEN));
});

test('an app whose node views do not keep the view stays unreachable', () => {
  // Not hypothetical: a nodeView that only renders and never dispatches has no
  // reason to hold one. The route is a convention, not a guarantee.
  const { window } = appEditor();
  const bare = window.document.createElement('span');
  Object.defineProperty(bare, 'pmViewDesc', { value: { spec: { dom: bare } } });
  assert.equal(findEditorView({ querySelectorAll: () => [bare] } as unknown as ParentNode), null);
});
