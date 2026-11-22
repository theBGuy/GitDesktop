// Edit history's Tab order around an open date editor, the calendar button's
// press, and the busy refusals of the row keys and selection gestures. Each
// case's negative control is named beside it.
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
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { nativePickers } from "@/features/history/CommitDateField";
import { EditHistoryDialog } from "@/features/history/EditHistoryDialog";
import {
  gitCommitDetails,
  gitRewriteCommits,
  gitUnpushedMessages,
} from "@/lib/git/api";
import type { CommitDate, CommitDetails, CommitSummary } from "@/lib/git/types";
import { type AppSettings, loadSettings } from "@/lib/settings/api";
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
// Author and committer dates match on every row, so each editor ends at its
// "Same as author date" checkbox.
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

const showPicker = vi.fn();
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
  vi.spyOn(nativePickers, "supported").mockReturnValue(true);
  // jsdom has no showPicker.
  Object.defineProperty(HTMLInputElement.prototype, "showPicker", {
    configurable: true,
    writable: true,
    value: showPicker,
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLInputElement.prototype, "showPicker");
});

function renderDialog(order: AppSettings["editHistoryOrder"] = "newest-first") {
  const settings = {
    ...structuredClone(DEFAULT_SETTINGS),
    editHistoryOrder: order,
  };
  vi.mocked(loadSettings).mockResolvedValue(structuredClone(settings));
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(settingsKeys.settings, settings);
  const onOpenChange = vi.fn();
  const { unmount } = render(
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
    </QueryClientProvider>,
  );
  return { onOpenChange, unmount, user: userEvent.setup() };
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
const editor = (c: CommitSummary) =>
  within(rowOf(c)).getByRole("group", { name: `Dates for ${c.subject}` });
/** The editor's first control: its author date field. */
const firstControl = (c: CommitSummary) =>
  within(editor(c)).getByRole("textbox", { name: "Author date" });
/** The editor's last control while the dates match: the Same checkbox. */
const lastControl = (c: CommitSummary) =>
  within(editor(c)).getByRole("checkbox", {
    name: "Same as author date (committer date)",
  });
const live = () =>
  screen
    .getAllByRole("status")
    .find((el) => el.getAttribute("aria-live") === "polite");
const held = (el: HTMLElement) => el.getAttribute("aria-disabled") === "true";
const isSelected = (c: CommitSummary) =>
  (rowOf(c).getAttribute("aria-label") ?? "").endsWith(", selected");
const shownOrder = () =>
  [...screen.getByRole("list").querySelectorAll("[data-row]")].map((r) =>
    r.getAttribute("data-row"),
  );

async function loaded() {
  await waitFor(() => expect(held(dateButton(C))).toBe(false));
}

/** Opens `c`'s editor from its row with D, landing in its author field. */
async function openEditor(
  user: ReturnType<typeof userEvent.setup>,
  c: CommitSummary,
) {
  act(() => rowOf(c).focus());
  await user.keyboard("d");
  expect(firstControl(c)).toHaveFocus();
}

describe("Tab around an open date editor", () => {
  // Control: spread nav.rowProps' tabIndex unchanged; Tab skips row B and
  // lands on the footer's Cancel.
  it("Tab from the editor's last control lands on the next row, and Shift+Tab walks back", async () => {
    const { user } = renderDialog();
    await loaded();
    await openEditor(user, C);
    act(() => lastControl(C).focus());
    await user.tab();
    expect(rowOf(B)).toHaveFocus();
    await user.tab({ shift: true });
    expect(lastControl(C)).toHaveFocus();
    act(() => firstControl(C).focus());
    await user.tab({ shift: true });
    expect(rowOf(C)).toHaveFocus();
  });

  it("keeps the editor's row a stop after the active row moved on", async () => {
    const { user } = renderDialog();
    await loaded();
    await openEditor(user, C);
    act(() => lastControl(C).focus());
    await user.tab();
    expect(rowOf(B)).toHaveFocus();
    // B is the active row now; Shift+Tab from C's first control still lands
    // on C itself.
    act(() => firstControl(C).focus());
    await user.tab({ shift: true });
    expect(rowOf(C)).toHaveFocus();
  });

  it("with the last row's editor open, Tab leaves the list for the footer", async () => {
    const { user } = renderDialog();
    await loaded();
    await openEditor(user, A);
    act(() => lastControl(A).focus());
    await user.tab();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  // Control: key the "row after" on `order` (newest-first data order); Tab
  // from C's editor finds no stop below it on screen and leaves for the footer.
  it("with oldest first, Tab lands on the next row on screen", async () => {
    const { user } = renderDialog("oldest-first");
    await loaded();
    expect(shownOrder()).toEqual([A.hash, B.hash, C.hash, D.hash]);
    await openEditor(user, C);
    act(() => lastControl(C).focus());
    await user.tab();
    expect(rowOf(D)).toHaveFocus();
  });

  it("arrows still walk the rows one at a time", async () => {
    const { user } = renderDialog();
    await loaded();
    await openEditor(user, C);
    act(() => rowOf(D).focus());
    await user.keyboard("{ArrowDown}");
    expect(rowOf(C)).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(rowOf(B)).toHaveFocus();
  });
});

describe("the calendar button", () => {
  // Control: restore the toggle (a press while the inputs show hides them);
  // the second press collapses the inputs and showPicker runs twice in three.
  it("opens the native picker on every press and keeps focus on the button", async () => {
    const { user } = renderDialog();
    await loaded();
    await openEditor(user, C);
    const button = within(editor(C)).getByRole("button", {
      name: "Pick the author date with the calendar",
    });
    for (let press = 1; press <= 3; press++) {
      await user.click(button);
      const day = within(editor(C)).getByLabelText(
        "Author date, calendar date",
      );
      await waitFor(() => expect(showPicker).toHaveBeenCalledTimes(press));
      expect(showPicker.mock.contexts.at(-1)).toBe(day);
      // A plain action: it never collapses, so it claims no expanded state.
      expect(button).not.toHaveAttribute("aria-expanded");
      // No row handler moves focus off the press (Chromium closes an open
      // picker when its page focus moves).
      expect(button).toHaveFocus();
    }
  });

  // Control: call showPicker straight from the reveal's layout effect; the
  // picker then opens in the press's own commit, before the input is painted.
  it("the first press opens the picker after a paint, never within the press", async () => {
    const { user } = renderDialog();
    await loaded();
    await openEditor(user, C);
    const button = within(editor(C)).getByRole("button", {
      name: "Pick the author date with the calendar",
    });
    act(() => button.click());
    within(editor(C)).getByLabelText("Author date, calendar date");
    expect(showPicker).not.toHaveBeenCalled();
    await act(() => new Promise((r) => requestAnimationFrame(r)));
    expect(showPicker).not.toHaveBeenCalled();
    await waitFor(() => expect(showPicker).toHaveBeenCalledTimes(1));
  });

  // Control: drop the effect's cleanup; the pending frame is never cancelled
  // (the unmount's cleared ref is the fire-time backstop showPicker still sees).
  it("unmounting before the frame cancels the pending picker", async () => {
    const { user, unmount } = renderDialog();
    await loaded();
    await openEditor(user, C);
    const button = within(editor(C)).getByRole("button", {
      name: "Pick the author date with the calendar",
    });
    const scheduled: number[] = [];
    const schedule = window.requestAnimationFrame.bind(window);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      const id = schedule(cb);
      scheduled.push(id);
      return id;
    });
    const cancel = vi.spyOn(window, "cancelAnimationFrame");
    act(() => button.click());
    expect(scheduled.length).toBeGreaterThan(0);
    unmount();
    expect(cancel).toHaveBeenCalledWith(scheduled[0]);
    for (let i = 0; i < 3; i++)
      await new Promise((r) => requestAnimationFrame(r));
    expect(showPicker).not.toHaveBeenCalled();
  });
});

type Init = KeyboardEventInit & { keyCode?: number };
describe("an input-method key on a row", () => {
  // Control: drop the row handler's isImeKeydown return; the Alt swallow
  // prevents the key's default.
  it.each<[string, Init]>([
    ["composing", { isComposing: true }],
    ["keyCode 229", { keyCode: 229 }],
  ])("a %s Alt+Down moves nothing and keeps its default", async (_, ime) => {
    renderDialog();
    await loaded();
    const order = shownOrder();
    act(() => rowOf(C).focus());
    const altDown = { key: "ArrowDown", code: "ArrowDown", altKey: true };
    expect(fireEvent.keyDown(rowOf(C), { ...altDown, ...ime })).toBe(true);
    expect(shownOrder()).toEqual(order);
    // Positive control: the plain chord moves the row.
    expect(fireEvent.keyDown(rowOf(C), altDown)).toBe(false);
    expect(shownOrder()).not.toEqual(order);
  });

  // Control: drop the row handler's stopPropagation; the dialog's
  // document-level Escape dismissal closes it.
  it("a keyCode 229 Escape keeps the dialog open; a plain one dismisses it", async () => {
    const { onOpenChange } = renderDialog();
    await loaded();
    act(() => rowOf(C).focus());
    expect(fireEvent.keyDown(rowOf(C), { key: "Escape", keyCode: 229 })).toBe(
      true,
    );
    await act(() => new Promise((r) => setTimeout(r, 10)));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(rowOf(C), { key: "Escape" });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalled());
    expect(onOpenChange.mock.calls[0][0]).toBe(false);
  });
});

