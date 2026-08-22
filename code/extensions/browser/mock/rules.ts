/**
 * Mock detection backend passes — stands in for the service of SPEC §3.1 until
 * it exists. Deliberately server-side-shaped: the client never imports this.
 *
 * The rule pass is real (regex + the shared checksums). The "model" pass is a
 * deterministic gazetteer, not an LLM: it exists so the eval can score the
 * `model` origin and so determinism (SPEC §3.2) holds under repeat calls.
 */
import { isValidAhv, isValidIban, isValidLuhn } from '../src/lib/checksums.ts';
import { normalizeValue } from '../src/lib/normalize.ts';
import type { DetectSpan } from '../src/lib/protocol.ts';
import type { Cls } from '../src/lib/types.ts';

export const MODEL_VERSION = 'det-mock-1';

interface RuleDef {
  cls: Cls;
  re: RegExp;
  /** Checksum over the compact form; a rule span exists only if this passes. */
  verify?: (compact: string) => boolean;
}

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
];

/** Deterministic rule pass: regex plus checksum, no guessing. */
export function rulePass(text: string, locale: string): DetectSpan[] {
  const spans: DetectSpan[] = [];
  const country = locale.split('-')[1];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (const m of text.matchAll(rule.re)) {
      const raw = m[0];
      const start = m.index;
      if (start === undefined) continue;
      const compact = normalizeValue(rule.cls, raw, country ? { country } : {});
      if (rule.verify && !rule.verify(compact)) continue;
      spans.push({
        start,
        end: start + raw.length,
        cls: rule.cls,
        normalized: compact,
        origin: 'rule',
      });
    }
  }
  return spans;
}

/**
 * Stand-in for the LLM pass. A gazetteer of given names plus a capitalised
 * surname, and a small ORG suffix list — enough shape for the eval, and honest
 * about being a stub.
 */
const GIVEN_NAMES = [
  'Anna', 'Andrea', 'Beat', 'Claudia', 'Daniel', 'Elena', 'Felix', 'Hans', 'Julia', 'Luca',
  'Marco', 'Maria', 'Martin', 'Nadia', 'Nicole', 'Peter', 'Sarah', 'Stefan', 'Thomas', 'Ursula',
];
const ORG_SUFFIXES = ['AG', 'GmbH', 'SA', 'Sàrl', 'Ltd', 'Holding'];

export function modelPass(text: string): DetectSpan[] {
  const spans: DetectSpan[] = [];

  const nameRe = new RegExp(
    `\\b(${GIVEN_NAMES.join('|')})\\s+([A-Z\\u00C0-\\u00DE][\\p{L}'\\u2019-]+)\\b`,
    'gu',
  );
  for (const m of text.matchAll(nameRe)) {
    if (m.index === undefined) continue;
    spans.push({
      start: m.index,
      end: m.index + m[0].length,
      cls: 'PERSON',
      normalized: normalizeValue('PERSON', m[0]),
      origin: 'model',
    });
  }

  const orgRe = new RegExp(
    `\\b([A-Z][\\p{L}&.-]*(?:\\s+[A-Z][\\p{L}&.-]*){0,3})\\s+(${ORG_SUFFIXES.join('|')})\\b`,
    'gu',
  );
  for (const m of text.matchAll(orgRe)) {
    if (m.index === undefined) continue;
    spans.push({
      start: m.index,
      end: m.index + m[0].length,
      cls: 'ORG',
      normalized: normalizeValue('ORG', m[0]),
      origin: 'model',
    });
  }

  return spans;
}

/** Both guessing passes, in the order the backend is authoritative for (SPEC §3.1). */
export function detectChunk(text: string, locale: string): DetectSpan[] {
  return [...rulePass(text, locale), ...modelPass(text)].sort(
    (a, b) => a.start - b.start || a.end - b.end || a.cls.localeCompare(b.cls),
  );
}
