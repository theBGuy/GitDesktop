import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
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
  gitDiscardLocalPrUpdate,
  gitMergeLocalPr,
  gitStatus,
  gitUpdateLocalPrHead,
  type LocalPrUpdateOutcome,
} from "@/lib/git/api";
import { conflictPreviewKey } from "@/lib/git/queries";
import type {
  BranchComparison,
  CommitSummary,
  MergePreview,
  RepoStatus,
} from "@/lib/git/types";
import { dispatchAction } from "@/lib/hotkeys/hotkeys";
import {
  type LocalPr,
  listLocalPrs,
  type PendingUpdate,
  updateLocalPr,
} from "@/lib/pulls/local";
import { localPrKey } from "@/lib/pulls/queries";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useConfirm } from "@/lib/stores/confirm";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";
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
  gitUpdateLocalPrHead: vi.fn(),
  gitDiscardLocalPrUpdate: vi.fn(),
  gitMergeLocalPr: vi.fn(),
  gitBranchDiffFiles: vi.fn(async () => []),
  // The Files tab's fork-point read and the Review tab's key read.
  gitMergeBase: vi.fn(() => new Promise(() => undefined)),
  getSecret: vi.fn(async () => null),
  // The forge probe never answers: a local PR needs none of it.
  forgeStatus: vi.fn(() => new Promise(() => undefined)),
}));
// Publish renders only for a forge that can open pull requests; the probe above
// never answers, so this one capability is answered here.
vi.mock("@/lib/git/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/git/queries")>();
  return {
    ...actual,
    forgeFeatureReady: (...args: Parameters<typeof actual.forgeFeatureReady>) =>
      args[1] === "mrCreate" || actual.forgeFeatureReady(...args),
  };
});
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
// The real ResolveConflictsView renders; only its per-file editors are stubbed.
vi.mock("@/features/repository/ConflictFileView", () => ({
  ConflictFileView: () => <p>file editor</p>,
}));
vi.mock("@/features/repository/ConflictResolveView", () => ({
  ConflictResolveView: () => <p>ai editor</p>,
}));

const REPO = "C:/repo";
const OTHER_REPO = "C:/other";
const WT = "C:/data/gd-resolve-0123456789ab";
const HEADER = "Merging main into feat. Finishing updates feat.";
const PREPARING = "Preparing to resolve conflicts…";
const UNFINISHED = "Finish or discard the unfinished conflict resolution first";
const RESUME = "An unfinished conflict resolution exists for this PR.";
const DIRTY = "Commit or stash your changes to update the current branch";
const CONFLICTS_TOAST =
  "Updating feat from main has conflicts — resolve them to finish";

const commit = (i: number) =>
  ({
    hash: `c${i}`,
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

const UPDATE: PendingUpdate = {
  base: "main",
  head: "feat",
  worktreePath: WT,
  worktreeId: "0123456789ab",
  opId: "op-1",
  journalRepo: REPO,
  startedAt: "2026-01-01T00:00:00Z",
};

const conflictsOutcome: LocalPrUpdateOutcome = {
  status: "conflicts",
  conflicts: ["src/a.ts"],
  headTip: "abc1234",
  worktreePath: WT,
  worktreeId: "0123456789ab",
  opId: "op-1",
  journalRepo: REPO,
};
const updatedOutcome: LocalPrUpdateOutcome = {
  status: "updated",
  conflicts: [],
  headTip: "def5678",
  worktreePath: null,
  worktreeId: null,
  opId: "op-1",
  journalRepo: REPO,
};

function makePr(over: Partial<LocalPr> = {}): LocalPr {
  return {
    id: "a",
    title: "PR A",
    body: "",
    base: "main",
    head: "feat",
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
const worktreeStatus = {
  branch: null,
  entries: [{ path: "src/a.ts", staged: null, unstaged: "conflicted" }],
} as unknown as RepoStatus;

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}

let records: LocalPr[] = [];
let repoStatus: RepoStatus = statusOn("main", false);

function select(id: string) {
  act(() => useUiStore.setState({ selectedPr: { kind: "local", id } }));
}

function renderView(id = "a") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const ui = (pid: string, repo: string) => (
    <QueryClientProvider client={client}>
      <LocalPrView repoPath={repo} id={pid} />
    </QueryClientProvider>
  );
  select(id);
  const result = render(ui(id, REPO));
  return {
    ...result,
    client,
    showPr: (pid: string) => {
      select(pid);
      result.rerender(ui(pid, REPO));
    },
    showRepo: (repo: string) => result.rerender(ui(id, repo)),
    /** The list re-read a second window or a refocus would bring. */
    arrive: async (next: LocalPr[]) => {
      records = next;
      await act(() => client.invalidateQueries({ queryKey: localPrKey(REPO) }));
    },
  };
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 30)));

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

