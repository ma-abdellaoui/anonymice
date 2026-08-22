import React, { useState } from "react";

import SearchPanel from "./SearchPanel";
import SessionBrowser from "./SessionBrowser";
import SubjectTools from "./SubjectTools";
import { SCOPES, errorMessage, isForbidden } from "./vaultShared";
import { type PiiScopeType } from "@/components/networking";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "@/lib/toast";

interface VaultBrowserProps {
  accessToken: string | null;
}

const VaultBrowser: React.FC<VaultBrowserProps> = ({ accessToken }) => {
  const [scope, setScope] = useState<PiiScopeType>("key");
  const [busy, setBusy] = useState<string | null>(null);
  const [searchDenied, setSearchDenied] = useState(false);

  const run = async (label: string, action: () => Promise<void>) => {
    if (!accessToken) return;
    setBusy(label);
    try {
      await action();
    } catch (error) {
      if (label === "search" && isForbidden(error)) setSearchDenied(true);
      else toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Scope</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3 text-sm text-gray-600">
          <select
            aria-label="Scope"
            className="rounded border border-gray-200 px-2 py-1.5 text-sm text-gray-700"
            value={scope}
            onChange={(event) => setScope(event.target.value as PiiScopeType)}
          >
            {SCOPES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          <p>
            Every action below is confined to this scope. A key can only reach a scope it belongs to, so choosing{" "}
            <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-xs">team</code> without being on one is
            refused rather than silently widened.
          </p>
        </CardContent>
      </Card>

      <SessionBrowser accessToken={accessToken} scope={scope} run={run} busy={busy} />
      <SubjectTools accessToken={accessToken} scope={scope} run={run} busy={busy} />
      <SearchPanel
        accessToken={accessToken}
        scope={scope}
        run={run}
        busy={busy}
        denied={searchDenied}
        onDeniedChange={setSearchDenied}
      />
    </div>
  );
};

export default VaultBrowser;
