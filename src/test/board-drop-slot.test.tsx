import {
  type InfiniteData,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
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
  ghSetItemFieldValues,
  ghSetItemPosition,
} from "@/lib/git/api";
import {
  useMoveBoardCard,
  useProjectItems,
  useReorderBoardCard,
} from "@/lib/git/queries";
import type {
  BoardItems,
  ProjectFieldDef,
  ProjectFieldOptionDef,
} from "@/lib/git/types";
import { toastComposedError, toastError } from "@/lib/toast";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  ghProjectItems: vi.fn(),
  ghSetItemFieldValues: vi.fn(),
  ghSetItemPosition: vi.fn(),
}));

vi.mock("@/lib/toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/toast")>()),
  toastError: vi.fn(),
  toastComposedError: vi.fn(),
}));

afterAll(() => expect(unmockedCommands).toEqual([]));

/**
 * Isolation: ONE QueryClient for the whole file and a fresh repo path per case.
 * The board machinery keeps module state (pending writes, the reorder count, the
 * owed re-read timers, the reposition verdicts) keyed by repo, and its read
 * ledger subscribes to the first client it sees, so a second client would
 * strand that ledger on a cache no case reads. Every gate a case opens is
 * settled in a `finally`, and the fake timers are cleared after each case.
 */
const client = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

/** Mirrors projects.ts `REPLICA_LAG_MS`: the recovery re-read's quiet window. */
const REPLICA_LAG_MS = 8_000;
const PROJECT = "PVT_1";
const PAGE_SIZE = 3;

const TODO: ProjectFieldOptionDef = {
  id: "opt-todo",
  name: "Todo",
  color: "GRAY",
  description: "",
};
const DONE: ProjectFieldOptionDef = {
  id: "opt-done",
  name: "Done",
  color: "GREEN",
  description: "",
};
const STATUS: Extract<ProjectFieldDef, { kind: "singleSelect" }> = {
  kind: "singleSelect",
  id: "PVTSSF_status",
  name: "Status",
  options: [TODO, DONE],
  isIssueField: false,
};

type Status = "todo" | "done";
type Row = { id: string; status: Status; archived: boolean };

/** The project's order as the server holds it. The pressed lens keeps archived
 *  cards and pages by three, so the moved card `M` sits on page 2 and its slot
 *  (after `T1`) on page 1; `Z` is an archived Todo card. */
const START: readonly Row[] = [
  { id: "T1", status: "todo", archived: false },
  { id: "T2", status: "todo", archived: false },
  { id: "Z", status: "todo", archived: true },
  { id: "D1", status: "done", archived: false },
  { id: "M", status: "done", archived: false },
  { id: "T3", status: "todo", archived: false },
];
const ORDER = START.map((row) => row.id);

/** Replaced, never mutated: a read hands its page to the cache by reference. */
let server: readonly Row[];
let reads: number;
/** While set, every board read waits on it. */
let readGate: Promise<void> | null;

const statusValue = (status: Status) => {
  const option = status === "todo" ? TODO : DONE;
  return {
    kind: "singleSelect" as const,
    fieldId: STATUS.id,
    fieldName: STATUS.name,
    optionId: option.id,
    name: option.name,
    color: option.color,
    isIssueField: false,
  };
};

/** A fresh page on every call. */
function page(rows: readonly Row[], start: number): BoardItems {
  const end = start + PAGE_SIZE;
  return {
    items: rows.slice(start, end).map((row) => ({
      itemId: row.id,
      isArchived: row.archived,
      content: {
        kind: "draft",
        id: `DI_${row.id}`,
        title: `Card ${row.id}`,
        body: "",
        assignees: [],
        createdAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-10-01T00:00:00Z",
      },
      fieldValues: [statusValue(row.status)],
      addedAt: "2026-10-01T00:00:00Z",
    })),
    totalCount: rows.length,
    truncated: end < rows.length,
    endCursor: end < rows.length ? String(end) : null,
  };
}

