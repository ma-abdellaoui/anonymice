import React from "react";

import type { PiiSpan } from "@/components/networking";

const DETECTOR_STYLES: Record<string, string> = {
  rules: "bg-blue-100 text-blue-900 ring-1 ring-blue-300",
  ner: "bg-amber-100 dark:bg-amber-950/50 text-amber-900 dark:text-amber-300 ring-1 ring-amber-300 dark:ring-amber-700",
};

interface SpanHighlighterProps {
  text: string;
  spans: PiiSpan[];
}

/**
 * Renders the source text with each detected span highlighted and labelled by
 * the stage that found it, so the staging policy can be tuned by eye.
 */
const SpanHighlighter: React.FC<SpanHighlighterProps> = ({ text, spans }) => {
  if (spans.length === 0) {
    return <p className="whitespace-pre-wrap break-words font-mono text-sm text-foreground">{text}</p>;
  }

  const ordered = [...spans].sort((a, b) => a.start - b.start);
  const pieces: React.ReactNode[] = [];
  let cursor = 0;

  ordered.forEach((span, index) => {
    if (span.start > cursor) {
      pieces.push(<span key={`plain-${index}`}>{text.slice(cursor, span.start)}</span>);
    }
    pieces.push(
      <mark
        key={`span-${index}`}
        className={`rounded px-1 ${DETECTOR_STYLES[span.detector] ?? "bg-muted text-foreground"}`}
        title={`${span.entity_type} · ${span.detector} · ${span.score.toFixed(2)}`}
      >
        {text.slice(span.start, span.end)}
      </mark>,
    );
    cursor = span.end;
  });

  if (cursor < text.length) {
    pieces.push(<span key="plain-tail">{text.slice(cursor)}</span>);
  }

  return <p className="whitespace-pre-wrap break-words font-mono text-sm text-foreground">{pieces}</p>;
};

export default SpanHighlighter;
