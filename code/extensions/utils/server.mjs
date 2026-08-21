// Anonymice mock — vault + classifier + a fake foreign service, in one process.
//
// Everything the extension does at every control point comes through here, so
// the console at http://vault.localhost:8787/ is a complete trace of what
// crossed the boundary and what did not.
//
// Run: node code/extensions/utils/server.mjs      (no dependencies)
//
// Hosts (Chrome resolves *.localhost to 127.0.0.1 automatically):
//   vault.localhost:8787    console + API        [TRUSTED]
//   trusted.localhost:8787  internal CRM fixture [TRUSTED]
//   cloud.localhost:8787    fake Confluence      [TOKENIZING]
//   ai.localhost:8787       fake LLM chat        [TOKENIZING, surrogate style]

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';

import { classify, sweep } from '../../../extension/src/lib/classifier.js';
import { mergeOverlapping, applySpans } from '../../../extension/src/lib/spans.js';
import { render, HIGH_CONFIDENCE } from '../../../extension/src/lib/tokens.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 8787;

// --- vault state (this is the part that stays in Switzerland) ----------------
const KEY = 'DEV-ONLY-KEY-NEVER-SHIP';
const vault = new Map();      // digest -> { cls, value, normalized, firstSeen, uses }

// --- what the FOREIGN service actually stored (the money shot) ---------------
const foreign = [];           // { ts, service, path, body }

// --- who may re-identify -----------------------------------------------------
const ROLES = {
  admin:   ['PER', 'IBAN', 'AHV', 'EMAIL', 'PHONE', 'CONTRACT', 'ADDR', 'CARD'],
  hr:      ['PER', 'EMAIL', 'PHONE', 'ADDR'],
  finance: ['IBAN', 'CONTRACT', 'CARD'],
  guest:   []
};
let actor = 'admin';

// --- trace bus ---------------------------------------------------------------
const clients = new Set();
const traceLog = [];

function trace(ev) {
  const e = { id: randomUUID().slice(0, 8), ts: Date.now(), ...ev };
  traceLog.push(e);
  if (traceLog.length > 500) traceLog.shift();
  const line = `data: ${JSON.stringify(e)}\n\n`;
  for (const c of clients) c.write(line);
  const tag = `${e.point ?? ' '} ${e.flow ?? ''}`.padEnd(22);
  console.log(`${tag} ${e.op.padEnd(12)} ${e.summary ?? ''}`);
  return e;
}

function normalize(cls, value) {
  const v = value.trim().replace(/\s+/g, ' ');
  if (['IBAN', 'AHV', 'CARD'].includes(cls)) return v.replace(/[\s.-]/g, '').toUpperCase();
  if (cls === 'EMAIL') return v.toLowerCase();
  if (cls === 'PHONE') return v.replace(/[^\d+]/g, '').replace(/^0/, '+41');
  return v.toLowerCase();
}

// Deterministic: same value -> same token, across documents, users and time.
// The key never leaves this process; the token is public, the derivation is not.
function mint(cls, value) {
  const norm = normalize(cls, value);
  const digest = createHmac('sha256', KEY).update(`${cls}:${norm}`).digest('hex').slice(0, 6);
  const existing = vault.get(digest);
  if (existing) { existing.uses++; return { digest, fresh: false }; }
  vault.set(digest, { cls, value, normalized: norm, firstSeen: Date.now(), uses: 1 });
  return { digest, fresh: true };
}

// --- policy ------------------------------------------------------------------
const POLICY = {
  trusted: ['vault.localhost', 'trusted.localhost'],
  tokenizing: ['cloud.localhost', 'ai.localhost'],
  style: { 'ai.localhost': 'surrogate', '*': 'opaque' },
  passthrough: { 'cloud.localhost': ['$.author.email', '$.accountId'] },
  blockedPaths: { 'cloud.localhost': ['/cloud/api/typeahead'] }
};

