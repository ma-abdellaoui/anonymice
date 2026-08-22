import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen } from "../../../../tests/test-utils";
import { CommunityEngagementButtons } from "./CommunityEngagementButtons";

let mockUseDisableShowPromptsImpl = () => false;

vi.mock("@/app/(dashboard)/hooks/useDisableShowPrompts", () => ({
  useDisableShowPrompts: () => mockUseDisableShowPromptsImpl(),
}));

describe("CommunityEngagementButtons", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseDisableShowPromptsImpl = () => false;
  });

  it("should render GitHub link with correct href", () => {
    renderWithProviders(<CommunityEngagementButtons />);

    const githubLink = screen.getByRole("link", { name: /anonymice on github/i });
    expect(githubLink).toBeInTheDocument();
    expect(githubLink).toHaveAttribute("href", "https://github.com/ma-abdellaoui/anonymice");
    expect(githubLink).toHaveAttribute("target", "_blank");
    expect(githubLink).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("should not render buttons when prompts are disabled", () => {
    mockUseDisableShowPromptsImpl = () => true;

    renderWithProviders(<CommunityEngagementButtons />);

    expect(screen.queryByRole("link", { name: /anonymice on github/i })).not.toBeInTheDocument();
  });
});
