import { describe, expect, it } from "vitest";

import { alignEncoding, type Alignment } from "./alignEncoding";

const aligned = (original: string, encoded: string): readonly Alignment[] => {
  const result = alignEncoding(original, encoded);
  if (result.kind !== "aligned") {
    throw new Error(`expected an alignment, got: ${result.reason}`);
  }
  return result.alignments;
};

const unalignedReason = (original: string, encoded: string): string => {
  const result = alignEncoding(original, encoded);
  if (result.kind !== "unaligned") {
    throw new Error(`expected no alignment, got ${result.alignments.length} alignments`);
  }
  return result.reason;
};

const pairs = (original: string, encoded: string): readonly (readonly [string, string])[] =>
  aligned(original, encoded).map((a) => [a.token, a.sourceValue] as const);

describe("alignEncoding", () => {
  it("returns no alignments when the encoder found nothing to replace", () => {
    expect(aligned("nothing sensitive here", "nothing sensitive here")).toEqual([]);
  });

  it("refuses to guess when the texts differ but carry no tokens", () => {
    expect(unalignedReason("Ada Lovelace", "REDACTED")).toBe(
      "the encoded text carries no tokens yet differs from the source",
    );
  });

  it("recovers the value a single mid-sentence token replaced", () => {
    const [only] = aligned("email Ada Lovelace today", "email <PERSON_1> today");
    const expected = {
      token: "<PERSON_1>",
      entityType: "PERSON",
      masked: false,
      sourceStart: 6,
      sourceEnd: 18,
      sourceValue: "Ada Lovelace",
      encodedStart: 6,
      encodedEnd: 16,
    };
    expect(only).toMatchObject(expected);
  });

  it("recovers a token that opens the text", () => {
    expect(pairs("Ada Lovelace wrote in", "<PERSON_1> wrote in")).toEqual([["<PERSON_1>", "Ada Lovelace"]]);
  });

  it("recovers a token that closes the text", () => {
    expect(pairs("please page Ada Lovelace", "please page <PERSON_1>")).toEqual([["<PERSON_1>", "Ada Lovelace"]]);
  });

  it("recovers a token that is the entire text", () => {
    expect(pairs("Ada Lovelace", "<PERSON_1>")).toEqual([["<PERSON_1>", "Ada Lovelace"]]);
  });

  it("keeps several tokens of different entity types in source order", () => {
    expect(
      pairs(
        "Ada Lovelace paid from CH93 0076 2011 6238 5295 7 using 4111 1111 1111 1111.",
        "<PERSON_1> paid from <IBAN_CODE_1> using <CREDIT_CARD_1>.",
      ),
    ).toEqual([
      ["<PERSON_1>", "Ada Lovelace"],
      ["<IBAN_CODE_1>", "CH93 0076 2011 6238 5295 7"],
      ["<CREDIT_CARD_1>", "4111 1111 1111 1111"],
    ]);
  });

  it("aligns both occurrences when one token is reused for a repeated value", () => {
    const alignments = aligned("Ada Lovelace met Ada Lovelace", "<PERSON_1> met <PERSON_1>");
    expect(alignments.map((a) => a.sourceValue)).toEqual(["Ada Lovelace", "Ada Lovelace"]);
    expect(alignments.map((a) => a.sourceStart)).toEqual([0, 17]);
    expect(alignments.map((a) => a.encodedStart)).toEqual([0, 15]);
  });

  it("searches forward from the current value rather than from the start of the source", () => {
    expect(pairs("at at Ada Lovelace at end", "at at <PERSON_1> at end")).toEqual([["<PERSON_1>", "Ada Lovelace"]]);
  });

  it("does not let an anchor match inside the value it is meant to follow", () => {
    expect(pairs("call Ada at Ada Corp at noon", "call <PERSON_1> at noon")).toEqual([
      ["<PERSON_1>", "Ada at Ada Corp"],
    ]);
  });

  it("spans line breaks in both the value and the anchors", () => {
    expect(pairs("from:\nAda Lovelace\nto: ops", "from:\n<PERSON_1>\nto: ops")).toEqual([
      ["<PERSON_1>", "Ada Lovelace"],
    ]);
  });

  it("measures unicode values in the same code units the encoder used", () => {
    const [only] = aligned("grüße an Ada Löwelace bitte", "grüße an <PERSON_1> bitte");
    expect(only.sourceValue).toBe("Ada Löwelace");
    expect(only.sourceStart).toBe(9);
  });

  it("reads a handle-codec token as its entity type", () => {
    const [only] = aligned("page Ada Lovelace", "page <PERSON:3f9c2e1b8d4a7f60>");
    expect(only).toMatchObject({ entityType: "PERSON", masked: false, sourceValue: "Ada Lovelace" });
  });

  it("reads an encrypted-codec token as its entity type", () => {
    const [only] = aligned("page Ada Lovelace", "page <PERSON:e1.QUJDRA-_x.y>");
    expect(only).toMatchObject({ entityType: "PERSON", masked: false, sourceValue: "Ada Lovelace" });
  });

  it("flags a bare mask as irreversible while still recovering what it covered", () => {
    const [only] = aligned("ssn 123-45-6789 on file", "ssn <US_SSN> on file");
    const expected = { token: "<US_SSN>", entityType: "US_SSN", masked: true, sourceValue: "123-45-6789" };
    expect(only).toMatchObject(expected);
  });

  it("separates a masked token from an encoded one in the same text", () => {
    const alignments = aligned("Ada Lovelace ssn 123-45-6789", "<PERSON_1> ssn <US_SSN>");
    expect(alignments.map((a) => [a.token, a.masked])).toEqual([
      ["<PERSON_1>", false],
      ["<US_SSN>", true],
    ]);
  });

  it("ignores angle-bracket text the user typed themselves", () => {
    expect(aligned("render <DIV> as is", "render <DIV> as is")).toEqual([]);
  });

  it("still aligns real tokens alongside angle-bracket text the user typed", () => {
    expect(pairs("call <DIV> for Ada Lovelace", "call <DIV> for <PERSON_1>")).toEqual([["<PERSON_1>", "Ada Lovelace"]]);
  });

  it("refuses to guess a boundary between two adjacent tokens", () => {
    expect(unalignedReason("Ada Lovelace ada@example.com", "<PERSON_1><EMAIL_ADDRESS_1>")).toBe(
      "two tokens sit next to each other with no anchor text between them",
    );
  });

  it("refuses when the text before the first token is not the source prefix", () => {
    expect(unalignedReason("email Ada Lovelace today", "wrote <PERSON_1> today")).toContain(
      "does not start the source",
    );
  });

  it("refuses when the text after the last token is not the source suffix", () => {
    expect(unalignedReason("email Ada Lovelace today", "email <PERSON_1> tomorrow")).toContain(
      "does not end the source",
    );
  });

  it("refuses when an inner anchor is missing from the source", () => {
    expect(unalignedReason("Ada Lovelace paid Grace", "<PERSON_1> owed <PERSON_2>")).toContain(
      "does not appear in the source",
    );
  });

  it("refuses when a token would map to nothing at all", () => {
    expect(unalignedReason("ab", "a<PERSON_1>b")).toBe("<PERSON_1> maps to an empty stretch of the source");
  });

  it("truncates a long anchor in the failure reason", () => {
    const reason = unalignedReason("Ada", `<PERSON_1>${"z".repeat(40)}`);
    expect(reason).toContain("…");
    expect(reason.length).toBeLessThan(120);
  });
});
