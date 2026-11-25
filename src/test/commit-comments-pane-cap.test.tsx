import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommitDetailView } from "@/features/history/CommitDetailView";
import {
  commitOnRemote,
  forgeCommitComments,
  forgeCommitDiff,
  forgeStatus,
  ghCommitAuthorAvatars,
  gitCommitDetails,
  gitCommitFileDiff,
  gitCommitFiles,
  gitLog,
  gitStatus,
  readRepoBranchRules,
} from "@/lib/git/api";
import type {
  CommitCommentOut,
  CommitDetails,
  ForgeStatus,
  RepoStatus,
} from "@/lib/git/types";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  commitOnRemote: vi.fn(),
  forgeCommitComments: vi.fn(),
  forgeCommitDiff: vi.fn(),
  forgeStatus: vi.fn(),
  ghCommitAuthorAvatars: vi.fn(),
  gitCommitDetails: vi.fn(),
  gitCommitFileDiff: vi.fn(),
  gitCommitFiles: vi.fn(),
  gitLog: vi.fn(),
  gitStatus: vi.fn(),
  readRepoBranchRules: vi.fn(),
}));
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
// The pane's size is all this suite reads, so the diff draws nothing.
vi.mock("@/features/diff/DiffSurfaceLazy", async () => {
  const { useReportPaneSettled } = await import(
    "@/features/diff/diff-pane-hold"
  );
  function DiffSurface() {
    useReportPaneSettled(true);
    return null;
  }
  return { DiffSurface, DiffContent: () => null };
});

const REPO = "/repo";
const A = "abcdef0123".repeat(4);
const B = `b${A.slice(1)}`;
const ALL_ON = new Proxy({}, { get: () => true });
const details = (hash: string): CommitDetails => ({
  hash,
  subject: `subject ${hash.slice(0, 4)}`,
  body: "",
  author: "Ada",
  authorEmail: "ada@example.com",
  date: "2026-11-01T10:00:00Z",
  committerDate: "2026-11-01T10:00:00Z",
});
const WHOLE: CommitCommentOut = {
  id: "whole",
  author: "octo",
  body: "a whole-commit note",
  createdAt: "2026-01-01T00:00:00Z",
  viewerDidAuthor: false,
  path: null,
  line: null,
  startLine: null,
  position: null,
};
const classes = (el: Element | null | undefined) =>
  (el?.getAttribute("class") ?? "").split(/\s+/);

beforeEach(() => {
  unmockedCommands.length = 0;
  vi.clearAllMocks();
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(forgeStatus).mockResolvedValue({
    provider: "gitlab",
    installed: true,
    authenticated: true,
    repo: "octo/repo",
    host: "gitlab.com",
    login: "octo",
    capabilities: ALL_ON,
    implemented: ALL_ON,
  } as unknown as ForgeStatus);
  vi.mocked(commitOnRemote).mockResolvedValue(true);
  vi.mocked(forgeCommitDiff).mockResolvedValue("");
  vi.mocked(readRepoBranchRules).mockResolvedValue(null);
  vi.mocked(ghCommitAuthorAvatars).mockResolvedValue([]);
  vi.mocked(gitLog).mockResolvedValue([]);
  vi.mocked(gitStatus).mockResolvedValue({
    branch: null,
    entries: [],
  } as unknown as RepoStatus);
  vi.mocked(gitCommitDetails).mockImplementation(async (_r, h) => details(h));
  vi.mocked(gitCommitFiles).mockResolvedValue([]);
  vi.mocked(gitCommitFileDiff).mockResolvedValue({
    filePath: "x",
    text: "",
    isBinary: false,
    isTruncated: false,
  });
});

afterEach(() => {
  cleanup();
  expect(unmockedCommands).toEqual([]);
});

// History's column beside the file rail doesn't scroll, so the comments pane
// keeps the plain 45% cap there: a 16rem floor would squeeze the diff above
// it toward nothing on a short window. The PR commit view's scrolling column
// takes the floor (pr-commit-detail-short-window.test.tsx).
describe("the commit comments pane in History", () => {
  it("caps at 45% with no floor, in its class and its loading hold", async () => {
    vi.mocked(forgeCommitComments).mockImplementation(async (_r, sha) =>
      sha === A ? [WHOLE] : new Promise<CommitCommentOut[]>(() => undefined),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(settingsKeys.settings, DEFAULT_SETTINGS);
    const view = (h: string) => (
      <QueryClientProvider client={client}>
        <CommitDetailView repoPath={REPO} hash={h} />
      </QueryClientProvider>
    );
    const result = render(view(A));
    await waitFor(() => expect(screen.getByText("a whole-commit note")));
    const list = screen.getByRole("group", { name: "Commit comments" });
    const pane = list.parentElement as HTMLElement;
    expect(classes(pane)).toEqual(
      expect.arrayContaining(["max-h-[45%]", "shrink-0"]),
    );
    expect(pane.className).not.toContain("16rem");
    // Another commit's list loading holds the pane at its answered height,
    // capped the same way.
    result.rerender(view(B));
    await waitFor(() => expect(pane.style.minHeight).not.toBe(""));
    expect(pane.style.minHeight).toContain("45%");
    expect(pane.style.minHeight).not.toContain("16rem");
    await act(async () => undefined);
    client.clear();
  });
});
