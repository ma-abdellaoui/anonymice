// ISOLATED world. Shared runtime for the other content scripts, plus the
// message bridge to the MAIN-world chokepoint (which cannot touch chrome.*).
//
// Content scripts of the same extension share this global scope; bridge.js is
// listed first in the manifest.

const CH = '__anonymice__';
const NONCE = Math.random().toString(36).slice(2); // MAIN world learns it via handshake

const pending = new Map();
let seq = 0;

function ask(type, payload) {
  return chrome.runtime.sendMessage({ type, ...payload }).catch((e) => ({ ok: false, error: String(e) }));
}

// --- MAIN <-> ISOLATED -------------------------------------------------------
window.addEventListener('message', async (ev) => {
  const d = ev.data;
  if (ev.source !== window || !d || d.ch !== CH) return;

  if (d.kind === 'hello') {
    window.postMessage({ ch: CH, kind: 'hello-ack', nonce: NONCE }, '*');
    return;
  }
  if (d.kind !== 'req' || d.nonce !== NONCE) return;

  const res = await ask(d.type, d.payload);
  window.postMessage({ ch: CH, kind: 'res', id: d.id, nonce: NONCE, res }, '*');
});

// --- shared helpers for clipboard.js / input.js ------------------------------
self.anonymice = {
  CH, NONCE, ask,

  // Every call carries { flow, point } so the trace console can attribute it
  // to a documented user flow and a control point.
  async destination(url, ctx = {}) { return ask('destination', { url, ...ctx }); },

  async classify(text, caretOffset, style, ctx = {}) {
    const r = await ask('classify', { text, caretOffset, style, ...ctx });
    return r.ok ? r.spans : null;    // null => fail closed at the call site
  },

  async sweep(text, url, ctx = {}) { return ask('sweep', { text, url, ...ctx }); },

  async resolve(digests, ctx = {}) {
    const r = await ask('resolve', { digests, ...ctx });
    return r.ok ? r.map : {};
  },

  audit(entry, ctx = {}) { return ask('audit', { entry, ...ctx }); },

  // Is the page we are on a surface we intercept at all?
  pageClass: null
};

(async () => {
  const d = await self.anonymice.destination(location.href, { flow: 'F0-page-load', point: '·' });
  self.anonymice.pageClass = d.ok ? d.class : 'unknown';
})();