function hostOf(u) { try { return new URL(u).hostname; } catch { return ''; } }
function classOf(u) {
  const h = hostOf(u);
  if (POLICY.trusted.includes(h)) return 'trusted';
  if (POLICY.tokenizing.includes(h)) return 'tokenizing';
  return 'unknown';
}
function styleOf(u) { return POLICY.style[hostOf(u)] ?? POLICY.style['*']; }
function blockedOf(u) {
  const paths = POLICY.blockedPaths[hostOf(u)];
  try { return !!paths && paths.some((p) => new URL(u).pathname.startsWith(p)); }
  catch { return false; }
}

// --- API ---------------------------------------------------------------------
const api = {
  'POST /api/destination': ({ url }) => ({
    class: classOf(url), style: styleOf(url), blocked: blockedOf(url),
    passthrough: POLICY.passthrough[hostOf(url)] ?? []
  }),

  // Interactive path: caret-aware, high recall. This is UX, not the guarantee.
  'POST /api/classify': (b) => {
    const spans = mergeOverlapping(classify(b.text ?? '', { caretOffset: b.caretOffset ?? null }));
    const style = b.style ?? 'opaque';
    const out = spans.map((s) => {
      const { digest, fresh } = mint(s.cls, s.value);
      return { ...s, digest, fresh, token: render(s.cls, digest, style),
               overridable: !HIGH_CONFIDENCE.has(s.cls) };
    });
    trace({ op: 'classify', flow: b.flow, point: b.point, origin: b.origin, url: b.url,
            before: b.text, after: out.length ? applySpans(b.text, out, (s) => s.token) : b.text,
            spans: out, summary: `${out.length} span(s) ${out.map((s) => s.cls).join(',') || '—'}` });
    return { spans: out };
  },

  // Egress gate: no caret exemption, no suppression, trusts nothing upstream.
  'POST /api/sweep': (b) => {
    const cls = classOf(b.url);
    if (cls === 'trusted') {
      trace({ op: 'egress-allow', flow: b.flow, point: '③', url: b.url, before: b.text,
              summary: 'destination TRUSTED — plaintext may pass' });
      return { text: b.text, changed: false };
    }
    if (blockedOf(b.url)) {
      trace({ op: 'egress-block', flow: b.flow, point: '③', url: b.url, before: b.text,
              summary: 'endpoint blocked by policy (typeahead leak)' });
      return { blocked: true };
    }
    const style = styleOf(b.url);
    const spans = mergeOverlapping(sweep(b.text ?? '')).map((s) => {
      const { digest } = mint(s.cls, s.value);
      return { ...s, digest, token: render(s.cls, digest, style) };
    });
    const text = spans.length ? applySpans(b.text, spans, (s) => s.token) : b.text;
    trace({ op: spans.length ? 'egress-mask' : 'egress-clean', flow: b.flow, point: '③',
            url: b.url, before: b.text, after: text, spans,
            summary: spans.length ? `masked ${spans.length} (${style})` : 'nothing to mask' });
    return { text, changed: !!spans.length, count: spans.length };
  },

  // Re-identification: authorized per entity class, as the calling actor, logged.
  'POST /api/resolve': (b) => {
    const allowed = ROLES[b.actor ?? actor] ?? [];
    const map = {}; const denied = [];
    for (const d of b.digests ?? []) {
      const e = vault.get(d);
      if (!e) continue;
      if (allowed.includes(e.cls)) map[d] = e.value; else denied.push(e.cls);
    }
    trace({ op: 'resolve', flow: b.flow, point: b.point, url: b.url, actor: b.actor ?? actor,
            summary: `as ${b.actor ?? actor}: ${Object.keys(map).length} granted, ${denied.length} denied${denied.length ? ' (' + [...new Set(denied)].join(',') + ')' : ''}` });
    return { map };
  },

  'POST /api/trace': (b) => { trace({ op: b.op ?? 'note', ...b }); return { ok: true }; },
  'POST /api/actor': (b) => { actor = b.actor; trace({ op: 'actor', summary: `switched to ${actor}` }); return { actor }; },
  'POST /api/reset': () => {
    vault.clear(); foreign.length = 0; traceLog.length = 0;
    trace({ op: 'reset', summary: 'vault + foreign storage cleared' });
    return { ok: true };
  },

  'GET /api/state': () => ({
    actor, roles: Object.keys(ROLES),
    vault: [...vault].map(([digest, e]) => ({ digest, ...e })),
    foreign
  })
};

