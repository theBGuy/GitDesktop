import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
import { CommitDetailView } from "@/features/history/CommitDetailView";
import {
  ALREADY_PUSHED_HINT,
  HISTORY_REFRESHING_HINT,
  UNPUSHED_UNCHECKED_HINT,
} from "@/features/history/commit-confirms";
import { HistoryPanel } from "@/features/history/HistoryPanel";
import {
  gitAmendCommitDates,
  gitCommitDetails,
  gitCommitFiles,
  gitLog,
  gitOpState,
  gitStatus,
  gitUndoCommit,
  gitUnpushedCount,
  gitUnpushedMessages,
  type UnpushedCount,
} from "@/lib/git/api";
import {
  BRANCH_PUSH_ACTIVE_MESSAGE,
  repoKeys,
  usePush,
} from "@/lib/git/queries";
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
  gitAmendCommitDates: vi.fn(),
  gitLog: vi.fn(),
  gitStatus: vi.fn(),
  gitOpState: vi.fn(),
  gitCommitDetails: vi.fn(),
  gitCommitFiles: vi.fn(),
  gitUndoCommit: vi.fn(),
  gitUnpushedCount: vi.fn(),
  gitUnpushedMessages: vi.fn(),
  // A push started by PushHarness stays pending for the whole test.
  gitPush: vi.fn(() => new Promise(() => undefined)),
}));
// usePush keys on the repository identity; it answers without a backend.
vi.mock("@/lib/git/repo-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/repo-identity")>()),
  peekRepoIdentity: (path: string) =>
    path === "/repo" ? "/repo/.git" : undefined,
  repoIdentityStrict: (path: string) =>
    path === "/repo"
      ? Promise.resolve("/repo/.git")
      : new Promise<string>(() => undefined),
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
    {
      hash: HASH_HEAD,
      message: "Add the parser",
      authorDate: { epochSeconds: 1_761_991_200, offsetMinutes: 0 },
      committerDate: { epochSeconds: 1_761_991_200, offsetMinutes: 0 },
    },
  ]);
  // Answers for the commit asked, so Edit dates' read of HEAD's parent lands.
  vi.mocked(gitCommitDetails).mockImplementation(async (_repo, hash) => ({
    hash,
    subject: "Add the parser",
    body: "",
    author: "Ada",
    authorEmail: "",
    date: "2026-11-01T10:00:00Z",
    committerDate: "2026-11-01T10:00:00Z",
  }));
  vi.mocked(gitUndoCommit).mockResolvedValue(undefined);
  vi.mocked(gitAmendCommitDates).mockResolvedValue(`d${HASH_HEAD.slice(1)}`);
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

/** One usePush binding per file: the usePush scan reads a second `const push`
 *  as a use of the first. */
function PushHarness() {
  const push = usePush(REPO);
  return (
    <button
      type="button"
      onClick={() =>
        void push.mutateAsync({ setUpstream: false, branch: "main" })
      }
    >
      start main
    </button>
  );
}

