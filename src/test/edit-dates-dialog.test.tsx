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
  gitOpState,
  gitStatus,
} from "@/lib/git/api";
import { repoKeys } from "@/lib/git/queries";
import type { CommitDetails, RepoStatus } from "@/lib/git/types";
import { useUiStore } from "@/lib/stores/ui";

const flags = vi.hoisted(() => ({ rulesSettling: false, blocked: false }));

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitStatus: vi.fn(),
  gitCommitDetails: vi.fn(),
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
  vi.mocked(gitOpState).mockReset().mockResolvedValue(opIdle);
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
    expect(onDatesChanged).toHaveBeenCalledWith(HASH, NEW_HASH);
  });

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
      expect(onDatesChanged).toHaveBeenCalledWith(HASH, NEW_HASH),
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
    expect(box).toHaveAccessibleName("Committer date: Same as author date");
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
