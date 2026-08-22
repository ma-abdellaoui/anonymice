/**
 * Chunk hashing, server side.
 *
 * Must agree byte for byte with `browser/src/lib/digest.ts`, which computes the
 * same digest through WebCrypto — `test/hash.test.ts` asserts that against the
 * browser implementation directly rather than trusting the two to stay in step.
 *
 * The hash is `sha256:<hex>` over the NFC-normalised chunk text (SPEC §3.2).
 */
import { createHash } from 'node:crypto';

export function chunkHash(nfcText: string): string {
  return `sha256:${createHash('sha256').update(nfcText.normalize('NFC'), 'utf8').digest('hex')}`;
}

/** Constant-time-ish equality for opaque strings of unequal length. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
