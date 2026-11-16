// Negative control (run once, reverted): deleting the Shift+click row from
// BUILT_IN_KEYS reds the row test.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ShortcutsDialog } from "@/features/shortcuts/ShortcutsDialog";
import { formatBinding } from "@/lib/hotkeys/binding";
import { BUILT_IN_KEYS } from "@/lib/hotkeys/registry";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";

vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));

function builtIn(): HTMLElement {
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ShortcutsDialog open onOpenChange={() => undefined} />
    </QueryClientProvider>,
  );
  const section = screen
    .getByRole("heading", { name: "Built-in" })
    .closest("section");
  if (!(section instanceof HTMLElement)) throw new Error("no Built-in section");
  return section;
}

/** The key cap beside the row whose description is `what`. */
function capFor(section: HTMLElement, what: string): string | null {
  const row = within(section).getByText(what).closest("li");
  return row?.querySelector("kbd")?.textContent ?? null;
}

describe("cheat sheet built-in keys", () => {
  it("lists Edit history's date and selection keys", () => {
    const section = builtIn();
    expect(
      capFor(section, "Open the focused commit's date editor in Edit history"),
    ).toBe("D");
    expect(capFor(section, "Select a range of commits in Edit history")).toBe(
      "Shift+click",
    );
    expect(
      capFor(
        section,
        "Add or remove a commit from the selection in Edit history",
      ),
    ).toBe(formatBinding("mod+click"));
    expect(
      capFor(section, "Extend the selection in History and Edit history"),
    ).toBe("Shift+↑ / Shift+↓");
    const toggle = BUILT_IN_KEYS.find((r) => r.keys === "Ctrl+click");
    expect(toggle?.binding).toBe("mod+click");
  });

  it("keys every row uniquely", () => {
    const keys = BUILT_IN_KEYS.map((r) => r.keys);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
