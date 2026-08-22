/**
 * The rule pass — deterministic detection, SPEC §3.3.
 *
 * Regex plus a class-intrinsic checksum, never a guess: a candidate that fails
 * mod-97, Luhn or the AHV check digit is not returned at all. The checksums are
 * the client's own library, vendored and diffed by `npm run parity`, so the
 * clone's validation (SPEC §8.7) cannot disagree with the detector about what a
 * valid IBAN is.
 *
 * Offsets come straight from `RegExp` match indices, which are UTF-16 code units
 * over the string as received — the unit the protocol specifies (SPEC §3.2).
 * That is why the pass never converts to codepoints anywhere: the conversion is
 * the bug it would introduce.
 *
 * `RULES_VERSION` is part of `modelVersion` on the wire, so editing anything in
 * this file must bump it — that string is what invalidates every cached span in
 * every service worker in the fleet.
 */
import { isValidAhv, isValidIban, isValidLuhn } from '../lib/checksums.ts';
import { baseNormalize, normalizeValue } from '../lib/normalize.ts';
import type { DetectSpan } from '../lib/protocol.ts';
import type { Cls } from '../lib/types.ts';

export const RULES_VERSION = 'rules-1';

interface RuleDef {
  cls: Cls;
  re: RegExp;
  /** Checksum over the compact form; a rule span exists only if this passes. */
  verify?: (compact: string) => boolean;
  /**
   * Canonical form, when `normalizeValue`'s class table does not cover the class.
   * See the `SECRET` note below.
   */
  normalize?: (raw: string) => string;
}

/**
 * `SECRET` has no row in the SPEC §5.1 normalisation table — the table covers
 * structured, `EMAIL` and free text (`PERSON`, `ADDR`, `ORG`), and `SECRET`
 * falls through `normalizeValue` into the free-text branch, which case-folds.
 * Case-folding credential material is wrong twice over: `AKIA…` and `akia…` are
 * not the same key, and two distinct secrets differing only in case would
 * collapse onto one vault entry. So the rule pass states the canonical form
 * itself — base normalisation only, case preserved — and the client never
 * recomputes it, because a span that arrives with `normalized` set is used as
 * given (registry.ts).
 */
const secretNormalize = (raw: string): string => baseNormalize(raw);

const RULES: RuleDef[] = [
  {
    cls: 'IBAN',
    // One alnum per step, optional single space: a trailing short group
    // ("... 5295 7") must not truncate the match, or the checksum sees 20 of 21.
    re: /\b[A-Z]{2}[0-9]{2}(?:[ ]?[A-Z0-9]){11,30}\b/g,
    verify: (c) => isValidIban(c),
  },
  {
    cls: 'AHV',
    re: /\b756[.\s]?[0-9]{4}[.\s]?[0-9]{4}[.\s]?[0-9]{2}\b/g,
    verify: (c) => isValidAhv(c),
  },
  {
    cls: 'CARD',
    re: /\b(?:[0-9]{4}[ -]?){3}[0-9]{1,4}\b/g,
    verify: (c) => isValidLuhn(c),
  },
  {
    cls: 'EMAIL',
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    cls: 'PHONE',
    re: /(?:\+41|0041|\+49|\+33|\+44)[ ]?(?:[0-9][ ]?){8,12}|\b0[0-9]{2}[ ][0-9]{3}[ ][0-9]{2}[ ][0-9]{2}\b/g,
  },
  // Credential material. Every pattern here is a *shaped* credential — a fixed
  // prefix and a fixed length — never "a long random-looking string", because
  // entropy heuristics fire on minified JavaScript, cache busters and content
  // hashes, and a false SECRET on a NATIVE page paints a highlight over
  // something no one can copy as a token.
  { cls: 'SECRET', re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/g, normalize: secretNormalize },
  { cls: 'SECRET', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, normalize: secretNormalize },
  { cls: 'SECRET', re: /\bgh[pousr]_[A-Za-z0-9]{36,251}\b/g, normalize: secretNormalize },
  { cls: 'SECRET', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, normalize: secretNormalize },
  { cls: 'SECRET', re: /\bAIza[0-9A-Za-z_-]{35}\b/g, normalize: secretNormalize },
  { cls: 'SECRET', re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{24,}\b/g, normalize: secretNormalize },
  {
    cls: 'SECRET',
    // A JWT: three base64url segments, the first of which decodes to `{"`.
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    normalize: secretNormalize,
  },
];

export function rulePass(text: string, locale: string): DetectSpan[] {
  const spans: DetectSpan[] = [];
  const country = locale.split('-')[1];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (const m of text.matchAll(rule.re)) {
      const raw = m[0];
      const start = m.index;
      if (start === undefined) continue;
      const normalized = rule.normalize
        ? rule.normalize(raw)
        : normalizeValue(rule.cls, raw, country ? { country } : {});
      if (rule.verify && !rule.verify(normalized)) continue;
      spans.push({ start, end: start + raw.length, cls: rule.cls, normalized, origin: 'rule' });
    }
  }
  return spans;
}
