/**
 * Serves the two QA fixtures, routed by Host header so the extension sees two
 * genuinely different hosts on one port:
 *
 *   http://native.anonymice.test:8787/    -> eval/corpus/native.html   (NATIVE)
 *   http://trusted.anonymice.test:8787/   -> eval/corpus/trusted.html  (TRUSTED)
 *   http://localhost:8787/                -> setup instructions
 *
 * Both names must resolve to 127.0.0.1 — see `npm run hosts`. Serving them from
 * one origin (localhost) would make the policy classes untestable, which is the
 * whole point of the pair.
 *
 * Pages are served clean, so whatever highlights them is the extension.
 * `HARNESS=1` instead injects dev/harness.ts, which runs the same Scanner as a
 * page script against the mock backend — useful for pipeline work, useless for
 * judging whether the extension works.
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { extname, join } from 'node:path';
import type { Duplex } from 'node:stream';

const PORT = Number(process.env.PORT ?? 8787);
const ROOT = new URL('../', import.meta.url).pathname;
const CORPUS = join(ROOT, 'eval/corpus');
const DIST = join(ROOT, 'dist');
const HARNESS = process.env.HARNESS === '1';

export const HOSTS = {
  native: 'native.anonymice.test',
  trusted: 'trusted.anonymice.test',
} as const;

const PAGE_FOR_HOST: Record<string, string> = {
  [HOSTS.native]: 'native.html',
  [HOSTS.trusted]: 'trusted.html',
};

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json',
  '.json': 'application/json',
};

const HARNESS_BAR = `
<div data-anonymice="status-bar" style="position:fixed;top:0;left:0;right:0;padding:.5rem .75rem;
     background:#111;color:#eee;font:13px/1.4 ui-monospace,monospace;z-index:2147483647">
  anonymice dev harness (not the extension) — <span data-anonymice="status">scanning…</span>
</div><div style="height:2.2rem"></div>
<script type="module" src="/dist/harness.js"></script>
`;

function setupPage(): string {
  return `<!doctype html><meta charset="utf-8"><title>anonymice fixtures</title>
  <body style="font:15px/1.7 system-ui;margin:3rem auto;max-width:44rem;padding:0 1rem">
  <h1>anonymice fixtures</h1>
  <p>Two pages, two hosts. ${
    HARNESS
      ? 'Running the <strong>dev harness</strong> — highlights come from a page script, not the extension.'
      : 'Highlights come from the <strong>extension</strong>, if it is loaded and lists these hosts.'
  }</p>
  <ul>
    <li><a href="http://${HOSTS.native}:${PORT}/">${HOSTS.native}</a> — NATIVE: everything sensitive should be light-red</li>
    <li><a href="http://${HOSTS.trusted}:${PORT}/">${HOSTS.trusted}</a> — TRUSTED: script registered, nothing painted (yet)</li>
  </ul>
  <p>If those links fail to resolve, the hostnames are not in <code>/etc/hosts</code>:</p>
  <pre style="background:#f6f6f6;padding:.75rem">npm run hosts</pre>
  <p>Expected results per page are in <code>docs/extensions/browser/QA.md</code>.</p>`;
}

/**
 * What the *server* actually received — the only thing that settles whether the
 * egress gate worked (SPEC §11, QA step 14). Held in memory, newest last, and
 * cleared by `DELETE /collected` so a step can start from a clean slate.
 */
interface Collected {
  transport: string;
  body: string;
  at: string;
}
const collected: Collected[] = [];
const collect = (transport: string, body: string): void => {
  collected.push({ transport, body, at: new Date().toISOString() });
  if (collected.length > 200) collected.shift();
};

