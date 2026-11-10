// Edit history's dates: the per-row Dates editor, the multi-select strip, the
// date holds and the before-parent confirm. Each case's negative control is
// named beside it.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { UNREADABLE_DATE_TEXT } from "@/features/history/commit-date";
import { EditHistoryDialog } from "@/features/history/EditHistoryDialog";
import { PROMOTION_BLOCKS_CHECKOUT } from "@/features/repository/checkout-copy";
import {
  gitCommitDetails,
  gitRewriteCommits,
  gitUnpushedMessages,
} from "@/lib/git/api";
import type { CommitDate, CommitDetails, CommitSummary } from "@/lib/git/types";
import { loadSettings } from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { useConfirm } from "@/lib/stores/confirm";
import { promotionBlocksCheckout } from "@/lib/stores/worktree-removal";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitUnpushedMessages: vi.fn(),
  gitRewriteCommits: vi.fn(),
  gitRebaseEdit: vi.fn(),
  gitCommitDetails: vi.fn(),
}));
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));
vi.mock("@/lib/stores/worktree-removal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stores/worktree-removal")>()),
  promotionBlocksCheckout: vi.fn(() => false),
}));

const BUSY = "The rewrite is still running.";

/** A wall-clock time in the given offset, as git records it. */
const at = (wall: string, offsetMinutes: number): CommitDate => ({
  epochSeconds: Date.parse(`${wall}Z`) / 1000 - offsetMinutes * 60,
  offsetMinutes,
});

const commit = (char: string, subject: string): CommitSummary => ({
  hash: char.repeat(40),
  subject,
  author: "Ada",
  authorEmail: "",
  date: "2026-11-01T10:00:00+01:00",
  tags: [],
  isMerge: false,
});
// Newest-first, as the host passes them.
const D = commit("d", "Fourth");
const C = commit("c", "Third");
const B = commit("b", "Second");
const A = commit("a", "First");
const COMMITS = [D, C, B, A];
const BASE = "f".repeat(40);

const DATES: Record<string, { author: CommitDate; committer: CommitDate }> = {
  [A.hash]: {
    author: at("2026-11-01T10:00:00", 60),
    committer: at("2026-11-01T10:00:00", 60),
  },
  [B.hash]: {
    author: at("2026-11-02T10:00:00", 60),
    committer: at("2026-11-02T12:00:00", 60),
  },
  [C.hash]: {
    author: at("2026-11-03T10:00:00", 60),
    committer: at("2026-11-03T10:00:00", 60),
  },
  [D.hash]: {
    author: at("2026-11-04T10:00:00", 60),
    committer: at("2026-11-04T10:00:00", 60),
  },
};

type DatesPatch = Partial<{
  authorDate: CommitDate | null;
  committerDate: CommitDate | null;
}>;
function unpushed(patch: Record<string, DatesPatch> = {}) {
  return COMMITS.map((c) => ({
    hash: c.hash,
    message: `${c.subject}\n\nBody.`,
    authorDate: DATES[c.hash].author,
    committerDate: DATES[c.hash].committer,
    ...patch[c.hash],
  }));
}

// jsdom has no scrollIntoView; the dialog scrolls a row it focuses into view.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadSettings).mockResolvedValue(structuredClone(DEFAULT_SETTINGS));
  vi.mocked(gitUnpushedMessages).mockResolvedValue(unpushed());
  vi.mocked(gitCommitDetails).mockResolvedValue({
    hash: BASE,
    date: "2026-10-31T10:00:00+01:00",
    committerDate: "2026-10-31T10:00:00+01:00",
  } as unknown as CommitDetails);
  vi.mocked(promotionBlocksCheckout).mockReturnValue(false);
  useConfirm.setState({ request: null, requestHold: null });
});

function renderDialog(
  opts: { commits?: CommitSummary[]; initialDatesFor?: string } = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(settingsKeys.settings, structuredClone(DEFAULT_SETTINGS));
  const onOpenChange = vi.fn();
  const tree = (commits: CommitSummary[]) => (
    <QueryClientProvider client={client}>
      <EditHistoryDialog
        repoPath="/repo"
        base={BASE}
        commits={commits}
        emptyNote=""
        open
        onOpenChange={onOpenChange}
        onDone={vi.fn()}
        initialDatesFor={opts.initialDatesFor}
      />
    </QueryClientProvider>
  );
  const view = render(tree(opts.commits ?? COMMITS));
  return {
    client,
    onOpenChange,
    user: userEvent.setup(),
    rerender: (commits: CommitSummary[]) => view.rerender(tree(commits)),
  };
}