describe("Undo while a push runs", () => {
  it("a running push of the current branch holds the undo before any read", async () => {
    await renderPanel({});
    render(
      <QueryClientProvider client={client}>
        <PushHarness />
      </QueryClientProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "start main" }));
    await waitFor(() =>
      expect(
        client.getMutationCache().findAll({ status: "pending" }),
      ).toHaveLength(1),
    );
    dispatchAction("undo-commit");
    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith(BRANCH_PUSH_ACTIVE_MESSAGE),
    );
    expect(gitCommitDetails).not.toHaveBeenCalled();
    expect(gitUndoCommit).not.toHaveBeenCalled();
  });

  it("a push started during the message read holds the undo after it", async () => {
    await renderPanel({});
    render(
      <QueryClientProvider client={client}>
        <PushHarness />
      </QueryClientProvider>,
    );
    let answer: (() => void) | undefined;
    vi.mocked(gitCommitDetails).mockImplementation(
      (_repo, hash) =>
        new Promise((resolve) => {
          answer = () =>
            resolve({
              hash,
              subject: "Add the parser",
              body: "",
              author: "Ada",
              authorEmail: "",
              date: "2026-11-01T10:00:00Z",
              committerDate: "2026-11-01T10:00:00Z",
            });
        }),
    );
    dispatchAction("undo-commit");
    await waitFor(() =>
      expect(gitCommitDetails).toHaveBeenCalledWith(REPO, HASH_HEAD),
    );
    expect(toast.info).not.toHaveBeenCalledWith(BRANCH_PUSH_ACTIVE_MESSAGE);
    await userEvent.click(screen.getByRole("button", { name: "start main" }));
    await waitFor(() =>
      expect(
        client.getMutationCache().findAll({ status: "pending" }),
      ).toHaveLength(1),
    );
    answer?.();
    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith(BRANCH_PUSH_ACTIVE_MESSAGE),
    );
    expect(gitUndoCommit).not.toHaveBeenCalled();
  });

  it("a detached HEAD is never held", async () => {
    setBranch({ name: null, detached: true } as Partial<BranchHead>);
    await renderPanel({});
    render(
      <QueryClientProvider client={client}>
        <PushHarness />
      </QueryClientProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "start main" }));
    dispatchAction("undo-commit");
    await waitFor(() => expect(gitUndoCommit).toHaveBeenCalled());
    expect(toast.info).not.toHaveBeenCalledWith(BRANCH_PUSH_ACTIVE_MESSAGE);
  });
});

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
      headOid: HASH_HEAD,
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
    /** The footer's note, outside the live region that speaks it too. */
    const footerNote = (text: string) =>
      waitFor(() =>
        expect(
          screen
            .getAllByText(text)
            .filter((el) => el.closest('[role="status"]') === null),
        ).toHaveLength(1),
      );

    async function openDialog() {
      setBranch(NO_UPSTREAM);
      vi.mocked(gitUnpushedCount).mockResolvedValue({
        count: 1,
        basis: "remotes",
        defaultBranch: null,
        headOid: HASH_HEAD,
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
        headOid: HASH_HEAD,
      }));
      await footerNote("Nothing left to edit: every commit is pushed.");
    }

    it("says the count couldn't be checked when its read fails", async () => {
      await openDialog();
      await recount(() => Promise.reject(new Error("count boom")));
      await footerNote("Couldn't check which commits are pushed.");
      expect(screen.queryByText("Catching up with the branch…")).toBeNull();
    });

    it("says it is catching up while a good count disagrees", async () => {
      await openDialog();
      // A default-branch count taken ON that branch can't describe it.
      await recount(async () => ({
        count: 0,
        basis: "default-branch",
        defaultBranch: "feature",
        headOid: HASH_HEAD,
      }));
      await footerNote("Catching up with the branch…");
      expect(
        screen.queryByText("Couldn't check which commits are pushed."),
      ).toBeNull();
    });
  });
});

