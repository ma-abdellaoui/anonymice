/**
 * `GET /v1/health` — liveness, unauthenticated on purpose (ENDPOINTS.md §1).
 *
 * It says nothing a caller does not already know, and QA needs an answer before
 * a token is configured. It is explicitly **not** a readiness signal for
 * detection: the client's circuit breaker is driven by real `/v1/detect`
 * results, and nothing in the extension polls this.
 */
import type { ServerResponse } from 'node:http';
import { sendJson } from '../http.ts';

export function handleHealth(res: ServerResponse, modelVersion: string): void {
  sendJson(res, 200, { status: 'ok', modelVersion });
}
