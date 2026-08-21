// CONTROL POINT: the clipboard. See docs/USER_FLOWS.md §1.
//
// Copy time knows the source but not the destination; paste time knows the
// destination but has lost provenance. So: classify at copy, decide at paste.
//
// Invariant: PLAINTEXT NEVER TOUCHES THE CLIPBOARD. text/plain and text/html
// carry tokens; the custom format carries only spans, entity ids, origin and
// timestamp. Resolving on a trusted paste is a vault lookup performed as the
// PASTING user — so authorization is checked at use, revocation is
// retroactive, and OS clipboard managers that sync to a vendor cloud receive
// tokens.

const A = self.anonymice;
const PROV = 'application/x-anonymice';   // sync events
const PROV_WEB = 'web ' + PROV;           // async Clipboard API

// --- copy / cut --------------------------------------------------------------
for (const ev of ['copy', 'cut']) {
  document.addEventListener(ev, onCopy, true); // capture: before the page sees it
}

async function onCopy(e) {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed) return;

  const plain = sel.toString();
  // Copy time is the richest context we will ever have — DOM, field labels,
  // table headers, an app adapter that knows column 3 is an IBAN. Throwing it
  // away and re-deriving from a flat string at paste time is strictly worse.
  const spans = await A.classify(plain, null, 'opaque', { flow: 'F1-clipboard-copy', point: '①' });
  if (spans === null) { e.preventDefault(); return; }  // fail closed
  if (!spans.length) return;

  e.preventDefault();
  const tokenized = substitute(plain, spans);

  const dt = e.clipboardData;
  dt.setData('text/plain', tokenized);
  dt.setData('text/html', escapeHtml(tokenized));      // sanitize EVERY flavour
  dt.setData(PROV, JSON.stringify({
    v: 1,
    origin: location.origin,
    ts: Date.now(),
    // no plaintext, no values — just what was masked and which entity it is
    spans: spans.map((s) => ({ start: s.start, end: s.end, cls: s.cls, token: s.token }))
  }));

  A.audit({ op: 'clipboard-write', summary: `${spans.length} span(s) tokenized; plaintext NOT on clipboard`, before: plain, after: tokenized, spans }, { flow: 'F1-clipboard-copy', point: '①' });
}

// --- paste / drop ------------------------------------------------------------
document.addEventListener('paste', onPaste, true);
document.addEventListener('drop', onPaste, true);

async function onPaste(e) {
  const dt = e.clipboardData || e.dataTransfer;
  if (!dt) return;

  const dest = await A.destination(location.href, { flow: 'F1-paste', point: '①' });
  if (!dest.ok) { e.preventDefault(); return; }        // fail closed

  // Screenshots cannot be sanitized. Policy is strip or block; we block.
  if ([...dt.items].some((i) => i.kind === 'file' && i.type.startsWith('image/'))) {
    if (dest.class === 'tokenizing') {
      e.preventDefault();
      A.audit({ op: 'paste-block', summary: 'image paste blocked — screenshots cannot be sanitized' },
              { flow: 'F1-paste', point: '①' });
      notify('Image paste blocked by policy'); return;
    }
  }

  const provenance = safeJson(dt.getData(PROV) || dt.getData(PROV_WEB));
  const plain = dt.getData('text/plain');
  if (!plain) return;

  if (dest.class === 'trusted') {
    // Re-identify for display/editing inside our boundary.
    const digests = [...plain.matchAll(/⟦[A-Z]+·([0-9a-f]+)⟧/g)].map((m) => m[1]);
    if (!digests.length) return;
    const map = await A.resolve(digests, { flow: 'F1-paste-trusted', point: '①' });
    e.preventDefault();
    insertText(plain.replace(/⟦([A-Z]+)·([0-9a-f]+)⟧/g, (t, c, d) => map[d] ?? t));
    return;
  }

  if (dest.class === 'tokenizing') {
    if (provenance) {
      A.audit({ op: 'paste-fastpath', summary: `provenance from ${provenance.origin}, ${provenance.spans.length} span(s) — already safe` },
              { flow: 'F1-paste-with-provenance', point: '①' });
      return;  // already tokenized at copy
    }
    // No provenance: content came from a native app, an email client, anywhere.
    // Classify now, without context, and confirm — the user made a deliberate
    // gesture, is present, and this is one discrete moment.
    const spans = await A.classify(plain, null, dest.style, { flow: 'F1-paste-no-provenance', point: '①' });
    if (spans === null) { e.preventDefault(); return; }
    if (!spans.length) return;
    e.preventDefault();
    const ok = await confirmMask(spans);
    insertText(ok ? substitute(plain, spans) : substituteHighConfidenceOnly(plain, spans));
  }
}

// --- helpers -----------------------------------------------------------------
function substitute(text, spans) {
  let out = text;
  for (const s of [...spans].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, s.start) + s.token + out.slice(s.end);
  }
  return out;
}

// The escape hatch is never total: high-confidence classes (IBAN, AHV, card,
// contract number) can not be waved through, and every override is audited.
function substituteHighConfidenceOnly(text, spans) {
  const forced = spans.filter((s) => !s.overridable);
  A.audit({ op: 'mask-override', summary: 'user waived low-confidence spans', waived: spans.filter((s) => s.overridable).map((s) => s.cls) });
  return substitute(text, forced);
}

function insertText(text) {
  // TODO: route through the editor adapter so the value lands as an atomic
  // entity node rather than raw text (see input.js / USER_FLOWS.md §2).
  document.execCommand('insertText', false, text);
}

async function confirmMask(spans) {
  // TODO: inline preview UI. Skeleton auto-accepts masking (fail-closed).
  return true;
}

function notify(msg) { console.info('[anonymice]', msg); }
function safeJson(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }
function escapeHtml(s) { return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
