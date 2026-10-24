/**
 * The pure pieces of the board-write bookkeeping: the keys a board write and a
 * board read are filed under, how a write's variables name its repo, the
 * predicates the settle, window-focus and mount paths decide by, and the
 * window-focus pass over a client handed in.
 *
 * Import-free at runtime on purpose (types only, erased): internal.ts, core.ts and
 * projects.ts all import this file, so it can sit under each of them without a
 * cycle, and `scripts/board-writes.test.mjs` loads it straight from `src/` under
 * Node's type stripping. A runtime import added here fails that test.
 */
import type {
  InvalidateQueryFilters,
  QueryClient,
} from "@tanstack/react-query";
import type { PendingMutationEntry } from "./pr-writes";
import type {
  BoardWriteKind,
  ItemWriteTarget,
  PendingBoardWrite,
  PendingItemWrite,
  PendingProjectWrite,
  PendingProjectWriteKind,
} from "./projects";

/** EVERY cached board read in one repo — every board, every lens of each. The
 *  scope a board write settles against: a write changes what an item IS, which no
 *  board's filter makes untrue. */
export const projectItemsRepoKey = (repo: string) =>
  ["repo", repo, "project-items"] as const;

/** Filter prefix for EVERY board write (projects.ts `boardWriteKey`) — narrowed
 *  to one repo by {@link boardWriteVars}. */
export const BOARD_WRITES_KEY = ["board-write"] as const;

/** Every board write's variables carry the repo it addresses; the rest are per-kind
 *  and read only for labels. Untrusted at this boundary in the sense that the
 *  filter sees `Mutation<any>`, so each field is `typeof`-guarded rather than
 *  asserted. The two BULK list spellings are read here rather than at the call
 *  site for the same reason: one place decides what a write's variables mean. */
export function boardWriteVars(mutation: { state: { variables?: unknown } }): {
  repo: string | null;
  itemId: string | null;
  number: number | null;
  count: number | null;
} {
  const vars = mutation.state.variables;
  if (typeof vars !== "object" || vars === null)
    return { repo: null, itemId: null, number: null, count: null };
  const { repo, itemId, number, items, itemIds } = vars as Record<
    string,
    unknown
  >;
  const list = Array.isArray(items)
    ? items
    : Array.isArray(itemIds)
      ? itemIds
      : null;
  return {
    repo: typeof repo === "string" ? repo : null,
    itemId: typeof itemId === "string" ? itemId : null,
    number: typeof number === "number" ? number : null,
    count: list === null ? null : list.length,
  };
}

/** The board writes among `entries` (keyed `["board-write", kind]`) against `repo`,
 *  one per invocation. The repo match reads each write's VARIABLES rather than a key
 *  segment: variables are fixed when the write fires, where a key is re-derived from
 *  whatever the hook's render scope holds later. An unknown key shape degrades to a
 *  null kind rather than a guessed one, which drops the write from the labelled
 *  lines but still counts it for the holds. An entry with no `mutationId` (never one
 *  read from the cache) has nothing to name it by and is skipped. */
export function pendingBoardWritesFor(
  entries: readonly PendingMutationEntry[],
  repo: string,
): PendingBoardWrite[] {
  return entries.flatMap((e): PendingBoardWrite[] => {
    const vars = boardWriteVars({ state: { variables: e.vars } });
    if (vars.repo !== repo || e.mutationId === undefined) return [];
    const kind = e.key?.[1];
    return [
      {
        mutationId: e.mutationId,
        kind: typeof kind === "string" ? (kind as BoardWriteKind) : null,
        itemId: vars.itemId,
        number: vars.number,
        count: vars.count,
        isPaused: e.paused ?? false,
      },
    ];
  });
}

/** The write a project or view write's key kind and patch say it is. One update
 *  hook serves several verbs (close and edit; rename, layout and fields), so its
 *  PATCH names which; a patch this build can't read stays the generic edit. */
