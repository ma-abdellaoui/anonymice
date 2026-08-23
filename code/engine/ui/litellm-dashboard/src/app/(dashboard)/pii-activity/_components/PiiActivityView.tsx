import React, { useMemo, useState } from "react";

import { Radio, RefreshCw } from "lucide-react";

import ActivityDrawer from "./ActivityDrawer";
import ActivityTable from "./ActivityTable";
import { useActivityFeed } from "./useActivityFeed";

import type { PiiActivityEvent, PiiDirection, PiiSurface } from "@/components/networking";
import { Button } from "@/components/ui/button";
import { UiLoadingSpinner } from "@/components/ui/ui-loading-spinner";

const SURFACES: { value: PiiSurface | ""; label: string }[] = [
  { value: "", label: "Everywhere" },
  { value: "guardrail", label: "LLM path" },
  { value: "endpoint", label: "REST endpoint" },
  { value: "extension", label: "Browser extension" },
];

const DIRECTIONS: { value: PiiDirection | ""; label: string }[] = [
  { value: "", label: "Everything" },
  { value: "detect", label: "Detect" },
  { value: "encode", label: "Encode" },
  { value: "decode", label: "Decode" },
];

interface ActivityBodyProps {
  feed: ReturnType<typeof useActivityFeed>;
  selectedId: string | null;
  onSelect: (event: PiiActivityEvent) => void;
}

const ActivityBody: React.FC<ActivityBodyProps> = ({ feed, selectedId, onSelect }) => {
  if (feed.loading && feed.events.length === 0) {
    return (
      <div className="flex items-center justify-center gap-2 p-12 text-sm text-muted-foreground">
        <UiLoadingSpinner className="h-4 w-4" />
        Loading
      </div>
    );
  }
  if (feed.events.length === 0) {
    return (
      <p className="p-12 text-center text-sm text-muted-foreground">
        Nothing recorded yet. Send a request through the proxy, or run the Flow tab under PII Anonymization.
      </p>
    );
  }
  return <ActivityTable events={feed.events} selectedId={selectedId} onSelect={onSelect} />;
};

interface PiiActivityViewProps {
  accessToken: string | null;
}

/**
 * Every encode and decode the system performed, wherever it happened.
 *
 * The point of putting the extension and the proxy in one table is that they
 * are one system: a value tokenized on copy and a value tokenized in flight are
 * the same operation, and seeing them interleaved is what makes that legible.
 */
const PiiActivityView: React.FC<PiiActivityViewProps> = ({ accessToken }) => {
  const [surface, setSurface] = useState<PiiSurface | "">("");
  const [direction, setDirection] = useState<PiiDirection | "">("");
  const [selected, setSelected] = useState<PiiActivityEvent | null>(null);

  const filters = useMemo(
    () => ({ limit: 200, ...(surface ? { surface } : {}), ...(direction ? { direction } : {}) }),
    [surface, direction],
  );
  const feed = useActivityFeed(accessToken, filters);

  const shown = selected ? feed.events.find((event) => event.id === selected.id) ?? selected : null;

  return (
    <div className="flex h-full w-full flex-col p-6">
      <div className="mb-4">
        <h1 className="text-xl font-semibold text-foreground">PII Activity</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every detect, encode and decode this proxy performed, from the LLM path, the REST endpoints, and the browser
          extension. Counts and outcomes always; the text itself only when capture is switched on.
        </p>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select
          aria-label="Surface"
          className="rounded border border-border px-2 py-1.5 text-sm text-foreground"
          value={surface}
          onChange={(event) => setSurface(event.target.value as PiiSurface | "")}
        >
          {SURFACES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <select
          aria-label="Operation"
          className="rounded border border-border px-2 py-1.5 text-sm text-foreground"
          value={direction}
          onChange={(event) => setDirection(event.target.value as PiiDirection | "")}
        >
          {DIRECTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <Button
          variant={feed.following ? "default" : "secondary"}
          onClick={() => feed.setFollowing(!feed.following)}
          aria-pressed={feed.following}
        >
          <Radio className={`mr-2 h-4 w-4 ${feed.following ? "animate-pulse" : ""}`} />
          {feed.following ? "Following" : "Follow"}
        </Button>

        <Button variant="secondary" onClick={feed.refresh} aria-label="Refresh">
          <RefreshCw className="h-4 w-4" />
        </Button>

        <span className="ml-auto text-xs text-muted-foreground">
          {feed.events.length} event{feed.events.length === 1 ? "" : "s"}
          {feed.captureEnabled ? " · text capture on" : " · text capture off"}
        </span>
      </div>

      {feed.error && (
        <p className="mb-3 rounded border border-rose-200 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/50 px-3 py-2 text-sm text-rose-700 dark:text-rose-300">{feed.error}</p>
      )}

      <div className="flex min-h-0 flex-1 overflow-hidden rounded-lg border border-border bg-card">
        <div className="min-w-0 flex-1 overflow-auto">
          <ActivityBody feed={feed} selectedId={shown?.id ?? null} onSelect={setSelected} />
        </div>

        {shown && (
          <ActivityDrawer event={shown} captureEnabled={feed.captureEnabled} onClose={() => setSelected(null)} />
        )}
      </div>
    </div>
  );
};

export default PiiActivityView;
