import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GUIDE_SECTIONS } from "@/features/help/content";
import { HelpScreen } from "@/features/help/HelpScreen";
import { resolveBody } from "@/features/help/resolve-body";
import { effectiveBindings } from "@/lib/hotkeys/default-binding";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useUiStore } from "@/lib/stores/ui";
import { unmockedCommands } from "./setup";

// The Help screen's one IPC seam is the settings read (Hide AI, rebindings).
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));

beforeEach(() => {
  useUiStore.setState(useUiStore.getInitialState(), true);
  vi.mocked(loadSettings).mockImplementation(async () =>
    structuredClone(DEFAULT_SETTINGS),
  );
});

afterAll(() => expect(unmockedCommands).toEqual([]));

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** Fence openers left unclosed at the end of a body, as their line numbers. */
function unclosedFences(body: string): number[] {
  let open: { char: string; len: number; line: number } | null = null;
  const lines = body.split("\n");
  for (const [i, line] of lines.entries()) {
    const m = FENCE.exec(line);
    if (!m) continue;
    const char = m[1][0];
    if (!open) open = { char, len: m[1].length, line: i + 1 };
    else if (
      char === open.char &&
      m[1].length >= open.len &&
      m[2].trim() === ""
    )
      open = null;
  }
  return open ? [open.line] : [];
}

describe("the user guide's code fences", () => {
  // A line opening a fence that nothing closes turns the rest of its section
  // into one raw code block, so every opener in a resolved body has its closer.
  it.each([true, false])(
    "each section closes every fence (AI shown: %s)",
    (ai) => {
      const bindings = effectiveBindings({});
      const unclosed = GUIDE_SECTIONS.filter((s) => ai || !s.ai).flatMap((s) =>
        unclosedFences(resolveBody(s.body, ai, bindings)).map(
          (line) => `${s.label}: line ${line}`,
        ),
      );
      expect(unclosed).toEqual([]);
    },
  );
});

describe("the Help screen's Pull requests section", () => {
  async function openPullRequests() {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <HelpScreen />
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    await user.click(
      within(
        screen.getByRole("navigation", { name: "Guide sections" }),
      ).getByRole("button", { name: "Pull requests" }),
    );
    return screen.findByRole("heading", { name: "Local PRs" });
  }

  it("renders its headings and emphasis to the end, outside any code block", async () => {
    await openPullRequests();
    const main = screen.getByRole("main");
    for (const el of main.querySelectorAll("pre, code")) {
      expect(el.textContent).not.toContain("## ");
      expect(el.textContent).not.toContain("**");
    }
    const pickers = within(main).getByText(/^The dialog's pickers read/, {
      selector: "p",
    });
    expect(
      within(pickers).getByText("Merge", { selector: "strong" }),
    ).toBeTruthy();
    expect(
      within(pickers).getByText("Base", { selector: "strong" }),
    ).toBeTruthy();
    expect(
      within(main).getByText("suggestion", { selector: "code" }),
    ).toBeTruthy();
  });
});
