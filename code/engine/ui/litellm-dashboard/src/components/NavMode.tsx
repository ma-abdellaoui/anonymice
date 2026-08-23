"use client";

import { useCallback, useEffect, useState } from "react";

import { cn } from "@/lib/cva.config";

const STORAGE_KEY = "anonymice:nav-mode";

export type NavMode = "simple" | "advanced";

/**
 * The pages the product's own story runs through.
 *
 * Simple mode shows these and nothing else. The proxy carries every LiteLLM
 * surface, and most of them are beside the point when the question is what
 * happens to sensitive data on the way to a model.
 */
export const SIMPLE_PAGES: ReadonlySet<string> = new Set([
  "anonymization",
  "pii-activity",
  "api-keys",
  "llm-playground",
  "models",
  "guardrails",
  "logs",
]);

const isMode = (value: string | null): value is NavMode => value === "simple" || value === "advanced";

/**
 * Which pages the sidebar offers, remembered per browser.
 *
 * Defaults to advanced, which is what the sidebar already showed. Narrowing
 * someone's navigation is a change they should make, not one that happens to
 * them; the choice is one click and it sticks.
 */
export const useNavMode = (): { mode: NavMode; setMode: (mode: NavMode) => void } => {
  const [mode, setModeState] = useState<NavMode>("advanced");

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reading a browser store on mount is what an effect is for; it cannot be read during render without breaking prerendering
      if (isMode(stored)) setModeState(stored);
    } catch {
      // A browser that refuses storage still gets a working sidebar.
    }
  }, []);

  const setMode = useCallback((next: NavMode) => {
    setModeState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Same: the choice just does not survive a reload.
    }
  }, []);

  return { mode, setMode };
};

interface NavModeToggleProps {
  mode: NavMode;
  onChange: (mode: NavMode) => void;
}

const OPTIONS: { value: NavMode; label: string; title: string }[] = [
  { value: "simple", label: "Simple", title: "Only the pages the anonymization story runs through" },
  { value: "advanced", label: "Advanced", title: "Every page the proxy exposes" },
];

export const NavModeToggle: React.FC<NavModeToggleProps> = ({ mode, onChange }) => (
  <div
    role="radiogroup"
    aria-label="Navigation detail"
    className="mb-2 flex gap-0.5 rounded-md bg-muted p-0.5 group-data-[collapsed=true]/sidebar:hidden"
  >
    {OPTIONS.map((option) => (
      <button
        key={option.value}
        type="button"
        role="radio"
        aria-checked={mode === option.value}
        title={option.title}
        onClick={() => onChange(option.value)}
        className={cn(
          "flex-1 rounded px-2 py-1 text-xs font-medium transition-colors",
          mode === option.value ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
        )}
      >
        {option.label}
      </button>
    ))}
  </div>
);