/** A rejection the case reads elsewhere, or settles on purpose in a `finally`. */
const ignore = () => undefined;

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Handled here so a gate rejected before anyone awaits it isn't reported.
  promise.catch(ignore);
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "Date",
      "performance",
    ],
  });
  server = START;
  reads = 0;
  readGate = null;
  vi.mocked(toastError).mockReset();
  vi.mocked(toastComposedError).mockReset();
  vi.mocked(ghProjectItems).mockReset();
  vi.mocked(ghSetItemFieldValues).mockReset();
  vi.mocked(ghSetItemPosition).mockReset();
  vi.mocked(ghProjectItems).mockImplementation(
    async (_repo, _project, cursor, query, includeArchived) => {
      reads += 1;
      if (readGate !== null) await readGate;
      const rows = server.filter(
        (row) =>
          (includeArchived || !row.archived) &&
          (query === null || query === `status:${row.status}`),
      );
      return page(rows, cursor === null ? 0 : Number(cursor));
    },
  );
  vi.mocked(ghSetItemFieldValues).mockImplementation(
    async (_repo, _project, itemId, updates) => {
      const update = updates[0];
      if (update?.kind !== "singleSelect") return;
      const status: Status = update.optionId === TODO.id ? "todo" : "done";
      server = server.map((row) =>
        row.id === itemId ? { ...row, status } : row,
      );
    },
  );
  vi.mocked(ghSetItemPosition).mockImplementation(
    async (_repo, _project, itemId, afterId) => {
      const moved = server.find((row) => row.id === itemId);
      const rest = server.filter((row) => row.id !== itemId);
      if (moved !== undefined) {
        const at =
          afterId === null ? 0 : rest.findIndex((r) => r.id === afterId) + 1;
        server = [...rest.slice(0, at), moved, ...rest.slice(at)];
      }
      return { itemIds: server.map((row) => row.id), truncated: false };
    },
  );
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

/** Microtasks and zero-delay timers, enough rounds for a read to land and its
 *  observers to hear of it. */
async function flush() {
  for (let i = 0; i < 6; i++)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await flush();
}

/** Steps the clock until `write` settles, so a changed retry wait fails on this
 *  assertion rather than at the test timeout. */
async function settleThroughRetries(write: Promise<unknown>) {
  let settled = false;
  write.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let spent = 0; !settled && spent < 60_000; spent += 50)
    await advance(50);
  expect(settled).toBe(true);
  await write;
}

type Lens = { query: string | null; archived: boolean };
/** The lens the moves are pressed under: unfiltered, archived cards kept. */
const PRESSED: Lens = { query: null, archived: true };
/** A second cached lens of the same board, which never draws `M`. */
const TODO_VIEW: Lens = { query: "status:todo", archived: false };

const lensKey = (repo: string, lens: Lens) =>
  [
    "repo",
    repo,
    "project-items",
    PROJECT,
    lens.query,
    lens.archived,
    false,
  ] as const;

const lensData = (repo: string, lens: Lens = PRESSED) =>
  client.getQueryData<InfiniteData<BoardItems, string | null>>(
    lensKey(repo, lens),
  );

const order = (repo: string, lens: Lens = PRESSED) =>
  lensData(repo, lens)?.pages.flatMap((p) => p.items.map((i) => i.itemId)) ??
  [];

const pageOrders = (repo: string) =>
  lensData(repo)?.pages.map((p) => p.items.map((i) => i.itemId));

function statusOf(repo: string, itemId: string): Status | "<none>" {
  const value = lensData(repo)
    ?.pages.flatMap((p) => p.items)
    .find((item) => item.itemId === itemId)
    ?.fieldValues.find((v) => v.kind === "singleSelect");
  if (value?.kind !== "singleSelect") return "<none>";
  return value.optionId === TODO.id ? "todo" : "done";
}

let seq = 0;
const freshRepo = () => `C:/drop-slot-${++seq}`;

