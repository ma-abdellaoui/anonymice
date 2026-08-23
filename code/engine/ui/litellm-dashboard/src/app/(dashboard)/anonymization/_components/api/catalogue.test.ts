import { describe, expect, it } from "vitest";

import { ENDPOINTS, SAMPLE_TEXT, type ConsoleContext } from "./catalogue";

const context: ConsoleContext = {
  sessionId: "sess-1",
  subjectId: "",
  encodedTexts: ["<PERSON:abc>"],
  sampleText: SAMPLE_TEXT,
};

const byId = (id: string) => ENDPOINTS.find((endpoint) => endpoint.id === id)!;

describe("the endpoint catalogue", () => {
  it("covers every route the proxy exposes under /pii", () => {
    const covered = ENDPOINTS.map((endpoint) => `${endpoint.method} ${endpoint.path}`);
    expect(covered).toEqual([
      "GET /pii/permissions",
      "POST /pii/detect",
      "POST /pii/encode",
      "POST /pii/decode",
      "GET /pii/session/{session_id}",
      "POST /pii/search",
      "GET /pii/subject/{subject_id}",
      "DELETE /pii/session/{session_id}",
      "DELETE /pii/subject/{subject_id}",
      "GET /pii/activity",
    ]);
  });

  it("puts the destructive routes last, after the ones that only read", () => {
    const firstDestructive = ENDPOINTS.findIndex((endpoint) => endpoint.destructive === true);
    const lastSafe = ENDPOINTS.map((e) => e.destructive === true).lastIndexOf(false);
    expect(firstDestructive).toBeGreaterThan(0);
    expect(firstDestructive).toBeLessThan(lastSafe);
  });

  it("names the grant each gated route needs, and search does not share decode's", () => {
    const gated = ENDPOINTS.filter((e) => e.grant).map((e) => [e.id, e.grant]);
    expect(gated).toEqual([
      ["decode", "allow_pii_decode"],
      ["search", "allow_pii_search"],
      ["subject-get", "allow_pii_decode"],
    ]);
  });

  it("sends search the field names the endpoint actually validates", () => {
    expect(Object.keys(byId("search").body!(context))).toEqual(["query", "mode", "scope_type"]);
  });

  it("makes decode carry what encode returned", () => {
    expect(byId("decode").body!(context)).toEqual({ texts: ["<PERSON:abc>"], session_id: "sess-1" });
  });

  it("leaves subject_id out of encode until one is set", () => {
    expect(byId("encode").body!(context)).not.toHaveProperty("subject_id");
    expect(byId("encode").body!({ ...context, subjectId: "customer-1" })).toMatchObject({
      subject_id: "customer-1",
    });
  });

  it("prefills each path parameter from the matching piece of context", () => {
    expect(byId("session-get").params).toEqual([{ name: "session_id", from: "sessionId" }]);
    expect(byId("subject-delete").params).toEqual([{ name: "subject_id", from: "subjectId" }]);
  });
});