type User = ReturnType<typeof userEvent.setup>;
/** Each busy refusal: the gesture and what it must leave alone. */
const BUSY_ARMS: {
  name: string;
  run: (user: User) => Promise<void>;
  unchanged: () => void;
}[] = [
  {
    name: "D on a row",
    run: (user) => user.keyboard("d"),
    unchanged: () => expect(within(rowOf(D)).queryByRole("group")).toBeNull(),
  },
  {
    name: "Alt+Down on a row",
    run: (user) => user.keyboard("{Alt>}{ArrowDown}{/Alt}"),
    // The order check every arm runs covers it.
    unchanged: () => undefined,
  },
  {
    name: "Enter on a row",
    run: (user) => user.keyboard("{Enter}"),
    unchanged: () => expect(screen.queryByRole("menu")).toBeNull(),
  },
  {
    name: "Space on a row",
    run: (user) => user.keyboard(" "),
    unchanged: () => expect(screen.queryByRole("menu")).toBeNull(),
  },
  {
    name: "Shift+Down on a row",
    run: (user) => user.keyboard("{Shift>}{ArrowDown}{/Shift}"),
    unchanged: () => expect(COMMITS.some(isSelected)).toBe(false),
  },
  {
    name: "Shift+click on a row",
    run: async (user) => {
      await user.keyboard("{Shift>}");
      await user.click(subjectOf(B));
      await user.keyboard("{/Shift}");
    },
    unchanged: () => expect(COMMITS.some(isSelected)).toBe(false),
  },
  {
    name: "Ctrl+click on a row",
    run: async (user) => {
      await user.keyboard("{Control>}");
      await user.click(subjectOf(B));
      await user.keyboard("{/Control}");
    },
    unchanged: () => expect(COMMITS.some(isSelected)).toBe(false),
  },
];

describe("while the rewrite runs", () => {
  // Control: drop the gesture's `announce(BUSY_REASON)`; the live region
  // stays silent.
  it.each(BUSY_ARMS)(
    "$name announces why and changes nothing",
    async ({ run, unchanged }) => {
      vi.mocked(gitRewriteCommits).mockReturnValue(
        new Promise<never>(() => undefined),
      );
      const { user } = renderDialog();
      await loaded();
      // A plain move is enough to make the plan applicable.
      act(() => rowOf(A).focus());
      await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
      await user.click(screen.getByRole("button", { name: "Rewrite history" }));
      await waitFor(() => expect(held(dateButton(C))).toBe(true));
      const order = shownOrder();
      expect(live()).not.toHaveTextContent(BUSY);
      act(() => rowOf(D).focus());
      await run(user);
      expect(live()).toHaveTextContent(BUSY);
      expect(shownOrder()).toEqual(order);
      unchanged();
    },
  );
});
