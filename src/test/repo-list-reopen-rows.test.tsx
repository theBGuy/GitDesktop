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
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MENU_HELD_ROW_CLASS } from "@/components/menu-held-row";
import { RepoList } from "@/features/repository/RepoList";
import type { RepoOwner } from "@/lib/git/types";
import { type ReopenHint, useReopenHint } from "@/lib/last-checkout/hint";
import {
  type AppSettings,
  loadSettings,
  type RecentRepo,
} from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";
import { settingsKeys } from "@/lib/settings/queries";
import { unmockedCommands } from "./setup";

type OpenFn = (
  path: string,
  source?: "recent" | "picker",
  stillCurrent?: () => boolean,
  opts?: { preferMain?: boolean },
) => Promise<boolean>;

const { openMock } = vi.hoisted(() => ({
  openMock: vi.fn<OpenFn>(),
}));

vi.mock("@/lib/last-checkout/hint", () => ({ useReopenHint: vi.fn() }));
vi.mock("@/features/repository/useOpenRepoByPath", () => ({
  useOpenRepoByPath: () => openMock,
}));
vi.mock("@/lib/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings/api")>()),
  loadSettings: vi.fn(),
}));

const ALPHA = "C:\\repos\\alpha";
const BRAVO = "C:\\repos\\bravo";
const CHARLIE = "C:\\repos\\charlie";
const MY_SPACE = "C:\\repos\\my repo";
const MY_UNDERSCORE = "C:\\repos\\my_repo";
const OLD = "C:\\repos\\my repo (old)";
const GOLF = "C:\\repos\\golf";

const LONG_NAME =
  "a-very-long-worktree-folder-name-that-cannot-fit-in-the-row-width";

/** The remembered worktree per row; BRAVO has no record. CHARLIE has one, but
 *  the hook answers null for the current repo's row (the hook's current-repo
 *  contract). */
const HINTS: Record<string, ReopenHint> = {
  [ALPHA]: { path: "C:\\wt\\fix-auth", name: "fix-auth-timeout" },
  [CHARLIE]: { path: "C:\\wt\\charlie-wt", name: "charlie-wt" },
  [MY_SPACE]: { path: "C:\\wt\\space", name: "wt-space" },
  [MY_UNDERSCORE]: { path: "C:\\wt\\underscore", name: "wt-underscore" },
  [OLD]: { path: "C:\\wt\\long", name: LONG_NAME },
  [GOLF]: { path: "C:\\wt\\zz", name: "zz-unique-wt" },
};

/** Seven rows: the first five fill the Recent slice, the last two (both
 *  hinted) group under their owners. */
function record(path: string, owner: string, alias?: string): RecentRepo {
  const name = path.split("\\").pop() ?? path;
  return {
    path,
    name,
    lastOpenedAt: "2026-11-01T00:00:00Z",
    alias,
    owner,
    host: "github.com",
    provider: "github",
    repoName: name,
    visibility: "private",
    isFork: false,
  };
}
const RECENTS: RecentRepo[] = [
  record(ALPHA, "octo"),
  record(BRAVO, "octo"),
  record(CHARLIE, "octo"),
  record(MY_SPACE, "octo"),
  record(MY_UNDERSCORE, "octo"),
  record(OLD, "octo", "Old one"),
  record(GOLF, "zed"),
];

const ESCAPE_DESC = "Shift+Enter opens the main workspace";
const titleFor = (name: string) =>
  `Opens in worktree ${name}. Shift+Enter or Shift+click opens the main workspace.`;

// jsdom implements no scrollIntoView; the list scrolls the marked row in.
Element.prototype.scrollIntoView ??= () => undefined;

beforeEach(() => {
  openMock.mockReset();
  openMock.mockResolvedValue(false);
  vi.mocked(useReopenHint).mockReset();
  vi.mocked(useReopenHint).mockImplementation((rowPath, currentPath) =>
    rowPath === currentPath ? null : (HINTS[rowPath] ?? null),
  );
});

