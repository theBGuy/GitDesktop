// Negative controls (run once, reverted): dropping the `data.hash === shown.hash`
// guard in EditDatesDialog prefills the placeholder case; dropping the live-repo
// check after the await calls onDatesChanged in the switched case.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativePickers } from "@/features/history/CommitDateField";
import {
  EditDatesDialog,
  type EditDatesTarget,
} from "@/features/history/EditDatesDialog";
import {
  gitAmendCommitDates,
  gitCommitDetails,
  gitCommitRecordsParent,
  gitLog,
  gitOpState,
  gitStatus,
} from "@/lib/git/api";
import { repoKeys } from "@/lib/git/queries";
import type { CommitDetails, CommitSummary, RepoStatus } from "@/lib/git/types";
import { useConfirm } from "@/lib/stores/confirm";
import { useUiStore } from "@/lib/stores/ui";

const flags = vi.hoisted(() => ({ rulesSettling: false, blocked: false }));

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitStatus: vi.fn(),
  gitCommitDetails: vi.fn(),
  gitCommitRecordsParent: vi.fn(),
  gitLog: vi.fn(),
  gitOpState: vi.fn(),
  gitAmendCommitDates: vi.fn(),
}));

vi.mock("@/lib/branch-rules/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/branch-rules/queries")>()),
  useEffectiveBranchRules: () => ({}),
  useEffectiveBranchRulesSettling: () => flags.rulesSettling,
}));

vi.mock("@/lib/branch-rules/match", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/branch-rules/match")>()),
  isForcePushBlocked: () => flags.blocked,
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  }),
  Toaster: () => null,
}));

const REPO = "/repo-a";
const HASH = "abcdef0123".repeat(4);
const NEW_HASH = "0123456789".repeat(4);

const status = (over: Partial<NonNullable<RepoStatus["branch"]>> = {}) =>
  ({
    branch: {
      name: "main",
      detached: false,
      oid: HASH,
      upstream: "origin/main",
      ahead: 1,
      behind: 0,
      upstreamGone: false,
      upstreamRemote: "origin",
      upstreamBranch: "main",
      pushNameMismatch: false,
      upstreamIsRemoteDefault: true,
      pushRemote: "origin",
      pushBranch: "main",
      ...over,
    },
    entries: [],
  }) satisfies RepoStatus;

const details = (over: Partial<CommitDetails> = {}): CommitDetails => ({
  hash: HASH,
  subject: "Add the thing",
  body: "",
  author: "Ann",
  authorEmail: "ann@example.com",
  date: "2026-11-07T23:58:04+01:00",
  committerDate: "2026-11-07T23:58:04+01:00",
  ...over,
});

const PARENT = "fedcba9876".repeat(4);

const logRow = (hash: string, isMerge = false): CommitSummary => ({
  hash,
  subject: "a commit",
  author: "Ann",
  authorEmail: "ann@example.com",
  date: "2026-11-07T20:00:00+01:00",
  tags: [],
  isMerge,
});

const opIdle = {
  merging: false,
  rebasing: false,
  cherryPicking: false,
  reverting: false,
  editPaused: false,
  rebaseStop: null,
};

const onDatesChanged = vi.fn();

function Host() {
  const [target, setTarget] = useState<EditDatesTarget | null>({
    hash: HASH,
    repo: REPO,
    expectedHead: HASH,
    expectedBranch: "main",
  });
  return (
    <>
      <output data-testid="open">{String(target !== null)}</output>
      <EditDatesDialog
        repoPath={REPO}
        target={target}
        onClose={() => setTarget(null)}
        onDatesChanged={onDatesChanged}
      />
    </>
  );
}

function renderHost() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <Host />
      </QueryClientProvider>,
    ),
  };
}

/** Waits until the details read has answered and that answer has rendered. */
async function detailsSettled(client: QueryClient) {
  await waitFor(() =>
    expect(
      client.getQueryState(repoKeys.commitDetails(REPO, HASH))?.status,
    ).toBe("success"),
  );
  // react-query notifies on a macrotask; let that render land.
  await act(() => new Promise((r) => setTimeout(r, 20)));
}

