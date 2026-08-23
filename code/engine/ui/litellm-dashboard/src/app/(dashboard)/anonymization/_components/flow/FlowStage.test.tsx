import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import FlowStage from "./FlowStage";
import { segmentPrompt, segmentReply, vaultFrom } from "./buildFlow";
import type { Beat, FlowRun } from "./flowTypes";
import { renderWithProviders } from "../../../../../../tests/test-utils";

import type { PiiPlacement } from "@/components/networking";

const PROMPT = "Email Ada about CH93 0076 2011 6238 5295 7";
const REPLY = "I drafted a note to <PERSON_1> about <IBAN_CODE_1>.";

const PLACEMENTS: PiiPlacement[] = [
  { text_index: 0, start: 6, end: 9, entity_type: "PERSON", detector: "ner", score: 0.97, token: "<PERSON_1>" },
  {
    text_index: 0,
    start: 16,
    end: 42,
    entity_type: "IBAN_CODE",
    detector: "rules",
    score: 1,
    token: "<IBAN_CODE_1>",
  },
];

const VAULT = vaultFrom(PROMPT, PLACEMENTS);

const RUN: FlowRun = {
  mode: "endpoint",
  prompt: PROMPT,
  promptSegments: segmentPrompt(PROMPT, PLACEMENTS),
  encodedPrompt: "Email <PERSON_1> about <IBAN_CODE_1>",
  vault: VAULT,
  providerReply: REPLY,
  replySegments: segmentReply(REPLY, VAULT),
  decodedReply: "I drafted a note to Ada about CH93 0076 2011 6238 5295 7.",
  sessionId: "session-1",
  model: "gpt-4o-mini",
  nerStageRan: true,
  timings: { encode: 40, provider: 900, decode: 12 },
};

const providerSide = () => screen.getByRole("region", { name: "The provider" });
const ourSide = () => screen.getByRole("region", { name: "Your boundary" });
const vault = () => screen.getByRole("region", { name: "Token vault" });

const render = (beat: Beat) => renderWithProviders(<FlowStage run={RUN} beat={beat} />);

describe("FlowStage", () => {
  it("shows the prompt as written on the first beat", () => {
    render("typed");
    expect(within(ourSide()).getAllByText("Ada").length).toBeGreaterThan(0);
  });

  it("mints a vault row for every distinct value", () => {
    render("encode");
    expect(within(vault()).getByText("<PERSON_1>")).toBeInTheDocument();
    expect(within(vault()).getByText("<IBAN_CODE_1>")).toBeInTheDocument();
    expect(within(vault()).getByText("Ada")).toBeInTheDocument();
  });

  it("never renders a real value on the provider's side of the boundary", () => {
    for (const beat of ["cross", "reply", "decode"] as Beat[]) {
      const { unmount } = render(beat);
      const provider = providerSide();
      expect(within(provider).queryByText("Ada")).not.toBeInTheDocument();
      expect(within(provider).queryByText(/CH93 0076/)).not.toBeInTheDocument();
      unmount();
    }
  });

  it("shows the tokenized prompt as what the provider receives", () => {
    render("cross");
    const provider = providerSide();
    expect(within(provider).getAllByText("<PERSON_1>").length).toBeGreaterThan(0);
  });

  it("counts the values that crossed against the number detected", () => {
    render("cross");
    expect(screen.getByText(/real values crossed the line, out of 2 detected/)).toBeInTheDocument();
  });

  it("names the model the run actually went to", () => {
    render("reply");
    expect(screen.getByText("gpt-4o-mini")).toBeInTheDocument();
  });

  it("holds the provider panels empty until something has crossed", () => {
    render("detect");
    expect(screen.getByText("nothing has crossed yet")).toBeInTheDocument();
  });

  it("returns the real values on our side once decoded", () => {
    render("decode");
    expect(within(ourSide()).getAllByText("Ada").length).toBeGreaterThan(0);
    expect(within(providerSide()).queryByText("Ada")).not.toBeInTheDocument();
  });
});
