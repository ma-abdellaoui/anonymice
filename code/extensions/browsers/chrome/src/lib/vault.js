// Client for the vault + classifier service (Switzerland).
//
// The extension does NOT classify, mint or resolve locally: every control
// point asks this one service, which is why the trace console is a complete
// record of what crossed the boundary.
//
// FAIL-CLOSED: every failure path returns { ok:false } and callers block.

export const SERVICE = 'http://vault.localhost:8787';
const TIMEOUT_MS = 2500;

async function call(path, body) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    const res = await fetch(SERVICE + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal
    });
    clearTimeout(t);
    if (!res.ok) return { ok: false, error: `service ${res.status}` };
    return { ok: true, ...(await res.json()) };
  } catch (e) {
    return { ok: false, error: `vault unreachable: ${e.message}` };
  }
}

export const destination = (url, ctx) => call('/api/destination', { url, ...ctx });
export const classify = (b) => call('/api/classify', b);
export const sweep    = (b) => call('/api/sweep', b);
export const resolve  = (b) => call('/api/resolve', b);
export const trace    = (b) => call('/api/trace', b);

// Our own traffic to the vault must never be swept — that would recurse.
export const isService = (url) => String(url).startsWith(SERVICE);