const stripButton = (name: string | RegExp) =>
  within(strip() as HTMLElement).getByRole("button", { name });

const footerButtons = () => [
  screen.getByRole("button", { name: "Merge" }),
  screen.getByRole("button", { name: "Close" }),
  screen.getByRole("button", { name: /^Publish to/ }),
];

const realAsk = useConfirm.getState().ask;

beforeEach(() => {
  vi.clearAllMocks();
  records = [makePr()];
  repoStatus = statusOn("main", false);
  useUiStore.setState({ repoPath: REPO, selectedPr: null });
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(listLocalPrs).mockImplementation(async (repo) =>
    repo === REPO ? records : [],
  );
  vi.mocked(updateLocalPr).mockImplementation(async (_repo, id, mutate) => {
    records = records.map((p) => (p.id === id ? mutate(p) : p));
    return records.find((p) => p.id === id) as LocalPr;
  });
  vi.mocked(loadBranchRules).mockResolvedValue(EMPTY_BRANCH_RULES);
  vi.mocked(loadSharedBranchRules).mockResolvedValue(EMPTY_BRANCH_RULES);
  vi.mocked(gitConflictPreview).mockResolvedValue(
    preview("conflict", ["src/a.ts"]),
  );
  vi.mocked(gitCompareBranches).mockResolvedValue(behindBy(2));
  vi.mocked(gitDefaultBranch).mockResolvedValue("main");
  vi.mocked(gitStatus).mockImplementation(async (path) =>
    path === WT ? worktreeStatus : repoStatus,
  );
  vi.mocked(gitUpdateLocalPrHead).mockReturnValue(new Promise(() => undefined));
});

afterEach(() => {
  useConfirm.setState({ ask: realAsk });
});

afterAll(() => expect(unmockedCommands).toEqual([]));

