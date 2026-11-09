import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommitDetailView } from "@/features/history/CommitDetailView";
import {
  AMEND_HOLD_HINT,
  OP_IN_PROGRESS_HINT,
} from "@/features/history/commit-confirms";
import { RESOLVE_CONFLICTS_HINT } from "@/features/history/edit-dates-route";
import {
  commitOnRemote,
  forgeCommitComments,
  forgeCommitDiff,
  forgeStatus,
  ghCommitAuthorAvatars,
  gitAmendCommitDates,
  gitCommitDetails,
  gitCommitFileDiff,
  gitCommitFiles,
  gitLog,
  gitOpState,
  gitStatus,
  readRepoBranchRules,
} from "@/lib/git/api";
import { repoStatusOptions } from "@/lib/git/queries";
import type { CommitSummary, ForgeStatus, RepoStatus } from "@/lib/git/types";
import {
  type HandlerEntry,
  registerHandler,
  unregisterHandler,
} from "@/lib/hotkeys/handler-registry";
import { useUiStore } from "@/lib/stores/ui";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  commitOnRemote: vi.fn(),
  forgeCommitComments: vi.fn(),
  forgeCommitDiff: vi.fn(),
  forgeStatus: vi.fn(),
  ghCommitAuthorAvatars: vi.fn(),
  gitAmendCommitDates: vi.fn(),
  gitCommitDetails: vi.fn(),
  gitCommitFileDiff: vi.fn(),
  gitCommitFiles: vi.fn(),
  gitLog: vi.fn(),
  gitOpState: vi.fn(),
  gitStatus: vi.fn(),
  readRepoBranchRules: vi.fn(),
}));
// The actions menu is under test, not the diff pane.
vi.mock("@/features/diff/DiffSurfaceLazy", () => ({
  DiffSurface: () => null,
  DiffContent: () => null,
}));

const REPO = "/repo";
/** Non-zero hex, so the oid-width guard never reads a zero run. */
const HASH = "abcdef0123".repeat(4);
const OTHER = `b${HASH.slice(1)}`;

const ALL_ON = new Proxy({}, { get: () => true });

const never = <T,>() => new Promise<T>(() => undefined);

const summary = (hash: string): CommitSummary => ({
  hash,
  subject: "the subject",
  author: "Ada",
  authorEmail: "ada@example.com",
  date: "2026-01-01T10:00:00Z",
  tags: [],
  isMerge: false,
});

/** Serves a status naming `head` as HEAD on `main`, under a log topped by
 *  `logTop` (agreeing by default). */
function serveHead(
  head: string,
  logTop = head,
  entries: RepoStatus["entries"] = [],
) {
  vi.mocked(gitLog).mockResolvedValue([summary(logTop), summary(`c${logTop}`)]);
  vi.mocked(gitStatus).mockResolvedValue({
    branch: {
      name: "main",
      detached: false,
      oid: head,
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
    },
    entries,
  } satisfies RepoStatus);
}

let handler: HandlerEntry | null = null;

beforeEach(() => {
  unmockedCommands.length = 0;
  vi.mocked(forgeStatus).mockResolvedValue({
    provider: "github",
    installed: true,
    authenticated: true,
    repo: "octo/repo",
    host: "github.com",
    login: "octo",
    capabilities: ALL_ON,
    implemented: ALL_ON,
  } as unknown as ForgeStatus);
  vi.mocked(commitOnRemote).mockResolvedValue(true);
  vi.mocked(forgeCommitDiff).mockResolvedValue("");
  vi.mocked(forgeCommitComments).mockResolvedValue([]);
  vi.mocked(readRepoBranchRules).mockResolvedValue(null);
  vi.mocked(ghCommitAuthorAvatars).mockResolvedValue([]);
  // Answers for the commit asked, so the dialog's read of HEAD's parent lands.
  vi.mocked(gitCommitDetails).mockImplementation(async (_repo, hash) => ({
    hash,
    subject: "the subject",
    body: "",
    author: "Ada",
    authorEmail: "ada@example.com",
    date: "2026-01-01T10:00:00Z",
    committerDate: "2026-01-01T10:00:00Z",
  }));
  vi.mocked(gitCommitFiles).mockResolvedValue([]);
  vi.mocked(gitCommitFileDiff).mockImplementation(never);
  vi.mocked(gitOpState).mockResolvedValue({
    merging: false,
    rebasing: false,
    cherryPicking: false,
    reverting: false,
    editPaused: false,
    rebaseStop: null,
  });
  useUiStore.setState({
    repoPath: REPO,
    selectedCommitHash: null,
    repoTab: "history",
  });
});

