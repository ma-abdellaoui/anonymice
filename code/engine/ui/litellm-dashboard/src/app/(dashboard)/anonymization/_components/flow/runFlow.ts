import { segmentPrompt, segmentReply, vaultFrom } from "./buildFlow";
import type { FlowRun } from "./flowTypes";

import { apiClient, piiDecodeCall, piiEncodeCall } from "@/components/networking";

export type FlowStage = "encode" | "provider" | "decode";

export const STAGE_LABELS: Record<FlowStage, string> = {
  encode: "Detecting and encoding",
  provider: "Asking the provider",
  decode: "Decoding the answer",
};

export interface FlowRequest {
  accessToken: string;
  prompt: string;
  model: string;
  onStage: (stage: FlowStage) => void;
}

interface ChatChoice {
  message?: { content?: string | null };
}

interface ChatResponse {
  choices?: ChatChoice[];
}

const REPLY_INSTRUCTION =
  "Answer in one or two short sentences. Any <LIKE_THIS> placeholder in the prompt is a real name or " +
  "identifier that was substituted out; refer to it by repeating the placeholder exactly as written.";

const replyText = (response: ChatResponse): string => response.choices?.[0]?.message?.content ?? "";

/**
 * Run the pipeline for real and keep every intermediate form.
 *
 * The tokenized prompt is sent through the proxy with the guardrail in place,
 * which is a no-op on text that already holds tokens rather than values. That
 * is worth doing rather than routing around: the same request path a real
 * caller uses is the one being demonstrated.
 */
export const runFlow = async (request: FlowRequest): Promise<FlowRun> => {
  const startedEncode = performance.now();
  request.onStage("encode");
  const encoded = await piiEncodeCall(request.accessToken, [request.prompt]);
  const encodeMs = performance.now() - startedEncode;

  const encodedPrompt = encoded.texts[0] ?? request.prompt;
  const vault = vaultFrom(request.prompt, encoded.placements ?? []);

  const startedProvider = performance.now();
  request.onStage("provider");
  const completion = await apiClient.post<ChatResponse>("/v1/chat/completions", {
    accessToken: request.accessToken,
    body: {
      model: request.model,
      messages: [
        { role: "system", content: REPLY_INSTRUCTION },
        { role: "user", content: encodedPrompt },
      ],
    },
  });
  const providerMs = performance.now() - startedProvider;
  const providerReply = replyText(completion);

  const startedDecode = performance.now();
  request.onStage("decode");
  const decoded = await piiDecodeCall(request.accessToken, [providerReply], encoded.session_id);
  const decodeMs = performance.now() - startedDecode;

  return {
    mode: "endpoint",
    prompt: request.prompt,
    promptSegments: segmentPrompt(request.prompt, encoded.placements ?? []),
    encodedPrompt,
    vault,
    providerReply,
    replySegments: segmentReply(providerReply, vault),
    decodedReply: decoded.texts[0] ?? providerReply,
    sessionId: encoded.session_id,
    model: request.model,
    nerStageRan: encoded.ner_stage_ran ?? false,
    timings: { encode: encodeMs, provider: providerMs, decode: decodeMs },
  };
};