function rowOf(c: CommitSummary): HTMLElement {
  const row = screen
    .getByRole("list")
    .querySelector<HTMLElement>(`[data-row="${c.hash}"]`);
  if (row === null) throw new Error(`no row for ${c.subject}`);
  return row;
}
const subjectOf = (c: CommitSummary) => within(rowOf(c)).getByText(c.subject);
const dateButton = (c: CommitSummary) =>
  within(rowOf(c)).getByRole("button", {
    name: new RegExp(`^Dates for ${c.subject}(:|$)`),
  });
const primary = () =>
  screen.getByRole("button", { name: /^(Rewrite history|Start rebase)$/ });
const footer = () =>
  screen.getByRole("dialog").querySelector(".mr-auto")?.textContent ?? "";
const strip = () =>
  screen.queryByRole("group", { name: "Dates for the selected commits" });
const isSelected = (c: CommitSummary) =>
  (rowOf(c).getAttribute("aria-label") ?? "").endsWith(", selected");
/** The dialog's polite live region (a busy spinner is a status too). */
const live = () =>
  screen
    .getAllByRole("status")
    .find((el) => el.getAttribute("aria-live") === "polite");
const held = (el: HTMLElement) => el.getAttribute("aria-disabled") === "true";

async function loaded() {
  await waitFor(() => expect(held(dateButton(C))).toBe(false));
}

/** Picks a row's action from its menu and waits out the close: the menu's
 *  explicit return focus lands on the row a microtask after the popup
 *  unmounts, whatever took focus meanwhile, so a gesture made before it
 *  settles would be retargeted (a later Shift+click ranges from this row). */
async function pickAction(
  user: ReturnType<typeof userEvent.setup>,
  c: CommitSummary,
  name: RegExp,
) {
  await user.click(
    screen.getByRole("button", { name: `Action for ${c.subject}` }),
  );
  await user.click(await screen.findByRole("menuitem", { name }));
  await waitFor(() => {
    expect(screen.queryByRole("menu")).toBeNull();
    expect(rowOf(c)).toHaveFocus();
  });
}

async function typeInto(
  user: ReturnType<typeof userEvent.setup>,
  field: HTMLElement,
  text: string,
) {
  await user.clear(field);
  await user.type(field, text);
}

describe("a row's Dates editor", () => {
  // Control: drop the editor container's Escape handling; the dialog's own
  // dismiss asks to close (onOpenChange(false)) and the editor stays open.
  it("opens on D in the author field and closes on Escape back to the row", async () => {
    const { user, onOpenChange } = renderDialog();
    await loaded();
    rowOf(C).focus();
    await user.keyboard("d");
    expect(dateButton(C)).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("Author date")).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByLabelText("Author date")).toBeNull();
    expect(rowOf(C)).toHaveFocus();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("holds the primary on an invalid date and canonicalizes on blur", async () => {
    const { user } = renderDialog();
    await loaded();
    await user.click(dateButton(C));
    const field = screen.getByLabelText("Author date");
    await typeInto(user, field, "2026-02-30 10:00:00 +01:00");
    expect(screen.getByText("February 2026 has 28 days.")).toBeInTheDocument();
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(held(primary())).toBe(true);
    expect(primary()).toHaveAccessibleDescription(
      `Fix the date on ${C.hash.slice(0, 7)} first.`,
    );
    await typeInto(user, field, "2026-11-03T11:00+0100");
    expect(field).not.toHaveAttribute("aria-invalid");
    expect(held(primary())).toBe(false);
    await user.tab();
    expect(field).toHaveValue("2026-11-03 11:00:00 +01:00");
  });

  // Control: stop copying `dates` onto the step in compilePlan; the step
  // assertion goes red.
  it("sends the changed row's exact dates and no date keys on the others", async () => {
    const { user } = renderDialog();
    await loaded();
    await user.click(dateButton(C));
    await typeInto(
      user,
      screen.getByLabelText("Author date"),
      "2026-11-03 11:00:00 +01:00",
    );
    expect(footer()).toContain("dates change on 1");
    vi.mocked(gitRewriteCommits).mockResolvedValue(undefined);
    await user.click(primary());
    await waitFor(() => expect(gitRewriteCommits).toHaveBeenCalledTimes(1));
    const steps = vi.mocked(gitRewriteCommits).mock.calls[0][2];
    const want = at("2026-11-03T11:00:00", 60);
    expect(steps.find((s) => s.hashes[0] === C.hash)).toMatchObject({
      authorDate: want,
      committerDate: want,
    });
    for (const s of steps.filter((s) => s.hashes[0] !== C.hash)) {
      expect(s).not.toHaveProperty("authorDate");
      expect(s).not.toHaveProperty("committerDate");
    }
  });
});

