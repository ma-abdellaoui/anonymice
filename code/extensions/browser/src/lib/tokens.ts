/**
 * Tier A token format — SPEC §6.4.
 *
 * DUPLICATED BY DESIGN. This file exists byte-identically in both extensions
 * (`browser/src/lib/tokens.ts` and `vscode/src/lib/tokens.ts`) and is kept in
 * step by hand, not by a shared package. `diff` the two files; they must match
 * exactly. Do not extract a shared module.
 *
 *   ANM1-PERSON-K3F9QW2MX7VBNC4H8
 *   └┬─┘ └─┬──┘ └───────┬───────┘
 *    │     │            └─ 16 payload chars (80 bits) + 1 check char
 *    │     └─ class label, [A-Z]{2,10}
 *    └─ namespace + format version
 */
import { type Cls, isCls } from './types.ts';

/** Namespace + format version. Writers emit exactly one; readers accept all (SPEC §6.6). */
export const SIGIL = 'ANM1';

/** Crockford base32: 0-9 A-Z minus I, L, O, U. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PAYLOAD_LEN = 16;
const CHECK_LEN = 1;
const CORE_LEN = PAYLOAD_LEN + CHECK_LEN;

/**
 * Crockford decode aliases. `U` is deliberately absent: it is excluded from the
 * alphabet to avoid accidental profanity, so a `U` in a token is damage, not a
 * variant spelling.
 */
const ALIASES: Record<string, string> = { I: '1', L: '1', O: '0' };

/** Dropped outright before matching — rich editors inject these on copy (SPEC §6.4). */
const IGNORABLE = /[\u200B-\u200F\u00AD\u2060\uFEFF\u00A0]/g;
/** Every dash variant folds onto ASCII hyphen, which Crockford then ignores inside the core. */
const HYPHENS = /[\u2010-\u2015\u2212\uFE63\uFF0D]/g;

/**
 * Permissive scan, run over normalised text. Deliberately wider than the spec's
 * `/\bANM1-[A-Z]{2,10}-[0-9A-HJKMNP-TV-Z]{17}\b/gi`: it admits `I`/`L`/`O`/`U`
 * and hyphens inside the core so a mangled token is *found* and reported as
 * damaged rather than silently missed (SPEC §6.7).
 */
const SCAN = /\bANM1-([A-Z]{2,10})-((?:[0-9A-Z]-?){16}[0-9A-Z])\b/g;

export interface TokenMatch {
  /** The token as it appears, in canonical form. */
  token: string;
  cls: string;
  /** False when the label is well-formed but not in this build's vocabulary (SPEC §6.6). */
  knownCls: boolean;
  /** Offsets into the *original* string passed to `scanTokens`. */
  start: number;
  end: number;
}

export type ParseResult =
  | { kind: 'token'; token: string; cls: string; knownCls: boolean }
  /** Token-shaped but the check character disagrees — truncated or mistyped (SPEC §6.7). */
  | { kind: 'damaged'; cls: string | null }
  | { kind: 'none' };

function symbolValue(c: string): number {
  return ALPHABET.indexOf(c);
}

/**
 * Position-weighted sum mod 32. Its job is error *messaging*, not integrity —
 * the vault lookup is the real check (SPEC §6.4). Weighting by position is what
 * makes it catch a transposition, which is the common human error.
 */
function checkChar(payload: string): string {
  let sum = 0;
  for (let i = 0; i < payload.length; i++) {
    sum += (symbolValue(payload[i]!) + 1) * (i + 1);
  }
  return ALPHABET[sum % 32]!;
}

/** 10 bytes → exactly 16 symbols, no padding: 80 bits is 16×5. */
function encode80(bytes: Uint8Array): string {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(acc >>> bits) & 31]!;
    }
  }
  return out;
}

/**
 * Mint a fresh token. 80 bits from a CSPRNG, never derived from the plaintext
 * (SPEC §6.3) — any deterministic function of the value is brute-forceable by
 * whoever holds the tokens.
 */
export function mintToken(cls: Cls): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  const payload = encode80(bytes);
  return `${SIGIL}-${cls}-${payload}${checkChar(payload)}`;
}

/**
 * NFKC, strip zero-width, fold dashes, upper-case. Without this a token that has
 * been through a rich editor is a silent detection failure (SPEC §6.4).
 * Length-preserving except for `IGNORABLE`, which is why `scanTokens` maps
 * offsets rather than trusting them.
 */
function normalizeText(s: string): string {
  return s.normalize('NFKC').replace(IGNORABLE, '').replace(HYPHENS, '-').toUpperCase();
}

/** Strip the hyphens Crockford ignores on decode, then apply the decode aliases. */
function canonicalCore(raw: string): string {
  let out = '';
  for (const c of raw.replace(/-/g, '')) out += ALIASES[c] ?? c;
  return out;
}

function coreIsWellFormed(core: string): boolean {
  if (core.length !== CORE_LEN) return false;
  for (const c of core) if (!ALPHABET.includes(c)) return false;
  return true;
}

/**
 * Parse one string that is expected to *be* a token — the paste path, where the
 * whole clipboard payload is the candidate (SPEC §8.3 browser / §8.1 vscode).
 */
export function parseToken(input: string): ParseResult {
  const text = normalizeText(input).trim();
  const m = new RegExp(`^${SCAN.source}$`).exec(text);
  if (!m) {
    // Distinguish "damaged token" from "not a token at all" so the failure is
    // legible rather than silent (SPEC §6.7, last row).
    const loose = /^ANM1-([A-Z]{2,10})-([0-9A-Z-]{1,40})$/.exec(text);
    return loose ? { kind: 'damaged', cls: loose[1]! } : { kind: 'none' };
  }
  const cls = m[1]!;
  const core = canonicalCore(m[2]!);
  if (!coreIsWellFormed(core)) return { kind: 'damaged', cls };
  const payload = core.slice(0, PAYLOAD_LEN);
  if (core[PAYLOAD_LEN] !== checkChar(payload)) return { kind: 'damaged', cls };
  return { kind: 'token', token: `${SIGIL}-${cls}-${core}`, cls, knownCls: isCls(cls) };
}

/**
 * Find every token in a body of text, with offsets into the *original* string.
 *
 * Normalisation drops characters, so offsets into the normalised text would be
 * wrong for the caller. We therefore keep an index map from normalised position
 * back to source position rather than normalising in place.
 */
export function scanTokens(source: string): TokenMatch[] {
  // NFKC can change length per character, so normalise character by character
  // and record where each surviving character came from.
  let clean = '';
  const map: number[] = [];
  for (let i = 0; i < source.length; i++) {
    const ch = normalizeText(source[i]!);
    if (ch === '') continue;
    for (const c of ch) {
      clean += c;
      map.push(i);
    }
  }
  map.push(source.length);

  const out: TokenMatch[] = [];
  const re = new RegExp(SCAN.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) {
    const cls = m[1]!;
    const core = canonicalCore(m[2]!);
    if (!coreIsWellFormed(core)) continue;
    if (core[PAYLOAD_LEN] !== checkChar(core.slice(0, PAYLOAD_LEN))) continue;
    out.push({
      token: `${SIGIL}-${cls}-${core}`,
      cls,
      knownCls: isCls(cls),
      start: map[m.index]!,
      end: map[m.index + m[0].length]!,
    });
  }
  return out;
}

/** Cheap synchronous pre-filter before committing to a vault lookup (SPEC §6.4). */
export function looksLikeToken(s: string): boolean {
  return normalizeText(s).includes(`${SIGIL}-`);
}