const primary = () => screen.getByRole("button", { name: /Change dates/ });
const authorField = () => screen.findByLabelText("Author date");

async function retype(field: HTMLElement, text: string) {
  const user = userEvent.setup();
  await user.clear(field);
  await user.type(field, text);
}

beforeEach(() => {
  flags.rulesSettling = false;
  flags.blocked = false;
  onDatesChanged.mockReset();
  vi.mocked(gitStatus).mockReset().mockResolvedValue(status());
  vi.mocked(gitCommitDetails).mockReset().mockResolvedValue(details());
  // A lone root commit by default: no parent, so nothing is judged.
  vi.mocked(gitLog)
    .mockReset()
    .mockResolvedValue([logRow(HASH)]);
  vi.mocked(gitCommitRecordsParent).mockReset().mockResolvedValue(false);
  vi.mocked(gitOpState).mockReset().mockResolvedValue(opIdle);
  useConfirm.setState({ request: null, requestHold: null });
  vi.mocked(gitAmendCommitDates).mockReset().mockResolvedValue(NEW_HASH);
  vi.mocked(toast.success).mockReset();
  useUiStore.setState({ repoPath: REPO, selectedCommitHash: HASH });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Edit dates dialog", () => {
  it("prefills equal dates in their own offset with one field", async () => {
    renderHost();
    expect(await authorField()).toHaveValue("2026-11-07 23:58:04 +01:00");
    expect(
      screen.getByRole("checkbox", { name: /same as author date/i }),
    ).toBeChecked();
    expect(screen.queryByLabelText("Committer date")).toBeNull();
    expect(primary()).toHaveAttribute("aria-disabled", "true");
  });

  it("prefills differing dates unticked with both fields", async () => {
    vi.mocked(gitCommitDetails).mockResolvedValue(
      details({ committerDate: "2026-11-08T01:02:03-08:00" }),
    );
    renderHost();
    await authorField();
    expect(screen.getByLabelText("Committer date")).toHaveValue(
      "2026-11-08 01:02:03 -08:00",
    );
    expect(
      screen.getByRole("checkbox", { name: /same as author date/i }),
    ).not.toBeChecked();
  });

  it("never prefills from another commit's details", async () => {
    vi.mocked(gitCommitDetails).mockResolvedValue(details({ hash: NEW_HASH }));
    const { client } = renderHost();
    await detailsSettled(client);
    expect(screen.queryByLabelText("Author date")).toBeNull();
    expect(primary()).toHaveAttribute("aria-disabled", "true");
  });

  it.each([
    ["year 2100", { committerDate: "2100-01-01T00:00:00+00:00" }],
    ["garbage", { date: "not a date" }],
  ])("says the dates can't be read for a %s date", async (_name, over) => {
    vi.mocked(gitCommitDetails).mockResolvedValue(details(over));
    renderHost();
    expect(
      await screen.findAllByText("This commit's dates can't be read here."),
    ).not.toHaveLength(0);
    expect(screen.queryByLabelText("Author date")).toBeNull();
    expect(primary()).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(primary());
    expect(gitAmendCommitDates).not.toHaveBeenCalled();
  });

  it("shows the unpushed line, the force-push warning, and the branch rule", async () => {
    const { unmount } = renderHost();
    expect(
      await screen.findByText("Rewrites this commit; its id changes."),
    ).toBeInTheDocument();
    unmount();

    vi.mocked(gitStatus).mockResolvedValue(status({ ahead: 0 }));
    const second = renderHost();
    expect(
      await screen.findByText(/This commit is already on origin\/main\./),
    ).toBeInTheDocument();
    second.unmount();

    flags.blocked = true;
    renderHost();
    await retype(await authorField(), "2026-11-08 10:00:00 +01:00");
    expect(
      await screen.findAllByText(/main is protected: force-pushing/),
    ).not.toHaveLength(0);
    expect(primary()).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(primary());
    expect(gitAmendCommitDates).not.toHaveBeenCalled();
  });

  it("holds while the branch rules settle on a pushed HEAD", async () => {
    vi.mocked(gitStatus).mockResolvedValue(status({ ahead: 0 }));
    flags.rulesSettling = true;
    renderHost();
    await retype(await authorField(), "2026-11-08 10:00:00 +01:00");
    expect(primary()).toHaveAttribute("aria-disabled", "true");
  });

  it("sends the exact dates, closes, and prunes only the old id", async () => {
    renderHost();
    await retype(await authorField(), "2026-11-08 10:00:00 +01:00");
    expect(primary()).not.toHaveAttribute("aria-disabled");
    await userEvent.click(primary());
    const sent = {
      epochSeconds: Date.UTC(2026, 10, 8, 9) / 1000,
      offsetMinutes: 60,
    };
    await waitFor(() =>
      expect(gitAmendCommitDates).toHaveBeenCalledWith(
        REPO,
        HASH,
        "main",
        sent,
        sent,
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId("open").textContent).toBe("false"),
    );
    expect(toast.success).toHaveBeenCalledWith(
      `Dates changed — ${HASH.slice(0, 7)} is now ${NEW_HASH.slice(0, 7)}`,
    );
    expect(useUiStore.getState().selectedCommitHash).toBe(NEW_HASH);
    expect(onDatesChanged).toHaveBeenCalledTimes(1);
    expect(onDatesChanged).toHaveBeenCalledWith(HASH, NEW_HASH, true);
  });

  // Control: land through selectCommit; the landing advances the epoch.
  it("lands the rewrite without advancing the interaction epoch", async () => {
    let settle: (v: string) => void = () => undefined;
    vi.mocked(gitAmendCommitDates).mockImplementation(
      () =>
        new Promise<string>((r) => {
          settle = r;
        }),
    );
    renderHost();
    await retype(await authorField(), "2026-11-08 10:00:00 +01:00");
    await userEvent.click(primary());
    await waitFor(() => expect(gitAmendCommitDates).toHaveBeenCalled());
    const before = useUiStore.getState().interactionEpoch;
    settle(NEW_HASH);
    await waitFor(() => expect(onDatesChanged).toHaveBeenCalled());
    expect(useUiStore.getState().selectedCommitHash).toBe(NEW_HASH);
    expect(useUiStore.getState().interactionEpoch).toBe(before);
  });

  // Control: report `true` whatever liveTarget says; the dismissed case reads
  // as closed by the change.
  it("reports a change that lands after Esc as not closing the dialog", async () => {
    let settle: (v: string) => void = () => undefined;
    vi.mocked(gitAmendCommitDates).mockImplementation(
      () =>
        new Promise<string>((r) => {
          settle = r;
        }),
    );
    renderHost();
    await retype(await authorField(), "2026-11-08 10:00:00 +01:00");
    await userEvent.click(primary());
    await waitFor(() => expect(gitAmendCommitDates).toHaveBeenCalled());
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.getByTestId("open").textContent).toBe("false"),
    );
    settle(NEW_HASH);
    await waitFor(() =>
      expect(onDatesChanged).toHaveBeenCalledWith(HASH, NEW_HASH, false),
    );
  });

  // Control: drop the `adoptSelection &&` guard; the null selection becomes
  // the rewrite.
  it.each([
    [false, null],
    [true, NEW_HASH],
  ])(
    "with no store selection and adoptSelection=%s selects %s",
    async (adopt, want) => {
      useUiStore.setState({ repoPath: REPO, selectedCommitHash: null });
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      render(
        <QueryClientProvider client={client}>
          <EditDatesDialog
            repoPath={REPO}
            target={{
              hash: HASH,
              repo: REPO,
              expectedHead: HASH,
              expectedBranch: "main",
            }}
            onClose={() => undefined}
            onDatesChanged={onDatesChanged}
            adoptSelection={adopt}
          />
        </QueryClientProvider>,
      );
      await retype(await authorField(), "2026-11-08 10:00:00 +01:00");
      await userEvent.click(primary());
      await waitFor(() => expect(onDatesChanged).toHaveBeenCalled());
      expect(useUiStore.getState().selectedCommitHash).toBe(want);
    },
  );

  it("does not prune or report when the repo changed under the await", async () => {
    let settle: (v: string) => void = () => undefined;
    vi.mocked(gitAmendCommitDates).mockImplementation(
      () =>
        new Promise<string>((r) => {
          settle = r;
        }),
    );
    renderHost();
    await retype(await authorField(), "2026-11-08 10:00:00 +01:00");
    await userEvent.click(primary());
    await waitFor(() => expect(gitAmendCommitDates).toHaveBeenCalled());
    useUiStore.setState({ repoPath: "/repo-b", selectedCommitHash: HASH });
    settle(NEW_HASH);
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(onDatesChanged).not.toHaveBeenCalled();
    expect(useUiStore.getState().selectedCommitHash).toBe(HASH);
  });

  it("holds and sends nothing once status reports another HEAD", async () => {
    vi.mocked(gitStatus).mockResolvedValue(status({ oid: NEW_HASH }));
    renderHost();
    await retype(await authorField(), "2026-11-08 10:00:00 +01:00");
    expect(primary()).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(primary());
    expect(gitAmendCommitDates).not.toHaveBeenCalled();
  });

  it("refuses when the repo switched before the press", async () => {
    renderHost();
    await retype(await authorField(), "2026-11-08 10:00:00 +01:00");
    useUiStore.setState({ repoPath: "/repo-b" });
    await userEvent.click(primary());
    expect(gitAmendCommitDates).not.toHaveBeenCalled();
  });

  it("keeps the dialog and the typed value when the change fails", async () => {
    vi.mocked(gitAmendCommitDates).mockRejectedValue(new Error("refused"));
    renderHost();
    const field = await authorField();
    await retype(field, "2026-11-08 10:00:00 +01:00");
    await userEvent.click(primary());
    await waitFor(() => expect(gitAmendCommitDates).toHaveBeenCalled());
    expect(screen.getByTestId("open").textContent).toBe("true");
    expect(await authorField()).toHaveValue("2026-11-08 10:00:00 +01:00");
  });

  it("holds while an operation is in progress", async () => {
    vi.mocked(gitOpState).mockResolvedValue({ ...opIdle, merging: true });
    renderHost();
    await retype(await authorField(), "2026-11-08 10:00:00 +01:00");
    await waitFor(() =>
      expect(
        screen.getAllByText("Finish the operation in Changes first."),
      ).not.toHaveLength(0),
    );
    expect(primary()).toHaveAttribute("aria-disabled", "true");
  });

  // Control: drop the `unresolved` arm of holdReason; the button goes live.
  it("holds on unmerged entries with no operation stopped", async () => {
    // A `git stash pop` that conflicted: no operation, an unmerged path.
    vi.mocked(gitStatus).mockResolvedValue({
      ...status(),
      entries: [{ path: "a.txt", staged: null, unstaged: "conflicted" }],
    });
    const { client } = renderHost();
    await detailsSettled(client);
    await retype(await authorField(), "2026-11-08 10:00:00 +01:00");
    await waitFor(() =>
      expect(
        screen.getAllByText("Resolve the conflicts first."),
      ).not.toHaveLength(0),
    );
    expect(primary()).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(primary());
    expect(gitAmendCommitDates).not.toHaveBeenCalled();
  });

  it("picks a date and a time into the typed field, keeping its offset", async () => {
    vi.spyOn(nativePickers, "supported").mockReturnValue(true);
    renderHost();
    const field = await authorField();
    await retype(field, "2026-11-08 10:00:00 -05:00");
    const toggle = screen.getByRole("button", {
      name: "Pick the author date with the calendar",
    });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByLabelText("Author date, calendar date")).toBeNull();
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const day = screen.getByLabelText("Author date, calendar date");
    expect(day).toHaveValue("2026-11-08");
    fireEvent.change(day, { target: { value: "2026-12-01" } });
    expect(field).toHaveValue("2026-12-01 10:00:00 -05:00");
    fireEvent.change(screen.getByLabelText("Author date, time"), {
      target: { value: "08:30:15" },
    });
    expect(field).toHaveValue("2026-12-01 08:30:15 -05:00");
  });

  it("offers no calendar button where the webview has no native pickers", async () => {
    vi.spyOn(nativePickers, "supported").mockReturnValue(false);
    renderHost();
    await authorField();
    expect(
      screen.queryByRole("button", {
        name: "Pick the author date with the calendar",
      }),
    ).toBeNull();
  });

  it("lands on the author field when a focused Retry brings the dates", async () => {
    vi.mocked(gitCommitDetails).mockRejectedValueOnce(new Error("read boom"));
    renderHost();
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(
      screen.getAllByText("Couldn't read this commit's dates."),
    ).not.toHaveLength(0);
    await userEvent.click(retry);
    const field = await authorField();
    await waitFor(() => expect(field).toHaveFocus());
  });

  // Control: drop onSubmit's hold check; the submit sends the change. The form
  // is submitted directly: user-event's Enter goes through the held button's
  // click, which never reaches the form.
  it("never submits past a held button from a field's form submit", async () => {
    renderHost();
    const field = await authorField();
    await retype(field, "2026-02-30 10:00:00 +01:00");
    await waitFor(() =>
      expect(primary()).toHaveAccessibleDescription("Fix the date first."),
    );
    const form = field.closest("form");
    if (form === null) throw new Error("no form");
    fireEvent.submit(form);
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(gitAmendCommitDates).not.toHaveBeenCalled();
  });

  it("holds an unchanged commit with its reason", async () => {
    renderHost();
    await authorField();
    await waitFor(() =>
      expect(primary()).toHaveAccessibleDescription("Change a date first."),
    );
  });

  // Control: render the pushed block whatever status says; the unpushed line
  // shows while the read is pending.
  it("holds and shows no push line while status is unread", async () => {
    vi.mocked(gitStatus).mockReturnValue(new Promise<never>(() => undefined));
    renderHost();
    await retype(await authorField(), "2026-11-08 10:00:00 +01:00");
    expect(primary()).toHaveAccessibleDescription(
      /^Still reading this branch's state/,
    );
    expect(
      screen.queryByText("Rewrites this commit; its id changes."),
    ).toBeNull();
    expect(screen.queryByText(/This commit is already on/)).toBeNull();
  });

  it("does not prune a store selection that points at another commit", async () => {
    const other = "1234567890".repeat(4);
    useUiStore.setState({ repoPath: REPO, selectedCommitHash: other });
    renderHost();
    await retype(await authorField(), "2026-11-08 10:00:00 +01:00");
    await userEvent.click(primary());
    await waitFor(() =>
      expect(onDatesChanged).toHaveBeenCalledWith(HASH, NEW_HASH, true),
    );
    expect(useUiStore.getState().selectedCommitHash).toBe(other);
  });

  // Control: compare against the clock with no slack; Now warns as future.
  it("Now fills the current time without a future warning, Reset restores", async () => {
    renderHost();
    const field = await authorField();
    // The shared clock snapshot was taken at mount; Now reads the wall clock,
    // here 30 s past it, the most the snapshot lags before it refreshes.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 30_000);
      await userEvent.click(screen.getByRole("button", { name: "Now" }));
      expect(field).not.toHaveValue("2026-11-07 23:58:04 +01:00");
      expect((field as HTMLInputElement).value).toMatch(
        /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d\d:\d\d$/,
      );
      expect(screen.queryByText("This date is in the future.")).toBeNull();
      await userEvent.click(screen.getByRole("button", { name: "Reset" }));
      expect(field).toHaveValue("2026-11-07 23:58:04 +01:00");
    } finally {
      vi.useRealTimers();
    }
  });

  it("warns when the author date is later than the committer date", async () => {
    vi.mocked(gitCommitDetails).mockResolvedValue(
      details({ committerDate: "2026-11-07T20:00:00+01:00" }),
    );
    renderHost();
    expect(
      await screen.findByText(
        "The author date is later than the committer date.",
      ),
    ).toBeInTheDocument();
  });

  it("says why ticking can't match an author date outside the range", async () => {
    vi.mocked(gitCommitDetails).mockResolvedValue(
      details({ date: "2026-11-07T23:58:04+15:00" }),
    );
    renderHost();
    await authorField();
    const box = screen.getByRole("checkbox", { name: /same as author date/i });
    expect(box).toHaveAccessibleName("Same as author date (committer date)");
    expect(box).not.toBeChecked();
    await userEvent.click(box);
    expect(
      screen.getByText(
        "The author date is outside the editable range, so the committer date can't be set to match it.",
      ),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(primary()).toHaveAccessibleDescription("Change a date first."),
    );
  });
});

