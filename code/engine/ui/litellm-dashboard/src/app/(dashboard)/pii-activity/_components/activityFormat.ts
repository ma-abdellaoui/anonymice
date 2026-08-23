import type { PiiActivityEvent } from "@/components/networking";

export const SURFACE_LABELS: Record<string, string> = {
  guardrail: "LLM path",
  endpoint: "REST endpoint",
  extension: "Browser extension",
};

export const SURFACE_STYLES: Record<string, string> = {
  guardrail: "bg-indigo-50 dark:bg-indigo-950/50 text-indigo-700 dark:text-indigo-300 ring-indigo-200 dark:ring-indigo-800",
  endpoint: "bg-sky-50 dark:bg-sky-950/50 text-sky-700 dark:text-sky-300 ring-sky-200 dark:ring-sky-800",
  extension: "bg-violet-50 dark:bg-violet-950/50 text-violet-700 dark:text-violet-300 ring-violet-200 dark:ring-violet-800",
};

export const DIRECTION_STYLES: Record<string, string> = {
  detect: "bg-muted text-muted-foreground ring-border",
  encode: "bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 ring-emerald-200 dark:ring-emerald-800",
  decode: "bg-amber-50 dark:bg-amber-950/50 text-amber-700 dark:text-amber-300 ring-amber-200 dark:ring-amber-800",
};

export const OUTCOME_STYLES: Record<string, string> = {
  applied: "bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 ring-emerald-200 dark:ring-emerald-800",
  blocked: "bg-rose-50 dark:bg-rose-950/50 text-rose-700 dark:text-rose-300 ring-rose-200 dark:ring-rose-800",
  failed: "bg-orange-50 dark:bg-orange-950/50 text-orange-700 dark:text-orange-300 ring-orange-200 dark:ring-orange-800",
  unscanned: "bg-rose-100 dark:bg-rose-950/50 text-rose-800 dark:text-rose-300 ring-rose-300 dark:ring-rose-700",
};

export const duration = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`);

export const clockTime = (iso: string): string => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleTimeString();
};

export const totalEntities = (event: PiiActivityEvent): number =>
  Object.values(event.entity_counts).reduce((sum, count) => sum + count, 0);

/** One line saying what became of this call, without needing the drawer open. */
export const outcomeSummary = (event: PiiActivityEvent): string => {
  if (event.outcome.kind === "unscanned") {
    return `text reached the provider unscanned: ${event.outcome.reason ?? "no detector"}`;
  }
  if (event.outcome.kind === "blocked") return `refused: ${event.outcome.entity_type} is configured to block`;
  if (event.outcome.kind === "failed") return event.outcome.reason ?? "failed";
  if (event.direction === "detect") return `${totalEntities(event)} found, text untouched`;
  if (event.direction === "decode") return `${event.resolved_count} of ${event.token_count} tokens resolved`;
  const masked = event.action_counts["MASK"] ?? 0;
  const encoded = event.action_counts["ENCODE"] ?? 0;
  if (encoded === 0 && masked === 0) return "nothing sensitive found";
  return masked > 0 ? `${encoded} tokenized, ${masked} masked irreversibly` : `${encoded} tokenized`;
};
