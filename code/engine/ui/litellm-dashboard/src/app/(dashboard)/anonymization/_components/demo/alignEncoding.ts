export interface Alignment {
  readonly token: string;
  readonly entityType: string;
  readonly masked: boolean;
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly sourceValue: string;
  readonly encodedStart: number;
  readonly encodedEnd: number;
}

export type AlignResult =
  | { readonly kind: "aligned"; readonly alignments: readonly Alignment[] }
  | { readonly kind: "unaligned"; readonly reason: string };

const TOKEN_PATTERN = /<([A-Z][A-Z0-9_]*)(?:_(\d+)|:([A-Za-z0-9._-]+))>|<([A-Z][A-Z0-9_]*)>/g;

interface TokenMatch {
  readonly token: string;
  readonly entityType: string;
  readonly masked: boolean;
  readonly encodedStart: number;
  readonly encodedEnd: number;
}

type Boundary =
  | { readonly kind: "found"; readonly sourceEnd: number; readonly nextCursor: number }
  | { readonly kind: "error"; readonly reason: string };

const scanTokens = (encoded: string): readonly TokenMatch[] =>
  [...encoded.matchAll(TOKEN_PATTERN)].map((match) => ({
    token: match[0],
    entityType: match[1] ?? match[4] ?? "",
    masked: match[1] === undefined,
    encodedStart: match.index ?? 0,
    encodedEnd: (match.index ?? 0) + match[0].length,
  }));

const quote = (literal: string): string => JSON.stringify(literal.length > 24 ? `${literal.slice(0, 24)}…` : literal);

const innerBoundary = (original: string, literal: string, sourceCursor: number): Boundary => {
  if (literal === "") {
    return { kind: "error", reason: "two tokens sit next to each other with no anchor text between them" };
  }
  const at = original.indexOf(literal, sourceCursor + 1);
  if (at < 0) {
    return { kind: "error", reason: `anchor text ${quote(literal)} does not appear in the source` };
  }
  return { kind: "found", sourceEnd: at, nextCursor: at + literal.length };
};

const tailBoundary = (original: string, literal: string): Boundary => {
  if (literal === "") {
    return { kind: "found", sourceEnd: original.length, nextCursor: original.length };
  }
  if (!original.endsWith(literal)) {
    return { kind: "error", reason: `the text after the last token, ${quote(literal)}, does not end the source` };
  }
  return { kind: "found", sourceEnd: original.length - literal.length, nextCursor: original.length };
};

interface WalkContext {
  readonly original: string;
  readonly encoded: string;
  readonly matches: readonly TokenMatch[];
}

const walk = (context: WalkContext, index: number, sourceCursor: number, acc: readonly Alignment[]): AlignResult => {
  const { original, encoded, matches } = context;
  const match = matches[index];
  if (match === undefined) {
    return { kind: "aligned", alignments: acc };
  }

  const next = matches[index + 1];
  const literal = encoded.slice(match.encodedEnd, next?.encodedStart ?? encoded.length);
  const boundary =
    next === undefined ? tailBoundary(original, literal) : innerBoundary(original, literal, sourceCursor);

  if (boundary.kind === "error") {
    return { kind: "unaligned", reason: boundary.reason };
  }
  if (boundary.sourceEnd <= sourceCursor) {
    return { kind: "unaligned", reason: `${match.token} maps to an empty stretch of the source` };
  }

  return walk(context, index + 1, boundary.nextCursor, [
    ...acc,
    {
      ...match,
      sourceStart: sourceCursor,
      sourceEnd: boundary.sourceEnd,
      sourceValue: original.slice(sourceCursor, boundary.sourceEnd),
    },
  ]);
};

/**
 * Recovers which stretch of the source each token replaced. `/pii/encode` returns the
 * tokens it minted but neither their offsets nor the values behind them, so the link has
 * to come from the two strings: encoding only splices over spans, leaving every other
 * byte intact, which makes the text between tokens a reliable anchor.
 */
export const alignEncoding = (original: string, encoded: string): AlignResult => {
  const matches = scanTokens(encoded);
  if (matches.length === 0) {
    return original === encoded
      ? { kind: "aligned", alignments: [] }
      : { kind: "unaligned", reason: "the encoded text carries no tokens yet differs from the source" };
  }

  const prefix = encoded.slice(0, matches[0].encodedStart);
  if (!original.startsWith(prefix)) {
    return {
      kind: "unaligned",
      reason: `the text before the first token, ${quote(prefix)}, does not start the source`,
    };
  }

  const walked = walk({ original, encoded, matches }, 0, prefix.length, []);
  if (walked.kind === "unaligned") {
    return walked;
  }
  return { kind: "aligned", alignments: walked.alignments.filter((a) => a.sourceValue !== a.token) };
};
