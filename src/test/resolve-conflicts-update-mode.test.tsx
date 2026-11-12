import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
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
import {
  MERGE_ABORT_KEPT,
  MERGE_ENTRY_ALREADY_CLOSED,
  ResolveConflictsView,
} from "@/features/pulls/ResolveConflictsView";
import {
  getSecret,
  gitAbortLocalPrMerge,
  gitDiscardLocalPrUpdate,
  gitFinishLocalPrMerge,
  gitFinishLocalPrUpdate,
  gitStatus,
} from "@/lib/git/api";
import {
  BRANCH_PUSH_ACTIVE_MESSAGE,
  BRANCH_PUSH_ELSEWHERE_MESSAGE,
  usePush,
} from "@/lib/git/queries";
import { repoIdentityQueryOptions } from "@/lib/git/repo-identity-query";
import type { RepoStatus } from "@/lib/git/types";
import { type LocalPr, updateLocalPr } from "@/lib/pulls/local";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { useConfirm } from "@/lib/stores/confirm";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";
import { unmockedCommands } from "./setup";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
  }),
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
  getSecret: vi.fn(),
  gitStatus: vi.fn(),
  gitFinishLocalPrUpdate: vi.fn(),
  gitDiscardLocalPrUpdate: vi.fn(),
  gitFinishLocalPrMerge: vi.fn(),
  gitAbortLocalPrMerge: vi.fn(),
  // A push started by PushHarness stays pending for the whole test.
  gitPush: vi.fn(() => new Promise(() => undefined)),
}));
// usePush keys on the repository identity; C:/repo-wt is another worktree of
// the same repository. Any other path never resolves.
vi.mock("@/lib/git/repo-identity", async (importOriginal) => {
  const ids = new Map([
    ["C:/repo", "C:/repo/.git"],
    ["C:/repo-wt", "C:/repo/.git"],
  ]);
  return {
    ...(await importOriginal<typeof import("@/lib/git/repo-identity")>()),
    peekRepoIdentity: (path: string) => ids.get(path),
    repoIdentityStrict: (path: string) => {
      const id = ids.get(path);
      return id === undefined
        ? new Promise<string>(() => undefined)
        : Promise.resolve(id);
    },
  };
});
vi.mock("@/lib/pulls/local", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pulls/local")>()),
  updateLocalPr: vi.fn(),
}));
// The per-file editors are their own surfaces; this file pins the shell around them.
vi.mock("@/features/repository/ConflictFileView", () => ({
  ConflictFileView: () => <p>file editor</p>,
}));
vi.mock("@/features/repository/ConflictResolveView", () => ({
  ConflictResolveView: () => <p>ai editor</p>,
}));

const REPO = "C:/repo";
const WT = "C:/data/gd-resolve-0123456789ab";
const UNREADABLE =
  "This update's worktree can't be read. Discard this update, then choose Resolve conflicts to start again.";

const UPDATE = {
  base: "main",
  head: "feat",
  worktreePath: WT,
  worktreeId: "0123456789ab",
  opId: "op-1",
  journalRepo: "C:/repo-checkout",
  startedAt: "2026-01-01T00:00:00Z",
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
    pendingUpdate: { ...UPDATE },
    ...over,
  };
}

const status = (conflicts: string[]): RepoStatus =>
  ({
    branch: null,
    entries: conflicts.map((path) => ({
      path,
      staged: null,
      unstaged: "conflicted",
    })),
  }) as unknown as RepoStatus;

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}

type Props = Partial<ComponentProps<typeof ResolveConflictsView>>;

function renderEditor(props: Props = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ResolveConflictsView
        repoPath={REPO}
        pr={makePr()}
        mode="update"
        {...props}
      />
    </QueryClientProvider>,
  );
}

const finishButton = () =>
  screen.getByRole("button", { name: /^Finish (update|merge)$/ });

let written: LocalPr[] = [];
const realAsk = useConfirm.getState().ask;

beforeEach(() => {
  vi.clearAllMocks();
  written = [];
  useUiStore.setState({ repoPath: REPO });
  vi.mocked(loadSettings).mockResolvedValue(DEFAULT_SETTINGS);
  vi.mocked(getSecret).mockResolvedValue(null);
  vi.mocked(gitStatus).mockResolvedValue(status([]));
  vi.mocked(updateLocalPr).mockImplementation(async (_repo, _id, mutate) => {
    const next = mutate(makePr());
    written.push(next);
    return next;
  });
});

