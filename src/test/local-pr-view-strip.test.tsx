import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalPrView } from "@/features/pulls/LocalPrView";
import {
  loadBranchRules,
  loadSharedBranchRules,
} from "@/lib/branch-rules/store";
import { EMPTY_BRANCH_RULES } from "@/lib/branch-rules/types";
import {
  forgeStatus,
  gitCompareBranches,
  gitConflictPreview,
  gitDefaultBranch,
  gitMergeAutostash,
  gitStatus,
  gitUpdateBranchFrom,
} from "@/lib/git/api";
import {
  conflictPreviewKey,
  conflictPreviewQueryKey,
  useMergeLocalPr,
  useUpdateBranchFrom,
} from "@/lib/git/queries";
import type {
  BranchComparison,
  CommitSummary,
  ForgeStatus,
  MergePreview,
  RepoStatus,
} from "@/lib/git/types";
import { dispatchAction } from "@/lib/hotkeys/hotkeys";
import { type LocalPr, listLocalPrs, updateLocalPr } from "@/lib/pulls/local";
import { useUpdateLocalPr } from "@/lib/pulls/queries";
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
vi.mock("@/lib/toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/toast")>()),
  toastError: vi.fn(),
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
  gitUpdateBranchFrom: vi.fn(),
  gitMergeAutostash: vi.fn(),
  // A merge staged from outside the view stays in flight.
  gitMergeLocalPr: vi.fn(() => new Promise(() => undefined)),
  gitBranchDiffFiles: vi.fn(async () => []),
  // The Files tab's fork-point read and the Review tab's key read.
  gitMergeBase: vi.fn(() => new Promise(() => undefined)),
  getSecret: vi.fn(async () => null),
  // The closed Promote dialog's Keep local read; never answered.
  gitBranches: vi.fn(() => new Promise(() => undefined)),
  // The forge probe never answers: a local PR needs none of it.
  forgeStatus: vi.fn(() => new Promise(() => undefined)),
  // The Edit dialog's issue chips read these once a tracker is ready; never answered.
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
// The paused-merge takeover's own view is out of scope here.
vi.mock("@/features/pulls/ResolveConflictsView", () => ({
  ResolveConflictsView: () => <p>Resolve view</p>,
}));

const REPO = "C:/repo";

const commit = (i: number) =>
  ({
    hash: String(i).padStart(40, "0"),
    subject: `commit ${i}`,
    author: "me",
    date: "2026-01-01T00:00:00Z",
  }) as unknown as CommitSummary;

const behindBy = (n: number): BranchComparison => ({
  ahead: [],
  behind: Array.from({ length: n }, (_, i) => commit(i)),
});

const preview = (
  status: MergePreview["status"],
  conflicts: string[] = [],
): MergePreview => ({ status, conflicts });

