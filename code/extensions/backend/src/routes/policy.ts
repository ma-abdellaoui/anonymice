/**
 * `GET /v1/policy` — the trust-list pull, ENDPOINTS.md §2.
 *
 * `304` is the steady state and the reason this endpoint is cheap: a fleet on a
 * one-minute refresh reads it constantly, and only the first read of a given
 * list should transfer a body.
 *
 * A `503` here is not a failure of the fleet: the client keeps serving its held
 * copy until that copy expires (ENDPOINTS.md §2.3), so an unreadable policy file
 * costs freshness, not protection — provided it is fixed inside the copy's life.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendError } from '../http.ts';
import type { Logger } from '../log.ts';
import type { PolicyStore } from '../policy/store.ts';

export interface PolicyRouteContext {
  store: PolicyStore;
  logger: Logger;
}

export function handlePolicy(req: IncomingMessage, res: ServerResponse, ctx: PolicyRouteContext): void {
  const served = ctx.store.current();
  if (!served) {
    ctx.logger.error('policy.unavailable', { file: ctx.store.file });
    return sendError(res, 503, 'policy_unavailable', 'the policy file could not be read');
  }

  res.setHeader('etag', served.etag);
  res.setHeader('cache-control', `max-age=${served.maxAgeSeconds}`);

  // Strong comparison: the client uses the ETag to decide whether it may keep
  // serving the copy it holds, so it has to mean byte equality.
  const presented = req.headers['if-none-match'];
  if (presented === served.etag) {
    ctx.logger.debug('policy.not_modified', { etag: served.etag });
    return void res.writeHead(304).end();
  }

  ctx.logger.info('policy.served', {
    policyVersion: served.policy.policyVersion ?? null,
    native: served.policy.native?.length ?? 0,
    trusted: served.policy.trusted?.length ?? 0,
    rejected: served.rejected.length,
    etag: served.etag,
  });
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(served.body);
}
