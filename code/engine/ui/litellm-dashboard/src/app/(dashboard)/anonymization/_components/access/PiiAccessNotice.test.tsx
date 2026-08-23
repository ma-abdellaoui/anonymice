import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import AnonymizationPanel from "../AnonymizationPanel";
import { renderWithProviders, testQueryClient } from "../../../../../../tests/test-utils";
import { keyCreateCall, piiPermissionsCall } from "@/components/networking";

vi.mock("@/components/networking", () => ({
  piiPermissionsCall: vi.fn(),
  keyCreateCall: vi.fn(),
  modelAvailableCall: vi.fn().mockResolvedValue({ data: [] }),
  piiDetectCall: vi.fn(),
  piiEncodeCall: vi.fn(),
  piiDecodeCall: vi.fn(),
  piiSessionCall: vi.fn(),
  piiRevokeSessionCall: vi.fn(),
  piiRevokeSubjectCall: vi.fn(),
  piiExportSubjectCall: vi.fn(),
  piiSearchCall: vi.fn(),
  apiClient: { post: vi.fn(), get: vi.fn() },
}));

vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn(), fromError: vi.fn() } }));

let seq = 0;
const render = () =>
  renderWithProviders(
    <AnonymizationPanel accessToken={`sk-session-${(seq += 1)}`} userRole="Admin" userId="u1" />,
  );

const CANNOT = { can_decode: false, can_decode_any: false, can_search: false };
const CAN = { can_decode: true, can_decode_any: false, can_search: true };

describe("PII console access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testQueryClient.clear();
    window.sessionStorage.clear();
  });

  it("grants itself decode rather than leaving the page to fail on first use", async () => {
    vi.mocked(piiPermissionsCall).mockResolvedValueOnce(CANNOT).mockResolvedValue(CAN);
    vi.mocked(keyCreateCall).mockResolvedValue({ key: "sk-granted" });
    render();
    await waitFor(() => expect(keyCreateCall).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText("This session cannot decode")).not.toBeInTheDocument());
  });

  it("mints a key carrying only the decode permission, and a short life", async () => {
    vi.mocked(piiPermissionsCall).mockResolvedValueOnce(CANNOT).mockResolvedValue(CAN);
    vi.mocked(keyCreateCall).mockResolvedValue({ key: "sk-granted" });
    render();
    await waitFor(() => expect(keyCreateCall).toHaveBeenCalled());
    const [, , form] = vi.mocked(keyCreateCall).mock.calls[0];
    expect(form.permissions).toEqual({ allow_pii_decode: true });
    expect(form.duration).toBe("24h");
  });

  it("keeps the granted key for the tab so a reload does not re-mint", async () => {
    vi.mocked(piiPermissionsCall).mockResolvedValueOnce(CANNOT).mockResolvedValue(CAN);
    vi.mocked(keyCreateCall).mockResolvedValue({ key: "sk-granted" });
    render();
    await waitFor(() => expect(window.sessionStorage.getItem("anonymice:pii-decode-key")).toBe("sk-granted"));
  });

  it("asks for nothing when the session already has the grant", async () => {
    vi.mocked(piiPermissionsCall).mockResolvedValue(CAN);
    render();
    await waitFor(() => expect(piiPermissionsCall).toHaveBeenCalled());
    expect(keyCreateCall).not.toHaveBeenCalled();
    expect(screen.queryByText("This session cannot decode")).not.toBeInTheDocument();
  });

  it("says why decode is refused when it cannot mint the key", async () => {
    vi.mocked(piiPermissionsCall).mockResolvedValue(CANNOT);
    vi.mocked(keyCreateCall).mockRejectedValue(new Error("key creation disabled"));
    render();
    expect(await screen.findByText("This session cannot decode")).toBeInTheDocument();
    expect(await screen.findByText("key creation disabled")).toBeInTheDocument();
  });

  it("explains that detect and encode still work", async () => {
    vi.mocked(piiPermissionsCall).mockResolvedValue(CANNOT);
    vi.mocked(keyCreateCall).mockRejectedValue(new Error("key creation disabled"));
    render();
    expect(await screen.findByText(/Detect and encode work without it/)).toBeInTheDocument();
  });

  it("does not claim a grant when the proxy returns no key", async () => {
    vi.mocked(piiPermissionsCall).mockResolvedValue(CANNOT);
    vi.mocked(keyCreateCall).mockResolvedValue({});
    render();
    expect(await screen.findByText(/returned no key/)).toBeInTheDocument();
  });

  it("lets the user retry a grant that failed", async () => {
    vi.mocked(piiPermissionsCall).mockResolvedValue(CANNOT);
    vi.mocked(keyCreateCall).mockRejectedValue(new Error("key creation disabled"));
    render();
    await userEvent.click(await screen.findByRole("button", { name: /Try again/ }));
    await waitFor(() => expect(vi.mocked(keyCreateCall).mock.calls.length).toBeGreaterThan(1));
  });
});