async function mount(repo: string) {
  const view = renderHook(
    () => ({
      board: useProjectItems(repo, PROJECT, null, true, true, false),
      todo: useProjectItems(repo, PROJECT, "status:todo", true, false, false),
      move: useMoveBoardCard(),
      reorder: useReorderBoardCard(),
    }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  await flush();
  await act(async () => {
    void view.result.current.board.fetchNextPage();
  });
  await flush();
  // Harness: both pages of the pressed lens and the second lens are loaded.
  expect(pageOrders(repo)).toEqual([ORDER.slice(0, 3), ORDER.slice(3)]);
  expect(order(repo, TODO_VIEW)).toEqual(["T1", "T2", "T3"]);
  return view;
}

type View = Awaited<ReturnType<typeof mount>>;

/** `itemId` moved to the Todo column, under `lens`. */
const toTodo = (
  repo: string,
  itemId: string,
  slot: { afterId: string | null } | undefined,
  lens: Lens = PRESSED,
) => ({
  repo,
  projectId: PROJECT,
  itemId,
  issueId: null,
  field: STATUS,
  bucket: { kind: "option" as const, option: TODO },
  query: lens.query,
  archived: lens.archived,
  rich: false,
  slot,
});

const reorderVars = (repo: string, itemId: string, afterId: string | null) => ({
  repo,
  projectId: PROJECT,
  itemId,
  afterId,
  query: PRESSED.query,
  archived: PRESSED.archived,
  rich: false,
});

/** Starts a write without awaiting it; a rejection is read by the caller. */
function start<T>(run: () => Promise<T>): Promise<T> {
  let promise: Promise<T> | undefined;
  act(() => {
    promise = run();
  });
  const started = promise as Promise<T>;
  started.catch(ignore);
  return started;
}

/**
 * Whether a converged reposition re-asserts its order over the pressed lens
 * right now: the board's reorder count is zero exactly when it does. The probe
 * repositions the first card onto the top (no splice) and answers with the
 * lens's order with its last two cards swapped.
 */
async function reassertsNow(view: View, repo: string): Promise<boolean> {
  await flush();
  const ids = order(repo);
  const [x, y] = ids.slice(-2);
  vi.mocked(ghSetItemPosition).mockImplementationOnce(async () => ({
    itemIds: [...ids.slice(0, -2), y, x],
    truncated: false,
  }));
  await act(() =>
    view.result.current.reorder.mutateAsync(reorderVars(repo, ids[0], null)),
  );
  await flush();
  const after = order(repo);
  return after.at(-2) === y && after.at(-1) === x;
}

describe("a board move that names its dropped slot", () => {
  it("slotted move: the cache draws the card in the target column at the dropped slot before the status write answers", async () => {
    const repo = freshRepo();
    const view = await mount(repo);
    const todoBefore = lensData(repo, TODO_VIEW);
    const gate = deferred();
    vi.mocked(ghSetItemFieldValues).mockImplementationOnce(() => gate.promise);
    const move = start(() =>
      view.result.current.move.mutateAsync(
        toTodo(repo, "M", { afterId: "T1" }),
      ),
    );
    try {
      await flush();
      expect(vi.mocked(ghSetItemFieldValues)).toHaveBeenCalledTimes(1);
      expect({
        pages: pageOrders(repo),
        status: statusOf(repo, "M"),
        otherLensUntouched: lensData(repo, TODO_VIEW) === todoBefore,
      }).toEqual({
        pages: [
          ["T1", "M", "T2"],
          ["Z", "D1", "T3"],
        ],
        status: "todo",
        otherLensUntouched: true,
      });
    } finally {
      gate.resolve();
      await move.catch(ignore);
      await flush();
    }
  });

  it("slotted move: a failed status write puts the card back in its source column and slot", async () => {
    const repo = freshRepo();
    const view = await mount(repo);
    const todoBefore = lensData(repo, TODO_VIEW);
    const refused = new Error("status refused");
    const gate = deferred();
    readGate = gate.promise;
    vi.mocked(ghSetItemFieldValues).mockImplementationOnce(async () => {
      throw refused;
    });
    try {
      const move = start(() =>
        view.result.current.move.mutateAsync(
          toTodo(repo, "M", { afterId: "T1" }),
        ),
      );
      await expect(move).rejects.toBe(refused);
      await flush();
      expect({
        order: order(repo),
        status: statusOf(repo, "M"),
        otherLensUntouched: lensData(repo, TODO_VIEW) === todoBefore,
        toasted: vi.mocked(toastError).mock.calls,
      }).toEqual({
        order: ORDER,
        status: "done",
        otherLensUntouched: true,
        toasted: [[refused]],
      });
    } finally {
      gate.resolve();
      readGate = null;
      await flush();
    }
  });

  it("slotted move: no board read starts when the status write settles", async () => {
    const repo = freshRepo();
    const view = await mount(repo);
    const before = reads;
    const move = start(() =>
      view.result.current.move.mutateAsync(
        toTodo(repo, "M", { afterId: "T1" }),
      ),
    );
    // What the panel's drop awaits before it writes the slot.
    await expect(move).resolves.toBeUndefined();
    // Read before any reorder: a converged one marks the filtered lenses itself.
    expect({
      pressed: client.getQueryState(lensKey(repo, PRESSED))?.isInvalidated,
      sibling: client.getQueryState(lensKey(repo, TODO_VIEW))?.isInvalidated,
    }).toEqual({ pressed: false, sibling: false });
    await advance(REPLICA_LAG_MS - 1);
    expect({
      reads: reads - before,
      order: order(repo),
      status: statusOf(repo, "M"),
    }).toEqual({
      reads: 0,
      order: ["T1", "M", "T2", "Z", "D1", "T3"],
      status: "todo",
    });
  });

  it("slotted move: the recovery re-read runs once the board has been quiet", async () => {
    const repo = freshRepo();
    const view = await mount(repo);
    const move = start(() =>
      view.result.current.move.mutateAsync(
        toTodo(repo, "M", { afterId: "T1" }),
      ),
    );
    await move;
    await advance(REPLICA_LAG_MS - 1);
    const before = reads;
    await advance(1);
    // Nothing wrote the slot, so the re-read draws GitHub's order: the new
    // column at the card's project-wide place.
    expect({
      reread: reads > before,
      order: order(repo),
      status: statusOf(repo, "M"),
    }).toEqual({
      reread: true,
      order: ["T1", "T2", "Z", "D1", "M", "T3"],
      status: "todo",
    });
  });

  it("slotted move: a lens whose first load a sibling write cancelled is read at the settle", async () => {
    const repo = freshRepo();
    const view = await mount(repo);
    const DONE_VIEW: Lens = { query: "status:done", archived: false };
    const gate = deferred();
    vi.mocked(ghSetItemFieldValues).mockImplementationOnce(() => gate.promise);
    const move = start(() =>
      view.result.current.move.mutateAsync(
        toTodo(repo, "M", { afterId: "T1" }),
      ),
    );
    const firstLoad = deferred();
    try {
      await flush();
      readGate = firstLoad.promise;
      renderHook(
        () =>
          useProjectItems(repo, PROJECT, DONE_VIEW.query, true, false, false),
        {
          wrapper: ({ children }: { children: ReactNode }) => (
            <QueryClientProvider client={client}>
              {children}
            </QueryClientProvider>
          ),
        },
      );
      await flush();
      // A sibling write settling while the slotted move is out cancels the
      // repo's reads without refetching, leaving the new lens with no data.
      await act(() =>
        view.result.current.move.mutateAsync(toTodo(repo, "D1", undefined)),
      );
      await flush();
      readGate = null;
      expect(client.getQueryState(lensKey(repo, DONE_VIEW))).toMatchObject({
        status: "pending",
        fetchStatus: "idle",
      });
      gate.resolve();
      await move;
      await flush();
      expect(client.getQueryState(lensKey(repo, DONE_VIEW))?.status).toBe(
        "success",
      );
    } finally {
      firstLoad.resolve();
      readGate = null;
      gate.resolve();
      await move.catch(ignore);
      await flush();
    }
  });

  it("slotted move: a sibling card's converged reposition leaves the dropped card at its slot", async () => {
    const repo = freshRepo();
    const view = await mount(repo);
    const gate = deferred();
    vi.mocked(ghSetItemFieldValues).mockImplementationOnce(() => gate.promise);
    const move = start(() =>
      view.result.current.move.mutateAsync(
        toTodo(repo, "M", { afterId: "T1" }),
      ),
    );
    try {
      await flush();
      // GitHub's answer still holds M at its old place: no slot was written.
      await act(() =>
        view.result.current.reorder.mutateAsync(reorderVars(repo, "T3", "T2")),
      );
      await flush();
      expect(server.map((row) => row.id)).toEqual([
        "T1",
        "T2",
        "T3",
        "Z",
        "D1",
        "M",
      ]);
      expect(order(repo)).toEqual(["T1", "M", "T2", "T3", "Z", "D1"]);
    } finally {
      gate.resolve();
      await move.catch(ignore);
      await flush();
    }
  });

  it("unslotted move: settles through an immediate board read", async () => {
    const repo = freshRepo();
    const view = await mount(repo);
    const before = reads;
    await act(() =>
      view.result.current.move.mutateAsync(toTodo(repo, "M", undefined)),
    );
    await flush();
    expect({
      reread: reads > before,
      order: order(repo),
      status: statusOf(repo, "M"),
    }).toEqual({
      reread: true,
      order: ORDER,
      status: "todo",
    });
  });

  it("slotted move: a lens that no longer draws the card settles through an immediate board read", async () => {
    const repo = freshRepo();
    const view = await mount(repo);
    const todoBefore = lensData(repo, TODO_VIEW);
    const gate = deferred();
    vi.mocked(ghSetItemFieldValues).mockImplementationOnce(() => gate.promise);
    const move = start(() =>
      view.result.current.move.mutateAsync(
        toTodo(repo, "M", { afterId: "T1" }, TODO_VIEW),
      ),
    );
    let before = reads;
    try {
      await flush();
      expect(lensData(repo, TODO_VIEW)).toBe(todoBefore);
      before = reads;
    } finally {
      gate.resolve();
      await move.catch(ignore);
    }
    await flush();
    expect(reads > before).toBe(true);
  });

  describe("the board's reorder count", () => {
    it("is released after a slotted move succeeds", async () => {
      const repo = freshRepo();
      const view = await mount(repo);
      await act(() =>
        view.result.current.move.mutateAsync(
          toTodo(repo, "M", { afterId: "T1" }),
        ),
      );
      expect(await reassertsNow(view, repo)).toBe(true);
    });

    it("is released after a slotted move's status write fails", async () => {
      const repo = freshRepo();
      const view = await mount(repo);
      vi.mocked(ghSetItemFieldValues).mockImplementationOnce(async () => {
        throw new Error("status refused");
      });
      const move = start(() =>
        view.result.current.move.mutateAsync(
          toTodo(repo, "M", { afterId: "T1" }),
        ),
      );
      await expect(move).rejects.toThrow("status refused");
      expect(await reassertsNow(view, repo)).toBe(true);
    });

    it("is released once when the settle runs twice, leaving another write's count held", async () => {
      const repo = freshRepo();
      const view = await mount(repo);
      // Another card's reposition holds its own count on the board throughout.
      const held = deferred();
      const position = vi.mocked(ghSetItemPosition).getMockImplementation();
      vi.mocked(ghSetItemPosition).mockImplementationOnce(async (...args) => {
        await held.promise;
        return (position as NonNullable<typeof position>)(...args);
      });
      const sibling = start(() =>
        view.result.current.reorder.mutateAsync(reorderVars(repo, "T2", "T3")),
      );
      // A throw past the success arm makes query-core run the settle again
      // through its error arm.
      let armed = true;
      const unsubscribe = client.getMutationCache().subscribe((event) => {
        if (!armed || event.type !== "updated") return;
        if (event.action.type !== "success") return;
        if (event.mutation.options.mutationKey?.[1] !== "move") return;
        armed = false;
        throw new Error("settle probe");
      });
      try {
        await flush();
        const move = start(() =>
          view.result.current.move.mutateAsync(
            toTodo(repo, "M", { afterId: "T1" }),
          ),
        );
        await expect(move).rejects.toThrow("settle probe");
        expect(armed).toBe(false);
        expect(await reassertsNow(view, repo)).toBe(false);
      } finally {
        unsubscribe();
        held.resolve();
        await sibling.catch(ignore);
        await flush();
      }
      expect(await reassertsNow(view, repo)).toBe(true);
    });
  });

  it("slotted move: the card's waiting reposition failure reports once and moves no card", async () => {
    const repo = freshRepo();
    const view = await mount(repo);
    vi.mocked(ghSetItemPosition).mockImplementation(async () => {
      throw new Error("position refused");
    });
    const reorder = start(() =>
      view.result.current.reorder.mutateAsync(reorderVars(repo, "M", "T1")),
    );
    await flush();
    await settleThroughRetries(reorder);
    // The failure waits on a read, holding M where the press put it.
    const held = ["T1", "M", "T2", "Z", "D1", "T3"];
    expect({
      order: order(repo),
      reported: vi.mocked(toastComposedError).mock.calls.length,
    }).toEqual({ order: held, reported: 0 });
    const gate = deferred();
    readGate = gate.promise;
    const refused = new Error("status refused");
    vi.mocked(ghSetItemFieldValues).mockImplementationOnce(async () => {
      throw refused;
    });
    try {
      const move = start(() =>
        view.result.current.move.mutateAsync(
          toTodo(repo, "M", { afterId: "T2" }),
        ),
      );
      await expect(move).rejects.toBe(refused);
      await flush();
      expect({
        order: order(repo),
        status: statusOf(repo, "M"),
        titles: vi
          .mocked(toastComposedError)
          .mock.calls.map(([opts]) => opts.title),
        statusToasts: vi.mocked(toastError).mock.calls,
      }).toEqual({
        order: held,
        status: "done",
        titles: ["Couldn't move Card M — position refused"],
        statusToasts: [[refused]],
      });
      // Past every bound the verdict could still have waited on.
      await advance(40_000);
      expect(vi.mocked(toastComposedError)).toHaveBeenCalledTimes(1);
      expect(order(repo)).toEqual(held);
    } finally {
      gate.resolve();
      readGate = null;
      await flush();
    }
  });

  it("slotted move: a failed slot write leaves the card in the new column and reports the reposition failure", async () => {
    const repo = freshRepo();
    const view = await mount(repo);
    await act(() =>
      view.result.current.move.mutateAsync(
        toTodo(repo, "M", { afterId: "T1" }),
      ),
    );
    vi.mocked(ghSetItemPosition).mockImplementation(async () => {
      throw new Error("position refused");
    });
    // The drop's slot write: the cache already draws M after T1.
    const reorder = start(() =>
      view.result.current.reorder.mutateAsync(reorderVars(repo, "M", "T1")),
    );
    await flush();
    await settleThroughRetries(reorder);
    await advance(REPLICA_LAG_MS);
    await advance(30_000);
    expect({
      titles: vi
        .mocked(toastComposedError)
        .mock.calls.map(([opts]) => opts.title),
      status: statusOf(repo, "M"),
    }).toEqual({
      titles: ["Couldn't move Card M — position refused"],
      status: "todo",
    });
  });
});