describe("multi-select", () => {
  // Control: drop the ", selected" suffix from the row's name.
  it("Shift+Down selects a range, the strip applies one date, Clear drops it", async () => {
    const { user } = renderDialog();
    await loaded();
    rowOf(D).focus();
    await user.keyboard("{Shift>}{ArrowDown}{ArrowDown}{/Shift}");
    expect([D, C, B].map(isSelected)).toEqual([true, true, true]);
    expect(isSelected(A)).toBe(false);
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    expect(screen.getByRole("list")).toHaveAttribute("data-multiselect");
    expect(
      document.querySelector("[aria-selected], [aria-multiselectable]"),
    ).toBeNull();
    const group = strip();
    expect(group).not.toBeNull();
    expect(group?.textContent).toContain("3 commits selected");
    expect(screen.getByRole("status")).toHaveTextContent("3 commits selected");

    await typeInto(
      user,
      screen.getByLabelText("Date for all 3"),
      "2026-11-06 08:00:00 +01:00",
    );
    const apply = screen.getByRole("button", { name: "Apply to 3" });
    await user.click(apply);
    expect(footer()).toContain("dates change on 3");
    expect(gitRewriteCommits).not.toHaveBeenCalled();
    expect([D, C, B].map(isSelected)).toEqual([true, true, true]);
    expect(apply).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(strip()).toBeNull();
    expect(document.activeElement?.getAttribute("data-row")).toBe(D.hash);
  });

  // Control: drop the strip's Escape handling; the dialog asks to close.
  it("Escape in the strip clears the selection and keeps the dialog and drafts", async () => {
    const { user, onOpenChange } = renderDialog();
    await loaded();
    rowOf(D).focus();
    await user.keyboard("{Shift>}{ArrowDown}{/Shift}");
    const field = screen.getByLabelText("Date for all 2");
    await typeInto(user, field, "2026-11-06 08:00:00 +01:00");
    await user.click(screen.getByRole("button", { name: "Apply to 2" }));
    await user.click(field);
    await user.keyboard("{Escape}");
    expect(strip()).toBeNull();
    expect(isSelected(D)).toBe(false);
    expect(rowOf(D)).toHaveFocus();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(footer()).toContain("dates change on 2");
  });

  it("Ctrl+click toggles, Shift+click ranges, a plain click clears, the date button selects nothing", async () => {
    const { user } = renderDialog();
    await loaded();
    await user.click(subjectOf(D));
    await user.keyboard("{Control>}");
    await user.click(subjectOf(B));
    await user.keyboard("{/Control}");
    expect([D, C, B, A].map(isSelected)).toEqual([false, false, true, false]);
    await user.keyboard("{Control>}");
    await user.click(subjectOf(B));
    await user.keyboard("{/Control}");
    expect(isSelected(B)).toBe(false);
    await user.keyboard("{Shift>}");
    await user.click(subjectOf(D));
    await user.keyboard("{/Shift}");
    expect([D, C, B, A].map(isSelected)).toEqual([true, true, true, false]);
    await user.click(dateButton(A));
    expect([D, C, B, A].map(isSelected)).toEqual([true, true, true, false]);
    expect(dateButton(A)).toHaveAttribute("aria-expanded", "true");
    await user.click(subjectOf(A));
    expect([D, C, B, A].map(isSelected)).toEqual([false, false, false, false]);
  });

  it("holds fold members and dropped rows and reports them skipped", async () => {
    const { user } = renderDialog();
    await loaded();
    await pickAction(user, B, /^Fixup/);
    await pickAction(user, C, /^Drop/);
    await waitFor(() => expect(held(dateButton(B))).toBe(true));
    expect(dateButton(B)).toHaveAccessibleDescription(
      "A squashed or fixed-up commit takes its dates from the commit it combines into.",
    );
    expect(dateButton(C)).toHaveAccessibleDescription(
      "A removed commit has no dates to change.",
    );
    await user.click(subjectOf(D));
    await user.keyboard("{Shift>}");
    await user.click(subjectOf(A));
    await user.keyboard("{/Shift}");
    expect([D, C, B, A].map(isSelected)).toEqual([true, false, false, true]);
    expect(strip()?.textContent).toContain("2 commits selected");
    expect(strip()?.textContent).toContain(
      "2 in the selection can't take dates and are skipped.",
    );
  });

  it("holds a row whose dates can't be read, never selects it, and keeps its reword", async () => {
    vi.mocked(gitUnpushedMessages).mockResolvedValue(
      unpushed({ [B.hash]: { committerDate: null } }),
    );
    const { user } = renderDialog();
    await loaded();
    expect(dateButton(B)).toHaveAccessibleDescription(
      "This commit's dates can't be read",
    );
    await user.keyboard("{Control>}");
    await user.click(subjectOf(B));
    await user.keyboard("{/Control}");
    expect(isSelected(B)).toBe(false);
    await pickAction(user, B, /^Reword/);
    const message = await screen.findByLabelText("Message for Second");
    expect(message).toBeEnabled();
    await user.type(message, "!");
    expect(message).toHaveValue("Second\n\nBody.!");
  });

  // Control: seed from the focused row whatever it is; the strip then reads
  // the fold member's date.
  it("seeds the strip from the first selected row when focus lands on a fold member", async () => {
    const { user } = renderDialog();
    await loaded();
    await pickAction(user, B, /^Fixup/);
    await user.click(subjectOf(D));
    await user.keyboard("{Shift>}");
    await user.click(subjectOf(B));
    await user.keyboard("{/Shift}");
    expect(rowOf(B)).toHaveFocus();
    expect(screen.getByLabelText("Date for all 2")).toHaveValue(
      "2026-11-04 10:00:00 +01:00",
    );
  });

  // Control: render the note without the seed row's id.
  it("names the seed row's id when an offset-less strip date borrows its offset", async () => {
    const { user } = renderDialog();
    await loaded();
    await pickAction(user, B, /^Fixup/);
    await user.click(subjectOf(D));
    await user.keyboard("{Shift>}");
    await user.click(subjectOf(B));
    await user.keyboard("{/Shift}");
    await typeInto(
      user,
      screen.getByLabelText("Date for all 2"),
      "2026-11-06 08:00:00",
    );
    expect(strip()?.textContent).toContain(
      `(the offset of ${D.hash.slice(0, 7)}, the commit this strip was filled from)`,
    );
  });
});

