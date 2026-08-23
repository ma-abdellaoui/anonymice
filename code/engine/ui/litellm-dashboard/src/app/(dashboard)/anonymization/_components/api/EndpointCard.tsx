import React, { useState } from "react";

import { Check, Copy, Play, RotateCcw, Trash2 } from "lucide-react";

import type { EndpointSpec } from "./catalogue";
import { curlFor } from "./curlFor";
import type { ApiConsole } from "./useApiConsole";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { UiLoadingSpinner } from "@/components/ui/ui-loading-spinner";

interface EndpointCardProps {
  endpoint: EndpointSpec;
  console: ApiConsole;
}

const METHOD_TONE: Record<string, string> = {
  GET: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  POST: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  DELETE: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300",
};

const asText = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2);

const RunIcon: React.FC<{ running: boolean; confirming: boolean }> = ({ running, confirming }) => {
  if (running) return <UiLoadingSpinner className="mr-2 h-4 w-4" />;
  if (confirming) return <Trash2 className="mr-2 h-4 w-4" />;
  return <Play className="mr-2 h-4 w-4" />;
};

const EndpointCard: React.FC<EndpointCardProps> = ({ endpoint, console: api }) => {
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const state = api.stateOf(endpoint);
  const url = api.urlOf(endpoint);
  const hasBody = endpoint.body !== undefined;
  const missingParam = (endpoint.params ?? []).some((param) => state.params[param.name] === "");

  const copy = async () => {
    await navigator.clipboard.writeText(curlFor(endpoint, url, hasBody ? state.body : null));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const onRun = async () => {
    if (endpoint.destructive && !confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    await api.send(endpoint);
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
          <span className={`rounded px-1.5 py-0.5 font-mono text-xs ${METHOD_TONE[endpoint.method] ?? ""}`}>
            {endpoint.method}
          </span>
          <code className="font-mono text-sm text-foreground">{endpoint.path}</code>
          {endpoint.grant && <Badge variant="secondary">needs {endpoint.grant}</Badge>}
        </CardTitle>
        <p className="text-sm text-foreground">{endpoint.summary}</p>
        <p className="text-xs text-muted-foreground">{endpoint.when}</p>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        {(endpoint.params ?? []).map((param) => (
          <label key={param.name} className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono">{param.name}</span>
            <Input
              aria-label={`${endpoint.id} ${param.name}`}
              value={state.params[param.name] ?? ""}
              onChange={(event) => api.setParam(endpoint, param.name, event.target.value)}
              placeholder={param.from === "sessionId" ? "run encode first" : "set a subject above"}
              className="h-8 w-80 font-mono text-xs"
            />
          </label>
        ))}

        {hasBody && (
          <Textarea
            aria-label={`${endpoint.id} request body`}
            value={state.body}
            onChange={(event) => api.edit(endpoint, event.target.value)}
            rows={Math.min(10, state.body.split("\n").length + 1)}
            className="font-mono text-xs"
          />
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={onRun}
            disabled={state.running || missingParam}
            variant={confirming ? "destructive" : "default"}
            aria-label={`${endpoint.method} ${endpoint.path}`}
          >
            <RunIcon running={state.running} confirming={confirming} />
            {confirming ? "Confirm, this cannot be undone" : "Send"}
          </Button>

          <Button variant="secondary" onClick={() => void copy()}>
            {copied ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}
            {copied ? "Copied" : "Copy as curl"}
          </Button>

          {state.edited && (
            <Button variant="ghost" onClick={() => api.reset(endpoint)} aria-label={`Reset ${endpoint.id}`}>
              <RotateCcw className="mr-2 h-4 w-4" />
              Reset
            </Button>
          )}

          {state.result !== null && (
            <span
              className={`ml-auto font-mono text-xs ${state.result.failed ? "text-rose-600 dark:text-rose-400" : "text-emerald-700 dark:text-emerald-400"}`}
            >
              {state.result.status || "no response"} · {Math.round(state.result.ms)}ms
            </span>
          )}
        </div>

        {state.result !== null && (
          <pre className="max-h-72 overflow-auto rounded border border-border bg-muted/60 p-3 font-mono text-xs text-foreground">
            {asText(state.result.body)}
          </pre>
        )}
      </CardContent>
    </Card>
  );
};

export default EndpointCard;
