/**
 * Mock backend — the three endpoints the extension needs, per
 * docs/extensions/browser/ENDPOINTS.md:
 *
 *   GET    /v1/health          liveness, unauthenticated
 *   GET    /v1/policy          the NATIVE / TRUSTED lists, with ETag and max-age
 *   POST   /v1/detect          SPEC §3.2 exactly, caps and the 413 re-split included
 *   POST   /v1/tokens          mint (ENDPOINTS.md §6)
 *   POST   /v1/tokens/resolve  resolve, and re-scope to a destination
 *   DELETE /v1/tokens/{token}  revoke
 *
 * Dev only, and it runs on localhost so neither raw page text nor the vault's
 * plaintext leaves the machine. The vault is in memory and dies with the
 * process — see mock/vault.ts.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { LIMITS, type DetectRequest, type DetectResponse } from '../src/lib/protocol.ts';
import { POLICY_FILE, servePolicy } from './policy-store.ts';
import { detectChunk, MODEL_VERSION } from './rules.ts';
import { createTokenApi, openMockVault, type Reply } from './tokens-api.ts';

const PORT = Number(process.env.PORT ?? 8788);
const TOKEN = process.env.DETECT_TOKEN ?? 'dev-token';

/** One vault per process, shared by every client that authenticates. */
const tokens = createTokenApi(await openMockVault());

function handle(body: DetectRequest): DetectResponse {
  return {
    modelVersion: MODEL_VERSION,
    policyVersion: body.policyVersion,
    chunks: body.chunks.map((chunk) => ({
      id: chunk.id,
      hash: chunk.hash,
      // Hints are advisory: the passes ignore them and the client merges by
      // precedence regardless (SPEC §3.2).
      spans: detectChunk(chunk.text, body.locale ?? 'de-CH'),
    })),
  };
}

function authorized(req: IncomingMessage): boolean {
  return req.headers.authorization === `Bearer ${TOKEN}`;
}

/**
 * The lists are read fresh per request. A 304 is the common case once QA has
 * loaded the extension, and it is worth exercising: it is what keeps a
 * one-minute refresh from re-transferring the list all day.
 */
function handlePolicy(req: IncomingMessage, res: ServerResponse): void {
  const { body, etag, maxAgeSeconds } = servePolicy();
  res.setHeader('etag', etag);
  res.setHeader('cache-control', `max-age=${maxAgeSeconds}`);
  if (req.headers['if-none-match'] === etag) {
    console.log('[policy] 304 not modified');
    return void res.writeHead(304).end();
  }
  console.log(`[policy] 200 ${body}`);
  res.writeHead(200, { 'content-type': 'application/json' }).end(body);
}

function send(res: ServerResponse, reply: Reply): void {
  res.writeHead(reply.status, { 'content-type': 'application/json' }).end(JSON.stringify(reply.body));
}

function readJson(req: IncomingMessage, then: (body: unknown) => void): void {
  const parts: Buffer[] = [];
  req.on('data', (c: Buffer) => parts.push(c));
  req.on('end', () => {
    try {
      then(JSON.parse(Buffer.concat(parts).toString('utf8')));
    } catch {
      then(undefined);
    }
  });
}

const server = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, if-none-match');
  res.setHeader('Access-Control-Expose-Headers', 'etag');
  if (req.method === 'OPTIONS') return void res.writeHead(204).end();

  const path = (req.url ?? '').split('?')[0];

  if (req.method === 'GET' && path === '/v1/health') {
    // Unauthenticated on purpose: it says nothing a caller does not already know,
    // and QA needs it to answer before the token is configured.
    return void res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ status: 'ok', modelVersion: MODEL_VERSION }));
  }

  if (req.method === 'GET' && path === '/v1/policy') {
    if (!authorized(req)) return void res.writeHead(401).end('unauthorized');
    return void handlePolicy(req, res);
  }

  if (path?.startsWith('/v1/tokens')) {
    if (!authorized(req)) return void res.writeHead(401).end('unauthorized');

    if (req.method === 'DELETE') {
      const token = decodeURIComponent(path.slice('/v1/tokens/'.length));
      if (!token) return void res.writeHead(400).end('no token');
      return void send(res, tokens.revoke(token));
    }
    if (req.method === 'POST' || req.method === 'PATCH') {
      const rest = path.slice('/v1/tokens'.length);
      return void readJson(req, (body) => {
        if (body === undefined) return void res.writeHead(400).end('bad json');
        if (req.method === 'POST' && rest === '') return void tokens.mint(body).then((r) => send(res, r));
        if (req.method === 'POST' && rest === '/resolve') {
          return void tokens.resolve(body).then((r) => send(res, r));
        }
        if (req.method === 'POST' && rest === '/child') return void send(res, tokens.child(body));
        const commit = /^\/(.+)\/commit$/.exec(rest);
        if (req.method === 'POST' && commit) {
          return void tokens.commit(decodeURIComponent(commit[1]!)).then((r) => send(res, r));
        }
        if (req.method === 'PATCH' && rest.startsWith('/')) {
          return void send(res, tokens.update(decodeURIComponent(rest.slice(1)), body));
        }
        res.writeHead(404).end('not found');
      });
    }
    return void res.writeHead(404).end('not found');
  }

  if (req.method !== 'POST' || path !== '/v1/detect') {
    return void res.writeHead(404).end('not found');
  }
  if (!authorized(req)) {
    return void res.writeHead(401).end('unauthorized');
  }

  const parts: Buffer[] = [];
  req.on('data', (c: Buffer) => parts.push(c));
  req.on('end', () => {
    let body: DetectRequest;
    try {
      body = JSON.parse(Buffer.concat(parts).toString('utf8')) as DetectRequest;
    } catch {
      return void res.writeHead(400).end('bad json');
    }
    const total = body.chunks?.reduce((n, c) => n + c.text.length, 0) ?? 0;
    if (
      !Array.isArray(body.chunks) ||
      body.chunks.length > LIMITS.maxChunks ||
      total > LIMITS.maxTotalChars ||
      body.chunks.some((c) => c.text.length > LIMITS.maxChunkChars)
    ) {
      return void res.writeHead(413, { 'content-type': 'text/plain' }).end('re-split');
    }
    if (!['native', 'trusted', 'untrusted'].includes(body.hostClass)) {
      return void res.writeHead(400).end(`unknown hostClass: ${String(body.hostClass)}`);
    }
    // Printed so a QA run can see which class each page was scanned under.
    console.log(
      `[${body.hostClass}] ${body.chunks.length} chunk(s), ` +
        `${body.chunks.reduce((n, c) => n + c.text.length, 0)} chars, locale ${body.locale}`,
    );
    const payload = JSON.stringify(handle(body));
    res.writeHead(200, { 'content-type': 'application/json' }).end(payload);
  });
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `port ${PORT} is already in use — another mock backend is probably still running.\n` +
      `Free it (\`pkill -f detect-serve[r]\`) or pick another: PORT=9788 npm run ...`,
    );
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`mock backend on http://localhost:${PORT}`);
  console.log(`  GET  /v1/health`);
  console.log(`  GET  /v1/policy   <- ${POLICY_FILE} (edit it live; re-read per request)`);
  console.log(`  POST /v1/detect`);
  console.log(`  POST /v1/tokens , /v1/tokens/resolve , /v1/tokens/child`);
  console.log(`  PATCH /v1/tokens/{token} , POST /v1/tokens/{token}/commit , DELETE /v1/tokens/{token}`);
  console.log(`  vault: in memory — every token dies when this process does`);
});
