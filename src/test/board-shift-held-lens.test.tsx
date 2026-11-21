import {
  focusManager,
  notifyManager,
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
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
import {
  ghProjectItems,
  ghSetItemsFieldValues,
  ghSwitchAccount,
} from "@/lib/git/api";
import {
  useInvalidateAfterReconnect,
  useProjectItems,
  useShiftItemDates,
  useSwitchAccount,
} from "@/lib/git/queries";
import {
  shiftChasedLenses,
  shiftChasedRepos,
} from "@/lib/git/queries/board-writes";
import type {
  BoardItems,
  ProjectFieldValue,
  ProjectFieldValueUpdate,
} from "@/lib/git/types";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  ghProjectItems: vi.fn(),
  ghSetItemsFieldValues: vi.fn(),
  ghSwitchAccount: vi.fn(),
}));

/** One macrotask hop, through `setImmediate`: a timer hop costs a whole timer
 *  tick (about 15 ms on Windows). */
const hop = () => new Promise<void>((resolve) => setImmediate(resolve));

async function hops(count: number) {
  for (let i = 0; i < count; i++) await act(hop);
}

/** Hops until `check` holds; a step that never comes fails loudly. */
async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await act(hop);
  }
  throw new Error(`never: ${what}`);
}

// Query-core flushes observer notifications on a timer; on the same hop, the
// hook's renders land inside the act-wrapped hops.
beforeAll(() => notifyManager.setScheduler(setImmediate));
afterAll(() => {
  notifyManager.setScheduler((callback) => setTimeout(callback, 0));
  expect(unmockedCommands).toEqual([]);
});
afterEach(() => {
  onlineManager.setOnline(true);
  focusManager.setFocused(undefined);
  // A leftover hold would keep a later case's lens static.
  expect({
    lenses: shiftChasedLenses.size,
    repos: shiftChasedRepos.size,
  }).toEqual({ lenses: 0, repos: 0 });
});

const PROJECT = "PVT_1";
const ITEM = "PVTI_A";
const START = "PVTF_start";
const TARGET = "PVTF_target";
/** The saved view the board switches to and back from. */
const OTHER_VIEW = "status:Done";

type Dates = { start: string; target: string };
const OLD: Dates = { start: "2026-11-02", target: "2026-11-13" };
const PRESS: Dates = { start: "2026-11-09", target: "2026-11-20" };
/** A second, newer press folded into the first one's burst. */
const PRESS2: Dates = { start: "2026-11-16", target: "2026-11-27" };

/** The card's dates on GitHub. Replaced, never mutated: an answer is handed to
 *  the cache by reference. */
let server: Dates;
/** Every api call in order: `read:<view>`, `write:start`, `write:end`. */
let log: string[];
let openGate: () => void;
let gate: Promise<void>;

const datesValues = (dates: Dates): ProjectFieldValue[] => [
  {
    kind: "date",
    fieldId: START,
    fieldName: "Start",
    date: dates.start,
    isIssueField: false,
  },
  {
    kind: "date",
    fieldId: TARGET,
    fieldName: "Target",
    date: dates.target,
    isIssueField: false,
  },
];

const page = (dates: Dates): BoardItems => ({
  items: [
    {
      itemId: ITEM,
      isArchived: false,
      content: {
        kind: "draft",
        id: "DI_A",
        title: "Card A",
        body: "",
        assignees: [],
        createdAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-10-01T00:00:00Z",
      },
      fieldValues: datesValues(dates),
      addedAt: "2026-10-01T00:00:00Z",
    },
  ],
  totalCount: 1,
  truncated: false,
  endCursor: null,
});

const dateOf = (
  updates: readonly ProjectFieldValueUpdate[],
  fieldId: string,
): string => {
  const update = updates.find((u) => u.fieldId === fieldId);
  return update?.kind === "date" ? update.date : `<${update?.kind ?? "none"}>`;
};

const datesOf = (updates: readonly ProjectFieldValueUpdate[]): Dates => ({
  start: dateOf(updates, START),
  target: dateOf(updates, TARGET),
});

beforeEach(() => {
  vi.mocked(ghProjectItems).mockReset();
  vi.mocked(ghSetItemsFieldValues).mockReset();
  vi.mocked(ghSwitchAccount).mockReset();
  vi.mocked(ghProjectItems).mockImplementation(
    async (_repo, _project, _after, query) => {
      log.push(`read:${query ?? "board"}`);
      return page(server);
    },
  );
  vi.mocked(ghSetItemsFieldValues).mockImplementation(
    async (_repo, _project, itemIds, updates) => {
      log.push("write:start");
      await gate;
      server = datesOf(updates);
      log.push("write:end");
      return { outcomes: itemIds.map((itemId) => ({ itemId, error: null })) };
    },
  );
  vi.mocked(ghSwitchAccount).mockResolvedValue(undefined);
});

