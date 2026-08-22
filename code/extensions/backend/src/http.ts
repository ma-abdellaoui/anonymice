/**
 * The thin HTTP layer: body reading with a hard cap, JSON replies, and the CORS
 * policy. Deliberately small — routing decisions live in `server.ts` and
 * protocol decisions in the routes.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export class BodyTooLarge extends Error {}

/**
 * Reads a request body, refusing anything over `maxBytes` *as it arrives* rather
 * than after buffering it. The caller answers `413`, which the client reads as
 * "re-split" (SPEC §3.2) — so an oversized body is a control signal, not a
 * dead end.
 */
export function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        // Drained rather than destroyed: tearing the socket down here would
        // reach the client as a connection reset, and it would retry the whole
        // batch instead of halving it. The `413` is only useful if it arrives.
        parts.length = 0;
        req.resume();
        reject(new BodyTooLarge(`body over ${maxBytes} bytes`));
        return;
      }
      parts.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

export function sendJson(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers }).end(body);
}

export function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }).end(text);
}

/**
 * Error bodies carry a stable machine-readable `error` and a human `message`,
 * and never a stack: the client logs whatever it gets, and a stack trace in a
 * browser console is an invitation.
 */
export function sendError(res: ServerResponse, status: number, error: string, message: string, requestId?: string): void {
  sendJson(res, status, requestId ? { error, message, requestId } : { error, message });
}

/**
 * A wildcard `Access-Control-Allow-Origin` is never sent. The callers are the
 * extension's service worker (`chrome-extension://<id>`) and, in development,
 * the fixture harness on loopback; anything else has no business here and gets
 * no CORS headers, which is what makes a browser refuse the response.
 */
export function isAllowedOrigin(origin: string, configured: readonly string[]): boolean {
  if (configured.length > 0) return configured.includes(origin);
  if (origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://')) return true;
  try {
    const url = new URL(origin);
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

export function applyCors(req: IncomingMessage, res: ServerResponse, configured: readonly string[]): void {
  const origin = req.headers.origin;
  if (!origin || !isAllowedOrigin(origin, configured)) return;
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('vary', 'origin');
  res.setHeader('access-control-allow-headers', 'authorization, content-type, if-none-match');
  res.setHeader('access-control-expose-headers', 'etag');
  res.setHeader('access-control-max-age', '600');
}
