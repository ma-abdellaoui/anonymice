import React, { useState } from "react";

import { Trash2 } from "lucide-react";

import { formatWhen } from "./vaultShared";
import {
  piiRevokeSessionCall,
  piiSessionCall,
  type PiiScopeType,
  type PiiTokenMetadata,
} from "@/components/networking";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { UiLoadingSpinner } from "@/components/ui/ui-loading-spinner";

interface SessionBrowserProps {
  accessToken: string | null;
  scope: PiiScopeType;
  run: (label: string, action: () => Promise<void>) => Promise<void>;
  busy: string | null;
}

const TokenTable: React.FC<{ tokens: PiiTokenMetadata[] }> = ({ tokens }) => (
  <div className="overflow-x-auto">
    <table className="w-full text-left text-sm">
      <thead className="text-xs uppercase text-gray-400">
        <tr>
          <th className="py-2 pr-4 font-medium">Token</th>
          <th className="py-2 pr-4 font-medium">Entity</th>
          <th className="py-2 pr-4 font-medium">Subject</th>
          <th className="py-2 pr-4 font-medium">Created</th>
          <th className="py-2 font-medium">Expires</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-100">
        {tokens.map((token) => (
          <tr key={token.token}>
            <td className="py-2 pr-4 font-mono text-xs text-gray-700">{token.token}</td>
            <td className="py-2 pr-4 text-gray-600">{token.entity_type}</td>
            <td className="py-2 pr-4 text-gray-600">{token.subject_id ?? "-"}</td>
            <td className="py-2 pr-4 text-gray-500">{formatWhen(token.created_at)}</td>
            <td className="py-2 text-gray-500">{formatWhen(token.expires_at)}</td>
          </tr>
        ))}
      </tbody>
    </table>
    <p className="mt-2 text-xs text-gray-400">
      Metadata only. Values are never listed here; use search or subject export, both of which are audited.
    </p>
  </div>
);

const SessionBrowser: React.FC<SessionBrowserProps> = ({ accessToken, scope, run, busy }) => {
  const [sessionId, setSessionId] = useState("");
  const [tokens, setTokens] = useState<PiiTokenMetadata[] | null>(null);

  const onLoad = () =>
    run("session", async () => {
      const response = await piiSessionCall(accessToken!, sessionId, scope);
      setTokens(response.tokens);
    });

  const onRevoke = () =>
    run("revoke-session", async () => {
      await piiRevokeSessionCall(accessToken!, sessionId, scope);
      setTokens([]);
    });

  const disabled = !accessToken || busy !== null || sessionId.trim() === "";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Session</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          <Input
            value={sessionId}
            onChange={(event) => setSessionId(event.target.value)}
            placeholder="session_id from /pii/encode"
            className="max-w-md font-mono text-sm"
          />
          <Button onClick={onLoad} disabled={disabled}>
            {busy === "session" ? <UiLoadingSpinner className="mr-2 h-4 w-4" /> : null}
            Load
          </Button>
          <Button variant="secondary" onClick={onRevoke} disabled={disabled}>
            {busy === "revoke-session" ? (
              <UiLoadingSpinner className="mr-2 h-4 w-4" />
            ) : (
              <Trash2 className="mr-2 h-4 w-4" />
            )}
            Revoke session
          </Button>
        </div>

        {tokens !== null &&
          (tokens.length === 0 ? (
            <p className="text-sm text-gray-500">No live tokens in this session for the {scope} scope.</p>
          ) : (
            <TokenTable tokens={tokens} />
          ))}
      </CardContent>
    </Card>
  );
};

export default SessionBrowser;