afterEach(() => {
  if (handler) unregisterHandler("edit-commit-dates", handler);
  handler = null;
  expect(unmockedCommands).toEqual([]);
});

/** Stands in for History's palette route, live and enabled. */
function liveHistoryRoute() {
  handler = { run: vi.fn(), enabled: true };
  registerHandler("edit-commit-dates", handler);
  return handler.run;
}

/** Renders the view, opens its actions menu once the log and status agree,
 *  and returns the Edit dates row. */
async function editDatesItem(
  settled: (item: HTMLElement) => void,
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  render(
    <QueryClientProvider client={client}>
      <CommitDetailView repoPath={REPO} hash={HASH} />
    </QueryClientProvider>,
  );
  const trigger = await screen.findByRole("button", {
    name: "Commit actions",
  });
  await userEvent.click(trigger);
  const item = await screen.findByRole("menuitem", { name: /^Edit dates…/ });
  await waitFor(() => settled(item));
  return item;
}

describe("CommitDetailView Edit dates…", () => {
  it("on HEAD opens the Edit dates dialog prefilled from the commit", async () => {
    serveHead(HASH);
    const item = await editDatesItem((i) =>
      expect(i).not.toHaveAttribute("aria-disabled", "true"),
    );
    expect(item).toHaveTextContent(/^Edit dates…$/);
    await userEvent.click(item);
    const dialog = await screen.findByRole("dialog", { name: "Edit dates" });
    expect(dialog).toHaveTextContent(HASH.slice(0, 7));
    expect(await screen.findByLabelText("Author date")).toHaveValue(
      "2026-01-01 10:00:00 +00:00",
    );
    expect(
      screen.getByRole("checkbox", { name: /same as author date/i }),
    ).toBeChecked();
  });

  it("off HEAD dispatches History's route for History's selected commit", async () => {
    serveHead(OTHER);
    useUiStore.setState({ selectedCommitHash: HASH });
    const run = liveHistoryRoute();
    const item = await editDatesItem((i) =>
      expect(i).not.toHaveAttribute("aria-disabled", "true"),
    );
    expect(item).toHaveTextContent(/^Edit dates…$/);
    await userEvent.click(item);
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog", { name: "Edit dates" })).toBeNull();
  });

  it.each([
    ["no History route is live", () => undefined],
    [
      "History has another commit selected",
      () => {
        useUiStore.setState({ selectedCommitHash: OTHER });
        liveHistoryRoute();
      },
    ],
  ])("off HEAD is held with its reason when %s", async (_name, arrange) => {
    serveHead(OTHER);
    arrange();
    const item = await editDatesItem((i) =>
      expect(i).toHaveTextContent(
        /^Edit dates… \(only the latest commit, or an unpushed commit in History\)$/,
      ),
    );
    expect(item).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(item);
    expect(handler?.run ?? vi.fn()).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Edit dates" })).toBeNull();
  });

  // Control: drop the History-row arm of the hint; the item falls through to
  // "only the latest commit, or an unpushed commit in History".
  it("off HEAD points at History's row when the commit is its selection but no route is live", async () => {
    serveHead(OTHER);
    useUiStore.setState({ selectedCommitHash: HASH });
    const item = await editDatesItem((i) =>
      expect(i).toHaveTextContent(/^Edit dates… \(see its row in History\)$/),
    );
    expect(item).toHaveAttribute("aria-disabled", "true");
  });

  // Control: drop the History-tab arm of the row hint; Compare's view points at
  // a History row that isn't on screen.
  it("off HEAD outside the History tab gives the general reason for History's selection", async () => {
    serveHead(OTHER);
    useUiStore.setState({ selectedCommitHash: HASH, repoTab: "compare" });
    const item = await editDatesItem((i) =>
      expect(i).toHaveTextContent(
        /^Edit dates… \(only the latest commit, or an unpushed commit in History\)$/,
      ),
    );
    expect(item).toHaveAttribute("aria-disabled", "true");
  });

  // Control: drop the trigger's landing in landFocus; focus falls elsewhere.
  it("after Change dates selects the rewritten commit and focuses Commit actions", async () => {
    const NEW = "0123456789".repeat(4);
    serveHead(HASH);
    useUiStore.setState({ selectedCommitHash: HASH });
    vi.mocked(gitAmendCommitDates).mockResolvedValue(NEW);
    const item = await editDatesItem((i) =>
      expect(i).not.toHaveAttribute("aria-disabled", "true"),
    );
    await userEvent.click(item);
    const field = await screen.findByLabelText("Author date");
    await userEvent.clear(field);
    await userEvent.type(field, "2026-01-02 10:00:00 +00:00");
    await userEvent.click(screen.getByRole("button", { name: /Change dates/ }));
    await waitFor(() => expect(gitAmendCommitDates).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Edit dates" })).toBeNull(),
    );
    expect(useUiStore.getState().selectedCommitHash).toBe(NEW);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Commit actions" }),
      ).toHaveFocus(),
    );
  });

  describe("the deferred landing on Commit actions", () => {
    const NEW = "0123456789".repeat(4);
    /** A commit whose details fail: the error arm unmounts the trigger. */
    const GONE = `d${HASH.slice(1)}`;
    let settle: (v: string) => void = () => undefined;

    beforeEach(() => {
      serveHead(HASH);
      useUiStore.setState({ selectedCommitHash: HASH });
      vi.mocked(gitCommitDetails).mockImplementation(async (_repo, hash) => {
        if (hash === GONE) throw new Error("gone");
        return {
          hash,
          subject: "the subject",
          body: "",
          author: "Ada",
          authorEmail: "ada@example.com",
          date: "2026-01-01T10:00:00Z",
          committerDate: "2026-01-01T10:00:00Z",
        };
      });
      vi.mocked(gitAmendCommitDates).mockImplementation(
        () =>
          new Promise<string>((r) => {
            settle = r;
          }),
      );
    });

    function view(client: QueryClient, hash: string, repo = REPO) {
      return (
        <QueryClientProvider client={client}>
          <button type="button">Elsewhere</button>
          <CommitDetailView repoPath={repo} hash={hash} />
        </QueryClientProvider>
      );
    }

    /** Opens Edit dates, sends a change, and leaves it pending. */
    async function pendingChange(client: QueryClient) {
      const utils = render(view(client, HASH));
      await userEvent.click(
        await screen.findByRole("button", { name: "Commit actions" }),
      );
      const item = await screen.findByRole("menuitem", {
        name: /^Edit dates…/,
      });
      await waitFor(() =>
        expect(item).not.toHaveAttribute("aria-disabled", "true"),
      );
      await userEvent.click(item);
      const field = await screen.findByLabelText("Author date");
      await userEvent.clear(field);
      await userEvent.type(field, "2026-01-02 10:00:00 +00:00");
      await userEvent.click(
        screen.getByRole("button", { name: /Change dates/ }),
      );
      await waitFor(() => expect(gitAmendCommitDates).toHaveBeenCalled());
      return utils;
    }

    // Control: arm the landing whatever `closed` says; the trigger's next
    // render takes focus from the body.
    it("arms nothing for a change that lands after Esc dismissed the dialog", async () => {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      await pendingChange(client);
      await userEvent.keyboard("{Escape}");
      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: "Edit dates" })).toBeNull(),
      );
      // On the body, where a deferred landing would take it.
      (document.activeElement as HTMLElement).blur();
      settle(NEW);
      await waitFor(() =>
        expect(useUiStore.getState().selectedCommitHash).toBe(NEW),
      );
      await act(() => new Promise((r) => setTimeout(r, 20)));
      expect(
        screen.getByRole("button", { name: "Commit actions" }),
      ).not.toHaveFocus();
    });

    // Control: drop the ref callback's clear; the render after focus returns
    // to the body takes it.
    it("drops the landing once focus moved to another control", async () => {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const { rerender } = await pendingChange(client);
      // The view leaves its content arm, taking the dialog with it, so the
      // change's close finds no trigger to land on.
      rerender(view(client, GONE));
      await screen.findByText("Could not load this commit");
      settle(NEW);
      await waitFor(() =>
        expect(useUiStore.getState().selectedCommitHash).toBe(NEW),
      );
      screen.getByRole("button", { name: "Elsewhere" }).focus();
      rerender(view(client, HASH));
      const first = await screen.findByRole("button", {
        name: "Commit actions",
      });
      expect(first).not.toHaveFocus();
      // Focus back on the body; the next render re-runs the trigger's ref.
      (document.activeElement as HTMLElement).blur();
      rerender(view(client, HASH));
      await act(() => new Promise((r) => setTimeout(r, 20)));
      expect(
        screen.getByRole("button", { name: "Commit actions" }),
      ).not.toHaveFocus();
    });

    // Control: drop the ref callback's repo check; the other repo's trigger
    // takes focus from the body.
    it("drops the landing when the same view mounts its trigger for another repo", async () => {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const { rerender } = await pendingChange(client);
      rerender(view(client, GONE));
      await screen.findByText("Could not load this commit");
      settle(NEW);
      await waitFor(() =>
        expect(useUiStore.getState().selectedCommitHash).toBe(NEW),
      );
      (document.activeElement as HTMLElement).blur();
      rerender(view(client, HASH, "/other"));
      await screen.findByRole("button", { name: "Commit actions" });
      await act(() => new Promise((r) => setTimeout(r, 20)));
      expect(
        screen.getByRole("button", { name: "Commit actions" }),
      ).not.toHaveFocus();
    });
  });

  it("holds HEAD with History's reason while an operation is in progress", async () => {
    serveHead(HASH);
    vi.mocked(gitOpState).mockResolvedValue({
      merging: true,
      rebasing: false,
      cherryPicking: false,
      reverting: false,
      editPaused: false,
      rebaseStop: null,
    });
    const item = await editDatesItem((i) =>
      expect(i).toHaveTextContent(`Edit dates…${OP_IN_PROGRESS_HINT}`),
    );
    expect(item).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(item);
    expect(screen.queryByRole("dialog", { name: "Edit dates" })).toBeNull();
  });

  it("holds HEAD with Undo's reason on unmerged entries", async () => {
    serveHead(HASH, HASH, [
      { path: "a.txt", staged: "conflicted", unstaged: null },
    ]);
    const item = await editDatesItem((i) =>
      expect(i).toHaveTextContent(`Edit dates…${RESOLVE_CONFLICTS_HINT}`),
    );
    expect(item).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(item);
    expect(screen.queryByRole("dialog", { name: "Edit dates" })).toBeNull();
  });

  it.each([
    [
      "the log's top isn't status's HEAD yet",
      () => serveHead(OTHER, HASH),
      AMEND_HOLD_HINT.refreshing,
    ],
    [
      "the log couldn't be read",
      () => {
        serveHead(OTHER);
        vi.mocked(gitLog).mockRejectedValue(new Error("log failed"));
      },
      AMEND_HOLD_HINT["log-unread"],
    ],
  ])("waits with Amend's reason when %s", async (_name, arrange, hint) => {
    arrange();
    const item = await editDatesItem((i) =>
      expect(i).toHaveTextContent(`Edit dates…${hint}`),
    );
    expect(item).toHaveAttribute("aria-disabled", "true");
  });

  it("opens nothing when the cached HEAD moved past the rendered one", async () => {
    serveHead(HASH);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const item = await editDatesItem(
      (i) => expect(i).not.toHaveAttribute("aria-disabled", "true"),
      client,
    );
    // The cache moves; the click lands before the batched re-render does.
    client.setQueryData<RepoStatus>(
      repoStatusOptions(REPO).queryKey,
      (old) =>
        old && { ...old, branch: old.branch && { ...old.branch, oid: OTHER } },
    );
    fireEvent.click(item);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(screen.queryByRole("dialog", { name: "Edit dates" })).toBeNull();
  });
});
