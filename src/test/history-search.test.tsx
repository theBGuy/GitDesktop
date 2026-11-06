import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, StrictMode, useLayoutEffect, useState } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { HistoryPanel } from "@/features/history/HistoryPanel";
import { TabPanel } from "@/features/repository/TabPanel";
import {
  gitFindCommitsByPrefix,
  gitLog,
  gitOpState,
  gitStatus,
} from "@/lib/git/api";
import {
  HISTORY_PAGE_SIZE,
  isShaPrefixQuery,
  isShortHexQuery,
} from "@/lib/git/queries";
import type { CommitPrefixMatch, CommitSummary } from "@/lib/git/types";
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
  gitLog: vi.fn(),
  gitStatus: vi.fn(),
  gitOpState: vi.fn(),
  gitFindCommitsByPrefix: vi.fn(),
}));

const REPO = "C:/r";
const PLACEHOLDER = "Filter loaded commits, or search all history";
const FULL_LINE = "Checked the message and SHA of every commit.";
const MESSAGES_LINE = "Checked the message of every commit.";
const SHA_FAILED = "Couldn't check SHAs. Matches cover messages only.";
const GREP_FAILED = "Couldn't search messages. Matches cover SHAs only.";
// The list's refresh notice, which speaks for a stale arm.
const REFRESH_FAILED = /^Couldn't refresh matches/;
const SEARCH_KEY = (q: string) => ["repo", REPO, "log-search", q];
const SHA_KEY = (q: string) => ["repo", REPO, "log-search", { sha: q }];

/** 40 hex chars from non-zero filler, so the oid-width guard never reads a
 *  zero run. */
const hash = (lead: string, fill = "9a8b7c6d5e") =>
  (lead + fill.repeat(8)).slice(0, 40);
const HASH_HEAD = hash("abcdef0123");
const HASH_PARENT = hash("bbcdef0123");
const DEEP = hash("62016e63");
const DEEP_OLDER = hash("62016e63", "1f2e3d4c5b");
const GREP_ONLY = hash("d1e2f3a4b5");
const CAFE = hash("cafe");

const summary = (h: string, subject = `Commit ${h.slice(0, 7)}`) =>
  ({
    hash: h,
    subject,
    author: "Ada",
    authorEmail: "",
    date: "2026-11-01T10:00:00Z",
    tags: [],
    isMerge: false,
  }) satisfies CommitSummary;
const hit = (h: string, onBranch: boolean): CommitPrefixMatch => ({
  commit: summary(h),
  onBranch,
});
// A read that never settles.
const never = <T,>() => new Promise<T>(() => undefined);
// Reruns that stay pending until the test fails them, so the pending render
// unmounts a pressed Retry before any answer lands.
function heldFailures() {
  const fails: (() => void)[] = [];
  return {
    answer: <T,>() =>
      new Promise<T>((_, reject) => {
        fails.push(() => reject(new Error("still failing")));
      }),
    failAll: () =>
      act(async () => {
        for (const fail of fails.splice(0)) fail();
      }),
  };
}

let loaded: CommitSummary[];
let grepAnswer: (q: string) => Promise<CommitSummary[]>;
let shaAnswer: (p: string) => Promise<CommitPrefixMatch[]>;
const grepCalls = () =>
  vi
    .mocked(gitLog)
    .mock.calls.filter((c) => c[3])
    .map((c) => c[3]);
const shaCalls = () =>
  vi.mocked(gitFindCommitsByPrefix).mock.calls.map((c) => c[1]);

// jsdom lays nothing out, so the virtualized list (@tanstack/virtual-core
// sizes its viewport from the scroll element's clientWidth/clientHeight)
// paints no rows; a fixed client size gives it a viewport.
const CLIENT_SIZE = { clientWidth: 800, clientHeight: 600 } as const;
beforeAll(() => {
  for (const [k, v] of Object.entries(CLIENT_SIZE)) {
    Object.defineProperty(HTMLElement.prototype, k, {
      configurable: true,
      get: () => v,
    });
  }
});
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
  loaded = [summary(HASH_HEAD), summary(HASH_PARENT)];
  grepAnswer = async () => [];
  shaAnswer = async () => [];
  vi.mocked(gitLog).mockImplementation(async (_r, _limit, _skip, q) =>
    q ? grepAnswer(q) : loaded,
  );
  vi.mocked(gitFindCommitsByPrefix).mockImplementation(async (_r, p) =>
    shaAnswer(p),
  );
  vi.mocked(gitStatus).mockResolvedValue({
    branch: {
      name: "main",
      detached: false,
      oid: HASH_HEAD,
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      upstreamGone: false,
      upstreamRemote: "origin",
      upstreamBranch: "main",
      pushNameMismatch: false,
      upstreamIsRemoteDefault: true,
      pushRemote: null,
      pushBranch: null,
    },
    entries: [],
  });
  vi.mocked(gitOpState).mockResolvedValue({
    merging: false,
    rebasing: false,
    cherryPicking: false,
    reverting: false,
    editPaused: false,
    rebaseStop: null,
  });
  useUiStore.setState({ repoPath: REPO, selectedCommitHash: null });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const row = (h: string) => document.querySelector(`[data-hash="${h}"]`);
const rowOrder = () =>
  [...document.querySelectorAll("[data-hash]")].map((el) =>
    el.getAttribute("data-hash"),
  );
// The shell's pre-mounted announcement region (its first status node).
const liveRegion = () =>
  document.querySelector('[role="status"].sr-only') as HTMLElement;
