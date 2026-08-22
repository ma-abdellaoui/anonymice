import React from "react";

import type { FlowSegment } from "./flowTypes";

const DETECTOR_RING: Record<string, string> = {
  rules: "bg-sky-100/80 ring-1 ring-sky-400 text-sky-950",
  ner: "bg-amber-100/80 ring-1 ring-amber-400 text-amber-950",
};

const TOKEN_STYLE = "bg-emerald-100/80 ring-1 ring-emerald-400 text-emerald-950";

interface MorphTextProps {
  segments: FlowSegment[];
  /** Which form each entity currently shows. */
  show: "value" | "token";
  /** Draw the detection outline around each entity. */
  outlined?: boolean;
  /** Stagger the outlines in, one entity after another. */
  stagger?: boolean;
}

/**
 * Text whose sensitive spans swap between their value and their token in place.
 *
 * Both forms are always in the DOM and the inactive one collapses to zero
 * width, so the swap reads as one thing becoming another rather than as two
 * separate screens. The width is set from the string length in `ch`, which is
 * exact because this text is monospaced.
 */
const MorphText: React.FC<MorphTextProps> = ({ segments, show, outlined = false, stagger = false }) => (
  <p className="whitespace-pre-wrap break-words font-mono text-[13px] leading-7 text-gray-800">
    {segments.map((segment, index) =>
      segment.kind === "plain" ? (
        <span key={`plain-${index}`}>{segment.text}</span>
      ) : (
        <span
          key={`entity-${index}`}
          className="anm-morph"
          data-show={show}
          title={`${segment.entityType} · ${segment.detector} · ${segment.score.toFixed(2)}`}
        >
          <span
            className={`anm-morph-value rounded-[3px] transition-all duration-300 ${
              outlined ? (DETECTOR_RING[segment.detector] ?? "bg-gray-100 ring-1 ring-gray-300") : ""
            }`}
            style={{
              ["--anm-w" as string]: `${segment.value.length}ch`,
              transitionDelay: stagger ? `${index * 90}ms` : "0ms",
            }}
          >
            {segment.value}
          </span>
          <span
            className={`anm-morph-token rounded-[3px] ${TOKEN_STYLE}`}
            style={{ ["--anm-w" as string]: `${segment.token.length}ch` }}
          >
            {segment.token}
          </span>
        </span>
      ),
    )}
  </p>
);

export default MorphText;