describe("Edit dates from History", () => {
  const HASH_BASE = `c${HASH_HEAD.slice(1)}`;
  const openMenu = async (container: HTMLElement, hash: string) => {
    const row = container.querySelector(`[data-hash="${hash}"]`);
    if (!row) throw new Error("no row");
    fireEvent.contextMenu(row);
    return screen.findByRole("menuitem", { name: /^Edit dates…/ });
  };
  // Three commits, the top two unpushed: the middle one is editable.
  const twoUnpushed = () => {
    vi.mocked(gitLog).mockResolvedValue([
      summary(HASH_HEAD, "Add the parser"),
      summary(HASH_PARENT, "Start the project"),
      summary(HASH_BASE, "Initial commit"),
    ]);
    setBranch({ ahead: 2 });
    const date = { epochSeconds: 1_761_991_200, offsetMinutes: 0 };
    vi.mocked(gitUnpushedMessages).mockResolvedValue([
      {
        hash: HASH_HEAD,
        message: "Add the parser",
        authorDate: date,
        committerDate: date,
      },
      {
        hash: HASH_PARENT,
        message: "Start the project",
        authorDate: date,
        committerDate: date,
      },
    ]);
  };

  it("the HEAD row opens the Edit dates dialog", async () => {
    const container = await renderPanel({});
    const item = await openMenu(container, HASH_HEAD);
    expect(item).not.toHaveAttribute("aria-disabled", "true");
    fireEvent.click(item);
    expect(
      await screen.findByRole("dialog", { name: "Edit dates" }),
    ).toBeInTheDocument();
  });

  it("a pushed row is held as already pushed", async () => {
    const container = await renderPanel({});
    const item = await openMenu(container, HASH_PARENT);
    expect(item).toHaveTextContent(/^Edit dates… \(already pushed\)$/);
    expect(item).toHaveAttribute("aria-disabled", "true");
  });

  it("an unpushed older row opens Edit history on its dates", async () => {
    twoUnpushed();
    const container = await renderPanel({});
    await waitFor(() =>
      expect(
        container.querySelector(`[data-hash="${HASH_BASE}"]`),
      ).not.toBeNull(),
    );
    const item = await openMenu(container, HASH_PARENT);
    await waitFor(() =>
      expect(item).not.toHaveAttribute("aria-disabled", "true"),
    );
    fireEvent.click(item);
    expect(
      await screen.findByRole("group", { name: "Dates for Start the project" }),
    ).toBeInTheDocument();
    // The routed row, never its field, takes the dialog's initial focus.
    const dialog = screen.getByRole("dialog");
    await waitFor(() =>
      expect(dialog.querySelector(`[data-row="${HASH_PARENT}"]`)).toHaveFocus(),
    );
  });

  it("a HEAD date change drops the old id from the panel's selection and anchor", async () => {
    const container = await renderPanel({});
    const rowOf = (hash: string) => {
      const row = container.querySelector<HTMLElement>(`[data-hash="${hash}"]`);
      if (!row) throw new Error("no row");
      return row;
    };
    // A plain click makes HEAD the selection and the anchor.
    fireEvent.click(rowOf(HASH_HEAD));
    expect(rowOf(HASH_HEAD)).toHaveClass("bg-accent");
    fireEvent.click(await openMenu(container, HASH_HEAD));
    const field = await screen.findByLabelText("Author date");
    fireEvent.change(field, {
      target: { value: "2026-11-02 10:00:00 +00:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Change dates/ }));
    await waitFor(() =>
      expect(gitAmendCommitDates).toHaveBeenCalledWith(
        REPO,
        HASH_HEAD,
        "main",
        expect.anything(),
        expect.anything(),
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Edit dates" })).toBeNull(),
    );
    // The rewrite takes the old commit's place in the store's selection.
    expect(useUiStore.getState().selectedCommitHash).toBe(
      `d${HASH_HEAD.slice(1)}`,
    );
    // The log still lists the old id, so a kept selection would still paint it.
    expect(rowOf(HASH_HEAD)).not.toHaveClass("bg-accent");
    // A kept anchor would turn this Shift+click into a two-row range.
    fireEvent.click(rowOf(HASH_PARENT), { shiftKey: true });
    expect(rowOf(HASH_PARENT)).toHaveClass("bg-accent");
    expect(rowOf(HASH_HEAD)).not.toHaveClass("bg-accent");
  });

  it("a HEAD date change from the row menu selects and focuses the rewritten row", async () => {
    const NEW = `d${HASH_HEAD.slice(1)}`;
    const container = await renderPanel({});
    const rowOf = (hash: string) =>
      container.querySelector<HTMLElement>(`[data-hash="${hash}"]`);
    fireEvent.click(rowOf(HASH_HEAD) as HTMLElement);
    fireEvent.click(await openMenu(container, HASH_HEAD));
    const field = await screen.findByLabelText("Author date");
    fireEvent.change(field, {
      target: { value: "2026-11-02 10:00:00 +00:00" },
    });
    // The refetch after the rewrite lists the new id where HEAD was.
    vi.mocked(gitLog).mockResolvedValue([
      summary(NEW, "Add the parser"),
      summary(HASH_PARENT, "Start the project"),
    ]);
    setBranch({ oid: NEW });
    fireEvent.click(screen.getByRole("button", { name: /Change dates/ }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Edit dates" })).toBeNull(),
    );
    expect(useUiStore.getState().selectedCommitHash).toBe(NEW);
    await waitFor(() => expect(rowOf(NEW)).toHaveFocus());
    expect(rowOf(HASH_PARENT)).not.toHaveFocus();
  });

  const NEW_HEAD = `d${HASH_HEAD.slice(1)}`;
  const HASH_GRAND = `e${HASH_HEAD.slice(1)}`;

  /** Changes HEAD's dates from the commit detail pane; the refetched log lists
   *  the rewritten HEAD over two older rows. */
  async function rewriteFromDetailPane() {
    // The pane renders its actions once its file list reads.
    vi.mocked(gitCommitFiles).mockResolvedValue([]);
    const NEW = NEW_HEAD;
    vi.mocked(gitOpState).mockResolvedValue(IDLE);
    client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(
      settingsKeys.settings,
      structuredClone(DEFAULT_SETTINGS),
    );
    // RepositoryView's pairing: the detail pane follows the store selection.
    function Detail() {
      const hash = useUiStore((s) => s.selectedCommitHash);
      return hash === null ? null : (
        <CommitDetailView repoPath={REPO} hash={hash} />
      );
    }
    const { container } = render(
      <QueryClientProvider client={client}>
        <HistoryPanel repoPath={REPO} />
        <Detail />
      </QueryClientProvider>,
    );
    const rowOf = (hash: string) =>
      container.querySelector<HTMLElement>(`[data-hash="${hash}"]`);
    await waitFor(() => expect(rowOf(HASH_HEAD)).not.toBeNull());
    // A plain click makes HEAD the panel's selection and anchor.
    fireEvent.click(rowOf(HASH_HEAD) as HTMLElement);
    await userEvent.click(
      await screen.findByRole("button", { name: "Commit actions" }),
    );
    const item = await screen.findByRole("menuitem", { name: /^Edit dates…/ });
    await waitFor(() => expect(item).not.toHaveAttribute("aria-disabled"));
    await userEvent.click(item);
    fireEvent.change(await screen.findByLabelText("Author date"), {
      target: { value: "2026-11-02 10:00:00 +00:00" },
    });
    vi.mocked(gitLog).mockResolvedValue([
      summary(NEW, "Add the parser"),
      summary(HASH_PARENT, "Start the project"),
      summary(HASH_GRAND, "Initial commit"),
    ]);
    setBranch({ oid: NEW });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Change dates/ }),
      ).not.toHaveAttribute("aria-disabled"),
    );
    fireEvent.click(screen.getByRole("button", { name: /Change dates/ }));
    await waitFor(() => expect(rowOf(NEW)).not.toBeNull());
    expect(useUiStore.getState().selectedCommitHash).toBe(NEW);
    await waitFor(() => expect(rowOf(NEW)).toHaveClass("bg-accent"));
    return (hash: string) => rowOf(hash) as HTMLElement;
  }
  const highlighted = (rowOf: (hash: string) => HTMLElement) =>
    [NEW_HEAD, HASH_PARENT, HASH_GRAND].map((h) =>
      rowOf(h).classList.contains("bg-accent"),
    );

  // Controls: drop HistoryPanel's prune on a new log answer, and no row is
  // highlighted; drop the fallback's anchor pin, and the second Shift+click
  // collapses the range to one row.
  it("a HEAD date change from the commit detail pane highlights the new row and ranges from it", async () => {
    const rowOf = await rewriteFromDetailPane();
    fireEvent.click(rowOf(HASH_PARENT), { shiftKey: true });
    expect(highlighted(rowOf)).toEqual([true, true, false]);
    fireEvent.click(rowOf(HASH_GRAND), { shiftKey: true });
    expect(highlighted(rowOf)).toEqual([true, true, true]);
  });

  // Control: drop the fallback's anchor pin; the second Shift+Down collapses
  // the range to one row.
  it("a HEAD date change from the commit detail pane keeps growing a Shift+arrow range", async () => {
    // jsdom has no scrollIntoView; arrow nav scrolls the row it focuses.
    Element.prototype.scrollIntoView = vi.fn();
    const rowOf = await rewriteFromDetailPane();
    fireEvent.keyDown(rowOf(NEW_HEAD), { key: "ArrowDown", shiftKey: true });
    expect(highlighted(rowOf)).toEqual([true, true, false]);
    fireEvent.keyDown(rowOf(HASH_PARENT), { key: "ArrowDown", shiftKey: true });
    expect(highlighted(rowOf)).toEqual([true, true, true]);
  });

  describe("the deferred landing on the rewritten row", () => {
    const NEW = `d${HASH_HEAD.slice(1)}`;
    const rewritten = (subject: string) => [
      summary(NEW, subject),
      summary(HASH_PARENT, "Start the project"),
    ];

    /** Changes HEAD's dates with the log's refetch held, so the dialog closes
     *  before the rewritten row renders and the landing waits armed. */
    async function changeWithLogHeld(container: HTMLElement) {
      const rowOf = (hash: string) =>
        container.querySelector<HTMLElement>(`[data-hash="${hash}"]`);
      fireEvent.click(rowOf(HASH_HEAD) as HTMLElement);
      fireEvent.click(await openMenu(container, HASH_HEAD));
      fireEvent.change(await screen.findByLabelText("Author date"), {
        target: { value: "2026-11-02 10:00:00 +00:00" },
      });
      let release!: () => void;
      const held = new Promise<CommitSummary[]>((r) => {
        release = () => r(rewritten("Add the parser"));
      });
      vi.mocked(gitLog).mockImplementation(() => held);
      setBranch({ oid: NEW });
      fireEvent.click(screen.getByRole("button", { name: /Change dates/ }));
      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: "Edit dates" })).toBeNull(),
      );
      expect(rowOf(NEW)).toBeNull();
      return { rowOf, release };
    }

    /** Lands one more log answer while focus sits on the body. */
    async function relistWithFocusOnBody(
      rowOf: (hash: string) => HTMLElement | null,
    ) {
      act(() => (document.activeElement as HTMLElement | null)?.blur());
      vi.mocked(gitLog).mockResolvedValue(rewritten("Add the parser, again"));
      await act(() => client.refetchQueries({ queryKey: repoKeys.log(REPO) }));
      await waitFor(() =>
        expect(rowOf(NEW)).toHaveTextContent("Add the parser, again"),
      );
    }

    it("lands once the refetched log renders the row", async () => {
      const container = await renderPanel({});
      const { rowOf, release } = await changeWithLogHeld(container);
      await act(async () => release());
      await waitFor(() => expect(rowOf(NEW)).toHaveFocus());
    });

    // Control: drop the clear on focus outside the dialog; the later listing
    // with focus on the body takes it to the row.
    it("is dropped once focus is on a control outside the dialog", async () => {
      const container = await renderPanel({});
      const { rowOf, release } = await changeWithLogHeld(container);
      const parent = rowOf(HASH_PARENT) as HTMLElement;
      act(() => parent.focus());
      await act(async () => release());
      await waitFor(() => expect(rowOf(NEW)).not.toBeNull());
      expect(parent).toHaveFocus();

      await relistWithFocusOnBody(rowOf);
      expect(rowOf(NEW)).not.toHaveFocus();
    });

    // Control: drop the focus-host exemption; the detail pane keeps focus.
    it("lands after the commit detail pane took focus for the new selection", async () => {
      vi.mocked(gitOpState).mockResolvedValue(IDLE);
      client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      client.setQueryData(
        settingsKeys.settings,
        structuredClone(DEFAULT_SETTINGS),
      );
      // RepositoryView's pairing: the detail pane follows the store selection.
      function Detail() {
        const hash = useUiStore((s) => s.selectedCommitHash);
        return hash === null ? null : (
          <CommitDetailView repoPath={REPO} hash={hash} />
        );
      }
      const { container } = render(
        <QueryClientProvider client={client}>
          <HistoryPanel repoPath={REPO} />
          <Detail />
        </QueryClientProvider>,
      );
      await waitFor(() =>
        expect(
          container.querySelector(`[data-hash="${HASH_HEAD}"]`),
        ).not.toBeNull(),
      );
      await waitFor(() =>
        expect(client.getQueryData(repoKeys.opState(REPO))).toBeDefined(),
      );
      const { rowOf, release } = await changeWithLogHeld(container);
      expect(useUiStore.getState().selectedCommitHash).toBe(NEW);
      const host = container.querySelector<HTMLElement>(
        "[data-commit-detail-focus-host]",
      );
      if (host === null) throw new Error("no detail focus host");
      // The pane's own move from the body to its host. Live, the selection's
      // render lands after the dialog returned focus to the body; jsdom applies
      // it first, so the move is made here.
      act(() => host.focus());
      await act(async () => release());
      await waitFor(() => expect(rowOf(NEW)).toHaveFocus());
    });

    // Control: drop the clear on a repo mismatch; back on the repo, the row
    // takes focus.
    it("is dropped by a repo switch", async () => {
      vi.mocked(gitOpState).mockResolvedValue(IDLE);
      client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      client.setQueryData(
        settingsKeys.settings,
        structuredClone(DEFAULT_SETTINGS),
      );
      const tree = (path: string) => (
        <QueryClientProvider client={client}>
          <HistoryPanel repoPath={path} />
        </QueryClientProvider>
      );
      const { container, rerender } = render(tree(REPO));
      await waitFor(() =>
        expect(
          container.querySelector(`[data-hash="${HASH_HEAD}"]`),
        ).not.toBeNull(),
      );
      await waitFor(() =>
        expect(client.getQueryData(repoKeys.opState(REPO))).toBeDefined(),
      );
      const { rowOf, release } = await changeWithLogHeld(container);
      rerender(tree("/repo-b"));
      rerender(tree(REPO));
      // Focus nobody placed: an armed landing would take it.
      expect(document.activeElement).toBe(document.body);
      await act(async () => release());
      await waitFor(() => expect(rowOf(NEW)).not.toBeNull());
      expect(rowOf(NEW)).not.toHaveFocus();
    });
  });

  it("the palette routes the selected commit, and refuses a pushed one", async () => {
    twoUnpushed();
    const container = await renderPanel({});
    await waitFor(() =>
      expect(
        container.querySelector(`[data-hash="${HASH_BASE}"]`),
      ).not.toBeNull(),
    );
    act(() => useUiStore.setState({ selectedCommitHash: HASH_BASE }));
    expect(dispatchAction("edit-commit-dates")).toBe(false);
    act(() => useUiStore.setState({ selectedCommitHash: HASH_PARENT }));
    await waitFor(() => expect(dispatchAction("edit-commit-dates")).toBe(true));
    expect(
      await screen.findByRole("group", { name: "Dates for Start the project" }),
    ).toBeInTheDocument();
  });

  it("a repo switch and back leaves the dialog closed", async () => {
    vi.mocked(gitOpState).mockResolvedValue(IDLE);
    const local = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    local.setQueryData(
      settingsKeys.settings,
      structuredClone(DEFAULT_SETTINGS),
    );
    const tree = (path: string) => (
      <QueryClientProvider client={local}>
        <HistoryPanel repoPath={path} />
      </QueryClientProvider>
    );
    const { container, rerender } = render(tree(REPO));
    await waitFor(() =>
      expect(
        container.querySelector(`[data-hash="${HASH_HEAD}"]`),
      ).not.toBeNull(),
    );
    await waitFor(() =>
      expect(local.getQueryData(repoKeys.opState(REPO))).toBeDefined(),
    );
    fireEvent.click(await openMenu(container, HASH_HEAD));
    await screen.findByRole("dialog", { name: "Edit dates" });
    rerender(tree("/repo-b"));
    rerender(tree(REPO));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Edit dates" })).toBeNull(),
    );
  });

  it("one mounted panel moves through its early returns without a hook-order error", async () => {
    const container = await renderPanel({});
    const reset = async (
      arrange: () => void,
      settled: () => void | Promise<void>,
    ) => {
      arrange();
      // Not awaited: the unread arm's fetch never settles.
      act(() => {
        void client.resetQueries({ queryKey: repoKeys.log(REPO) });
      });
      await waitFor(settled);
    };
    const logState = () => client.getQueryState(repoKeys.log(REPO));
    await reset(
      () => vi.mocked(gitLog).mockReturnValue(new Promise(() => undefined)),
      () => expect(logState()?.status).toBe("pending"),
    );
    await reset(
      () => vi.mocked(gitLog).mockRejectedValue(new Error("log failed")),
      () => expect(logState()?.status).toBe("error"),
    );
    await reset(
      () => vi.mocked(gitLog).mockResolvedValue([]),
      () => expect(logState()?.status).toBe("success"),
    );
    await reset(
      () =>
        vi
          .mocked(gitLog)
          .mockResolvedValue([
            summary(HASH_HEAD, "Add the parser"),
            summary(HASH_PARENT, "Start the project"),
          ]),
      () =>
        expect(
          container.querySelector(`[data-hash="${HASH_HEAD}"]`),
        ).not.toBeNull(),
    );
  });
});

