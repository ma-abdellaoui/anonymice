import React, { useState } from "react";

import { Search } from "lucide-react";

import { MATCH_MODES } from "./vaultShared";
import { piiSearchCall, type PiiMatchMode, type PiiScopeType, type PiiSearchHit } from "@/components/networking";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { UiLoadingSpinner } from "@/components/ui/ui-loading-spinner";

interface SearchPanelProps {
  accessToken: string | null;
  scope: PiiScopeType;
  run: (label: string, action: () => Promise<void>) => Promise<void>;
  busy: string | null;
  denied: boolean;
  onDeniedChange: (denied: boolean) => void;
}

const SearchPanel: React.FC<SearchPanelProps> = ({ accessToken, scope, run, busy, denied, onDeniedChange }) => {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<PiiMatchMode>("normalized");
  const [hits, setHits] = useState<PiiSearchHit[] | null>(null);
  const [scanned, setScanned] = useState(0);

  const onSearch = () =>
    run("search", async () => {
      onDeniedChange(false);
      const response = await piiSearchCall(accessToken!, { query, mode, scopeType: scope });
      setHits(response.hits);
      setScanned(response.scanned);
    });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Search</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="value to look for"
            className="max-w-md text-sm"
          />
          <select
            aria-label="Match mode"
            className="rounded border border-border px-2 py-1.5 text-sm text-foreground"
            value={mode}
            onChange={(event) => setMode(event.target.value as PiiMatchMode)}
          >
            {MATCH_MODES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <Button onClick={onSearch} disabled={!accessToken || busy !== null || query.trim() === ""}>
            {busy === "search" ? <UiLoadingSpinner className="mr-2 h-4 w-4" /> : <Search className="mr-2 h-4 w-4" />}
            Search
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{MATCH_MODES.find((option) => option.value === mode)?.hint}</p>

        {denied && (
          <p className="text-sm text-muted-foreground">
            This key is not permitted to search. Set{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">permissions.allow_pii_search</code> on
            the key. It is deliberately separate from{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">allow_pii_decode</code>, since finding
            which tokens hold a value is more powerful than resolving one you already have.
          </p>
        )}

        {!denied && hits !== null && (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">
              {hits.length} match{hits.length === 1 ? "" : "es"} after scanning {scanned} row
              {scanned === 1 ? "" : "s"}
            </p>
            {hits.map((hit) => (
              <div key={hit.token} className="flex flex-wrap items-baseline gap-2 text-sm">
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">{hit.token}</code>
                <span className="text-muted-foreground">{hit.entity_type}</span>
                {hit.session_id && <span className="text-xs text-muted-foreground">session {hit.session_id}</span>}
                {hit.subject_id && <span className="text-xs text-muted-foreground">subject {hit.subject_id}</span>}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default SearchPanel;