function projectWriteKind(
  family: "project" | "view",
  keyKind: unknown,
  vars: Record<string, unknown>,
): PendingProjectWriteKind | null {
  const patch =
    typeof vars.patch === "object" && vars.patch !== null
      ? (vars.patch as Record<string, unknown>)
      : {};
  if (family === "project") {
    switch (keyKind) {
      case "create":
        return "project-create";
      case "delete":
        return "project-delete";
      case "update":
        if (patch.closed === true) return "project-close";
        if (patch.closed === false) return "project-reopen";
        return "project-edit";
      default:
        return null;
    }
  }
  switch (keyKind) {
    case "create":
      return "view-create";
    case "duplicate":
      return "view-duplicate";
    case "delete":
      return "view-delete";
    case "update":
      if (patch.layout !== undefined) return "view-layout";
      if (patch.name !== undefined) return "view-rename";
      if (patch.visibleFieldIds !== undefined) return "view-fields";
      return "view-edit";
    default:
      return null;
  }
}

/** The project writes (keyed `["project-write", kind]`) and view writes (keyed
 *  `["project-view-write", kind]`) against `repo` and, when given, `projectId` (a
 *  create, which names no project, matches on the repo alone) — one per invocation, matched on VARIABLES for the reason
 *  {@link pendingBoardWritesFor} gives. An unknown key shape keeps the write with a
 *  null kind, as a board write's does. */
export function pendingProjectWritesFor(
  projectEntries: readonly PendingMutationEntry[],
  viewEntries: readonly PendingMutationEntry[],
  repo: string,
  projectId: string | null,
): PendingProjectWrite[] {
  const read =
    (family: "project" | "view") =>
    (e: PendingMutationEntry): PendingProjectWrite[] => {
      const vars = e.vars;
      if (
        typeof vars !== "object" ||
        vars === null ||
        e.mutationId === undefined
      )
        return [];
      const scope = vars as Record<string, unknown>;
      if (scope.repo !== repo) return [];
      // A project create names no project yet, so it stays visible repo-wide;
      // every other project write, and every view write, names the one it edits.
      const scoped = family === "view" || typeof scope.projectId === "string";
      if (projectId !== null && scoped && scope.projectId !== projectId)
        return [];
      return [
        {
          mutationId: e.mutationId,
          kind: projectWriteKind(family, e.key?.[1], scope),
          isPaused: e.paused ?? false,
        },
      ];
    };
  return [
    ...projectEntries.flatMap(read("project")),
    ...viewEntries.flatMap(read("view")),
  ];
}

/** Whether a write to one issue's or pull request's project rail is pending on
 *  `target`, and whether every such write is parked offline. Matched on the write's
 *  VARIABLES (repo, lens, kind, number), so a rail remounted on the same item finds
 *  a write its previous mount started. */
export function pendingItemWriteFor(
  entries: readonly PendingMutationEntry[],
  target: ItemWriteTarget,
): PendingItemWrite {
  const matched = entries.filter((e) => {
    const vars = e.vars;
    if (typeof vars !== "object" || vars === null) return false;
    const { repo, lens, kind, number } = vars as Record<string, unknown>;
    return (
      repo === target.repo &&
      lens === target.lens &&
      kind === target.kind &&
      number === target.number
    );
  });
  return {
    pending: matched.length > 0,
    paused: matched.length > 0 && matched.every((e) => e.paused === true),
  };
}

/**
 * Whether a board-write mutation on `repo` is PAUSED offline — it ran its
 * `onMutate` patch, but query-core parked it before its `mutationFn`, so the
 * request-scoped count (internal.ts `pendingBoardWrites`) never saw it. Never
 * true for a write inside its request, so the two readings can't both count one
 * write.
 *
 * Never true for a write that is settling either, so a settle can't count itself
 * — PROVIDED every board-write `onMutate` awaits only microtask-scope work (today:
 * `cancelQueries`). query-core captures `isPaused` BEFORE `onMutate` and clears
 * it only on resume or at the final success/error dispatch, after `onSettled`: a
 * write that went offline→online across an `onMutate` spanning a real event would
 * start without pausing and carry `isPaused: true` through its own settle.
 */
export function pausedBoardWriteOn(
  mutation: { state: { isPaused: boolean; variables?: unknown } },
  repo: string,
): boolean {
  return mutation.state.isPaused && boardWriteVars(mutation).repo === repo;
}

/** Count one more live chase on the lens `hash`. */
export function holdLens(held: Map<string, number>, hash: string): void {
  held.set(hash, (held.get(hash) ?? 0) + 1);
}

/** Count one chase on `hash` finished; the entry is DELETED at zero, so the map
 *  holds only lenses a chase is reading. */
