// Edit history asks before a user close drops a plan it hasn't applied: every
// close route (Escape on a row, the backdrop, the corner X, the footer Cancel)
// funnels through one dirty check. Each case's negative control is named
// beside it.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialogHost } from "@/components/confirm-dialog-host";
import { EDIT_HISTORY_DISCARD_CONFIRM } from "@/features/history/commit-confirms";
import { EditHistoryDialog } from "@/features/history/EditHistoryDialog";
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
import { useUiStore } from "@/lib/stores/ui";
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

const PROMPT = EDIT_HISTORY_DISCARD_CONFIRM.title;

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
  committerDate: "2026-11-01T10:00:00+01:00",
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
const DAY: Record<string, string> = {
  [A.hash]: "2026-11-01",
  [B.hash]: "2026-11-02",
  [C.hash]: "2026-11-03",
  [D.hash]: "2026-11-04",
};
const unpushed = () =>
  COMMITS.map((c) => ({
    hash: c.hash,
    message: `${c.subject}\n\nBody.`,
    authorDate: at(`${DAY[c.hash]}T10:00:00`, 60),
    committerDate: at(`${DAY[c.hash]}T10:00:00`, 60),
  }));

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
  useUiStore.setState({ repoPath: "/repo" });
});

function renderDialog() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(settingsKeys.settings, structuredClone(DEFAULT_SETTINGS));
  const onOpenChange = vi.fn();
  const view = render(
    <QueryClientProvider client={client}>
      <EditHistoryDialog
        repoPath="/repo"
        base={BASE}
        commits={COMMITS}
        emptyNote=""
        open
        onOpenChange={onOpenChange}
        onDone={vi.fn()}
      />
      <ConfirmDialogHost />
    </QueryClientProvider>,
  );
  return { onOpenChange, user: userEvent.setup(), unmount: view.unmount };
}

const editHistory = () => screen.getByRole("dialog", { name: "Edit history" });
function rowOf(c: CommitSummary): HTMLElement {
  const row = editHistory().querySelector<HTMLElement>(
    `[data-row="${c.hash}"]`,
  );
  if (row === null) throw new Error(`no row for ${c.subject}`);
  return row;
}
const dateButton = (c: CommitSummary) =>
  within(rowOf(c)).getByRole("button", {
    name: new RegExp(`^Dates for ${c.subject}(:|$)`),
  });
const prompt = () => screen.queryByRole("dialog", { name: PROMPT });
const held = (el: HTMLElement) => el.getAttribute("aria-disabled") === "true";

async function loaded() {
  await waitFor(() => expect(held(dateButton(C))).toBe(false));
}

async function reword(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    screen.getByRole("button", { name: `Action for ${C.subject}` }),
  );
  await user.click(await screen.findByRole("menuitem", { name: /^Reword/ }));
  await waitFor(() => {
    expect(screen.queryByRole("menu")).toBeNull();
    expect(rowOf(C)).toHaveFocus();
  });
}

function overlay(): HTMLElement {
  const el = document.querySelector<HTMLElement>(
    '[data-slot="dialog-overlay"]',
  );
  if (el === null) throw new Error("no backdrop");
  return el;
}

const closeX = () =>
  within(editHistory()).getByRole("button", { name: "Close" });
const footerCancel = () =>
  within(editHistory()).getByRole("button", { name: "Cancel" });

/** Each user close route, run with focus on row C, and the element focused
 *  when the prompt opens (a pointer press on a button focuses that button; the
 *  backdrop takes no focus). */
const ROUTES: {
  name: string;
  close: (user: ReturnType<typeof userEvent.setup>) => Promise<void>;
  focusedAtAsk: () => HTMLElement;
}[] = [
  {
    name: "Escape on a row",
    close: (user) => user.keyboard("{Escape}"),
    focusedAtAsk: () => rowOf(C),
  },
  {
    name: "a backdrop click",
    close: (user) => user.click(overlay()),
    focusedAtAsk: () => rowOf(C),
  },
  {
    name: "the corner X",
    close: (user) => user.click(closeX()),
    focusedAtAsk: closeX,
  },
  {
    name: "the footer Cancel",
    close: (user) => user.click(footerCancel()),
    focusedAtAsk: footerCancel,
  },
];

describe("closing with a pending reword", () => {
  // Control: drop `closeAsks()`/the dirty arm from the funnel (or route the
  // footer Cancel straight to the host prop); that route closes unasked.
  it.each(ROUTES)(
    "$name asks; Cancel keeps the plan and focus, Discard closes",
    async ({ close, focusedAtAsk }) => {
      const { user, onOpenChange } = renderDialog();
      await loaded();
      await reword(user);
      const message = screen.getByLabelText("Message for Third");
      await user.type(message, "!");
      act(() => rowOf(C).focus());
      // Resolved before the prompt hides the dialog from role queries.
      const before = focusedAtAsk();

      await close(user);
      await waitFor(() => expect(prompt()).not.toBeNull());
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(editHistory()).toBeInTheDocument();
      expect(
        within(prompt() as HTMLElement).getByText(
          EDIT_HISTORY_DISCARD_CONFIRM.body,
        ),
      ).toBeInTheDocument();

      await user.click(
        within(prompt() as HTMLElement).getByRole("button", { name: "Cancel" }),
      );
      await waitFor(() => expect(prompt()).toBeNull());
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(screen.getByLabelText("Message for Third")).toHaveValue(
        "Third\n\nBody.!",
      );
      await waitFor(() => expect(before).toHaveFocus());

      await close(user);
      await waitFor(() => expect(prompt()).not.toBeNull());
      await user.click(
        within(prompt() as HTMLElement).getByRole("button", {
          name: "Discard edits",
        }),
      );
      await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
      expect(onOpenChange).toHaveBeenCalledTimes(1);
    },
  );
});