afterEach(() => {
  useConfirm.setState({ ask: realAsk });
});

afterAll(() => expect(unmockedCommands).toEqual([]));

describe("ResolveConflictsView, update mode", () => {
  it("the header names the merge into head, wraps, and offers Back to PR", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    renderEditor({ onBack });
    const sentence = await screen.findByText(/^Merging/);
    expect(sentence).toHaveTextContent(
      "Merging main into feat. Finishing updates feat.",
    );
    expect(sentence).not.toHaveClass("truncate");
    expect(screen.getByRole("button", { name: "Discard" })).toBeInTheDocument();
    expect(finishButton()).toHaveTextContent("Finish update");
    await user.click(screen.getByRole("button", { name: "Back to PR" }));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(gitFinishLocalPrUpdate).not.toHaveBeenCalled();
    expect(gitDiscardLocalPrUpdate).not.toHaveBeenCalled();
    expect(updateLocalPr).not.toHaveBeenCalled();
  });

  it("the header and done line name the record's head after a rename", async () => {
    // A branch rename rewrites the record's head, never its update field.
    renderEditor({ pr: makePr({ head: "feat-renamed" }) });
    const sentence = await screen.findByText(/^Merging/);
    expect(sentence).toHaveTextContent(
      "Merging main into feat-renamed. Finishing updates feat-renamed.",
    );
    await waitFor(() =>
      expect(
        screen.getAllByText(
          (_, el) =>
            el?.tagName === "SPAN" &&
            el.textContent ===
              "All conflicts resolved. Finish update to apply the merge to feat-renamed.",
        ),
      ).toHaveLength(1),
    );
  });

  it("the header's buttons wrap inside their group, right-aligned", async () => {
    renderEditor({ onBack: vi.fn() });
    await screen.findByText(/^Merging/);
    const group = screen.getByRole("button", { name: "Back to PR" })
      .parentElement as HTMLElement;
    expect(group).toContainElement(finishButton());
    expect(group).toHaveClass(
      "ml-auto",
      "flex",
      "flex-wrap",
      "items-center",
      "justify-end",
    );
  });

  it("no Back to PR without onBack", async () => {
    renderEditor();
    await screen.findByText(/^Merging/);
    expect(screen.queryByRole("button", { name: "Back to PR" })).toBeNull();
  });

  it("a conflict left holds Finish; none shows the done line", async () => {
    vi.mocked(gitStatus).mockResolvedValue(status(["src/a.ts"]));
    const view = renderEditor();
    await screen.findByRole("option", { name: "a.ts" });
    expect(finishButton()).toHaveAttribute("aria-disabled", "true");
    expect(finishButton()).toHaveAccessibleDescription(
      "Resolve every conflict first",
    );
    view.unmount();

    vi.mocked(gitStatus).mockResolvedValue(status([]));
    const clean = renderEditor();
    const done =
      "All conflicts resolved. Finish update to apply the merge to feat.";
    await waitFor(() =>
      expect(
        screen.getAllByText((_t, el) => el?.textContent === done),
      ).not.toHaveLength(0),
    );
    expect(finishButton()).not.toHaveAttribute("aria-disabled");
    clean.unmount();

    renderEditor({ pr: makePr({ approved: true }) });
    const approvedLine =
      "All conflicts resolved. Finish update to apply the merge to feat; this clears the PR's approval.";
    await waitFor(() =>
      expect(
        screen.getAllByText((_t, el) => el?.textContent === approvedLine)
          .length,
      ).toBeGreaterThanOrEqual(2),
    );
  });

  it("finishHeldReason holds Finish while Discard stays enabled", async () => {
    renderEditor({
      finishHeldReason:
        "Commit or stash your changes to update the current branch",
    });
    await screen.findByText(/^Merging/);
    await waitFor(() => expect(gitStatus).toHaveBeenCalled());
    expect(finishButton()).toHaveAttribute("aria-disabled", "true");
    expect(finishButton()).toHaveAccessibleDescription(
      "Commit or stash your changes to update the current branch",
    );
    expect(screen.getByRole("button", { name: "Discard" })).not.toHaveAttribute(
      "aria-disabled",
    );
  });

  it("Finish holds while the worktree's status read has not answered", async () => {
    vi.mocked(gitStatus).mockReturnValue(new Promise(() => undefined));
    renderEditor();
    await screen.findByText(/^Merging/);
    expect(finishButton()).toHaveAttribute("aria-disabled", "true");
    expect(finishButton()).toHaveAccessibleDescription(
      "Resolve every conflict first",
    );
    expect(screen.queryByText(UNREADABLE)).toBeNull();
  });

  it("Finish sends the record's update and toasts the finish", async () => {
    const user = userEvent.setup();
    const onHeadMoved = vi.fn();
    vi.mocked(gitFinishLocalPrUpdate).mockResolvedValue({
      status: "updated",
      conflicts: [],
      headTip: "abc1234",
      worktreePath: null,
      worktreeId: null,
      opId: "op-1",
      journalRepo: "C:/repo-checkout",
    });
    renderEditor({ onHeadMoved });
    await waitFor(() =>
      expect(finishButton()).not.toHaveAttribute("aria-disabled"),
    );
    await user.click(finishButton());
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Updated feat from main"),
    );
    expect(gitFinishLocalPrUpdate).toHaveBeenCalledWith(
      REPO,
      "main",
      "feat",
      WT,
      "0123456789ab",
      "op-1",
      "C:/repo-checkout",
    );
    expect(written).toHaveLength(1);
    expect(written[0].status).toBe("open");
    expect(written[0].mergedAt).toBeUndefined();
    expect(written[0].pendingUpdate).toBeUndefined();
    expect(onHeadMoved).toHaveBeenCalledWith(
      expect.objectContaining({ repo: REPO, id: "a" }),
    );
  });

  it("Finish sends the base the start merged, not the PR's live base", async () => {
    const user = userEvent.setup();
    vi.mocked(gitFinishLocalPrUpdate).mockReturnValue(
      new Promise(() => undefined),
    );
    renderEditor({
      pr: makePr({
        base: "main",
        pendingUpdate: { ...UPDATE, base: "release" },
      }),
    });
    await waitFor(() =>
      expect(finishButton()).not.toHaveAttribute("aria-disabled"),
    );
    await user.click(finishButton());
    await waitFor(() => expect(gitFinishLocalPrUpdate).toHaveBeenCalled());
    expect(vi.mocked(gitFinishLocalPrUpdate).mock.calls[0][1]).toBe("release");
  });

  it("an approved finish names the approval; a switched-away one names the repo", async () => {
    const user = userEvent.setup();
    const answer =
      deferred<Awaited<ReturnType<typeof gitFinishLocalPrUpdate>>>();
    vi.mocked(gitFinishLocalPrUpdate).mockReturnValue(answer.promise);
    vi.mocked(updateLocalPr).mockImplementation(async (_repo, _id, mutate) => {
      const next = mutate(makePr({ approved: true }));
      written.push(next);
      return next;
    });
    renderEditor({ pr: makePr({ approved: true }) });
    await waitFor(() =>
      expect(finishButton()).not.toHaveAttribute("aria-disabled"),
    );
    await user.click(finishButton());
    // While finishing, the label alone names the button.
    await waitFor(() =>
      expect(finishButton()).toHaveAttribute("aria-disabled", "true"),
    );
    expect(finishButton()).toHaveAccessibleName("Finish update");
    act(() => useUiStore.setState({ repoPath: "C:/other" }));
    await act(async () =>
      answer.resolve({
        status: "updated",
        conflicts: [],
        headTip: "abc1234",
        worktreePath: null,
        worktreeId: null,
        opId: "op-1",
        journalRepo: REPO,
      }),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Updated feat from main in repo. Approval cleared because the branch changed.",
      ),
    );
    expect(written[0].approved).toBe(false);
  });

  it("a refused finish toasts the error and keeps the editor", async () => {
    const user = userEvent.setup();
    const err = new Error("Resolve every conflict first");
    vi.mocked(gitFinishLocalPrUpdate).mockRejectedValue(err);
    renderEditor();
    await waitFor(() =>
      expect(finishButton()).not.toHaveAttribute("aria-disabled"),
    );
    await user.click(finishButton());
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(err));
    expect(updateLocalPr).not.toHaveBeenCalled();
    expect(finishButton()).toBeInTheDocument();
    expect(screen.getByText(/^Merging/)).toBeInTheDocument();
  });

  it("Discard confirms with the update's copy; Cancel runs nothing", async () => {
    const user = userEvent.setup();
    const ask = vi.fn(async () => false);
    useConfirm.setState({ ask });
    renderEditor();
    await screen.findByText(/^Merging/);
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Discard this update?",
        body: "The conflict resolution is thrown away; your branch and working tree are untouched.",
        confirmLabel: "Discard update",
      }),
    );
    await act(async () => undefined);
    expect(gitDiscardLocalPrUpdate).not.toHaveBeenCalled();
    expect(updateLocalPr).not.toHaveBeenCalled();
  });

  it("a confirmed Discard discards and says so", async () => {
    const user = userEvent.setup();
    useConfirm.setState({ ask: vi.fn(async () => true) });
    vi.mocked(gitDiscardLocalPrUpdate).mockResolvedValue({
      status: "discarded",
    });
    renderEditor();
    await screen.findByText(/^Merging/);
    await user.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Update discarded"),
    );
    expect(gitDiscardLocalPrUpdate).toHaveBeenCalledWith(
      REPO,
      "feat",
      WT,
      "0123456789ab",
      "op-1",
      "C:/repo-checkout",
    );
  });

  it("a discard that finds the update landed toasts the finish", async () => {
    const user = userEvent.setup();
    useConfirm.setState({ ask: vi.fn(async () => true) });
    vi.mocked(gitDiscardLocalPrUpdate).mockResolvedValue({ status: "updated" });
    vi.mocked(updateLocalPr).mockImplementation(async (_repo, _id, mutate) => {
      const next = mutate(makePr({ approved: true }));
      written.push(next);
      return next;
    });
    renderEditor({ pr: makePr({ approved: true }) });
    await screen.findByText(/^Merging/);
    await user.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Updated feat from main. Approval cleared because the branch changed.",
      ),
    );
    expect(toast.success).not.toHaveBeenCalledWith("Update discarded");
  });

  it("an unreadable worktree says so in both slots and holds only Finish", async () => {
    vi.mocked(gitStatus).mockRejectedValue(new Error("no such directory"));
    renderEditor({ onBack: vi.fn() });
    await waitFor(() =>
      expect(screen.getAllByText(UNREADABLE, { selector: "div" })).toHaveLength(
        2,
      ),
    );
    expect(finishButton()).toHaveAttribute("aria-disabled", "true");
    expect(finishButton()).toHaveAccessibleDescription(UNREADABLE);
    expect(screen.getByRole("button", { name: "Discard" })).not.toHaveAttribute(
      "aria-disabled",
    );
    expect(
      screen.getByRole("button", { name: "Back to PR" }),
    ).not.toHaveAttribute("aria-disabled");
  });
});

