/**
 * The client-side rule pass — browser SPEC §3.1, §3.3.
 *
 * Deterministic only: regex plus a checksum. No entropy heuristics, no
 * name lists, nothing probabilistic. That is what makes it safe to run here
 * rather than on the backend — a deterministic rule cannot disagree with the
 * backend's copy of the same rule, so the highlight and the token can never
 * diverge (browser §3.1).
 *
 * Its recall is therefore partial by construction: PERSON, ADDR and ORG are not
 * findable this way and are not attempted. Callers must not present "no
 * findings" as "no sensitive data" (browser §3.2, failure semantics).
 */
import { scanTokens } from './tokens.ts';
import type { Cls } from './types.ts';

export interface Finding {
  start: number;
  end: number;
  cls: Cls;
  /** As it appears in the text, in its own formatting. */
  value: string;
  /** Canonical form; identity for the vault (browser §5.1). */
  normalized: string;
  /** Which rule fired, for "why is this flagged?". */
  rule: string;
}

// ---------------------------------------------------------------- checksums

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

const IBAN_LEN: Record<string, number> = {
  AT: 20, BE: 16, CH: 21, DE: 22, DK: 18, ES: 24, FI: 18, FR: 27, GB: 22, IE: 22,
  IT: 27, LI: 21, LU: 20, NL: 18, NO: 15, PL: 28, PT: 25, SE: 24,
};

