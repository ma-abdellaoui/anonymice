import React, { useEffect, useRef, useState } from "react";

import { AlertTriangle, Play, RotateCcw } from "lucide-react";

import { alignEncoding, type Alignment } from "./alignEncoding";
import TokenDiff from "./TokenDiff";
import { makeOpenAIChatCompletionRequest } from "@/components/llm_calls/chat_completion";
import { fetchAvailableModels, type ModelGroup } from "@/components/llm_calls/fetch_models";
import {
  piiDecodeCall,
  piiDetectCall,
  piiEncodeCall,
  type PiiEncodeResponse,
  type PiiSpan,
} from "@/components/networking";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { UiLoadingSpinner } from "@/components/ui/ui-loading-spinner";
import { ApiError } from "@/lib/http/client";
import { toast } from "@/lib/toast";

const SCENARIOS: readonly { readonly label: string; readonly text: string }[] = [
  {
    label: "Support ticket",
    text: "Hallo, hier ist Ada Lovelace. Bitte erstattet die Buchung auf mein Konto CH93 0076 2011 6238 5295 7. Ihr erreicht mich unter ada.lovelace@example.ch oder +41 79 555 21 12.",
  },
  {
    label: "Card dispute",
    text: "Ada Lovelace disputes a charge on card 4111 1111 1111 1111. Ada Lovelace says the merchant billed twice on 14 March. Reply to ada@example.com.",
  },
  {
    label: "Nothing sensitive",
    text: "Summarise our refund policy for a customer who paid by invoice and wants a partial credit.",
  },
];

type Stage = "idle" | "detecting" | "encoding" | "calling" | "decoding" | "done";

type Blocker =
  | { readonly kind: "not-configured" }
  | { readonly kind: "no-decode-permission" }
  | { readonly kind: "no-model" };

const STAGE_LABEL: Record<Exclude<Stage, "idle" | "done">, string> = {
  detecting: "Detecting",
  encoding: "Encoding",
  calling: "Waiting on the model",
  decoding: "Decoding",
};

const blockerFor = (error: unknown): Blocker | null => {
  if (!(error instanceof ApiError)) return null;
  if (error.status === 501) return { kind: "not-configured" };
  if (error.status === 403) return { kind: "no-decode-permission" };
  return null;
};

const BlockerBanner: React.FC<{ blocker: Blocker }> = ({ blocker }) => (
  <div className="flex items-start gap-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-amber-300">
    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
    <div>
      {blocker.kind === "not-configured" && (
        <>
          <p className="font-medium">PII anonymization is not configured on this proxy.</p>
          <p className="mt-1">
            Set <code className="font-mono">PRESIDIO_ANALYZER_API_BASE</code> (and optionally{" "}
            <code className="font-mono">LITELLM_PII_NER_API_BASE</code>) and restart the proxy.
          </p>
        </>
      )}
      {blocker.kind === "no-decode-permission" && (
        <>
          <p className="font-medium">This key may encode but not decode.</p>
          <p className="mt-1">
            Everything above is real: the provider received the tokenized text. To restore the reply, set{" "}
            <code className="font-mono">permissions.allow_pii_decode = true</code> on the key.
          </p>
        </>
      )}
      {blocker.kind === "no-model" && (
        <>
          <p className="font-medium">No model is available to call.</p>
          <p className="mt-1">
            Add a model to the proxy, or use the Playground tab to exercise encode and decode alone.
          </p>
        </>
      )}
    </div>
  </div>
);

const Step: React.FC<{ index: number; title: string; caption?: string; children: React.ReactNode }> = ({
  index,
  title,
  caption,
  children,
}) => (
  <Card>
    <CardHeader>
      <CardTitle className="flex items-baseline gap-2">
        <span className="text-xs text-gray-400">{index}</span>
        {title}
        {caption && <span className="text-sm font-normal text-gray-500">{caption}</span>}
      </CardTitle>
    </CardHeader>
    <CardContent>{children}</CardContent>
  </Card>
);

interface DemoOutcomeProps {
  original: string;
  encodedText: string | null;
  alignments: readonly Alignment[];
  spans: readonly PiiSpan[];
  unalignedReason: string | null;
  modelReply: string | null;
  decodedReply: string | null;
  blocker: Blocker | null;
}

const DemoOutcome: React.FC<DemoOutcomeProps> = ({
  original,
  encodedText,
  alignments,
  spans,
  unalignedReason,
  modelReply,
  decodedReply,
  blocker,
}) => {
  if (blocker?.kind === "not-configured") {
    return <BlockerBanner blocker={blocker} />;
  }

  return (
    <>
      {encodedText !== null && (
        <Step
          index={1}
          title="What left the building"
          caption={`${alignments.length} value${alignments.length === 1 ? "" : "s"} replaced`}
        >
          <TokenDiff
            original={original}
            encoded={encodedText}
            alignments={alignments}
            spans={spans}
            unalignedReason={unalignedReason}
          />
        </Step>
      )}

      {modelReply !== null && (
        <Step index={2} title="What the model replied" caption="verbatim, still tokenized">
          <p className="whitespace-pre-wrap break-words font-mono text-sm text-gray-700">
            {modelReply === "" ? <span className="text-gray-400">waiting…</span> : modelReply}
          </p>
        </Step>
      )}

      {blocker !== null && <BlockerBanner blocker={blocker} />}

      {decodedReply !== null && (
        <Step index={3} title="What you get back" caption="tokens resolved from the vault">
          <p className="whitespace-pre-wrap break-words font-mono text-sm text-gray-700">{decodedReply}</p>
        </Step>
      )}
    </>
  );
};

