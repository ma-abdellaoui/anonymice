import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ChatgptSignIn from "./ChatgptSignIn";
import { renderWithProviders, testQueryClient } from "../../../../../tests/test-utils";
import {
  chatgptLoginPollCall,
  chatgptLoginStartCall,
  chatgptLoginStatusCall,
  chatgptSignOutCall,
} from "@/components/networking";
import { toast } from "@/lib/toast";

vi.mock("@/components/networking", () => ({
  chatgptLoginStatusCall: vi.fn(),
  chatgptLoginStartCall: vi.fn(),
  chatgptLoginPollCall: vi.fn(),
  chatgptSignOutCall: vi.fn(),
}));

vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn(), fromError: vi.fn() },
}));

// A token per test, so no two share a react-query cache key. Without this a
// still-running poll from the previous test can refetch into the next one's cache.
let tokenSeq = 0;
const STARTED = {
  verification_url: "https://chatgpt.com/deviceauth",
  user_code: "ABCD-1234",
  device_auth_id: "dev-1",
  interval_seconds: 0,
};

const signedOut = { signed_in: false, account_id: null, expires_at: null };
const signedIn = { signed_in: true, account_id: "acct-123", expires_at: 1800000000 };

const render = () => renderWithProviders(<ChatgptSignIn accessToken={`sk-access-token-${(tokenSeq += 1)}`} />);

describe("ChatgptSignIn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testQueryClient.clear();
    vi.mocked(chatgptLoginStartCall).mockResolvedValue(STARTED);
  });

  it("offers a sign-in when there is no session", async () => {
    vi.mocked(chatgptLoginStatusCall).mockResolvedValue(signedOut);
    render();
    expect(await screen.findByRole("button", { name: /Sign in with ChatGPT/ })).toBeInTheDocument();
  });

  it("names the signed-in account instead", async () => {
    vi.mocked(chatgptLoginStatusCall).mockResolvedValue(signedIn);
    render();
    expect(await screen.findByText(/Signed in as acct-123/)).toBeInTheDocument();
  });

  it("shows the code and where to type it, rather than linking through with it", async () => {
    vi.mocked(chatgptLoginStatusCall).mockResolvedValue(signedOut);
    vi.mocked(chatgptLoginPollCall).mockResolvedValue({ status: "pending", account_id: null });
    render();
    await userEvent.click(await screen.findByRole("button", { name: /Sign in with ChatGPT/ }));
    expect(await screen.findByText("ABCD-1234")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /chatgpt.com\/deviceauth/ });
    expect(link).toHaveAttribute("href", "https://chatgpt.com/deviceauth");
    expect(link.getAttribute("href")).not.toContain("ABCD-1234");
  });

  it("warns that a device code is a phishing target", async () => {
    vi.mocked(chatgptLoginStatusCall).mockResolvedValue(signedOut);
    vi.mocked(chatgptLoginPollCall).mockResolvedValue({ status: "pending", account_id: null });
    render();
    await userEvent.click(await screen.findByRole("button", { name: /Sign in with ChatGPT/ }));
    expect(await screen.findByText(/common phishing target/)).toBeInTheDocument();
  });

  it("switches to the signed-in state once the code is approved", async () => {
    let current = signedOut;
    vi.mocked(chatgptLoginStatusCall).mockImplementation(async () => current);
    vi.mocked(chatgptLoginPollCall).mockImplementation(async () => {
      current = signedIn;
      return { status: "complete", account_id: "acct-123" };
    });
    render();
    await userEvent.click(await screen.findByRole("button", { name: /Sign in with ChatGPT/ }));
    expect(await screen.findByText(/Signed in as acct-123/)).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith("Signed in to ChatGPT");
  });

  it("keeps polling while the person has not approved yet", async () => {
    vi.mocked(chatgptLoginStatusCall).mockResolvedValue(signedOut);
    vi.mocked(chatgptLoginPollCall)
      .mockResolvedValueOnce({ status: "pending", account_id: null })
      .mockResolvedValue({ status: "complete", account_id: "acct-123" });
    render();
    await userEvent.click(await screen.findByRole("button", { name: /Sign in with ChatGPT/ }));
    await waitFor(() => expect(chatgptLoginPollCall).toHaveBeenCalledTimes(2));
  });

  it("surfaces a failure to start rather than hanging", async () => {
    vi.mocked(chatgptLoginStatusCall).mockResolvedValue(signedOut);
    vi.mocked(chatgptLoginStartCall).mockRejectedValue(new Error("upstream down"));
    render();
    await userEvent.click(await screen.findByRole("button", { name: /Sign in with ChatGPT/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("upstream down"));
  });

  it("signs out", async () => {
    let current = signedIn;
    vi.mocked(chatgptLoginStatusCall).mockImplementation(async () => current);
    vi.mocked(chatgptSignOutCall).mockImplementation(async () => {
      current = signedOut;
      return signedOut;
    });
    render();
    await userEvent.click(await screen.findByRole("button", { name: /Sign out/ }));
    expect(await screen.findByRole("button", { name: /Sign in with ChatGPT/ })).toBeInTheDocument();
  });

  it("renders nothing when the proxy does not expose the route", async () => {
    vi.mocked(chatgptLoginStatusCall).mockRejectedValue(new Error("404"));
    const { container } = render();
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
