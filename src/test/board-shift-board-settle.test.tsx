import {
  notifyManager,
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
import { ghProjectItems, ghSetItemsFieldValues } from "@/lib/git/api";
import { useProjectItems, useShiftItemDates } from "@/lib/git/queries";
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

/** The negative control's switch: while `inert` is on, the defences a chase's
 *  hold drives read as unheld (see the mock below). */
const control = vi.hoisted(() => ({ inert: false }));

// The real module, with BOTH chase-hold defences the board settle meets made
// switchable for the control, each reading `control.inert` on every call: the
// repo count, whose `set` does nothing while the control is on, and the lens's
// held staleTime, which then stays numeric, so `refetchQueries` doesn't skip the
// held lens. A defence added beside them joins this object the same way.
vi.mock("@/lib/git/queries/board-writes", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@/lib/git/queries/board-writes")>();
  class InertableCount extends Map<string, number> {
    override set(key: string, value: number): this {
      return control.inert ? this : super.set(key, value);
    }
  }
  return {
    ...real,
    shiftChasedRepos: new InertableCount(),
    staleTimeUnlessHeld: (
      held: ReadonlyMap<string, number>,
      staleTime: number,
    ) => {
      const live = real.staleTimeUnlessHeld(held, staleTime);
      return (query: { queryHash: string }) =>
        control.inert ? staleTime : live(query);
    },
  };
});

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  ghProjectItems: vi.fn(),
  ghSetItemsFieldValues: vi.fn(),
}));

// Query-core flushes observer notifications on a timer; on the same hop, the
// hook's renders land inside the act-wrapped hops below.
beforeAll(() => notifyManager.setScheduler(setImmediate));
afterAll(() => {
  notifyManager.setScheduler((callback) => setTimeout(callback, 0));
  expect(unmockedCommands).toEqual([]);
});
// Every burst released both holds: a leftover one would defer later settles.
afterEach(() => {
  control.inert = false;
  expect({
    lenses: shiftChasedLenses.size,
    repos: shiftChasedRepos.size,
  }).toEqual({ lenses: 0, repos: 0 });
});

const PROJECT = "PVT_1";
const START = "PVTF_start";
const TARGET = "PVTF_target";

type Card = "A" | "B";
const ITEM_ID: Record<Card, string> = { A: "PVTI_A", B: "PVTI_B" };
const cardOf = (itemId: string): Card => (itemId === ITEM_ID.A ? "A" : "B");

type Dates = { start: string; target: string };
type Board = Record<Card, Dates>;

const OLD: Board = {
  A: { start: "2026-11-02", target: "2026-11-13" },
  B: { start: "2026-12-01", target: "2026-12-11" },
};
const A_NEW: Dates = { start: "2026-11-09", target: "2026-11-20" };
/** B's first press, and the press that folds in while its write is out. */
const B_PRESS_1: Dates = { start: "2026-12-08", target: "2026-12-18" };
const B_PRESS_2: Dates = { start: "2026-12-15", target: "2026-12-25" };

/** A sweep mounts one board per offset, each bounded by real macrotasks. */
const SWEEP_TIMEOUT_MS = 60_000;

/** One macrotask hop, through `setImmediate`: a timer hop costs a whole timer
 *  tick (about 15 ms on Windows), and a sweep runs one burst per offset. */
const hop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Hops until `check` holds; a burst whose step never comes fails loudly. */
async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await act(hop);
  }
  throw new Error(`never: ${what}`);
}

/** The highest extra-tick offset on B's first write that the sweeps try. At
 *  least twice the highest offset the control finds losing (asserted there). */
const SWEEP_MAX = 24;
const OFFSETS = Array.from({ length: SWEEP_MAX + 1 }, (_, k) => k);

/** A second saved view's filter: the sibling lens of the same repository, which
 *  no chase holds, so only the repo count keeps a board settle off it. */
const SIBLING_QUERY = "status:open";

/** What the mocked GitHub answers reads with. Replaced, never mutated: an
 *  answer is handed to the cache by reference. */
let server: Board;
/** Every api call in order: `read:board` (the chased lens), `read:sibling`,
 *  `write:<card>:start`, `write:<card>:end`. */
let log: string[];
/** Extra microtask ticks B's first write takes after the shared gate opens. */
let offset: number;
/** Lens holds seen without their repo held, sampled at every api call. */
let unheldRepos: string[];
let openGate: () => void;
let gate: Promise<void>;
let openSecondGate: () => void;
let secondGate: Promise<void>;

const dateValue = (
  fieldId: string,
  fieldName: string,
  date: string,
): ProjectFieldValue => ({
  kind: "date",
  fieldId,
  fieldName,
  date,
  isIssueField: false,
});

const datesValues = (dates: Dates): ProjectFieldValue[] => [
  dateValue(START, "Start", dates.start),
  dateValue(TARGET, "Target", dates.target),
];