describe("before parent", () => {
  async function datedBeforeParent() {
    const r = renderDialog();
    await loaded();
    await r.user.click(dateButton(B));
    await typeInto(
      r.user,
      screen.getByLabelText("Author date"),
      "2026-10-30 10:00:00 +01:00",
    );
    return r;
  }

  // Control: skip the ask; Cancel's no-call assertion goes red.
  it("flags the row, the editor and the footer, and asks once before rewriting", async () => {
    const { user } = await datedBeforeParent();
    expect(within(rowOf(B)).getByText("before parent")).toBeInTheDocument();
    expect(
      screen.getByText(/^Earlier than its parent aaaaaaa \(Nov 1, /),
    ).toBeInTheDocument();
    expect(footer()).toContain("1 dated before its parent");
    vi.mocked(gitRewriteCommits).mockResolvedValue(undefined);

    await user.click(primary());
    await waitFor(() =>
      expect(useConfirm.getState().request?.title).toBe(
        "Rewrite with out-of-order dates?",
      ),
    );
    act(() => useConfirm.getState().answer(false));
    await act(() => Promise.resolve());
    expect(gitRewriteCommits).not.toHaveBeenCalled();

    await user.click(primary());
    await waitFor(() => expect(useConfirm.getState().request).not.toBeNull());
    act(() => useConfirm.getState().answer(true));
    await waitFor(() => expect(gitRewriteCommits).toHaveBeenCalledTimes(1));
  });

  // Control: drop the two suffixes from the row's name.
  it("names the before-parent flag and the changed dates in the row's label", async () => {
    await datedBeforeParent();
    expect(rowOf(B).getAttribute("aria-label")).toMatch(
      /Second, dated before its parent, dates changed$/,
    );
    expect(rowOf(C).getAttribute("aria-label")).toMatch(/Third$/);
  });

  // Control: take only fully readable rows into originalAuthor; B goes
  // unflagged and the rewrite runs without a prompt.
  it("compares against a parent whose committer date alone is unreadable", async () => {
    vi.mocked(gitUnpushedMessages).mockResolvedValue(
      unpushed({ [A.hash]: { committerDate: null } }),
    );
    const { user } = await datedBeforeParent();
    expect(within(rowOf(B)).getByText("before parent")).toBeInTheDocument();
    expect(footer()).toContain("1 dated before its parent");
    vi.mocked(gitRewriteCommits).mockResolvedValue(undefined);
    await user.click(primary());
    await waitFor(() =>
      expect(useConfirm.getState().request?.title).toBe(
        "Rewrite with out-of-order dates?",
      ),
    );
    act(() => useConfirm.getState().answer(false));
    await act(() => Promise.resolve());
    expect(gitRewriteCommits).not.toHaveBeenCalled();
  });

  // Control: remove the check after the confirm; the rewrite runs.
  it("refuses when a promotion starts while the prompt is open", async () => {
    const info = vi.spyOn(toast, "info");
    const { user } = await datedBeforeParent();
    await user.click(primary());
    await waitFor(() => expect(useConfirm.getState().request).not.toBeNull());
    vi.mocked(promotionBlocksCheckout).mockReturnValue(true);
    act(() => useConfirm.getState().answer(true));
    await waitFor(() =>
      expect(info).toHaveBeenCalledWith(PROMOTION_BLOCKS_CHECKOUT),
    );
    expect(gitRewriteCommits).not.toHaveBeenCalled();
    info.mockRestore();
  });
});

describe("the parent's date read", () => {
  async function dated(c: CommitSummary, text: string) {
    const r = renderDialog();
    await loaded();
    await r.user.click(dateButton(c));
    await typeInto(r.user, screen.getByLabelText("Author date"), text);
    return r;
  }

  // Control: drop the pending case from the primary's reasons; the primary is
  // live and the rewrite runs unjudged.
  it("holds the primary while the parent's date is still reading", async () => {
    vi.mocked(gitCommitDetails).mockReturnValue(
      new Promise<never>(() => undefined),
    );
    await dated(C, "2026-11-03 11:00:00 +01:00");
    expect(held(primary())).toBe(true);
    expect(primary()).toHaveAccessibleDescription("Reading the parent's date…");
  });

  // Control: ask only on `beforeParent`; the rewrite runs without a prompt.
  it("asks once, with the unread wording, when the oldest row is re-dated over a failed read", async () => {
    vi.mocked(gitCommitDetails).mockRejectedValue(new Error("boom"));
    const { user } = await dated(A, "2026-11-01 11:00:00 +01:00");
    await waitFor(() =>
      expect(
        within(rowOf(A)).getByText("parent date unread"),
      ).toBeInTheDocument(),
    );
    expect(footer()).toContain("oldest commit's parent date unread");
    expect(footer()).not.toContain("dated before");
    expect(rowOf(A).getAttribute("aria-label")).toMatch(
      /First, parent's date unread, dates changed$/,
    );
    expect(held(primary())).toBe(false);
    vi.mocked(gitRewriteCommits).mockResolvedValue(undefined);

    await user.click(primary());
    await waitFor(() =>
      expect(useConfirm.getState().request?.title).toBe(
        "Rewrite without checking the parent's date?",
      ),
    );
    expect(useConfirm.getState().request?.body).toContain(
      "The oldest commit's parent date couldn't be read",
    );
    act(() => useConfirm.getState().answer(false));
    await act(() => Promise.resolve());
    expect(useConfirm.getState().request).toBeNull();
    expect(gitRewriteCommits).not.toHaveBeenCalled();

    await user.click(primary());
    await waitFor(() => expect(useConfirm.getState().request).not.toBeNull());
    act(() => useConfirm.getState().answer(true));
    await waitFor(() => expect(gitRewriteCommits).toHaveBeenCalledTimes(1));
  });

  it("asks nothing over a failed read when the oldest row keeps its date", async () => {
    vi.mocked(gitCommitDetails).mockRejectedValue(new Error("boom"));
    const { user } = await dated(C, "2026-11-03 11:00:00 +01:00");
    await waitFor(() => expect(held(primary())).toBe(false));
    expect(footer()).not.toContain("parent date unread");
    vi.mocked(gitRewriteCommits).mockResolvedValue(undefined);
    await user.click(primary());
    await waitFor(() => expect(gitRewriteCommits).toHaveBeenCalledTimes(1));
    expect(useConfirm.getState().request).toBeNull();
  });
});

describe("focus after a row's menu", () => {
  // Control: return the menu's row from finalFocus unconditionally; focus is
  // pulled back to C after the exit.
  it("leaves focus on a row focused before the menu's return lands", async () => {
    const { user } = renderDialog();
    await loaded();
    await user.click(
      screen.getByRole("button", { name: `Action for ${C.subject}` }),
    );
    await user.click(await screen.findByRole("menuitem", { name: /^Drop/ }));
    act(() => rowOf(B).focus());
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(rowOf(B)).toHaveFocus();
  });
});

describe("read states", () => {
  // Control: drop the failed arm of the button text; the Skeleton stays.
  it("names a failed row with no listed date by its visible text", async () => {
    vi.mocked(gitUnpushedMessages).mockRejectedValue(new Error("boom"));
    renderDialog({
      commits: COMMITS.map((c) => (c === B ? { ...B, date: "" } : c)),
    });
    await waitFor(() =>
      expect(dateButton(B)).toHaveAccessibleName(
        "Dates for Second: Date not loaded",
      ),
    );
    expect(dateButton(B)).toHaveTextContent("Date not loaded");
    expect(dateButton(B).querySelector('[data-slot="skeleton"]')).toBeNull();
  });

  it("holds the date buttons while the read is pending", async () => {
    vi.mocked(gitUnpushedMessages).mockReturnValue(
      new Promise<never>(() => undefined),
    );
    renderDialog();
    await waitFor(() =>
      expect(dateButton(C)).toHaveAccessibleDescription("Loading dates…"),
    );
  });

  it("reports a failed read on the buttons and the footer, and Retry recovers", async () => {
    vi.mocked(gitUnpushedMessages).mockRejectedValue(new Error("boom"));
    const { user } = renderDialog();
    await waitFor(() =>
      expect(footer()).toContain("Couldn't load commit messages and dates."),
    );
    expect(dateButton(C)).toHaveAccessibleDescription(
      "Couldn't load commit dates",
    );
    vi.mocked(gitUnpushedMessages).mockResolvedValue(unpushed());
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await loaded();
  });

  // Control: drop the unreadable arm of the label; the row keeps a skeleton.
  it("an unreadable row with no readable listed date says so instead of loading", async () => {
    vi.mocked(gitUnpushedMessages).mockResolvedValue(
      unpushed({ [B.hash]: { authorDate: null, committerDate: null } }),
    );
    renderDialog({
      commits: COMMITS.map((c) => (c === B ? { ...B, date: "" } : c)),
    });
    await loaded();
    const button = dateButton(B);
    expect(button).toHaveTextContent(UNREADABLE_DATE_TEXT);
    expect(button.querySelector('[data-slot="skeleton"]')).toBeNull();
  });

  // Control: derive `failed` from the read's isError alone; the loaded row's
  // editor unmounts and the field loses focus.
  it("keeps a loaded row's editor, draft and focus through a failed refetch", async () => {
    const { user, client } = renderDialog();
    await loaded();
    await user.click(dateButton(C));
    const field = screen.getByLabelText("Author date");
    await typeInto(user, field, "2026-11-03 11:00:00 +01:00");
    vi.mocked(gitUnpushedMessages).mockRejectedValue(new Error("boom"));
    await act(() => client.refetchQueries());
    await waitFor(() =>
      expect(footer()).toContain("Couldn't load commit messages and dates."),
    );
    expect(screen.getByLabelText("Author date")).toBe(field);
    expect(field).toHaveValue("2026-11-03 11:00:00 +01:00");
    expect(field).toHaveFocus();
  });
});

describe("busy and reseed", () => {
  // Control: unmount the editor while busy; the field lookup goes red.
  it("disables the date controls in place while the rewrite runs", async () => {
    vi.mocked(gitRewriteCommits).mockReturnValue(
      new Promise<never>(() => undefined),
    );
    const { user } = renderDialog();
    await loaded();
    await user.click(dateButton(C));
    await typeInto(
      user,
      screen.getByLabelText("Author date"),
      "2026-11-03 11:00:00 +01:00",
    );
    await user.click(primary());
    await waitFor(() => expect(held(dateButton(C))).toBe(true));
    expect(dateButton(C)).toHaveAccessibleDescription(BUSY);
    const field = screen.getByLabelText("Author date");
    expect(field).toHaveAttribute("aria-disabled", "true");
    expect(field).toHaveAccessibleDescription(expect.stringContaining(BUSY));
    expect(
      held(screen.getByRole("button", { name: "Now" })) &&
        held(screen.getByRole("button", { name: "Reset" })),
    ).toBe(true);
  });

  // Control: close on Escape whatever busy says; the field lookup goes red.
  it("Escape in a row's editor while busy keeps it and announces why", async () => {
    vi.mocked(gitRewriteCommits).mockReturnValue(
      new Promise<never>(() => undefined),
    );
    const { user, onOpenChange } = renderDialog();
    await loaded();
    await user.click(dateButton(C));
    const field = screen.getByLabelText("Author date");
    await typeInto(user, field, "2026-11-03 11:00:00 +01:00");
    await user.click(primary());
    await waitFor(() => expect(held(dateButton(C))).toBe(true));
    expect(live()).not.toHaveTextContent(BUSY);
    act(() => field.focus());
    await user.keyboard("{Escape}");
    expect(screen.getByLabelText("Author date")).toBe(field);
    expect(live()).toHaveTextContent(BUSY);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("Escape in the strip while busy keeps the selection and announces why", async () => {
    vi.mocked(gitRewriteCommits).mockReturnValue(
      new Promise<never>(() => undefined),
    );
    const { user } = renderDialog();
    await loaded();
    rowOf(D).focus();
    await user.keyboard("{Shift>}{ArrowDown}{/Shift}");
    const field = screen.getByLabelText("Date for all 2");
    await typeInto(user, field, "2026-11-06 08:00:00 +01:00");
    await user.click(screen.getByRole("button", { name: "Apply to 2" }));
    expect(live()).toHaveTextContent("Dates applied to 2 commits");
    await user.click(primary());
    await waitFor(() => expect(held(dateButton(C))).toBe(true));
    act(() => field.focus());
    await user.keyboard("{Escape}");
    expect(strip()).not.toBeNull();
    expect(isSelected(D)).toBe(true);
    expect(live()).toHaveTextContent(BUSY);
  });

  it("D on a row whose dates can't be read announces why", async () => {
    vi.mocked(gitUnpushedMessages).mockResolvedValue(
      unpushed({ [B.hash]: { committerDate: null } }),
    );
    const { user } = renderDialog();
    await loaded();
    rowOf(B).focus();
    await user.keyboard("d");
    expect(live()).toHaveTextContent("This commit's dates can't be read");
    expect(screen.queryByLabelText("Author date")).toBeNull();
  });

  it("opens the initialDatesFor row's editor and focuses that row", async () => {
    renderDialog({ initialDatesFor: B.hash });
    await loaded();
    await waitFor(() => expect(rowOf(B)).toHaveFocus());
    expect(within(rowOf(B)).getByLabelText("Author date")).toBeInTheDocument();
    expect(dateButton(B)).toHaveAttribute("aria-expanded", "true");
  });

  it("a changed commit set clears drafts, open editors and the selection", async () => {
    const { user, rerender } = renderDialog();
    await loaded();
    await user.click(dateButton(C));
    await typeInto(
      user,
      screen.getByLabelText("Author date"),
      "2026-11-03 11:00:00 +01:00",
    );
    rowOf(D).focus();
    await user.keyboard("{Shift>}{ArrowDown}{ArrowDown}{/Shift}");
    expect(strip()).not.toBeNull();
    rerender([commit("e", "Fifth"), ...COMMITS]);
    await waitFor(() => expect(strip()).toBeNull());
    expect(screen.queryByLabelText("Author date")).toBeNull();
    expect(footer()).not.toContain("dates change");
    expect([D, C, B, A].some(isSelected)).toBe(false);
  });
});
