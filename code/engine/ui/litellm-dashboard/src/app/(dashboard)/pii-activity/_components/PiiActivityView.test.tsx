import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import PiiActivityView from "./PiiActivityView";
import { renderWithProviders, testQueryClient } from "../../../../../tests/test-utils";
import { piiActivityCall, streamPiiActivity, type PiiActivityEvent } from "@/components/networking";

vi.mock("@/components/networking", () => ({
  piiActivityCall: vi.fn(),
  streamPiiActivity: vi.fn(() => new Promise(() => {})),
}));

const ACCESS_TOKEN = "sk-access-token";

const anEvent = (overrides: Partial<PiiActivityEvent> = {}): PiiActivityEvent => ({
  id: "event-1",
  at: "2026-08-22T10:00:00Z",
  surface: "guardrail",
  direction: "encode",
  outcome: { kind: "applied", entity_type: null, reason: null },
  duration_ms: 42,
  entity_counts: { PERSON: 1, IBAN_CODE: 2 },
  action_counts: { ENCODE: 3 },
  token_count: 3,
  resolved_count: 0,
  ner_stage_ran: true,
  request_id: "req-1",
  session_id: "session-1",
  key_alias: "demo-key",
  user_id: "u1",
  model: "gpt-4o-mini",
  guardrail_name: "pii-anonymizer",
  browser: null,
  capture: null,
  capture_withheld: false,
  ...overrides,
});

const respondWith = (events: PiiActivityEvent[], captureEnabled = false) =>
  vi.mocked(piiActivityCall).mockResolvedValue({ events, capture_enabled: captureEnabled });

const render = () => renderWithProviders(<PiiActivityView accessToken={ACCESS_TOKEN} />);

describe("PiiActivityView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testQueryClient.clear();
    vi.mocked(streamPiiActivity).mockImplementation(() => new Promise(() => {}));
  });

  it("lists what each call detected", async () => {
    respondWith([anEvent()]);
    render();
    expect(await screen.findByText("PERSON")).toBeInTheDocument();
    expect(screen.getByText("IBAN_CODE ×2")).toBeInTheDocument();
  });

  it("says what became of an encode without opening anything", async () => {
    respondWith([anEvent()]);
    render();
    expect(await screen.findByText("3 tokenized")).toBeInTheDocument();
  });

  it("calls out an entity that was masked irreversibly", async () => {
    respondWith([anEvent({ action_counts: { ENCODE: 2, MASK: 1 } })]);
    render();
    expect(await screen.findByText("2 tokenized, 1 masked irreversibly")).toBeInTheDocument();
  });

  it("reports a blocked request with the entity that caused it", async () => {
    respondWith([anEvent({ outcome: { kind: "blocked", entity_type: "CREDIT_CARD", reason: null } })]);
    render();
    expect(await screen.findByText(/CREDIT_CARD is configured to block/)).toBeInTheDocument();
  });

  it("calls out text that reached the provider unscanned", async () => {
    const unscanned = { kind: "unscanned" as const, entity_type: null, reason: "no PII detector is configured" };
    respondWith([anEvent({ outcome: unscanned })]);
    render();
    expect(await screen.findByText(/reached the provider unscanned/)).toBeInTheDocument();
  });

  it("reports how much a decode resolved", async () => {
    respondWith([anEvent({ direction: "decode", token_count: 3, resolved_count: 2 })]);
    render();
    expect(await screen.findByText("2 of 3 tokens resolved")).toBeInTheDocument();
  });

  it("shows a browser event by the host it happened on", async () => {
    respondWith([
      anEvent({
        surface: "extension",
        model: null,
        browser: { host: "crm.internal", trust_class: "NATIVE", action: "mint" },
      }),
    ]);
    render();
    expect(await screen.findByText("crm.internal")).toBeInTheDocument();
    expect(within(screen.getByRole("table")).getByText("Browser extension")).toBeInTheDocument();
  });

  it("narrows to one surface when filtered", async () => {
    respondWith([anEvent()]);
    render();
    await screen.findByText("PERSON");
    await userEvent.selectOptions(screen.getByLabelText("Surface"), "extension");
    await waitFor(() =>
      expect(piiActivityCall).toHaveBeenLastCalledWith(ACCESS_TOKEN, expect.objectContaining({ surface: "extension" })),
    );
  });

  it("says nothing was recorded rather than showing an empty table", async () => {
    respondWith([]);
    render();
    expect(await screen.findByText(/Nothing recorded yet/)).toBeInTheDocument();
  });

  it("surfaces a failure to read the log", async () => {
    vi.mocked(piiActivityCall).mockRejectedValue(new Error("activity 503"));
    render();
    expect(await screen.findByText("activity 503")).toBeInTheDocument();
  });

  describe("the drawer", () => {
    const open = async () => {
      await userEvent.click(await screen.findByText(/tokenized|resolved|found/));
    };

    it("shows the before and after when they were captured", async () => {
      respondWith(
        [
          anEvent({
            capture: {
              before: ["email Ada"],
              after: ["email <PERSON_1>"],
              placements: [
                {
                  token: "<PERSON_1>",
                  entity_type: "PERSON",
                  detector: "ner",
                  score: 0.97,
                  action: "ENCODE",
                  text_index: 0,
                  start: 6,
                  end: 9,
                  value: "Ada",
                },
              ],
            },
          }),
        ],
        true,
      );
      render();
      await open();
      expect(screen.getByText("email Ada")).toBeInTheDocument();
      expect(screen.getByText("email <PERSON_1>")).toBeInTheDocument();
    });

    it("explains that text was withheld rather than absent", async () => {
      respondWith([anEvent({ capture_withheld: true })], true);
      render();
      await open();
      expect(screen.getByText(/this key may not read it/)).toBeInTheDocument();
    });

    it("explains that capture is switched off when nothing was recorded", async () => {
      respondWith([anEvent()], false);
      render();
      await open();
      expect(screen.getByText(/LITELLM_PII_ACTIVITY_CAPTURE_TEXT=true/)).toBeInTheDocument();
    });

    it("distinguishes an empty capture from a disabled one", async () => {
      respondWith([anEvent()], true);
      render();
      await open();
      expect(screen.getByText("Nothing was captured for this call.")).toBeInTheDocument();
    });
  });
});
