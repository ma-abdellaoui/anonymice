/**
 * Normalisation is mechanical, never inferential — SPEC §5.1.
 *
 * Two different normal forms are in play and must not be confused:
 *   - wire text is NFC, because offsets are UTF-16 code units over NFC (SPEC §3.2)
 *   - identity uses NFKC, because `normalized` decides which values collapse
 */
import type { Cls } from './types.ts';

/** Zero-width and format characters stripped before anything else (SPEC §5.1). */
const FORMAT_CHARS = /[\u200B-\u200F\u00AD\u2060\uFEFF]/g;
const WHITESPACE_RUN = /\s+/g;
/** Separators removed from structured classes only. */
const SEPARATORS = /[\s\-.()/]/g;

/** NFC form used for chunk text on the wire. */
export function toWireText(s: string): string {
  return s.normalize('NFC');
}

/** The step every class shares. */
export function baseNormalize(s: string): string {
  return s.normalize('NFKC').replace(FORMAT_CHARS, '').replace(WHITESPACE_RUN, ' ').trim();
}

const STRUCTURED: ReadonlySet<Cls> = new Set<Cls>(['IBAN', 'CARD', 'AHV', 'PHONE']);

export interface NormalizeOptions {
  /** ISO-3166 alpha-2, used only to put a national PHONE into E.164. */
  country?: string;
}

const DIALLING_CODES: Record<string, string> = { CH: '41', DE: '49', FR: '33', AT: '43', GB: '44', US: '1' };

/**
 * Canonical form of a value. Same `normalized` ⇒ same spanId ⇒ same vault entry.
 * Deliberately does no entity resolution: "MEIER, Anna" does not become
 * "Anna Meier" (SPEC §5.1 — over-merge is silent and unrecoverable).
 */
export function normalizeValue(cls: Cls, value: string, opts: NormalizeOptions = {}): string {
  const base = baseNormalize(value);

  if (cls === 'EMAIL') {
    // Local part stays byte-exact: case is significant and +tag is a different address.
    const at = base.lastIndexOf('@');
    if (at < 0) return base;
    return base.slice(0, at) + '@' + base.slice(at + 1).toLowerCase();
  }

  if (cls === 'PHONE') return normalizePhone(base, opts.country);

  if (STRUCTURED.has(cls)) return base.replace(SEPARATORS, '').toUpperCase();

  // Free text (PERSON, ADDR, ORG, UNKNOWN): case-fold, and nothing else.
  return base.toLowerCase();
}

function normalizePhone(base: string, country?: string): string {
  const trimmed = base.replace(SEPARATORS, '');
  if (trimmed.startsWith('+')) return '+' + trimmed.slice(1).replace(/\D/g, '');
  if (trimmed.startsWith('00')) return '+' + trimmed.slice(2).replace(/\D/g, '');
  const digits = trimmed.replace(/\D/g, '');
  const code = country ? DIALLING_CODES[country.toUpperCase()] : undefined;
  // Only promote to E.164 when the country is actually known (SPEC §5.1).
  if (code && digits.startsWith('0')) return '+' + code + digits.slice(1);
  if (code) return '+' + code + digits;
  return digits;
}
