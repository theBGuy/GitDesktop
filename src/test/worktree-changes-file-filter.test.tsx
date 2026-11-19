import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFileFilterStore } from "@/components/use-file-list-filter";
import { STATUS_READ_FAILED_REASON } from "@/features/repository/sync-controls-state";
import { WorktreeChangesView } from "@/features/sessions/WorktreeChangesView";
import { gitDiffFile, gitStatus } from "@/lib/git/api";
import type { FileDiff, RepoStatus } from "@/lib/git/types";
import { loadSettings, saveSettingsMerged } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitDiffFile: vi.fn(),
  gitStatus: vi.fn(),
}));
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
  saveSettingsMerged: vi.fn(),
}));
// A wide row, so the rail is expanded and its field rendered.
vi.mock("@/lib/use-container-width", () => ({
  useContainerWidth: () => [() => undefined, 900],
}));
// The stand-in pane names the file it shows in an attribute. A "slow" file
// never settles, so a pick of it holds the pane busy.
vi.mock("@/features/diff/DiffSurfaceLazy", async () => {
  const { useReportPaneSettled } = await import(
    "@/features/diff/diff-pane-hold"
  );
  function DiffSurface({ filePath }: { filePath: string }) {
    useReportPaneSettled(!filePath.includes("slow"));
    return <div data-open-file={filePath} />;
  }
  return { DiffSurface, DiffContent: DiffSurface };
});

Element.prototype.scrollIntoView = vi.fn();

const WT = "/worktree";
/** What the next status read serves; a promise holds it. */
let paths: string[] | Promise<string[]> = [];

function renderView({ seed }: { seed?: RepoStatus } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (seed) client.setQueryData(["session-worktree-status", WT], seed);
  const utils = render(
    <QueryClientProvider client={client}>
      <button type="button">Outside</button>
      <WorktreeChangesView repoPath={WT} />
    </QueryClientProvider>,
  );
  return {
    ...utils,
    poll: () =>
      act(() =>
        client.refetchQueries({ queryKey: ["session-worktree-status"] }),
      ),
    reset: () =>
      act(() => client.resetQueries({ queryKey: ["session-worktree-status"] })),
  };
}

const field = () =>
  screen.getByRole<HTMLInputElement>("textbox", {
    name: "Filter changed files",
  });
const fieldGroup = () =>
  field().closest('[data-slot="input-group"]') as HTMLElement;
const rail = () => screen.getByRole("complementary");
const rendered = () =>
  Array.from(
    rail().querySelectorAll<HTMLElement>("[data-path]"),
    (el) => el.dataset.path,
  );
const openFile = () =>
  Array.from(document.querySelectorAll("[data-open-file]"))
    .find((el) => el.closest("[inert]") === null)
    ?.getAttribute("data-open-file");
const expectOpen = (path: string) =>
  waitFor(() => expect(openFile()).toBe(path));
const landing = () =>
  document.querySelector<HTMLElement>('span[tabindex="-1"]');
/** The one filter status in the view. */
const oneStatus = () => {
  const all = document.querySelectorAll<HTMLElement>(
    "[data-file-filter-status]",
  );
  expect(all).toHaveLength(1);
  return all[0];
};

beforeEach(() => {
  vi.clearAllMocks();
  unmockedCommands.length = 0;
  useFileFilterStore.setState({ texts: {} });
  paths = [];
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(saveSettingsMerged).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(gitStatus).mockImplementation(async () => {
    const served = await paths;
    return {
      branch: null,
      entries: served.map((path) => ({
        path,
        staged: null,
        unstaged: "modified",
      })),
    } as unknown as RepoStatus;
  });
  vi.mocked(gitDiffFile).mockImplementation(
    async (_r, path) =>
      ({
        filePath: path,
        isBinary: false,
        isTruncated: false,
        text: `diff --git a/${path} b/${path}\n`,
      }) as FileDiff,
  );
});

afterEach(() => {
  expect(unmockedCommands).toEqual([]);
});

