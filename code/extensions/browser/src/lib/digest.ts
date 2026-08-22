/** SHA-256 helpers. Used for chunk hashes (SPEC §3.2) and spanIds (SPEC §5). */

const encoder = new TextEncoder();

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Cache key, response binding and staleness guard, all from one hash (SPEC §3.2). */
export async function chunkHash(nfcText: string): Promise<string> {
  return `sha256:${await sha256Hex(nfcText)}`;
}

/**
 * spanId — a deterministic digest of `normalized`, never a counter (SPEC §5).
 * Page-local: it is a digest of plaintext, so it never leaves the browser and is
 * never emitted (SPEC §5.2).
 */
export async function spanIdFor(normalized: string): Promise<string> {
  return await sha256Hex(normalized);
}
