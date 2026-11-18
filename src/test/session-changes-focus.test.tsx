import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFileFilterStore } from "@/components/use-file-list-filter";
import { SessionChanges } from "@/features/sessions/SessionView";
import type { AgentSession } from "@/features/sessions/store";
import {
  gitBranchDiffFiles,
  gitBranchFileDiff,
  gitDiffFile,
  gitMergeBase,
  gitStatus,
} from "@/lib/git/api";
import type { DiffStatEntry, FileDiff, RepoStatus } from "@/lib/git/types";
import { loadSettings, saveSettingsMerged } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { unmockedCommands } from "./setup";

/** Stand-ins by default; the integration case renders the real views. */
const views = vi.hoisted(() => ({ real: false }));
vi.mock("@/features/sessions/WorktreeChangesView", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/features/sessions/WorktreeChangesView")
    >();
  return {
    ...actual,
    WorktreeChangesView: (props: { repoPath: string }) =>
      views.real ? (
        <actual.WorktreeChangesView {...props} />
      ) : (
        <button type="button">Worktree view</button>
      ),
  };
});
vi.mock("@/features/compare/BranchDiffView", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/compare/BranchDiffView")>();
  return {
    ...actual,
    BranchDiffView: (props: Parameters<typeof actual.BranchDiffView>[0]) =>
      views.real ? (
        <actual.BranchDiffView {...props} />
      ) : (
        <button type="button">Branch diff view</button>
      ),
  };
});
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitBranchDiffFiles: vi.fn(),
  gitBranchFileDiff: vi.fn(),
  gitDiffFile: vi.fn(),
  gitMergeBase: vi.fn(),
  gitStatus: vi.fn(),
}));
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
  saveSettingsMerged: vi.fn(),
}));
// A wide row, so the rails are expanded and their fields rendered.
vi.mock("@/lib/use-container-width", () => ({
  useContainerWidth: () => [() => undefined, 900],
}));
vi.mock("@/features/diff/DiffSurfaceLazy", async () => {
  const { useReportPaneSettled } = await import(
    "@/features/diff/diff-pane-hold"
  );
  function DiffSurface({ filePath }: { filePath: string }) {
    useReportPaneSettled(true);
    return <div data-open-file={filePath} />;
  }
  return { DiffSurface, DiffContent: DiffSurface };
});

Element.prototype.scrollIntoView = vi.fn();

const session = (over: Partial<AgentSession>): AgentSession =>
  ({
    id: "s1",
    repoPath: "/repo",
    worktreePath: "/worktree",
    branch: "feature",
    base: "base0",
    headHash: "head1",
    running: false,
    kept: false,
    turns: [],
    ...over,
  }) as AgentSession;

function renderChanges(first: AgentSession) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const ui = (s: AgentSession) => (
    <QueryClientProvider client={client}>
      <button type="button">Outside</button>
      <div data-slot-host="" className="flex min-h-0 flex-1 flex-col">
        <SessionChanges session={s} />
      </div>
    </QueryClientProvider>
  );
  const utils = render(ui(first));
  return { ...utils, update: (s: AgentSession) => utils.rerender(ui(s)) };
}

const landing = () =>
  document.querySelector<HTMLElement>("[data-slot-host]")
    ?.firstElementChild as HTMLElement;
const field = () =>
  screen.getByRole<HTMLInputElement>("textbox", {
    name: "Filter changed files",
  });

beforeEach(() => {
  vi.clearAllMocks();
  unmockedCommands.length = 0;
  views.real = false;
  useFileFilterStore.setState({ texts: {} });
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(saveSettingsMerged).mockResolvedValue(DEFAULT_SETTINGS);
});

afterEach(() => {
  expect(unmockedCommands).toEqual([]);
});

describe("SessionChanges focus landing", () => {
  it("S01 a mount moves nothing; a turn's end lands focus that fell to <body>", () => {
    const { update } = renderChanges(session({ running: true }));
    expect(document.activeElement).toBe(document.body);
    const before = screen.getByRole("button", { name: "Worktree view" });
    act(() => before.focus());
    update(session({ running: false }));
    expect(
      screen.getByRole("button", { name: "Branch diff view" }),
    ).toBeTruthy();
    expect(landing().tagName).toBe("SPAN");
    expect(document.activeElement).toBe(landing());
  });

  it("S02 focus outside the pane stays where the user put it", () => {
    const { update } = renderChanges(session({ running: true }));
    const outside = screen.getByRole("button", { name: "Outside" });
    act(() => outside.focus());
    update(session({ running: false }));
    expect(document.activeElement).toBe(outside);
  });

  it("S03 a turn that committed nothing lands on the placeholder's landing", () => {
    const { update } = renderChanges(
      session({ running: true, headHash: "base0" }),
    );
    act(() => screen.getByRole("button", { name: "Worktree view" }).focus());
    update(session({ running: false, headHash: "base0" }));
    expect(screen.getByText(/No changes yet/)).toBeTruthy();
    expect(document.activeElement).toBe(landing());
  });

  it("S04 a field focused as the turn ends keeps focus and text in the new rail", async () => {
    views.real = true;
    const user = userEvent.setup();
    const entry = (path: string): DiffStatEntry => ({
      path,
      added: 1,
      deleted: 1,
      isBinary: false,
      binaryKind: null,
    });
    const diffOf = (path: string): FileDiff => ({
      filePath: path,
      isBinary: false,
      isTruncated: false,
      text: `diff --git a/${path} b/${path}\n`,
    });
    vi.mocked(gitBranchDiffFiles).mockResolvedValue(
      ["src/alpha.ts", "src/beta.ts", "lib/alpha-2.ts"].map(entry),
    );
    vi.mocked(gitBranchFileDiff).mockImplementation(async (_r, _b, _c, p) =>
      diffOf(p),
    );
    vi.mocked(gitMergeBase).mockResolvedValue({
      mergeBase: "1234567abc",
      compareRev: "abc1234567",
    });
    vi.mocked(gitStatus).mockResolvedValue({
      branch: null,
      entries: ["src/alpha.ts", "src/gamma.ts"].map((path) => ({
        path,
        staged: null,
        unstaged: "modified",
      })),
    } as unknown as RepoStatus);
    vi.mocked(gitDiffFile).mockImplementation(
      async (_r, p) => diffOf(p) as FileDiff,
    );

    // A later turn: the branch diff's list is already cached.
    const { update } = renderChanges(session({ running: false }));
    await waitFor(() => expect(field().value).toBe(""));
    update(session({ running: true }));
    await waitFor(() =>
      expect(
        screen
          .getByRole("complementary")
          .querySelector('[data-path="src/gamma.ts"]'),
      ).not.toBeNull(),
    );
    await user.type(field(), "alpha");
    const typedIn = field();
    update(session({ running: false }));
    expect(field()).not.toBe(typedIn);
    expect(document.activeElement).toBe(field());
    expect(field().value).toBe("alpha");
  });
});