describe("LocalPrView: resolving conflicts before approval", () => {
  it("V1: Resolve conflicts starts once and holds the PR's other actions while preparing", async () => {
    const user = userEvent.setup();
    renderView();
    await findStrip(/will conflict/);
    await settle();
    await user.click(stripButton("Resolve conflicts"));
    expect(gitUpdateLocalPrHead).toHaveBeenCalledWith(REPO, "main", "feat");
    await waitFor(() =>
      expect(stripButton("Preparing…")).toHaveAttribute(
        "aria-disabled",
        "true",
      ),
    );
    for (const b of footerButtons()) {
      expect(b).toHaveAttribute("aria-disabled", "true");
      expect(b).toHaveAccessibleDescription(PREPARING);
    }
    await user.click(stripButton("Preparing…"));
    act(() => void dispatchAction("pr-resolve-conflicts"));
    await settle();
    expect(gitUpdateLocalPrHead).toHaveBeenCalledTimes(1);
  });

  it("V2: a conflicted start opens the editor once the list shows it, focus on the sink", async () => {
    const user = userEvent.setup();
    const command = deferred<LocalPrUpdateOutcome>();
    vi.mocked(gitUpdateLocalPrHead).mockReturnValue(command.promise);
    renderView();
    await findStrip(/will conflict/);
    await settle();
    const listRead = deferred<LocalPr[]>();
    await user.click(stripButton("Resolve conflicts"));
    vi.mocked(listLocalPrs).mockReturnValueOnce(listRead.promise);
    await act(async () => command.resolve(conflictsOutcome));
    await settle();
    // The record is written, but the list on screen has not re-read it yet, so
    // the start is still pending.
    expect(toast.warning).not.toHaveBeenCalled();
    expect(updateLocalPr).toHaveBeenCalledTimes(1);
    expect(stripButton("Preparing…")).toHaveAttribute("aria-disabled", "true");
    await user.click(stripButton("Preparing…"));
    expect(gitUpdateLocalPrHead).toHaveBeenCalledTimes(1);
    await act(async () => listRead.resolve(records));
    await screen.findByText(/Finishing updates/);
    expect(toast.warning).toHaveBeenCalledWith(CONFLICTS_TOAST);
    expect(screen.getByText(/Finishing updates/)).toHaveTextContent(HEADER);
    expect(strip()).toBeNull();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toHaveAccessibleName("Conflict editor");
  });

  it("AM6: a record that lands while the start is pending holds Discard and Continue", async () => {
    const user = userEvent.setup();
    const view = renderView();
    await findStrip(/will conflict/);
    await settle();
    await user.click(stripButton("Resolve conflicts"));
    await view.arrive([makePr({ pendingUpdate: { ...UPDATE } })]);
    await findStrip(RESUME);
    for (const name of ["Discard", "Continue resolving"]) {
      expect(stripButton(name)).toHaveAttribute("aria-disabled", "true");
      expect(stripButton(name)).toHaveAccessibleDescription(PREPARING);
    }
  });

  it("V3: a clean start updates in place and holds the strip until its reads answer", async () => {
    const user = userEvent.setup();
    const command = deferred<LocalPrUpdateOutcome>();
    vi.mocked(gitUpdateLocalPrHead).mockReturnValue(command.promise);
    records = [makePr({ approved: true })];
    renderView();
    await findStrip(/will conflict/);
    await settle();
    await user.click(stripButton("Resolve conflicts"));
    const previewRead = deferred<MergePreview>();
    const compareRead = deferred<BranchComparison>();
    const listRead = deferred<LocalPr[]>();
    vi.mocked(gitConflictPreview).mockReturnValue(previewRead.promise);
    vi.mocked(gitCompareBranches).mockReturnValue(compareRead.promise);
    vi.mocked(listLocalPrs).mockReturnValueOnce(listRead.promise);
    await act(async () => command.resolve(updatedOutcome));
    await settle();
    expect(records[0].approved).toBe(false);
    // The preview and list re-reads are still out: the start has not settled.
    expect(stripButton("Preparing…")).toHaveAttribute("aria-disabled", "true");
    expect(toast.success).not.toHaveBeenCalled();
    await act(async () => previewRead.resolve(preview("clean")));
    await settle();
    // The preview answered, but the list on screen has not: the start is still
    // pending, so nothing in the strip is offered yet.
    expect(listLocalPrs).toHaveBeenCalledTimes(2);
    for (const b of within(strip() as HTMLElement).queryAllByRole("button"))
      expect(b).toHaveAttribute("aria-disabled", "true");
    expect(toast.success).not.toHaveBeenCalled();
    await act(async () => listRead.resolve(records));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Updated feat from main. Approval cleared because the branch changed.",
      ),
    );
    // The comparison still holds the old head's answer: no stale "behind" offer.
    const s = await findStrip("Updating feat from main…");
    for (const b of within(s).queryAllByRole("button"))
      expect(b).toHaveAttribute("aria-disabled", "true");
    await act(async () => compareRead.resolve(behindBy(0)));
    await findStrip("No conflicts with main.");
    expect(screen.queryByText(/Finishing updates/)).toBeNull();
  });

  it("V3: an unapproved clean start says nothing of approval", async () => {
    const user = userEvent.setup();
    vi.mocked(gitUpdateLocalPrHead).mockResolvedValue(updatedOutcome);
    renderView();
    await findStrip(/will conflict/);
    await settle();
    vi.mocked(gitConflictPreview).mockResolvedValue(preview("clean"));
    vi.mocked(gitCompareBranches).mockResolvedValue(behindBy(0));
    await user.click(stripButton("Resolve conflicts"));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Updated feat from main"),
    );
    await findStrip("No conflicts with main.");
  });

  it("V4: a failed start toasts and leaves the strip offering Resolve again", async () => {
    const user = userEvent.setup();
    const err = new Error("Updating feat from main failed; feat is unchanged.");
    vi.mocked(gitUpdateLocalPrHead).mockRejectedValue(err);
    renderView();
    await findStrip(/will conflict/);
    await settle();
    await user.click(stripButton("Resolve conflicts"));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(err));
    await settle();
    expect(stripButton("Resolve conflicts")).not.toHaveAttribute(
      "aria-disabled",
    );
    expect(strip()).toHaveTextContent(/will conflict/);
    expect(updateLocalPr).not.toHaveBeenCalled();
  });

  it("V5: a dirty checked-out head holds the start, but not Discard or Continue", async () => {
    repoStatus = statusOn("feat", true);
    const view = renderView();
    await findStrip(/will conflict/);
    await waitFor(() =>
      expect(stripButton("Resolve conflicts")).toHaveAccessibleDescription(
        "Commit or stash your changes to update the current branch",
      ),
    );
    expect(stripButton("Resolve conflicts")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await view.arrive([makePr({ pendingUpdate: { ...UPDATE } })]);
    await findStrip(RESUME);
    for (const name of ["Discard", "Continue resolving"])
      expect(stripButton(name)).not.toHaveAttribute("aria-disabled");
  });

  it("V6: a promotion PR offers no start, yet an existing update stays dismissable", async () => {
    records = [makePr({ base: "release", head: "main" })];
    const view = renderView();
    await findStrip(/Approve, then Merge to resolve the conflicts/);
    await settle();
    expect(
      within(strip() as HTMLElement).queryByRole("button", {
        name: "Resolve conflicts",
      }),
    ).toBeNull();
    act(() => void dispatchAction("pr-resolve-conflicts"));
    await settle();
    expect(gitUpdateLocalPrHead).not.toHaveBeenCalled();
    await view.arrive([
      makePr({
        base: "release",
        head: "main",
        pendingUpdate: { ...UPDATE, base: "release", head: "main" },
      }),
    ]);
    await findStrip(RESUME);
    expect(stripButton("Discard")).toBeInTheDocument();
    expect(stripButton("Continue resolving")).toBeInTheDocument();
  });

  it("V7 / AM1: entering a PR with an unfinished update opens the editor", async () => {
    records = [makePr({ pendingUpdate: { ...UPDATE } })];
    renderView();
    const sentence = await screen.findByText(/Finishing updates/);
    expect(sentence).toHaveTextContent(HEADER);
    expect(
      screen.getByRole("button", { name: "Back to PR" }),
    ).toBeInTheDocument();
    expect(strip()).toBeNull();
  });

  it("V7: a record that arrives on screen shows the resume arm; Continue opens the editor", async () => {
    const user = userEvent.setup();
    const view = renderView();
    await findStrip(/will conflict/);
    await view.arrive([makePr({ pendingUpdate: { ...UPDATE } })]);
    await findStrip(RESUME);
    for (const b of footerButtons()) {
      expect(b).toHaveAttribute("aria-disabled", "true");
      expect(b).toHaveAccessibleDescription(UNFINISHED);
    }
    await user.click(stripButton("Continue resolving"));
    expect((await screen.findByText(/Finishing updates/)).textContent).toBe(
      HEADER,
    );
  });

  it("V8: a start that settles after a PR switch writes its own PR and opens nothing", async () => {
    const command = deferred<LocalPrUpdateOutcome>();
    vi.mocked(gitUpdateLocalPrHead).mockReturnValue(command.promise);
    records = [makePr(), makePr({ id: "b", title: "PR B", head: "other" })];
    const user = userEvent.setup();
    const view = renderView();
    await findStrip(/will conflict/);
    await settle();
    await user.click(stripButton("Resolve conflicts"));
    view.showPr("b");
    await screen.findByRole("heading", { name: /PR B/ });
    await act(async () => command.resolve(conflictsOutcome));
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(CONFLICTS_TOAST),
    );
    expect(vi.mocked(updateLocalPr).mock.calls[0].slice(0, 2)).toEqual([
      REPO,
      "a",
    ]);
    await settle();
    expect(records[0].pendingUpdate?.worktreeId).toBe("0123456789ab");
    expect(screen.queryByText(/Finishing updates/)).toBeNull();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    view.showPr("a");
    expect((await screen.findByText(/Finishing updates/)).textContent).toBe(
      HEADER,
    );
  });

  it("V8: a start that settles after a repository switch names that repository", async () => {
    const command = deferred<LocalPrUpdateOutcome>();
    vi.mocked(gitUpdateLocalPrHead).mockReturnValue(command.promise);
    const user = userEvent.setup();
    const view = renderView();
    await findStrip(/will conflict/);
    await settle();
    await user.click(stripButton("Resolve conflicts"));
    act(() => useUiStore.setState({ repoPath: OTHER_REPO }));
    view.showRepo(OTHER_REPO);
    await act(async () => command.resolve(conflictsOutcome));
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        "Updating feat from main in repo has conflicts — resolve them to finish",
      ),
    );
    expect(vi.mocked(updateLocalPr).mock.calls[0].slice(0, 2)).toEqual([
      REPO,
      "a",
    ]);
    expect(screen.queryByText(/Finishing updates/)).toBeNull();
  });

  it("V9: a paused merge and an update exclude each other", async () => {
    records = [
      makePr({
        approved: true,
        pendingMerge: {
          base: "main",
          head: "feat",
          strategy: "merge",
          message: "m",
          worktreePath: WT,
          worktreeId: "0123456789ab",
          opId: "op-m",
          startedAt: "2026-01-01T00:00:00Z",
        },
      }),
    ];
    const merge = renderView();
    await screen.findByText(/^Resolving conflicts/);
    act(() => void dispatchAction("pr-resolve-conflicts"));
    await settle();
    expect(gitUpdateLocalPrHead).not.toHaveBeenCalled();
    merge.unmount();

    const user = userEvent.setup();
    records = [makePr({ approved: true })];
    const view = renderView();
    await findStrip(/will conflict/);
    await view.arrive([
      makePr({ approved: true, pendingUpdate: { ...UPDATE } }),
    ]);
    await findStrip(RESUME);
    const button = screen.getByRole("button", { name: "Merge" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAccessibleDescription(UNFINISHED);
    await user.click(button);
    await settle();
    expect(
      screen.queryByRole("menuitem", { name: "Create a merge commit" }),
    ).toBeNull();
    expect(gitMergeLocalPr).not.toHaveBeenCalled();
  });

  it("V10: the palette and the keyboard start it only for the selected PR", async () => {
    const user = userEvent.setup();
    const view = renderView();
    await findStrip(/will conflict/);
    await settle();
    select("someone-else");
    await settle();
    act(() => void dispatchAction("pr-resolve-conflicts"));
    await settle();
    expect(gitUpdateLocalPrHead).not.toHaveBeenCalled();
    select("a");
    await settle();
    act(() => void dispatchAction("pr-resolve-conflicts"));
    await settle();
    expect(gitUpdateLocalPrHead).toHaveBeenCalledWith(REPO, "main", "feat");
    view.unmount();

    vi.mocked(gitUpdateLocalPrHead).mockClear();
    renderView();
    await findStrip(/will conflict/);
    await settle();
    stripButton("Resolve conflicts").focus();
    await user.keyboard("{Enter}");
    expect(gitUpdateLocalPrHead).toHaveBeenCalledTimes(1);
  });

  it("V11: a closed PR still carrying an update shows the closed view", async () => {
    records = [makePr({ status: "closed", pendingUpdate: { ...UPDATE } })];
    renderView();
    await screen.findByRole("button", { name: "Reopen" });
    await settle();
    expect(screen.queryByText(/Finishing updates/)).toBeNull();
    expect(strip()).toBeNull();
  });

  it("V12: the strip's Discard confirms, discards, and offers Resolve again", async () => {
    const user = userEvent.setup();
    const ask = vi.fn(async () => true);
    useConfirm.setState({ ask });
    vi.mocked(gitDiscardLocalPrUpdate).mockResolvedValue({
      status: "discarded",
    });
    const view = renderView();
    await findStrip(/will conflict/);
    await view.arrive([makePr({ pendingUpdate: { ...UPDATE } })]);
    await findStrip(RESUME);
    await user.click(stripButton("Discard"));
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Discard this update?" }),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Update discarded"),
    );
    expect(gitDiscardLocalPrUpdate).toHaveBeenCalledWith(
      REPO,
      "feat",
      WT,
      "0123456789ab",
      "op-1",
      REPO,
    );
    await findStrip(/will conflict/);
    expect(stripButton("Resolve conflicts")).toBeInTheDocument();
  });

  it("V13: Back to PR returns to the PR, keeps the update, and re-entry reopens it", async () => {
    const user = userEvent.setup();
    records = [
      makePr({ pendingUpdate: { ...UPDATE } }),
      makePr({ id: "b", title: "PR B", head: "other" }),
    ];
    const view = renderView();
    await screen.findByText(/Finishing updates/);
    await user.click(screen.getByRole("button", { name: "Back to PR" }));
    await findStrip(RESUME);
    expect(stripButton("Discard")).toBeInTheDocument();
    expect(stripButton("Continue resolving")).toBeInTheDocument();
    expect(document.activeElement).toHaveAccessibleName("Pull request");
    expect(gitUpdateLocalPrHead).not.toHaveBeenCalled();
    expect(gitDiscardLocalPrUpdate).not.toHaveBeenCalled();
    view.showPr("b");
    await screen.findByRole("heading", { name: /PR B/ });
    view.showPr("a");
    expect((await screen.findByText(/Finishing updates/)).textContent).toBe(
      HEADER,
    );
  });

  it("V14: a tab pick during the start leaves the editor closed", async () => {
    const user = userEvent.setup();
    const command = deferred<LocalPrUpdateOutcome>();
    vi.mocked(gitUpdateLocalPrHead).mockReturnValue(command.promise);
    renderView();
    await findStrip(/will conflict/);
    await settle();
    await user.click(stripButton("Resolve conflicts"));
    await user.click(screen.getByRole("button", { name: /^Commits/ }));
    await act(async () => command.resolve(conflictsOutcome));
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(CONFLICTS_TOAST),
    );
    await findStrip(RESUME);
    expect(screen.queryByText(/Finishing updates/)).toBeNull();
  });

  it("V14: the composer's draft survives the editor and Back to PR", async () => {
    const user = userEvent.setup();
    vi.mocked(gitUpdateLocalPrHead).mockResolvedValue(conflictsOutcome);
    renderView();
    await findStrip(/will conflict/);
    await settle();
    await user.type(
      screen.getByRole("textbox", { name: "Leave a note" }),
      "draft note",
    );
    await user.click(stripButton("Resolve conflicts"));
    await screen.findByText(/Finishing updates/);
    await user.click(screen.getByRole("button", { name: "Back to PR" }));
    await findStrip(RESUME);
    expect(screen.getByRole("textbox", { name: "Leave a note" })).toHaveValue(
      "draft note",
    );
  });

  it("V15: an approved PR's Resolve carries the approval notice; the resume arm never does", async () => {
    const note = "Merges main into feat. Finishing clears the approval.";
    records = [makePr({ approved: true })];
    const view = renderView();
    await findStrip(/will conflict/);
    await waitFor(() =>
      expect(stripButton("Resolve conflicts")).toHaveAccessibleDescription(
        note,
      ),
    );
    expect(stripButton("Resolve conflicts")).toHaveAttribute("title", note);
    await view.arrive([
      makePr({ approved: true, pendingUpdate: { ...UPDATE } }),
    ]);
    await findStrip(RESUME);
    for (const name of ["Discard", "Continue resolving"]) {
      expect(stripButton(name)).not.toHaveAttribute("title");
      expect(stripButton(name)).not.toHaveAccessibleDescription(note);
    }
    view.unmount();

    records = [makePr()];
    renderView();
    await findStrip(/will conflict/);
    await settle();
    expect(stripButton("Resolve conflicts")).not.toHaveAttribute("title");
    expect(stripButton("Resolve conflicts")).not.toHaveAccessibleDescription(
      note,
    );
  });

  it("V15: an approved PR whose start is held shows its reason, never the notice", async () => {
    records = [makePr({ approved: true })];
    repoStatus = statusOn("feat", true);
    renderView();
    await findStrip(/will conflict/);
    await waitFor(() =>
      expect(stripButton("Resolve conflicts")).toHaveAccessibleDescription(
        DIRTY,
      ),
    );
    expect(stripButton("Resolve conflicts")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(stripButton("Resolve conflicts")).not.toHaveAttribute("title");
  });

  it("V1: two activations before the start's cache notice lands start once", async () => {
    renderView();
    await findStrip(/will conflict/);
    await settle();
    act(() => void dispatchAction("pr-resolve-conflicts"));
    act(() => void dispatchAction("pr-resolve-conflicts"));
    await settle();
    expect(gitUpdateLocalPrHead).toHaveBeenCalledTimes(1);
  });

  it("D20: a head that turns dirty while preparing keeps the start's own reason", async () => {
    const user = userEvent.setup();
    repoStatus = statusOn("feat", false);
    const view = renderView();
    await findStrip(/will conflict/);
    await settle();
    await user.click(stripButton("Resolve conflicts"));
    await waitFor(() =>
      expect(stripButton("Preparing…")).toHaveAttribute(
        "aria-disabled",
        "true",
      ),
    );
    repoStatus = statusOn("feat", true);
    const reads = vi.mocked(gitStatus).mock.calls.length;
    // Not awaited: the forge probe under the same prefix never answers.
    act(() => void view.client.invalidateQueries({ queryKey: ["repo", REPO] }));
    await waitFor(() =>
      expect(vi.mocked(gitStatus).mock.calls.length).toBeGreaterThan(reads),
    );
    await settle();
    expect(stripButton("Preparing…")).toHaveAccessibleDescription("Preparing…");
  });

  it("B1: another PR's start holds this PR's Resolve with its reason", async () => {
    const user = userEvent.setup();
    records = [makePr(), makePr({ id: "b", title: "PR B", head: "other" })];
    const view = renderView("b");
    await findStrip(/will conflict/);
    await settle();
    await user.click(stripButton("Resolve conflicts"));
    view.showPr("a");
    await screen.findByRole("heading", { name: /PR A/ });
    await findStrip(/will conflict/);
    await waitFor(() =>
      expect(stripButton("Resolve conflicts")).toHaveAccessibleDescription(
        "Another conflict resolution is being prepared…",
      ),
    );
    expect(stripButton("Resolve conflicts")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("B1: a discard in flight holds Continue resolving with its reason", async () => {
    const user = userEvent.setup();
    useConfirm.setState({ ask: vi.fn(async () => true) });
    vi.mocked(gitDiscardLocalPrUpdate).mockReturnValue(
      new Promise(() => undefined),
    );
    const view = renderView();
    await findStrip(/will conflict/);
    await view.arrive([makePr({ pendingUpdate: { ...UPDATE } })]);
    await findStrip(RESUME);
    await user.click(stripButton("Discard"));
    await waitFor(() =>
      expect(stripButton("Continue resolving")).toHaveAccessibleDescription(
        "Discarding this update…",
      ),
    );
    expect(stripButton("Continue resolving")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("C2: Update branch, offered over a failed prediction, holds while preparing", async () => {
    const user = userEvent.setup();
    const view = renderView();
    await findStrip(/will conflict/);
    await settle();
    await user.click(stripButton("Resolve conflicts"));
    vi.mocked(gitConflictPreview).mockRejectedValue(new Error("merge-tree"));
    await act(() =>
      view.client.invalidateQueries({ queryKey: conflictPreviewKey(REPO) }),
    );
    await waitFor(() =>
      expect(stripButton(/^Update branch/)).toHaveAccessibleDescription(
        PREPARING,
      ),
    );
    expect(stripButton(/^Update branch/)).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("V8: a start that settles while another PR's editor is open leaves it open", async () => {
    const command = deferred<LocalPrUpdateOutcome>();
    vi.mocked(gitUpdateLocalPrHead).mockReturnValue(command.promise);
    const otherUpdate: PendingUpdate = {
      ...UPDATE,
      head: "other",
      worktreePath: "C:/data/gd-resolve-fedcba987654",
      worktreeId: "fedcba987654",
    };
    records = [
      makePr(),
      makePr({
        id: "b",
        title: "PR B",
        head: "other",
        pendingUpdate: otherUpdate,
      }),
    ];
    const user = userEvent.setup();
    const view = renderView();
    await findStrip(/will conflict/);
    await settle();
    await user.click(stripButton("Resolve conflicts"));
    view.showPr("b");
    const header = "Merging main into other. Finishing updates other.";
    expect((await screen.findByText(/Finishing updates/)).textContent).toBe(
      header,
    );
    await act(async () => command.resolve(conflictsOutcome));
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(CONFLICTS_TOAST),
    );
    await settle();
    expect(screen.getByText(/Finishing updates/).textContent).toBe(header);
  });

  it("CS1: a clean start whose PR was left before its reads answered holds on return", async () => {
    const user = userEvent.setup();
    const command = deferred<LocalPrUpdateOutcome>();
    vi.mocked(gitUpdateLocalPrHead).mockReturnValue(command.promise);
    records = [makePr(), makePr({ id: "b", title: "PR B", head: "other" })];
    const view = renderView();
    await findStrip(/will conflict/);
    await settle();
    await user.click(stripButton("Resolve conflicts"));
    view.showPr("b");
    await screen.findByRole("heading", { name: /PR B/ });
    await findStrip(/will conflict/);
    // A's own reads answer only when the test says; B's answer at once.
    const previewRead = deferred<MergePreview>();
    const compareRead = deferred<BranchComparison>();
    vi.mocked(gitConflictPreview).mockImplementation((_repo, _base, head) =>
      head === "feat"
        ? previewRead.promise
        : Promise.resolve(preview("conflict", ["src/a.ts"])),
    );
    vi.mocked(gitCompareBranches).mockImplementation((_repo, _base, head) =>
      head === "feat" ? compareRead.promise : Promise.resolve(behindBy(2)),
    );
    await act(async () => command.resolve(updatedOutcome));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Updated feat from main"),
    );
    await settle();
    view.showPr("a");
    await screen.findByRole("heading", { name: /PR A/ });
    const s = await findStrip("Updating feat from main…");
    for (const b of within(s).queryAllByRole("button"))
      expect(b).toHaveAttribute("aria-disabled", "true");
    // Control: A's cached prediction is still the pre-update conflict, which
    // without the hold would offer Resolve conflicts enabled.
    expect(
      view.client.getQueryData([...conflictPreviewKey(REPO), "main", "feat"]),
    ).toEqual(preview("conflict", ["src/a.ts"]));
    await act(async () => {
      previewRead.resolve(preview("clean"));
      compareRead.resolve(behindBy(0));
    });
    await findStrip("No conflicts with main.");
  });
});
