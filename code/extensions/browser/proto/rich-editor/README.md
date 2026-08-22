# SPIKE — rich-editor reveal via ProseMirror decorations

**Status: spike. Not shipped, not wired to the vault, not on any load path.**
Self-contained (own `package.json`, own `node_modules`) so the extension's
dependency surface stays clean.

    npm install && npm run check

## The question

SPEC §8.1 concludes plaintext cannot live in the page, because every DOM surface
is page-readable. That conclusion is sound for an `<input>`, where `value` is
*both* what is rendered and what is submitted — one object, so there is nothing
to separate.

A ProseMirror-backed editor (Confluence, Jira, TipTap, Atlassian ADF) does not
work that way. The **document model** is the source of truth and the DOM is a
rendering of it, and what a collaborative destination receives is the model —
shipped as transaction steps. So the question is whether a **decoration**, which
ProseMirror renders but never reads back, can hold the plaintext while the model
holds only the token.

Decorations rather than a custom node type on purpose: ADF is validated
server-side and an unknown node would be stripped. A decoration never touches
the schema.

## What the spike shows

`src/token-decorations.ts` conceals the token with `Decoration.inline`
(`display:none`) and renders the value in a `Decoration.widget` beside it.

| | verified |
|---|---|
| user sees the plaintext in the page DOM | ✅ |
| document model holds only the token | ✅ |
| collab steps carry no plaintext when editing around the token | ✅ |
| copy-out of the editor yields the token | ✅ |
| a token not in the vault renders as itself, not as a value | ✅ |
| **ProseMirror's own `readDOMChange` does not pull the value into the model** | ✅ |

The last row is the one that could have killed it. ProseMirror reparses the DOM
back into the model on any mutation it did not make — IME, autocorrect,
spellcheck, drag-drop. `test/reparse.test.ts` drives the real path (mutate a text
node behind the view's back, let `DOMObserver` flush) and the model stays
token-only. The mechanism is `WidgetViewDesc.parseRule() → { ignore: true }`,
reached through `dom.pmViewDesc` in prosemirror-view's `ruleFromNode`.

## What it also shows — the limits

- **The marker protects the node, not the characters.** `test/reparse.test.ts`
  unwraps the chip, and the plaintext is then parsed straight into the model.
  Anything that strips `pmViewDesc` — a sanitiser, a DOM-mangling extension, a
  page script cloning the editor subtree — turns this into a leak *at the moment
  the user is typing*. There is a matching test asserting the naive-parse failure
  mode explicitly, so a regression is loud.
- **`render: 'plaintext'` does not close page-JS reads.** The value is in the
  page DOM, so session replay (FullStory, Hotjar, LogRocket, Datadog RUM)
  serialises it out — SPEC §8.8's concrete argument for the iframe boundary. This
  variant is a `TRUSTED`-class mechanism only.
- **`render: 'frame'` closes both** and is also verified here: the widget renders
  a `chrome-extension://` iframe *inline*, so the editor lays it out. No rAF
  tracking, no clipping, no z-index war — most of §8.8's cost list is a
  consequence of `position: fixed` over a page we do not control, and it does not
  apply here. Cost is one frame per revealed token.

## Attaching to an editor we do not own — works, but on a convention

The mechanism works, and it can be injected into a live editor we did not build.
What it cannot do is rest on anything Atlassian guarantees.

A decoration needs a plugin on the page's own `EditorView`, added with
`view.updateState(view.state.reconfigure({ plugins: [...] }))`. That needs the
`EditorView` **object**, not its DOM node. Two facts, both pinned in
`test/attachment.test.ts`:

1. An isolated-world content script cannot read expando properties the page set
   on a DOM node — each world gets its own wrappers — so `node.pmViewDesc` is
   invisible from an isolated world. This is what forces `world: "MAIN"`.
2. The MAIN world does not rescue it. `view.dom.pmViewDesc` is a `NodeViewDesc`
   whose keys are `parent, children, dom, contentDOM, dirty, node, outerDeco,
   innerDeco, nodeDOM`: **no back-reference to the `EditorView`, and nothing
   hanging off it holds an `EditorState`** (prosemirror-view
   `dist/index.js:1519` constructs it without one).

3. **But a real app is not a plain document.** Any node rendered through a
   custom node view gets a `CustomNodeViewDesc`, which keeps the app's own
   NodeView object as `.spec` (`dist/index.js:1589`). ProseMirror does not put
   the view there — the *app* does, because the nodeView signature is
   `(node, view, getPos)` and an implementation needs `view.dispatch` to do
   anything. Atlassian's `ReactNodeView` follows that pattern, and Confluence
   renders mentions, panels, media and macros through node views.

`test/attachment-custom.test.ts` models that app and runs the full route: find
any element whose `pmViewDesc.spec` holds an object with `state` and `dispatch`,
then `view.updateState(view.state.reconfigure({ plugins: [...old, tokenReveal] }))`
on an editor the test never built. The value renders; the model stays
token-only.

**So this is deliverable — on a convention rather than an interface.** We would
be reading a private field whose name is the app's choice, on a class Atlassian
can restructure in any deploy. The third test in that file covers the other
branch: a nodeView that never keeps the view stays unreachable.

The two other routes — walking the React fiber off the editor node, or hooking
the webpack chunk registry to intercept `EditorView` before construction — are
strictly worse versions of the same bet.

**The failure direction is what makes the bet acceptable.** If attachment
breaks, no plugin loads, no decoration renders, and the editor shows the token.
Degraded UX, intact security — SPEC §8.6 exactly. This is not a mechanism where
fragility costs confidentiality, which is why "fragile" is a maintenance
argument here and not a security one.

`test/attachment.test.ts` asserts the plain-document negative deliberately: if a
future ProseMirror adds a view reference, that test fails and the convention
stops being load-bearing.

## Not covered — what a browser is needed for
- Caret and selection behaviour around the chip with a real caret.
- Frame sizing round-trip and reflow for `render: 'frame'`.
- Whether ADF's server-side validation is genuinely indifferent to a token
  sitting in a text node (expected — it is ordinary text — but unverified).