/** The held lens: `useProjectItems(repo, PROJECT, null, true, false, false)`. */
const lensKey = (repo: string) =>
  ["repo", repo, "project-items", PROJECT, null, false, false] as const;

const heldReads = () => log.filter((entry) => entry === "read:board").length;
/** The chase's settle re-reads the lens before its promise resolves, so it is
 *  counted from the last write's answer. */
const readsAfterLastWrite = () =>
  log.slice(log.lastIndexOf("write:end") + 1).filter((e) => e === "read:board")
    .length;
const writes = () =>
  vi
    .mocked(ghSetItemsFieldValues)
    .mock.calls.map(([, , , updates]) => datesOf(updates));

let seq = 0;

function mountBoard() {
  const repo = `C:/r-held-lens-${++seq}`;
  server = OLD;
  log = [];
  gate = new Promise((resolve) => {
    openGate = resolve;
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = renderHook(
    ({ query }: { query: string | null }) => ({
      items: useProjectItems(repo, PROJECT, query, true, false, false),
      shift: useShiftItemDates(),
      switchAccount: useSwitchAccount(),
      afterReconnect: useInvalidateAfterReconnect(),
    }),
    {
      initialProps: { query: null as string | null },
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  const press = (dates: Dates = PRESS): Promise<string> =>
    view.result.current.shift
      .mutateAsync({
        repo,
        projectId: PROJECT,
        itemId: ITEM,
        issueId: null,
        issueFieldIdByFieldId: {},
        values: datesValues(dates),
        query: null,
        archived: false,
        rich: false,
      })
      .then(
        (outcome) => outcome.kind,
        (e: unknown) => `threw: ${String(e)}`,
      );
  const cachedDates = (): Dates | null => {
    const item = client
      .getQueryData<{ pages: BoardItems[] }>(lensKey(repo))
      ?.pages[0]?.items.find((i) => i.itemId === ITEM);
    if (item === undefined) return null;
    const date = (fieldId: string) => {
      const value = item.fieldValues.find(
        (v) => v.kind !== "unknown" && v.fieldId === fieldId,
      );
      return value?.kind === "date" ? value.date : "<none>";
    };
    return { start: date(START), target: date(TARGET) };
  };
  /** Stale-marks the held lens without reading it, as a sibling write's mark
   *  does; after the shift's patch, which clears marks. */
  const staleMark = () =>
    client.invalidateQueries({
      queryKey: lensKey(repo),
      exact: true,
      refetchType: "none",
    });
  return { repo, client, view, press, cachedDates, staleMark };
}

type Board = ReturnType<typeof mountBoard>;

/** A route that can start a read of the lens, driven through the real hook or
 *  the real manager. */
type Driver = (board: Board) => Promise<void>;

const DRIVERS: Record<string, Driver> = {
  "a network reconnect (R7)": async () => {
    act(() => onlineManager.setOnline(false));
    act(() => onlineManager.setOnline(true));
  },
  "switching to another view and back (R6)": async ({ view }) => {
    view.rerender({ query: OTHER_VIEW });
    await hops(4);
    view.rerender({ query: null });
  },
  "query-core's window focus (R8)": async () => {
    act(() => focusManager.setFocused(false));
    act(() => focusManager.setFocused(true));
  },
  // The bare invalidate alone: a switch to a different login also re-reads
  // forge-status, whose account-change reset wipes the lens (left open).
  "useSwitchAccount's bare invalidate (R9)": async ({ view }) => {
    await act(() =>
      view.result.current.switchAccount.mutateAsync({
        host: "github.com",
        login: "octo",
      }),
    );
  },
  "useInvalidateAfterReconnect's callback (R10)": async ({ view }) => {
    act(() => view.result.current.afterReconnect());
  },
};

/** What one driver did during a chase and once the chase was over. */
type Observed = {
  readsWhileHeld: number;
  outcome: string;
  writes: Dates[];
  server: Dates;
  readsAfterSettle: number;
  cacheIsServer: boolean;
  heldAfterSettle: number;
  idleDriverReads: number;
};

async function runDriver(driver: Driver): Promise<Observed> {
  const board = mountBoard();
  const { view, client, press, cachedDates, staleMark } = board;
  await until(() => view.result.current.items.isSuccess, "the board loads");
  let pressed: Promise<string> = Promise.resolve("never pressed");
  let readsWhileHeld = -1;
  let outcome = "never settled";
  try {
    act(() => {
      pressed = press();
    });
    await until(() => log.includes("write:start"), "the write starts");
    await act(staleMark);
    const before = heldReads();
    await driver(board);
    await hops(4);
    readsWhileHeld = heldReads() - before;
  } finally {
    if (!onlineManager.isOnline()) act(() => onlineManager.setOnline(true));
    openGate();
    outcome = await act(() => pressed);
  }
  await hops(4);
  const readsAfterSettle = readsAfterLastWrite();
  const heldAfterSettle = shiftChasedLenses.size + shiftChasedRepos.size;
  const cacheIsServer =
    JSON.stringify(cachedDates()) === JSON.stringify(server);
  // The same driver over the now-idle lens: it reads, so the driver is live and
  // the hold has let go.
  await act(staleMark);
  const idleBefore = heldReads();
  await driver(board);
  await hops(4);
  const observed: Observed = {
    readsWhileHeld,
    outcome,
    writes: writes(),
    server,
    readsAfterSettle,
    cacheIsServer,
    heldAfterSettle,
    idleDriverReads: heldReads() - idleBefore,
  };
  view.unmount();
  client.clear();
  return observed;
}

const HELD: Observed = {
  readsWhileHeld: 0,
  outcome: "converged",
  writes: [PRESS],
  server: PRESS,
  readsAfterSettle: 1,
  cacheIsServer: true,
  heldAfterSettle: 0,
  idleDriverReads: 1,
};

describe("a board lens a date-shift chase holds", () => {
  it.each(Object.keys(DRIVERS))(
    "isn't read by %s, and the chase writes only the user's dates",
    async (name) => {
      expect(await runDriver(DRIVERS[name] as Driver)).toEqual(HELD);
    },
  );

  it("cancels a read of the lens paused offline, so a focus mid-chase lands none", async () => {
    const { repo, view, client, press, cachedDates } = mountBoard();
    await until(() => view.result.current.items.isSuccess, "the board loads");
    const lensState = () => client.getQueryState(lensKey(repo));
    let pressed: Promise<string> = Promise.resolve("never pressed");
    let readsWhileHeld = -1;
    let pausedAtResume = "unread";
    let outcome = "never settled";
    try {
      // Offline: the press patches and parks before its request, and a read of
      // the lens started after the patch parks too.
      act(() => onlineManager.setOnline(false));
      act(() => {
        pressed = press();
      });
      await until(
        () =>
          client
            .getMutationCache()
            .getAll()
            .some((m) => m.state.isPaused),
        "the press parks offline",
      );
      act(() => {
        void client.invalidateQueries({ queryKey: lensKey(repo), exact: true });
      });
      await until(
        () => lensState()?.fetchStatus === "paused",
        "the read parks offline",
      );
      // Online: the press resumes and its chase takes the hold.
      act(() => onlineManager.setOnline(true));
      await until(() => log.includes("write:start"), "the write starts");
      pausedAtResume = lensState()?.fetchStatus ?? "no lens";
      const before = heldReads();
      act(() => focusManager.setFocused(false));
      act(() => focusManager.setFocused(true));
      await hops(4);
      readsWhileHeld = heldReads() - before;
    } finally {
      if (!onlineManager.isOnline()) act(() => onlineManager.setOnline(true));
      openGate();
      outcome = await act(() => pressed);
    }
    await hops(4);
    expect({
      pausedAtResume,
      readsWhileHeld,
      outcome,
      writes: writes(),
      server,
      readsAfterSettle: readsAfterLastWrite(),
      cacheIsServer: JSON.stringify(cachedDates()) === JSON.stringify(server),
    }).toEqual({
      pausedAtResume: "idle",
      readsWhileHeld: 0,
      outcome: "converged",
      writes: [PRESS],
      server: PRESS,
      readsAfterSettle: 1,
      cacheIsServer: true,
    });
    view.unmount();
    client.clear();
  });

  it("writes only the press when the lens was collected and its first load lands mid-write", async () => {
    const { repo, view, client, press, cachedDates } = mountBoard();
    await until(() => view.result.current.items.isSuccess, "the board loads");
    let pressed: Promise<string> = Promise.resolve("never pressed");
    let outcome = "never settled";
    let loadedMidWrite: Dates | null = null;
    try {
      // Offline: the press patches and parks before its request.
      act(() => onlineManager.setOnline(false));
      act(() => {
        pressed = press();
      });
      await until(
        () =>
          client
            .getMutationCache()
            .getAll()
            .some((m) => m.state.isPaused),
        "the press parks offline",
      );
      // Another view leaves the lens unobserved, and its entry is collected.
      view.rerender({ query: OTHER_VIEW });
      await hops(4);
      act(() => client.removeQueries({ queryKey: lensKey(repo), exact: true }));
      // Online: the press resumes with no card cached, and sends its own dates.
      act(() => onlineManager.setOnline(true));
      await until(() => log.includes("write:start"), "the write starts");
      // Back to the lens while the write is held: its first load answers with
      // the dates GitHub held before the write.
      view.rerender({ query: null });
      await until(() => cachedDates() !== null, "the lens loads mid-write");
      loadedMidWrite = cachedDates();
    } finally {
      // A throw above must not tear down with the press parked or chasing.
      if (!onlineManager.isOnline()) act(() => onlineManager.setOnline(true));
      openGate();
      outcome = await act(() => pressed);
    }
    await hops(4);
    expect({
      loadedMidWrite,
      outcome,
      writes: writes(),
      server,
      readsAfterSettle: readsAfterLastWrite(),
      cacheIsServer: JSON.stringify(cachedDates()) === JSON.stringify(server),
    }).toEqual({
      loadedMidWrite: OLD,
      outcome: "converged",
      writes: [PRESS],
      server: PRESS,
      readsAfterSettle: 1,
      cacheIsServer: true,
    });
    view.unmount();
    client.clear();
  });

  it("still chases a press folded in after the collected lens's first load lands mid-write", async () => {
    const { repo, view, client, press, cachedDates } = mountBoard();
    await until(() => view.result.current.items.isSuccess, "the board loads");
    let pressed: Promise<string> = Promise.resolve("never pressed");
    let pressed2: Promise<string> = Promise.resolve("never pressed");
    let outcome = "never settled";
    let outcome2 = "never settled";
    let loadedMidWrite: Dates | null = null;
    let patched: Dates | null = null;
    try {
      act(() => onlineManager.setOnline(false));
      act(() => {
        pressed = press();
      });
      await until(
        () =>
          client
            .getMutationCache()
            .getAll()
            .some((m) => m.state.isPaused),
        "the press parks offline",
      );
      view.rerender({ query: OTHER_VIEW });
      await hops(4);
      act(() => client.removeQueries({ queryKey: lensKey(repo), exact: true }));
      act(() => onlineManager.setOnline(true));
      await until(() => log.includes("write:start"), "the write starts");
      view.rerender({ query: null });
      // The load lands BEFORE the second press: a press ahead of it would cancel
      // that load in its onMutate and patch no card.
      await until(() => cachedDates() !== null, "the lens loads mid-write");
      loadedMidWrite = cachedDates();
      act(() => {
        pressed2 = press(PRESS2);
      });
      await until(
        () => JSON.stringify(cachedDates()) === JSON.stringify(PRESS2),
        "the second press patches the card",
      );
      patched = cachedDates();
    } finally {
      if (!onlineManager.isOnline()) act(() => onlineManager.setOnline(true));
      openGate();
      outcome = await act(() => pressed);
      outcome2 = await act(() => pressed2);
    }
    await hops(4);
    expect({
      loadedMidWrite,
      patched,
      outcome,
      outcome2,
      writes: writes(),
      server,
      cacheIsServer: JSON.stringify(cachedDates()) === JSON.stringify(server),
    }).toEqual({
      loadedMidWrite: OLD,
      patched: PRESS2,
      outcome: "converged",
      outcome2: "folded",
      writes: [PRESS, PRESS2],
      server: PRESS2,
      cacheIsServer: true,
    });
    view.unmount();
    client.clear();
  });

  it("releases both holds when the first write fails, and the settle reads once", async () => {
    const { view, client, press, cachedDates } = mountBoard();
    await until(() => view.result.current.items.isSuccess, "the board loads");
    vi.mocked(ghSetItemsFieldValues).mockImplementationOnce(
      async (_repo, _project, itemIds) => {
        log.push("write:start");
        log.push("write:end");
        return {
          outcomes: itemIds.map((itemId) => ({ itemId, error: "boom" })),
        };
      },
    );
    let pressed: Promise<string> = Promise.resolve("never pressed");
    act(() => {
      pressed = press();
    });
    const outcome = await act(() => pressed);
    await hops(4);
    expect({
      outcome,
      writes: writes(),
      server,
      readsAfterSettle: readsAfterLastWrite(),
      cacheIsServer: JSON.stringify(cachedDates()) === JSON.stringify(server),
    }).toEqual({
      outcome: "threw: Error: boom",
      writes: [PRESS],
      server: OLD,
      readsAfterSettle: 1,
      cacheIsServer: true,
    });
    view.unmount();
    client.clear();
  });
});