describe("ResolveConflictsView, merge mode (parity)", () => {
  const MERGE = {
    base: "main",
    head: "feat",
    strategy: "merge" as const,
    message: "m",
    worktreePath: WT,
    worktreeId: "0123456789ab",
    opId: "op-m",
    startedAt: "2026-01-01T00:00:00Z",
  };

  it("the into-base flow keeps its copy and commands", async () => {
    const user = userEvent.setup();
    const ask = vi.fn(async () => false);
    useConfirm.setState({ ask });
    const answer = deferred<never>();
    vi.mocked(gitFinishLocalPrMerge).mockReturnValue(answer.promise);
    renderEditor({
      mode: "merge",
      pr: makePr({ pendingUpdate: undefined, pendingMerge: MERGE }),
    });
    const sentence = await screen.findByText(/^Resolving conflicts/);
    expect(sentence).toHaveTextContent("Resolving conflicts · feat → main");
    expect(sentence).toHaveClass("truncate");
    expect(screen.queryByRole("button", { name: "Back to PR" })).toBeNull();
    expect(screen.getByRole("button", { name: "Abort" })).toBeInTheDocument();
    const done = "All conflicts resolved — Finish to complete the merge.";
    await waitFor(() => expect(screen.getAllByText(done)).toHaveLength(2));
    await user.click(screen.getByRole("button", { name: "Abort" }));
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Discard this merge?" }),
    );
    await user.click(finishButton());
    await waitFor(() => expect(gitFinishLocalPrMerge).toHaveBeenCalled());
    expect(gitFinishLocalPrUpdate).not.toHaveBeenCalled();
    // The one deliberate change: the busy spinner is hidden from the name.
    await waitFor(() =>
      expect(finishButton()).toHaveAttribute("aria-disabled", "true"),
    );
    expect(finishButton()).toHaveAccessibleName("Finish merge");
  });

  it("a record carrying an update too still names the merge's branches", async () => {
    renderEditor({
      mode: "merge",
      pr: makePr({
        pendingMerge: MERGE,
        pendingUpdate: { ...UPDATE, base: "develop", head: "feat-old" },
      }),
    });
    const sentence = await screen.findByText(/^Resolving conflicts/);
    expect(sentence).toHaveTextContent("Resolving conflicts · feat → main");
  });

  /** Confirms Abort on a paused merge whose abort command answers with `aborted`,
   *  over a fresh record that differs from the shown one by `fresh`. */
  async function abortMerge(
    aborted: { removed: boolean; closed: boolean },
    fresh: Partial<LocalPr> = {},
  ) {
    const user = userEvent.setup();
    useConfirm.setState({ ask: vi.fn(async () => true) });
    vi.mocked(gitAbortLocalPrMerge).mockResolvedValue(aborted);
    vi.mocked(updateLocalPr).mockImplementation(async (_repo, _id, mutate) => {
      const next = mutate(
        makePr({ pendingUpdate: undefined, pendingMerge: MERGE, ...fresh }),
      );
      written.push(next);
      return next;
    });
    renderEditor({
      mode: "merge",
      pr: makePr({ pendingUpdate: undefined, pendingMerge: MERGE }),
    });
    await screen.findByText(/^Resolving conflicts/);
    await user.click(screen.getByRole("button", { name: "Abort" }));
    await waitFor(() => expect(gitAbortLocalPrMerge).toHaveBeenCalledTimes(1));
    await act(async () => new Promise((r) => setTimeout(r, 20)));
  }

  it("an abort that removed the worktree and closed the merge says it was discarded", async () => {
    await abortMerge({ removed: true, closed: true });
    expect(toast.success).toHaveBeenCalledWith("Merge discarded");
    expect(written).toHaveLength(1);
    expect(written[0].pendingMerge).toBeUndefined();
    expect(written[0].status).toBe("open");
  });

  it("an abort that left the worktree keeps the record and says it is still there", async () => {
    await abortMerge({ removed: false, closed: false });
    expect(toastError).toHaveBeenCalledWith(
      expect.objectContaining({ message: MERGE_ABORT_KEPT }),
    );
    expect(toast.success).not.toHaveBeenCalledWith("Merge discarded");
    expect(updateLocalPr).not.toHaveBeenCalled();
  });

  it("an abort whose entry was already closed clears the merge and claims no finish", async () => {
    await abortMerge({ removed: true, closed: false });
    expect(toast.success).toHaveBeenCalledWith("Merge discarded", {
      description: MERGE_ENTRY_ALREADY_CLOSED,
    });
    expect(written).toHaveLength(1);
    expect(written[0].pendingMerge).toBeUndefined();
    expect(written[0].status).toBe("open");
    expect(written[0].mergedAt).toBeUndefined();
  });

  it("an abort whose entry was already closed keeps a merged status another window wrote", async () => {
    const mergedAt = "2026-01-02T00:00:00Z";
    await abortMerge(
      { removed: true, closed: false },
      { status: "merged", mergedAt },
    );
    expect(written).toHaveLength(1);
    expect(written[0].pendingMerge).toBeUndefined();
    expect(written[0].status).toBe("merged");
    expect(written[0].mergedAt).toBe(mergedAt);
  });

  it("an errored status read shows no unreadable line in merge mode", async () => {
    vi.mocked(gitStatus).mockRejectedValue(new Error("gone"));
    renderEditor({
      mode: "merge",
      pr: makePr({ pendingUpdate: undefined, pendingMerge: MERGE }),
    });
    await screen.findByText(/^Resolving conflicts/);
    await waitFor(() => expect(gitStatus).toHaveBeenCalled());
    await act(async () => new Promise((r) => setTimeout(r, 30)));
    expect(screen.queryByText(UNREADABLE)).toBeNull();
  });
});

