/**
 * `POST /v1/detect` — SPEC §3.2, ENDPOINTS.md §3.
 *
 * The route owns validation and status codes; the engine owns spans. The status
 * codes are a contract in themselves:
 *
 *  - `413` is **not** an error. It means "re-split": the client halves the batch
 *    and retries (SPEC §3.2). Every cap breach answers it, including a body over
 *    the byte ceiling, because a client that sent too much has exactly one
 *    useful next move either way.
 *  - `400` means the request is malformed in a way retrying will not fix.
 *  - `502` means a pass failed. It degrades the page to "not scanned" and the
 *    badge says so — which is the whole reason it is not a `200` with no spans.
 */
import type { ServerResponse } from 'node:http';
import { LIMITS, type DetectChunkRequest, type DetectHint, type DetectRequest } from '../lib/protocol.ts';
import { isCls } from '../lib/types.ts';
import { DetectionUnavailable, type DetectEngine } from '../detect/engine.ts';
import { sendError, sendJson } from '../http.ts';
import type { Logger } from '../log.ts';

const HOST_CLASSES = new Set(['native', 'trusted', 'untrusted']);

export type ParseResult =
  | { ok: true; request: DetectRequest; droppedHints: number }
  | { ok: false; status: number; error: string; message: string };

/**
 * Validates a body into a `DetectRequest`, or into the status the client should
 * see. Hints are the one part treated leniently: they are advisory (SPEC §3.2),
 * so a malformed hint is dropped and counted rather than failing a request whose
 * text is perfectly detectable.
 */
export function parseDetectRequest(raw: unknown, fallbackLocale: string): ParseResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, status: 400, error: 'bad_request', message: 'body is not a JSON object' };
  }
  const body = raw as Record<string, unknown>;

  if (typeof body.policyVersion !== 'string' || !body.policyVersion) {
    return { ok: false, status: 400, error: 'bad_request', message: 'policyVersion must be a non-empty string' };
  }
  if (typeof body.hostClass !== 'string' || !HOST_CLASSES.has(body.hostClass)) {
    // "Reject anything else rather than guessing" (ENDPOINTS.md §3): the class
    // decides how the answer may be used, so a default would be a policy choice
    // made in the wrong place.
    return { ok: false, status: 400, error: 'bad_request', message: `hostClass must be native|trusted|untrusted, got ${JSON.stringify(body.hostClass)}` };
  }
  const locale = typeof body.locale === 'string' && body.locale ? body.locale : fallbackLocale;
  if (!Array.isArray(body.chunks)) {
    return { ok: false, status: 400, error: 'bad_request', message: 'chunks must be an array' };
  }

  const chunks: DetectChunkRequest[] = [];
  let droppedHints = 0;
  let totalChars = 0;
  for (const [index, entry] of body.chunks.entries()) {
    if (!entry || typeof entry !== 'object') {
      return { ok: false, status: 400, error: 'bad_request', message: `chunks[${index}] is not an object` };
    }
    const chunk = entry as Record<string, unknown>;
    if (typeof chunk.id !== 'string' || !chunk.id) {
      return { ok: false, status: 400, error: 'bad_request', message: `chunks[${index}].id must be a non-empty string` };
    }
    if (typeof chunk.hash !== 'string' || !chunk.hash) {
      return { ok: false, status: 400, error: 'bad_request', message: `chunks[${index}].hash must be a non-empty string` };
    }
    if (typeof chunk.text !== 'string') {
      return { ok: false, status: 400, error: 'bad_request', message: `chunks[${index}].text must be a string` };
    }
    // UTF-16 code units, the unit the caps are stated in and the unit offsets use.
    if (chunk.text.length > LIMITS.maxChunkChars) {
      return { ok: false, status: 413, error: 're_split', message: `chunks[${index}] is over ${LIMITS.maxChunkChars} characters` };
    }
    totalChars += chunk.text.length;

    const { hints, dropped } = parseHints(chunk.hints, chunk.text.length);
    droppedHints += dropped;
    chunks.push(hints.length ? { id: chunk.id, hash: chunk.hash, text: chunk.text, hints } : { id: chunk.id, hash: chunk.hash, text: chunk.text });
  }

  if (chunks.length > LIMITS.maxChunks) {
    return { ok: false, status: 413, error: 're_split', message: `over ${LIMITS.maxChunks} chunks` };
  }
  if (totalChars > LIMITS.maxTotalChars) {
    return { ok: false, status: 413, error: 're_split', message: `over ${LIMITS.maxTotalChars} characters in total` };
  }

  return {
    ok: true,
    droppedHints,
    request: { policyVersion: body.policyVersion, locale, hostClass: body.hostClass as DetectRequest['hostClass'], chunks },
  };
}

