import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import AnonymizationDemo from "./AnonymizationDemo";
import { ApiError } from "@/lib/http/client";

const piiDetectCall = vi.fn();
const piiEncodeCall = vi.fn();
const piiDecodeCall = vi.fn();
const makeOpenAIChatCompletionRequest = vi.fn();
const fetchAvailableModels = vi.fn();

vi.mock("@/components/networking", () => ({
  piiDetectCall: (...args: unknown[]) => piiDetectCall(...args),
  piiEncodeCall: (...args: unknown[]) => piiEncodeCall(...args),
  piiDecodeCall: (...args: unknown[]) => piiDecodeCall(...args),
}));

vi.mock("@/components/llm_calls/chat_completion", () => ({
  makeOpenAIChatCompletionRequest: (...args: unknown[]) => makeOpenAIChatCompletionRequest(...args),
}));

vi.mock("@/components/llm_calls/fetch_models", () => ({
  fetchAvailableModels: (...args: unknown[]) => fetchAvailableModels(...args),
}));

vi.mock("@/lib/toast", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const ORIGINAL = "Refund Ada Lovelace at ada@example.com";
const ENCODED = "Refund <PERSON_1> at <EMAIL_ADDRESS_1>";

const typeText = (value: string) => fireEvent.change(screen.getByLabelText("Text to send"), { target: { value } });
const clickRun = () => fireEvent.click(screen.getByRole("button", { name: /run/i }));

const renderReady = async () => {
  render(<AnonymizationDemo accessToken="sk-test" />);
  await waitFor(() => expect(screen.getByLabelText("Model")).toHaveTextContent("gpt-4o"));
};

describe("AnonymizationDemo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchAvailableModels.mockResolvedValue([{ model_group: "gpt-4o" }]);
    piiDetectCall.mockResolvedValue({
      results: [
        { spans: [{ entity_type: "PERSON", start: 7, end: 19, score: 0.98, detector: "rules" }], ner_stage_ran: false },
      ],
    });
    piiEncodeCall.mockResolvedValue({
      texts: [ENCODED],
      session_id: "sess-abc123456789",
      tokens: [{ token: "<PERSON_1>", entity_type: "PERSON", codec_id: "placeholder" }],
    });
    piiDecodeCall.mockResolvedValue({ texts: ["Sure, I emailed Ada Lovelace at ada@example.com"] });
    makeOpenAIChatCompletionRequest.mockImplementation(async (_history: unknown, updateUI: (chunk: string) => void) => {
      updateUI("Sure, I emailed <PERSON_1> ");
      updateUI("at <EMAIL_ADDRESS_1>");
    });
  });

  it("sends the encoded text to the model, never the text the user typed", async () => {
    await renderReady();
    typeText(ORIGINAL);
    clickRun();

    await waitFor(() => expect(makeOpenAIChatCompletionRequest).toHaveBeenCalled());

    const [history, , model, token] = makeOpenAIChatCompletionRequest.mock.calls[0];
    expect(history).toEqual([{ role: "user", content: ENCODED }]);
    expect(model).toBe("gpt-4o");
    expect(token).toBe("sk-test");
    expect(JSON.stringify(history)).not.toContain("Ada Lovelace");
  });

  it("decodes the assembled reply against the session the encode returned", async () => {
    await renderReady();
    typeText(ORIGINAL);
    clickRun();

    await waitFor(() => expect(piiDecodeCall).toHaveBeenCalled());
    expect(piiDecodeCall).toHaveBeenCalledWith(
      "sk-test",
      ["Sure, I emailed <PERSON_1> at <EMAIL_ADDRESS_1>"],
      "sess-abc123456789",
    );
  });

  it("shows both sides of the transform and what each token stood in for", async () => {
    await renderReady();
    typeText(ORIGINAL);
    clickRun();

    expect(await screen.findByText("<PERSON_1>", { selector: "mark" })).toBeInTheDocument();
    const ledgerToken = await screen.findByText("<PERSON_1>", { selector: "td" });
    const row = ledgerToken.closest("tr");
    expect(row).toHaveTextContent("Ada Lovelace");
    expect(row).toHaveTextContent("rules");
    expect(row).toHaveTextContent("0.98");
  });

  it("reuses the session on a second run so tokens stay stable across turns", async () => {
    await renderReady();
    typeText(ORIGINAL);
    clickRun();
    await waitFor(() => expect(piiDecodeCall).toHaveBeenCalled());

    clickRun();
    await waitFor(() => expect(piiEncodeCall).toHaveBeenCalledTimes(2));
    expect(piiEncodeCall.mock.calls[0][2]).toBeUndefined();
    expect(piiEncodeCall.mock.calls[1][2]).toBe("sess-abc123456789");
  });

  it("drops the session when the user asks for a fresh one", async () => {
    await renderReady();
    typeText(ORIGINAL);
    clickRun();
    await waitFor(() => expect(piiDecodeCall).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: /new session/i }));
    clickRun();
    await waitFor(() => expect(piiEncodeCall).toHaveBeenCalledTimes(2));
    expect(piiEncodeCall.mock.calls[1][2]).toBeUndefined();
  });

  it("keeps the transform on screen and names the permission when the key cannot decode", async () => {
    piiDecodeCall.mockRejectedValue(new ApiError("forbidden", 403, {}));
    await renderReady();
    typeText(ORIGINAL);
    clickRun();

    expect(await screen.findByText(/allow_pii_decode/)).toBeInTheDocument();
    expect(screen.getByText("<PERSON_1>", { selector: "mark" })).toBeInTheDocument();
  });

  it("says the proxy is unconfigured rather than showing an empty transform", async () => {
    piiDetectCall.mockRejectedValue(new ApiError("not configured", 501, {}));
    await renderReady();
    typeText(ORIGINAL);
    clickRun();

    expect(await screen.findByText(/PRESIDIO_ANALYZER_API_BASE/)).toBeInTheDocument();
    expect(makeOpenAIChatCompletionRequest).not.toHaveBeenCalled();
  });
});
