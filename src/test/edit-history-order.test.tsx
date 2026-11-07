// The Edit history order toggle: a display-only reversal with spatial moves,
// chronological end reasons and direction-aware fold copy. Negative control:
// routing the moves back through newest-first arithmetic (visualMoveTarget's
// `reversed` forced false) turns the oldest-first move cases red.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EditHistoryDialog } from "@/features/history/EditHistoryDialog";
import { gitUnpushedMessages } from "@/lib/git/api";
import type { CommitSummary } from "@/lib/git/types";
import {
  type AppSettings,
  loadSettings,
  saveSettingsMerged,
} from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitUnpushedMessages: vi.fn(),
  gitRewriteCommits: vi.fn(),
  gitRebaseEdit: vi.fn(),
}));
// The real writer would reach the rejecting test transport and roll the
// optimistic patch back.
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
  saveSettingsMerged: vi.fn(),
}));

type ListOrder = AppSettings["editHistoryOrder"];

const commit = (char: string, subject: string): CommitSummary => ({
  hash: char.repeat(40),
  subject,
  author: "Ada",
  authorEmail: "",
  date: "2026-11-01T10:00:00Z",
  tags: [],
  isMerge: false,
});
// Newest-first, as the host passes them.
const THIRD = commit("c", "Third");
const SECOND = commit("b", "Second");
const FIRST = commit("a", "First");
const COMMITS = [THIRD, SECOND, FIRST];
const BASE = "f".repeat(40);

let stored: AppSettings;

function newClient(order: ListOrder) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  stored = { ...structuredClone(DEFAULT_SETTINGS), editHistoryOrder: order };
  client.setQueryData(settingsKeys.settings, structuredClone(stored));
  return client;
}

function renderDialog(client: QueryClient, commits = COMMITS) {
  const tree = (c: CommitSummary[]) => (
    <QueryClientProvider client={client}>
      <EditHistoryDialog
        repoPath="/repo"
        base={BASE}
        commits={c}
        emptyNote=""
        open
        onOpenChange={vi.fn()}
        onDone={vi.fn()}
      />
    </QueryClientProvider>
  );
  const view = render(tree(commits));
  return {
    unmount: view.unmount,
    rerender: (c: CommitSummary[]) => view.rerender(tree(c)),
  };
}

const list = () => screen.getByRole("list");
const rowOf = (c: CommitSummary) =>
  list().querySelector<HTMLElement>(`[data-row="${c.hash}"]`) as HTMLElement;
const shownSubjects = () =>
  within(list())
    .getAllByRole("listitem")
    .map((li) => li.getAttribute("data-row"))
    .map((h) => COMMITS.find((c) => c.hash === h)?.subject);
const status = () => within(screen.getByRole("dialog")).getByRole("status");
const cachedOrder = (client: QueryClient) =>
  client.getQueryData<AppSettings>(settingsKeys.settings)?.editHistoryOrder;

// After the dialog's own initial focus, which would otherwise land later.
async function focusRow(c: CommitSummary) {
  await waitFor(() =>
    expect(document.activeElement?.hasAttribute("data-row")).toBe(true),
  );
  await act(async () => rowOf(c).focus());
}

async function setSquash(
  user: ReturnType<typeof userEvent.setup>,
  c: CommitSummary,
) {
  await user.click(
    screen.getByRole("button", { name: `Action for ${c.subject}` }),
  );
  await user.click(await screen.findByRole("menuitem", { name: /^Squash/ }));
}

// jsdom has no scrollIntoView; the dialog scrolls a moved or reseeded row in.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  vi.mocked(gitUnpushedMessages).mockReset();
  vi.mocked(gitUnpushedMessages).mockResolvedValue(
    COMMITS.map((c) => ({ hash: c.hash, message: c.subject })),
  );
  vi.mocked(loadSettings).mockReset();
  vi.mocked(loadSettings).mockImplementation(async () =>
    structuredClone(stored),
  );
  vi.mocked(saveSettingsMerged).mockReset();
  vi.mocked(saveSettingsMerged).mockImplementation(async (s) => {
    stored = structuredClone(s);
    return structuredClone(s);
  });
});

