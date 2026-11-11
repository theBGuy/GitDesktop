import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  ghProjectItems,
  ghSetItemsFieldValues,
  gitRemoteSetUrl,
} from "@/lib/git/api";
import {
  invalidateRepoAfterWrite,
  useProjectItems,
  useSetRemoteUrl,
  useShiftItemDates,
} from "@/lib/git/queries";
import { shiftChasedLenses } from "@/lib/git/queries/board-writes";
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
  gitRemoteSetUrl: vi.fn(),
}));

afterAll(() => expect(unmockedCommands).toEqual([]));
// Every burst released its lens: a leftover hold would skip later tests' settles.
afterEach(() => expect(shiftChasedLenses.size).toBe(0));

const PROJECT = "PVT_1";
const ITEM = "PVTI_1";
const START = "PVTF_start";
const TARGET = "PVTF_target";

type Dates = { start: string; target: string };

const OLD: Dates = { start: "2026-11-02", target: "2026-11-13" };
const NEW: Dates = { start: "2026-11-09", target: "2026-11-20" };

/** What the mocked GitHub answers reads with. Replaced, never mutated: the
 *  first answer is handed to the cache by reference, so an in-place write would
 *  turn the cached old dates into the new ones behind the chase's back. */
let server: Dates;
/** Every api call in order: `read`, `write:start`, `write:end`. */
let log: string[];
let openGate: () => void;
let gate: Promise<void>;

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