// Every visible Retry: the arm lines' and the refresh notice's.
const retryButtons = () => screen.queryAllByRole("button", { name: /^Retry/ });
// react-query notifies observers on a later timer, after an awaited refetch
// resolves; flush it so a negative assertion reads the settled render.
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
const filterInput = () => screen.getByPlaceholderText(PLACEHOLDER);
// The panel shell, where a rescued Retry hands focus.
const panelShell = () => filterInput().closest('[tabindex="-1"]');
const cta = () => screen.getByRole("button", { name: /^Search all history/ });

async function renderPanel(
  wrap: (panel: ReactNode) => ReactNode = (panel) => panel,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(settingsKeys.settings, structuredClone(DEFAULT_SETTINGS));
  const utils = render(
    <QueryClientProvider client={client}>
      {wrap(<HistoryPanel repoPath={REPO} />)}
    </QueryClientProvider>,
  );
  await waitFor(() => expect(row(HASH_HEAD)).not.toBeNull());
  return { ...utils, client };
}

/** Types `text` into the filter and presses the search-all button. */
async function searchAll(text: string) {
  const user = userEvent.setup();
  await user.type(filterInput(), text);
  await user.click(cta());
  return user;
}

describe("hex-shape predicates", () => {
  it.each([
    ["abc", false, true],
    ["abcd", true, false],
    ["  ABCD ", true, false],
    ["a".repeat(64), true, false],
    ["a".repeat(65), false, false],
    ["abcg", false, false],
  ])("%j: prefix %s, short hex %s", (q, prefix, short) => {
    expect(isShaPrefixQuery(q)).toBe(prefix);
    expect(isShortHexQuery(q)).toBe(short);
  });
});

