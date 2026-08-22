import { useEffect, useState } from "react";

import { modelAvailableCall } from "@/components/networking";

/**
 * Sorted so the model that always answers comes first.
 *
 * dev_config.yaml ships `openrouter-free`, pointed at OpenRouter's free
 * auto-router, precisely so the Flow tab has something to call on a machine
 * where no paid provider key is set.
 */
const ALWAYS_AVAILABLE = "openrouter-free";

const preferred = (a: string, b: string): number => {
  if (a === ALWAYS_AVAILABLE) return -1;
  if (b === ALWAYS_AVAILABLE) return 1;
  return a.localeCompare(b);
};

/** Callable model names, de-duplicated, with the always-available one first. */
export const orderModels = (names: (string | undefined)[]): string[] => {
  const callable = names.filter((id): id is string => typeof id === "string" && !id.includes("*"));
  return [...new Set(callable)].sort(preferred);
};

interface ModelListResponse {
  data?: { id?: string }[];
}

/** Model names this key can call, so the visualizer sends to something that exists. */
export const useModelChoices = (accessToken: string | null, userId: string | null, userRole: string | null) => {
  const [models, setModels] = useState<string[]>([]);

  useEffect(() => {
    if (!accessToken) return;
    let live = true;
    modelAvailableCall(accessToken, userId ?? "", userRole ?? "")
      .then((response: ModelListResponse) => {
        if (!live) return;
        setModels(orderModels((response.data ?? []).map((entry) => entry.id)));
      })
      .catch(() => setModels([]));
    return () => {
      live = false;
    };
  }, [accessToken, userId, userRole]);

  return models;
};
