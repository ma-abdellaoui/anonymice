import { useEffect, useState } from "react";

import { modelAvailableCall } from "@/components/networking";

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
        const names = (response.data ?? [])
          .map((entry) => entry.id)
          .filter((id): id is string => typeof id === "string" && !id.includes("*"));
        setModels([...new Set(names)].sort());
      })
      .catch(() => setModels([]));
    return () => {
      live = false;
    };
  }, [accessToken, userId, userRole]);

  return models;
};