/** A fresh page from `dates` on every call (see {@link server}). */
const page = (dates: Dates): BoardItems => ({
  items: [
    {
      itemId: ITEM,
      isArchived: false,
      content: {
        kind: "draft",
        id: "DI_1",
        title: "Card",
        body: "",
        assignees: [],
        createdAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-10-01T00:00:00Z",
      },
      fieldValues: [
        dateValue(START, "Start", dates.start),
        dateValue(TARGET, "Target", dates.target),
      ],
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
  server = OLD;
  log = [];
  gate = new Promise((resolve) => {
    openGate = resolve;
  });
  vi.mocked(ghProjectItems).mockReset();
  vi.mocked(ghSetItemsFieldValues).mockReset();
  vi.mocked(gitRemoteSetUrl).mockReset();
  vi.mocked(ghProjectItems).mockImplementation(async () => {
    log.push("read");
    return page(server);
  });
  vi.mocked(ghSetItemsFieldValues).mockImplementation(
    async (_repo, _project, itemIds, updates) => {
      const first = vi.mocked(ghSetItemsFieldValues).mock.calls.length === 1;
      log.push("write:start");
      if (first) await gate;
      server = datesOf(updates);
      log.push("write:end");
      return { outcomes: itemIds.map((itemId) => ({ itemId, error: null })) };
    },
  );
  vi.mocked(gitRemoteSetUrl).mockResolvedValue(undefined as never);
});

/** The lens key `useProjectItems(repo, PROJECT, null, true, false, false)`
 *  reads: the unfiltered, live-only, lean board. */
const lensKey = (repo: string) =>
  ["repo", repo, "project-items", PROJECT, null, false, false] as const;

function cachedDates(client: QueryClient, repo: string): Dates | null {
  const data = client.getQueryData<{ pages: BoardItems[] }>(lensKey(repo));
  const item = data?.pages[0]?.items[0];
  if (item === undefined) return null;
  const date = (fieldId: string) => {
    const value = item.fieldValues.find(
      (v) => v.kind !== "unknown" && v.fieldId === fieldId,
    );
    return value?.kind === "date" ? value.date : "<none>";
  };
  return { start: date(START), target: date(TARGET) };
}

const reads = () => log.filter((entry) => entry === "read").length;

function mount(repo: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const { result } = renderHook(
    () => ({
      items: useProjectItems(repo, PROJECT, null, true, false, false),
      shift: useShiftItemDates(),
      remote: useSetRemoteUrl(repo),
    }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  return { client, hook: result };
}

type Mounted = ReturnType<typeof mount>;

/** Two whole-repo write settles: `useRepoMutation`'s default arm, and the
 *  helper the hand-rolled settles share. Each resolves to whether it ran. */
const DRIVERS: {
  name: string;
  run: (mounted: Mounted, repo: string) => Promise<boolean>;
}[] = [
  {
    name: "a default-arm useRepoMutation (useSetRemoteUrl)",
    run: async ({ hook }, repo) => {
      await act(() =>
        hook.current.remote.mutateAsync({ name: "origin", url: "x" }),
      );
      return vi
        .mocked(gitRemoteSetUrl)
        .mock.calls.some(([r, name]) => r === repo && name === "origin");
    },
  },
  {
    name: "invalidateRepoAfterWrite",
    run: async ({ client }, repo) => {
      await act(() => invalidateRepoAfterWrite(client, repo));
      return true;
    },
  },
];

async function macrotasks(count: number) {
  for (let i = 0; i < count; i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
}

/** What a shift burst did, as the fix's contract states it in one object. */
type Observed = {
  readsWhileHeld: number;
  writes: Dates[];
  outcome: string;
  server: Dates;
};

/**
 * One shift of both date fields to {@link NEW} on an active lens, with the
 * driver's whole-repo settle landing while the first write is in flight and
 * GitHub still answers {@link OLD}. The gate opens and the shift is awaited in
 * a `finally`, so a throw never leaves a live burst behind.
 */
async function runScenario(repo: string, driver: (typeof DRIVERS)[number]) {
  const mounted = mount(repo);
  const { client, hook } = mounted;
  await waitFor(() => expect(hook.current.items.isSuccess).toBe(true));
  let shift: Promise<{ kind: string }> | undefined;
  act(() => {
    shift = hook.current.shift.mutateAsync({
      repo,
      projectId: PROJECT,
      itemId: ITEM,
      issueId: null,
      issueFieldIdByFieldId: {},
      values: [
        dateValue(START, "Start", NEW.start),
        dateValue(TARGET, "Target", NEW.target),
      ],
      query: null,
      archived: false,
      rich: false,
    });
  });
  let cacheBeforeDriver: Dates | null = null;
  let driverRan = false;
  let outcome = "never started";
  try {
    await waitFor(() =>
      expect(vi.mocked(ghSetItemsFieldValues)).toHaveBeenCalledTimes(1),
    );
    cacheBeforeDriver = cachedDates(client, repo);
    driverRan = await driver.run(mounted, repo);
    await macrotasks(2);
  } finally {
    openGate();
    if (shift !== undefined)
      outcome = await act(() =>
        (shift as Promise<{ kind: string }>).then(
          (o) => o.kind,
          (e) => `threw: ${String(e)}`,
        ),
      );
  }
  await macrotasks(4);
  const writes = vi
    .mocked(ghSetItemsFieldValues)
    .mock.calls.map(([, , , updates]) => datesOf(updates));
  const from = log.indexOf("write:start");
  const to = log.lastIndexOf("write:end");
  const observed: Observed = {
    readsWhileHeld: log.slice(from, to + 1).filter((e) => e === "read").length,
    writes,
    outcome,
    server,
  };
  return {
    mounted,
    observed,
    harness: {
      firstWrite: writes[0],
      cacheBeforeDriver,
      driverRan,
      shiftSettled: !outcome.startsWith("threw") && outcome !== "never started",
    },
  };
}

/** The fix's contract, as ONE assertion so a single diff shows every field. */
function expectHeldThroughSettle(observed: Observed) {
  expect(observed).toEqual({
    readsWhileHeld: 0,
    writes: [NEW],
    outcome: "converged",
    server: NEW,
  });
}

let seq = 0;
const freshRepo = () => `C:/r4-shift-${++seq}`;

describe.each(DRIVERS)("a whole-repo write settle: $name", (driver) => {
  it("harness: the shift's first write carries the new dates and the settle runs mid-flight", async () => {
    const { harness } = await runScenario(freshRepo(), driver);
    expect(harness).toEqual({
      firstWrite: NEW,
      cacheBeforeDriver: NEW,
      driverRan: true,
      shiftSettled: true,
    });
  });

  it("premise: a lens a shift chase holds takes no read, and the chase writes only the new dates", async () => {
    const { observed } = await runScenario(freshRepo(), driver);
    expectHeldThroughSettle(observed);
  });

  it("after the burst the hold is gone, the chase's settle re-read the lens, and a later settle refetches it", async () => {
    const repo = freshRepo();
    const { mounted, observed } = await runScenario(repo, driver);
    expectHeldThroughSettle(observed);
    const afterBurst = log.slice(log.lastIndexOf("write:end") + 1);
    expect({
      held: shiftChasedLenses.size,
      settleReads: afterBurst.filter((e) => e === "read").length,
      cached: cachedDates(mounted.client, repo),
    }).toEqual({ held: 0, settleReads: 1, cached: server });
    const before = reads();
    server = OLD;
    expect(await driver.run(mounted, repo)).toBe(true);
    await macrotasks(4);
    expect({
      reads: reads() - before,
      cached: cachedDates(mounted.client, repo),
    }).toEqual({ reads: 1, cached: OLD });
  });

  it("an idle board's lens refetches once and shows the server's answer", async () => {
    const repo = freshRepo();
    const mounted = mount(repo);
    await waitFor(() =>
      expect(mounted.hook.current.items.isSuccess).toBe(true),
    );
    server = NEW;
    expect(await driver.run(mounted, repo)).toBe(true);
    await macrotasks(4);
    expect({
      reads: reads(),
      cached: cachedDates(mounted.client, repo),
    }).toEqual({ reads: 2, cached: NEW });
  });
});