describe("the prompt's lifetime", () => {
  // Control: drop discardPending from requestClose's early return; the second
  // Escape asks again (two asks).
  it("two closes before the prompt takes focus ask once, and one answer closes once", async () => {
    const { user, onOpenChange } = renderDialog();
    await loaded();
    await reword(user);
    const ask = vi.spyOn(useConfirm.getState(), "ask");
    const row = rowOf(C);
    act(() => {
      fireEvent.keyDown(row, { key: "Escape" });
      fireEvent.keyDown(row, { key: "Escape" });
    });
    await waitFor(() => expect(prompt()).not.toBeNull());
    expect(ask).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
    await user.click(
      within(prompt() as HTMLElement).getByRole("button", {
        name: "Discard edits",
      }),
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    ask.mockRestore();
  });

  // Controls: drop the unmount cleanup and the request outlives the dialog;
  // ask repo-scoped and the switch toasts "Didn't discard …".
  it("a repo switch that unmounts the dialog withdraws the prompt silently", async () => {
    const info = vi.spyOn(toast, "info");
    const { user, unmount } = renderDialog();
    await loaded();
    await reword(user);
    act(() => rowOf(C).focus());
    await user.keyboard("{Escape}");
    await waitFor(() => expect(prompt()).not.toBeNull());
    // As the host does: the switch lands, then History drops the dialog.
    act(() => useUiStore.setState({ repoPath: "/other" }));
    unmount();
    await act(() => new Promise((r) => setTimeout(r, 0)));
    expect(useConfirm.getState().request).toBeNull();
    expect(info).not.toHaveBeenCalled();
    info.mockRestore();
  });
});

describe("what counts as unapplied", () => {
  // Control: drop the dateInfo arm from `dirty`; the closed errored draft
  // carries no dates, plan.changed is false, and Escape closes unasked.
  it("a date draft left in error, editor closed, makes Escape on a row ask", async () => {
    const { user, onOpenChange } = renderDialog();
    await loaded();
    await user.click(dateButton(C));
    const field = screen.getByLabelText("Author date");
    await user.clear(field);
    await user.paste("2026-02-30 10:00:00 +01:00");
    expect(field).toHaveAttribute("aria-invalid", "true");
    // Escape inside the editor closes it (swallowed), back on the row.
    await user.keyboard("{Escape}");
    expect(screen.queryByLabelText("Author date")).toBeNull();
    expect(rowOf(C)).toHaveFocus();
    expect(prompt()).toBeNull();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(prompt()).not.toBeNull());
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  // Control: drop the strip arm from `dirty`; Escape on the row closes.
  it("an unapplied strip date makes Escape on a row ask", async () => {
    const { user, onOpenChange } = renderDialog();
    await loaded();
    act(() => rowOf(D).focus());
    await user.keyboard("{Shift>}{ArrowDown}{/Shift}");
    const field = screen.getByLabelText("Date for all 2");
    await user.clear(field);
    await user.paste("2026-11-06 08:00:00 +01:00");
    act(() => rowOf(C).focus());
    await user.keyboard("{Escape}");
    await waitFor(() => expect(prompt()).not.toBeNull());
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("a selection whose strip is untouched closes without asking", async () => {
    const { user, onOpenChange } = renderDialog();
    await loaded();
    act(() => rowOf(D).focus());
    await user.keyboard("{Shift>}{ArrowDown}{/Shift}");
    expect(screen.getByLabelText("Date for all 2")).toBeInTheDocument();
    act(() => rowOf(C).focus());
    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(prompt()).toBeNull();
  });

  it("a dialog with no edits closes on Escape without asking", async () => {
    const { user, onOpenChange } = renderDialog();
    await loaded();
    act(() => rowOf(C).focus());
    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(prompt()).toBeNull();
  });

  // Control: count the presence of a `dateDrafts` key or an open editor as
  // dirt; this case asks.
  it("an editor whose draft is back at the commit's own dates is not dirty", async () => {
    const { user, onOpenChange } = renderDialog();
    await loaded();
    await user.click(dateButton(C));
    const field = screen.getByLabelText("Author date");
    await user.clear(field);
    await user.paste("2026-11-05 10:00:00 +01:00");
    await user.clear(field);
    await user.paste("2026-11-03 10:00:00 +01:00");
    act(() => rowOf(C).focus());
    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(prompt()).toBeNull();
  });
});

describe("while the rewrite runs", () => {
  // Control: drop `busy` from the Root's guard and from requestClose's
  // refusal; Escape on the row asks.
  it("closing stays blocked and nothing asks", async () => {
    vi.mocked(gitRewriteCommits).mockReturnValue(
      new Promise<never>(() => undefined),
    );
    const { user, onOpenChange } = renderDialog();
    await loaded();
    await reword(user);
    await user.click(screen.getByRole("button", { name: "Rewrite history" }));
    await waitFor(() => expect(held(dateButton(C))).toBe(true));
    act(() => rowOf(C).focus());
    await user.keyboard("{Escape}");
    await user.click(overlay());
    await act(() => Promise.resolve());
    expect(prompt()).toBeNull();
    expect(useConfirm.getState().request).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(editHistory()).toBeInTheDocument();
  });
});
