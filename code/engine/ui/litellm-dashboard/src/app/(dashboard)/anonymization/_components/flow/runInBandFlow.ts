import { segmentPrompt, segmentReply, vaultFrom } from "./buildFlow";
import type { FlowRun } from "./flowTypes";
import type { FlowRequest } from "./runFlow";

import {
  chatCompletionWithCallId,
  piiActivityCall,
  type PiiActivityEvent,
  type PiiPlacement,
  type PiiTextCapture,
} from "@/components/networking";

const REPLY_INSTRUCTION =
  "Answer in one or two short sentences. Any <LIKE_THIS> placeholder in the prompt is a real name or " +
  "identifier that was substituted out; refer to it by repeating the placeholder exactly as written.";

const CAPTURE_OFF =
  "The guardrail ran, but the activity log is not keeping the text it worked on, so there is nothing to " +
  "show. Set LITELLM_PII_ACTIVITY_CAPTURE_TEXT=true on the proxy and restart it.";

const CAPTURE_WITHHELD =
  "The guardrail ran and the text was captured, but this session may not read it back. Decode access is " +
  "what governs reading a captured value.";

const NO_CALL_ID =
  "The proxy did not return an x-litellm-call-id header, so this run cannot be matched to what the " +
  "guardrail did to it.";

const NOT_RECORDED =
  "The guardrail recorded nothing for this request. It is most likely not enabled for the key or the " +
  "model that was used.";

/** The activity log holds one entry per message, so find the one that is the prompt. */
const indexOfPrompt = (capture: PiiTextCapture, prompt: string): number => {
  const exact = capture.before.indexOf(prompt);
  return exact === -1 ? capture.before.length - 1 : exact;
};

const placementsIn = (capture: PiiTextCapture, textIndex: number): PiiPlacement[] =>
  capture.placements
    .filter((placement) => placement.text_index === textIndex)
    .map((placement) => ({ ...placement, text_index: 0 }));

const captureOf = (event: PiiActivityEvent): PiiTextCapture => {
  if (event.capture !== null) return event.capture;
  throw new Error(event.capture_withheld ? CAPTURE_WITHHELD : CAPTURE_OFF);
};

const firstWhere = (events: PiiActivityEvent[], direction: "encode" | "decode"): PiiActivityEvent | undefined =>
  events.find((event) => event.direction === direction && event.surface === "guardrail");

/**
 * Run the pipeline the way a real caller does, and read back what happened.
 *
 * The prompt goes to /v1/chat/completions untouched: the guardrail encodes it
 * on the way out and decodes the answer on the way back, exactly as it would
 * for any client pointed at the proxy. Nothing here drives the anonymizer
 * directly. What the panels show is then read out of the activity log by the
 * call id the proxy returned, so the visualization is a recording of the
 * request rather than a second, parallel one made to illustrate it.
 *
 * The tokens are the guardrail's ordinal ones, `<PERSON_1>`, which survive a
 * round trip through a model far better than a random handle does: a model
 * asked to repeat `<IBAN_CODE:69ecb84f496afbd0>` will often decide the hex is
 * the value and hand back a fragment of it that nothing can resolve.
 */
export const runInBandFlow = async (request: FlowRequest): Promise<FlowRun> => {
  const started = performance.now();
  request.onStage("encode");
  const completion = await chatCompletionWithCallId(request.accessToken, request.model, [
    { role: "system", content: REPLY_INSTRUCTION },
    { role: "user", content: request.prompt },
  ]);
  const totalMs = performance.now() - started;
  if (completion.callId === null) throw new Error(NO_CALL_ID);

  request.onStage("decode");
  const activity = await piiActivityCall(request.accessToken, {
    requestId: completion.callId,
    limit: 20,
  });
  const encodeEvent = firstWhere(activity.events, "encode");
  const decodeEvent = firstWhere(activity.events, "decode");
  if (encodeEvent === undefined) throw new Error(NOT_RECORDED);

  const encodeCapture = captureOf(encodeEvent);
  const textIndex = indexOfPrompt(encodeCapture, request.prompt);
  const prompt = encodeCapture.before[textIndex] ?? request.prompt;
  const placements = placementsIn(encodeCapture, textIndex);
  const vault = vaultFrom(prompt, placements);

  const decodeCapture = decodeEvent === undefined ? null : captureOf(decodeEvent);
  const providerReply = decodeCapture?.before[0] ?? completion.content;
  const decodedReply = decodeCapture?.after[0] ?? completion.content;

  const encodeMs = encodeEvent.duration_ms;
  const decodeMs = decodeEvent?.duration_ms ?? 0;

  return {
    mode: "in-band",
    prompt,
    promptSegments: segmentPrompt(prompt, placements),
    encodedPrompt: encodeCapture.after[textIndex] ?? prompt,
    vault,
    providerReply,
    replySegments: segmentReply(providerReply, vault),
    decodedReply,
    sessionId: encodeEvent.request_id ?? "",
    model: request.model,
    nerStageRan: encodeEvent.ner_stage_ran,
    timings: {
      encode: encodeMs,
      provider: Math.max(0, totalMs - encodeMs - decodeMs),
      decode: decodeMs,
    },
  };
};