// --- the fake FOREIGN service ------------------------------------------------
// Anything reaching here has, by definition, left our boundary. The console
// shows it verbatim: if a real value appears in this panel, the design failed.
function receiveForeign(service, path, body) {
  foreign.push({ ts: Date.now(), service, path, body });
  const leak = mergeOverlapping(sweep(String(body)));
  trace({ op: leak.length ? 'PROVIDER-RECEIVED-PLAINTEXT' : 'provider-received',
          point: '🌍', url: `${service}${path}`, before: String(body),
          leak: leak.map((s) => ({ cls: s.cls, value: s.value })),
          summary: leak.length
            ? `⚠️  ${leak.length} real value(s) crossed the border: ${leak.map((s) => s.cls).join(',')}`
            : `${String(body).length} bytes, tokens only` });
}

// --- HTTP --------------------------------------------------------------------
const MIME = { html: 'text/html', js: 'text/javascript', css: 'text/css', json: 'application/json' };

createServer(async (req, res) => {
  const host = (req.headers.host ?? '').split(':')[0];
  const url = new URL(req.url, `http://${host}:${PORT}`);
  const cors = {
    'access-control-allow-origin': req.headers.origin ?? '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-credentials': 'true'
  };
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();

  // trace stream
  if (url.pathname === '/events') {
    res.writeHead(200, { ...cors, 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ op: 'connected', ts: Date.now(), id: 'init', summary: 'trace stream open' })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  const body = await readBody(req);

  // fake foreign endpoints
  if (url.pathname.startsWith('/cloud/api/')) {
    receiveForeign('cloud.localhost', url.pathname, body);
    return json(res, cors, { ok: true, id: randomUUID().slice(0, 8) });
  }
  if (url.pathname.startsWith('/ai/')) {
    receiveForeign('ai.localhost', url.pathname, body);
    // Echo the prompt back so token round-tripping is visible, streamed in
    // deliberately awkward chunks so the SSE-boundary bug is reproducible.
    const prompt = safeJson(body)?.prompt ?? String(body);
    const answer = `Based on the context: ${prompt.split('\n').pop()} — noted.`;
    res.writeHead(200, { ...cors, 'content-type': 'text/event-stream' });
    for (let i = 0; i < answer.length; i += 7) {
      res.write(`data: ${JSON.stringify({ delta: answer.slice(i, i + 7) })}\n\n`);
      await new Promise((r) => setTimeout(r, 20));
    }
    return res.end('data: [DONE]\n\n');
  }

  // API
  const route = api[`${req.method} ${url.pathname}`];
  if (route) return json(res, cors, route(safeJson(body) ?? {}) ?? {});

  // static: fixture per host, console everywhere else
  const file = url.pathname === '/'
    ? ({ 'trusted.localhost': 'fixtures/trusted.html',
         'cloud.localhost': 'fixtures/cloud.html',
         'ai.localhost': 'fixtures/ai.html' }[host] ?? 'console.html')
    : url.pathname.slice(1);
  try {
    const buf = await readFile(join(HERE, file));
    res.writeHead(200, { ...cors, 'content-type': MIME[file.split('.').pop()] ?? 'text/plain' });
    res.end(buf);
  } catch {
    res.writeHead(404, cors).end('not found');
  }
}).listen(PORT, () => {
  console.log(`
  anonymice mock  →  http://vault.localhost:${PORT}/     console
                     http://trusted.localhost:${PORT}/   internal CRM   [TRUSTED]
                     http://cloud.localhost:${PORT}/     fake Confluence [TOKENIZING]
                     http://ai.localhost:${PORT}/        fake LLM chat   [TOKENIZING/surrogate]
`);
});

function readBody(req) {
  return new Promise((resolve) => {
    let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => resolve(d));
  });
}
function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }
function json(res, cors, obj) {
  res.writeHead(200, { ...cors, 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}