// Negative control (run once, reverted): skipping the ask in `run()` sends the
// earlier-than-parent dates with no prompt, failing the first case.
describe("Edit dates dialog against HEAD's parent", () => {
  /** HEAD over PARENT, its parent's details answered by `parent`. */
  function withParent(parent: () => Promise<CommitDetails>) {
    vi.mocked(gitLog).mockResolvedValue([logRow(HASH), logRow(PARENT)]);
    vi.mocked(gitCommitDetails).mockImplementation((_repo, hash) =>
      hash === PARENT ? parent() : Promise.resolve(details()),
    );
  }
  const parentAt = (date: string) => () =>
    Promise.resolve(details({ hash: PARENT, date, committerDate: date }));
  const EARLIER = "2026-11-07 19:00:00 +01:00";

  it("warns and asks once before dating HEAD earlier than its parent", async () => {
    withParent(parentAt("2026-11-07T20:00:00+01:00"));
    renderHost();
    await retype(await authorField(), EARLIER);
    expect(
      await screen.findByText(/^Earlier than its parent fedcba9 \(/),
    ).toBeInTheDocument();
    await waitFor(() => expect(primary()).not.toHaveAttribute("aria-disabled"));

    await userEvent.click(primary());
    await waitFor(() =>
      expect(useConfirm.getState().request?.title).toBe(
        "Rewrite with out-of-order dates?",
      ),
    );
    expect(useConfirm.getState().request?.confirmLabel).toBe("Change dates");
    act(() => useConfirm.getState().answer(false));
    await act(() => Promise.resolve());
    expect(gitAmendCommitDates).not.toHaveBeenCalled();
    expect(screen.getByTestId("open").textContent).toBe("true");

    await userEvent.click(primary());
    await waitFor(() => expect(useConfirm.getState().request).not.toBeNull());
    act(() => useConfirm.getState().answer(true));
    await waitFor(() => expect(gitAmendCommitDates).toHaveBeenCalledTimes(1));
  });

  it("sends a date after the parent's without asking", async () => {
    withParent(parentAt("2026-11-07T20:00:00+01:00"));
    renderHost();
    await retype(await authorField(), "2026-11-07 21:00:00 +01:00");
    await waitFor(() => expect(primary()).not.toHaveAttribute("aria-disabled"));
    await userEvent.click(primary());
    await waitFor(() => expect(gitAmendCommitDates).toHaveBeenCalledTimes(1));
    expect(useConfirm.getState().request).toBeNull();
  });

  it("reads no parent for a root commit and asks nothing", async () => {
    renderHost();
    await retype(await authorField(), EARLIER);
    await userEvent.click(primary());
    await waitFor(() => expect(gitAmendCommitDates).toHaveBeenCalledTimes(1));
    expect(useConfirm.getState().request).toBeNull();
    for (const [, hash] of vi.mocked(gitCommitDetails).mock.calls)
      expect(hash).toBe(HASH);
  });

  it("holds while the parent's date is read", async () => {
    withParent(() => new Promise<never>(() => undefined));
    renderHost();
    await retype(await authorField(), EARLIER);
    await waitFor(() =>
      expect(primary()).toHaveAccessibleDescription(
        "Reading the parent's date…",
      ),
    );
    expect(primary()).toHaveAttribute("aria-disabled", "true");
  });

  it("asks with the unread wording when the parent's read fails", async () => {
    withParent(() => Promise.reject(new Error("read boom")));
    renderHost();
    await retype(await authorField(), EARLIER);
    expect(
      await screen.findByText(
        "The date of its parent fedcba9 couldn't be read, so this date can't be checked against it.",
      ),
    ).toBeInTheDocument();
    await userEvent.click(primary());
    await waitFor(() =>
      expect(useConfirm.getState().request?.title).toBe(
        "Rewrite without checking the parent's date?",
      ),
    );
    expect(useConfirm.getState().request?.body).toBe(
      "This commit's parent date couldn't be read, so its new date may fall before its parent's. Git allows this; views sorted by date would list the two out of order.",
    );
    act(() => useConfirm.getState().answer(true));
    await waitFor(() => expect(gitAmendCommitDates).toHaveBeenCalledTimes(1));
  });

  // Control: read a lone commit as parentless; the change is sent unasked.
  it("asks with the unread wording at a shallow clone's boundary", async () => {
    vi.mocked(gitCommitRecordsParent).mockResolvedValue(true);
    renderHost();
    await retype(await authorField(), EARLIER);
    expect(
      await screen.findByText(
        "The date of its parent couldn't be read, so this date can't be checked against it.",
      ),
    ).toBeInTheDocument();
    await userEvent.click(primary());
    await waitFor(() =>
      expect(useConfirm.getState().request?.title).toBe(
        "Rewrite without checking the parent's date?",
      ),
    );
    expect(gitCommitRecordsParent).toHaveBeenCalledWith(REPO, HASH);
    act(() => useConfirm.getState().answer(false));
    await act(() => Promise.resolve());
    expect(gitAmendCommitDates).not.toHaveBeenCalled();
  });

  it("holds while a lone commit's parent record is read", async () => {
    vi.mocked(gitCommitRecordsParent).mockReturnValue(
      new Promise<never>(() => undefined),
    );
    renderHost();
    await retype(await authorField(), EARLIER);
    await waitFor(() =>
      expect(primary()).toHaveAccessibleDescription(
        "Reading the parent's date…",
      ),
    );
  });

  // Control: read the press's `gate` after the await; the change is sent.
  it("refuses with the gate's reason when HEAD became protected during the prompt", async () => {
    flags.blocked = true;
    withParent(parentAt("2026-11-07T20:00:00+01:00"));
    vi.mocked(toast.error).mockClear();
    const { client } = renderHost();
    await retype(await authorField(), EARLIER);
    await waitFor(() => expect(primary()).not.toHaveAttribute("aria-disabled"));
    await userEvent.click(primary());
    await waitFor(() => expect(useConfirm.getState().request).not.toBeNull());
    // HEAD reaches its upstream while the prompt is open: now a protected
    // force push.
    act(() => {
      client.setQueryData(repoKeys.status(REPO), status({ ahead: 0 }));
    });
    expect(
      await screen.findAllByText(/^main is protected: force-pushing/),
    ).not.toHaveLength(0);
    act(() => useConfirm.getState().answer(true));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringMatching(/^main is protected: force-pushing/),
      ),
    );
    expect(gitAmendCommitDates).not.toHaveBeenCalled();
  });

  // Control: drop the toast in `run()`'s cached-HEAD check; this goes red.
  it("says why when HEAD moved while the prompt was open", async () => {
    withParent(parentAt("2026-11-07T20:00:00+01:00"));
    vi.mocked(toast.error).mockClear();
    const { client } = renderHost();
    await retype(await authorField(), EARLIER);
    await waitFor(() => expect(primary()).not.toHaveAttribute("aria-disabled"));
    await userEvent.click(primary());
    await waitFor(() => expect(useConfirm.getState().request).not.toBeNull());
    act(() => {
      client.setQueryData(repoKeys.status(REPO), status({ oid: NEW_HASH }));
    });
    act(() => useConfirm.getState().answer(true));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "The latest commit changed — no dates were changed.",
      ),
    );
    expect(gitAmendCommitDates).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
