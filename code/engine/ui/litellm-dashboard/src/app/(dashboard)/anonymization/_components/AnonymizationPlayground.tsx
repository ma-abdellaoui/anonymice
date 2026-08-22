import React, { useState } from "react";

import { Lock, LockOpen, ScanSearch } from "lucide-react";

import SpanHighlighter from "./SpanHighlighter";
import {
  piiDecodeCall,
  piiDetectCall,
  piiEncodeCall,
  type PiiDetectResult,
  type PiiEncodeResponse,
  type PiiScopeType,
} from "@/components/networking";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { UiLoadingSpinner } from "@/components/ui/ui-loading-spinner";
import { toast } from "@/lib/toast";

const SAMPLE_TEXT = "Ada Lovelace emailed ada@example.com from 10.0.0.1 about card 4111 1111 1111 1111.";
const SCOPES: PiiScopeType[] = ["key", "user", "team", "organization"];

interface AnonymizationPlaygroundProps {
  accessToken: string | null;
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const AnonymizationPlayground: React.FC<AnonymizationPlaygroundProps> = ({ accessToken }) => {
  const [text, setText] = useState(SAMPLE_TEXT);
  const [detection, setDetection] = useState<PiiDetectResult | null>(null);
  const [encoded, setEncoded] = useState<PiiEncodeResponse | null>(null);
  const [decoded, setDecoded] = useState<string | null>(null);
  const [busy, setBusy] = useState<"detect" | "encode" | "decode" | null>(null);
  const [scope, setScope] = useState<PiiScopeType>("key");
  const [subjectId, setSubjectId] = useState("");

  const run = async (stage: "detect" | "encode" | "decode", action: () => Promise<void>) => {
    if (!accessToken) return;
    setBusy(stage);
    try {
      await action();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const onDetect = () =>
    run("detect", async () => {
      const response = await piiDetectCall(accessToken!, [text]);
      setDetection(response.results[0] ?? null);
    });

  const onEncode = () =>
    run("encode", async () => {
      const response = await piiEncodeCall(accessToken!, [text], {
        sessionId: encoded?.session_id,
        scopeType: scope,
        subjectId: subjectId.trim() || undefined,
      });
      setEncoded(response);
      setDecoded(null);
    });

  const onDecode = () =>
    run("decode", async () => {
      if (!encoded) return;
      const response = await piiDecodeCall(accessToken!, encoded.texts, encoded.session_id, scope);
      setDecoded(response.texts[0] ?? "");
    });

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Source text</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={4}
            className="font-mono text-sm"
            placeholder="Paste text containing PII to see how it is detected and encoded"
          />
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-sm text-gray-500" htmlFor="playground-scope">
              Scope
            </label>
            <select
              id="playground-scope"
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
            <Input
              value={subjectId}
              onChange={(event) => setSubjectId(event.target.value)}
              placeholder="subject_id (optional)"
              className="max-w-xs font-mono text-sm"
            />
          </div>
          <p className="text-xs text-gray-400">
            Scope decides who can later resolve these tokens, and is only honoured when the vault is enabled. A
            subject_id makes the values reachable by export and erasure; it defaults to the request&apos;s end user.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={onDetect} disabled={!accessToken || busy !== null || text.trim() === ""}>
              {busy === "detect" ? (
                <UiLoadingSpinner className="mr-2 h-4 w-4" />
              ) : (
                <ScanSearch className="mr-2 h-4 w-4" />
              )}
              Detect
            </Button>
            <Button onClick={onEncode} disabled={!accessToken || busy !== null || text.trim() === ""}>
              {busy === "encode" ? <UiLoadingSpinner className="mr-2 h-4 w-4" /> : <Lock className="mr-2 h-4 w-4" />}
              Encode
            </Button>
            <Button variant="secondary" onClick={onDecode} disabled={!accessToken || busy !== null || !encoded}>
              {busy === "decode" ? (
                <UiLoadingSpinner className="mr-2 h-4 w-4" />
              ) : (
                <LockOpen className="mr-2 h-4 w-4" />
              )}
              Decode
            </Button>
          </div>
        </CardContent>
      </Card>

      {detection && (
        <Card>
          <CardHeader>
            <CardTitle>
              Detected{" "}
              <span className="text-sm font-normal text-gray-500">
                {detection.spans.length} span{detection.spans.length === 1 ? "" : "s"} ·{" "}
                {detection.ner_stage_ran ? "model stage ran" : "rules only"}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <SpanHighlighter text={text} spans={detection.spans} />
            {detection.spans.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {detection.spans.map((span, index) => (
                  <span
                    key={`${span.entity_type}-${span.start}-${index}`}
                    className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700"
                  >
                    {span.entity_type} · {span.detector} · {span.score.toFixed(2)}
                  </span>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {encoded && (
        <Card>
          <CardHeader>
            <CardTitle>
              Encoded <span className="text-sm font-normal text-gray-500">session {encoded.session_id}</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="whitespace-pre-wrap break-words font-mono text-sm text-gray-700">{encoded.texts[0]}</p>
            {encoded.tokens.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {encoded.tokens.map((token) => (
                  <span
                    key={token.token}
                    className="rounded-full bg-gray-100 px-2 py-0.5 font-mono text-xs text-gray-700"
                  >
                    {token.token}
                  </span>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {decoded !== null && (
        <Card>
          <CardHeader>
            <CardTitle>
              Decoded{" "}
              <span className="text-sm font-normal text-gray-500">
                {decoded === text ? "round-trip matches the source" : "differs from the source"}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-wrap break-words font-mono text-sm text-gray-700">{decoded}</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
};

export default AnonymizationPlayground;
