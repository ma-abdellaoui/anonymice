// CONTROL POINT: the read path. See docs/USER_FLOWS.md §3.
//
// The provider genuinely stores tokens, so this is the one place where a
// display-only pass is correct. Real values are rendered as a DECORATION —
// never written into the document — or the next keystroke ships them back.

const A = self.anonymice;
const TOKEN_RE = /⟦([A-Z]+)·([0-9a-f]{5,16})⟧/g;
const shown = new WeakSet();

let queued = false;
const observer = new MutationObserver(() => schedule());

addEventListener('DOMContentLoaded', () => {
  if (A.pageClass !== 'tokenizing') return;
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  schedule();
});

function schedule() {
  if (queued) return;
  queued = true;
  requestIdleCallback(sweepDom, { timeout: 300 });
}

async function sweepDom() {
  queued = false;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const hits = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (shown.has(n) || n.parentElement?.isContentEditable) continue;  // never touch editor content
    TOKEN_RE.lastIndex = 0;
    if (TOKEN_RE.test(n.data)) hits.push(n);
  }
  if (!hits.length) return;

  // Batch: one resolve call per viewport, never one per token.
  const digests = [...new Set(hits.flatMap((n) => [...n.data.matchAll(TOKEN_RE)].map((m) => m[2])))];
  const map = await A.resolve(digests, { flow: 'F3-read', point: '①' });

  for (const n of hits) {
    shown.add(n);
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of [...n.data.matchAll(TOKEN_RE)]) {
      frag.append(n.data.slice(last, m.index));
      const plain = map[m[2]];
      const el = document.createElement('span');
      el.dataset.anonymiceToken = m[0];          // token stays the truth
      el.textContent = plain ?? m[0];            // no grant → token stays visible
      el.title = plain ? `re-identified · ${m[1]}` : `not authorized for ${m[1]}`;
      el.style.cssText = plain
        ? 'background:#eef3ff;border-bottom:1px dashed #7aa7ff;border-radius:2px'
        : 'background:#f3eefb;color:#6b4a9c;border-radius:2px';
      frag.append(el);
      last = m.index + m[0].length;
    }
    frag.append(n.data.slice(last));
    n.replaceWith(frag);
  }
}
