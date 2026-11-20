import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AppAnnouncer } from "@/components/app-announcer";
import { announceApp } from "@/lib/app-announce";

// The app-level polite region an arrival in another repository speaks through.
// The store is module state shared by every case here, so the empty-region case
// runs first and the rest compare against what the region held before.

afterEach(cleanup);

function region(): HTMLElement {
  return screen.getByRole("status");
}

describe("AppAnnouncer", () => {
  it("renders one empty polite, visually hidden status region before any text", () => {
    render(<AppAnnouncer />);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    const el = region();
    expect(el.textContent).toBe("");
    expect(el.getAttribute("aria-live")).toBe("polite");
    expect(el.classList.contains("sr-only")).toBe(true);
  });

  it("puts an announced text in the region", () => {
    render(<AppAnnouncer />);
    act(() => announceApp("Opened in harbor"));
    expect(region().textContent?.startsWith("Opened in harbor")).toBe(true);
  });

  it("changes the region's textContent when the same text is announced again", () => {
    render(<AppAnnouncer />);
    act(() => announceApp("Opened in Fork"));
    const first = region().textContent;
    act(() => announceApp("Opened in Fork"));
    const second = region().textContent;
    expect(second).not.toBe(first);
    expect(second?.startsWith("Opened in Fork")).toBe(true);
    act(() => announceApp("Opened in Fork"));
    expect(region().textContent).not.toBe(second);
  });

  it("keeps the same node across announcements", () => {
    render(<AppAnnouncer />);
    const before = region();
    act(() => announceApp("Opened in Upstream"));
    act(() => announceApp("Opened in widgets"));
    expect(region()).toBe(before);
    expect(before.isConnected).toBe(true);
    expect(before.textContent?.startsWith("Opened in widgets")).toBe(true);
  });
});
