import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { NavModeToggle, SIMPLE_PAGES, useNavMode } from "./NavMode";

const Harness = () => {
  const { mode, setMode } = useNavMode();
  return (
    <>
      <span data-testid="mode">{mode}</span>
      <NavModeToggle mode={mode} onChange={setMode} />
    </>
  );
};

describe("SIMPLE_PAGES", () => {
  it("keeps the two pages the anonymization story is told from", () => {
    expect(SIMPLE_PAGES.has("anonymization")).toBe(true);
    expect(SIMPLE_PAGES.has("pii-activity")).toBe(true);
  });

  it("keeps what is needed to actually send a request", () => {
    for (const page of ["api-keys", "llm-playground", "models", "guardrails", "logs"]) {
      expect(SIMPLE_PAGES.has(page)).toBe(true);
    }
  });

  it("leaves the rest of the proxy out", () => {
    for (const page of ["vector-stores", "budgets", "organizations", "caching", "router-settings"]) {
      expect(SIMPLE_PAGES.has(page)).toBe(false);
    }
  });
});

describe("useNavMode", () => {
  beforeEach(() => window.localStorage.clear());

  it("leaves the sidebar as it was until someone narrows it", () => {
    render(<Harness />);
    expect(screen.getByTestId("mode")).toHaveTextContent("advanced");
  });

  it("remembers simple across a remount", async () => {
    const first = render(<Harness />);
    await userEvent.click(screen.getByRole("radio", { name: "Simple" }));
    expect(screen.getByTestId("mode")).toHaveTextContent("simple");
    first.unmount();

    render(<Harness />);
    expect(await screen.findByTestId("mode")).toHaveTextContent("simple");
  });

  it("switches back", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("radio", { name: "Simple" }));
    await userEvent.click(screen.getByRole("radio", { name: "Advanced" }));
    expect(screen.getByTestId("mode")).toHaveTextContent("advanced");
  });

  it("marks the active option for assistive tech", async () => {
    render(<Harness />);
    expect(screen.getByRole("radio", { name: "Advanced" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("radio", { name: "Simple" }));
    expect(screen.getByRole("radio", { name: "Simple" })).toHaveAttribute("aria-checked", "true");
  });

  it("ignores a stored value that is not a mode", () => {
    window.localStorage.setItem("anonymice:nav-mode", "everything");
    render(<Harness />);
    expect(screen.getByTestId("mode")).toHaveTextContent("advanced");
  });
});