/** A fresh page from `board` on every call (see {@link server}). */
const page = (board: Board): BoardItems => ({
  items: (["A", "B"] as const).map((card) => ({
    itemId: ITEM_ID[card],
    isArchived: false,
    content: {
      kind: "draft" as const,
      id: `DI_${card}`,
      title: `Card ${card}`,
      body: "",
      assignees: [],
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z",
    },
    fieldValues: datesValues(board[card]),
    addedAt: "2026-10-01T00:00:00Z",
  })),
  totalCount: 2,
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

/** AC2's invariant at this instant: every held lens's repo is held too. Lens
 *  hashes are query-core's JSON of the key, whose second segment is the repo. */
function sampleHolds(): void {
  for (const lens of shiftChasedLenses.keys()) {
    const repo = (JSON.parse(lens) as unknown[])[1];
    if (typeof repo !== "string" || (shiftChasedRepos.get(repo) ?? 0) < 1)
      unheldRepos.push(lens);
  }
}

const writesStarted = (card: Card) =>
  log.filter((entry) => entry === `write:${card}:start`).length;

beforeEach(() => {
  vi.mocked(ghProjectItems).mockReset();
  vi.mocked(ghSetItemsFieldValues).mockReset();
  vi.mocked(ghProjectItems).mockImplementation(
    async (_repo, _project, _cursor, query) => {
      sampleHolds();
      log.push(query === SIBLING_QUERY ? "read:sibling" : "read:board");
      return page(server);
    },
  );
  vi.mocked(ghSetItemsFieldValues).mockImplementation(
    async (_repo, _project, itemIds, updates) => {
      sampleHolds();
      const card = cardOf(itemIds[0] ?? "");
      log.push(`write:${card}:start`);
      const nth = writesStarted(card);
      if (nth === 1) {
        await gate;
        if (card === "B") for (let tick = 0; tick < offset; tick++) await null;
      } else if (card === "B" && nth === 2) await secondGate;
      server = { ...server, [card]: datesOf(updates) };
      log.push(`write:${card}:end`);
      return { outcomes: itemIds.map((itemId) => ({ itemId, error: null })) };
    },
  );
});

/** The lens key `useProjectItems(repo, PROJECT, null, true, false, false)`
 *  reads: the unfiltered, live-only, lean board. */
const lensKey = (repo: string) =>
  ["repo", repo, "project-items", PROJECT, null, false, false] as const;

function cachedBoard(client: QueryClient, repo: string): Board | null {
  const items = client.getQueryData<{ pages: BoardItems[] }>(lensKey(repo))
    ?.pages[0]?.items;
  const datesFor = (card: Card): Dates | null => {
    const item = items?.find((i) => i.itemId === ITEM_ID[card]);
    if (item === undefined) return null;
    const date = (fieldId: string) => {
      const value = item.fieldValues.find(
        (v) => v.kind !== "unknown" && v.fieldId === fieldId,
      );
      return value?.kind === "date" ? value.date : "<none>";
    };
    return { start: date(START), target: date(TARGET) };
  };
  const a = datesFor("A");
  const b = datesFor("B");
  return a === null || b === null ? null : { A: a, B: b };
}

async function macrotasks(count: number) {
  for (let i = 0; i < count; i++) await act(hop);
}

/** What one two-chase burst did, as AC6 states it in one object. Reads are
 *  counted per lens: the chased one, and its unheld sibling. */
type Observed = {
  secondPress: string;
  outcomes: string[];
  readsWhileHeld: number;
  siblingReadsWhileHeld: number;
  writesA: Dates[];
  writesB: Dates[];
  server: Board;
  readsAfterSettle: number;
  siblingReadsAfterSettle: number;
  cacheIsServer: boolean;
  unheldRepos: number;
};

let seq = 0;
const freshRepo = () => `C:/r-board-settle-${++seq}`;

/**
 * Two chases on cards A and B of one active lens, with a second observed lens
 * of the same repository beside it. B's second press folds in while its first
 * write is out, so B owes a second round. Both first writes wait on one gate,
 * opened once; B's then takes `ticks` extra microtasks, which moves B's gap
 * between rounds across A's settle. B's second write waits on a second gate
 * opened two macrotasks later, so a read issued in the gap lands first. The
 * gates open and every press is awaited in a `finally`, so a throw never leaves
 * a live burst behind.
 */
async function runBurst(ticks: number): Promise<Observed> {
  const repo = freshRepo();
  server = OLD;
  log = [];
  offset = ticks;
  unheldRepos = [];
  gate = new Promise((resolve) => {
    openGate = resolve;
  });
  secondGate = new Promise((resolve) => {
    openSecondGate = resolve;
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const { result, unmount } = renderHook(
    () => ({
      items: useProjectItems(repo, PROJECT, null, true, false, false),
      sibling: useProjectItems(
        repo,
        PROJECT,
        SIBLING_QUERY,
        true,
        false,
        false,
      ),
      shift: useShiftItemDates(),
    }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  await until(
    () => result.current.items.isSuccess && result.current.sibling.isSuccess,
    "both lenses load",
  );
  const press = (card: Card, dates: Dates): Promise<string> =>
    result.current.shift
      .mutateAsync({
        repo,
        projectId: PROJECT,
        itemId: ITEM_ID[card],
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
  const bursts: Promise<string>[] = [];
  let secondPress = "never pressed";
  let outcomes: string[] = [];
  try {
    act(() => {
      bursts.push(press("A", A_NEW), press("B", B_PRESS_1));
    });
    await until(
      () => writesStarted("A") === 1 && writesStarted("B") === 1,
      "both first writes start",
    );
    secondPress = await act(() => press("B", B_PRESS_2));
  } finally {
    openGate();
    await macrotasks(2);
    openSecondGate();
    outcomes = await act(() => Promise.all(bursts));
  }
  await macrotasks(4);
  const writes = (card: Card) =>
    vi
      .mocked(ghSetItemsFieldValues)
      .mock.calls.filter(([, , itemIds]) => cardOf(itemIds[0] ?? "") === card)
      .map(([, , , updates]) => datesOf(updates));
  const firstWrite = log.findIndex((e) => e.endsWith(":start"));
  const lastWrite = log.findLastIndex((e) => e.endsWith(":end"));
  const held = log.slice(firstWrite, lastWrite + 1);
  const after = log.slice(lastWrite + 1);
  const reads = (entries: string[], lens: "board" | "sibling") =>
    entries.filter((e) => e === `read:${lens}`).length;
  const observed: Observed = {
    secondPress,
    outcomes,
    readsWhileHeld: reads(held, "board"),
    siblingReadsWhileHeld: reads(held, "sibling"),
    writesA: writes("A"),
    writesB: writes("B"),
    server,
    readsAfterSettle: reads(after, "board"),
    siblingReadsAfterSettle: reads(after, "sibling"),
    cacheIsServer:
      JSON.stringify(cachedBoard(client, repo)) === JSON.stringify(server),
    unheldRepos: unheldRepos.length,
  };
  unmount();
  client.clear();
  vi.mocked(ghProjectItems).mockClear();
  vi.mocked(ghSetItemsFieldValues).mockClear();
  return observed;
}

/** One burst per offset, keyed by offset so one diff names every that differs. */
async function sweep(): Promise<Record<number, Observed>> {
  const byOffset: Record<number, Observed> = {};
  for (const ticks of OFFSETS) byOffset[ticks] = await runBurst(ticks);
  return byOffset;
}

const HELD: Observed = {
  secondPress: "folded",
  outcomes: ["converged", "converged"],
  readsWhileHeld: 0,
  // No lens of the repository is read while held: the count defers the settle
  // for every lens, where "static" covers only the chased one.
  siblingReadsWhileHeld: 0,
  writesA: [A_NEW],
  writesB: [B_PRESS_1, B_PRESS_2],
  server: { A: A_NEW, B: B_PRESS_2 },
  readsAfterSettle: 1,
  siblingReadsAfterSettle: 1,
  cacheIsServer: true,
  unheldRepos: 0,
};

/** The loss AC7 looks for: a read landed while held, B wrote its first press's
 *  dates back after its latest, and GitHub ends on them. */
const lost = (o: Observed) =>
  o.readsWhileHeld > 0 &&
  o.writesB.length >= 3 &&
  JSON.stringify(o.writesB[2]) === JSON.stringify(B_PRESS_1) &&
  JSON.stringify(o.server.B) === JSON.stringify(B_PRESS_1);

describe("a board write's own settle while a date-shift chase holds its repo", () => {
  it(
    "defers at every offset: no read while held, and B's writes carry only its presses",
    async () => {
      const observed = await sweep();
      expect(observed).toEqual(
        Object.fromEntries(OFFSETS.map((ticks) => [ticks, HELD])),
      );
    },
    SWEEP_TIMEOUT_MS,
  );

  it(
    "control: with the chase-hold defences inert, some offset loses B's latest press",
    async () => {
      control.inert = true;
      let observed: Record<number, Observed>;
      try {
        observed = await sweep();
      } finally {
        control.inert = false;
      }
      const losing = OFFSETS.filter((ticks) =>
        lost(observed[ticks] as Observed),
      );
      expect(losing.length).toBeGreaterThan(0);
      expect(SWEEP_MAX).toBeGreaterThanOrEqual(2 * Math.max(...losing));
      // The hold sampler sees the inert count at every offset, so its zero
      // in the sweep above is a reading, not a sampler that never ran.
      expect(
        OFFSETS.filter(
          (ticks) => (observed[ticks] as Observed).unheldRepos > 0,
        ),
      ).toEqual(OFFSETS);
    },
    SWEEP_TIMEOUT_MS,
  );
});