interface AnonymizationDemoProps {
  accessToken: string | null;
}

const AnonymizationDemo: React.FC<AnonymizationDemoProps> = ({ accessToken }) => {
  const [text, setText] = useState(SCENARIOS[0].text);
  const [models, setModels] = useState<ModelGroup[]>([]);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>("idle");
  const [spans, setSpans] = useState<readonly PiiSpan[]>([]);
  const [encoded, setEncoded] = useState<PiiEncodeResponse | null>(null);
  const [alignments, setAlignments] = useState<readonly Alignment[]>([]);
  const [unalignedReason, setUnalignedReason] = useState<string | null>(null);
  const [modelReply, setModelReply] = useState<string | null>(null);
  const [decodedReply, setDecodedReply] = useState<string | null>(null);
  const [blocker, setBlocker] = useState<Blocker | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const replyRef = useRef("");

  useEffect(() => {
    if (!accessToken) return;
    fetchAvailableModels(accessToken)
      .then((available) => {
        setModels(available);
        setSelectedModel((current) => current ?? available[0]?.model_group ?? null);
      })
      .catch(() => setModels([]));
  }, [accessToken]);

  const reset = () => {
    setSpans([]);
    setEncoded(null);
    setAlignments([]);
    setUnalignedReason(null);
    setModelReply(null);
    setDecodedReply(null);
    setBlocker(null);
    setStage("idle");
    replyRef.current = "";
  };

  const newSession = () => {
    setSessionId(null);
    reset();
  };

  const loadScenario = (scenario: string) => {
    setText(scenario);
    reset();
  };

  const run = async () => {
    if (!accessToken) return;
    reset();

    try {
      setStage("detecting");
      const detected = await piiDetectCall(accessToken, [text]);
      setSpans(detected.results[0]?.spans ?? []);

      setStage("encoding");
      const encodedResponse = await piiEncodeCall(accessToken, [text], sessionId ?? undefined);
      setEncoded(encodedResponse);
      setSessionId(encodedResponse.session_id);

      const encodedText = encodedResponse.texts[0] ?? text;
      const alignment = alignEncoding(text, encodedText);
      setAlignments(alignment.kind === "aligned" ? alignment.alignments : []);
      setUnalignedReason(alignment.kind === "aligned" ? null : alignment.reason);

      if (!selectedModel) {
        setBlocker({ kind: "no-model" });
        setStage("done");
        return;
      }

      setStage("calling");
      setModelReply("");
      await makeOpenAIChatCompletionRequest(
        [{ role: "user", content: encodedText }],
        (chunk) => {
          replyRef.current += chunk;
          setModelReply(replyRef.current);
        },
        selectedModel,
        accessToken,
      );

      setStage("decoding");
      const restored = await piiDecodeCall(accessToken, [replyRef.current], encodedResponse.session_id);
      setDecodedReply(restored.texts[0] ?? "");
      setStage("done");
    } catch (error) {
      const known = blockerFor(error);
      if (known) {
        setBlocker(known);
      } else {
        toast.error(error instanceof Error ? error.message : String(error));
      }
      setStage("done");
    }
  };

  const busy = stage !== "idle" && stage !== "done";
  const encodedText = encoded?.texts[0] ?? null;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Send something private to a model</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            {SCENARIOS.map((scenario) => (
              <Button
                key={scenario.label}
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => loadScenario(scenario.text)}
              >
                {scenario.label}
              </Button>
            ))}
          </div>

          <Textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={4}
            className="font-mono text-sm"
            aria-label="Text to send"
          />

          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={run} disabled={!accessToken || busy || text.trim() === ""}>
              {busy ? <UiLoadingSpinner className="mr-2 h-4 w-4" /> : <Play className="mr-2 h-4 w-4" />}
              {busy ? STAGE_LABEL[stage as Exclude<Stage, "idle" | "done">] : "Run"}
            </Button>

            <Select value={selectedModel ?? ""} onValueChange={(value) => setSelectedModel(String(value))}>
              <SelectTrigger size="sm" aria-label="Model" disabled={busy || models.length === 0}>
                <span className="text-muted-foreground">Model</span>
                <span className="truncate font-semibold">{selectedModel ?? "none available"}</span>
              </SelectTrigger>
              <SelectContent>
                {models.map((model) => (
                  <SelectItem key={model.model_group} value={model.model_group}>
                    {model.model_group}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <div className="ml-auto flex items-center gap-2 text-xs text-gray-500">
              {sessionId && <span className="font-mono">session {sessionId.slice(0, 12)}</span>}
              <Button variant="secondary" size="sm" onClick={newSession} disabled={busy || sessionId === null}>
                <RotateCcw className="mr-2 h-3 w-3" />
                New session
              </Button>
            </div>
          </div>

          <p className="text-xs text-gray-500">
            Tokens stay stable within a session, so the same person keeps the same token across turns. Start a new
            session to mint fresh ones.
          </p>
        </CardContent>
      </Card>

      <DemoOutcome
        original={text}
        encodedText={encodedText}
        alignments={alignments}
        spans={spans}
        unalignedReason={unalignedReason}
        modelReply={modelReply}
        decodedReply={decodedReply}
        blocker={blocker}
      />
    </div>
  );
};

export default AnonymizationDemo;