function makePr(over: Partial<LocalPr> = {}): LocalPr {
  return {
    id: "a",
    title: "PR A",
    body: "",
    base: "main",
    head: "feature",
    status: "open",
    approved: false,
    labels: [],
    comments: [],
    createdAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function statusOn(branch: string, dirty: boolean): RepoStatus {
  return {
    branch: { name: branch },
    entries: dirty
      ? [{ path: "a.txt", staged: null, unstaged: "modified" }]
      : [],
  } as unknown as RepoStatus;
}

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let records: LocalPr[] = [];

/** Starts an update-from write from outside the view, as the branch switcher does. */
let startUpdate!: (branch: string, base: string) => void;
function UpdateProbe() {
  const m = useUpdateBranchFrom(REPO);
  startUpdate = (branch, base) => {
    void m.mutateAsync({ branch, base }).catch(() => undefined);
  };
  return null;
}

/** Starts PR "a"'s record and merge writes from outside the view, as another
 *  surface or a remounted view's earlier press would: no click slot is set. */
let stageRecordWrite!: (vars: {
  mutate: (pr: LocalPr) => LocalPr;
  approved?: boolean;
}) => void;
let stageMerge!: () => void;
function WriteProbe() {
  const record = useUpdateLocalPr(REPO);
  const merge = useMergeLocalPr(REPO);
  stageRecordWrite = (vars) => {
    void record.mutateAsync({ id: "a", ...vars }).catch(() => undefined);
  };
  stageMerge = () => {
    const vars = {
      id: "a",
      base: "main",
      head: "feature",
      message: "m",
      strategy: "merge" as const,
    };
    void merge.mutateAsync(vars).catch(() => undefined);
  };
  return null;
}

/** A selection change re-renders a mounted view, so it lands inside act. */
function select(id: string) {
  act(() => useUiStore.setState({ selectedPr: { kind: "local", id } }));
}

function renderView(id = "a") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const ui = (pid: string) => (
    <QueryClientProvider client={client}>
      <LocalPrView repoPath={REPO} id={pid} />
      <UpdateProbe />
      <WriteProbe />
    </QueryClientProvider>
  );
  select(id);
  const result = render(ui(id));
  return {
    ...result,
    client,
    showPr: (pid: string) => {
      select(pid);
      result.rerender(ui(pid));
    },
    /** Unmounts the view and mounts it again over the same cache, as a local ->
     *  remote -> local hop does. */
    remount: () => {
      result.rerender(
        <QueryClientProvider client={client}>
          <UpdateProbe />
          <WriteProbe />
        </QueryClientProvider>,
      );
      result.rerender(ui(id));
    },
  };
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 30)));

/** The strip: the element right after the normal view's header. */
function strip(): HTMLElement | null {
  const next = document.querySelector("header")?.nextElementSibling;
  return next instanceof HTMLElement && next.getAttribute("tabindex") === "-1"
    ? next
    : null;
}

async function findStrip(text: string | RegExp) {
  await waitFor(() => {
    const s = strip();
    expect(s).not.toBeNull();
    if (typeof text === "string") expect(s).toHaveTextContent(text);
    else expect(s?.textContent).toMatch(text);
  });
  return strip() as HTMLElement;
}

/** The footer: the bar holding Close. */
function footer(): HTMLElement {
  const close = screen.getByRole("button", { name: "Close" });
  const bar = close.closest(".border-t");
  if (!(bar instanceof HTMLElement)) throw new Error("no footer");
  return bar;
}

const DIRTY =
  "Commit or stash your changes before merging into the current branch";

beforeEach(() => {
  vi.clearAllMocks();
  records = [makePr()];
  useUiStore.setState({ repoPath: REPO, selectedPr: null });
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(listLocalPrs).mockImplementation(async () => records);
  vi.mocked(updateLocalPr).mockImplementation(async (_repo, id, mutate) => {
    records = records.map((p) => (p.id === id ? mutate(p) : p));
    return records.find((p) => p.id === id) as LocalPr;
  });
  vi.mocked(loadBranchRules).mockResolvedValue(EMPTY_BRANCH_RULES);
  vi.mocked(loadSharedBranchRules).mockResolvedValue(EMPTY_BRANCH_RULES);
  vi.mocked(gitConflictPreview).mockResolvedValue(preview("clean"));
  vi.mocked(gitCompareBranches).mockResolvedValue(behindBy(0));
  vi.mocked(gitDefaultBranch).mockResolvedValue("main");
  vi.mocked(gitStatus).mockResolvedValue(statusOn("feature", false));
  vi.mocked(gitUpdateBranchFrom).mockReturnValue(new Promise(() => undefined));
});

afterAll(() => expect(unmockedCommands).toEqual([]));

