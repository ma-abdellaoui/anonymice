import type { PiiMatchMode, PiiScopeType } from "@/components/networking";

export const SCOPES: PiiScopeType[] = ["key", "user", "team", "organization"];

export const MATCH_MODES: { value: PiiMatchMode; label: string; hint: string }[] = [
  { value: "normalized", label: "Normalized", hint: "ignores case, accents and spacing" },
  { value: "exact", label: "Exact", hint: "byte-for-byte" },
  { value: "substring", label: "Substring", hint: "matches inside the value" },
];

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A 403 means the key lacks the permission, which is worth saying plainly rather than as a toast. */
export const isForbidden = (error: unknown): boolean => errorMessage(error).includes("403");

export const formatWhen = (iso: string | null): string => (iso ? new Date(iso).toLocaleString() : "-");