describe("Search all's SHA arm", () => {
  it("finds a commit beyond the loaded pages by an uppercase, padded prefix", async () => {
    shaAnswer = async () => [hit(DEEP, true)];
    await renderPanel();
    await searchAll(" 62016E63 ");
    await waitFor(() => expect(row(DEEP)).not.toBeNull());
    expect(shaCalls()).toEqual(["62016e63"]);
    // A real row: selectable, and it carries the shared commit menu.
    fireEvent.click(row(DEEP) as Element);
    expect(useUiStore.getState().selectedCommitHash).toBe(DEEP);
    expect(row(DEEP)?.classList.contains("bg-accent")).toBe(true);
    fireEvent.contextMenu(row(DEEP) as Element);
    for (const item of [
      "Checkout commit",
      "Revert changes in commit",
      "Cherry-pick commit",
      "Create branch from commit…",
      "Create tag…",
      "Copy SHA",
    ]) {
      expect(
        await screen.findByRole("menuitem", { name: item }),
      ).toBeInTheDocument();
    }
  });

  it("accepts a full 64-char id", async () => {
    const id = "6201".repeat(16);
    await renderPanel();
    await searchAll(id);
    await waitFor(() => expect(shaCalls()).toEqual([id]));
  });

  it("lists every on-branch match of an ambiguous prefix, in wire order", async () => {
    shaAnswer = async () => [hit(DEEP_OLDER, true), hit(DEEP, true)];
    await renderPanel();
    await searchAll("62016e63");
    await waitFor(() => expect(rowOrder()).toEqual([DEEP_OLDER, DEEP]));
  });

  it("lists a commit both arms matched once, at its SHA position", async () => {
    shaAnswer = async () => [hit(CAFE, true)];
    grepAnswer = async () => [summary(GREP_ONLY, "cafe menu"), summary(CAFE)];
    await renderPanel();
    await searchAll("cafe");
    await waitFor(() => expect(rowOrder()).toEqual([CAFE, GREP_ONLY]));
    expect(screen.queryByText(/Couldn't/)).toBeNull();
  });
});

describe("off-branch notice", () => {
  const OFF = hash("6201a");

  it("replaces the empty line once the grep settles empty", async () => {
    shaAnswer = async () => [hit(OFF, false)];
    const { container } = await renderPanel();
    await searchAll("6201a");
    const open = await screen.findByRole("button", { name: /^Open commit/ });
    const line = open.previousElementSibling as HTMLElement;
    expect(line.textContent).toBe(`${OFF.slice(0, 7)} isn't on this branch`);
    const sha = line.querySelector(".font-mono");
    expect(sha?.textContent).toBe(OFF.slice(0, 7));
    expect(sha?.classList.contains("text-foreground")).toBe(true);
    // Outside the virtualized scroll container.
    expect(line.closest(".overflow-y-auto")).toBeNull();
    await waitFor(() => expect(grepCalls()).toEqual(["6201a"]));
    await waitFor(() =>
      expect(screen.queryByText("Searching all history…")).toBeNull(),
    );
    expect(container.textContent).not.toContain("No commits on this branch");
  });

  it("sits over 'Searching all history…' while the grep still runs", async () => {
    shaAnswer = async () => [hit(OFF, false)];
    grepAnswer = never;
    await renderPanel();
    await searchAll("6201a");
    await screen.findByRole("button", { name: /^Open commit/ });
    expect(screen.getByText("Searching all history…")).toBeInTheDocument();
  });

  it("caps at three rows plus an overflow line", async () => {
    shaAnswer = async () =>
      ["1", "2", "3", "4"].map((c) => hit(hash(`6201${c}`), false));
    await renderPanel();
    await searchAll("6201");
    expect(
      await screen.findByText("+1 more match isn't on this branch"),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: /^Open commit/ }),
    ).toHaveLength(3);
  });

  it("counts two or more overflow matches in the plural", async () => {
    shaAnswer = async () =>
      ["1", "2", "3", "4", "5"].map((c) => hit(hash(`6201${c}`), false));
    await renderPanel();
    await searchAll("6201");
    expect(
      await screen.findByText("+2 more matches aren't on this branch"),
    ).toBeInTheDocument();
  });

  it("lengthens every shown SHA until two that share 7 chars differ", async () => {
    const ids = [hash("6201abc1"), hash("6201f"), hash("6201abc2")];
    shaAnswer = async () => ids.map((h) => hit(h, false));
    await renderPanel();
    await searchAll("6201");
    const buttons = await screen.findAllByRole("button", {
      name: /^Open commit/,
    });
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(
      ids.map((h) => `Open commit ${h.slice(0, 8)}`),
    );
    expect(
      buttons.map(
        (b) =>
          b.previousElementSibling?.querySelector(".font-mono")?.textContent,
      ),
    ).toEqual(ids.map((h) => h.slice(0, 8)));
  });

  it("measures SHA length over the shown rows only, not the overflow", async () => {
    const shown = [hash("6201abc1"), hash("6201f"), hash("6201d")];
    // Beyond the cap of three, sharing 7 chars with the first shown row.
    const overflow = hash("6201abc2");
    shaAnswer = async () => [...shown, overflow].map((h) => hit(h, false));
    await renderPanel();
    await searchAll("6201");
    expect(
      await screen.findByText("+1 more match isn't on this branch"),
    ).toBeInTheDocument();
    const buttons = screen.getAllByRole("button", { name: /^Open commit/ });
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(
      shown.map((h) => `Open commit ${h.slice(0, 7)}`),
    );
    expect(
      buttons.map(
        (b) =>
          b.previousElementSibling?.querySelector(".font-mono")?.textContent,
      ),
    ).toEqual(shown.map((h) => h.slice(0, 7)));
  });

  it("a focused Open commit whose match turns on-branch hands focus to the panel", async () => {
    shaAnswer = async () => [hit(OFF, false)];
    const { client } = await renderPanel();
    await searchAll("6201a");
    const open = await screen.findByRole("button", { name: /^Open commit/ });
    act(() => open.focus());
    expect(document.activeElement).toBe(open);
    shaAnswer = async () => [hit(OFF, true)];
    await act(() => client.refetchQueries({ queryKey: SHA_KEY("6201a") }));
    await settle();
    expect(screen.queryByRole("button", { name: /^Open commit/ })).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.contains(filterInput())).toBe(true);
  });

  it("a focused Open commit whose row turns on-branch hands focus to the next row's button", async () => {
    const OTHER = hash("6201b");
    shaAnswer = async () => [hit(OFF, false), hit(OTHER, false)];
    const { client } = await renderPanel();
    await searchAll("6201");
    const first = await screen.findByRole("button", {
      name: `Open commit ${OFF.slice(0, 7)}`,
    });
    act(() => first.focus());
    shaAnswer = async () => [hit(OFF, true), hit(OTHER, false)];
    await act(() => client.refetchQueries({ queryKey: SHA_KEY("6201") }));
    await settle();
    expect(first.isConnected).toBe(false);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: `Open commit ${OTHER.slice(0, 7)}` }),
    );
  });

  it("a focused last row turning on-branch hands focus to the row before it", async () => {
    const OTHER = hash("6201b");
    shaAnswer = async () => [hit(OFF, false), hit(OTHER, false)];
    const { client } = await renderPanel();
    await searchAll("6201");
    const second = await screen.findByRole("button", {
      name: `Open commit ${OTHER.slice(0, 7)}`,
    });
    act(() => second.focus());
    shaAnswer = async () => [hit(OFF, false), hit(OTHER, true)];
    await act(() => client.refetchQueries({ queryKey: SHA_KEY("6201") }));
    await settle();
    expect(second.isConnected).toBe(false);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: `Open commit ${OFF.slice(0, 7)}` }),
    );
  });

  it("a focused third row turning on-branch hands focus to the row that slides in", async () => {
    const ids = ["1", "2", "3", "4"].map((c) => hash(`6201${c}`));
    shaAnswer = async () => ids.map((h) => hit(h, false));
    const { client } = await renderPanel();
    await searchAll("6201");
    const third = await screen.findByRole("button", {
      name: `Open commit ${ids[2].slice(0, 7)}`,
    });
    expect(
      screen.queryByRole("button", {
        name: `Open commit ${ids[3].slice(0, 7)}`,
      }),
    ).toBeNull();
    act(() => third.focus());
    shaAnswer = async () => ids.map((h, i) => hit(h, i === 2));
    await act(() => client.refetchQueries({ queryKey: SHA_KEY("6201") }));
    await settle();
    expect(third.isConnected).toBe(false);
    expect(document.activeElement).toBe(
      screen.getByRole("button", {
        name: `Open commit ${ids[3].slice(0, 7)}`,
      }),
    );
  });

  it("focus moved off Open commit stays put when the notice goes", async () => {
    shaAnswer = async () => [hit(OFF, false)];
    const { client } = await renderPanel();
    await searchAll("6201a");
    await screen.findByRole("button", { name: /^Open commit/ });
    act(() => filterInput().focus());
    shaAnswer = async () => [hit(OFF, true)];
    await act(() => client.refetchQueries({ queryKey: SHA_KEY("6201a") }));
    await settle();
    expect(screen.queryByRole("button", { name: /^Open commit/ })).toBeNull();
    expect(document.activeElement).toBe(filterInput());
  });

  it("two rows leaving at once hand focus to the next remaining row", async () => {
    const ids = ["1", "2", "3", "4"].map((c) => hash(`6201${c}`));
    shaAnswer = async () => ids.map((h) => hit(h, false));
    const { client } = await renderPanel();
    await searchAll("6201");
    const second = await screen.findByRole("button", {
      name: `Open commit ${ids[1].slice(0, 7)}`,
    });
    act(() => second.focus());
    shaAnswer = async () => ids.map((h, i) => hit(h, i < 2));
    await act(() => client.refetchQueries({ queryKey: SHA_KEY("6201") }));
    await settle();
    expect(second.isConnected).toBe(false);
    expect(document.activeElement).toBe(
      screen.getByRole("button", {
        name: `Open commit ${ids[2].slice(0, 7)}`,
      }),
    );
  });

  it("an unfocused row leaving leaves focus on <body>", async () => {
    shaAnswer = async () => [hit(OFF, false)];
    const { client } = await renderPanel();
    await searchAll("6201a");
    await screen.findByRole("button", { name: /^Open commit/ });
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    expect(document.activeElement).toBe(document.body);
    shaAnswer = async () => [hit(OFF, true)];
    await act(() => client.refetchQueries({ queryKey: SHA_KEY("6201a") }));
    await settle();
    expect(screen.queryByRole("button", { name: /^Open commit/ })).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  it("a focus move made while the row leaves is never undone", async () => {
    if (!customElements.get("gd-focus-on-disconnect")) {
      customElements.define(
        "gd-focus-on-disconnect",
        class extends HTMLElement {
          disconnectedCallback() {
            filterInput().focus();
          }
        },
      );
    }
    shaAnswer = async () => [hit(OFF, false)];
    const { client } = await renderPanel();
    await searchAll("6201a");
    const open = await screen.findByRole("button", { name: /^Open commit/ });
    open.parentElement?.append(
      document.createElement("gd-focus-on-disconnect"),
    );
    act(() => open.focus());
    shaAnswer = async () => [hit(OFF, true)];
    await act(() => client.refetchQueries({ queryKey: SHA_KEY("6201a") }));
    await settle();
    expect(open.isConnected).toBe(false);
    expect(document.activeElement).toBe(filterInput());
  });

  it("an Activity hide and re-show never moves focus", async () => {
    const control: { set?: (mode: "visible" | "hidden") => void } = {};
    // A browser drops focus from a display:none node; jsdom keeps it, so the
    // host drops it to body in the hide commit, before any microtask runs (a
    // removed focus owner falls to body; jsdom won't blur a hidden node). The
    // rescue's isConnected guard stays unpinned: without it the target is the
    // hidden row's own button, and focusing a display:none node is a no-op.
    function Host({ children }: { children: ReactNode }) {
      const [mode, setMode] = useState<"visible" | "hidden">("visible");
      useLayoutEffect(() => {
        control.set = setMode;
        if (mode !== "hidden") return;
        const away = document.createElement("button");
        document.body.append(away);
        away.focus();
        away.remove();
      });
      return <TabPanel active={mode === "visible"}>{children}</TabPanel>;
    }
    shaAnswer = async () => [hit(OFF, false)];
    await renderPanel((panel) => <Host>{panel}</Host>);
    await searchAll("6201a");
    const open = await screen.findByRole("button", { name: /^Open commit/ });
    act(() => open.focus());
    act(() => control.set?.("hidden"));
    await settle();
    expect(open.isConnected).toBe(true);
    expect(document.activeElement).toBe(document.body);
    act(() => control.set?.("visible"));
    await settle();
    expect(document.activeElement).toBe(document.body);
  });

  it("under StrictMode a later commit never re-runs a spent rescue", async () => {
    const ids = ["1", "2", "3", "4"].map((c) => hash(`6201${c}`));
    shaAnswer = async () => ids.map((h) => hit(h, false));
    const { client } = await renderPanel((panel) => (
      <StrictMode>{panel}</StrictMode>
    ));
    await searchAll("6201");
    const third = await screen.findByRole("button", {
      name: `Open commit ${ids[2].slice(0, 7)}`,
    });
    act(() => third.focus());
    shaAnswer = async () => ids.map((h, i) => hit(h, i === 2));
    await act(() => client.refetchQueries({ queryKey: SHA_KEY("6201") }));
    await settle();
    const slidIn = screen.getByRole("button", {
      name: `Open commit ${ids[3].slice(0, 7)}`,
    });
    expect(document.activeElement).toBe(slidIn);
    act(() => slidIn.blur());
    expect(document.activeElement).toBe(document.body);
    await act(() => client.refetchQueries({ queryKey: SHA_KEY("6201") }));
    await settle();
    expect(document.activeElement).toBe(document.body);
  });

  it("Open commit selects the full hash and clears the list selection", async () => {
    shaAnswer = async () => [hit(OFF, false)];
    grepAnswer = async () => [summary(GREP_ONLY)];
    await renderPanel();
    const user = await searchAll("6201a");
    await waitFor(() => expect(row(GREP_ONLY)).not.toBeNull());
    fireEvent.click(row(GREP_ONLY) as Element);
    expect(row(GREP_ONLY)?.classList.contains("bg-accent")).toBe(true);
    const open = screen.getByRole("button", { name: /^Open commit/ });
    await user.click(open);
    const ui = useUiStore.getState();
    expect(ui.selectedCommitHash).toBe(OFF);
    expect(ui.repoTab).toBe("history");
    expect(document.querySelectorAll("[data-hash].bg-accent")).toHaveLength(0);
    expect(row(OFF)).toBeNull();
    expect(document.activeElement).toBe(open);
  });
});

