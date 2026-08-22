/**
 * The synchronous local rule pass — SPEC §8.1.
 *
 * Deliberately narrow: only classes with a checksum or an unambiguous shape, so
 * a paste is never tokenised on a guess. Everything probabilistic stays with the
 * backend, which is the single guessing authority (browser SPEC §3.1).
 */
import type { Cls } from './types.ts';

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return digits.length >= 12 && sum % 10 === 0;
}

const IBAN_LEN: Record<string, number> = {
  CH: 21, DE: 22, FR: 27, AT: 20, GB: 22, IT: 27, ES: 24, NL: 18, BE: 16, LI: 21,
};

function ibanValid(compact: string): boolean {
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/.test(compact)) return false;
  const expected = IBAN_LEN[compact.slice(0, 2)];
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

/** High-confidence credential shapes. Vendor-prefixed keys only — no entropy heuristics. */
const SECRET_PATTERNS: RegExp[] = [
  /^gh[pousr]_[A-Za-z0-9]{36,}$/,
  /^sk-[A-Za-z0-9_-]{20,}$/,
  /^sk-ant-[A-Za-z0-9_-]{20,}$/,
  /^AKIA[0-9A-Z]{16}$/,
  /^xox[baprs]-[A-Za-z0-9-]{10,}$/,
  /^-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

export function quickClassify(input: string): { cls: Cls; normalized: string } | undefined {
  const text = input.trim();
  if (text === '') return undefined;

  for (const re of SECRET_PATTERNS) {
    if (re.test(text)) return { cls: 'SECRET', normalized: text };
  }

  // Separators stripped exactly as the shared normaliser does for structured
  // classes (browser SPEC §5.1) — dots included, or `756.1234.5678.97` never
  // reaches the checksum. Email is matched against `text`, not this.
  const compact = text.replace(/[\s\-.()/]/g, '').toUpperCase();

  if (ibanValid(compact)) return { cls: 'IBAN', normalized: compact };
  if (ahvValid(compact)) return { cls: 'AHV', normalized: compact };
  if (/^[0-9]+$/.test(compact) && luhn(compact)) return { cls: 'CARD', normalized: compact };

  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
    const at = text.lastIndexOf('@');
    return { cls: 'EMAIL', normalized: text.slice(0, at) + '@' + text.slice(at + 1).toLowerCase() };
  }

  return undefined;
}