function parseHints(raw: unknown, textLength: number): { hints: DetectHint[]; dropped: number } {
  if (raw === undefined) return { hints: [], dropped: 0 };
  if (!Array.isArray(raw)) return { hints: [], dropped: 1 };
  const hints: DetectHint[] = [];
  let dropped = 0;
  for (const entry of raw) {
    const hint = entry as Partial<DetectHint> | null;
    if (
      !hint ||
      typeof hint !== 'object' ||
      !Number.isInteger(hint.start) ||
      !Number.isInteger(hint.end) ||
      (hint.start as number) < 0 ||
      (hint.end as number) > textLength ||
      (hint.start as number) >= (hint.end as number) ||
      typeof hint.cls !== 'string' ||
      !isCls(hint.cls)
    ) {
      dropped++;
      continue;
    }
    hints.push({ start: hint.start as number, end: hint.end as number, cls: hint.cls, origin: 'annotation' });
  }
  return { hints, dropped };
}

export interface DetectRouteContext {
  engine: DetectEngine;
  fallbackLocale: string;
  logger: Logger;
}

export async function handleDetect(rawBody: string, res: ServerResponse, ctx: DetectRouteContext): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return sendError(res, 400, 'bad_json', 'body did not parse as JSON');
  }

  const result = parseDetectRequest(parsed, ctx.fallbackLocale);
  if (!result.ok) {
    ctx.logger.warn('detect.rejected', { status: result.status, error: result.error, message: result.message });
    return sendError(res, result.status, result.error, result.message);
  }

  const { request, droppedHints } = result;
  const startedAt = process.hrtime.bigint();
  const before = ctx.engine.stats;

  let response;
  try {
    response = await ctx.engine.detect(request);
  } catch (err) {
    if (err instanceof DetectionUnavailable) {
      // Loud, never a quiet empty answer: the page degrades to "not scanned".
      ctx.logger.error('detect.unavailable', { reason: err.message, chunkCount: request.chunks.length });
      return sendError(res, 502, 'detector_unavailable', 'a detection pass failed; the page is not scanned');
    }
    throw err;
  }

  const after = ctx.engine.stats;
  const spans = response.chunks.reduce((n, c) => n + c.spans.length, 0);
  if (request.hostClass === 'untrusted') {
    // Text from an untrusted host should not be reaching a detector at all
    // (SPEC §1). Answer it, but never let it pass unremarked.
    ctx.logger.warn('detect.untrusted_host_class', { chunkCount: request.chunks.length });
  }
  ctx.logger.info('detect.ok', {
    hostClass: request.hostClass,
    policyVersion: request.policyVersion,
    locale: request.locale,
    chunkCount: request.chunks.length,
    chars: request.chunks.reduce((n, c) => n + c.text.length, 0),
    spanCount: spans,
    cacheHits: after.hits - before.hits,
    droppedHints,
    hashMismatches: after.hashMismatches - before.hashMismatches,
    ms: Number(process.hrtime.bigint() - startedAt) / 1e6,
  });
  sendJson(res, 200, response);
}