function ibanValid(compact: string): boolean {
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}$/.test(compact)) return false;
  const expected = IBAN_LEN[compact.slice(0, 2)];
  // An unknown country is not a reason to reject, but a known one with the wrong
  // length is: that is what makes the country table worth carrying.
  if (expected !== undefined && compact.length !== expected) return false;
  const moved = compact.slice(4) + compact.slice(0, 4);
  let rem = 0;
  for (const c of moved) {
    const v = c >= 'A' && c <= 'Z' ? String(c.charCodeAt(0) - 55) : c;
    for (const d of v) rem = (rem * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}

function ahvValid(compact: string): boolean {
  if (!/^756[0-9]{10}$/.test(compact)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += (compact.charCodeAt(i) - 48) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10 === compact.charCodeAt(12) - 48;
}

/**
 * Luhn alone is far too weak to flag a digit run in source code: roughly one in
 * ten random 16-digit strings passes it, and source is full of ids and
 * timestamps. Requiring a real issuer prefix and a real card length is what
 * turns this from a nuisance into a rule.
 */
function cardIssuer(digits: string): string | undefined {
  const n = digits.length;
  const p2 = Number(digits.slice(0, 2));
  const p4 = Number(digits.slice(0, 4));
  if (n === 16 && digits[0] === '4') return 'visa';
  if (n === 13 && digits[0] === '4') return 'visa';
  if (n === 19 && digits[0] === '4') return 'visa';
  if (n === 16 && p2 >= 51 && p2 <= 55) return 'mastercard';
  if (n === 16 && p4 >= 2221 && p4 <= 2720) return 'mastercard';
  if (n === 15 && (p2 === 34 || p2 === 37)) return 'amex';
  if (n === 16 && (digits.startsWith('6011') || p2 === 65)) return 'discover';
  if (n === 16 && p2 === 35) return 'jcb';
  if (n === 14 && (p2 === 36 || p2 === 38 || (p2 === 30 && '05'.includes(digits[2]!)))) return 'diners';
  return undefined;
}

// ------------------------------------------------------------------- rules

const SECRET_RULES: { name: string; re: RegExp }[] = [
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  { name: 'openai-key', re: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\b/g },
  { name: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'aws-access-key-id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'stripe-key', re: /\b[sr]k_(?:live|test)_[0-9A-Za-z]{16,}\b/g },
  { name: 'private-key-block', re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g },
];

// Grouping-agnostic on purpose: an IBAN may be printed in 4s, a card in 4-6-5
// (Amex) or unspaced. The candidate is deliberately greedy and the exact extent
// is decided afterwards by length, so trailing text cannot swallow a valid match.
const IBAN_CANDIDATE = /\b[A-Z]{2}[0-9]{2}(?:[ ]?[A-Z0-9]){8,32}\b/g;
const CARD_CANDIDATE = /(?<![0-9A-Za-z._-])[0-9](?:[ -]?[0-9]){11,25}(?![0-9A-Za-z._-])/g;
const AHV_CANDIDATE = /(?<![0-9])756[.\s]?[0-9]{4}[.\s]?[0-9]{4}[.\s]?[0-9]{2}(?![0-9])/g;
const EMAIL_CANDIDATE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

function compact(s: string): string {
  return s.replace(/[\s\-.()/]/g, '').toUpperCase();
}

/**
 * Compact form plus a map from each compact character back to its source index,
 * so a finding trimmed by length still reports offsets that index the document.
 */
function compactWithMap(raw: string, offset: number): { text: string; map: number[] } {
  let text = '';
  const map: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (/[\s\-.()/]/.test(ch)) continue;
    text += ch.toUpperCase();
    map.push(offset + i);
  }
  return { text, map };
}

/**
 * A greedy candidate may have run past the end of the real value. Try each
 * plausible length longest-first and keep the first that validates.
 */
function firstValidPrefix(
  cand: { text: string; map: number[] },
  lengths: readonly number[],
  valid: (s: string) => boolean,
): { normalized: string; start: number; end: number } | undefined {
  for (const n of lengths) {
    if (n > cand.text.length) continue;
    const slice = cand.text.slice(0, n);
    if (!valid(slice)) continue;
    return { normalized: slice, start: cand.map[0]!, end: cand.map[n - 1]! + 1 };
  }
  return undefined;
}

const IBAN_LENGTHS = Array.from({ length: 20 }, (_, i) => 34 - i);
const CARD_LENGTHS = [19, 16, 15, 14, 13] as const;

function push(out: Finding[], f: Finding): void {
  out.push(f);
}

/**
 * Find every rule-detectable value in `text`.
 *
 * Ranges already occupied by an ANM1 token are excluded: a value that is already
 * tokenised must never be offered for tokenisation again, and a token's payload
 * is alphanumeric enough to trip a candidate regex.
 */
export function detect(text: string): Finding[] {
  const taken: { start: number; end: number }[] = scanTokens(text).map((t) => ({ start: t.start, end: t.end }));
  const out: Finding[] = [];

  for (const { name, re } of SECRET_RULES) {
    for (const m of text.matchAll(re)) {
      push(out, {
        start: m.index, end: m.index + m[0].length,
        cls: 'SECRET', value: m[0], normalized: m[0].trim(), rule: name,
      });
    }
  }

  for (const m of text.matchAll(IBAN_CANDIDATE)) {
    const cand = compactWithMap(m[0], m.index);
    const country = cand.text.slice(0, 2);
    const known = IBAN_LEN[country];
    const hit = firstValidPrefix(cand, known !== undefined ? [known] : IBAN_LENGTHS, ibanValid);
    if (!hit) continue;
    push(out, {
      start: hit.start, end: hit.end, cls: 'IBAN',
      value: text.slice(hit.start, hit.end), normalized: hit.normalized, rule: 'iban-mod97',
    });
  }

  for (const m of text.matchAll(AHV_CANDIDATE)) {
    const c = compact(m[0]);
    if (!ahvValid(c)) continue;
    push(out, { start: m.index, end: m.index + m[0].length, cls: 'AHV', value: m[0], normalized: c, rule: 'ahv-ean13' });
  }

  for (const m of text.matchAll(CARD_CANDIDATE)) {
    const cand = compactWithMap(m[0], m.index);
    if (!/^[0-9]+$/.test(cand.text)) continue;
    let issuer: string | undefined;
    const hit = firstValidPrefix(cand, CARD_LENGTHS, (s) => {
      issuer = cardIssuer(s);
      return issuer !== undefined && luhn(s);
    });
    if (!hit) continue;
    push(out, {
      start: hit.start, end: hit.end, cls: 'CARD',
      value: text.slice(hit.start, hit.end), normalized: hit.normalized, rule: `card-luhn-${issuer}`,
    });
  }

  for (const m of text.matchAll(EMAIL_CANDIDATE)) {
    const at = m[0].lastIndexOf('@');
    push(out, {
      start: m.index, end: m.index + m[0].length, cls: 'EMAIL', value: m[0],
      normalized: m[0].slice(0, at) + '@' + m[0].slice(at + 1).toLowerCase(),
      rule: 'email',
    });
  }

  return resolveOverlaps(out, taken);
}

/**
 * Span algebra, reduced to what one deterministic layer needs (browser §3.3):
 * drop anything inside an existing token, then on an overlap keep the longer
 * finding. Widening rather than narrowing is the fail-closed direction.
 */
function resolveOverlaps(found: Finding[], taken: { start: number; end: number }[]): Finding[] {
  const kept: Finding[] = [];
  const sorted = [...found].sort((a, b) => a.start - b.start || b.end - a.end);
  for (const f of sorted) {
    if (taken.some((t) => f.start < t.end && t.start < f.end)) continue;
    const clash = kept.find((k) => f.start < k.end && k.start < f.end);
    if (clash) {
      if (f.end - f.start > clash.end - clash.start) kept[kept.indexOf(clash)] = f;
      continue;
    }
    kept.push(f);
  }
  return kept.sort((a, b) => a.start - b.start);
}

/** Counts by class, for an offer that names what it found (SPEC §6.1). */
export function summarize(findings: readonly Finding[]): string {
  const counts = new Map<Cls, number>();
  for (const f of findings) counts.set(f.cls, (counts.get(f.cls) ?? 0) + 1);
  return [...counts.entries()].map(([c, n]) => `${n} ${c}`).join(', ');
}