describe("LocalPrView merge strip", () => {
  it("an open PR shows the strip under the header on every tab", async () => {
    const user = userEvent.setup();
    renderView();
    const s = await findStrip("No conflicts with main.");
    const composer = screen.getByRole("textbox", { name: "Leave a note" });
    expect(
      s.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    for (const tab of [/^Commits/, /^Files/, /^Review/]) {
      await user.click(screen.getByRole("button", { name: tab }));
      const shown = await findStrip("No conflicts with main.");
      const content = shown.nextElementSibling;
      expect(content).not.toBeNull();
      expect(content).not.toBe(footer());
    }
  });

  it.each([
    ["closed", { status: "closed" as const }],
    ["merged", { status: "merged" as const }],
  ])("a %s PR shows no strip", async (_label, over) => {
    records = [makePr(over)];
    renderView();
    await screen.findByRole("heading", { name: /PR A/ });
    await settle();
    expect(strip()).toBeNull();
    expect(screen.queryByText(/No conflicts with/)).toBeNull();
  });

  it("the old status block's lines render in no state", async () => {
    const old =
      /Merges cleanly|This merge will conflict in|Approve this PR to merge/;
    renderView();
    await findStrip("No conflicts with main.");
    expect(screen.queryByText(old)).toBeNull();
    vi.mocked(gitConflictPreview).mockResolvedValue(
      preview("conflict", ["src/a.ts"]),
    );
    records = [makePr({ id: "c", head: "conflicting" })];
    renderView("c");
    await screen.findAllByText(/will conflict/);
    expect(screen.queryByText(old)).toBeNull();
  });

  it("Approve sits in the footer on every tab and holds while it saves", async () => {
    const user = userEvent.setup();
    const write = deferred<LocalPr>();
    vi.mocked(updateLocalPr).mockImplementationOnce(
      async (_repo, id, mutate) => {
        await write.promise;
        records = records.map((p) => (p.id === id ? mutate(p) : p));
        return records[0];
      },
    );
    renderView();
    await findStrip("No conflicts with main.");
    for (const tab of [/^Commits/, /^Files/, /^Review/, /^Conversation/]) {
      await user.click(screen.getByRole("button", { name: tab }));
      const approve = within(footer()).getByRole("button", { name: "Approve" });
      expect(approve).toHaveAttribute("aria-pressed", "false");
    }
    expect(screen.getAllByRole("button", { name: "Approve" })).toHaveLength(2);
    await user.click(within(footer()).getByRole("button", { name: "Approve" }));
    expect(updateLocalPr).toHaveBeenCalledTimes(1);
    const mutate = vi.mocked(updateLocalPr).mock.calls[0][2];
    expect(mutate(makePr()).approved).toBe(true);
    await waitFor(() => {
      for (const b of screen.getAllByRole("button", { name: "Approve" })) {
        expect(b).toHaveAttribute("aria-disabled", "true");
        expect(b).toHaveAccessibleDescription("Saving…");
      }
    });
    await user.click(within(footer()).getByRole("button", { name: "Approve" }));
    expect(updateLocalPr).toHaveBeenCalledTimes(1);
    await act(async () => write.resolve(makePr()));
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "Approved" })).toHaveLength(
        2,
      ),
    );
    for (const b of screen.getAllByRole("button", { name: "Approved" })) {
      expect(b).toHaveAttribute("aria-pressed", "true");
    }
  });

  it("a closed PR has no Approve", async () => {
    records = [makePr({ status: "closed" })];
    renderView();
    await screen.findByRole("button", { name: "Reopen" });
    expect(screen.queryByRole("button", { name: /^Approve/ })).toBeNull();
  });

  it("the approval hold stays with its PR across a switch", async () => {
    const user = userEvent.setup();
    records = [makePr(), makePr({ id: "b", title: "PR B", head: "other" })];
    vi.mocked(updateLocalPr).mockReturnValueOnce(new Promise(() => undefined));
    const view = renderView();
    await findStrip("No conflicts with main.");
    await user.click(within(footer()).getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(
        within(footer()).getByRole("button", { name: "Approve" }),
      ).toHaveAttribute("aria-disabled", "true"),
    );
    view.showPr("b");
    await screen.findByRole("heading", { name: /PR B/ });
    const approve = within(footer()).getByRole("button", { name: "Approve" });
    expect(approve).not.toHaveAttribute("aria-disabled");
  });

  it("Merge holds while an approval change saves", async () => {
    const user = userEvent.setup();
    records = [makePr({ approved: true })];
    vi.mocked(updateLocalPr).mockReturnValueOnce(new Promise(() => undefined));
    renderView();
    await findStrip("No conflicts with main.");
    await settle();
    const merge = () => screen.getByRole("button", { name: "Merge" });
    expect(merge()).not.toHaveAttribute("aria-disabled");
    await user.click(
      within(footer()).getByRole("button", { name: "Approved" }),
    );
    await waitFor(() =>
      expect(merge()).toHaveAttribute("aria-disabled", "true"),
    );
    expect(merge()).toHaveAccessibleDescription("Saving…");
  });

  it("an approval being granted holds Merge as saving, not as unapproved", async () => {
    const user = userEvent.setup();
    vi.mocked(updateLocalPr).mockReturnValueOnce(new Promise(() => undefined));
    renderView();
    await findStrip("No conflicts with main.");
    await settle();
    const merge = () => screen.getByRole("button", { name: "Merge" });
    // Control: the stored record alone reads as unapproved.
    expect(merge()).toHaveAccessibleDescription(
      "Approve the PR before merging",
    );
    await user.click(within(footer()).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(merge()).toHaveAccessibleDescription("Saving…"));
    expect(merge()).toHaveAttribute("aria-disabled", "true");
    expect(records[0].approved).toBe(false);
  });

  it("an approval write pending in the cache holds Merge as saving with no click", async () => {
    vi.mocked(updateLocalPr).mockReturnValue(new Promise(() => undefined));
    renderView();
    await findStrip("No conflicts with main.");
    await settle();
    const merge = () => screen.getByRole("button", { name: "Merge" });
    const unapproved = "Approve the PR before merging";
    // Control: a pending record write that sets no approval holds nothing.
    act(() => stageRecordWrite({ mutate: (cur) => ({ ...cur, title: "x" }) }));
    await settle();
    expect(merge()).toHaveAccessibleDescription(unapproved);
    act(() =>
      stageRecordWrite({
        mutate: (cur) => ({ ...cur, approved: true }),
        approved: true,
      }),
    );
    await waitFor(() => expect(merge()).toHaveAccessibleDescription("Saving…"));
    expect(merge()).toHaveAttribute("aria-disabled", "true");
  });

  it("a merge in flight outranks an approval write in flight", async () => {
    records = [makePr({ approved: true })];
    vi.mocked(updateLocalPr).mockReturnValue(new Promise(() => undefined));
    renderView();
    await findStrip("No conflicts with main.");
    await settle();
    const merge = () => screen.getByRole("button", { name: "Merge" });
    act(() =>
      stageRecordWrite({
        mutate: (cur) => ({ ...cur, approved: false }),
        approved: false,
      }),
    );
    // Control: the approval write alone reads as saving.
    await waitFor(() => expect(merge()).toHaveAccessibleDescription("Saving…"));
    act(() => stageMerge());
    await waitFor(() =>
      expect(merge()).toHaveAccessibleDescription("Merging…"),
    );
  });

  it("Merge names its reason, and the dirty tree's shows as text", async () => {
    // Unapproved over a dirty current base: the approval reason outranks the tree's.
    vi.mocked(gitStatus).mockResolvedValue(statusOn("main", true));
    const view = renderView();
    await findStrip("No conflicts with main.");
    await settle();
    expect(gitStatus).toHaveBeenCalled();
    const merge = () => screen.getByRole("button", { name: "Merge" });
    expect(merge()).toHaveAttribute("aria-disabled", "true");
    expect(merge()).toHaveAccessibleDescription(
      "Approve the PR before merging",
    );
    expect(screen.queryByText(DIRTY, { selector: "p > span" })).toBeNull();
    view.unmount();

    records = [makePr({ approved: true })];
    vi.mocked(gitStatus).mockResolvedValue(statusOn("main", true));
    const dirty = renderView();
    const line = await screen.findByText(DIRTY, { selector: "p > span" });
    expect(merge()).toHaveAccessibleDescription(DIRTY);
    expect(
      line.compareDocumentPosition(merge()) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const approve = within(footer()).getByRole("button", { name: "Approved" });
    expect(
      line.compareDocumentPosition(approve) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const group = approve.closest(".ml-auto");
    expect(group).not.toBeNull();
    expect(group).toContainElement(merge());
    expect(group).not.toContainElement(
      screen.getByRole("button", { name: "Close" }),
    );
    dirty.unmount();

    vi.mocked(gitStatus).mockResolvedValue(statusOn("main", false));
    renderView();
    await findStrip("No conflicts with main.");
    await settle();
    expect(merge()).not.toHaveAttribute("aria-disabled");
    expect(screen.queryByText(DIRTY)).toBeNull();
  });

  it("Update branch lives in the strip, behind and conflict-free only", async () => {
    vi.mocked(gitCompareBranches).mockResolvedValue(behindBy(3));
    const view = renderView();
    const s = await findStrip("This branch is 3 commits behind main.");
    expect(
      screen.getAllByRole("button", { name: "Update branch" }),
    ).toHaveLength(1);
    expect(
      within(s).getByRole("button", { name: "Update branch" }),
    ).toBeInTheDocument();
    expect(
      within(footer()).queryByRole("button", { name: "Update branch" }),
    ).toBeNull();
    view.unmount();

    vi.mocked(gitConflictPreview).mockResolvedValue(
      preview("conflict", ["src/a.ts"]),
    );
    const conflicted = renderView();
    await findStrip(/will conflict/);
    await settle();
    expect(screen.queryByRole("button", { name: "Update branch" })).toBeNull();
    conflicted.unmount();

    vi.mocked(gitConflictPreview).mockResolvedValue(preview("clean"));
    records = [makePr({ base: "release", head: "main" })];
    renderView();
    await findStrip(/main is the repository's default branch/);
    expect(screen.queryByRole("button", { name: "Update branch" })).toBeNull();
  });

  it("a running update on this branch holds the button and shows in the strip", async () => {
    const user = userEvent.setup();
    vi.mocked(gitCompareBranches).mockResolvedValue(behindBy(3));
    renderView();
    await findStrip("This branch is 3 commits behind main.");
    await user.click(screen.getByRole("button", { name: "Update branch" }));
    await findStrip("Updating feature from main…");
    const button = screen.getByRole("button", { name: "Update branch" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAccessibleDescription("Updating this branch…");
    expect(gitUpdateBranchFrom).toHaveBeenCalledWith(REPO, "feature", "main");
  });

  /** Starts an update of this PR's branch, answers the write, and leaves the
   *  strip's two reads re-asked for the moved head but unanswered. */
  async function updateWithReadsInFlight(start: () => Promise<void>) {
    vi.mocked(gitCompareBranches).mockResolvedValue(behindBy(3));
    const write = deferred<{ outcome: "merge"; holder: null }>();
    vi.mocked(gitUpdateBranchFrom).mockReturnValue(write.promise);
    renderView();
    await findStrip("This branch is 3 commits behind main.");
    const previewRead = deferred<MergePreview>();
    const compareRead = deferred<BranchComparison>();
    vi.mocked(gitConflictPreview).mockReturnValue(previewRead.promise);
    vi.mocked(gitCompareBranches).mockReturnValue(compareRead.promise);
    await start();
    await findStrip("Updating feature from main…");
    await act(async () => write.resolve({ outcome: "merge", holder: null }));
    await settle();
    // The write's invalidation re-asked each read once; neither has answered.
    expect(gitConflictPreview).toHaveBeenCalledTimes(2);
    expect(gitCompareBranches).toHaveBeenCalledTimes(2);
    return { previewRead, compareRead };
  }

  it("a finished update holds the strip until its reads answer", async () => {
    const user = userEvent.setup();
    let button!: HTMLElement;
    await updateWithReadsInFlight(async () => {
      button = screen.getByRole("button", { name: "Update branch" });
      await user.click(button);
    });
    expect(strip()).toHaveTextContent("Updating feature from main…");
    expect(strip()).not.toHaveTextContent("behind");
    expect(screen.getByRole("button", { name: "Update branch" })).toBe(button);
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAccessibleDescription("Updating this branch…");
    expect(document.activeElement).toBe(button);
  });

  it("the strip turns clean once the reads land, focus on its root", async () => {
    const user = userEvent.setup();
    const { previewRead, compareRead } = await updateWithReadsInFlight(
      async () => {
        await user.click(screen.getByRole("button", { name: "Update branch" }));
      },
    );
    await act(async () => {
      previewRead.resolve(preview("clean"));
      compareRead.resolve(behindBy(0));
    });
    const s = await findStrip("No conflicts with main.");
    expect(screen.queryByRole("button", { name: "Update branch" })).toBeNull();
    expect(document.activeElement).toBe(s);
  });

  it("a finished update re-reads only its own PR's prediction", async () => {
    const user = userEvent.setup();
    vi.mocked(gitCompareBranches).mockResolvedValue(behindBy(3));
    vi.mocked(gitUpdateBranchFrom).mockResolvedValue({
      outcome: "merge",
      holder: null,
    });
    const view = renderView();
    await findStrip("This branch is 3 commits behind main.");
    // Another PR's prediction, read once and cached with no observer on screen.
    await act(() =>
      view.client.prefetchQuery({
        queryKey: conflictPreviewQueryKey(REPO, "main", "other"),
        queryFn: () => gitConflictPreview(REPO, "main", "other"),
        networkMode: "always",
      }),
    );
    vi.mocked(gitConflictPreview).mockClear();
    vi.mocked(gitCompareBranches).mockResolvedValue(behindBy(0));
    await user.click(screen.getByRole("button", { name: "Update branch" }));
    await findStrip("No conflicts with main.");
    await settle();
    const heads = vi.mocked(gitConflictPreview).mock.calls.map((c) => c[2]);
    expect(heads).toContain("feature");
    expect(heads).not.toContain("other");
    // Control: a repo-wide prefix refetch would have re-run the other PR's.
    await act(() =>
      view.client.refetchQueries({
        queryKey: conflictPreviewKey(REPO),
        type: "all",
      }),
    );
    expect(gitConflictPreview).toHaveBeenCalledWith(REPO, "main", "other");
  });

  it("an update started outside the strip leaves the window open, offering the update again", async () => {
    // The same write started outside the strip carries no hold, so this is the
    // window a press showed before: the retained behind answer, enabled.
    await updateWithReadsInFlight(async () => {
      act(() => startUpdate("feature", "main"));
    });
    expect(strip()).toHaveTextContent("This branch is 3 commits behind main.");
    expect(
      screen.getByRole("button", { name: "Update branch" }),
    ).not.toHaveAttribute("aria-disabled");
  });

  it("keeps the strip held while a dirty-tree update's stash-and-reapply runs, until its reads answer", async () => {
    vi.mocked(gitCompareBranches).mockResolvedValue(behindBy(3));
    vi.mocked(gitUpdateBranchFrom).mockRejectedValue(
      new Error(
        "error: Your local changes to the following files would be overwritten by merge: a.txt",
      ),
    );
    const compound = deferred<{ kind: "reapplied" }>();
    vi.mocked(gitMergeAutostash).mockReturnValue(compound.promise);
    const user = userEvent.setup();
    renderView();
    await findStrip("This branch is 3 commits behind main.");
    await settle();
    await user.click(screen.getByRole("button", { name: "Update branch" }));
    await user.click(
      await screen.findByRole("button", { name: /Stash and reapply/ }),
    );
    await waitFor(() =>
      expect(gitMergeAutostash).toHaveBeenCalledWith(REPO, "main"),
    );
    await findStrip("Updating feature from main…");
    const previewRead = deferred<MergePreview>();
    const compareRead = deferred<BranchComparison>();
    vi.mocked(gitConflictPreview).mockReturnValue(previewRead.promise);
    vi.mocked(gitCompareBranches).mockReturnValue(compareRead.promise);
    await act(async () => compound.resolve({ kind: "reapplied" }));
    await settle();
    // The compound settled; the strip's reads were re-asked and have not answered.
    expect(strip()).toHaveTextContent("Updating feature from main…");
    expect(strip()).not.toHaveTextContent("behind");
    const held = screen.getByRole("button", { name: "Update branch" });
    expect(held).toHaveAttribute("aria-disabled", "true");
    expect(held).toHaveAccessibleDescription("Updating this branch…");
    await act(async () => {
      previewRead.resolve(preview("clean"));
      compareRead.resolve(behindBy(0));
    });
    await findStrip("No conflicts with main.");
    expect(screen.queryByRole("button", { name: "Update branch" })).toBeNull();
  });

  it("keeps Merge held across a remount while an approval withdrawal saves", async () => {
    const user = userEvent.setup();
    records = [makePr({ approved: true })];
    vi.mocked(updateLocalPr).mockReturnValueOnce(new Promise(() => undefined));
    const view = renderView();
    await findStrip("No conflicts with main.");
    await settle();
    const merge = () => screen.getByRole("button", { name: "Merge" });
    expect(merge()).not.toHaveAttribute("aria-disabled");
    await user.click(
      within(footer()).getByRole("button", { name: "Approved" }),
    );
    await waitFor(() =>
      expect(merge()).toHaveAttribute("aria-disabled", "true"),
    );
    view.remount();
    await findStrip("No conflicts with main.");
    await settle();
    expect(merge()).toHaveAttribute("aria-disabled", "true");
    expect(merge()).toHaveAccessibleDescription("Saving…");
  });

  it("an update of other branches holds with their names", async () => {
    vi.mocked(gitCompareBranches).mockResolvedValue(behindBy(3));
    renderView();
    await findStrip("This branch is 3 commits behind main.");
    act(() => startUpdate("x", "y"));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Update branch" }),
      ).toHaveAccessibleDescription("Updating x from y…"),
    );
    expect(strip()).toHaveTextContent("This branch is 3 commits behind main.");
  });

  it.each([
    [
      "the default-branch read",
      () =>
        vi
          .mocked(gitDefaultBranch)
          .mockReturnValue(new Promise(() => undefined)),
      "Checking which branch is the default…",
    ],
    [
      "the branch rules",
      () =>
        vi
          .mocked(loadBranchRules)
          .mockReturnValue(new Promise(() => undefined)),
      "Checking this repository's promotion branches…",
    ],
  ])("%s still loading holds Update branch", async (_l, arrange, reason) => {
    vi.mocked(gitCompareBranches).mockResolvedValue(behindBy(3));
    arrange();
    renderView();
    await findStrip("This branch is 3 commits behind main.");
    const button = screen.getByRole("button", { name: "Update branch" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAccessibleDescription(reason);
  });

  it("a failed check offers Retry, which re-reads the failed reads", async () => {
    const user = userEvent.setup();
    vi.mocked(gitConflictPreview).mockRejectedValue(new Error("boom"));
    vi.mocked(gitCompareBranches).mockRejectedValue(new Error("boom"));
    renderView();
    await findStrip("Conflicts with main can't be checked right now.");
    expect(gitConflictPreview).toHaveBeenCalledTimes(1);
    expect(gitCompareBranches).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(gitConflictPreview).toHaveBeenCalledTimes(2));
    expect(gitCompareBranches).toHaveBeenCalledTimes(2);
  });

  it("Retry leaves an answered comparison alone, and behind shows the update", async () => {
    const user = userEvent.setup();
    vi.mocked(gitConflictPreview).mockRejectedValue(new Error("boom"));
    vi.mocked(gitCompareBranches).mockResolvedValue(behindBy(2));
    renderView();
    await findStrip(
      "Conflicts with main can't be checked right now. This branch is 2 commits behind main.",
    );
    expect(
      screen.getByRole("button", { name: "Update branch" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(gitConflictPreview).toHaveBeenCalledTimes(2));
    await settle();
    expect(gitCompareBranches).toHaveBeenCalledTimes(1);
  });

  it("a check that can't be made offers no Retry", async () => {
    vi.mocked(gitConflictPreview).mockResolvedValue(preview("unknown"));
    vi.mocked(gitCompareBranches).mockResolvedValue(behindBy(2));
    renderView();
    const s = await findStrip(
      "Conflicts with main can't be checked. This branch is 2 commits behind main.",
    );
    expect(s).not.toHaveTextContent("right now");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Update branch" }),
    ).toBeInTheDocument();
  });

  it("the palette's Update pull request branch runs only where the button would", async () => {
    vi.mocked(gitCompareBranches).mockResolvedValue(behindBy(3));
    const view = renderView();
    await findStrip("This branch is 3 commits behind main.");
    select("someone-else");
    await settle();
    // The write starts a microtask after the dispatch (react-query awaits
    // onMutate first), so each verdict waits the same settle before reading.
    act(() => void dispatchAction("pr-update-branch"));
    await settle();
    expect(gitUpdateBranchFrom).not.toHaveBeenCalled();
    select("a");
    await settle();
    // Positive twin: the same wait sees a call the dispatch did start.
    act(() => void dispatchAction("pr-update-branch"));
    await settle();
    expect(gitUpdateBranchFrom).toHaveBeenCalledWith(REPO, "feature", "main");
    view.unmount();

    vi.mocked(gitUpdateBranchFrom).mockClear();
    vi.mocked(gitConflictPreview).mockResolvedValue(
      preview("conflict", ["src/a.ts"]),
    );
    const conflicted = renderView();
    await findStrip(/will conflict/);
    act(() => void dispatchAction("pr-update-branch"));
    await settle();
    expect(gitUpdateBranchFrom).not.toHaveBeenCalled();
    conflicted.unmount();

    vi.mocked(gitConflictPreview).mockResolvedValue(preview("clean"));
    vi.mocked(gitDefaultBranch).mockReturnValue(new Promise(() => undefined));
    renderView();
    await findStrip("This branch is 3 commits behind main.");
    act(() => void dispatchAction("pr-update-branch"));
    await settle();
    expect(gitUpdateBranchFrom).not.toHaveBeenCalled();
  });

  it("a paused merge's takeover shows no strip", async () => {
    records = [
      makePr({
        pendingMerge: {
          base: "main",
          head: "feature",
          strategy: "merge",
          message: "m",
          worktreePath: "C:/wt",
          worktreeId: "wt",
          startedAt: "2026-01-01T00:00:00Z",
        } as LocalPr["pendingMerge"],
      }),
    ];
    renderView();
    await screen.findByText("Resolve view");
    await settle();
    expect(
      screen.queryByText(/No conflicts with|Checking for conflicts/),
    ).toBeNull();
  });

  it("a switched PR never shows the previous PR's conflict", async () => {
    records = [makePr(), makePr({ id: "b", title: "PR B", head: "other" })];
    vi.mocked(gitConflictPreview).mockImplementation(async (_r, _b, head) =>
      head === "feature"
        ? preview("conflict", ["src/clash.ts"])
        : preview("clean"),
    );
    const view = renderView();
    await findStrip(/will conflict/);
    expect(strip()).toHaveTextContent("clash.ts");
    view.showPr("b");
    expect(strip()?.textContent ?? "").not.toMatch(/will conflict|clash.ts/);
    await findStrip("No conflicts with main.");
    expect(strip()).not.toHaveTextContent("clash.ts");
  });
});

describe("LocalPrView Edit dialog", () => {
  it("says the linked-issue lines are added when you save", async () => {
    vi.mocked(forgeStatus).mockResolvedValue({
      provider: "github",
      installed: true,
      authenticated: true,
      repo: "owner/repo",
      host: "github.com",
      login: "me",
      capabilities: {},
      implemented: { issues: true },
    } as unknown as ForgeStatus);
    try {
      records = [makePr({ body: "Fix it\n\nCloses #3" })];
      const user = userEvent.setup();
      renderView();
      await screen.findByRole("heading", { name: /PR A/ });
      await waitFor(() => expect(forgeStatus).toHaveBeenCalled());
      await settle();
      await user.click(screen.getByRole("button", { name: "Edit" }));
      const dialog = await screen.findByRole("dialog");
      expect(
        await within(dialog).findByText(
          "Added to the description when you save.",
        ),
      ).toBeInTheDocument();
    } finally {
      vi.mocked(forgeStatus).mockImplementation(
        () => new Promise(() => undefined),
      );
    }
  });
});
