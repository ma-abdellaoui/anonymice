import React, { useState } from "react";

import { ArrowRight } from "lucide-react";

import type { Alignment } from "./alignEncoding";
import { detectorStyle, MarkedText, type Mark } from "../SpanHighlighter";
import type { PiiSpan } from "@/components/networking";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const SOURCE_FALLBACK = "bg-rose-100 text-rose-900 ring-1 ring-rose-300";
const TOKEN_STYLE = "bg-emerald-100 text-emerald-900 ring-1 ring-emerald-300";
const MASKED_STYLE = "bg-slate-200 text-slate-700 ring-1 ring-slate-400 line-through";

interface LedgerRow {
  readonly token: string;
  readonly entityType: string;
  readonly sourceValue: string;
  readonly masked: boolean;
  readonly detector: string | null;
  readonly score: number | null;
  readonly occurrences: number;
}

const spanAt = (spans: readonly PiiSpan[], alignment: Alignment): PiiSpan | undefined =>
  spans.find((span) => span.start === alignment.sourceStart && span.end === alignment.sourceEnd);

export const buildLedger = (alignments: readonly Alignment[], spans: readonly PiiSpan[]): readonly LedgerRow[] =>
  [...new Set(alignments.map((a) => a.token))].map((token) => {
    const hits = alignments.filter((a) => a.token === token);
    const matched = hits.map((a) => spanAt(spans, a)).find((span) => span !== undefined);
    return {
      token,
      entityType: hits[0].entityType,
      sourceValue: hits[0].sourceValue,
      masked: hits[0].masked,
      detector: matched?.detector ?? null,
      score: matched?.score ?? null,
      occurrences: hits.length,
    };
  });

const sourceMarks = (alignments: readonly Alignment[], spans: readonly PiiSpan[]): readonly Mark[] =>
  alignments.map((alignment, index) => {
    const span = spanAt(spans, alignment);
    return {
      key: `source-${index}`,
      groupId: alignment.token,
      start: alignment.sourceStart,
      end: alignment.sourceEnd,
      className: span ? detectorStyle(span.detector) : SOURCE_FALLBACK,
      title: span
        ? `${span.entity_type} · ${span.detector} · ${span.score.toFixed(2)} · became ${alignment.token}`
        : `became ${alignment.token}`,
    };
  });

const encodedMarks = (alignments: readonly Alignment[]): readonly Mark[] =>
  alignments.map((alignment, index) => ({
    key: `encoded-${index}`,
    groupId: alignment.token,
    start: alignment.encodedStart,
    end: alignment.encodedEnd,
    className: alignment.masked ? MASKED_STYLE : TOKEN_STYLE,
    title: alignment.masked
      ? `masked ${alignment.sourceValue}, the provider's copy cannot be restored`
      : `replaced ${alignment.sourceValue}`,
  }));

const Column: React.FC<{ label: string; caption: string; children: React.ReactNode }> = ({
  label,
  caption,
  children,
}) => (
  <div className="flex min-w-0 flex-1 flex-col gap-2">
    <div>
      <p className="text-xs font-semibold tracking-wide text-gray-900 uppercase">{label}</p>
      <p className="text-xs text-gray-500">{caption}</p>
    </div>
    <div className="min-h-24 rounded-lg bg-gray-50 p-3 ring-1 ring-gray-200">{children}</div>
  </div>
);

interface TokenDiffProps {
  original: string;
  encoded: string;
  alignments: readonly Alignment[];
  spans: readonly PiiSpan[];
  unalignedReason: string | null;
}

const TokenDiff: React.FC<TokenDiffProps> = ({ original, encoded, alignments, spans, unalignedReason }) => {
  const [active, setActive] = useState<string | null>(null);
  const ledger = buildLedger(alignments, spans);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col items-stretch gap-4 md:flex-row md:items-start">
        <Column label="You wrote" caption="every stretch the detector claimed">
          <MarkedText
            text={original}
            marks={sourceMarks(alignments, spans)}
            activeKey={active}
            onMarkEnter={setActive}
            onMarkLeave={() => setActive(null)}
          />
        </Column>
        <div className="hidden self-center text-gray-400 md:block">
          <ArrowRight className="h-5 w-5" />
        </div>
        <Column label="The provider saw" caption="the exact bytes that left the building">
          <MarkedText
            text={encoded}
            marks={encodedMarks(alignments)}
            activeKey={active}
            onMarkEnter={setActive}
            onMarkLeave={() => setActive(null)}
          />
        </Column>
      </div>

      {unalignedReason !== null && (
        <p className="text-xs text-gray-500">Showing both texts without links: {unalignedReason}.</p>
      )}

      {ledger.length > 0 && (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Token</TableHead>
                <TableHead>Entity</TableHead>
                <TableHead>Stood in for</TableHead>
                <TableHead>Found by</TableHead>
                <TableHead className="text-right">Score</TableHead>
                <TableHead className="text-right">Uses</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ledger.map((row) => (
                <TableRow
                  key={row.token}
                  className={active === row.token ? "bg-gray-100" : undefined}
                  onMouseEnter={() => setActive(row.token)}
                  onMouseLeave={() => setActive(null)}
                >
                  <TableCell className="font-mono text-xs">{row.token}</TableCell>
                  <TableCell className="text-xs">{row.entityType}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {row.sourceValue}
                    {row.masked && <span className="ml-2 text-gray-500">(masked, not restorable)</span>}
                  </TableCell>
                  <TableCell className="text-xs">{row.detector ?? "—"}</TableCell>
                  <TableCell className="text-right text-xs">{row.score?.toFixed(2) ?? "—"}</TableCell>
                  <TableCell className="text-right text-xs">{row.occurrences}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
};

export default TokenDiff;
