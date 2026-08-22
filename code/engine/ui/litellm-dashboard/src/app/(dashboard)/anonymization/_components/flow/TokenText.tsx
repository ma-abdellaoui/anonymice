import React from "react";

/**
 * A string with its tokens marked, and nothing else in it.
 *
 * This is what the provider's side of the stage renders. `MorphText` keeps both
 * forms in the DOM so it can animate between them, which would put the real
 * value inside a panel labelled as the provider's, hidden by CSS. A picture of
 * a boundary that leaks in the markup is not worth showing, so the two sides
 * use different components on purpose.
 */
const TOKEN_PATTERN = /<[A-Z][A-Z0-9_]*(?:_\d+|:[A-Za-z0-9._-]+)>/g;

interface TokenTextProps {
  text: string;
}

const TokenText: React.FC<TokenTextProps> = ({ text }) => {
  const pieces: React.ReactNode[] = [];
  let cursor = 0;

  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const at = match.index ?? 0;
    if (at > cursor) pieces.push(<span key={`plain-${cursor}`}>{text.slice(cursor, at)}</span>);
    pieces.push(
      <mark
        key={`token-${at}`}
        className="rounded-[3px] bg-emerald-100/80 dark:bg-emerald-950/50 px-0.5 text-emerald-950 dark:text-emerald-300 ring-1 ring-emerald-400 dark:ring-emerald-700"
      >
        {match[0]}
      </mark>,
    );
    cursor = at + match[0].length;
  }
  if (cursor < text.length) pieces.push(<span key="plain-tail">{text.slice(cursor)}</span>);

  return (
    <p className="whitespace-pre-wrap break-words font-mono text-[13px] leading-7 text-foreground">
      {pieces.length > 0 ? pieces : text}
    </p>
  );
};

export default TokenText;