afterAll(() => {
  expect(unmockedCommands).toEqual([]);
});

function renderList(currentPath: string | null = null) {
  const stored: AppSettings = {
    ...structuredClone(DEFAULT_SETTINGS),
    recentRepos: RECENTS,
  };
  vi.mocked(loadSettings).mockImplementation(async () =>
    structuredClone(stored),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(settingsKeys.settings, stored);
  seedOwners(client, RECENTS);
  const user = userEvent.setup();
  // Fresh callback props, so a rerender re-renders the list itself.
  const ui = () => (
    <QueryClientProvider client={client}>
      <RepoList
        currentPath={currentPath}
        onAliasRepo={vi.fn()}
        onRemoveRepo={vi.fn()}
      />
    </QueryClientProvider>
  );
  const view = render(ui());
  return {
    user,
    client,
    rerenderList: () => view.rerender(ui()),
    unmount: view.unmount,
  };
}

/** Owners rows equal to the records, so neither backfill effect fires. */
function seedOwners(client: QueryClient, repos: RecentRepo[]) {
  const owners: RepoOwner[] = repos.map((r) => ({
    path: r.path,
    owner: r.owner ?? null,
    host: r.host ?? null,
    provider: r.provider ?? null,
    repoName: r.repoName ?? null,
  }));
  client.setQueryData(["repo-owners", repos.map((r) => r.path).sort()], owners);
}

function rowOf(path: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(
    `[data-repo-path="${CSS.escape(path)}"]`,
  );
  if (!row) throw new Error(`no row for ${path}`);
  return row;
}
const optionOf = (path: string) =>
  within(rowOf(path)).getByRole("option") as HTMLButtonElement;
const filterInput = () =>
  screen.getByRole("combobox", { name: "Filter repositories" });
const HINT_SELECTOR = '[title^="Opens in worktree "]';
const hintLineOf = (path: string) =>
  optionOf(path).querySelector<HTMLElement>(HINT_SELECTOR);

/** The calls' args for `path`. The menu's call shares a row's path while its
 *  menu is on that row and passes hold=menuShown (true through the close
 *  animation), so a hold=true call there can come from either; the row calls
 *  hold only while an open is in flight. */
const callsFor = (path: string, from = 0) =>
  vi
    .mocked(useReopenHint)
    .mock.calls.slice(from)
    .filter(([p]) => p === path);

async function rightClick(
  user: ReturnType<typeof userEvent.setup>,
  el: Element,
) {
  await user.pointer({ keys: "[MouseRight]", target: el });
  return screen.findByRole("menu");
}

describe("reopen hint rows", () => {
  it("renders the subtitle line under the path on a hinted row, in both sections", () => {
    renderList();
    for (const path of [ALPHA, GOLF]) {
      const line = hintLineOf(path);
      expect(line, path).not.toBeNull();
      expect(line).toHaveClass(
        "flex",
        "min-w-0",
        "items-center",
        "gap-1",
        "text-[10px]",
        "leading-tight",
        "text-muted-foreground",
      );
      const svg = line?.querySelector("svg");
      expect(svg).toHaveAttribute("aria-hidden", "true");
      expect(line?.querySelector(".sr-only")?.textContent).toBe(
        "opens in worktree ",
      );
      // The line sits after the PathText inside the button's text column.
      expect(line?.previousElementSibling).not.toBeNull();
      expect(line?.parentElement?.parentElement).toBe(optionOf(path));
    }
    // GOLF sits in an owner group, ALPHA in the Recent slice.
    expect(
      within(rowOf(GOLF).parentElement as HTMLElement).getByText("zed"),
    ).toBeInTheDocument();
    expect(hintLineOf(GOLF)?.textContent).toBe(
      "opens in worktree zz-unique-wt",
    );
  });

  it("keeps an aliased row's name first and truncates a long worktree name", () => {
    renderList();
    const line = hintLineOf(OLD);
    const column = line?.parentElement;
    expect(column?.firstElementChild).toHaveClass("italic");
    expect(column?.firstElementChild?.textContent).toBe("Old one");
    expect(column?.lastElementChild).toBe(line);
    expect(within(line as HTMLElement).getByText(LONG_NAME)).toHaveClass(
      "min-w-0",
      "truncate",
    );
  });

  it("renders no subtitle, describedby or escape item on a null-hint row, and passes currentPath through", async () => {
    const { user } = renderList(CHARLIE);
    for (const path of [BRAVO, CHARLIE]) {
      expect(hintLineOf(path), path).toBeNull();
      expect(optionOf(path)).not.toHaveAttribute("aria-describedby");
    }
    // Control: a hinted row in the same render does carry both.
    expect(hintLineOf(ALPHA)).not.toBeNull();
    expect(optionOf(ALPHA)).toHaveAttribute("aria-describedby");
    for (const r of RECENTS)
      expect(callsFor(r.path), r.path).toContainEqual([r.path, CHARLIE, false]);

    const menu = await rightClick(user, optionOf(BRAVO));
    expect(
      within(menu).queryByRole("menuitem", { name: "Open in main workspace" }),
    ).toBeNull();
  });

  it("passes a null currentPath through from the Welcome host's shape", () => {
    renderList(null);
    for (const r of RECENTS)
      expect(callsFor(r.path), r.path).toContainEqual([r.path, null, false]);
    // The mock hides the current row only, so with no current repo CHARLIE shows.
    expect(hintLineOf(CHARLIE)).not.toBeNull();
  });

  it("names the worktree in the option and keeps the escape in its description", () => {
    renderList();
    const option = optionOf(ALPHA);
    // jsdom's accname trims each inline child, dropping the sr-only lead-in's
    // trailing space (the subtitle-line test pins that space on the node
    // itself).
    expect(option).toHaveAccessibleName(/opens in worktree\s*fix-auth-timeout/);
    expect(option).not.toHaveAccessibleName(/main workspace/);
    const descId = option.getAttribute("aria-describedby");
    expect(descId).toBeTruthy();
    const desc = document.getElementById(descId as string);
    expect(desc?.textContent).toBe(ESCAPE_DESC);
    expect(desc).toHaveAttribute("hidden");
    // Control: the description node sits outside the option, so it can't join
    // the name.
    expect(option.contains(desc)).toBe(false);
    expect(optionOf(BRAVO)).not.toHaveAccessibleName(/opens in worktree/);
  });

  it("titles the hint line with the teaching copy", () => {
    renderList();
    expect(hintLineOf(ALPHA)).toHaveAttribute(
      "title",
      titleFor("fix-auth-timeout"),
    );
    expect(hintLineOf(GOLF)).toHaveAttribute("title", titleFor("zz-unique-wt"));
  });

  it("leaves a clipped worktree name to the line's teaching title on hover", async () => {
    const { user } = renderList();
    const line = hintLineOf(OLD) as HTMLElement;
    const name = within(line).getByText(LONG_NAME);
    // jsdom lays nothing out, so the name is made to measure as clipped.
    Object.defineProperty(name, "scrollWidth", { value: 500 });
    Object.defineProperty(name, "clientWidth", { value: 100 });
    await user.hover(name);
    expect(name).not.toHaveAttribute("title");
    expect(name.closest("[title]")).toBe(line);
    expect(line).toHaveAttribute("title", titleFor(LONG_NAME));
  });
});

describe("main-workspace escapes", () => {
  it.each([
    ["hinted", ALPHA],
    ["non-hinted", BRAVO],
  ])("click threads preferMain from Shift on a %s row", async (_, path) => {
    const { user } = renderList();
    await user.click(optionOf(path));
    expect(openMock).toHaveBeenLastCalledWith(path, "recent", undefined, {
      preferMain: false,
    });
    await waitFor(() => expect(optionOf(path)).toBeEnabled());
    await user.keyboard("{Shift>}");
    await user.click(optionOf(path));
    await user.keyboard("{/Shift}");
    expect(openMock).toHaveBeenLastCalledWith(path, "recent", undefined, {
      preferMain: true,
    });
    expect(openMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["hinted", ALPHA, 1],
    ["non-hinted", BRAVO, 2],
  ])(
    "Enter threads preferMain from Shift on a %s row",
    async (_, path, downs) => {
      const { user } = renderList();
      const input = filterInput();
      expect(input).toHaveFocus();
      await user.keyboard("{ArrowDown}".repeat(downs));
      await user.keyboard("{Enter}");
      expect(openMock).toHaveBeenLastCalledWith(path, "recent", undefined, {
        preferMain: false,
      });
      await waitFor(() => expect(optionOf(path)).toBeEnabled());
      await user.keyboard("{Shift>}{Enter}{/Shift}");
      expect(openMock).toHaveBeenLastCalledWith(path, "recent", undefined, {
        preferMain: true,
      });
      expect(openMock).toHaveBeenCalledTimes(2);
    },
  );

  it("prevents text selection on Shift+mousedown only", () => {
    renderList();
    const option = optionOf(ALPHA);
    // fireEvent returns false exactly when the event was default-prevented.
    expect(fireEvent.mouseDown(option, { shiftKey: true })).toBe(false);
    expect(fireEvent.mouseDown(option)).toBe(true);
  });

  it("offers Open in main workspace first on a hinted row's menu, acting on the right-clicked row", async () => {
    let resolveOpen: (v: boolean) => void = () => undefined;
    openMock.mockImplementation(
      () =>
        new Promise<boolean>((r) => {
          resolveOpen = r;
        }),
    );
    const { user } = renderList();
    // Highlight sits on ALPHA; the menu opens on MY_SPACE.
    await user.keyboard("{ArrowDown}");
    expect(rowOf(ALPHA)).toHaveAttribute("data-highlighted", "true");
    const menu = await rightClick(user, optionOf(MY_SPACE));
    const items = within(menu).getAllByRole("menuitem");
    expect(items[0].textContent).toBe("Open in main workspace");
    expect(items[0].nextElementSibling).toHaveAttribute("role", "separator");
    expect(items[1].textContent).toBe("Create alias…");
    // Control for the in-flight-open test's held item: with no open in flight
    // it is enabled.
    expect(items[0]).not.toHaveAttribute("aria-disabled", "true");

    await user.click(items[0]);
    expect(openMock).toHaveBeenCalledTimes(1);
    expect(openMock).toHaveBeenLastCalledWith(MY_SPACE, "recent", undefined, {
      preferMain: true,
    });
    // The same spinner/freeze a row click sets: every option disabled.
    await waitFor(() => {
      for (const r of RECENTS) expect(optionOf(r.path)).toBeDisabled();
    });
    resolveOpen(false);
    await waitFor(() => expect(optionOf(MY_SPACE)).toBeEnabled());
  });

  it.each([
    ["non-hinted", BRAVO],
    ["current", CHARLIE],
  ])("leaves the escape item off a %s row's menu", async (_, path) => {
    const { user } = renderList(CHARLIE);
    const menu = await rightClick(user, optionOf(path));
    const labels = within(menu)
      .getAllByRole("menuitem")
      .map((el) => el.textContent);
    expect(labels).not.toContain("Open in main workspace");
    expect(labels[0]).toBe("Create alias…");
  });

  it("keeps the escape item while its menu is open when the hint turns null, until close", async () => {
    // Models the hook's contract: a held call returns the value it had when
    // the hold rose. Only the menu's call holds here (no open is in flight).
    const live: Record<string, ReopenHint | null> = { ...HINTS };
    const latched = new Map<string, ReopenHint | null>();
    vi.mocked(useReopenHint).mockImplementation((rowPath, _current, hold) => {
      const now = live[rowPath] ?? null;
      if (!hold) return now;
      if (!latched.has(rowPath)) latched.set(rowPath, now);
      return latched.get(rowPath) ?? null;
    });
    const { user, rerenderList } = renderList();
    const menu = await rightClick(user, optionOf(MY_SPACE));
    expect(within(menu).getAllByRole("menuitem")[0].textContent).toBe(
      "Open in main workspace",
    );
    expect(vi.mocked(useReopenHint)).toHaveBeenCalledWith(MY_SPACE, null, true);

    live[MY_SPACE] = null;
    rerenderList();
    const items = within(screen.getByRole("menu")).getAllByRole("menuitem");
    expect(items[0].textContent).toBe("Open in main workspace");
    expect(items[1].textContent).toBe("Create alias…");

    // Closing drops the hold: the menu's call is live again.
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    const from = vi.mocked(useReopenHint).mock.calls.length;
    rerenderList();
    const after = callsFor(MY_SPACE, from);
    expect(after.length).toBeGreaterThan(0);
    for (const call of after) expect(call).toEqual([MY_SPACE, null, false]);
  });

  it("keeps the escape item through the close animation when the hint turns null", async () => {
    const live: Record<string, ReopenHint | null> = { ...HINTS };
    const latched = new Map<string, ReopenHint | null>();
    vi.mocked(useReopenHint).mockImplementation((rowPath, _current, hold) => {
      const now = live[rowPath] ?? null;
      // The row and the menu share this path, so the latch is never cleared.
      if (!hold) return now;
      if (!latched.has(rowPath)) latched.set(rowPath, now);
      return latched.get(rowPath) ?? null;
    });
    const { user, rerenderList } = renderList();
    const menu = await rightClick(user, optionOf(MY_SPACE));
    const item = within(menu).getAllByRole("menuitem")[0];
    expect(item.textContent).toBe("Open in main workspace");
    // Close by a synchronous item click, so the popup is still fading out when
    // the hint changes under it.
    act(() => {
      fireEvent.click(
        within(menu).getByRole("menuitem", { name: "Create alias…" }),
      );
    });
    live[MY_SPACE] = null;
    rerenderList();
    expect(item).toBeInTheDocument();
    expect(item.textContent).toBe("Open in main workspace");
    expect(item.nextElementSibling).toHaveAttribute("role", "separator");
    // Once the close completes the hold drops and the call is live again.
    await waitFor(() => expect(menu).not.toBeInTheDocument());
    const from = vi.mocked(useReopenHint).mock.calls.length;
    rerenderList();
    for (const call of callsFor(MY_SPACE, from))
      expect(call).toEqual([MY_SPACE, null, false]);
  });

  it("asks about no path once the menu's row left recents", async () => {
    const { user, client } = renderList();
    await rightClick(user, optionOf(MY_SPACE));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    // Control: while the row is listed, the menu's call names it.
    expect(vi.mocked(useReopenHint)).toHaveBeenCalledWith(
      MY_SPACE,
      null,
      false,
    );

    const remaining = RECENTS.filter((r) => r.path !== MY_SPACE);
    const stored: AppSettings = {
      ...structuredClone(DEFAULT_SETTINGS),
      recentRepos: remaining,
    };
    vi.mocked(loadSettings).mockImplementation(async () =>
      structuredClone(stored),
    );
    seedOwners(client, remaining);
    const from = vi.mocked(useReopenHint).mock.calls.length;
    act(() => client.setQueryData(settingsKeys.settings, stored));
    await waitFor(() =>
      expect(
        document.querySelector(`[data-repo-path="${CSS.escape(MY_SPACE)}"]`),
      ).toBeNull(),
    );
    const calls = vi.mocked(useReopenHint).mock.calls.slice(from);
    expect(calls).toContainEqual(["", null, false]);
    expect(calls.map(([p]) => p)).not.toContain(MY_SPACE);
  });

  it("keeps asking about the menu's row when recents respell its path", async () => {
    const { user, client } = renderList();
    await rightClick(user, optionOf(MY_SPACE));
    const respelled = "c:/repos/MY REPO";
    const recents = RECENTS.map((r) =>
      r.path === MY_SPACE ? { ...r, path: respelled } : r,
    );
    const stored: AppSettings = {
      ...structuredClone(DEFAULT_SETTINGS),
      recentRepos: recents,
    };
    vi.mocked(loadSettings).mockImplementation(async () =>
      structuredClone(stored),
    );
    seedOwners(client, recents);
    const from = vi.mocked(useReopenHint).mock.calls.length;
    act(() => client.setQueryData(settingsKeys.settings, stored));
    await waitFor(() => expect(rowOf(respelled)).toBeInTheDocument());
    const calls = vi.mocked(useReopenHint).mock.calls.slice(from);
    expect(calls).toContainEqual([MY_SPACE, null, true]);
    expect(calls).not.toContainEqual(["", null, true]);
  });
});

describe("keyboard row menu", () => {
  it.each([
    ["ContextMenu", { key: "ContextMenu" }],
    ["Shift+F10", { key: "F10", shiftKey: true }],
  ])("%s opens the highlighted row's menu", async (_, init) => {
    const { user } = renderList();
    // Down x5 marks MY_UNDERSCORE, the SECOND row of a pair sharing one option
    // id, so an id lookup would land on MY_SPACE instead.
    await user.keyboard("{ArrowDown}".repeat(5));
    expect(rowOf(MY_UNDERSCORE)).toHaveAttribute("data-highlighted", "true");
    expect(optionOf(MY_UNDERSCORE).id).toBe(optionOf(MY_SPACE).id);
    expect(fireEvent.keyDown(filterInput(), init)).toBe(false);
    const menu = await screen.findByRole("menu");
    await user.click(
      within(menu).getByRole("menuitem", { name: "Open in main workspace" }),
    );
    expect(openMock).toHaveBeenLastCalledWith(
      MY_UNDERSCORE,
      "recent",
      undefined,
      { preferMain: true },
    );
  });

  it.each([
    ["ContextMenu with no highlighted row", { key: "ContextMenu" }],
    ["Shift+F10 with no highlighted row", { key: "F10", shiftKey: true }],
  ])("%s is left to the input", async (_, init) => {
    renderList();
    expect(document.querySelector('[data-highlighted="true"]')).toBeNull();
    expect(fireEvent.keyDown(filterInput(), init)).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("plain F10 does nothing new even with a highlighted row", async () => {
    const { user } = renderList();
    await user.keyboard("{ArrowDown}");
    expect(fireEvent.keyDown(filterInput(), { key: "F10" })).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

// WebView2 follows the Menu key's keyup with a trusted `contextmenu` that would
// open its native menu over the row menu; jsdom's events stand in for it.
describe("Menu key follow-up contextmenu", () => {
  const followUp = (target: Element = document.body) =>
    target.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    );

  async function openWith(init: { key: string; shiftKey?: boolean }) {
    const view = renderList();
    await view.user.keyboard("{ArrowDown}");
    // Held before the modal menu hides the rest of the page from queries.
    const input = filterInput();
    expect(fireEvent.keyDown(input, init)).toBe(false);
    const menu = await screen.findByRole("menu");
    return { ...view, input, menu };
  }

  it("cancels the contextmenu that follows the Menu key, once", async () => {
    const { menu } = await openWith({ key: "ContextMenu" });
    expect(followUp(menu)).toBe(false);
    // Disarmed by the one it cancelled.
    expect(followUp(menu)).toBe(true);
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("lets a contextmenu through a task after the Menu key's keyup", async () => {
    const { input, menu } = await openWith({ key: "ContextMenu" });
    fireEvent.keyUp(input, { key: "ContextMenu" });
    await act(() => new Promise((r) => setTimeout(r, 10)));
    expect(followUp(menu)).toBe(true);
  });

  /** Arms with the canceller's timers faked; `run` sees the armed state. */
  async function withFakeTimers(run: () => void) {
    const { user } = renderList();
    await user.keyboard("{ArrowDown}");
    const input = filterInput();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      act(() => {
        fireEvent.keyDown(input, { key: "ContextMenu" });
      });
      run();
    } finally {
      vi.useRealTimers();
    }
  }

  it("stays armed while the Menu key is held, until its keyup", async () => {
    await withFakeTimers(() => {
      vi.advanceTimersByTime(1500);
      expect(followUp()).toBe(false);
    });
  });

  it("lets a contextmenu through after a window blur", async () => {
    await openWith({ key: "ContextMenu" });
    window.dispatchEvent(new Event("blur"));
    expect(followUp()).toBe(true);
  });

  it("lets a contextmenu through after the last-resort bound with no keyup", async () => {
    await withFakeTimers(() => {
      vi.advanceTimersByTime(10_000);
      expect(followUp()).toBe(true);
    });
  });

  it("leaves no canceller behind when armed twice, then unmounted", async () => {
    const { input, unmount } = await openWith({ key: "ContextMenu" });
    // The second open's own contextmenu would cancel and disarm the first
    // canceller; stopped short of it here, the re-arm alone must retire it.
    const swallow = (e: Event) => e.stopImmediatePropagation();
    window.addEventListener("contextmenu", swallow, true);
    act(() => {
      fireEvent.keyDown(input, { key: "ContextMenu" });
    });
    window.removeEventListener("contextmenu", swallow, true);
    unmount();
    expect(followUp()).toBe(true);
  });

  it("disarms when the list unmounts", async () => {
    const { unmount } = await openWith({ key: "ContextMenu" });
    unmount();
    expect(followUp()).toBe(true);
  });

  it("arms nothing for Shift+F10", async () => {
    const { menu } = await openWith({ key: "F10", shiftKey: true });
    expect(followUp(menu)).toBe(true);
  });
});

describe("in-flight open", () => {
  it("holds the row hints, releases the closed menu's hint, and holds the escape item with its reason", async () => {
    let resolveOpen: (v: boolean) => void = () => undefined;
    openMock.mockImplementation(
      () =>
        new Promise<boolean>((r) => {
          resolveOpen = r;
        }),
    );
    const { user } = renderList();
    const menu = await rightClick(user, optionOf(MY_SPACE));
    const from = vi.mocked(useReopenHint).mock.calls.length;
    await user.click(
      within(menu).getByRole("menuitem", { name: "Open in main workspace" }),
    );
    await waitFor(() => {
      for (const r of RECENTS) expect(optionOf(r.path)).toBeDisabled();
    });
    // Every row's call now holds; the menu's call on MY_SPACE is live again
    // once the closed menu's exit animation completes.
    for (const r of RECENTS)
      expect(callsFor(r.path, from), r.path).toContainEqual([
        r.path,
        null,
        true,
      ]);
    await waitFor(() =>
      expect(callsFor(MY_SPACE, from)).toContainEqual([MY_SPACE, null, false]),
    );
    for (const r of RECENTS.filter((x) => x.path !== MY_SPACE))
      expect(callsFor(r.path, from), r.path).not.toContainEqual([
        r.path,
        null,
        false,
      ]);

    // A second escape while the first is pending is held with its reason on
    // the label, and starts nothing (the menu reopens from the row div: its
    // option button is disabled).
    const again = await rightClick(user, rowOf(MY_SPACE));
    const held = within(again).getAllByRole("menuitem")[0];
    expect(held.textContent).toBe(
      "Open in main workspace (a repository is opening)",
    );
    expect(held).toHaveAttribute("aria-disabled", "true");
    for (const token of MENU_HELD_ROW_CLASS.split(/\s+/))
      expect(held).toHaveClass(token);
    await user.click(held);
    expect(openMock).toHaveBeenCalledTimes(1);
    // A held item's click leaves the menu open; close it to reach the rows.
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    const settled = vi.mocked(useReopenHint).mock.calls.length;
    resolveOpen(false);
    await waitFor(() => {
      for (const r of RECENTS) expect(optionOf(r.path)).toBeEnabled();
    });
    for (const r of RECENTS) {
      const last = callsFor(r.path, settled).at(-1);
      expect(last, r.path).toEqual([r.path, null, false]);
    }
    // The freeze cleared: the list still renders in its stored order.
    const order = [...document.querySelectorAll("[data-repo-path]")].map((el) =>
      el.getAttribute("data-repo-path"),
    );
    expect(order).toEqual(RECENTS.map((r) => r.path));
  });

  it("keeps the clicked label on the closing menu while its open starts", async () => {
    openMock.mockImplementation(() => new Promise<boolean>(() => undefined));
    const { user } = renderList();
    const menu = await rightClick(user, optionOf(MY_SPACE));
    const item = within(menu).getByRole("menuitem", {
      name: "Open in main workspace",
    });
    // Synchronous, so the popup is still mounted for its exit when it renders.
    act(() => {
      fireEvent.click(item);
    });
    expect(openMock).toHaveBeenCalledTimes(1);
    expect(optionOf(MY_SPACE)).toBeDisabled();
    expect(item).toBeInTheDocument();
    expect(item.textContent).toBe("Open in main workspace");
    expect(item).not.toHaveAttribute("aria-disabled", "true");
  });
});

describe("filter and navigation", () => {
  it("never matches a worktree hint name", async () => {
    const { user } = renderList();
    await user.type(filterInput(), "zz-unique-wt");
    expect(screen.getByText("No repositories match.")).toBeInTheDocument();
    // Control: a repo name still matches.
    await user.clear(filterInput());
    await user.type(filterInput(), "golf");
    expect(screen.queryByText("No repositories match.")).toBeNull();
    expect(rowOf(GOLF)).toBeInTheDocument();
  });

  it("arrows and Enter traverse a hinted list", async () => {
    const { user } = renderList();
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowUp}");
    expect(rowOf(BRAVO)).toHaveAttribute("data-highlighted", "true");
    expect(filterInput()).toHaveAttribute(
      "aria-activedescendant",
      optionOf(BRAVO).id,
    );
    await user.keyboard("{Enter}");
    expect(openMock).toHaveBeenCalledWith(BRAVO, "recent", undefined, {
      preferMain: false,
    });
  });

  it("adds no focusable nodes", () => {
    renderList();
    const listbox = screen.getByRole("listbox", { name: "Repositories" });
    const focusable = [
      ...listbox.querySelectorAll<HTMLElement>(
        'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ];
    // Control: the hint nodes exist in this render.
    expect(listbox.querySelectorAll(HINT_SELECTOR).length).toBe(6);
    expect(focusable).toHaveLength(RECENTS.length);
    for (const el of focusable) expect(el).toHaveAttribute("role", "option");
  });

  it("gives same-sanitized paths distinct description ids", () => {
    renderList();
    const a = optionOf(MY_SPACE);
    const b = optionOf(MY_UNDERSCORE);
    // Control: the option ids themselves collide, so an id built the same way
    // would too.
    expect(a.id).toBe(b.id);
    const idA = a.getAttribute("aria-describedby");
    const idB = b.getAttribute("aria-describedby");
    expect(idA).toBeTruthy();
    expect(idA).not.toBe(idB);
    expect(
      rowOf(MY_SPACE).contains(document.getElementById(idA as string)),
    ).toBe(true);
    expect(
      rowOf(MY_UNDERSCORE).contains(document.getElementById(idB as string)),
    ).toBe(true);
    // The hostile path's id still resolves to its own row.
    const idOld = optionOf(OLD).getAttribute("aria-describedby") as string;
    expect(rowOf(OLD).contains(document.getElementById(idOld))).toBe(true);
  });
});
