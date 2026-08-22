/**
 * Bearer authentication — ENDPOINTS.md §4. One credential, two endpoints.
 *
 * Two properties worth the few extra lines:
 *
 *  - **Comparison is constant time and length-independent.** Both sides are
 *    SHA-256'd first, so `timingSafeEqual` gets two 32-byte buffers and neither
 *    the comparison nor the length of the buffers says anything about the
 *    credential.
 *  - **Every configured token is checked.** During a rotation
 *    (`DETECT_TOKEN_PREVIOUS`) both are live, so the fleet can move to the new
 *    one endpoint at a time instead of all at once.
 */
import { timingSafeEqual } from 'node:crypto';
import { sha256Hex } from './lib/hash.ts';

export function bearerFrom(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? null;
}

export function isAuthorized(header: string | undefined, tokens: readonly string[]): boolean {
  const presented = bearerFrom(header);
  if (presented === null) return false;
  const presentedDigest = Buffer.from(sha256Hex(presented), 'hex');
  // Every token is compared even after a match, so the time taken says nothing
  // about which credential (or how many) the server holds.
  let ok = false;
  for (const token of tokens) {
    if (timingSafeEqual(presentedDigest, Buffer.from(sha256Hex(token), 'hex'))) ok = true;
  }
  return ok;
}