/** One usePush binding per file: the usePush scan reads a second `const push`
 *  as a use of the first. */
function PushHarness({
  branch,
  path,
}: {
  branch: "feat" | "main" | "dev";
  path: string;
}) {
  const push = usePush(path);
  return (
    <button
      type="button"
      onClick={() => {
        if (branch === "feat")
          void push.mutateAsync({ setUpstream: false, branch: "feat" });
        else if (branch === "main")
          void push.mutateAsync({ setUpstream: false, branch: "main" });
        else void push.mutateAsync({ setUpstream: false, branch: "dev" });
      }}
    >
      start {branch} in {path}
    </button>
  );
}

describe("ResolveConflictsView's Finish while the moved branch pushes", () => {
  const MERGE = {
    base: "main",
    head: "feat",
    strategy: "merge" as const,
    message: "m",
    worktreePath: WT,
    worktreeId: "0123456789ab",
    opId: "op-m",
    startedAt: "2026-01-01T00:00:00Z",
  };
  const MODES = {
    update: {
      pr: makePr(),
      moved: "feat",
      finish: gitFinishLocalPrUpdate,
      done: "All conflicts resolved. Finish update to apply the merge to feat.",
    },
    merge: {
      pr: makePr({ pendingUpdate: undefined, pendingMerge: MERGE }),
      moved: "main",
      finish: gitFinishLocalPrMerge,
      done: "All conflicts resolved — Finish to complete the merge.",
    },
  } as const;

  /** The editor in `mode`, with a push of `branch` from `path` left pending in
   *  its cache, once Finish is live. */
  async function renderWithPush(
    mode: "update" | "merge",
    branch: "feat" | "main" | "dev",
    path: string,
  ) {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <PushHarness branch={branch} path={path} />
        <ResolveConflictsView repoPath={REPO} pr={MODES[mode].pr} mode={mode} />
      </QueryClientProvider>,
    );
    // The identity must land first: a push filed without it is path-keyed.
    await waitFor(() =>
      expect(
        client.getQueryData(repoIdentityQueryOptions(path).queryKey),
      ).toBeDefined(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: `start ${branch} in ${path}` }),
    );
    await waitFor(() =>
      expect(
        client.getMutationCache().findAll({ status: "pending" }),
      ).toHaveLength(1),
    );
    await waitFor(() =>
      expect(finishButton()).not.toHaveAttribute("aria-disabled"),
    );
  }

  for (const mode of ["update", "merge"] as const)
    for (const [where, path, message] of [
      ["this checkout", REPO, BRANCH_PUSH_ACTIVE_MESSAGE],
      ["another worktree", "C:/repo-wt", BRANCH_PUSH_ELSEWHERE_MESSAGE],
    ] as const)
      it(`${mode} mode: a push of the moved branch in ${where} refuses and keeps the editor`, async () => {
        const { moved, finish, done } = MODES[mode];
        await renderWithPush(mode, moved, path);
        await userEvent.click(finishButton());
        expect(toast.info).toHaveBeenCalledWith(message);
        expect(finish).not.toHaveBeenCalled();
        expect(updateLocalPr).not.toHaveBeenCalled();
        expect(finishButton()).not.toHaveAttribute("aria-disabled");
        expect(
          screen.getAllByText((_t, el) => el?.textContent === done),
        ).not.toHaveLength(0);
      });

  it("a push of another branch lets Finish run", async () => {
    vi.mocked(gitFinishLocalPrUpdate).mockReturnValue(
      new Promise(() => undefined),
    );
    await renderWithPush("update", "dev", "C:/repo-wt");
    await userEvent.click(finishButton());
    await waitFor(() => expect(gitFinishLocalPrUpdate).toHaveBeenCalled());
    expect(toast.info).not.toHaveBeenCalled();
  });
});
