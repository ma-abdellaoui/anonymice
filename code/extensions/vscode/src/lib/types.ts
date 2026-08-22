/** Shared vocabulary. SPEC §3, §7. */

/**
 * Detection classes. `UNKNOWN` is an annotation with no class stated.
 * `SECRET` is credential material — passwords, API keys, private keys. Tier A only:
 * no reserved range exists to format-preserve against (browser SPEC §6.5).
 *
 * PART OF THE TOKEN FORMAT. The class label sits inside the token, and both
 * extensions share one vault, so this list is duplicated byte-for-byte in
 * `browser/src/lib/types.ts`. Change both together — see `npm run format-parity`.
 */
export const CLASSES = [
  'PERSON', 'IBAN', 'CARD', 'AHV', 'PHONE', 'EMAIL', 'ADDR', 'ORG', 'SECRET', 'UNKNOWN',
] as const;
export type Cls = (typeof CLASSES)[number];

export function isCls(v: string): v is Cls {
  return (CLASSES as readonly string[]).includes(v);
}

/**
 * Resource class (SPEC §3). Note this is not the browser's host class: it no
 * longer controls what may be displayed — SPEC §2.3 does that unconditionally —
 * only where plaintext may live and who may resolve it.
 */
export type ResourceClass = 'NATIVE' | 'TRUSTED' | 'UNTRUSTED';

/** How a resolved value is rendered against its token (SPEC §7.2). */
export type RevealMode = 'annotate' | 'substitute' | 'off';