describe("Undo on a branch with no upstream", () => {
  const UNDO_PUSHED_REFRESHING =
    "Still checking which commits are pushed — try again in a moment.";
  const UNDO_PUSHED_UNCHECKED =
    "Couldn't check which commits are pushed; nothing was undone.";
  const GONE_UPSTREAM: Partial<BranchHead> = {
    ...NO_UPSTREAM,
    upstream: "origin/feature",
    upstreamGone: true,
  };

  const counted = (over: Partial<UnpushedCount>) =>
    vi.mocked(gitUnpushedCount).mockResolvedValue({
      count: 0,
      basis: "remotes",
      defaultBranch: null,
      headOid: HASH_HEAD,
      ...over,
    });

  async function openUndoRow(container: HTMLElement) {
    const row = container.querySelector(`[data-hash="${HASH_HEAD}"]`);
    if (!row) throw new Error("no head row");
    fireEvent.contextMenu(row);
    return screen.findByRole("menuitem", {
      name: /^Undo commit \(keep changes\)/,
    });
  }

  /** Lets a dispatched action's synchronous arms and toasts run. */
  const settle = () => act(async () => undefined);

  it.each([
    ["no upstream", NO_UPSTREAM],
    ["a gone upstream", GONE_UPSTREAM],
  ])(
    "a commit a remote branch has reads already pushed (%s)",
    async (_n, branch) => {
      setBranch(branch);
      counted({ count: 0 });
      const item = await openUndoRow(await renderPanel({}));
      await waitFor(() =>
        expect(item).toHaveTextContent(
          `Undo commit (keep changes)${ALREADY_PUSHED_HINT}`,
        ),
      );
      expect(item).toHaveAttribute("aria-disabled", "true");
      dispatchAction("undo-commit");
      await settle();
      expect(gitCommitDetails).not.toHaveBeenCalled();
      expect(gitUndoCommit).not.toHaveBeenCalled();
      expect(toast.info).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["an unpushed commit on the remotes basis", { count: 1 }],
    [
      "the on-default-branch basis",
      {
        count: 0,
        basis: "on-default-branch" as const,
        defaultBranch: "feature",
      },
    ],
    [
      "the default-branch basis",
      { count: 0, basis: "default-branch" as const, defaultBranch: "main" },
    ],
    ["the unresolved basis", { count: 0, basis: "unresolved" as const }],
  ])("the shortcut undoes on %s", async (_n, over) => {
    setBranch(NO_UPSTREAM);
    counted(over);
    await renderPanel({});
    await waitFor(() =>
      expect(client.getQueryData(repoKeys.unpushedCount(REPO))).toBeDefined(),
    );
    dispatchAction("undo-commit");
    await waitFor(() => expect(gitUndoCommit).toHaveBeenCalled());
  });

  it("a failed count holds the row and the shortcut explains", async () => {
    setBranch(NO_UPSTREAM);
    vi.mocked(gitUnpushedCount).mockRejectedValue(new Error("count boom"));
    const item = await openUndoRow(await renderPanel({}));
    await waitFor(() =>
      expect(item).toHaveTextContent(
        `Undo commit (keep changes)${UNPUSHED_UNCHECKED_HINT}`,
      ),
    );
    expect(item).toHaveAttribute("aria-disabled", "true");
    dispatchAction("undo-commit");
    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith(UNDO_PUSHED_UNCHECKED),
    );
    expect(gitCommitDetails).not.toHaveBeenCalled();
    expect(gitUndoCommit).not.toHaveBeenCalled();
  });

  it("an unread count holds the row and the shortcut explains", async () => {
    setBranch(NO_UPSTREAM);
    vi.mocked(gitUnpushedCount).mockImplementation(
      () => new Promise<UnpushedCount>(() => undefined),
    );
    const item = await openUndoRow(await renderPanel({}));
    expect(item).toHaveTextContent(
      `Undo commit (keep changes)${HISTORY_REFRESHING_HINT}`,
    );
    expect(item).toHaveAttribute("aria-disabled", "true");
    dispatchAction("undo-commit");
    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith(UNDO_PUSHED_REFRESHING),
    );
    expect(gitCommitDetails).not.toHaveBeenCalled();
  });

  it("a count taken on another head holds the row as refreshing", async () => {
    setBranch(NO_UPSTREAM);
    counted({ count: 1, headOid: HASH_PARENT });
    const item = await openUndoRow(await renderPanel({}));
    await waitFor(() => expect(gitUnpushedCount).toHaveBeenCalled());
    await waitFor(() =>
      expect(item).toHaveTextContent(
        `Undo commit (keep changes)${HISTORY_REFRESHING_HINT}`,
      ),
    );
    expect(item).toHaveAttribute("aria-disabled", "true");
  });

  it("a log trailing status holds Edit dates as refreshing, even with a failed count", async () => {
    // Status already names a newer HEAD than the log's top row.
    setBranch({ ...NO_UPSTREAM, oid: `e${HASH_HEAD.slice(1)}` });
    vi.mocked(gitUnpushedCount).mockRejectedValue(new Error("count boom"));
    const container = await renderPanel({});
    await waitFor(() => expect(gitUnpushedCount).toHaveBeenCalled());
    const row = await waitFor(() => {
      const r = container.querySelector(`[data-hash="${HASH_HEAD}"]`);
      if (!r) throw new Error("no top row");
      return r;
    });
    fireEvent.contextMenu(row);
    const item = await screen.findByRole("menuitem", {
      name: /^Edit dates…/,
    });
    await waitFor(() =>
      expect(item).toHaveTextContent(`Edit dates…${HISTORY_REFRESHING_HINT}`),
    );
    expect(item).toHaveAttribute("aria-disabled", "true");
  });

  it("a log refetch landing the same head keeps every gate agreed", async () => {
    setBranch(NO_UPSTREAM);
    counted({ count: 1 });
    const container = await renderPanel({});
    await waitFor(() =>
      expect(client.getQueryData(repoKeys.unpushedCount(REPO))).toBeDefined(),
    );
    // The refetched log must land on a later millisecond than the count.
    const countAt =
      client.getQueryState(repoKeys.unpushedCount(REPO))?.dataUpdatedAt ?? 0;
    await waitFor(() => expect(Date.now()).toBeGreaterThan(countAt));
    await act(() => client.refetchQueries({ queryKey: repoKeys.log(REPO) }));
    const undo = await openUndoRow(container);
    expect(undo).toHaveTextContent(/^Undo commit \(keep changes\)$/);
    expect(undo).not.toHaveAttribute("aria-disabled", "true");
    const edit = screen.getByRole("menuitem", { name: /^Edit history…/ });
    expect(edit).toHaveTextContent(/^Edit history…$/);
    expect(edit).not.toHaveAttribute("aria-disabled", "true");
  });
});