export function releaseLens(held: Map<string, number>, hash: string): void {
  const left = (held.get(hash) ?? 1) - 1;
  if (left > 0) held.set(hash, left);
  else held.delete(hash);
}

/**
 * A board lens's `refetchOnMount`: false while a date-shift chase holds the lens,
 * the query-core default (`true`) otherwise. Reads `held` LIVE on every mount —
 * a lens held after the predicate was built must still be caught.
 */
export function refetchOnMountUnlessHeld(held: ReadonlyMap<string, number>) {
  return (query: { queryHash: string }): boolean => !held.has(query.queryHash);
}

/** The slice of a react-query `Query` the focus refetch reads. Options are read
 *  per observer at CALL time, never an observer's cached `isStale`: its stale timer
 *  can lag in an occluded webview, reading fresh long past the staleTime. */
export type FocusCandidate = {
  queryHash: string;
  state: { status: string; data?: unknown };
  isStaleByTime(staleTime: StaleTime): boolean;
  observers: ReadonlyArray<{
    options: { enabled?: unknown; staleTime?: unknown };
  }>;
};

type StaleTime = number | "static";

/** An option given as a value or as a function of the query, resolved the way
 *  query-core resolves `enabled` and `staleTime`. */
function resolveOption(value: unknown, query: FocusCandidate): unknown {
  return typeof value === "function" ? value(query) : value;
}

/**
 * Which ACTIVE repo queries a window focus refetches: those an enabled observer
 * holds past its own staleTime, and those in error with no data or a finite
 * staleTime (forge-status keeps its last good data beside the error, so within its
 * staleTime only this arm retries an outage; an Infinity read, like deep Actions
 * pages, never replays). A lens in `chased` is never refetched: see
 * {@link focusStaleMarkFilter}.
 */
export function focusRefetchPredicate(chased: ReadonlySet<string>) {
  return (query: FocusCandidate): boolean => {
    if (chased.has(query.queryHash)) return false;
    const staleTimes = query.observers.flatMap((observer): StaleTime[] => {
      if (resolveOption(observer.options.enabled, query) === false) return [];
      const staleTime = resolveOption(observer.options.staleTime, query);
      return [
        typeof staleTime === "number" || staleTime === "static" ? staleTime : 0,
      ];
    });
    if (query.state.status === "error")
      return (
        query.state.data === undefined ||
        staleTimes.some((t) => typeof t === "number" && Number.isFinite(t))
      );
    return staleTimes.some((t) => query.isStaleByTime(t));
  };
}

/**
 * The focus pass's stale mark for lenses a date-shift chase is reading: marked
 * stale but NOT refetched, since an answer landing mid-chase replaces the patched
 * dates the chase compares against and it would write the server's older ones
 * back. The chase's own settle reconciles the lens through `invalidateProjectBoards`.
 */
export function focusStaleMarkFilter(
  chased: ReadonlySet<string>,
): InvalidateQueryFilters {
  return {
    queryKey: ["repo"],
    predicate: (query) => chased.has(query.queryHash),
    refetchType: "none",
  };
}

/** The focus pass itself, over the lenses `held` names now: the active refetch,
 *  plus the stale mark when a chase is live. Nothing else is invalidated, so an
 *  inactive query keeps its own clock. Here rather than in projects.ts so
 *  `scripts/focus-refetch.test.mjs` drives the composition the app runs. */
export function refetchRepoQueriesOnFocus(
  queryClient: Pick<QueryClient, "refetchQueries" | "invalidateQueries">,
  held: ReadonlyMap<string, number>,
): void {
  // A snapshot: nothing should read a map a chase settling in between could change.
  const chased = new Set(held.keys());
  void queryClient.refetchQueries({
    queryKey: ["repo"],
    type: "active",
    predicate: focusRefetchPredicate(chased),
  });
  if (chased.size > 0)
    void queryClient.invalidateQueries(focusStaleMarkFilter(chased));
}

/** The kind a project status write files itself under, its mutation key being
 *  `[family, kind]` (projects.ts `statusWriteKey`). A key naming any
 *  other kind, or none, reads as null and so holds nothing: the filter sees
 *  `Mutation<any>`, so the key is checked, never asserted. */
export function statusWriteKind(
  key: readonly unknown[] | undefined,
): "create" | "update" | "delete" | null {
  const kind = key?.[1];
  return kind === "create" || kind === "update" || kind === "delete"
    ? kind
    : null;
}
