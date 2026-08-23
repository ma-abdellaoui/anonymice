import { describe, expect, it } from "vitest";

import { orderModels } from "./useModelChoices";

describe("orderModels", () => {
  it("puts the always-available free model first", () => {
    expect(orderModels(["anthropic-opus-4-8", "openrouter-free", "gpt-5.5"])[0]).toBe("openrouter-free");
  });

  it("sorts the rest alphabetically", () => {
    expect(orderModels(["gpt-5.5", "anthropic-opus-4-8"])).toEqual(["anthropic-opus-4-8", "gpt-5.5"]);
  });

  it("drops wildcard routes, which are not callable model names", () => {
    expect(orderModels(["openrouter-free", "anthropic/*"])).toEqual(["openrouter-free"]);
  });

  it("de-duplicates", () => {
    expect(orderModels(["gpt-5.5", "gpt-5.5"])).toEqual(["gpt-5.5"]);
  });

  it("copes with no models at all", () => {
    expect(orderModels([])).toEqual([]);
  });
});
