/**
 * The egress gate — SPEC §10.
 *
 * Every mechanism in §8 controls what a *page* holds. This one controls what
 * leaves the browser, which is the only place the guarantee can actually be
 * made: on a collaborative destination there is no moment where the page holds
 * a complete value and has not yet sent it (§10.1).
 *
 * Pure and synchronous by construction. `WebSocket.send`, `XMLHttpRequest.send`
 * and `sendBeacon` return void or a boolean, so there is no round trip to be
 * had — the decision has to be made from what is already in hand (§10.3). That
 * constraint is what shapes everything here.
 *
 * **This is not a second detector.** Pass 1 matches values the page's own
 * registry already holds, which came from the backend (§3.1). Pass 2 is
 * checksum-anchored against `checksums.ts` — the one shared library §8.7.2
 * already requires the clone to validate against, so it cannot disagree with
 * the detector about what a valid IBAN is, and it adds no per-destination rule
 * pack.
 */
import { isValidAhv, isValidIban, isValidLuhn } from './checksums.ts';
import { normalizeValue } from './normalize.ts';
import { SIGIL } from './tokens.ts';
import type { Cls } from './types.ts';

export interface EgressMatch {
  start: number;
  end: number;
  cls: Cls;
  /** As it appears in the body. */
  value: string;
  /** Canonical form — the key a token is held under (SPEC §5.1). */
  normalized: string;
  /** Which pass found it, for the audit line and for QA. */
  via: 'registry' | 'checksum';
}

/** A value the page's registry already knows about, pushed down from §7's cache. */
export interface KnownValue {
  cls: Cls;
  value: string;
  normalized: string;
}

export type Verdict =
  /** Nothing sensitive in the body; forward it untouched. */
  | { kind: 'clean' }
  /** Every match had a token in hand; forward this instead. */
  | { kind: 'substituted'; body: string; replaced: EgressMatch[] }
  /**
   * The request does not go out (§10.4). Either the vault still owes us a token
   * — `missing` says which — or the body is positional and substituting into it
   * would corrupt the destination's document (§10.9.2).
   */
  | {
      kind: 'blocked';
      reason: 'no-token' | 'positional';
      missing: EgressMatch[];
      replaced: EgressMatch[];
    };

/**
 * Candidate shapes, deliberately loose. Each one is only a way to find
 * something worth running a checksum over; the checksum is what decides.
 * Widening these costs false candidates, never false positives.
 */
const CANDIDATES: ReadonlyArray<{ cls: Cls; re: RegExp; ok: (compact: string) => boolean }> = [
  {
    cls: 'IBAN',
    re: /\b[A-Z]{2}[0-9]{2}(?:[ -]?[A-Z0-9]){10,30}\b/g,
    ok: (c) => isValidIban(c),
  },
  {
    cls: 'CARD',
    re: /\b[0-9](?:[ -]?[0-9]){11,18}\b/g,
    ok: (c) => isValidLuhn(c),
  },
  {
    cls: 'AHV',
    re: /\b756(?:[.\s-]?[0-9]){10}\b/g,
    ok: (c) => isValidAhv(c),
  },
  {
    // No checksum exists; §8.7.2's "RFC-5322-lite" is the whole check.
    cls: 'EMAIL',
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z]{2,})+\b/g,
    ok: () => true,
  },
];

/** Tokens are not values. Finding one is the system working, not a leak. */
const TOKEN = new RegExp(`\\b${SIGIL}-[A-Z]{2,10}-[0-9A-HJKMNP-TV-Z]{17}\\b`, 'gi');

function tokenSpans(body: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  TOKEN.lastIndex = 0;
  for (const m of body.matchAll(TOKEN)) spans.push([m.index, m.index + m[0].length]);
  return spans;
}

const overlaps = (a: [number, number], b: [number, number]): boolean => a[0] < b[1] && b[0] < a[1];

/**
 * Find everything in `body` that must not leave as-is.
 *
 * Registry matches win over checksum matches on overlap: the registry carries
 * the class the *detector* assigned, and a locally-guessed class on the same
 * characters is the weaker claim (§3.3's precedence, applied here).
 */
export function findSensitive(
  body: string,
  known: readonly KnownValue[],
  opts: { country?: string } = {},
): EgressMatch[] {
  const found: EgressMatch[] = [];
  const skip = tokenSpans(body);
  const claimed: Array<[number, number]> = [...skip];

  const claim = (start: number, end: number): boolean => {
    const span: [number, number] = [start, end];
    if (claimed.some((c) => overlaps(c, span))) return false;
    claimed.push(span);
    return true;
  };

  // Pass 1 — literal, and the only pass that can see a PERSON or an ADDR, since
  // those have no intrinsic shape to anchor on. Longest first, so a full address
  // is not shadowed by a street name inside it.
  for (const entry of [...known].sort((a, b) => b.value.length - a.value.length)) {
    if (!entry.value) continue;
    let from = 0;
    for (;;) {
      const at = body.indexOf(entry.value, from);
      if (at < 0) break;
      from = at + entry.value.length;
      if (!claim(at, from)) continue;
      found.push({
        start: at,
        end: from,
        cls: entry.cls,
        value: entry.value,
        normalized: entry.normalized,
        via: 'registry',
      });
    }
  }

  // Pass 2 — the typed-in-place case the registry has never seen, and the whole
  // reason this gate exists (§10.1).
  for (const candidate of CANDIDATES) {
    candidate.re.lastIndex = 0;
    for (const m of body.matchAll(candidate.re)) {
      const value = m[0];
      const start = m.index;
      const end = start + value.length;
      const normalized = normalizeValue(candidate.cls, value, opts);
      if (!candidate.ok(normalized)) continue;
      if (!claim(start, end)) continue;
      found.push({ start, end, cls: candidate.cls, value, normalized, via: 'checksum' });
    }
  }

  return found.sort((a, b) => a.start - b.start);
}

/**
 * Decide what happens to one outbound body.
 *
 * `tokenFor` is a synchronous cache read, exactly as §7's copy handler is: the
 * token is minted while the value is being detected, not while the request is
 * being sent. A miss is not a reason to invent one — it is a reason to stop.
 */
export function inspect(
  body: string,
  known: readonly KnownValue[],
  tokenFor: (normalized: string, cls: Cls) => string | undefined,
  opts: { country?: string; allowSubstitute?: boolean } = {},
): Verdict {
  const matches = findSensitive(body, known, opts);
  if (matches.length === 0) return { kind: 'clean' };

  /**
   * A positional body carrying a value has no good outcome: forwarding it leaks,
   * and substituting a 29-character token for a value of another length moves
   * every offset after it and corrupts the destination's document. Holding it is
   * the only arm that is merely inconvenient (§10.9.2).
   */
  if (opts.allowSubstitute === false) {
    return { kind: 'blocked', reason: 'positional', missing: matches, replaced: [] };
  }

  const replaced: EgressMatch[] = [];
  const missing: EgressMatch[] = [];
  let out = '';
  let cursor = 0;

  for (const match of matches) {
    const token = tokenFor(match.normalized, match.cls);
    if (token === undefined) {
      missing.push(match);
      continue;
    }
    out += body.slice(cursor, match.start) + token;
    cursor = match.end;
    replaced.push(match);
  }
  out += body.slice(cursor);

  // Fail closed: a body we could only partly tokenise still carries the part we
  // could not, so it is not a body that may leave (§10.4).
  if (missing.length > 0) return { kind: 'blocked', reason: 'no-token', missing, replaced };
  return { kind: 'substituted', body: out, replaced };
}
