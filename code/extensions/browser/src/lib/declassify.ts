/**
 * Declassification — SPEC §8.5.
 *
 * The exit from the token scheme, and the one operation that deliberately puts
 * plaintext back into an untrusted page. The user pastes an IBAN, clears the
 * field and types `invoice ref 12`; that is not sensitive, and emitting a token
 * for it puts a token where the destination expects a plain string.
 *
 * What governs it is **not** "did it stop classifying" but **whether the new
 * value is a descendant of the old one**. A prefix, a truncation, a re-spacing —
 * each of those is the typed-prefix leak arriving by another route, and each is
 * refused. Only a genuine replacement is written through.
 *
 * Deliberately conservative in one direction only: a false refusal costs the
 * user a token where they wanted text, which is visible and recoverable. A false
 * declassification writes a fragment of a secret into a page whose JavaScript
 * reads everything, which is neither.
 */
import { isValidAhv, isValidIban, isValidLuhn } from './checksums.ts';
import { baseNormalize, normalizeValue } from './normalize.ts';
import type { Cls } from './types.ts';

export type Verdict =
  /** Still sensitive: mint or reuse a token for the new value. */
  | { kind: 'tokenize'; cls: Cls; normalized: string }
  /** A fragment of the resolved plaintext. Hold the token; write nothing. */
  | { kind: 'refuse'; reason: 'prefix' | 'fragment' }
  /** A genuine replacement. Write the literal through and sever the lineage. */
  | { kind: 'declassify' };

/**
 * The comparison form. Separators go, because "re-spacing" is named in §8.5 as a
 * fragment rather than a replacement — `CH93 0076` and `CH930076` are the same
 * secret typed two ways, and a test that could not see that would pass one of
 * them straight through.
 */
export function fold(s: string): string {
  return baseNormalize(s)
    .toLowerCase()
    .replace(/[\s\-.()/]/g, '');
}

/**
 * Length of the longest substring the two share.
 *
 * The rolling row keeps this O(n) in space over values that are, in practice,
 * tens of characters — a field the user is typing into, not a document.
 */
export function longestCommonSubstring(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0;
  let best = 0;
  let previous = new Uint32Array(b.length + 1);
  let current = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        const run = previous[j - 1]! + 1;
        current[j] = run;
        if (run > best) best = run;
      } else {
        current[j] = 0;
      }
    }
    [previous, current] = [current, previous];
    current.fill(0);
  }
  return best;
}

/**
 * The floor from §8.5: `min(4, ⌈len/2⌉)`.
 *
 * Four characters for anything of ordinary length, and *less* for a short value —
 * a fixed 4 would pass trivially on a five-character secret, which is exactly
 * where a shared run of three matters most.
 */
export function shareThreshold(resolvedLength: number): number {
  return Math.min(4, Math.ceil(resolvedLength / 2));
}

/**
 * Classes with a checksum of their own. Everything else has no local answer:
 * `PERSON`, `ADDR` and `ORG` are the backend's to judge (SPEC §3.1), so a clone
 * showing one must not draw it as invalid merely because it cannot check it.
 */
const CHECKSUMMED = new Set<Cls>(['IBAN', 'CARD', 'AHV', 'EMAIL', 'PHONE']);

export function hasIntrinsicCheck(cls: Cls): boolean {
  return CHECKSUMMED.has(cls);
}

/**
 * Does the value still satisfy its own class?
 *
 * Only the checksummed classes can be answered here, from the same library the
 * backend's rule pass uses (SPEC §8.7.2) — so the clone can never disagree with
 * the detector about what a valid IBAN is. `PERSON`, `ADDR` and `ORG` have no
 * checksum and the backend is the only authority on them (SPEC §3.1), so the
 * honest local answer is "cannot say", and the fragment test below is what keeps
 * that safe.
 */
export function stillClassifies(cls: Cls, value: string, country?: string): boolean {
  const compact = normalizeValue(cls, value, country ? { country } : {});
  switch (cls) {
    case 'IBAN':
      return isValidIban(compact);
    case 'CARD':
      return isValidLuhn(compact);
    case 'AHV':
      return isValidAhv(compact);
    case 'EMAIL':
      return /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(compact);
    case 'PHONE':
      return /^\+?\d{7,15}$/.test(compact);
    default:
      return false;
  }
}

/**
 * What should happen to a field whose revealed value has been edited to `next`.
 *
 * `resolved` is the plaintext the token stood for. Both are the *committed*
 * value, not a keystroke: this runs on blur, because judging a value mid-word
 * would refuse every edit at the moment it is half-typed.
 */
export function judgeEdit(
  cls: Cls,
  next: string,
  resolved: string,
  country?: string,
): Verdict {
  const nextFolded = fold(next);
  const resolvedFolded = fold(resolved);

  // Unchanged: nothing to decide, and re-minting would churn the vault.
  if (nextFolded === resolvedFolded) return { kind: 'tokenize', cls, normalized: normalizeValue(cls, next, country ? { country } : {}) };

  // An empty field holds no secret and no fragment of one. Refusing here would
  // make a field the user cleared impossible to clear.
  if (nextFolded.length === 0) return { kind: 'declassify' };

  // "a hand-typed second IBAN is not a declassification" (§8.5).
  if (stillClassifies(cls, next, country)) {
    return { kind: 'tokenize', cls, normalized: normalizeValue(cls, next, country ? { country } : {}) };
  }

  // A prefix of any length at all. Length-independent on purpose: the typed
  // prefix is the leak this whole design exists to prevent, so `C` of an IBAN is
  // refused as firmly as `CH9300762`.
  if (resolvedFolded.startsWith(nextFolded)) return { kind: 'refuse', reason: 'prefix' };

  if (longestCommonSubstring(nextFolded, resolvedFolded) >= shareThreshold(resolvedFolded.length)) {
    return { kind: 'refuse', reason: 'fragment' };
  }

  return { kind: 'declassify' };
}

export interface AuditEntry {
  /** What the field held before, as a class — never the value. */
  cls: Cls;
  /**
   * A digest of the literal that was written through, not the literal. The audit
   * has to answer "what happened" without becoming a second copy of the data the
   * rest of this design keeps out of reach (SPEC §8.5).
   */
  literalHash: string;
  at: number;
  destinationOrigin: string;
}