describe("Undo over unresolved conflicts", () => {
  const UNDO_UNRESOLVED = "Resolve the conflicts first; nothing was undone.";

  async function withConflict() {
    const shown = await vi.mocked(gitStatus)(REPO);
    vi.mocked(gitStatus).mockResolvedValue({
      ...shown,
      entries: [
        { path: "a.txt", staged: "conflicted", unstaged: "conflicted" },
      ],
    });
  }

  it("with no stopped operation the row holds and the shortcut refuses first", async () => {
    await withConflict();
    const container = await renderPanel({});
    const row = container.querySelector(`[data-hash="${HASH_HEAD}"]`);
    if (!row) throw new Error("no head row");
    fireEvent.contextMenu(row);
    const item = await screen.findByRole("menuitem", {
      name: /^Undo commit \(keep changes\)/,
    });
    await waitFor(() =>
      expect(item).toHaveTextContent(
        "Undo commit (keep changes) (resolve the conflicts first)",
      ),
    );
    expect(item).toHaveAttribute("aria-disabled", "true");
    dispatchAction("undo-commit");
    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith(UNDO_UNRESOLVED),
    );
    expect(gitCommitDetails).not.toHaveBeenCalled();
    expect(gitUndoCommit).not.toHaveBeenCalled();
  });

  // Control: drop the `unresolved` arm of editDatesRoute; the row and the
  // palette go live.
  it("Edit dates holds the HEAD row and the palette with Undo's reason", async () => {
    await withConflict();
    const container = await renderPanel({});
    act(() => useUiStore.setState({ selectedCommitHash: HASH_HEAD }));
    const row = container.querySelector(`[data-hash="${HASH_HEAD}"]`);
    if (!row) throw new Error("no head row");
    fireEvent.contextMenu(row);
    const item = await screen.findByRole("menuitem", { name: /^Edit dates…/ });
    await waitFor(() =>
      expect(item).toHaveTextContent(
        "Edit dates… (resolve the conflicts first)",
      ),
    );
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(dispatchAction("edit-commit-dates")).toBe(false);
    expect(screen.queryByRole("dialog", { name: "Edit dates" })).toBeNull();
  });

  it("a stopped merge keeps its own reason", async () => {
    await withConflict();
    const container = await renderPanel({ merging: true });
    const row = container.querySelector(`[data-hash="${HASH_HEAD}"]`);
    if (!row) throw new Error("no head row");
    fireEvent.contextMenu(row);
    const item = await screen.findByRole("menuitem", {
      name: /^Undo commit \(keep changes\)/,
    });
    expect(item).toHaveTextContent(
      "Undo commit (keep changes) (finish or abort the merge first)",
    );
    expect(item).toHaveAttribute("aria-disabled", "true");
  });
});
