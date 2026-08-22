import React from "react";

import type { PiiSpan } from "@/components/networking";

const DETECTOR_STYLES: Record<string, string> = {
  rules: "bg-blue-100 text-blue-900 ring-1 ring-blue-300",
  ner: "bg-amber-100 text-amber-900 ring-1 ring-amber-300",
};

const NEUTRAL_STYLE = "bg-gray-100 text-gray-900";

export interface Mark {
  readonly key: string;
  readonly groupId?: string;
  readonly start: number;
  readonly end: number;
  readonly className: string;
  readonly title?: string;
}

export const detectorStyle = (detector: string): string => DETECTOR_STYLES[detector] ?? NEUTRAL_STYLE;

export const spansToMarks = (spans: readonly PiiSpan[]): readonly Mark[] =>
  spans.map((span, index) => ({
    key: `${span.entity_type}-${span.start}-${index}`,
    start: span.start,
    end: span.end,
    className: detectorStyle(span.detector),
    title: `${span.entity_type} · ${span.detector} · ${span.score.toFixed(2)}`,
  }));

interface MarkedTextProps {
  text: string;
  marks: readonly Mark[];
  activeKey?: string | null;
  onMarkEnter?: (groupId: string) => void;
  onMarkLeave?: () => void;
}

/**
 * Renders text with arbitrary stretches marked up. Marks that start before the
 * previous one ended are dropped rather than spliced, since a cursor that only
 * moves forward would otherwise duplicate or swallow the overlap.
 */
export const MarkedText: React.FC<MarkedTextProps> = ({ text, marks, activeKey, onMarkEnter, onMarkLeave }) => {
  const ordered = [...marks].sort((a, b) => a.start - b.start);

  const { pieces, cursor } = ordered.reduce<{ pieces: React.ReactNode[]; cursor: number }>(
    (acc, mark) => {
      if (mark.start < acc.cursor || mark.end > text.length) return acc;

      const groupId = mark.groupId ?? mark.key;
      const lead =
        mark.start > acc.cursor ? [<span key={`plain-${mark.key}`}>{text.slice(acc.cursor, mark.start)}</span>] : [];

      return {
        pieces: [
          ...acc.pieces,
          ...lead,
          <mark
            key={mark.key}
            className={`rounded px-1 transition-shadow ${mark.className} ${
              activeKey === groupId ? "ring-2 ring-gray-900 ring-offset-1" : ""
            }`}
            title={mark.title}
            onMouseEnter={onMarkEnter ? () => onMarkEnter(groupId) : undefined}
            onMouseLeave={onMarkLeave}
          >
            {text.slice(mark.start, mark.end)}
          </mark>,
        ],
        cursor: mark.end,
      };
    },
    { pieces: [], cursor: 0 },
  );

  return (
    <p className="whitespace-pre-wrap break-words font-mono text-sm text-gray-700">
      {pieces}
      {cursor < text.length && <span key="plain-tail">{text.slice(cursor)}</span>}
    </p>
  );
};

interface SpanHighlighterProps {
  text: string;
  spans: PiiSpan[];
}

/**
 * Renders the source text with each detected span highlighted and labelled by
 * the stage that found it, so the staging policy can be tuned by eye.
 */
const SpanHighlighter: React.FC<SpanHighlighterProps> = ({ text, spans }) => (
  <MarkedText text={text} marks={spansToMarks(spans)} />
);

export default SpanHighlighter;
