import React, { useState } from "react";

import { ChevronLeft, ChevronRight, Pause, Play, RotateCcw, Send } from "lucide-react";

import FlowStage from "./FlowStage";
import FlowStepper from "./FlowStepper";
import type { FlowMode, FlowRun } from "./flowTypes";
import { runInBandFlow } from "./runInBandFlow";
import { runFlow, STAGE_LABELS, type FlowStage as RunStage } from "./runFlow";
import { useFlowPlayback } from "./useFlowPlayback";
import { useModelChoices } from "./useModelChoices";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { UiLoadingSpinner } from "@/components/ui/ui-loading-spinner";
import { toast } from "@/lib/toast";

const SAMPLE_PROMPT =
  "Draft a short reply to Anna Meier confirming we received her payment from CH93 0076 2011 6238 5295 7, " +
  "and copy her at anna.meier@example.ch.";

const SPEEDS = [0.5, 1, 1.5, 2];

const MODE_LABELS: Record<FlowMode, string> = {
  "in-band": "Through the proxy",
  endpoint: "Through the vault API",
};

const MODE_NOTES: Record<FlowMode, string> = {
  "in-band":
    "The prompt goes to /v1/chat/completions untouched and the guardrail does the work, which is what any " +
    "client pointed at the proxy gets. Tokens are ordinal, and the mapping lives only for this request.",
  endpoint:
    "The console drives /pii/encode and /pii/decode itself. Tokens are random handles kept in the vault, so " +
    "they stay resolvable long after the call, at the cost of a shape models more often distort.",
};

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

interface AnonymizationFlowProps {
  accessToken: string | null;
  userId: string | null;
  userRole: string | null;
}

/**
 * The round trip, end to end, as something you can watch.
 *
 * Every panel is filled from a real call, either the guardrail doing the work
 * in-band on an ordinary completion or the console driving /pii/encode and
 * /pii/decode itself. Nothing here is staged, which is the only reason it is
 * worth showing.
 */
const AnonymizationFlow: React.FC<AnonymizationFlowProps> = ({ accessToken, userId, userRole }) => {
  const [prompt, setPrompt] = useState(SAMPLE_PROMPT);
  const [model, setModel] = useState("");
  const [run, setRun] = useState<FlowRun | null>(null);
  const [stage, setStage] = useState<RunStage | null>(null);
  const [mode, setMode] = useState<FlowMode>("in-band");

  const models = useModelChoices(accessToken, userId, userRole);
  const playback = useFlowPlayback(run !== null);
  const chosenModel = model || models[0] || "";
  const ready = accessToken !== null && chosenModel !== "" && prompt.trim() !== "";
  const busy = stage !== null;

  const onSend = async () => {
    if (!accessToken || !chosenModel) return;
    setRun(null);
    try {
      const request = { accessToken, prompt, model: chosenModel, onStage: setStage };
      const result = mode === "in-band" ? await runInBandFlow(request) : await runFlow(request);
      setRun(result);
      playback.restart();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setStage(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl border border-border bg-card p-4">
        <Textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          rows={3}
          className="font-mono text-sm"
          aria-label="Prompt"
          placeholder="Write a prompt containing something you would not want a provider to keep"
        />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            Model
            <select
              aria-label="Model"
              className="rounded border border-border px-2 py-1.5 text-sm text-foreground"
              value={chosenModel}
              onChange={(event) => setModel(event.target.value)}
            >
              {models.length === 0 && <option value="">no models configured</option>}
              {models.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            Path
            <select
              aria-label="Path"
              className="rounded border border-border px-2 py-1.5 text-sm text-foreground"
              value={mode}
              onChange={(event) => setMode(event.target.value as FlowMode)}
            >
              {(Object.keys(MODE_LABELS) as FlowMode[]).map((value) => (
                <option key={value} value={value}>
                  {MODE_LABELS[value]}
                </option>
              ))}
            </select>
          </label>

          <Button
            onClick={onSend}
            disabled={!ready || busy}
            className="ml-auto"
          >
            {stage !== null ? (
              <UiLoadingSpinner className="mr-2 h-4 w-4" />
            ) : (
              <Send className="mr-2 h-4 w-4" />
            )}
            {stage !== null ? STAGE_LABELS[stage] : "Send it through"}
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">{MODE_NOTES[mode]}</p>
      </div>

      {run === null ? (
        <div className="rounded-xl border border-dashed border-border bg-muted/60 p-12 text-center">
          <p className="text-sm text-muted-foreground">
            Send a prompt to watch it get encoded, cross the boundary, come back, and get decoded.
          </p>
        </div>
      ) : (
        <>
          <FlowStepper
            beat={playback.beat}
            index={playback.index}
            timings={run.timings}
            onSelect={playback.goTo}
          />

          <FlowStage run={run} beat={playback.beat} />

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={playback.previous} disabled={playback.index === 0} aria-label="Previous step">
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button onClick={playback.toggle} aria-label={playback.isPlaying ? "Pause" : "Play"}>
              {playback.isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            </Button>
            <Button variant="secondary" onClick={playback.next} disabled={playback.atEnd} aria-label="Next step">
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button variant="secondary" onClick={playback.restart} aria-label="Replay">
              <RotateCcw className="mr-2 h-4 w-4" />
              Replay
            </Button>

            <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
              Speed
              <select
                aria-label="Speed"
                className="rounded border border-border px-2 py-1 text-sm text-foreground"
                value={playback.speed}
                onChange={(event) => playback.setSpeed(Number(event.target.value))}
              >
                {SPEEDS.map((value) => (
                  <option key={value} value={value}>
                    {value}x
                  </option>
                ))}
              </select>
            </label>
          </div>

          <p className="text-xs text-muted-foreground">
            {run.mode === "in-band" ? "Request" : "Session"} {run.sessionId}
            {run.nerStageRan ? " · the model stage ran" : " · rules stage only, so names need the NER stage enabled"}
          </p>
        </>
      )}
    </div>
  );
};

export default AnonymizationFlow;
