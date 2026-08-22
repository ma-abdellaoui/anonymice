import React from "react";

import { Lock } from "lucide-react";

import type { VaultEntry } from "./flowTypes";

interface VaultPanelProps {
  entries: VaultEntry[];
  /** Rows are hidden until the encode beat mints them. */
  revealed: boolean;
  /** The decode beat is reading them back out. */
  resolving: boolean;
}

/**
 * The mapping, on our side of the line.
 *
 * This panel is the answer to the only question that matters about the
 * boundary: the value is here, so it is not there.
 */
const VaultPanel: React.FC<VaultPanelProps> = ({ entries, revealed, resolving }) => (
  <section
    aria-label="Token vault"
    className={`rounded-lg border transition-all duration-500 ${
      resolving ? "border-emerald-400 dark:border-emerald-700 bg-emerald-50/60 dark:bg-emerald-950/50 shadow-sm" : "border-border bg-muted/70"
    }`}
  >
    <div className="flex items-center gap-2 border-b border-border/70 px-3 py-2">
      <Lock className={`h-3.5 w-3.5 ${resolving ? "text-emerald-600 dark:text-emerald-300" : "text-muted-foreground"}`} />
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Token vault</span>
      <span className="ml-auto text-[11px] text-muted-foreground">never crosses the line</span>
    </div>
    <div className="divide-y divide-border/60">
      {entries.length === 0 && (
        <p className="px-3 py-3 text-xs text-muted-foreground">Nothing minted yet</p>
      )}
      {entries.map((entry, index) => (
        <div
          key={entry.token}
          className="flex items-center gap-2 px-3 py-2 transition-all duration-500"
          style={{
            opacity: revealed ? 1 : 0,
            transform: revealed ? "translateY(0)" : "translateY(-6px)",
            transitionDelay: `${index * 110}ms`,
          }}
        >
          <code className="rounded bg-emerald-100/80 dark:bg-emerald-950/50 px-1.5 py-0.5 font-mono text-[11px] text-emerald-950 dark:text-emerald-300 ring-1 ring-emerald-300 dark:ring-emerald-700">
            {entry.token}
          </code>
          <span className="text-muted-foreground/50">&rarr;</span>
          <code className="truncate font-mono text-[11px] text-foreground">{entry.value}</code>
          <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
            {entry.detector}
          </span>
        </div>
      ))}
    </div>
  </section>
);

export default VaultPanel;