const server = createServer((req, res) => {
  const host = (req.headers.host ?? '').split(':')[0] ?? '';
  const path = (req.url ?? '/').split('?')[0] ?? '/';

  const cors = {
    'access-control-allow-origin': req.headers.origin ?? '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
  };

  try {
    if (req.method === 'OPTIONS') return void res.writeHead(204, cors).end();

    // The sink. Whatever arrives here is what a real destination would have
    // stored, which is the assertion every egress QA step actually makes.
    if (path === '/collect') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        collect(String(req.headers['x-transport'] ?? 'http'), Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200, { ...cors, 'content-type': TYPES['.json']! }).end('{"ok":true}');
      });
      return;
    }

    if (path === '/collected') {
      if (req.method === 'DELETE') {
        collected.length = 0;
        return void res.writeHead(200, { ...cors, 'content-type': TYPES['.json']! }).end('{"ok":true}');
      }
      return void res
        .writeHead(200, { ...cors, 'content-type': TYPES['.json']! })
        .end(JSON.stringify(collected, null, 2));
    }

    if (path.startsWith('/dist/')) {
      const file = join(DIST, path.slice('/dist/'.length));
      if (!file.startsWith(DIST)) return void res.writeHead(403).end('no');
      return void res
        .writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
        .end(readFileSync(file));
    }

    const page = PAGE_FOR_HOST[host];
    if (!page) {
      return void res.writeHead(200, { 'content-type': TYPES['.html']! }).end(setupPage());
    }

    const raw = readFileSync(join(CORPUS, page), 'utf8');
    const html = HARNESS ? raw.replace('</body>', `${HARNESS_BAR}</body>`) : raw;
    res.writeHead(200, { 'content-type': TYPES['.html']! }).end(html);
  } catch {
    res.writeHead(404).end('not found');
  }
});

/**
 * A minimal RFC 6455 server, text frames only.
 *
 * Worth the ~40 lines rather than a dependency: WebSocket is the transport that
 * forces the gate to be synchronous (SPEC §11.3), so a QA pass that cannot
 * exercise it is not testing the interesting half.
 */
const WS_GUID = '258EAFA5-E914-47DA-95CA-5AB0DC85B11F';

server.on('upgrade', (req, socket: Duplex) => {
  if ((req.url ?? '').split('?')[0] !== '/collab') return void socket.destroy();
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string') return void socket.destroy();

  const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );

  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const opcode = buffer[0]! & 0x0f;
      const masked = (buffer[1]! & 0x80) !== 0;
      let length = buffer[1]! & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < offset + 2) return;
        length = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (buffer.length < offset + 8) return;
        length = Number(buffer.readBigUInt64BE(offset));
        offset += 8;
      }
      const mask = masked ? buffer.subarray(offset, offset + 4) : null;
      if (masked) offset += 4;
      if (buffer.length < offset + length) return;

      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!;
      buffer = buffer.subarray(offset + length);

      if (opcode === 0x8) return void socket.end();
      if (opcode === 0x1) collect('websocket', payload.toString('utf8'));
    }
  });
  socket.on('error', () => socket.destroy());
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `port ${PORT} is already in use — another fixture server is probably still running.\n` +
        `Free it (\`pkill -f fixture-serve[r]\`) or pick another: PORT=9787 npm run ...`,
    );
    process.exit(1);
  }
  throw err;
});

/**
 * The hostnames resolve to loopback, so a bare `http://native.anonymice.test/`
 * goes to whatever owns port 80 — an already-installed Apache or nginx, not us.
 * Say so at startup rather than letting someone discover it by reading a
 * stranger's default page and wondering why nothing is highlighted.
 */
async function warnIfPortEightyAnswers(): Promise<void> {
  for (const host of Object.values(HOSTS)) {
    try {
      const res = await fetch(`http://${host}/`, {
        method: 'HEAD',
        signal: AbortSignal.timeout(400),
      });
      console.warn(
        `\n  ! port 80 on these hostnames is already served by ` +
          `${res.headers.get('server') ?? 'something else'}.\n` +
          `    A bare http://${host}/ will show that, not the fixtures.\n` +
          `    Always include :${PORT} in the URL.`,
      );
      return;
    } catch {
      // Nothing listening, or it did not answer in time: no collision to warn about.
    }
  }
}

server.listen(PORT, () => {
  console.log(`fixtures on :${PORT}` + (HARNESS ? ' (HARNESS=1 — the dev harness, not the extension)' : ''));
  console.log(`  NATIVE   http://${HOSTS.native}:${PORT}/`);
  console.log(`  TRUSTED  http://${HOSTS.trusted}:${PORT}/`);
  console.log(`  setup    http://localhost:${PORT}/`);
  console.log(`  egress   POST /collect · ws /collab · GET|DELETE /collected`);
  void warnIfPortEightyAnswers();
});