describe("debounce and the search-all button", () => {
  it("waits 300 ms after typing; the button runs the live text at once", async () => {
    grepAnswer = async (q) => (q === "abcd" ? [summary(GREP_ONLY)] : never());
    await renderPanel();
    vi.useFakeTimers();
    // Testing Library flushes its async wrapper on a setTimeout it advances only
    // through a jest global; without one, faked timers never fire it.
    vi.stubGlobal("jest", { advanceTimersByTime: vi.advanceTimersByTime });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.type(filterInput(), "ab");
    await act(() => vi.advanceTimersByTimeAsync(300));
    await user.type(filterInput(), "cd");
    // Pressed inside the window: one call each, for the live text.
    await user.click(cta());
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(grepCalls()).toEqual(["abcd"]);
    expect(shaCalls()).toEqual(["abcd"]);
    expect(row(GREP_ONLY)).not.toBeNull();

    await user.type(filterInput(), "e");
    await act(() => vi.advanceTimersByTimeAsync(299));
    expect(grepCalls()).toEqual(["abcd"]);
    expect(shaCalls()).toEqual(["abcd"]);
    // The old answer stays through the window.
    expect(row(GREP_ONLY)).not.toBeNull();

    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(grepCalls()).toEqual(["abcd", "abcde"]);
    expect(shaCalls()).toEqual(["abcd", "abcde"]);
    expect(row(GREP_ONLY)).toBeNull();
    expect(screen.getByText("Searching all history…")).toBeInTheDocument();
    expect(screen.queryByText(/No commits/)).toBeNull();
  });

  it("a press inside the window lets go once the text returns to the settled value", async () => {
    grepAnswer = async (q) => (q === "abcd" ? never() : []);
    await renderPanel();
    vi.useFakeTimers();
    vi.stubGlobal("jest", { advanceTimersByTime: vi.advanceTimersByTime });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.type(filterInput(), "ab");
    await act(() => vi.advanceTimersByTimeAsync(300));
    await user.type(filterInput(), "cd");
    await user.click(cta());
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(grepCalls()).toEqual(["abcd"]);
    // Back to the text the debounce last settled on, so it settles on no new
    // value.
    await user.type(filterInput(), "{Backspace}{Backspace}");
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(grepCalls()).toEqual(["abcd", "ab"]);
    expect(screen.queryByText("Searching all history…")).toBeNull();
    expect(
      screen.getByText('No commits on this branch match "ab"'),
    ).toBeInTheDocument();
  });

  it("never runs the SHA arm before the button, or for a query it can't take", async () => {
    await renderPanel();
    const user = userEvent.setup();
    await user.type(filterInput(), "62016e63");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });
    expect(shaCalls()).toEqual([]);
    expect(grepCalls()).toEqual([]);

    for (const q of ["62016g63", "abc", "a".repeat(65)]) {
      await user.clear(filterInput());
      await user.type(filterInput(), q);
      await user.click(cta());
      await waitFor(() => expect(grepCalls()).toContain(q));
    }
    expect(shaCalls()).toEqual([]);
  });
});

