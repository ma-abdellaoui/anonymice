// CONTROL POINT: typed input. See docs/USER_FLOWS.md §2.
//
// No provenance, no discrete gesture, no moment where the user is "done".
// Classification here is early, incremental and interactive — the GUARANTEE
// lives in the chokepoint (chokepoint.js), not in this file.

const A = self.anonymice;
const DEBOUNCE_MS = 150;

const state = new WeakMap(); // element -> { timer, composing }

document.addEventListener('input', onInput, true);
document.addEventListener('compositionstart', (e) => mark(e.target, true), true);
document.addEventListener('compositionend', (e) => { mark(e.target, false); onInput(e); }, true);

function mark(el, composing) {
  const s = state.get(el) || {};
  s.composing = composing;
  state.set(el, s);
}

function onInput(e) {
  const el = e.target;
  if (!isEditable(el)) return;
  if (A.pageClass !== 'tokenizing') return;   // trusted / unknown: do nothing

  const s = state.get(el) || {};
  // Never classify mid-IME-composition, or every non-ASCII name gets mangled.
  if (s.composing) return;

  clearTimeout(s.timer);
  s.timer = setTimeout(() => run(el), DEBOUNCE_MS);
  state.set(el, s);
}

async function run(el) {
  const { text, caret } = readValue(el);
  if (!text) return;

  // caret is passed so the classifier skips the value being typed:
  // `CH93 0076 2011` is a valid IBAN prefix and the user is not finished.
  const spans = await A.classify(text, caret, styleForPage(), { flow: 'F2-typing', point: '①' });
  if (!spans || !spans.length) return;

  applyToEditor(el, text, spans);
}

// --- editor adapters ---------------------------------------------------------
// The entity must become an ATOMIC INLINE NODE (a chip), not token text with a
// decoration painted over it: token length != display length, so every offset
// the editor computes would be wrong. ProseMirror / Slate / Lexical / TinyMCE
// all have this primitive already, because @mentions needed it first.
//
// Consequences the adapter must honour:
//   - serializes to the token, renders as plaintext
//   - caret steps over it as ONE unit; backspace deletes it whole
//   - the substitution transaction is grouped into the SAME history step as
//     the keystroke that triggered it, or Ctrl+Z resurrects plaintext into the
//     document model and the next autosave ships it
const ADAPTERS = [];

export_adapter({
  name: 'prosemirror',
  match: (el) => el.classList?.contains('ProseMirror'),
  apply: (el, text, spans) => {
    // TODO: dispatch a transaction replacing each span range with an
    // `entity` node type, addToHistory: false / grouped with the last step.
    console.debug('[anonymice] prosemirror adapter: %d spans', spans.length);
  }
});

export_adapter({
  name: 'plain',     // <input>, <textarea>
  match: (el) => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement,
  apply: (el, text, spans) => {
    // No chip primitive available: token text is the only option here, so
    // preserve the caret manually.
    const caret = el.selectionStart;
    let out = text, shift = 0;
    for (const s of [...spans].sort((a, b) => a.start - b.start)) {
      const delta = s.token.length - (s.end - s.start);
      out = out.slice(0, s.start + shift) + s.token + out.slice(s.end + shift);
      if (s.end <= caret) shift += delta;
    }
    el.value = out;
    el.setSelectionRange(caret + shift, caret + shift);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
});

export_adapter({
  name: 'contenteditable',
  match: (el) => el.isContentEditable,
  apply: (el, text, spans) => {
    // TODO: chip nodes via Range surgery + a contenteditable="false" wrapper.
    console.debug('[anonymice] contenteditable adapter: %d spans', spans.length);
  }
});

function export_adapter(a) { ADAPTERS.push(a); }

function applyToEditor(el, text, spans) {
  const a = ADAPTERS.find((x) => x.match(el));
  if (!a) return;     // unknown editor: the chokepoint still catches egress
  a.apply(el, text, spans);
  A.audit({ op: 'input-mask', summary: `${a.name} adapter · ${spans.length} span(s) → document model`, before: text, spans }, { flow: 'F2-typing', point: '②' });
}

// --- helpers -----------------------------------------------------------------
function isEditable(el) {
  return el && (el.isContentEditable ||
    el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement);
}

function readValue(el) {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return { text: el.value, caret: el.selectionStart };
  }
  const sel = document.getSelection();
  return { text: el.textContent, caret: sel?.focusOffset ?? null };
}

function styleForPage() { return 'opaque'; }
