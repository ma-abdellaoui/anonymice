import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import VaultBrowser from "./VaultBrowser";
import { renderWithProviders } from "../../../../../tests/test-utils";
import {
  piiExportSubjectCall,
  piiRevokeSessionCall,
  piiRevokeSubjectCall,
  piiSearchCall,
  piiSessionCall,
} from "@/components/networking";
import { toast } from "@/lib/toast";

vi.mock("@/components/networking", () => ({
  piiSessionCall: vi.fn(),
  piiRevokeSessionCall: vi.fn(),
  piiRevokeSubjectCall: vi.fn(),
  piiExportSubjectCall: vi.fn(),
  piiSearchCall: vi.fn(),
}));

vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn(), fromError: vi.fn() },
}));

const ACCESS_TOKEN = "sk-access-token";

const render = () => renderWithProviders(<VaultBrowser accessToken={ACCESS_TOKEN} />);

const typeInto = async (user: ReturnType<typeof userEvent.setup>, placeholder: string, value: string) => {
  await user.type(screen.getByPlaceholderText(placeholder), value);
};

describe("VaultBrowser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("session browsing", () => {
    it("lists token metadata for the session that was asked for", async () => {
      vi.mocked(piiSessionCall).mockResolvedValue({
        session_id: "s1",
        scope_type: "key",
        tokens: [
          {
            token: "<PERSON:abc>",
            entity_type: "PERSON",
            subject_id: "subject-a",
            created_at: null,
            expires_at: null,
          },
        ],
      });
      const user = userEvent.setup();
      render();

      await typeInto(user, "session_id from /pii/encode", "s1");
      await user.click(screen.getByRole("button", { name: "Load" }));

      expect(await screen.findByText("<PERSON:abc>")).toBeInTheDocument();
      expect(screen.getByText("PERSON")).toBeInTheDocument();
      expect(piiSessionCall).toHaveBeenCalledWith(ACCESS_TOKEN, "s1", "key");
    });

    it("sends the selected scope rather than always the default", async () => {
      vi.mocked(piiSessionCall).mockResolvedValue({ session_id: "s1", scope_type: "team", tokens: [] });
      const user = userEvent.setup();
      render();

      await user.selectOptions(screen.getByLabelText("Scope"), "team");
      await typeInto(user, "session_id from /pii/encode", "s1");
      await user.click(screen.getByRole("button", { name: "Load" }));

      await waitFor(() => expect(piiSessionCall).toHaveBeenCalledWith(ACCESS_TOKEN, "s1", "team"));
    });

    it("says so plainly when a session holds nothing", async () => {
      vi.mocked(piiSessionCall).mockResolvedValue({ session_id: "s1", scope_type: "key", tokens: [] });
      const user = userEvent.setup();
      render();

      await typeInto(user, "session_id from /pii/encode", "s1");
      await user.click(screen.getByRole("button", { name: "Load" }));

      expect(await screen.findByText(/No live tokens in this session/)).toBeInTheDocument();
    });

    it("empties the listing after the session is revoked", async () => {
      vi.mocked(piiSessionCall).mockResolvedValue({
        session_id: "s1",
        scope_type: "key",
        tokens: [
          { token: "<PERSON:abc>", entity_type: "PERSON", subject_id: null, created_at: null, expires_at: null },
        ],
      });
      vi.mocked(piiRevokeSessionCall).mockResolvedValue({ revoked: true, scope_type: "key" });
      const user = userEvent.setup();
      render();

      await typeInto(user, "session_id from /pii/encode", "s1");
      await user.click(screen.getByRole("button", { name: "Load" }));
      expect(await screen.findByText("<PERSON:abc>")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: /revoke session/i }));
      expect(await screen.findByText(/No live tokens in this session/)).toBeInTheDocument();
    });
  });

  describe("subject export and erasure", () => {
    it("shows the values held for a subject", async () => {
      vi.mocked(piiExportSubjectCall).mockResolvedValue({
        subject_id: "subject-a",
        scope_type: "key",
        values: [{ token: "<PERSON:abc>", value: "Ada Lovelace" }],
      });
      const user = userEvent.setup();
      render();

      await typeInto(user, "subject_id", "subject-a");
      await user.click(screen.getByRole("button", { name: /export/i }));

      expect(await screen.findByText("Ada Lovelace")).toBeInTheDocument();
    });

    it("warns that an export is real PII and was audited", async () => {
      vi.mocked(piiExportSubjectCall).mockResolvedValue({
        subject_id: "subject-a",
        scope_type: "key",
        values: [{ token: "<PERSON:abc>", value: "Ada Lovelace" }],
      });
      const user = userEvent.setup();
      render();

      await typeInto(user, "subject_id", "subject-a");
      await user.click(screen.getByRole("button", { name: /export/i }));

      expect(await screen.findByText(/real PII and the read has been audited/)).toBeInTheDocument();
    });

    it("erases against the subject that was entered", async () => {
      vi.mocked(piiRevokeSubjectCall).mockResolvedValue({ revoked: true, scope_type: "key" });
      const user = userEvent.setup();
      render();

      await typeInto(user, "subject_id", "subject-a");
      await user.click(screen.getByRole("button", { name: /erase/i }));

      await waitFor(() => expect(piiRevokeSubjectCall).toHaveBeenCalledWith(ACCESS_TOKEN, "subject-a", "key"));
    });
  });

  describe("search", () => {
    it("reports the matches and how much was scanned", async () => {
      vi.mocked(piiSearchCall).mockResolvedValue({
        hits: [{ token: "<PERSON:abc>", entity_type: "PERSON", session_id: "s1", subject_id: null }],
        scanned: 42,
        scope_type: "key",
      });
      const user = userEvent.setup();
      render();

      await typeInto(user, "value to look for", "ada");
      await user.click(screen.getByRole("button", { name: /^search$/i }));

      expect(await screen.findByText(/1 match after scanning 42 rows/)).toBeInTheDocument();
    });

    it("passes the chosen match mode through", async () => {
      vi.mocked(piiSearchCall).mockResolvedValue({ hits: [], scanned: 0, scope_type: "key" });
      const user = userEvent.setup();
      render();

      await user.selectOptions(screen.getByLabelText("Match mode"), "substring");
      await typeInto(user, "value to look for", "ada");
      await user.click(screen.getByRole("button", { name: /^search$/i }));

      await waitFor(() =>
        expect(piiSearchCall).toHaveBeenCalledWith(ACCESS_TOKEN, {
          query: "ada",
          mode: "substring",
          scopeType: "key",
        }),
      );
    });

    it("explains the missing permission instead of a bare error when search is refused", async () => {
      vi.mocked(piiSearchCall).mockRejectedValue(new Error("403 Forbidden"));
      const user = userEvent.setup();
      render();

      await typeInto(user, "value to look for", "ada");
      await user.click(screen.getByRole("button", { name: /^search$/i }));

      expect(await screen.findByText(/permissions.allow_pii_search/)).toBeInTheDocument();
      expect(toast.error).not.toHaveBeenCalled();
    });

    it("still surfaces a real failure as an error", async () => {
      vi.mocked(piiSearchCall).mockRejectedValue(new Error("503 vault unavailable"));
      const user = userEvent.setup();
      render();

      await typeInto(user, "value to look for", "ada");
      await user.click(screen.getByRole("button", { name: /^search$/i }));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("503 vault unavailable"));
      expect(screen.queryByText(/permissions.allow_pii_search/)).not.toBeInTheDocument();
    });
  });
});