describe("WorktreeChangesView file filter", () => {
  it("C-a C-g: filters the rows, keeps the pane and the header's full count", async () => {
    paths = ["src/a.ts", "src/b.md", "lib/c.ts"];
    const user = userEvent.setup();
    const { container } = renderView();
    await expectOpen("src/a.ts");
    await user.type(field(), "lib");
    expect(rendered()).toEqual(["lib/c.ts"]);
    expect(fieldGroup().textContent).toContain("1 of 3");
    expect(container.querySelector("header")?.textContent).toContain("3 files");
    await act(() => Promise.resolve());
    expect(openFile()).toBe("src/a.ts");
    expect(rail().querySelector("[aria-current]")).toBeNull();
  });

  it("C-b: list arrows walk the matches only", async () => {
    paths = ["x/1.ts", "y/2.md", "x/3.ts", "y/4.md", "x/5.ts"];
    const user = userEvent.setup();
    renderView();
    await expectOpen("x/1.ts");
    await user.type(field(), "x/");
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement?.getAttribute("data-path")).toBe("x/1.ts");
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement?.getAttribute("data-path")).toBe("x/3.ts");
    await expectOpen("x/3.ts");
  });

  it("C-e: a poll under a filter adds a match, drops the focused row and the open row", async () => {
    paths = ["a/keep.ts", "b/other.md", "c/keep-too.ts"];
    const user = userEvent.setup();
    const { poll } = renderView();
    await expectOpen("a/keep.ts");
    await user.type(field(), "keep");
    expect(fieldGroup().textContent).toContain("2 of 3");
    paths = ["a/keep.ts", "b/other.md", "c/keep-too.ts", "d/keep-new.ts"];
    await poll();
    await waitFor(() => expect(fieldGroup().textContent).toContain("3 of 4"));
    // Arrow onto the second match (a pick), then drop it.
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(document.activeElement?.getAttribute("data-path")).toBe(
      "c/keep-too.ts",
    );
    paths = ["a/keep.ts", "b/other.md", "d/keep-new.ts"];
    await poll();
    await waitFor(() => expect(rendered()).not.toContain("c/keep-too.ts"));
    expect(document.activeElement).not.toBe(document.body);
    // The open row leaves: the first match opens.
    paths = ["b/other.md", "d/keep-new.ts"];
    await poll();
    await expectOpen("d/keep-new.ts");
  });

  it("C-l: a poll emptying the list lands focus on the landing span; a first load takes none", async () => {
    let land: (p: string[]) => void = () => undefined;
    paths = new Promise((r) => {
      land = r;
    });
    const user = userEvent.setup();
    const { poll } = renderView();
    await act(async () => land(["a.ts", "b.ts"]));
    await expectOpen("a.ts");
    expect(document.activeElement).toBe(document.body);

    await user.type(field(), "b");
    paths = [];
    await poll();
    await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
    expect(document.activeElement).toBe(landing());
    expect(document.activeElement).toBe(
      screen.getByRole("group", { name: "Changes" }),
    );

    paths = ["a.ts", "b.ts"];
    await poll();
    await waitFor(() => expect(rendered()).toEqual(["b.ts"]));
    await user.click(field());
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement?.getAttribute("data-path")).toBe("b.ts");
    paths = [];
    await poll();
    await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
    expect(document.activeElement).toBe(landing());

    paths = ["a.ts"];
    await poll();
    await waitFor(() => expect(screen.getByRole("complementary")).toBeTruthy());
    const outside = screen.getByRole("button", { name: "Outside" });
    await act(() => outside.focus());
    paths = [];
    await poll();
    await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
    expect(document.activeElement).toBe(outside);
  });

  it("C-l: a poll emptying the list leaves focus on <body> when the row never held it", async () => {
    paths = ["a.ts", "b.ts"];
    const { poll } = renderView();
    await expectOpen("a.ts");
    expect(document.activeElement).toBe(document.body);
    paths = [];
    await poll();
    await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
    expect(document.activeElement).toBe(document.body);

    paths = ["a.ts", "b.ts"];
    await poll();
    await waitFor(() => expect(rendered()).toEqual(["a.ts", "b.ts"]));
    const row = rail().parentElement as HTMLElement;
    act(() => row.focus());
    expect(document.activeElement).toBe(row);
    paths = [];
    await poll();
    await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
    expect(document.activeElement).toBe(landing());
  });

  it("C-m: a poll leaving nothing to match moves focus from the hidden list to the field", async () => {
    paths = ["a.ts", "b.ts"];
    const user = userEvent.setup();
    const { poll } = renderView();
    await expectOpen("a.ts");
    await user.type(field(), "b");
    const viewport = rail().querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    );
    expect(viewport).toBeTruthy();
    act(() => viewport?.focus());
    expect(document.activeElement).toBe(viewport);
    paths = ["a.ts", "c.ts"];
    await poll();
    await waitFor(() =>
      expect(screen.getByText("No files match the filter")).toBeTruthy(),
    );
    expect(viewport?.isConnected).toBe(true);
    expect(document.activeElement).toBe(field());
  });

  it("C-k: an untouched list follows a new first file; a typed filter pins the open file", async () => {
    paths = ["b.ts", "c.ts"];
    const user = userEvent.setup();
    const { poll } = renderView();
    await expectOpen("b.ts");
    paths = ["a.ts", "b.ts", "c.ts"];
    await poll();
    await expectOpen("a.ts");
    await user.type(field(), "c");
    expect(rendered()).toEqual(["c.ts"]);
    await act(() => Promise.resolve());
    expect(openFile()).toBe("a.ts");
    paths = ["0.ts", "a.ts", "c.ts"];
    await poll();
    await act(() => Promise.resolve());
    expect(openFile()).toBe("a.ts");
  });

  it("C-h: one filter status, the same node through pending, content and empty", async () => {
    let land: (p: string[]) => void = () => undefined;
    paths = new Promise((r) => {
      land = r;
    });
    const user = userEvent.setup();
    const { poll } = renderView();
    await act(() => Promise.resolve());
    const node = oneStatus();
    await act(async () => land(["a.ts", "b.ts"]));
    await expectOpen("a.ts");
    expect(oneStatus()).toBe(node);
    await user.type(field(), "b");
    expect(node.textContent).toBe("Showing 1 of 2 files");
    await user.clear(field());
    expect(node.textContent).toBe("Showing all 2 files");

    paths = [];
    await poll();
    await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
    expect(oneStatus()).toBe(node);
    expect(node.isConnected).toBe(true);

    paths = ["a.ts", "b.ts"];
    await poll();
    await waitFor(() => expect(screen.getByRole("complementary")).toBeTruthy());
    expect(oneStatus()).toBe(node);
    await user.type(field(), "a");
    expect(node.textContent).toBe("Showing 1 of 2 files");
  });

  it("C-h: a failed read keeps its own status line beside the one filter status", async () => {
    vi.mocked(gitStatus).mockRejectedValueOnce(new Error("status failed"));
    renderView();
    await waitFor(() =>
      expect(
        Array.from(
          document.querySelectorAll(
            '[role="status"]:not([data-file-filter-status])',
          ),
        ).some((el) => el.textContent === STATUS_READ_FAILED_REASON),
      ).toBe(true),
    );
    oneStatus();
  });

  it("C-h: the filter status empties when a reset status read fails", async () => {
    paths = ["a.ts", "b.ts"];
    const user = userEvent.setup();
    const { reset } = renderView();
    await expectOpen("a.ts");
    await user.type(field(), "b");
    expect(oneStatus().textContent).toBe("Showing 1 of 2 files");
    vi.mocked(gitStatus).mockRejectedValue(new Error("status failed"));
    await reset();
    await waitFor(() =>
      expect(
        Array.from(
          document.querySelectorAll(
            '[role="status"]:not([data-file-filter-status])',
          ),
        ).some((el) => el.textContent === STATUS_READ_FAILED_REASON),
      ).toBe(true),
    );
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(oneStatus().textContent).toBe("");
  });

  it("C-l: a first load straight into the empty arm takes no focus", async () => {
    let land: (p: string[]) => void = () => undefined;
    paths = new Promise((r) => {
      land = r;
    });
    renderView();
    await act(() => Promise.resolve());
    expect(landing()).toBeNull();
    await act(async () => land([]));
    await waitFor(() => expect(landing()).toBeTruthy());
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  it("C-l: a mount over a cached empty status takes no focus", async () => {
    renderView({
      seed: { branch: null, entries: [] } as unknown as RepoStatus,
    });
    expect(landing()).toBeTruthy();
    await act(() => Promise.resolve());
    await waitFor(() => expect(gitStatus).toHaveBeenCalled());
    await act(() => Promise.resolve());
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  it("C-h: the filter status sits outside the busy pane", async () => {
    paths = ["a.ts", "slow.ts"];
    const user = userEvent.setup();
    renderView();
    await expectOpen("a.ts");
    const slow = rail().querySelector<HTMLElement>('[data-path="slow.ts"]');
    expect(slow).toBeTruthy();
    await user.click(slow as HTMLElement);
    // The held pane is busy until the slow file settles or its bound runs out.
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy();
    const all = document.querySelectorAll("[data-file-filter-status]");
    for (const s of all) expect(s.closest('[aria-busy="true"]')).toBeNull();
    expect(all).toHaveLength(1);
  });
});
