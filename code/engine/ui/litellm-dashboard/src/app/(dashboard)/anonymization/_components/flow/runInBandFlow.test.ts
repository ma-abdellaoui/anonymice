import { beforeEach, describe, expect, it, vi } from "vitest";

import { runInBandFlow } from "./runInBandFlow";

import { chatCompletionWithCallId, piiActivityCall } from "@/components/networking";

vi.mock("@/components/networking", () => ({
  chatCompletionWithCallId: vi.fn(),
  piiActivityCall: vi.fn(),
}));

const PROMPT = "Pay Ada Lovelace at ada@example.com";
const ENCODED = "Pay <PERSON_1> at <EMAIL_ADDRESS_1>";
const REPLY_TOKENS = "Paid <PERSON_1>, receipt to <EMAIL_ADDRESS_1>.";
const REPLY_VALUES = "Paid Ada Lovelace, receipt to ada@example.com.";

const placement = (over: Partial<Record<string, unknown>> = {}) => ({
  token: "<PERSON_1>",
  entity_type: "PERSON",
  detector: "ner",
  score: 0.9,
  action: "encode",
  text_index: 1,
  start: 4,
  end: 16,
  value: "Ada Lovelace",
  ...over,
});

const event = (over: Record<string, unknown>) => ({
  id: "e1",
  at: "2026-01-01T00:00:00Z",
  surface: "guardrail",
  direction: "encode",
  outcome: { kind: "applied", entity_type: null, reason: null },
  duration_ms: 10,
  entity_counts: {},
  action_counts: {},
  token_count: 2,
  resolved_count: 0,
  ner_stage_ran: true,
  request_id: "call-1",
  session_id: null,
  key_alias: null,
  user_id: null,
  model: "m",
  guardrail_name: "pii-anonymizer",
  browser: null,
  capture: null,
  capture_withheld: false,
  ...over,
});

const EMAIL_PLACEMENT = {
  token: "<EMAIL_ADDRESS_1>",
  entity_type: "EMAIL_ADDRESS",
  detector: "rules",
  score: 1,
  start: 20,
  end: 36,
  value: "ada@example.com",
};

const ENCODE_CAPTURE = {
  before: ["system instruction", PROMPT],
  after: ["system instruction", ENCODED],
  placements: [placement(), placement(EMAIL_PLACEMENT)],
};

const ENCODE_EVENT = { direction: "encode", duration_ms: 12, capture: ENCODE_CAPTURE };

const DECODE_CAPTURE = { before: [REPLY_TOKENS], after: [REPLY_VALUES], placements: [] };

const DECODE_EVENT = { id: "e2", direction: "decode", duration_ms: 4, capture: DECODE_CAPTURE };

const encodeEvent = event(ENCODE_EVENT);

const decodeEvent = event(DECODE_EVENT);

const NO_CAPTURE = { direction: "encode", capture: null, capture_withheld: false };

const WITHHELD_CAPTURE = { direction: "encode", capture: null, capture_withheld: true };

const request = { accessToken: "sk-1", prompt: PROMPT, model: "m", onStage: vi.fn() };

const feed = (events: unknown[]) =>
  vi.mocked(piiActivityCall).mockResolvedValue({ events, capture_enabled: true } as never);

describe("runInBandFlow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(chatCompletionWithCallId).mockResolvedValue({ content: REPLY_VALUES, callId: "call-1" });
  });

  it("sends the prompt untouched, so the guardrail is what does the encoding", async () => {
    feed([encodeEvent, decodeEvent]);
    await runInBandFlow(request);
    const [, , messages] = vi.mocked(chatCompletionWithCallId).mock.calls[0];
    expect(messages.at(-1)).toEqual({ role: "user", content: PROMPT });
  });

  it("reads back only the events this request produced", async () => {
    feed([encodeEvent, decodeEvent]);
    await runInBandFlow(request);
    expect(vi.mocked(piiActivityCall).mock.calls[0][1]).toMatchObject({ requestId: "call-1" });
  });

  it("shows what crossed the boundary, not what was typed", async () => {
    feed([encodeEvent, decodeEvent]);
    const run = await runInBandFlow(request);
    expect(run.encodedPrompt).toBe(ENCODED);
    expect(run.encodedPrompt).not.toContain("Ada Lovelace");
  });

  it("picks the message that is the prompt rather than the first one captured", async () => {
    feed([encodeEvent, decodeEvent]);
    const run = await runInBandFlow(request);
    expect(run.prompt).toBe(PROMPT);
    expect(run.promptSegments.some((s) => s.kind === "entity" && s.value === "Ada Lovelace")).toBe(true);
  });

  it("keeps both halves of the reply, tokenized and resolved", async () => {
    feed([encodeEvent, decodeEvent]);
    const run = await runInBandFlow(request);
    expect(run.providerReply).toBe(REPLY_TOKENS);
    expect(run.decodedReply).toBe(REPLY_VALUES);
  });

  it("splits the wall clock across the stages the guardrail measured", async () => {
    feed([encodeEvent, decodeEvent]);
    const run = await runInBandFlow(request);
    expect(run.timings.encode).toBe(12);
    expect(run.timings.decode).toBe(4);
    expect(run.timings.provider).toBeGreaterThanOrEqual(0);
  });

  it("marks the run as the in-band path", async () => {
    feed([encodeEvent, decodeEvent]);
    expect((await runInBandFlow(request)).mode).toBe("in-band");
  });

  it("says capture is off rather than animating an empty run", async () => {
    feed([event(NO_CAPTURE)]);
    await expect(runInBandFlow(request)).rejects.toThrow(/LITELLM_PII_ACTIVITY_CAPTURE_TEXT/);
  });

  it("distinguishes a withheld capture from one that was never taken", async () => {
    feed([event(WITHHELD_CAPTURE)]);
    await expect(runInBandFlow(request)).rejects.toThrow(/may not read it back/);
  });

  it("says so when the guardrail did not run for this request", async () => {
    feed([]);
    await expect(runInBandFlow(request)).rejects.toThrow(/recorded nothing/);
  });

  it("refuses to guess when the proxy returned no call id", async () => {
    vi.mocked(chatCompletionWithCallId).mockResolvedValue({ content: REPLY_VALUES, callId: null });
    feed([encodeEvent, decodeEvent]);
    await expect(runInBandFlow(request)).rejects.toThrow(/x-litellm-call-id/);
  });

  it("still shows the encode half when nothing in the reply needed decoding", async () => {
    feed([encodeEvent]);
    const run = await runInBandFlow(request);
    expect(run.encodedPrompt).toBe(ENCODED);
    expect(run.decodedReply).toBe(REPLY_VALUES);
    expect(run.timings.decode).toBe(0);
  });
});
