import type { PiiActivityEvent } from "@/components/networking";

export const SURFACE_LABELS: Record<string, string> = {
  guardrail: "LLM path",
  endpoint: "REST endpoint",
  extension: "Browser extension",
};

export const SURFACE_STYLES: Record<string, string> = {
  guardrail: "bg-indigo-50 text-indigo-700 ring-indigo-200",
  endpoint: "bg-sky-50 text-sky-700 ring-sky-200",
  extension: "bg-violet-50 text-violet-700 ring-violet-200",
};

export const DIRECTION_STYLES: Record<string, string> = {
  detect: "bg-gray-50 text-gray-600 ring-gray-200",
  encode: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  decode: "bg-amber-50 text-amber-700 ring-amber-200",
};

export const OUTCOME_STYLES: Record<string, string> = {
  applied: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  blocked: "bg-rose-50 text-rose-700 ring-rose-200",
  failed: "bg-orange-50 text-orange-700 ring-orange-200",
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
  if (event.outcome.kind === "blocked") return `refused: ${event.outcome.entity_type} is configured to block`;
  if (event.outcome.kind === "failed") return event.outcome.reason ?? "failed";
  if (event.direction === "detect") return `${totalEntities(event)} found, text untouched`;
  if (event.direction === "decode") return `${event.resolved_count} of ${event.token_count} tokens resolved`;
  const masked = event.action_counts["MASK"] ?? 0;
  const encoded = event.action_counts["ENCODE"] ?? 0;
  if (encoded === 0 && masked === 0) return "nothing sensitive found";
  return masked > 0 ? `${encoded} tokenized, ${masked} masked irreversibly` : `${encoded} tokenized`;
};
