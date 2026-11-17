import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalPrView } from "@/features/pulls/LocalPrView";
import {
  loadBranchRules,
  loadSharedBranchRules,
} from "@/lib/branch-rules/store";
import { EMPTY_BRANCH_RULES } from "@/lib/branch-rules/types";
import {
  gitCompareBranches,
  gitConflictPreview,
  gitDefaultBranch,
  gitStatus,
} from "@/lib/git/api";
import type { CommitSummary, RepoStatus } from "@/lib/git/types";
import { type LocalPr, listLocalPrs } from "@/lib/pulls/local";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useUiStore } from "@/lib/stores/ui";
import { unmockedCommands } from "./setup";

vi.mock("sonner", () => ({
  toast: {
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
  },
}));
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitConflictPreview: vi.fn(),
  gitCompareBranches: vi.fn(),
  gitDefaultBranch: vi.fn(),
  gitStatus: vi.fn(),
  gitBranchDiffFiles: vi.fn(async () => []),
  gitMergeBase: vi.fn(() => new Promise(() => undefined)),
  getSecret: vi.fn(async () => null),
  gitBranches: vi.fn(() => new Promise(() => undefined)),
  forgeStatus: vi.fn(() => new Promise(() => undefined)),
  forgeIssueList: vi.fn(() => new Promise(() => undefined)),
  forgeIssueView: vi.fn(() => new Promise(() => undefined)),
}));
// Plugin-store reads bypass the rejecting transport, so each is mocked here.
vi.mock("@/lib/pulls/local", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pulls/local")>()),
  listLocalPrs: vi.fn(),
  updateLocalPr: vi.fn(),
}));
vi.mock("@/lib/branch-rules/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/branch-rules/store")>()),
  loadBranchRules: vi.fn(),
  loadSharedBranchRules: vi.fn(),
}));

const REPO = "C:/repo";

function commit(i: number, date: string, committerDate: string): CommitSummary {
  return {
    hash: String(i).padStart(40, "0"),
    subject: `commit ${i}`,
    author: "me",
    authorEmail: "",
    date,
    committerDate,
    tags: [],
    isMerge: false,
  };
}

const C1 = commit(1, "2026-11-02T09:00:00Z", "2026-11-02T09:00:00Z");
// Rewritten by Edit dates: authored before the PR, committed after the comment.
const C2 = commit(2, "2026-10-15T08:00:00Z", "2026-11-05T08:00:00Z");
// Replayed in the same rewrite: the same committer second as C2.
const C3 = commit(3, "2026-10-16T08:00:00Z", "2026-11-05T08:00:00Z");

const pr = (comments: LocalPr["comments"]): LocalPr => ({
  id: "a",
  title: "PR A",
  body: "",
  base: "main",
  head: "feature",
  status: "open",
  approved: false,
  labels: [],
  comments,
  createdAt: "2026-11-01T10:00:00Z",
});

const COMMENT = {
  id: "c1",
  body: "the review comment",
  createdAt: "2026-11-03T12:00:00Z",
};

/** `git log` order: newest first. */
function setup(ahead: CommitSummary[], comments: LocalPr["comments"]) {
  vi.mocked(gitCompareBranches).mockResolvedValue({ ahead, behind: [] });
  vi.mocked(listLocalPrs).mockResolvedValue([pr(comments)]);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  act(() =>
    useUiStore.setState({
      repoPath: REPO,
      selectedPr: { kind: "local", id: "a" },
    }),
  );
  render(
    <QueryClientProvider client={client}>
      <LocalPrView repoPath={REPO} id="a" />
    </QueryClientProvider>,
  );
}

/** The feed's anchors in DOM order, read off the elements they name. */
function feedOrder(anchors: Record<string, HTMLElement>): string[] {
  return Object.entries(anchors)
    .sort(([, a], [, b]) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
    )
    .map(([name]) => name);
}

/** A "pushed N commits" row: its toggle and the row that holds its list. */
function pushedRow(n: number) {
  const toggle = screen.getByRole("button", {
    name: `pushed ${n} commit${n === 1 ? "" : "s"}`,
  });
  const row = toggle.closest("div.flex.items-start");
  if (!(row instanceof HTMLElement)) throw new Error("no pushed row");
  return { toggle, row };
}

