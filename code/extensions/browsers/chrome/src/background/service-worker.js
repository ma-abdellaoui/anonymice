// Router. Content scripts talk only to this worker; this worker talks only to
// the vault service. No local shortcuts — so the trace console sees every
// control point.

import * as vault from '../lib/vault.js';

const destCache = new Map(); // origin -> { at, value }
const DEST_TTL = 10_000;

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  handle(msg, sender)
    .then(reply)
    .catch((e) => reply({ ok: false, error: String(e) })); // caller fails closed
  return true;
});

async function handle(msg, sender) {
  const ctx = { flow: msg.flow, point: msg.point, origin: sender?.origin ?? sender?.url };

  switch (msg.type) {
    case 'destination': {
      const key = originOf(msg.url);
      const hit = destCache.get(key);
      if (hit && Date.now() - hit.at < DEST_TTL) return hit.value;
      const value = await vault.destination(msg.url, ctx);
      if (value.ok) destCache.set(key, { at: Date.now(), value });
      return value;
    }

    case 'classify':
      return vault.classify({ text: msg.text, caretOffset: msg.caretOffset ?? null,
                              style: msg.style, url: msg.url ?? ctx.origin, ...ctx });

    case 'sweep':
      if (vault.isService(msg.url)) return { ok: true, text: msg.text, changed: false };
      return vault.sweep({ text: msg.text, url: msg.url, ...ctx });

    case 'resolve':
      return vault.resolve({ digests: msg.digests, url: ctx.origin, ...ctx });

    case 'audit':
      return vault.trace({ ...msg.entry, url: sender?.url, ...ctx });

    default:
      throw new Error(`unknown message ${msg.type}`);
  }
}

function originOf(u) { try { return new URL(u).origin; } catch { return String(u); } }
