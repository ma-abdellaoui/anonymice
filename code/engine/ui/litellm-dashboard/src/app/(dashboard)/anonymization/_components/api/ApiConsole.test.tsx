import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ApiConsole from "./ApiConsole";
import { renderWithProviders } from "../../../../../../tests/test-utils";

import { apiClient } from "@/components/networking";
import { ApiError } from "@/lib/http/client";

vi.mock("@/components/networking", () => ({
  apiClient: { requestWithHeaders: vi.fn() },
  getProxyBaseUrl: () => "http://localhost:4000",
}));

const ENCODED = { texts: ["<PERSON:abc>"], session_id: "sess-1" };

const answer = (data: unknown) => ({ data, status: 200, headers: new Headers() });

const send = vi.mocked(apiClient.requestWithHeaders);

const runButton = (name: string): HTMLElement => screen.getByRole("button", { name });

const clickSend = async (name: string) => {
  await userEvent.click(runButton(name));
};

const render = () => renderWithProviders(<ApiConsole accessToken="sk-session" />);

describe("the PII API console", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    send.mockResolvedValue(answer({}) as never);
  });

  it("lists every route so the tab doubles as the reference", () => {
    render();
    expect(runButton("POST /pii/encode")).toBeInTheDocument();
    expect(runButton("GET /pii/subject/{subject_id}")).toBeInTheDocument();
    expect(runButton("DELETE /pii/subject/{subject_id}")).toBeInTheDocument();
  });

  it("sends the real request with the session's own credential", async () => {
    render();
    await clickSend("GET /pii/permissions");
    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(send.mock.calls[0][0]).toBe("GET");
    expect(send.mock.calls[0][1]).toBe("/pii/permissions");
    expect(send.mock.calls[0][2]).toMatchObject({ accessToken: "sk-session" });
  });

  it("shows the status and the answer, so the card is its own proof", async () => {
    send.mockResolvedValue(answer({ can_decode: true }) as never);
    render();
    await clickSend("GET /pii/permissions");
    expect(await screen.findByText(/"can_decode": true/)).toBeInTheDocument();
  });

  it("feeds what encode returned into decode without anything being copied by hand", async () => {
    send.mockResolvedValue(answer(ENCODED) as never);
    render();
    await clickSend("POST /pii/encode");
    await waitFor(() =>
      expect(screen.getByLabelText("decode request body")).toHaveValue(
        JSON.stringify({ texts: ["<PERSON:abc>"], session_id: "sess-1" }, null, 2),
      ),
    );
  });

  it("fills the session path parameter from the same answer", async () => {
    send.mockResolvedValue(answer(ENCODED) as never);
    render();
    await clickSend("POST /pii/encode");
    await waitFor(() => expect(screen.getByLabelText("session-get session_id")).toHaveValue("sess-1"));
  });

  it("stops overwriting a card once somebody has typed in it", async () => {
    render();
    const body = screen.getByLabelText("decode request body");
    await userEvent.clear(body);
    await userEvent.type(body, "mine");
    send.mockResolvedValue(answer(ENCODED) as never);
    await clickSend("POST /pii/encode");
    await waitFor(() => expect(screen.getByLabelText("session-get session_id")).toHaveValue("sess-1"));
    expect(body).toHaveValue("mine");
  });

  it("lets an edited card follow again after a reset", async () => {
    send.mockResolvedValue(answer(ENCODED) as never);
    render();
    await clickSend("POST /pii/encode");
    const body = screen.getByLabelText("decode request body");
    await userEvent.clear(body);
    await userEvent.type(body, "mine");
    await userEvent.click(screen.getByRole("button", { name: "Reset decode" }));
    await waitFor(() =>
      expect(screen.getByLabelText("decode request body")).toHaveValue(
        JSON.stringify({ texts: ["<PERSON:abc>"], session_id: "sess-1" }, null, 2),
      ),
    );
  });

  it("cannot revoke a session before there is one to revoke", async () => {
    render();
    expect(runButton("DELETE /pii/session/{session_id}")).toBeDisabled();
  });

  it("asks before running a call that destroys a mapping", async () => {
    send.mockResolvedValue(answer(ENCODED) as never);
    render();
    await clickSend("POST /pii/encode");
    const button = runButton("DELETE /pii/session/{session_id}");
    await waitFor(() => expect(button).toBeEnabled());
    send.mockClear();
    await userEvent.click(button);
    expect(send).not.toHaveBeenCalled();
    await waitFor(() => expect(button).toHaveTextContent("Confirm, this cannot be undone"));
    await userEvent.click(button);
    await waitFor(() => expect(send).toHaveBeenCalledOnce());
  });

  it("reports a refusal in place rather than swallowing it", async () => {
    send.mockRejectedValue(new ApiError("key lacks the allow_pii_decode permission", 403, { detail: "nope" }));
    render();
    await clickSend("GET /pii/permissions");
    expect(await screen.findByText(/403/)).toBeInTheDocument();
  });
});