describe("Edit history order toggle", () => {
  it("renders newest-first by default", async () => {
    renderDialog(newClient("newest-first"));
    await screen.findByRole("dialog");
    expect(list()).toHaveAccessibleName("Commits, newest first");
    expect(shownSubjects()).toEqual(["Third", "Second", "First"]);
    expect(screen.getByRole("dialog")).toHaveTextContent("Newest on top;");
    expect(
      screen.getByRole("button", { name: "Newest first" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", { name: "Oldest first" }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("keeps the control clear of the close X on the title's row", async () => {
    renderDialog(newClient("newest-first"));
    const titleRow = (await screen.findByText("Edit history")).parentElement;
    expect(titleRow).toHaveClass("pr-8");
    expect(titleRow).toContainElement(
      screen.getByRole("group", { name: "Commit order" }),
    );
  });

  it("reverses the list on the click and persists the order", async () => {
    const user = userEvent.setup();
    const client = newClient("newest-first");
    renderDialog(client);
    await user.click(screen.getByRole("button", { name: "Oldest first" }));
    expect(list()).toHaveAccessibleName("Commits, oldest first");
    expect(shownSubjects()).toEqual(["First", "Second", "Third"]);
    expect(screen.getByRole("dialog")).toHaveTextContent("Oldest on top;");
    expect(cachedOrder(client)).toBe("oldest-first");
    await waitFor(() =>
      expect(saveSettingsMerged).toHaveBeenCalledWith(
        expect.objectContaining({ editHistoryOrder: "oldest-first" }),
      ),
    );
    // Pressing the pressed segment keeps it and writes nothing.
    await user.click(screen.getByRole("button", { name: "Oldest first" }));
    expect(shownSubjects()).toEqual(["First", "Second", "Third"]);
    expect(saveSettingsMerged).toHaveBeenCalledTimes(1);
  });

  it("restores the order on reopen", async () => {
    const user = userEvent.setup();
    const client = newClient("newest-first");
    const first = renderDialog(client);
    await user.click(screen.getByRole("button", { name: "Oldest first" }));
    await waitFor(() => expect(saveSettingsMerged).toHaveBeenCalled());
    first.unmount();
    renderDialog(client);
    expect(list()).toHaveAccessibleName("Commits, oldest first");
    expect(shownSubjects()).toEqual(["First", "Second", "Third"]);
  });

  it("rolls back only the order when the write fails", async () => {
    const user = userEvent.setup();
    const client = newClient("newest-first");
    let reject: ((e: Error) => void) | undefined;
    vi.mocked(saveSettingsMerged).mockImplementation(
      () =>
        new Promise((_, rej) => {
          reject = rej;
        }),
    );
    renderDialog(client);
    await user.click(screen.getByRole("button", { name: "Oldest first" }));
    expect(shownSubjects()).toEqual(["First", "Second", "Third"]);
    // A concurrent unrelated write lands before the failure.
    const latest = client.getQueryData<AppSettings>(settingsKeys.settings);
    if (latest === undefined) throw new Error("settings not cached");
    act(() => {
      client.setQueryData(settingsKeys.settings, {
        ...latest,
        changesViewMode: "tree",
      });
    });
    await act(async () => reject?.(new Error("disk full")));
    await waitFor(() =>
      expect(shownSubjects()).toEqual(["Third", "Second", "First"]),
    );
    const after = client.getQueryData<AppSettings>(settingsKeys.settings);
    expect(after?.editHistoryOrder).toBe("newest-first");
    expect(after?.changesViewMode).toBe("tree");
  });

  it("lets a stale failure roll nothing back after a later change", async () => {
    const user = userEvent.setup();
    const client = newClient("newest-first");
    const rejects: ((e: Error) => void)[] = [];
    vi.mocked(saveSettingsMerged).mockImplementation(
      () =>
        new Promise((_, rej) => {
          rejects.push(rej);
        }),
    );
    renderDialog(client);
    const press = (name: string) =>
      user.click(screen.getByRole("button", { name }));
    await press("Oldest first");
    await press("Newest first");
    await press("Oldest first");
    await waitFor(() => expect(rejects.length).toBeGreaterThan(0));
    // The first change's failure lands while the third is still pending,
    // with the order back on the value the first change set.
    await act(async () => rejects[0](new Error("disk full")));
    expect(cachedOrder(client)).toBe("oldest-first");
    expect(shownSubjects()).toEqual(["First", "Second", "Third"]);
  });

  it("lets a closed dialog's late failure roll back nothing after a reopen", async () => {
    const user = userEvent.setup();
    const client = newClient("newest-first");
    const rejects: ((e: Error) => void)[] = [];
    vi.mocked(saveSettingsMerged).mockImplementation(
      () =>
        new Promise((_, rej) => {
          rejects.push(rej);
        }),
    );
    const press = (name: string) =>
      user.click(screen.getByRole("button", { name }));
    const first = renderDialog(client);
    await press("Oldest first");
    await waitFor(() => expect(rejects.length).toBe(1));
    first.unmount();
    renderDialog(client);
    await press("Newest first");
    await press("Oldest first");
    // The closed dialog's change fails while the reopened one's are pending.
    await act(async () => rejects[0](new Error("disk full")));
    expect(cachedOrder(client)).toBe("oldest-first");
    expect(shownSubjects()).toEqual(["First", "Second", "Third"]);
  });

  it("styles the pressed segment apart from the unpressed one", async () => {
    renderDialog(newClient("newest-first"));
    for (const name of ["Newest first", "Oldest first"]) {
      const segment = await screen.findByRole("button", { name });
      expect(segment).toHaveClass(
        "h-6",
        "text-muted-foreground",
        "aria-pressed:bg-secondary",
        "aria-pressed:text-secondary-foreground",
        "aria-pressed:hover:bg-secondary",
        "hover:text-muted-foreground",
        "aria-pressed:hover:text-secondary-foreground",
        "font-normal",
        "aria-pressed:font-medium",
      );
      // The vendored hover-equal pressed fill, full-strength hover text and
      // unconditional weight are merged away.
      expect(segment).not.toHaveClass("aria-pressed:bg-muted");
      expect(segment).not.toHaveClass("hover:text-foreground");
      expect(segment).not.toHaveClass("font-medium");
    }
  });

  it("holds the toggle with a reason until settings load", async () => {
    let resolve: ((s: AppSettings) => void) | undefined;
    vi.mocked(loadSettings).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    stored = structuredClone(DEFAULT_SETTINGS);
    renderDialog(client);
    const group = await screen.findByRole("group", { name: "Commit order" });
    expect(group).toHaveAttribute("title", "Loading settings…");
    expect(screen.getByRole("button", { name: "Oldest first" })).toBeDisabled();
    await act(async () => resolve?.(structuredClone(stored)));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Oldest first" }),
      ).toBeEnabled(),
    );
    expect(group).not.toHaveAttribute("title");
  });

  it("says why the toggle is held when settings fail to load", async () => {
    vi.mocked(loadSettings).mockRejectedValue(new Error("unreadable"));
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    renderDialog(client);
    const group = await screen.findByRole("group", { name: "Commit order" });
    await waitFor(() =>
      expect(group).toHaveAttribute("title", "Couldn't load settings"),
    );
    expect(screen.getByRole("button", { name: "Newest first" })).toBeDisabled();
  });

  it("keeps the roving tab stop on the same commit across a flip", async () => {
    const user = userEvent.setup();
    renderDialog(newClient("newest-first"));
    await focusRow(SECOND);
    expect(rowOf(SECOND)).toHaveAttribute("tabindex", "0");
    await user.click(screen.getByRole("button", { name: "Oldest first" }));
    expect(rowOf(SECOND)).toHaveAttribute("tabindex", "0");
    expect(rowOf(FIRST)).toHaveAttribute("tabindex", "-1");
    expect(rowOf(THIRD)).toHaveAttribute("tabindex", "-1");
  });

  it("keeps the reversal across a reseed", async () => {
    const view = renderDialog(newClient("oldest-first"));
    view.rerender([SECOND, FIRST]);
    await waitFor(() => expect(shownSubjects()).toEqual(["First", "Second"]));
    expect(list().contains(document.activeElement)).toBe(true);
  });
});

describe("Oldest-first moves are spatial", () => {
  it("refuses at the displayed top with the oldest end's reason", async () => {
    const user = userEvent.setup();
    renderDialog(newClient("oldest-first"));
    await focusRow(FIRST);
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
    expect(status()).toHaveTextContent("Already the oldest commit");
    expect(shownSubjects()).toEqual(["First", "Second", "Third"]);
    expect(
      screen.getByRole("button", { name: "Move First up" }),
    ).toHaveAccessibleDescription("Already the oldest commit");
  });

  it("refuses at the displayed bottom with the newest end's reason", async () => {
    const user = userEvent.setup();
    renderDialog(newClient("oldest-first"));
    await focusRow(THIRD);
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(status()).toHaveTextContent("Already the newest commit");
    expect(
      screen.getByRole("button", { name: "Move Third down" }),
    ).toHaveAccessibleDescription("Already the newest commit");
  });

  it("moves down one and counts the display position", async () => {
    const user = userEvent.setup();
    renderDialog(newClient("oldest-first"));
    await focusRow(FIRST);
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(shownSubjects()).toEqual(["Second", "First", "Third"]);
    expect(status()).toHaveTextContent("Moved to 2 of 3");
    await waitFor(() => expect(rowOf(FIRST)).toHaveFocus());
  });

  it("sends the bottom row to the displayed top", async () => {
    const user = userEvent.setup();
    renderDialog(newClient("oldest-first"));
    await focusRow(THIRD);
    await user.keyboard("{Alt>}{Home}{/Alt}");
    expect(shownSubjects()).toEqual(["Third", "First", "Second"]);
    expect(status()).toHaveTextContent("Moved to 1 of 3");
    await waitFor(() => expect(rowOf(THIRD)).toHaveFocus());
  });

  it("moves a row up with its button", async () => {
    const user = userEvent.setup();
    renderDialog(newClient("oldest-first"));
    await user.click(screen.getByRole("button", { name: "Move Second up" }));
    expect(shownSubjects()).toEqual(["Second", "First", "Third"]);
    expect(status()).toHaveTextContent("Moved to 1 of 3");
  });
});

const FOLD_CASES: [ListOrder, "below" | "above", "ArrowDown" | "ArrowUp"][] = [
  ["newest-first", "below", "ArrowDown"],
  ["oldest-first", "above", "ArrowUp"],
];

describe.each(FOLD_CASES)("Fold copy in %s", (order, position, towardOlder) => {
  it("names the target and where it sits", async () => {
    const user = userEvent.setup();
    renderDialog(newClient(order));
    await setSquash(user, SECOND);
    // The older neighbor, displayed on the named side.
    const shown = shownSubjects();
    const neighbor =
      shown[shown.indexOf("Second") + (order === "oldest-first" ? -1 : 1)];
    expect(neighbor).toBe("First");
    expect(rowOf(SECOND)).toHaveTextContent('into "First"');
    await user.click(
      screen.getByRole("button", { name: `Action for ${SECOND.subject}` }),
    );
    expect(
      await screen.findByRole("menuitem", {
        name: `Squash Combine into "First" ${position}, joining the messages`,
      }),
    ).toBeInTheDocument();
  });

  it("says where the missing older commit would be for a held fold", async () => {
    const user = userEvent.setup();
    renderDialog(newClient(order));
    await setSquash(user, SECOND);
    await focusRow(SECOND);
    await user.keyboard(`{Alt>}{${towardOlder}}{/Alt}`);
    const held = `no older kept commit ${position} to combine into`;
    expect(rowOf(SECOND)).toHaveTextContent(held);
    expect(rowOf(SECOND).getAttribute("aria-label")).toContain(held);
    expect(screen.getByRole("dialog")).toHaveTextContent(
      `"Second" can't be squashed — no older commit ${position} in this list is kept to combine it into.`,
    );
    await user.click(
      screen.getByRole("button", { name: `Action for ${SECOND.subject}` }),
    );
    const squash = await screen.findByRole("menuitem", { name: /^Squash/ });
    expect(squash).toHaveTextContent(
      `No older kept commit ${position} in this list to combine into`,
    );
  });
});
