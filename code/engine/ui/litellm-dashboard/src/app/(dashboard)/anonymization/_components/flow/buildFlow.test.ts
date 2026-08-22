import { describe, expect, it } from "vitest";

import { segmentPrompt, segmentReply, vaultFrom } from "./buildFlow";

import type { PiiPlacement } from "@/components/networking";

const placement = (overrides: Partial<PiiPlacement> = {}): PiiPlacement => ({
  text_index: 0,
  start: 0,
  end: 3,
  entity_type: "PERSON",
  detector: "ner",
  score: 0.97,
  token: "<PERSON_1>",
  ...overrides,
});

const values = (segments: ReturnType<typeof segmentPrompt>) =>
  segments.map((segment) => (segment.kind === "plain" ? segment.text : `[${segment.value}=${segment.token}]`)).join("");

describe("segmentPrompt", () => {
  it("cuts the prompt around each tokenized span", () => {
    const at = { start: 6, end: 9 };
    const segments = segmentPrompt("email Ada now", [placement(at)]);
    expect(values(segments)).toBe("email [Ada=<PERSON_1>] now");
  });

  it("reassembles to exactly the text that was sent", () => {
    const prompt = "Ada wrote to Bob";
    const segments = segmentPrompt(prompt, [
      placement({ start: 0, end: 3 }),
      placement({ start: 13, end: 16, token: "<PERSON_2>" }),
    ]);
    const rebuilt = segments.map((s) => (s.kind === "plain" ? s.text : s.value)).join("");
    expect(rebuilt).toBe(prompt);
  });

  it("keeps a span that starts at the very beginning", () => {
    const segments = segmentPrompt("Ada wrote", [placement({ start: 0, end: 3 })]);
    expect(segments[0]).toMatchObject({ kind: "entity", value: "Ada" });
  });

  it("keeps a span that runs to the very end", () => {
    const segments = segmentPrompt("write to Ada", [placement({ start: 9, end: 12 })]);
    expect(segments.at(-1)).toMatchObject({ kind: "entity", value: "Ada" });
  });

  it("ignores placements belonging to another text in the batch", () => {
    const segments = segmentPrompt("email Ada", [placement({ text_index: 1, start: 0, end: 3 })]);
    expect(segments).toEqual([{ kind: "plain", text: "email Ada" }]);
  });

  it("carries the detector and score through for the highlight", () => {
    const byRules = { start: 0, end: 3, detector: "rules", score: 0.5 };
    const segments = segmentPrompt("Ada", [placement(byRules)]);
    expect(segments[0]).toMatchObject({ detector: "rules", score: 0.5 });
  });

  it("drops an overlapping span rather than splicing text that was never sent", () => {
    const segments = segmentPrompt("Ada Lovelace", [
      placement({ start: 0, end: 12 }),
      placement({ start: 4, end: 12, token: "<PERSON_2>" }),
    ]);
    const rebuilt = segments.map((s) => (s.kind === "plain" ? s.text : s.value)).join("");
    expect(rebuilt).toBe("Ada Lovelace");
  });

  it("returns the whole prompt as one plain run when nothing was found", () => {
    expect(segmentPrompt("nothing here", [])).toEqual([{ kind: "plain", text: "nothing here" }]);
  });
});

describe("vaultFrom", () => {
  it("pairs each token with the value it replaced", () => {
    expect(vaultFrom("email Ada", [placement({ start: 6, end: 9 })])).toEqual([
      { token: "<PERSON_1>", value: "Ada", entityType: "PERSON", detector: "ner" },
    ]);
  });

  it("lists a repeated value once, because one token stands for both", () => {
    const vault = vaultFrom("Ada and Ada", [placement({ start: 0, end: 3 }), placement({ start: 8, end: 11 })]);
    expect(vault).toHaveLength(1);
  });

  it("keeps distinct entities apart", () => {
    const vault = vaultFrom("Ada Bob", [
      placement({ start: 0, end: 3 }),
      placement({ start: 4, end: 7, token: "<PERSON_2>" }),
    ]);
    expect(vault.map((entry) => entry.value)).toEqual(["Ada", "Bob"]);
  });
});

describe("segmentReply", () => {
  const vault = [{ token: "<PERSON_1>", value: "Ada", entityType: "PERSON", detector: "ner" }];

  it("locates the tokens the model echoed back", () => {
    expect(values(segmentReply("I emailed <PERSON_1> today", vault))).toBe("I emailed [Ada=<PERSON_1>] today");
  });

  it("finds every occurrence of the same token", () => {
    const segments = segmentReply("<PERSON_1> replied to <PERSON_1>", vault);
    expect(segments.filter((segment) => segment.kind === "entity")).toHaveLength(2);
  });

  it("leaves a token the model distorted as plain text", () => {
    expect(segmentReply("I emailed <person_1> today", vault)).toEqual([
      { kind: "plain", text: "I emailed <person_1> today" },
    ]);
  });

  it("leaves a reply with no tokens untouched", () => {
    expect(segmentReply("done", vault)).toEqual([{ kind: "plain", text: "done" }]);
  });

  it("handles an empty vault", () => {
    expect(segmentReply("<PERSON_1> replied", [])).toEqual([{ kind: "plain", text: "<PERSON_1> replied" }]);
  });
});
