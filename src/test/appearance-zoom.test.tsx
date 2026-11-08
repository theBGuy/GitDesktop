import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppearanceSection } from "@/features/settings/AppearanceSection";
import { type AppSettings, loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useZoom } from "@/lib/zoom/use-zoom";
import { resetZoom, stepZoom } from "@/lib/zoom/zoom";

// The settings api is the seam for the hint's bindings; the zoom controller is
// mocked whole (it wires the window and the store), while @/lib/zoom/steps
// stays real so the copy is checked against the shipped constants.
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
vi.mock("@/lib/zoom/zoom", () => ({
  stepZoom: vi.fn(),
  resetZoom: vi.fn(),
}));
vi.mock("@/lib/zoom/use-zoom", () => ({ useZoom: vi.fn() }));

let stored: AppSettings;

beforeEach(() => {
  stored = structuredClone(DEFAULT_SETTINGS);
  vi.mocked(loadSettings).mockImplementation(async () =>
    structuredClone(stored),
  );
  vi.mocked(useZoom).mockReturnValue({ level: 1, max: 2 });
  vi.mocked(stepZoom).mockClear();
  vi.mocked(resetZoom).mockClear();
});

async function renderSection(
  zoom = { level: 1, max: 2 },
  hotkeys: AppSettings["hotkeys"] = {},
) {
  vi.mocked(useZoom).mockReturnValue(zoom);
  stored.hotkeys = hotkeys;
  // A non-default theme marks the settings read as landed (the hint reads
  // the registry defaults until it does).
  stored.theme = "light";
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <AppearanceSection />
    </QueryClientProvider>,
  );
  await screen.findByText("Light");
  return userEvent.setup();
}

const zoomOut = () => screen.getByRole("button", { name: "Zoom out" });
const zoomIn = () => screen.getByRole("button", { name: "Zoom in" });
const reset = () => screen.getByRole("button", { name: "Reset zoom" });
const hint = () =>
  screen.getByText(
    (_, el) =>
      el?.tagName === "P" &&
      !!el.textContent?.startsWith("Scales the whole app"),
  );
const reasonOf = (button: HTMLElement) => {
  const ids = button.getAttribute("aria-describedby")?.split(" ") ?? [];
  return ids.map((id) => document.getElementById(id)?.textContent).join(" ");
};

describe("Settings → Appearance interface zoom", () => {
  it("names the stepper group by its label and reads the level politely", async () => {
    await renderSection({ level: 1.25, max: 2 });
    expect(
      screen.getByRole("group", { name: "Interface zoom" }),
    ).toBeInTheDocument();
    const readout = screen.getByRole("status");
    expect(readout).toHaveTextContent("Zoom 125%");
    expect(readout).toHaveClass("tabular-nums", "min-w-16");
    expect(readout).not.toHaveAttribute("tabindex");
  });

  it("drives the controller with the settings source", async () => {
    const user = await renderSection({ level: 1.25, max: 2 });
    await user.click(zoomOut());
    expect(stepZoom).toHaveBeenLastCalledWith(-1, "settings");
    await user.click(zoomIn());
    expect(stepZoom).toHaveBeenLastCalledWith(1, "settings");
    await user.click(reset());
    expect(resetZoom).toHaveBeenCalledWith("settings");
    expect(stepZoom).toHaveBeenCalledTimes(2);
  });

  it("blocks Reset at 100% and its click calls nothing", async () => {
    const user = await renderSection({ level: 1, max: 2 });
    expect(reset()).toHaveAttribute("aria-disabled", "true");
    expect(reasonOf(reset())).toBe("Already at 100%");
    await user.click(reset());
    expect(resetZoom).not.toHaveBeenCalled();
    expect(zoomOut()).not.toHaveAttribute("aria-disabled");
    expect(zoomIn()).not.toHaveAttribute("aria-disabled");
  });

  it("blocks zoom out at the minimum", async () => {
    const user = await renderSection({ level: 0.8, max: 2 });
    expect(zoomOut()).toHaveAttribute("aria-disabled", "true");
    expect(reasonOf(zoomOut())).toBe("Minimum zoom (80%)");
    await user.click(zoomOut());
    expect(stepZoom).not.toHaveBeenCalled();
  });

  it("blocks zoom in at the display's maximum with its own reason", async () => {
    const user = await renderSection({ level: 1.5, max: 1.5 });
    expect(zoomIn()).toHaveAttribute("aria-disabled", "true");
    expect(reasonOf(zoomIn())).toBe("Maximum zoom for this display");
    await user.click(zoomIn());
    expect(stepZoom).not.toHaveBeenCalled();
  });

  it("blocks zoom in at the hard maximum", async () => {
    await renderSection({ level: 2, max: 2 });
    expect(zoomIn()).toHaveAttribute("aria-disabled", "true");
    expect(reasonOf(zoomIn())).toBe("Maximum zoom (200%)");
  });

  it("keeps zoom out live when a clamped level blocks Reset", async () => {
    const user = await renderSection({ level: 1, max: 1 });
    expect(reset()).toHaveAttribute("aria-disabled", "true");
    expect(zoomIn()).toHaveAttribute("aria-disabled", "true");
    await user.click(zoomOut());
    expect(stepZoom).toHaveBeenCalledWith(-1, "settings");
  });

  it.each([
    { level: 1.25, max: 2 },
    { level: 1, max: 1 },
    { level: 0.8, max: 2 },
  ])("tabs −, +, Reset after the theme select at %o", async (zoom) => {
    const user = await renderSection(zoom);
    screen.getByRole("combobox").focus();
    await user.tab();
    expect(zoomOut()).toHaveFocus();
    await user.tab();
    expect(zoomIn()).toHaveFocus();
    await user.tab();
    expect(reset()).toHaveFocus();
  });

  it("hints the default chords, one Kbd per whole chord", async () => {
    await renderSection();
    expect(hint()).toHaveTextContent(
      "Scales the whole app, diffs included. Ctrl+= / Ctrl+- or Ctrl+scroll; Ctrl+0 resets.",
    );
    const chords = [...hint().querySelectorAll("kbd")].map(
      (k) => k.textContent,
    );
    expect(chords).toEqual(["Ctrl+=", "Ctrl+-", "Ctrl+0"]);
    expect(screen.getByText("Ctrl+scroll")).toHaveClass("whitespace-nowrap");
  });

  it("follows a rebind", async () => {
    await renderSection(undefined, { "app-zoom-in": "mod+shift+i" });
    const chords = [...hint().querySelectorAll("kbd")].map(
      (k) => k.textContent,
    );
    expect(chords).toEqual(["Ctrl+Shift+I", "Ctrl+-", "Ctrl+0"]);
  });

  it.each([
    [
      { "app-zoom-out": null },
      "Scales the whole app, diffs included. Ctrl+= or Ctrl+scroll; Ctrl+0 resets.",
    ],
    [
      { "app-zoom-in": null, "app-zoom-out": null },
      "Scales the whole app, diffs included. Ctrl+scroll zooms; Ctrl+0 resets.",
    ],
    [
      { "app-zoom-reset": null },
      "Scales the whole app, diffs included. Ctrl+= / Ctrl+- or Ctrl+scroll.",
    ],
    [
      { "app-zoom-in": null, "app-zoom-out": null, "app-zoom-reset": null },
      "Scales the whole app, diffs included. Ctrl+scroll zooms.",
    ],
  ])("drops unbound chords: %o", async (hotkeys, text) => {
    await renderSection(undefined, hotkeys);
    expect(hint()).toHaveTextContent(text);
  });
});
