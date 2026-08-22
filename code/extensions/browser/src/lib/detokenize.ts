/**
 * Ingress — SPEC §10.9.
 *
 * The mirror of `egress.ts`. Egress turns a value into a token on the way out;
 * this turns a token back into a value on the way in, so that a destination
 * storing tokens still renders as real data to the user.
 *
 * Without this half, `reveal: 'dom'` works exactly once. The user types a value,
 * it goes out as a token, and on the next page load the destination hands back
 * the token it stored — which is what the user then reads. Seamless requires
 * both directions.
 *
 * **The length rule.** A token is 29 characters and a value is whatever it is,
 * so every substitution moves the offset of everything after it. That is free
 * for a request/response body, which is re-parsed whole. It is *fatal* for a
 * positional protocol — a collaborative editor's step stream addresses the
 * document by offset, and a client whose document is 3 characters shorter than
 * the server's will corrupt it on the next edit. `safeToSubstitute` is where
 * that distinction is enforced rather than assumed (§10.9.2).
 */
import { scanTokens } from './tokens.ts';

export interface Detokenized {
  text: string;
  /** Tokens replaced, in the order they appeared. */
  replaced: string[];
  /** Seen but not resolvable — the caller may want to warm the cache. */
  unresolved: string[];
}

/**
 * Replace every token we hold a value for. Unknown tokens are left as-is: a
 * token we cannot resolve is still the correct thing to show, and inventing
 * anything else would be worse than showing the token.
 */
export function detokenize(
  text: string,
  valueFor: (token: string) => string | undefined,
): Detokenized {
  const matches = scanTokens(text);
  if (matches.length === 0) return { text, replaced: [], unresolved: [] };

  const replaced: string[] = [];
  const unresolved: string[] = [];
  let out = '';
  let cursor = 0;

  for (const match of matches) {
    const value = valueFor(match.token);
    if (value === undefined) {
      unresolved.push(match.token);
      continue;
    }
    out += text.slice(cursor, match.start) + value;
    cursor = match.end;
    replaced.push(match.token);
  }
  out += text.slice(cursor);

  return { text: out, replaced, unresolved };
}

/** Every token in a body, so the bridge knows what to ask the vault for. */
export function tokensIn(text: string): string[] {
  return [...new Set(scanTokens(text).map((m) => m.token))];
}

/**
 * Whether rewriting this body is safe, in the offset sense above.
 *
 * The test is deliberately a denylist of shapes we recognise as positional
 * rather than an allowlist of shapes we think are flat. Getting it wrong in the
 * permissive direction corrupts a user's document, so this refuses anything that
 * looks like it addresses a document by offset.
 *
 * ProseMirror steps (`stepType` + `from`/`to`), Yjs and OT updates, and
 * JSON-patch style paths all fall out of this. A REST payload does not.
 */
const POSITIONAL = [
  /"stepType"\s*:/,
  /"steps"\s*:\s*\[/,
  /\bfrom"\s*:\s*\d+.{0,40}"to"\s*:\s*\d+/s,
  /"retain"\s*:\s*\d+/,
  /"ops"\s*:\s*\[/,
  /"clientID"\s*:/,
];

export function safeToSubstitute(body: string): boolean {
  return !POSITIONAL.some((re) => re.test(body));
}