const times = (root: ParentNode) =>
  [...root.querySelectorAll("time")].map((t) => t.getAttribute("dateTime"));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(loadBranchRules).mockResolvedValue(EMPTY_BRANCH_RULES);
  vi.mocked(loadSharedBranchRules).mockResolvedValue(EMPTY_BRANCH_RULES);
  vi.mocked(gitConflictPreview).mockResolvedValue({
    status: "clean",
    conflicts: [],
  });
  vi.mocked(gitDefaultBranch).mockResolvedValue("main");
  vi.mocked(gitStatus).mockResolvedValue({
    branch: { name: "feature" },
    entries: [],
  } as unknown as RepoStatus);
});

afterAll(() => expect(unmockedCommands).toEqual([]));

describe("local PR timeline", () => {
  it("orders commits by committer date and keeps a rewrite's replay order", async () => {
    const user = userEvent.setup();
    setup([C3, C2, C1], [COMMENT]);
    await screen.findByRole("button", { name: "pushed 2 commits" });
    const created = screen.getByText(/created this local PR/);
    const comment = screen.getByText("the review comment");
    const first = pushedRow(1);
    const last = pushedRow(2);
    expect(
      feedOrder({
        created,
        first: first.row,
        comment,
        last: last.row,
      }),
    ).toEqual(["created", "first", "comment", "last"]);

    await user.click(first.toggle);
    expect(first.row).toHaveTextContent("commit 1");
    expect(times(first.row)).toEqual([
      "2026-11-02T09:00:00Z",
      "2026-11-02T09:00:00Z",
    ]);

    await user.click(last.toggle);
    const rows = [...last.row.querySelectorAll("li")].map(
      (li) => li.textContent,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("commit 2");
    expect(rows[1]).toContain("commit 3");
    // The header (the run's newest), then each row: committer dates.
    expect(times(last.row)).toEqual([
      "2026-11-05T08:00:00Z",
      "2026-11-05T08:00:00Z",
      "2026-11-05T08:00:00Z",
    ]);
  });

  it("keeps author dates on the Commits tab", async () => {
    const user = userEvent.setup();
    setup([C3, C2, C1], [COMMENT]);
    await user.click(
      await screen.findByRole("button", { name: "Commits (3)" }),
    );
    // Every time on the tab but the header's created date.
    const listed = () =>
      times(document).filter((d) => d !== "2026-11-01T10:00:00Z");
    await waitFor(() =>
      expect(listed()).toEqual([
        "2026-10-16T08:00:00Z",
        "2026-10-15T08:00:00Z",
        "2026-11-02T09:00:00Z",
      ]),
    );
  });

  it("compares committer dates as instants, not strings", async () => {
    // 08:00+02:00 is 06:00Z, earlier than 07:00Z though it sorts later as text.
    const early = commit(
      4,
      "2026-11-06T08:00:00+02:00",
      "2026-11-06T08:00:00+02:00",
    );
    const late = commit(5, "2026-11-06T07:00:00Z", "2026-11-06T07:00:00Z");
    setup(
      [late, early],
      [{ id: "c2", body: "between", createdAt: "2026-11-06T06:30:00Z" }],
    );
    await screen.findAllByRole("button", { name: "pushed 1 commit" });
    const [a, b] = screen.getAllByRole("button", { name: "pushed 1 commit" });
    const between = screen.getByText("between");
    expect(feedOrder({ a, between, b })).toEqual(["a", "between", "b"]);
    const rowOf = (el: HTMLElement) => el.closest("div.flex.items-start");
    expect(times(rowOf(a) as HTMLElement)).toEqual([
      "2026-11-06T08:00:00+02:00",
    ]);
  });

  it("shows only the created row and comment with nothing ahead", async () => {
    setup([], [COMMENT]);
    await screen.findByText("the review comment");
    expect(screen.getByText(/created this local PR/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^pushed / })).toBeNull();
  });
});