describe("empty states", () => {
  it("the loaded filter names what it checked", async () => {
    await renderPanel();
    await userEvent.setup().type(filterInput(), "zzz");
    expect(
      screen.getByText('No loaded commits match "zzz"'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Checked the subject, author and SHA of 2 loaded commits.",
      ),
    ).toBeInTheDocument();
  });

  it("counts one loaded commit in the singular", async () => {
    loaded = [summary(HASH_HEAD)];
    await renderPanel();
    await userEvent.setup().type(filterInput(), "zzz");
    expect(
      screen.getByText(
        "Checked the subject, author and SHA of 1 loaded commit.",
      ),
    ).toBeInTheDocument();
  });

  it.each([
    ["a non-hex query", "zzzz", FULL_LINE],
    ["a SHA-eligible query", "a1b2", FULL_LINE],
    ["a 1-3-char hex query", "abc", MESSAGES_LINE],
    ["a 65-char hex query", "b".repeat(65), FULL_LINE],
  ])("search all with %s says what it covered", async (_n, q, line) => {
    await renderPanel();
    await searchAll(q);
    expect(
      await screen.findByText(`No commits on this branch match "${q}"`),
    ).toBeInTheDocument();
    expect(screen.getByText(line)).toBeInTheDocument();
  });
});

describe("partial failure", () => {
  it("a dead SHA arm swaps the coverage claim for its own Retry", async () => {
    shaAnswer = () => Promise.reject(new Error("sha boom"));
    await renderPanel();
    await searchAll("a1b2");
    // Only messages were checked, so the headline claims no more than that.
    expect(
      await screen.findByText('No commit messages on this branch match "a1b2"'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('No commits on this branch match "a1b2"'),
    ).toBeNull();
    expect(screen.getByText(SHA_FAILED)).toBeInTheDocument();
    expect(screen.queryByText(FULL_LINE)).toBeNull();
    const retry = screen.getByRole("button", { name: "Retry" });
    const grepBefore = grepCalls().length;
    const held = heldFailures();
    shaAnswer = held.answer;
    await userEvent.setup().click(retry);
    await waitFor(() => expect(shaCalls()).toHaveLength(2));
    expect(grepCalls()).toHaveLength(grepBefore);
    await waitFor(() => expect(retry.isConnected).toBe(false));
    expect(document.activeElement).toBe(panelShell());
    await held.failAll();
    expect(await screen.findByText(SHA_FAILED)).toBeInTheDocument();
  });

  it("both arms stale over kept rows show one refresh notice, whose Retry reruns both", async () => {
    shaAnswer = async () => [hit(DEEP, true)];
    grepAnswer = async () => [summary(GREP_ONLY)];
    const { client } = await renderPanel();
    await searchAll("62016e63");
    await waitFor(() => expect(row(GREP_ONLY)).not.toBeNull());
    expect(row(DEEP)).not.toBeNull();
    shaAnswer = () => Promise.reject(new Error("sha boom"));
    grepAnswer = () => Promise.reject(new Error("grep boom"));
    await act(() =>
      client.refetchQueries({ queryKey: ["repo", REPO, "log-search"] }),
    );
    await settle();
    expect(screen.getByText(REFRESH_FAILED)).toBeInTheDocument();
    expect(screen.queryByText(SHA_FAILED)).toBeNull();
    expect(screen.queryByText(GREP_FAILED)).toBeNull();
    expect(screen.queryByText("Couldn't search all history.")).toBeNull();
    expect(row(DEEP)).not.toBeNull();
    expect(row(GREP_ONLY)).not.toBeNull();
    expect(liveRegion().textContent).toBe("");
    expect(retryButtons()).toHaveLength(1);
    const grepBefore = grepCalls().length;
    const shaBefore = shaCalls().length;
    // Pending reruns unmount the line under focus.
    grepAnswer = never;
    shaAnswer = never;
    await userEvent.setup().click(retryButtons()[0]);
    await waitFor(() => expect(grepCalls()).toHaveLength(grepBefore + 1));
    await waitFor(() => expect(shaCalls()).toHaveLength(shaBefore + 1));
    expect(document.activeElement).not.toBe(document.body);
  });

  it("a SHA refetch failing under fresh grep rows says so through the refresh notice, whose Retry reruns only the SHA arm", async () => {
    shaAnswer = async () => [hit(DEEP, true)];
    grepAnswer = async () => [summary(GREP_ONLY)];
    const { client } = await renderPanel();
    await searchAll("62016e63");
    await waitFor(() => expect(row(GREP_ONLY)).not.toBeNull());
    shaAnswer = () => Promise.reject(new Error("sha boom"));
    await act(() => client.refetchQueries({ queryKey: SHA_KEY("62016e63") }));
    await settle();
    expect(screen.getByText(REFRESH_FAILED)).toBeInTheDocument();
    expect(screen.queryByText(SHA_FAILED)).toBeNull();
    expect(row(DEEP)).not.toBeNull();
    expect(retryButtons()).toHaveLength(1);
    const grepBefore = grepCalls().length;
    const shaBefore = shaCalls().length;
    const retry = retryButtons()[0];
    // The notice's always-mounted host takes focus when its Retry unmounts.
    const noticeHost = retry.closest('[tabindex="-1"]');
    const held = heldFailures();
    shaAnswer = held.answer;
    await userEvent.setup().click(retry);
    await waitFor(() => expect(shaCalls()).toHaveLength(shaBefore + 1));
    expect(grepCalls()).toHaveLength(grepBefore);
    await waitFor(() => expect(retry.isConnected).toBe(false));
    expect(document.activeElement).toBe(noticeHost);
    await held.failAll();
    expect(await screen.findByText(REFRESH_FAILED)).toBeInTheDocument();
  });

  it("a dead SHA arm's line speaks for a stale grep too, whose Retry reruns both", async () => {
    shaAnswer = () => Promise.reject(new Error("sha boom"));
    grepAnswer = async () => [summary(GREP_ONLY)];
    const { client } = await renderPanel();
    await searchAll("62016e63");
    expect(await screen.findByText(SHA_FAILED)).toBeInTheDocument();
    grepAnswer = () => Promise.reject(new Error("grep boom"));
    const grepRefetched = grepCalls().length + 1;
    await act(() =>
      client.refetchQueries({ queryKey: SEARCH_KEY("62016e63") }),
    );
    await settle();
    expect(grepCalls()).toHaveLength(grepRefetched);
    expect(screen.getByText(SHA_FAILED)).toBeInTheDocument();
    expect(screen.queryByText(REFRESH_FAILED)).toBeNull();
    expect(row(GREP_ONLY)).not.toBeNull();
    expect(liveRegion().textContent).toBe("");
    expect(retryButtons()).toHaveLength(1);
    const shaBefore = shaCalls().length;
    // Pending reruns unmount the line under focus.
    grepAnswer = never;
    shaAnswer = never;
    await userEvent.setup().click(retryButtons()[0]);
    await waitFor(() => expect(grepCalls()).toHaveLength(grepRefetched + 1));
    await waitFor(() => expect(shaCalls()).toHaveLength(shaBefore + 1));
    expect(document.activeElement).not.toBe(document.body);
  });

  it("a dead grep keeps the SHA rows and never claims no match", async () => {
    shaAnswer = async () => [hit(DEEP, true)];
    grepAnswer = () => Promise.reject(new Error("grep boom"));
    const { container } = await renderPanel();
    await searchAll("62016e63");
    expect(await screen.findByText(GREP_FAILED)).toBeInTheDocument();
    expect(row(DEEP)).not.toBeNull();
    expect(container.textContent).not.toContain("No commits on this branch");
    expect(screen.queryByText("Couldn't search all history.")).toBeNull();
    expect(liveRegion().textContent).toBe("");
    const shaBefore = shaCalls().length;
    const retry = screen.getByRole("button", { name: "Retry" });
    const held = heldFailures();
    grepAnswer = held.answer;
    await userEvent.setup().click(retry);
    await waitFor(() => expect(grepCalls()).toHaveLength(2));
    expect(shaCalls()).toHaveLength(shaBefore);
    await waitFor(() => expect(retry.isConnected).toBe(false));
    expect(document.activeElement).toBe(panelShell());
    await held.failAll();
    expect(await screen.findByText(GREP_FAILED)).toBeInTheDocument();
  });

  it("both arms dead shows the error block, announced, whose Retry reruns both", async () => {
    const OFF = hash("6201a");
    shaAnswer = () => Promise.reject(new Error("sha boom"));
    grepAnswer = () => Promise.reject(new Error("grep boom"));
    await renderPanel();
    await searchAll("6201a");
    expect(
      await screen.findByText("Couldn't search all history."),
    ).toBeInTheDocument();
    expect(liveRegion().textContent).toContain("Couldn't search all history.");
    expect(screen.queryByText(FULL_LINE)).toBeNull();
    expect(screen.queryByText(REFRESH_FAILED)).toBeNull();
    expect(retryButtons()).toHaveLength(1);
    const retry = screen.getByRole("button", { name: "Retry" });
    const held = heldFailures();
    shaAnswer = held.answer;
    grepAnswer = held.answer;
    await userEvent.setup().click(retry);
    await waitFor(() => expect(grepCalls()).toHaveLength(2));
    await waitFor(() => expect(shaCalls()).toHaveLength(2));
    await waitFor(() => expect(retry.isConnected).toBe(false));
    expect(document.activeElement).toBe(panelShell());
    await held.failAll();
    expect(
      await screen.findByText("Couldn't search all history."),
    ).toBeInTheDocument();
    expect(row(OFF)).toBeNull();
  });

  it("a dead grep with only off-branch hits says SHAs answered, under the notices", async () => {
    const OFF = hash("6201a");
    shaAnswer = async () => [hit(OFF, false)];
    grepAnswer = () => Promise.reject(new Error("grep boom"));
    await renderPanel();
    await searchAll("6201a");
    const line = await screen.findByText(GREP_FAILED);
    const open = screen.getByRole("button", { name: /^Open commit/ });
    expect(
      open.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByText("Couldn't search all history.")).toBeNull();
    expect(liveRegion().textContent).toBe("");
    expect(row(OFF)).toBeNull();
    const shaBefore = shaCalls().length;
    const retry = screen.getByRole("button", { name: "Retry" });
    const held = heldFailures();
    grepAnswer = held.answer;
    await userEvent.setup().click(retry);
    await waitFor(() => expect(grepCalls()).toHaveLength(2));
    expect(shaCalls()).toHaveLength(shaBefore);
    await waitFor(() => expect(retry.isConnected).toBe(false));
    expect(document.activeElement).toBe(panelShell());
    await held.failAll();
    expect(await screen.findByText(GREP_FAILED)).toBeInTheDocument();
  });

  it("a dead SHA arm's empty-state line speaks for a stale grep too", async () => {
    shaAnswer = () => Promise.reject(new Error("sha boom"));
    const { client } = await renderPanel();
    await searchAll("a1b2");
    expect(await screen.findByText(SHA_FAILED)).toBeInTheDocument();
    grepAnswer = () => Promise.reject(new Error("grep boom"));
    const grepRefetched = grepCalls().length + 1;
    await act(() => client.refetchQueries({ queryKey: SEARCH_KEY("a1b2") }));
    await settle();
    expect(grepCalls()).toHaveLength(grepRefetched);
    expect(
      screen.getByText('No commit messages on this branch match "a1b2"'),
    ).toBeInTheDocument();
    expect(screen.getByText(SHA_FAILED)).toBeInTheDocument();
    expect(screen.queryByText(REFRESH_FAILED)).toBeNull();
    expect(retryButtons()).toHaveLength(1);
    const shaBefore = shaCalls().length;
    // Pending reruns unmount the line under focus.
    grepAnswer = never;
    shaAnswer = never;
    await userEvent.setup().click(retryButtons()[0]);
    await waitFor(() => expect(grepCalls()).toHaveLength(grepRefetched + 1));
    await waitFor(() => expect(shaCalls()).toHaveLength(shaBefore + 1));
    expect(document.activeElement).not.toBe(document.body);
  });

  it("a dead grep over stale off-branch hits keeps the notices over its own line", async () => {
    const OFF = hash("6201a");
    shaAnswer = async () => [hit(OFF, false)];
    grepAnswer = () => Promise.reject(new Error("grep boom"));
    const { client } = await renderPanel();
    await searchAll("6201a");
    expect(await screen.findByText(GREP_FAILED)).toBeInTheDocument();
    shaAnswer = () => Promise.reject(new Error("sha boom"));
    const shaRefetched = shaCalls().length + 1;
    await act(() => client.refetchQueries({ queryKey: SHA_KEY("6201a") }));
    await settle();
    expect(shaCalls()).toHaveLength(shaRefetched);
    expect(screen.getByText(GREP_FAILED)).toBeInTheDocument();
    expect(screen.queryByText("Couldn't search all history.")).toBeNull();
    expect(screen.queryByText(REFRESH_FAILED)).toBeNull();
    expect(
      screen.getByRole("button", { name: /^Open commit/ }),
    ).toBeInTheDocument();
    expect(liveRegion().textContent).toBe("");
    expect(retryButtons()).toHaveLength(1);
  });

  it("a grep failing before the SHA arm answers waits for it", async () => {
    let land: ((m: CommitPrefixMatch[]) => void) | undefined;
    shaAnswer = () =>
      new Promise<CommitPrefixMatch[]>((resolve) => {
        land = resolve;
      });
    grepAnswer = () => Promise.reject(new Error("grep boom"));
    const { client } = await renderPanel();
    await searchAll("62016e63");
    await waitFor(() => expect(grepCalls()).toEqual(["62016e63"]));
    await waitFor(() => expect(land).toBeDefined());
    // The grep's failure must reach the cache, then the render, before the UI's
    // absence of a failure line means anything.
    await waitFor(() =>
      expect(client.getQueryState(SEARCH_KEY("62016e63"))?.status).toBe(
        "error",
      ),
    );
    await settle();
    expect(screen.getByText("Searching all history…")).toBeInTheDocument();
    expect(screen.queryByText("Couldn't search all history.")).toBeNull();
    expect(liveRegion().textContent).toBe("");
    await act(async () => land?.([hit(DEEP, true)]));
    expect(await screen.findByText(GREP_FAILED)).toBeInTheDocument();
    expect(row(DEEP)).not.toBeNull();
    expect(screen.queryByText("Couldn't search all history.")).toBeNull();
    expect(liveRegion().textContent).toBe("");
  });

  it("a dead grep's line speaks for stale SHA rows too, whose Retry reruns both", async () => {
    shaAnswer = async () => [hit(DEEP, true)];
    grepAnswer = () => Promise.reject(new Error("grep boom"));
    const { client } = await renderPanel();
    await searchAll("62016e63");
    expect(await screen.findByText(GREP_FAILED)).toBeInTheDocument();
    shaAnswer = () => Promise.reject(new Error("sha boom"));
    const shaRefetched = shaCalls().length + 1;
    await act(() => client.refetchQueries({ queryKey: SHA_KEY("62016e63") }));
    await settle();
    expect(shaCalls()).toHaveLength(shaRefetched);
    expect(screen.getByText(GREP_FAILED)).toBeInTheDocument();
    expect(screen.queryByText("Couldn't search all history.")).toBeNull();
    expect(screen.queryByText(SHA_FAILED)).toBeNull();
    expect(screen.queryByText(REFRESH_FAILED)).toBeNull();
    expect(row(DEEP)).not.toBeNull();
    expect(liveRegion().textContent).toBe("");
    expect(retryButtons()).toHaveLength(1);
    const grepBefore = grepCalls().length;
    const shaBefore = shaCalls().length;
    // Pending reruns unmount the line under focus.
    grepAnswer = never;
    shaAnswer = never;
    await userEvent.setup().click(retryButtons()[0]);
    await waitFor(() => expect(grepCalls()).toHaveLength(grepBefore + 1));
    await waitFor(() => expect(shaCalls()).toHaveLength(shaBefore + 1));
    expect(document.activeElement).not.toBe(document.body);
  });

  it("a failed Load more keeps its own notice beside a dead SHA line, whose Retry leaves the grep pages alone", async () => {
    shaAnswer = () => Promise.reject(new Error("sha boom"));
    const page = Array.from({ length: HISTORY_PAGE_SIZE }, (_, i) =>
      summary(hash(`d${i.toString(16).padStart(4, "0")}`)),
    );
    vi.mocked(gitLog).mockImplementation(async (_r, _limit, skip, q) => {
      if (!q) return loaded;
      if (skip) throw new Error("page boom");
      return page;
    });
    await renderPanel();
    await searchAll("a1b2");
    expect(await screen.findByText(SHA_FAILED)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Load more results" }));
    expect(
      await screen.findByText(/^Couldn't load more matches/),
    ).toBeInTheDocument();
    expect(screen.getByText(SHA_FAILED)).toBeInTheDocument();
    expect(screen.queryByText(REFRESH_FAILED)).toBeNull();
    expect(retryButtons()).toHaveLength(1);
    const grepBefore = grepCalls().length;
    const shaBefore = shaCalls().length;
    shaAnswer = never;
    await user.click(retryButtons()[0]);
    await waitFor(() => expect(shaCalls()).toHaveLength(shaBefore + 1));
    await settle();
    expect(grepCalls()).toHaveLength(grepBefore);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("a dead SHA line moving from the empty state to the footer keeps focus off <body>", async () => {
    shaAnswer = () => Promise.reject(new Error("sha boom"));
    const { client } = await renderPanel();
    await searchAll("a1b2");
    expect(
      await screen.findByText('No commit messages on this branch match "a1b2"'),
    ).toBeInTheDocument();
    const retry = screen.getByRole("button", { name: "Retry" });
    act(() => retry.focus());
    expect(document.activeElement).toBe(retry);
    grepAnswer = async () => [summary(GREP_ONLY)];
    await act(() => client.refetchQueries({ queryKey: SEARCH_KEY("a1b2") }));
    await settle();
    expect(row(GREP_ONLY)).not.toBeNull();
    expect(screen.getByText(SHA_FAILED)).toBeInTheDocument();
    expect(retry.isConnected).toBe(false);
    expect(document.activeElement).not.toBe(document.body);
  });
});
