import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { toast } from "sonner";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { HistoryPanel } from "@/features/history/HistoryPanel";
import {
  gitCommitDetails,
  gitLog,
  gitOpState,
  gitStatus,
  gitUndoCommit,
  gitUnpushedCount,
  gitUnpushedMessages,
  type UnpushedCount,
} from "@/lib/git/api";
import { repoKeys } from "@/lib/git/queries";
import type { BranchHead, CommitSummary, RepoOpState } from "@/lib/git/types";
import { dispatchAction } from "@/lib/hotkeys/hotkeys";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";

vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitLog: vi.fn(),
  gitStatus: vi.fn(),
  gitOpState: vi.fn(),
  gitCommitDetails: vi.fn(),
  gitUndoCommit: vi.fn(),
  gitUnpushedCount: vi.fn(),
  gitUnpushedMessages: vi.fn(),
}));
vi.mock("sonner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("sonner")>()),
  toast: Object.assign(vi.fn(), {
    info: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    message: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

const REPO = "/repo";
const UNDO_MID_PICK =
  "A cherry-pick or revert is in progress — finish or abort it first; nothing was undone.";
const UNDO_MID_MERGE =
  "A merge is in progress — finish or abort it first; nothing was undone.";

/** Non-zero hex, so the oid-width guard never reads a zero run. */
const HASH_HEAD = "abcdef0123".repeat(4);
const HASH_PARENT = `b${HASH_HEAD.slice(1)}`;

const summary = (hash: string, subject: string): CommitSummary => ({
  hash,
  subject,
  author: "Ada",
  authorEmail: "",
  date: "2026-11-01T10:00:00Z",
  tags: [],
  isMerge: false,
});

/** Serves `git_status` with `main` one commit ahead of origin/main, plus
 *  `over`. */
function setBranch(over: Partial<BranchHead>) {
  vi.mocked(gitStatus).mockResolvedValue({
    branch: {
      name: "main",
      detached: false,
      oid: HASH_HEAD,
      upstream: "origin/main",
      ahead: 1,
      behind: 0,
      upstreamGone: false,
      upstreamRemote: "origin",
      upstreamBranch: "main",
      pushNameMismatch: false,
      upstreamIsRemoteDefault: true,
      pushRemote: null,
      pushBranch: null,
      ...over,
    },
    entries: [],
  });
}

/** A branch with no upstream, so the panel counts through git_unpushed_count. */
const NO_UPSTREAM: Partial<BranchHead> = {
  name: "feature",
  upstream: null,
  ahead: 0,
  upstreamRemote: null,
  upstreamBranch: null,
  upstreamIsRemoteDefault: false,
};

const IDLE: RepoOpState = {
  merging: false,
  rebasing: false,
  cherryPicking: false,
  reverting: false,
  editPaused: false,
  rebaseStop: null,
};

// jsdom lays nothing out, so the virtualized commit list (@tanstack/virtual-core
// sizes its viewport from the scroll element's clientWidth/clientHeight) reads
// a 0-height viewport and paints no rows; a fixed client size gives it one.
const CLIENT_SIZE = { clientWidth: 800, clientHeight: 600 } as const;
beforeAll(() => {
  for (const [k, v] of Object.entries(CLIENT_SIZE)) {
    Object.defineProperty(HTMLElement.prototype, k, {
      configurable: true,
      get: () => v,
    });
  }
});
// Element.prototype owns the real getters, so dropping the override restores them.
afterAll(() => {
  for (const k of Object.keys(CLIENT_SIZE)) {
    Reflect.deleteProperty(HTMLElement.prototype, k);
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadSettings).mockImplementation(async () =>
    structuredClone(DEFAULT_SETTINGS),
  );
  vi.mocked(gitLog).mockResolvedValue([
    summary(HASH_HEAD, "Add the parser"),
    summary(HASH_PARENT, "Start the project"),
  ]);
  // One commit ahead of its upstream: the HEAD commit is undoable.
  setBranch({});
  vi.mocked(gitUnpushedMessages).mockResolvedValue([
    { hash: HASH_HEAD, message: "Add the parser" },
  ]);
  vi.mocked(gitCommitDetails).mockResolvedValue({
    hash: HASH_HEAD,
    subject: "Add the parser",
    body: "",
    author: "Ada",
    authorEmail: "",
    date: "2026-11-01T10:00:00Z",
  });
  vi.mocked(gitUndoCommit).mockResolvedValue(undefined);
  useUiStore.setState({ repoPath: REPO });
});

// The last render's client, for tests that refetch one read.
let client: QueryClient;

async function renderPanel(op: Partial<RepoOpState>) {
  vi.mocked(gitOpState).mockResolvedValue({ ...IDLE, ...op });
  client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(settingsKeys.settings, structuredClone(DEFAULT_SETTINGS));
  const { container } = render(
    <QueryClientProvider client={client}>
      <HistoryPanel repoPath={REPO} />
    </QueryClientProvider>,
  );
  // The gates read the log, the status and the op state together.
  await waitFor(() =>
    expect(client.getQueryData(repoKeys.opState(REPO))).toBeDefined(),
  );
  await waitFor(() =>
    expect(
      container.querySelector(`[data-hash="${HASH_HEAD}"]`),
    ).not.toBeNull(),
  );
  return container;
}

describe("Undo during a stopped operation", () => {
  it.each([
    ["cherry-pick", { cherryPicking: true }, UNDO_MID_PICK],
    ["revert", { reverting: true }, UNDO_MID_PICK],
    ["merge", { merging: true }, UNDO_MID_MERGE],
    [
      "pick inside a merge",
      { merging: true, cherryPicking: true },
      UNDO_MID_PICK,
    ],
  ])(
    "the shortcut toasts the %s refusal before reading the commit",
    async (_name, op, sentence) => {
      await renderPanel(op);
      dispatchAction("undo-commit");
      await waitFor(() => expect(toast.info).toHaveBeenCalledWith(sentence));
      expect(gitCommitDetails).not.toHaveBeenCalled();
      expect(gitUndoCommit).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["mid-rebase", { rebasing: true, editPaused: true, rebaseStop: "edit" }],
    ["with nothing in progress", {}],
  ] as const)("the shortcut undoes %s", async (_name, op) => {
    await renderPanel(op);
    dispatchAction("undo-commit");
    await waitFor(() => expect(gitUndoCommit).toHaveBeenCalled());
    expect(gitCommitDetails).toHaveBeenCalledWith(REPO, HASH_HEAD);
    expect(toast.info).not.toHaveBeenCalledWith(UNDO_MID_PICK);
    expect(toast.info).not.toHaveBeenCalledWith(UNDO_MID_MERGE);
  });

  it.each([
    [
      "cherry-pick",
      { cherryPicking: true },
      " (finish or abort the cherry-pick or revert first)",
    ],
    ["merge", { merging: true }, " (finish or abort the merge first)"],
  ])("the menu row holds with the %s reason", async (_name, op, hint) => {
    const container = await renderPanel(op);
    const row = container.querySelector(`[data-hash="${HASH_HEAD}"]`);
    if (!row) throw new Error("no head row");
    fireEvent.contextMenu(row);
    const item = await screen.findByRole("menuitem", {
      name: /^Undo commit \(keep changes\)/,
    });
    expect(item).toHaveTextContent(`Undo commit (keep changes)${hint}`);
    expect(item).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(item);
    expect(toast.info).not.toHaveBeenCalled();
    expect(gitCommitDetails).not.toHaveBeenCalled();
  });

  it("an older commit's row keeps its own reason during a merge", async () => {
    const container = await renderPanel({ merging: true });
    const row = container.querySelector(`[data-hash="${HASH_PARENT}"]`);
    if (!row) throw new Error("no parent row");
    fireEvent.contextMenu(row);
    const item = await screen.findByRole("menuitem", {
      name: /^Undo commit \(keep changes\)/,
    });
    expect(item).toHaveTextContent(
      /^Undo commit \(keep changes\) \(latest commit only\)$/,
    );
    expect(item).toHaveAttribute("aria-disabled", "true");
  });

  it("the menu row stays offered mid-rebase", async () => {
    const container = await renderPanel({ rebasing: true });
    const row = container.querySelector(`[data-hash="${HASH_HEAD}"]`);
    if (!row) throw new Error("no head row");
    fireEvent.contextMenu(row);
    const item = await screen.findByRole("menuitem", {
      name: /^Undo commit \(keep changes\)/,
    });
    expect(item).toHaveTextContent(/^Undo commit \(keep changes\)$/);
    expect(item).not.toHaveAttribute("aria-disabled", "true");
  });
});

// A terminal abort (`git merge --abort`) moves no HEAD, so only these routes'
// own re-reads can see that the cached stop is gone.
describe("Undo after an operation ends outside the app", () => {
  /** Serves the next op-state reads from `next`; resolves once one starts. */
  async function nextOpState(next: () => Promise<RepoOpState>) {
    const before = vi.mocked(gitOpState).mock.calls.length;
    vi.mocked(gitOpState).mockImplementation(next);
    return () =>
      waitFor(() =>
        expect(vi.mocked(gitOpState).mock.calls.length).toBeGreaterThan(before),
      );
  }

  it("the shortcut re-reads a cached stop and undoes once it's gone", async () => {
    await renderPanel({ merging: true });
    await nextOpState(async () => IDLE);
    dispatchAction("undo-commit");
    await waitFor(() => expect(gitUndoCommit).toHaveBeenCalled());
    expect(gitCommitDetails).toHaveBeenCalledWith(REPO, HASH_HEAD);
    expect(toast.info).not.toHaveBeenCalledWith(UNDO_MID_MERGE);
  });

  it("the shortcut keeps the cached refusal when the re-read fails", async () => {
    await renderPanel({ merging: true });
    await nextOpState(() => Promise.reject(new Error("op boom")));
    dispatchAction("undo-commit");
    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith(UNDO_MID_MERGE),
    );
    expect(gitCommitDetails).not.toHaveBeenCalled();
    expect(gitUndoCommit).not.toHaveBeenCalled();
  });

  it("the shortcut drops a re-read that lands after a repo switch", async () => {
    await renderPanel({ merging: true });
    let land: ((s: RepoOpState) => void) | undefined;
    const started = await nextOpState(
      () =>
        new Promise<RepoOpState>((resolve) => {
          land = resolve;
        }),
    );
    dispatchAction("undo-commit");
    await started();
    act(() => useUiStore.setState({ repoPath: "/other" }));
    await act(async () => land?.(IDLE));
    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith(
        expect.stringMatching(
          /^You switched repositories before the undo started — nothing was undone/,
        ),
      ),
    );
    expect(gitCommitDetails).not.toHaveBeenCalled();
    expect(gitUndoCommit).not.toHaveBeenCalled();
  });

  it("the menu re-reads on open and offers the row once it lands", async () => {
    const container = await renderPanel({ merging: true });
    await nextOpState(async () => IDLE);
    const row = container.querySelector(`[data-hash="${HASH_HEAD}"]`);
    if (!row) throw new Error("no head row");
    fireEvent.contextMenu(row);
    const item = await screen.findByRole("menuitem", {
      name: /^Undo commit \(keep changes\)/,
    });
    await waitFor(() =>
      expect(item).toHaveTextContent(/^Undo commit \(keep changes\)$/),
    );
    expect(item).not.toHaveAttribute("aria-disabled", "true");
  });
});

async function openHeadMenu(container: HTMLElement) {
  const row = container.querySelector(`[data-hash="${HASH_HEAD}"]`);
  if (!row) throw new Error("no head row");
  fireEvent.contextMenu(row);
  return screen.findByRole("menuitem", { name: /^Edit history…/ });
}

/** Re-reads the no-upstream count, now answering `next`. */
async function recount(next: () => Promise<UnpushedCount>) {
  vi.mocked(gitUnpushedCount).mockImplementation(next);
  await act(() =>
    client.refetchQueries({ queryKey: repoKeys.unpushedCount(REPO) }),
  );
}

describe("Edit history with nothing to edit", () => {
  it("the menu row names an upstream branch with nothing ahead", async () => {
    setBranch({ ahead: 0 });
    const item = await openHeadMenu(await renderPanel({}));
    expect(item).toHaveTextContent(/^Edit history… \(no unpushed commits\)$/);
    expect(item).toHaveAttribute("aria-disabled", "true");
  });

  it("the menu row names the default branch the count ran against", async () => {
    setBranch(NO_UPSTREAM);
    vi.mocked(gitUnpushedCount).mockResolvedValue({
      count: 0,
      basis: "default-branch",
      defaultBranch: "main",
    });
    const container = await renderPanel({});
    await waitFor(() => expect(gitUnpushedCount).toHaveBeenCalled());
    const item = await openHeadMenu(container);
    await waitFor(() =>
      expect(item).toHaveTextContent(
        /^Edit history… \(no commits ahead of main\)$/,
      ),
    );
    expect(item).toHaveAttribute("aria-disabled", "true");
  });

  describe("the open dialog's note once the set empties", () => {
    async function openDialog() {
      setBranch(NO_UPSTREAM);
      vi.mocked(gitUnpushedCount).mockResolvedValue({
        count: 1,
        basis: "remotes",
        defaultBranch: null,
      });
      const container = await renderPanel({});
      const item = await openHeadMenu(container);
      await waitFor(() =>
        expect(item).not.toHaveAttribute("aria-disabled", "true"),
      );
      fireEvent.click(item);
      await screen.findByRole("dialog");
      // A terminal push leaves nothing unpushed; the reads agree on it.
      await recount(async () => ({
        count: 0,
        basis: "remotes",
        defaultBranch: null,
      }));
      expect(
        await screen.findByText(
          "Nothing left to edit: every commit is pushed.",
        ),
      ).toBeInTheDocument();
    }

    it("says the count couldn't be checked when its read fails", async () => {
      await openDialog();
      await recount(() => Promise.reject(new Error("count boom")));
      expect(
        await screen.findByText("Couldn't check which commits are pushed."),
      ).toBeInTheDocument();
      expect(screen.queryByText("Catching up with the branch…")).toBeNull();
    });

    it("says it is catching up while a good count disagrees", async () => {
      await openDialog();
      // A default-branch count taken ON that branch can't describe it.
      await recount(async () => ({
        count: 0,
        basis: "default-branch",
        defaultBranch: "feature",
      }));
      expect(
        await screen.findByText("Catching up with the branch…"),
      ).toBeInTheDocument();
      expect(
        screen.queryByText("Couldn't check which commits are pushed."),
      ).toBeNull();
    });
  });
});
