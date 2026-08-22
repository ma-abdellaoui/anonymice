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
import { extname, join } from 'node:path';

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

const server = createServer((req, res) => {
  const host = (req.headers.host ?? '').split(':')[0] ?? '';
  const path = (req.url ?? '/').split('?')[0] ?? '/';

  try {
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

server.listen(PORT, () => {
  console.log(`fixtures on :${PORT}` + (HARNESS ? ' (HARNESS=1 — the dev harness, not the extension)' : ''));
  console.log(`  NATIVE   http://${HOSTS.native}:${PORT}/`);
  console.log(`  TRUSTED  http://${HOSTS.trusted}:${PORT}/`);
  console.log(`  setup    http://localhost:${PORT}/`);
});
