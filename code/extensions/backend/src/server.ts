/**
 * Routing and request lifecycle. Protocol decisions live in `routes/`; what is
 * here is the part every route shares.
 *
 * The shape is deliberately flat — four paths, one credential, no framework and
 * no dependencies. This process sits inside the vault's trust boundary
 * (SPEC §3.1), and every dependency it takes is code with access to raw page
 * text; the bar for adding one is that high on purpose.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { isAuthorized } from './auth.ts';
import type { Config } from './config.ts';
import type { DetectEngine } from './detect/engine.ts';
import { applyCors, BodyTooLarge, readBody, sendError, sendText } from './http.ts';
import type { Logger } from './log.ts';
import type { PolicyStore } from './policy/store.ts';
import { handleDetect } from './routes/detect.ts';
import { handleHealth } from './routes/health.ts';
import { handleMetrics, type Counters } from './routes/metrics.ts';
import { handlePolicy } from './routes/policy.ts';

export interface Backend {
  server: Server;
  counters: Counters;
  listen(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
}

export interface BackendDeps {
  config: Config;
  engine: DetectEngine;
  store: PolicyStore;
  logger: Logger;
}

const ALLOWED_METHODS: Record<string, string> = {
  '/v1/health': 'GET',
  '/v1/policy': 'GET',
  '/v1/detect': 'POST',
  '/v1/metrics': 'GET',
};

export function createBackend(deps: BackendDeps): Backend {
  const { config, engine, store, logger } = deps;
  const startedAt = Date.now();
  const counters: Counters = {
    requests: 0,
    unauthorized: 0,
    detectOk: 0,
    detectRejected: 0,
    detectFailed: 0,
    policyServed: 0,
    policyNotModified: 0,
  };

  const server = createServer((req, res) => {
    counters.requests++;
    const requestId = randomUUID();
    res.setHeader('x-request-id', requestId);
    res.setHeader('x-content-type-options', 'nosniff');
    applyCors(req, res, config.allowedOrigins);

    const log = logger.child({ requestId });
    void route(req, res, log).catch((err: unknown) => {
      // Nothing below is expected to throw; if it does, the client gets an id
      // and nothing else. A stack trace in a browser console is an invitation.
      log.error('request.failed', {
        method: req.method ?? '',
        path: pathOf(req),
        reason: err instanceof Error ? err.message : 'unknown',
      });
      if (!res.headersSent) sendError(res, 500, 'internal_error', 'the request could not be handled', requestId);
      else res.end();
    });
  });

  async function route(req: IncomingMessage, res: ServerResponse, log: Logger): Promise<void> {
    const path = pathOf(req);
    const method = req.method ?? 'GET';

    if (method === 'OPTIONS') return void res.writeHead(204).end();

    const allowed = ALLOWED_METHODS[path];
    if (allowed === undefined) return sendError(res, 404, 'not_found', `no route for ${path}`);
    if (allowed !== method) {
      res.setHeader('allow', allowed);
      return sendError(res, 405, 'method_not_allowed', `${path} accepts ${allowed}`);
    }

    if (path === '/v1/health') return handleHealth(res, engine.modelVersion);

    // Everything past here needs the bearer credential (ENDPOINTS.md §4).
    if (!isAuthorized(req.headers.authorization, config.tokens)) {
      counters.unauthorized++;
      log.warn('auth.rejected', { path });
      res.setHeader('www-authenticate', 'Bearer');
      return sendError(res, 401, 'unauthorized', 'a valid bearer credential is required');
    }

    if (path === '/v1/policy') {
      handlePolicy(req, res, { store, logger: log });
      if (res.statusCode === 304) counters.policyNotModified++;
      else if (res.statusCode === 200) counters.policyServed++;
      return;
    }

    if (path === '/v1/metrics') return handleMetrics(res, engine, store, counters, startedAt);

    // /v1/detect
    // Never cached by anything in between: the body is derived from page text.
    res.setHeader('cache-control', 'no-store');
    let body: string;
    try {
      body = await readBody(req, config.maxBodyBytes);
    } catch (err) {
      if (err instanceof BodyTooLarge) {
        // 413 is the re-split signal, so an oversized body gets the same answer
        // as an over-cap one: halve it and try again (SPEC §3.2).
        counters.detectRejected++;
        log.warn('detect.body_too_large', { limitBytes: config.maxBodyBytes });
        // The rest of the upload is discarded, so this connection is finished
        // once the answer is out.
        res.setHeader('connection', 'close');
        res.on('finish', () => req.destroy());
        return sendText(res, 413, 're-split');
      }
      throw err;
    }
    await handleDetect(body, res, { engine, fallbackLocale: fallbackLocale(store), logger: log });
    if (res.statusCode === 200) counters.detectOk++;
    else if (res.statusCode === 502) counters.detectFailed++;
    else counters.detectRejected++;
  }

  return {
    server,
    counters,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
          server.removeListener('error', reject);
          const address = server.address();
          const port = typeof address === 'object' && address ? address.port : config.port;
          resolve({ host: config.host, port });
        });
      }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/**
 * The locale a request may omit. It comes from the served policy rather than a
 * constant, so the one place that states "this deployment is de-CH" is the same
 * file the clients are told it from.
 */
function fallbackLocale(store: PolicyStore): string {
  return store.current()?.policy.locale ?? 'de-CH';
}

function pathOf(req: IncomingMessage): string {
  const raw = req.url ?? '/';
  const path = raw.split('?')[0] ?? '/';
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}
