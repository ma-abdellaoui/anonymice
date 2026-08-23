import React from "react";

import EndpointCard from "./EndpointCard";
import { ENDPOINTS, useApiConsole } from "./useApiConsole";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

interface ApiConsoleProps {
  accessToken: string | null;
}

/**
 * The whole /pii surface, runnable, in the order you would actually use it.
 *
 * Each card sends the real request against this proxy with the session's own
 * credential and prints what came back, so the tab doubles as the reference
 * for the API and as proof that it does what the reference claims.
 */
const ApiConsole: React.FC<ApiConsoleProps> = ({ accessToken }) => {
  const api = useApiConsole(accessToken);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Shared inputs</CardTitle>
          <p className="text-xs text-muted-foreground">
            Every card below is filled in from these and from what earlier calls returned. Encode hands its
            session_id to decode and to both session routes, so you can work down the page without copying
            anything by hand. Edit a card and it stops following; press Reset to let it follow again.
          </p>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Text to work on
            <Textarea
              aria-label="Text to work on"
              value={api.context.sampleText}
              onChange={(event) => api.setSampleText(event.target.value)}
              rows={2}
              className="font-mono text-xs"
            />
          </label>
          <label className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono">subject_id</span>
            <Input
              aria-label="subject_id"
              value={api.context.subjectId}
              onChange={(event) => api.setSubjectId(event.target.value)}
              placeholder="optional, e.g. customer-4711"
              className="h-8 w-80 font-mono text-xs"
            />
            <span>
              File the tokens under a person, and the two subject routes have something to export or erase.
            </span>
          </label>
        </CardContent>
      </Card>

      {ENDPOINTS.map((endpoint) => (
        <EndpointCard key={endpoint.id} endpoint={endpoint} console={api} />
      ))}
    </div>
  );
};

export default ApiConsole;
