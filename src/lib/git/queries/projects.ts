import {
  type InfiniteData,
  notifyManager,
  type QueryClient,
  type QueryKey,
  replaceEqualDeep,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useRef, useSyncExternalStore } from "react";
import { toastError, toastErrorWithNote } from "@/lib/toast";
import * as api from "../api";
import type {
  BoardItem,
  BoardItemContent,
  BoardItems,
  BoardOrder,
  ItemFieldValues,
  ItemProjects,
  ProjectFieldDef,
  ProjectFieldOptionDef,
  ProjectFieldValue,
  ProjectFieldValueUpdate,
  ProjectItemRemove,
  ProjectIterationDef,
  ProjectV2Ref,
  RemoteLens,
} from "../types";
import {
  applyBoardOrder,
  boardAnchorId,
  boardPredecessorId,
  reorderBoardItem,
} from "./board-order";
import { keepPreviousDataForKeyAxes, repoKeys } from "./core";
import {
  invalidateProjectBoards,
  pendingBoardWrites,
  projectItemsRepoKey,
} from "./internal";

/** The GitHub Projects (v2) boards an item could join — repo-level plus the
 *  owner's. `retry: false` because the common failure is a missing `project`
 *  token scope, which no retry can fix; the picker renders the hint instead. */
export function useAvailableProjects(
  repo: string,
  enabled: boolean,
  lens: RemoteLens,
) {
  return useQuery({
    queryKey: ["repo", repo, "projects-available", lens] as const,
    queryFn: () => api.ghProjectsAvailable(repo, lens),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** Every item's board memberships in one repo — the prefix {@link itemProjectsKey}
 *  extends, and the only handle a writer without an item's lens/kind/number has.
 *  The BOARD's own add/remove are exactly that writer. */
const itemProjectsFamilyKey = (repo: string) =>
  ["repo", repo, "item-projects"] as const;

const itemProjectsKey = (
  repo: string,
  lens: RemoteLens,
  kind: "issue" | "pr",
  number: number,
) => [...itemProjectsFamilyKey(repo), lens, kind, number] as const;

/** One issue/PR's board memberships. Shorter staleTime than the catalog: the
 *  memberships are what the picker edits, the catalog only what it offers. The
 *  ENVELOPE is the data — callers unwrap `items` and read `truncated`, which no
 *  `select` may drop: the picker has to say when the list is partial. */
export function useItemProjects(
  repo: string,
  kind: "issue" | "pr",
  number: number,
  enabled: boolean,
  lens: RemoteLens,
) {
  return useQuery({
    queryKey: itemProjectsKey(repo, lens, kind, number),
    queryFn: () => api.ghItemProjects(repo, kind, number, lens),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

/** Every item's field values in one repo — the prefix {@link itemFieldValuesKey}
 *  extends, and the only handle a writer without an item's lens/kind/number has. */
const itemFieldValuesFamilyKey = (repo: string) =>
  ["repo", repo, "item-field-values"] as const;

const itemFieldValuesKey = (
  repo: string,
  lens: RemoteLens,
  kind: "issue" | "pr",
  number: number,
) => [...itemFieldValuesFamilyKey(repo), lens, kind, number] as const;

/** One issue/PR's project field values, per board. Same axes, staleTime and
 *  `retry: false` as {@link useItemProjects} — it reads the same boards through the
 *  same token scope, so a missing `project` scope fails both the same way and no
 *  retry fixes it. No `placeholderData` either: the rail can't show one item's
 *  fields under another's, so a retained set would have to be suppressed on
 *  arrival, leaving only the stale copy it pins in cache. Envelope-valued for the
 *  reason {@link useItemProjects} states. */
export function useItemFieldValues(
  repo: string,
  kind: "issue" | "pr",
  number: number,
  enabled: boolean,
  lens: RemoteLens,
) {
  return useQuery({
    queryKey: itemFieldValuesKey(repo, lens, kind, number),
    queryFn: () => api.ghItemFieldValues(repo, kind, number, lens),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

/** The picker's batched link/unlink, with an optimistic patch of the memberships
 *  cache. Adds land as `pending:`-prefixed placeholder item ids — the real item id
 *  only exists once GitHub creates the item, and `onSettled`'s refetch supplies
 *  it; the picker refuses to send a `pending:` id back as a remove target. */
export function useEditItemProjects(
  repo: string,
  kind: "issue" | "pr",
  number: number,
  lens: RemoteLens,
) {
  const queryClient = useQueryClient();
  const key = itemProjectsKey(repo, lens, kind, number);
  const fieldsKey = itemFieldValuesKey(repo, lens, kind, number);
  return useMutation({
    mutationFn: (args: {
      contentId: string;
      /** Full refs, not ids: the optimistic chip renders the title before the
       *  refetch lands (the backend takes only the ids). */
      adds: ProjectV2Ref[];
      removes: ProjectItemRemove[];
    }) =>
      api.ghEditItemProjects(
        repo,
        args.contentId,
        args.adds.map((p) => p.id),
        args.removes,
      ),
    onMutate: async (args) => {
      await queryClient.cancelQueries({ queryKey: key });
      const prev = queryClient.getQueryData<ItemProjects>(key);
      if (prev) {
        // `items` alone is patched: `truncated` is the READ's claim about the
        // server's cap on this item's memberships, which a local link or unlink
        // has no answer for — only the settle refetch does.
        queryClient.setQueryData<ItemProjects>(key, (current) => {
          if (current === undefined) return current;
          const removed = new Set(args.removes.map((r) => r.itemId));
          const kept = current.items.filter(
            (item) => !removed.has(item.itemId),
          );
          // An add for a board the item is already on would otherwise render a
          // second chip until the refetch reconciles it. The write is idempotent,
          // so skipping the placeholder is enough.
          const onBoard = new Set(kept.map((item) => item.project.id));
          return {
            ...current,
            items: [
              ...kept,
              ...args.adds
                .filter((project) => !onBoard.has(project.id))
                .map((project) => ({
                  itemId: `pending:${project.id}`,
                  project,
                })),
            ],
          };
        });
      }
      return { prev };
    },
    // Reporting lives here, not in the caller's `mutate` options: the popover
    // that fires this closes as it does, and react-query drops mutate-scoped
    // callbacks once the observer loses its listeners.
    onError: (e, _args, ctx) => {
      if (ctx?.prev) queryClient.setQueryData<ItemProjects>(key, ctx.prev);
      toastError(e);
    },
    // RETURNED, not voided: react-query holds `isPending` until this promise
    // settles, which is what lets the picker's trigger stay held across the
    // refetch rather than freeing while the cache still holds `pending:` ids.
    // `invalidateQueries` resolves even when the refetch errors, so there is no
    // stuck-trigger mode.
    onSettled: () => {
      // The fields read stays UNAWAITED — the rail filters its lines by the live
      // memberships, so it is already correct — but has to be CANCELLED first: a
      // first link enables that query mid-mutation, and query-core dedupes a
      // fetch whose data is still undefined by REUSING the in-flight promise
      // instead of cancelling it, landing the pre-link empty read as fresh.
      void queryClient
        .cancelQueries({ queryKey: fieldsKey })
        .then(() => queryClient.invalidateQueries({ queryKey: fieldsKey }));
      invalidateProjectBoards(queryClient, repo);
      return queryClient.invalidateQueries({ queryKey: key });
    },
  });
}

/** One board's field DEFINITIONS. Keyed on the board alone — no lens, no item: the
 *  same board serves every item on it. Options mirror {@link useAvailableProjects},
 *  `enabled` being the caller's own UI state, never another query's cache. */
export function useProjectFields(
  repo: string,
  projectId: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["repo", repo, "project-fields", projectId] as const,
    queryFn: () => api.ghProjectFields(repo, projectId),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** Repo + board + LENS, with NO account axis — deliberately the same contract
 *  every forge-cache family here keeps (pr-list, pr, the sibling Projects reads).
 *  An account axis belongs to all of them at once, in the account-switch task.
 *
 *  `query` is the saved view's filter, and it is an identity axis rather than an
 *  option: the server answers a filtered read with a DIFFERENT set of items, so
 *  two lenses over one board are two caches. Null is the unfiltered board. */
/** Every cached LENS of ONE board's items — the prefix {@link projectItemsKey}
 *  extends, and the handle a write that changes which cards EXIST has to patch:
 *  the board on screen is one lens, and a view switched away from still holds its
 *  own pages of the same item set. Narrower than the family
 *  {@link invalidateProjectBoards} addresses, which spans every board. */
const projectItemsFamilyKey = (repo: string, projectId: string) =>
  ["repo", repo, "project-items", projectId] as const;

/** `archived` is an identity axis for the same reason `query` is: asking for both
 *  archived states is a DIFFERENT set of items, with its own `totalCount`. It sits
 *  past the board in the key, so the family above still prefixes over it — a write
 *  that patches every cached lens reaches both states without knowing about them. */
const projectItemsKey = (
  repo: string,
  projectId: string,
  query: string | null,
  archived: boolean,
) => [...projectItemsFamilyKey(repo, projectId), query, archived] as const;

/** Whether a cached board key is the archived-INCLUSIVE lens. Read off the key
 *  rather than passed in: one write patches every cached lens of a board at once,
 *  and what the right patch IS differs between a lens that draws archived cards and
 *  one that doesn't. The axis is {@link projectItemsKey}'s last element. */
function keyShowsArchived(key: QueryKey): boolean {
  return key.at(-1) === true;
}

/**
 * Whether a cached board key is the UNFILTERED read — the `query` axis, which sits
 * one before the archived one in {@link projectItemsKey}.
 *
 * The BOUNDED-COUNTS line, and the first of two local tests. A patch may move a
 * lens's `totalCount` only where it can decide that the figure held the card: an
 * unfiltered read is decidable, a FILTERED one never is, since whether a view's
 * filter matches is the server's answer and the filter rides to it verbatim. The
 * other test is the CARD's state, which no key carries (`wasArchived` on
 * {@link BoardItemRemoval}); a writer that fires on one state only has it constant.
 * Untouched beats guessed: a count this layer leaves alone is at most one read
 * stale, where a guess compounds across repeated writes.
 */
function keyIsUnfiltered(key: QueryKey): boolean {
  return key.at(-2) === null;
}

/** `data` with the LAST loaded page's `totalCount` moved by `delta` — the last page
 *  because that is the figure the board reads, and the slot {@link appendBoardItem}
 *  already bumps. Clamped at zero: a count is never negative however the cache and
 *  the server disagree. A cache with no pages has no figure to move. */
function withBoardCount(
  data: InfiniteData<BoardItems, string | null> | undefined,
  delta: number,
): InfiniteData<BoardItems, string | null> | undefined {
  if (data === undefined || delta === 0) return data;
  const last = data.pages.length - 1;
  if (last < 0) return data;
  return {
    ...data,
    pages: data.pages.map((page, i) =>
      i === last
        ? { ...page, totalCount: Math.max(0, page.totalCount + delta) }
        : page,
    ),
  };
}

/** One board's saved views. Repo + board and no account axis, the family contract
 *  {@link projectItemsKey} states. */
const projectViewsKey = (repo: string, projectId: string) =>
  ["repo", repo, "project-views", projectId] as const;

/** Which board write a mutation IS. Rides its `mutationKey` so the panel can tell
 *  the kinds apart without holding a flag per hook. */
export type BoardWriteKind =
  | "move"
  /** A card repositioned inside its own column — the project's global order,
   *  which no column pick expresses. */
  | "reorder"
  | "convert"
  | "archive"
  /** An archived card put back on the board — the archive's reversal, which changes
   *  the card in place rather than taking it off. */
  | "restore"
  | "remove"
  | "add-existing"
  | "add-draft"
  | "edit-draft"
  /** Fired from the create-issue dialog rather than the board, and it draws no
   *  card of its own — but its settle invalidates the same board reads, so the
   *  board's pagination has to wait on it like any other write here. */
  | "add-issue-projects";

/**
 * The key every board write is tagged with: `["board-write", kind]`. It says WHAT a
 * write is and nothing else — the card-vs-add split the panel's gates need is a
 * lookup over {@link BoardWriteKind} at the call site, not a key segment, so the key
 * carries no group to fall out of sync with it.
 *
 * Tagging exists because `useMutation().isPending` tracks one observer's LATEST
 * invocation only — `MutationObserver.mutate` drops its previous mutation and
 * builds a new one (query-core 5.102.8) — while these flows deliberately allow a
 * second invocation over a first: an Esc'd draft whose write continues, consecutive
 * add-existing picks. The key lets the panel enumerate the CACHE instead, which sees
 * every one.
 *
 * WHICH REPO a write belongs to is deliberately NOT in here. The key is built from
 * the hook's render scope, and query-core re-applies a live observer's options on
 * every render: a key carrying `repo` would change identity under a repo switch,
 * which `MutationObserver.setOptions` answers by RESETTING the observer off its own
 * pending mutation. The write's repo is its call-time `variables.repo` — one source
 * of truth, fixed at fire time — so {@link usePendingBoardWrites} matches on that.
 */
const boardWriteKey = (kind: BoardWriteKind) => ["board-write", kind] as const;

/** Filter prefix for EVERY board write — narrowed to one repo by variables below. */
const BOARD_WRITES_KEY = ["board-write"] as const;

/** One pending board write, flattened for the panel's holds, strip and busy card.
 *  The two value fields are display-only reads off the write's own variables, and
 *  absent on the kinds that don't carry them. */
export interface PendingBoardWrite {
  mutationId: number;
  kind: BoardWriteKind | null;
  /** The card a write is rewriting in place — a convert, or a draft edit. */
  itemId: string | null;
  /** The issue/PR number an add-existing is putting on the board. */
  number: number | null;
}

/** Every board write's variables carry the repo it addresses; the rest are per-kind
 *  and read only for labels. Untrusted at this boundary in the sense that the
 *  filter sees `Mutation<any>`, so each field is `typeof`-guarded rather than
 *  asserted. */
function boardWriteVars(mutation: { state: { variables?: unknown } }): {
  repo: string | null;
  itemId: string | null;
  number: number | null;
} {
  const vars = mutation.state.variables;
  if (typeof vars !== "object" || vars === null)
    return { repo: null, itemId: null, number: null };
  const { repo, itemId, number } = vars as Record<string, unknown>;
  return {
    repo: typeof repo === "string" ? repo : null,
    itemId: typeof itemId === "string" ? itemId : null,
    number: typeof number === "number" ? number : null,
  };
}

/**
 * Every board write against `repo` that is currently in flight, one entry per
 * INVOCATION — the observer-independent reading the panel's gates and strip need.
 *
 * `getSnapshot` COMPUTES from the cache rather than returning a value some
 * subscription last wrote, which is the whole point of doing this by hand instead of
 * through `useMutationState`. That hook keeps its result in a ref refreshed ONLY
 * inside its cache subscription, so any window without a live subscription is a
 * blind spot it never reconciles: this panel lives under `<Activity>`, which tears
 * passive effects down on hide, and a write settling while the tab is away notifies
 * nobody. On show, re-subscribing re-reads the same untouched ref, React sees no
 * change, and the pre-hide list latches — holds and strip lines for writes that
 * finished minutes ago. `useMutationState` has the same blind spot for `repo`, which
 * reaches its filters through an options ref updated after render.
 *
 * Computing on demand makes both moot: React calls this on every render and again
 * when it re-subscribes, and each call reads the live cache under the CURRENT
 * `repo`. `replaceEqualDeep` keeps the identity stable when nothing changed, which
 * is what `useSyncExternalStore` requires of a snapshot (and the library's own
 * pattern for it).
 *
 * The repo match reads each write's own VARIABLES rather than a key segment:
 * variables are fixed when the write fires, where a key is re-derived from whatever
 * the hook's render scope holds later.
 */
export function usePendingBoardWrites(repo: string): PendingBoardWrite[] {
  const cache = useQueryClient().getMutationCache();
  // The previous snapshot `replaceEqualDeep` diffs against, so an unchanged cache
  // keeps returning one identity — `useSyncExternalStore` loops on a snapshot that
  // is a fresh value every call.
  const snapshot = useRef<PendingBoardWrite[]>([]);
  const getSnapshot = useCallback(() => {
    const next = cache
      .findAll({ mutationKey: BOARD_WRITES_KEY, status: "pending" })
      .flatMap((m): PendingBoardWrite[] => {
        const vars = boardWriteVars(m);
        if (vars.repo !== repo) return [];
        // The key's own tail; an unknown shape degrades to a null kind rather
        // than a guessed one, which drops the write from the labelled lines but
        // still counts it for the holds.
        const kind = m.options.mutationKey?.[1];
        return [
          {
            mutationId: m.mutationId,
            kind: typeof kind === "string" ? (kind as BoardWriteKind) : null,
            itemId: vars.itemId,
            number: vars.number,
          },
        ];
      });
    snapshot.current = replaceEqualDeep(snapshot.current, next);
    return snapshot.current;
  }, [cache, repo]);
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      cache.subscribe(notifyManager.batchCalls(onStoreChange)),
    [cache],
  );
  // Third argument is the server snapshot, which this desktop app never renders;
  // the same computation answers it, as the library does for its own hooks.
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Run one board write with its repo's {@link pendingBoardWrites} count held up for
 * the duration. Wraps the REQUEST rather than pairing `onMutate`/`onSettled` hooks:
 * the `finally` is what makes the decrement unmissable on the throw path, and it
 * lands before query-core continues into the settle callbacks, so a write never
 * counts itself. The entry is DELETED at zero rather than left at 0, so the map
 * holds only repos with work in flight.
 *
 * `repo` rides the call-time mutation variables at every wrap site, never a hook's
 * render scope — the same rule the writes' own targets follow.
 */
async function trackBoardWrite<T>(
  repo: string,
  write: () => Promise<T>,
): Promise<T> {
  pendingBoardWrites.set(repo, (pendingBoardWrites.get(repo) ?? 0) + 1);
  try {
    return await write();
  } finally {
    const left = (pendingBoardWrites.get(repo) ?? 1) - 1;
    if (left > 0) pendingBoardWrites.set(repo, left);
    else pendingBoardWrites.delete(repo);
  }
}

/**
 * {@link invalidateProjectBoards}'s STALE-ONLY mode, as its own function rather
 * than a flag at the call site: the settle for a write that has already patched the
 * cards it changed ({@link writeThroughBoards}).
 *
 * Stale-only because the refetch is the very thing those patches exist to avoid.
 * GitHub answers a board read off replicas that lag its own writes by seconds, so a
 * read fired at settle can return the PRE-write list — and a resolved read clears
 * `isInvalidated`, stamping that stale answer fresh for the rest of the 60s
 * staleTime. The card the user just created would then not appear until something
 * unrelated invalidated the board.
 *
 * NAMED ACCEPTED EDGE: the mode is per WRITE, not per board. A sibling write of
 * another kind settling inside that same replica window still refetches, and such a
 * refetch can drop a just-patched card until the next natural read — a window focus,
 * a tab return, the next write. Rare, self-healing, and deliberately not covered:
 * the alternative is a recently-inserted-ids overlay that has to decide when an id
 * stops being recent, which is this same replica-lag guess moved somewhere harder to
 * see.
 *
 * No cancel of its own, unlike its sibling: this runs INSIDE a cancel that already
 * ran for the patch's sake, and query-core's cancel REVERTS what it cancels — a
 * second one here could undo the patch this is marking stale. The same caller owns
 * the other half of that cancel's cost, restarting the reads it left with no data
 * ({@link writeThroughBoards}); a stale mark alone would leave them on a skeleton,
 * since `refetchType: "none"` returns before query-core reaches `refetchQueries`.
 */
function markProjectBoardsStale(queryClient: QueryClient, repo: string): void {
  void queryClient.invalidateQueries({
    queryKey: projectItemsRepoKey(repo),
    refetchType: "none",
  });
}

/**
 * Patch the boards a write changed IN PLACE instead of re-reading them, mark them
 * stale for the next natural read, and restart whatever the cancel left with nothing
 * to show.
 *
 * CANCEL FIRST, and over exactly `patchKey`: a read already in flight would otherwise
 * resolve over the patch and put the pre-write board back. It has to land BEFORE the
 * patch rather than after it, since query-core cancels with `revert: true` and a
 * cancel run afterwards would revert the cache past what was just written into it.
 * The scope is the patch's own because that is the only cache this write can clobber
 * — a read of a board `patchKey` doesn't reach can't resolve over a patch that never
 * touches it, and cancelling it would cost that board its load for nothing.
 *
 * `patchKey` is therefore both scopes at once: one board's family for a write that
 * adds a card, where a sibling board must not grow one; the repo-wide family for a
 * write addressed by an item id, which no other board holds. Either way every cached
 * LENS under it is covered — the lens sits past the board in the key — so a view
 * switched away from is patched too, and the user can switch back before anything
 * re-reads.
 *
 * RESTART LAST, wider than the cancel on purpose. A cancelled read that HAD data
 * simply keeps showing it and reconciles on the stale mark; a read cancelled mid
 * INITIAL load has nothing, and `revert: true` returns it to `status: "pending"` with
 * `fetchStatus: "idle"` (query-core 5.102.8 `Query.#revertState`), which no observer
 * re-runs on its own — a board left on its skeleton until a focus or a remount. The
 * predicate is what makes the wider scope safe: it matches only a read that has never
 * resolved AND is doing nothing, so a drawn board is never refetched, an errored one
 * is never silently retried behind its own Retry control, and an offline-paused one
 * (`fetchStatus: "paused"`) is left to resume on reconnect. Repo-wide rather than
 * `patchKey` because {@link invalidateProjectBoards}'s deferred branch cancels that
 * wide and cannot restart either, and the last write out of a burst may now be one of
 * these rather than a refetching one.
 *
 * The restart runs in BOTH stale modes, and is the only rescue in the
 * `markStale: false` one, where a read cancelled with nothing has no mark of its own
 * to reconcile on.
 */
function writeThroughBoards(
  queryClient: QueryClient,
  repo: string,
  patchKey: QueryKey,
  /** The patch, per cached lens. `key` is that lens's own key, for a write whose
   *  right answer differs by what the lens SHOWS — `setQueryData` hands an updater
   *  the previous data alone, so the key is closed over below rather than passed
   *  through it. A caller whose patch is the same everywhere just ignores it. */
  patch: (
    data: InfiniteData<BoardItems, string | null> | undefined,
    key: QueryKey,
  ) => InfiniteData<BoardItems, string | null> | undefined,
  /**
   * Whether the patched boards still owe a re-read. TRUE where the answer is
   * PARTIAL — a minted card says nothing about the rest of the board.
   *
   * FALSE shields only the lenses the payload DETERMINES: it keeps every mark ANY
   * code laid before or during this write, lays none of its own on UNFILTERED keys,
   * and marks FILTERED ones, whose membership only a server read can settle. A lens
   * carrying an earlier write's debt keeps it and re-inherits the in-window refetch
   * that implies — the earlier correction wins over this patch's freshness.
   */
  markStale = true,
  /** Keys seen invalidated BEFORE this write started clearing marks. A caller with
   *  an optimistic `onMutate` has already erased its own evidence by settle time —
   *  `setQueryData` clears `isInvalidated` — so it captures the debt there and hands
   *  it here. Read by the shield arm alone; duplicates are harmless, since
   *  `Query.invalidate()` no-ops on an already-invalidated query. */
  owedMarks: readonly QueryKey[] = [],
): void {
  void queryClient.cancelQueries({ queryKey: patchKey }).then(() => {
    const keys = queryClient
      .getQueriesData<InfiniteData<BoardItems, string | null>>({
        queryKey: patchKey,
      })
      .map(([key]) => key);
    // Three reasons a key still owes a read under the shield: it is FILTERED, where
    // the payload cannot settle membership at all — only the server knows whether
    // that view keeps the card; a mark landed between mutate and settle; or the
    // caller saw one before its own `onMutate` cleared it. The middle test is read
    // BEFORE the patch, which would clear it too.
    const toMark = markStale
      ? []
      : [
          ...owedMarks,
          ...keys.filter(
            (key) =>
              !keyIsUnfiltered(key) ||
              queryClient.getQueryState(key)?.isInvalidated === true,
          ),
        ];
    for (const key of keys)
      queryClient.setQueryData<InfiniteData<BoardItems, string | null>>(
        key,
        (data) => patch(data, key),
      );
    if (markStale) markProjectBoardsStale(queryClient, repo);
    for (const queryKey of toMark)
      void queryClient.invalidateQueries({
        queryKey,
        exact: true,
        refetchType: "none",
      });
    void queryClient.refetchQueries({
      queryKey: projectItemsRepoKey(repo),
      // `active` is query-core's "some observer has `enabled !== false`", so a board
      // behind a hidden tab keeps its Activity gate and is not woken here.
      type: "active",
      predicate: (query) =>
        query.state.status === "pending" && query.state.fetchStatus === "idle",
    });
  });
}

/** One board's items under one LENS, paged. Keyed on the board, the saved view's
 *  filter and the archived toggle: a board is the same object whichever remote
 *  reached it, but each filter and each archived state answers with a different set
 *  of items and its own `totalCount`. `retry: false` for the same reason the rest of
 *  the Projects family uses it: the common failure is a missing `project` scope,
 *  which no retry fixes. The backend auto-pages, so a page here is up to 500 items
 *  and `truncated` drives "Load more" rather than an automatic walk to the end of a
 *  5,000-item board.
 *
 *  `query` rides to the server verbatim; null is the unfiltered board.
 *  `includeArchived` asks for both archived states rather than the default read's
 *  live items alone. Switching lenses keeps the previous one's cards on screen (the
 *  placeholder axes below), so callers gate every claim they DERIVE from the data —
 *  a count, a page control — on `!isPlaceholderData`. */
export function useProjectItems(
  repo: string,
  projectId: string,
  query: string | null,
  enabled: boolean,
  includeArchived: boolean,
) {
  return useInfiniteQuery({
    queryKey: projectItemsKey(repo, projectId, query, includeArchived),
    queryFn: ({ pageParam }) =>
      api.ghProjectItems(repo, projectId, pageParam, query, includeArchived),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.truncated ? last.endCursor : null),
    enabled,
    staleTime: 60_000,
    retry: false,
    // The board is a placeholder axis (index 3 in the key literal above); the filter
    // at index 4 and the archived state at index 5 deliberately are not. Switching
    // views, or showing archived cards, keeps the previous lens's cards on screen
    // while the new read lands, where switching BOARDS must never show another's.
    placeholderData: keepPreviousDataForKeyAxes(repo, [[3, projectId]]),
  });
}

/** One board's SAVED VIEWS — the lenses the switcher offers. Board state like the
 *  field definitions, so the same options: no lens, no item, `retry: false`
 *  because the common failure is the missing `project`/`read:project` scope. */
export function useProjectViews(
  repo: string,
  projectId: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: projectViewsKey(repo, projectId),
    queryFn: () => api.ghProjectViews(repo, projectId),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** The board fields a move writes: the kinds that make columns. */
type BoardGroupField = Extract<
  ProjectFieldDef,
  { kind: "singleSelect" | "iteration" }
>;

/** Where a move sends a card, per grouping kind — or null for the board's
 *  "No {field}" column, which stands for the ABSENCE of a value and so clears the
 *  field rather than setting it. */
export type BoardMoveBucket =
  | { kind: "option"; option: ProjectFieldOptionDef }
  | { kind: "iteration"; iteration: ProjectIterationDef }
  | null;

/** `bucket` as the value the card will read as once the write lands. */
function groupValue(
  field: BoardGroupField,
  bucket: NonNullable<BoardMoveBucket>,
): ProjectFieldValue {
  // Iteration field definitions carry no `isIssueField` at all: GitHub has no
  // org-level iteration field, so an iteration value is always the board's own.
  const isIssueField = field.kind === "iteration" ? false : field.isIssueField;
  if (bucket.kind === "option")
    return {
      kind: "singleSelect",
      fieldId: field.id,
      fieldName: field.name,
      optionId: bucket.option.id,
      name: bucket.option.name,
      color: bucket.option.color,
      isIssueField,
    };
  return {
    kind: "iteration",
    fieldId: field.id,
    fieldName: field.name,
    iterationId: bucket.iteration.id,
    title: bucket.iteration.title,
    startDate: bucket.iteration.startDate,
    duration: bucket.iteration.duration,
    isIssueField,
  };
}

/** `bucket` as the wire's set list: one update, or none at all for the clear —
 *  which rides the write's separate `clears` list, no update shape expressing it. */
function moveUpdates(
  fieldId: string,
  bucket: BoardMoveBucket,
): ProjectFieldValueUpdate[] {
  if (bucket === null) return [];
  if (bucket.kind === "option")
    return [{ kind: "singleSelect", fieldId, optionId: bucket.option.id }];
  return [{ kind: "iteration", fieldId, iterationId: bucket.iteration.id }];
}

/** The moved item's field values with `field` set to `bucket`, or dropped when
 *  `bucket` is null — the clear. Replaced IN PLACE where an entry already exists so
 *  the rail's line order survives a move. Matched on the FIELD ID alone: one field
 *  holds one value, whatever kind the cached copy of it was read as. */
function withGroupValue(
  values: ProjectFieldValue[],
  field: BoardGroupField,
  bucket: BoardMoveBucket,
): ProjectFieldValue[] {
  const next = bucket === null ? null : groupValue(field, bucket);
  const isField = (value: ProjectFieldValue) =>
    "fieldId" in value && value.fieldId === field.id;
  const held = values.some(isField);
  if (!held) return next === null ? values : [...values, next];
  return values.flatMap((value) => {
    if (!isField(value)) return [value];
    return next === null ? [] : [next];
  });
}

/** One item's `fieldValues` replaced across every cached page, leaving every OTHER
 *  item and every page the caller never read exactly as they are. Both directions
 *  of the write go through here: a whole-tree restore would drop a `Load more` page
 *  that landed mid-flight, since the rollback would carry the tree as it was before
 *  that page existed. */
function patchBoardItem(
  data: InfiniteData<BoardItems, string | null> | undefined,
  itemId: string,
  values: ProjectFieldValue[],
): InfiniteData<BoardItems, string | null> | undefined {
  if (data === undefined) return undefined;
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      items: page.items.map((item) =>
        item.itemId === itemId ? { ...item, fieldValues: values } : item,
      ),
    })),
  };
}

/** One item's ARCHIVED flag flipped across every cached page — the patch for a write
 *  that changes whether a card is archived rather than what it holds, which is why it
 *  sits beside {@link patchBoardItem} rather than reusing it (that one replaces field
 *  values and nothing else). Pages that don't hold the card keep their identity, so no
 *  column re-renders for a card it doesn't draw. */
function patchBoardItemArchived(
  data: InfiniteData<BoardItems, string | null> | undefined,
  itemId: string,
  isArchived: boolean,
): InfiniteData<BoardItems, string | null> | undefined {
  if (data === undefined) return undefined;
  return {
    ...data,
    pages: data.pages.map((page) =>
      page.items.some((item) => item.itemId === itemId)
        ? {
            ...page,
            items: page.items.map((item) =>
              item.itemId === itemId ? { ...item, isArchived } : item,
            ),
          }
        : page,
    ),
  };
}

/** One item appended to the LAST loaded page, which is where the board puts a MINTED
 *  card: the pages are in position order. For a REJOINING one (a restore) that slot
 *  only approximates the position it always held, which no cache can say. Never
 *  twice — a second copy would be a card the menu and the move path can both target —
 *  and that guard is what lets a caller compose this after a patch without testing
 *  which of the two applies.
 *
 *  `totalCount` moves only when `countsIt` says this lens's figure excluded the item
 *  until now, which is unknowable under a filter. The flag lives here rather than at
 *  the call site because only this function knows whether the insert happened. A
 *  cache with no pages has no board to append to. */
function appendBoardItem(
  data: InfiniteData<BoardItems, string | null> | undefined,
  item: BoardItem,
  countsIt = true,
): InfiniteData<BoardItems, string | null> | undefined {
  if (data === undefined) return undefined;
  const last = data.pages.length - 1;
  if (last < 0) return data;
  if (
    data.pages.some((page) => page.items.some((i) => i.itemId === item.itemId))
  )
    return data;
  return {
    ...data,
    pages: data.pages.map((page, i) =>
      i === last
        ? {
            ...page,
            items: [...page.items, item],
            totalCount: countsIt ? page.totalCount + 1 : page.totalCount,
          }
        : page,
    ),
  };
}

/** One item REPLACED wholesale wherever a page holds its id — the write's own answer
 *  standing in for what the cache had. {@link patchBoardItem}'s rule for the card
 *  whose CONTENT changed (a draft that became an issue), which a field-values patch
 *  would leave reading as the old thing. Pages that don't hold it keep their identity,
 *  so no column re-renders for a card it doesn't draw. */
function replaceBoardItem(
  data: InfiniteData<BoardItems, string | null> | undefined,
  item: BoardItem,
): InfiniteData<BoardItems, string | null> | undefined {
  if (data === undefined) return undefined;
  return {
    ...data,
    pages: data.pages.map((page) =>
      page.items.some((cur) => cur.itemId === item.itemId)
        ? {
            ...page,
            items: page.items.map((cur) =>
              cur.itemId === item.itemId ? item : cur,
            ),
          }
        : page,
    ),
  };
}

/** One DRAFT card's content replaced in place, keeping its field values and its slot.
 *  Refuses on a card that is no longer a draft: a convert settling first has already
 *  swapped the content, and an edit's answer describes a note that card no longer
 *  holds. */
function patchDraftContent(
  data: InfiniteData<BoardItems, string | null> | undefined,
  itemId: string,
  content: Extract<BoardItemContent, { kind: "draft" }>,
): InfiniteData<BoardItems, string | null> | undefined {
  if (data === undefined) return undefined;
  // ONE predicate for both levels: a page whose only match is a card that has since
  // become an issue would otherwise take a fresh identity for a map that changed
  // nothing, re-rendering a column for a no-op.
  const rewritable = (item: BoardItem) =>
    item.itemId === itemId && item.content.kind === "draft";
  return {
    ...data,
    pages: data.pages.map((page) =>
      page.items.some(rewritable)
        ? {
            ...page,
            items: page.items.map((cur) =>
              rewritable(cur) ? { ...cur, content } : cur,
            ),
          }
        : page,
    ),
  };
}

/** Where one item sits in a board's cached pages, plus the item itself — what a
 *  removal has to remember to be able to put it back exactly where it was. One
 *  removal patches every cached lens of the board and each needs its own record; the
 *  LENS it belongs to rides the undo entry that carries this. */
interface RemovedBoardItem {
  pageIndex: number;
  itemIndex: number;
  item: BoardItem;
}

/** `itemId`'s page and slot in `data`, or null when this lens doesn't draw it. */
function findBoardItem(
  data: InfiniteData<BoardItems, string | null> | undefined,
  itemId: string,
): { pageIndex: number; itemIndex: number; item: BoardItem } | null {
  if (data === undefined) return null;
  for (const [pageIndex, page] of data.pages.entries()) {
    const itemIndex = page.items.findIndex((item) => item.itemId === itemId);
    if (itemIndex !== -1)
      return { pageIndex, itemIndex, item: page.items[itemIndex] };
  }
  return null;
}

/** One item dropped from every cached page, leaving every OTHER item and every page
 *  the caller never read exactly as they are — {@link patchBoardItem}'s rule, for
 *  the other kind of write.
 *
 *  `totalCount` is untouched HERE, and the caller decides: each lens's figure matches
 *  its OWN filter (measured 2026-09-21), so what a drop means for it is a question
 *  about the KEY rather than about these pages. The removal loop composes
 *  {@link withBoardCount} over this for the keys where that question has a local
 *  answer, and leaves the figure alone on the rest, where it still rides an ordinary
 *  read. Composing rather than flagging is right for this direction precisely because
 *  the decrement is key-driven, not presence-driven: an unfiltered live-only lens
 *  loses the card from its count whether or not these pages had loaded it. */
function dropBoardItem(
  data: InfiniteData<BoardItems, string | null> | undefined,
  itemId: string,
): InfiniteData<BoardItems, string | null> | undefined {
  if (data === undefined) return undefined;
  return {
    ...data,
    pages: data.pages.map((page) =>
      page.items.some((item) => item.itemId === itemId)
        ? { ...page, items: page.items.filter((i) => i.itemId !== itemId) }
        : page,
    ),
  };
}

/** {@link dropBoardItem}'s inverse: the one item back at the page and slot it left,
 *  onto the CURRENT cache rather than a snapshot of the world — restoring a whole
 *  tree would revert a concurrent write to a sibling card and drop a `Load more`
 *  page that landed while this one was in flight.
 *
 *  Three ways the board can have moved on underneath, each left alone rather than
 *  forced: a refetch already put the item back (never insert it twice), the page it
 *  sat on no longer exists, or that page is now shorter than its old slot (the
 *  splice clamps to the end). */
function restoreBoardItem(
  data: InfiniteData<BoardItems, string | null> | undefined,
  at: RemovedBoardItem,
): InfiniteData<BoardItems, string | null> | undefined {
  if (data === undefined) return undefined;
  const held = data.pages.some((page) =>
    page.items.some((item) => item.itemId === at.item.itemId),
  );
  const page = data.pages[at.pageIndex];
  if (held || page === undefined) return data;
  const items = [...page.items];
  items.splice(Math.min(at.itemIndex, items.length), 0, at.item);
  return {
    ...data,
    pages: data.pages.map((p, i) =>
      i === at.pageIndex ? { ...page, items } : p,
    ),
  };
}

/**
 * The board's own move: one item's grouped single-select field, written through the
 * same command the field editor uses, with an optimistic patch of the board's item
 * pages. `buildColumns` derives the columns from those field values, so the patch
 * re-buckets the card at its global-position slot without the board re-reading.
 *
 * Single-writer by contract: the panel holds ONE instance and disables every move
 * row while it is pending. Not for the snapshot's sake — the rollback below is one
 * item wide — but because two writes to the same card's field settle in an order
 * neither the board nor GitHub promises, and a late rollback would put a card back
 * in a column a later write already moved it out of.
 *
 * The write TARGET rides the variables, never this hook's scope. A pending mutation
 * runs on the latest render's options — query-core re-applies them on every
 * re-render, and an offline move PAUSES before `mutationFn` and resumes through
 * whatever closure is current — so a repo or board switch mid-flight would
 * otherwise submit the old card against the new board.
 */
export function useMoveBoardCard() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: boardWriteKey("move"),
    mutationFn: (args: {
      repo: string;
      projectId: string;
      /** The membership's item id on `projectId` — what the write addresses. */
      itemId: string;
      field: BoardGroupField;
      /** The column's bucket, or null for the board's "No {field}" column. */
      bucket: BoardMoveBucket;
      /** The lens the board was showing when the move was fired — the cache this
       *  write patches and rolls back. Switching views mid-flight is safe because
       *  `onMutate` pins the key into the context the settle handlers read, not
       *  because anything cancels the write. */
      query: string | null;
      /** Whether that lens was drawing archived cards — the other half of the key,
       *  for the reason `query` is a variable rather than a render read. */
      archived: boolean;
    }) =>
      trackBoardWrite(args.repo, () =>
        api.ghSetItemFieldValues(
          args.repo,
          args.projectId,
          args.itemId,
          // The wire takes the field id and the bucket's own id, so the field's
          // KIND never enters here — a mismatched pair is unrepresentable.
          moveUpdates(args.field.id, args.bucket),
          args.bucket === null ? [args.field.id] : [],
        ),
      ),
    onMutate: async (args) => {
      // Derived from the variables, like every other target here: `onMutate` runs
      // before the pause so its own scope is safe, but one source of truth for
      // WHERE the write lands is what keeps the settle handlers honest.
      const key = projectItemsKey(
        args.repo,
        args.projectId,
        args.query,
        args.archived,
      );
      const railKey = itemFieldValuesFamilyKey(args.repo);
      await queryClient.cancelQueries({ queryKey: key });
      // The one card's values, not the whole tree: that is all the rollback needs,
      // and all it may safely carry.
      const before = queryClient
        .getQueryData<InfiniteData<BoardItems, string | null>>(key)
        ?.pages.flatMap((page) => page.items)
        .find((item) => item.itemId === args.itemId)?.fieldValues;
      if (before !== undefined)
        queryClient.setQueryData<InfiniteData<BoardItems, string | null>>(
          key,
          (data) =>
            patchBoardItem(
              data,
              args.itemId,
              withGroupValue(before, args.field, args.bucket),
            ),
        );
      // The settle handlers read these, never their own scope: they too run on the
      // latest render's options, so a mid-flight switch would otherwise roll the
      // old board's values into the new board's key and invalidate the wrong repo's
      // boards.
      return { before, itemId: args.itemId, key, railKey, repo: args.repo };
    },
    // Reporting and rollback live here, not in the caller's `mutate` options: the
    // context menu that fires this closes as it does, and react-query drops
    // mutate-scoped callbacks once the observer loses its listeners.
    onError: (e, _args, ctx) => {
      if (ctx !== undefined && ctx.before !== undefined) {
        const { key, itemId, before } = ctx;
        queryClient.setQueryData<InfiniteData<BoardItems, string | null>>(
          key,
          (data) => patchBoardItem(data, itemId, before),
        );
      }
      toastError(e);
    },
    // Cancel-before-invalidate on both families, for the reason
    // {@link invalidateProjectBoards} states: a read already in flight would
    // otherwise resolve afterwards and stamp itself fresh, erasing the
    // invalidation. Invalidate-only past that — no forced refetch, so a rail
    // behind a closed sidebar still re-reads on its own terms.
    onSettled: (_d, _e, _args, ctx) => {
      if (ctx === undefined) return;
      invalidateProjectBoards(queryClient, ctx.repo);
      void queryClient
        .cancelQueries({ queryKey: ctx.railKey })
        .then(() => queryClient.invalidateQueries({ queryKey: ctx.railKey }));
    },
  });
}

/**
 * The reposition writes between their request and their answer, keyed by the CACHE
 * each one chases: repo, board, lens (filter and archived state both) and card
 * together. Module scope for the reason {@link pendingBoardWrites} is — the
 * serializer has to hold across renders and across the hook instance.
 *
 * This keys the FOLD-vs-RUN decision only (repo + board + lens + card): the chase
 * re-reads ONE lens's cache, so a press made under a different saved view (or a
 * second repo path onto the same board) splices a cache the live write never looks
 * at, and folding it in would drop it silently — keyed this way it starts its own
 * write instead. Whether a converged settle re-asserts its board-wide order is a
 * SEPARATE, lens-agnostic question ({@link reorderingBoards}): while any reorder is
 * in flight on the board the re-assert defers to that write's settle.
 *
 * `JSON.stringify` rather than a joined string: a saved view's filter and a
 * Windows repo path both carry spaces, and array encoding is injective without
 * having to claim a delimiter is impossible.
 */
const reorderingCards = new Set<string>();

const reorderFoldKey = (args: {
  repo: string;
  projectId: string;
  query: string | null;
  archived: boolean;
  itemId: string;
}) =>
  JSON.stringify([
    args.repo,
    args.projectId,
    args.query,
    args.archived,
    args.itemId,
  ]);

/**
 * How many reposition writes are in flight against each BOARD, keyed
 * LENS-AGNOSTICALLY (repo + board, no query). A converged settle re-asserts its
 * payload over EVERY cached item of the board ({@link applyBoardOrder} is
 * board-wide), so it must defer while ANY other card's reorder is still running on
 * that board — a concurrent reorder of a different card carries that card's OLD
 * position in this write's payload, and re-asserting would revert it. The lens is
 * out of the key on purpose: a concurrent reorder under another saved view still
 * has to be seen. Distinct from {@link reorderingCards}, which keys the
 * fold-vs-run decision per lens.
 */
const reorderingBoards = new Map<string, number>();

const reorderBoardKey = (args: { repo: string; projectId: string }) =>
  JSON.stringify([args.repo, args.projectId]);

/** How many FOLLOW-UP writes one burst may spend chasing the card's own cache
 *  position. Reachable by ordinary use — a long key-hold down a long column moves
 *  faster than the round trips — so running out is a real outcome rather than a
 *  pathological one, and the settle answers it with a re-read instead of a patch. */
const REORDER_CHASE_LIMIT = 8;

/** How long a FOLLOW-UP write waits before each re-attempt — one entry per
 *  re-attempt, so the list's length is the retry budget. Long enough to clear the
 *  server-side contention a burst creates, short enough that a hard failure still
 *  reaches the user in about a second. Chase rounds count writes, never attempts:
 *  a retried write is the same round trying again. */
const REORDER_RETRY_WAITS_MS = [300, 800];

/** How one reposition burst ended. A FOLDED press is reconciled by the write it
 *  folded into; a CONVERGED one patches the payload's order over the cache. Both
 *  ways of EXHAUSTED share a cache half — earlier writes DID land and where the
 *  server ended up is no longer something this cache can say, so only a re-read is
 *  honest (patching would snap the card backwards, rolling back would erase a write
 *  that stuck) — but differ on feedback: a follow-up that FAILED every retry
 *  carries its `error`, which the settle toasts (matching the initial write's
 *  throw), while running out of chase rounds is not a failure (the user out-pressed
 *  the chase) and carries none. */
type ReorderOutcome =
  | { kind: "folded" }
  | { kind: "converged"; order: BoardOrder }
  | { kind: "exhausted"; error?: unknown };

/**
 * Reposition one card inside the project's own item order, with an optimistic
 * splice of the board's loaded pages. The order a board draws its cards in IS this
 * sequence — `buildColumns` keeps it — so the splice re-draws the card in its new
 * slot without the board re-reading.
 *
 * COALESCED, not queued: at most one write per card PER LENS is in flight
 * ({@link reorderingCards}), and a press that arrives during one applies its splice
 * and returns. The live write then re-reads the card's CURRENT place from that
 * lens's cache after each round trip and writes again when it has moved, until the
 * two agree. The cache IS the pending target, so there is no second piece of state
 * to keep in step with it. The invariant is convergence, not history: the server
 * ends up where the card is drawn, and positions the user pressed through may never
 * be written at all.
 *
 * That re-read is a CALL-TIME `getQueryData`, never a render closure, for the
 * reason {@link useMoveBoardCard} states: query-core re-applies a pending
 * mutation's options on every render and resumes an offline-paused write through
 * whatever closure is current by then. The write target rides the variables for the
 * same reason.
 *
 * The rollback is one card wide — the id it previously followed — rather than a
 * tree snapshot, which would revert a concurrent write to a sibling card and drop a
 * `Load more` page that landed mid-flight.
 */
export function useReorderBoardCard() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: boardWriteKey("reorder"),
    mutationFn: async (args: {
      repo: string;
      projectId: string;
      /** The membership's item id on `projectId` — what the write addresses. */
      itemId: string;
      /** The id this card lands directly AFTER, or null for the top of the
       *  board. */
      afterId: string | null;
      /** The lens the board was showing when the press landed — the cache this
       *  write patches, rolls back, and re-reads the card's place from. */
      query: string | null;
      /** Whether that lens was drawing archived cards — the other half of the key.
       *  The board holds every reposition while they are shown (an archived card is
       *  not a legal position anchor), so this is false in practice; it rides the
       *  variables anyway, since the key is built from them and nothing else. */
      archived: boolean;
    }): Promise<ReorderOutcome> => {
      const fold = reorderFoldKey(args);
      // Folded into the write already chasing THIS cache: its own loop below picks
      // this press's splice up, so a second request would only race it.
      if (reorderingCards.has(fold)) return { kind: "folded" };
      reorderingCards.add(fold);
      // A write that ACTUALLY starts (never a fold) counts against its board, so a
      // converged settle can see a concurrent reorder of another card still in
      // flight and defer the board-wide re-assert to that write's settle.
      const boardKey = reorderBoardKey(args);
      reorderingBoards.set(boardKey, (reorderingBoards.get(boardKey) ?? 0) + 1);
      try {
        const key = projectItemsKey(
          args.repo,
          args.projectId,
          args.query,
          args.archived,
        );
        let afterId = args.afterId;
        const write = () =>
          trackBoardWrite(args.repo, () =>
            api.ghSetItemPosition(
              args.repo,
              args.projectId,
              args.itemId,
              afterId,
            ),
          );
        /** Where the cache says the card sits now, as an id a write may anchor to.
         *  A lens that has stopped drawing it reads as agreement, there being
         *  nothing left to disagree with; `null` is a real answer (the top of the
         *  board), so the absent case is tested rather than coalesced. */
        const cached = () => {
          const at = boardAnchorId(
            queryClient.getQueryData<InfiniteData<BoardItems, string | null>>(
              key,
            ),
            args.itemId,
          );
          return at === undefined ? afterId : at;
        };
        /**
         * One position write, re-attempted through a transient server failure.
         * `updateProjectV2ItemPosition` was observed answering a 500 (with a
         * GitHub request id) WHILE COMMITTING the write — the response errors, the
         * side effect lands (measured 2026-09-19, a single spaced press) — and
         * back-to-back calls on one project hit the same class transiently, where
         * spaced single writes succeed. So the failure reaches the initial write as
         * well as the chase's, and the anchor is not the variable.
         *
         * The retry absorbs it because the re-issue is idempotent: attempt 2 sends
         * updateProjectV2ItemPosition with the SAME `afterId`, which is a no-op
         * reposition returning 200 whether or not attempt 1 committed. So a
         * transient 500 (the common case) resolves to a confirmed success, and only
         * a persistent failure reaches null. No error-string classification —
         * everything is retried, the chase re-reads afterwards, and the cost is
         * bounded to about a second.
         */
        // The last real failure across attempts, kept so the initial-write throw
        // can surface GitHub's own error rather than a synthetic one — `toastError`
        // in `onError` renders the AppError it carries.
        let lastError: unknown;
        const retryWrite = async (): Promise<BoardOrder | null> => {
          for (let attempt = 0; ; attempt += 1) {
            try {
              return await write();
            } catch (e) {
              lastError = e;
              const waitMs = REORDER_RETRY_WAITS_MS[attempt];
              if (waitMs === undefined) return null;
              await new Promise((resolve) => setTimeout(resolve, waitMs));
            }
          }
        };
        // The INITIAL write is retried too, and only THROWS when every attempt
        // failed: a 500-but-commit here means the move DID land, so a rollback +
        // toast would be a lie about a success. A genuine outage still exhausts to
        // null and throws the real error, where the rollback IS truthful.
        const first = await retryWrite();
        if (first === null) throw lastError;
        let order = first;
        for (let chase = 0; chase < REORDER_CHASE_LIMIT; chase += 1) {
          const at = cached();
          if (at === afterId) return { kind: "converged", order };
          afterId = at;
          const next = await retryWrite();
          // A follow-up that failed every attempt carries its error so the settle
          // can toast it — silently succeeding would be inconsistent with the
          // initial write, which throws the same failure.
          if (next === null) return { kind: "exhausted", error: lastError };
          order = next;
        }
        // Out of rounds — the user out-pressed the chase, NOT a failure, so no
        // error rides along. One last read decides which it was: the final write
        // may well have caught up, and only a still-disagreeing cache is exhaustion.
        return cached() === afterId
          ? { kind: "converged", order }
          : { kind: "exhausted" };
      } finally {
        reorderingCards.delete(fold);
        const left = (reorderingBoards.get(boardKey) ?? 1) - 1;
        if (left > 0) reorderingBoards.set(boardKey, left);
        else reorderingBoards.delete(boardKey);
      }
    },
    onMutate: async (args) => {
      // Derived from the variables, like every other target here.
      const key = projectItemsKey(
        args.repo,
        args.projectId,
        args.query,
        args.archived,
      );
      await queryClient.cancelQueries({ queryKey: key });
      const before = boardPredecessorId(
        queryClient.getQueryData<InfiniteData<BoardItems, string | null>>(key),
        args.itemId,
      );
      queryClient.setQueryData<InfiniteData<BoardItems, string | null>>(
        key,
        (data) => reorderBoardItem(data, args.itemId, args.afterId),
      );
      // The settle handlers read these rather than their own scope: they run on
      // the latest render's options, so a mid-flight repo or board switch would
      // otherwise patch the new board's cache with the old board's answer.
      return {
        key,
        itemId: args.itemId,
        repo: args.repo,
        projectId: args.projectId,
        before,
      };
    },
    // Reporting and rollback live here, not in the caller's `mutate` options: the
    // keypress that fires this moves focus on, and react-query drops mutate-scoped
    // callbacks once the observer loses its listeners.
    // The rollback target predates any chase rounds that already landed on GitHub,
    // so it describes a board the server may have moved past — the settle's
    // invalidation is what corrects both the cache and that lie.
    onError: (e, _args, ctx) => {
      if (ctx !== undefined && ctx.before !== undefined) {
        const { key, itemId, before } = ctx;
        queryClient.setQueryData<InfiniteData<BoardItems, string | null>>(
          key,
          (data) => reorderBoardItem(data, itemId, before),
        );
      }
      toastError(e);
    },
    onSettled: (outcome, e, _args, ctx) => {
      if (ctx === undefined) return;
      // A refused write needs a real re-read: order is the one thing a failure
      // says nothing about, and the rollback above is a guess at what the board
      // had rather than a reading of what it has.
      if (e !== null || outcome === undefined) {
        invalidateProjectBoards(queryClient, ctx.repo);
        return;
      }
      switch (outcome.kind) {
        // The write this folded into owns the reconciliation for both of them.
        case "folded":
          return;
        // The burst stopped short with writes already landed, so neither the
        // payload nor the rollback describes the board: a re-read is the answer. A
        // follow-up that FAILED every retry also toasts it, matching the initial
        // write's throw; running out of chase rounds carries no error and stays
        // silent.
        case "exhausted":
          if (outcome.error !== undefined) toastError(outcome.error);
          invalidateProjectBoards(queryClient, ctx.repo);
          return;
        // Board-wide: the payload describes the PROJECT's order, which every cached
        // lens of this board is a subsequence of. No rail family — a reposition
        // changes no field value.
        default: {
          // Burst-boundary guard. This settle is queued behind writeThroughBoards'
          // own cancelQueries().then(); by the time it runs a reorder of ANOTHER
          // card may still be in flight on this board, and its payload carries this
          // card's — or that card's — OLD position, so re-asserting our board-wide
          // order would revert it. The finally already decremented THIS write before
          // onSettled runs, so a positive count means a DIFFERENT write is live and
          // owns the reconciliation. Lens-agnostic key: a concurrent reorder under
          // another saved view counts too.
          if ((reorderingBoards.get(reorderBoardKey(ctx)) ?? 0) > 0) return;
          writeThroughBoards(
            queryClient,
            ctx.repo,
            projectItemsFamilyKey(ctx.repo, ctx.projectId),
            (data) => applyBoardOrder(data, outcome.order),
          );
        }
      }
    },
  });
}

/**
 * Mark one repo's per-item board memberships and project field values stale, for a
 * write that changed WHICH boards an item is on. The same two families
 * {@link useEditItemProjects} reconciles, addressed by their PREFIX: a write fired
 * from the board holds an item id and a project id, never the item's lens, kind and
 * number, so the per-item keys are out of reach.
 *
 * Cancel before invalidate on both, for the reason {@link invalidateProjectBoards}
 * states: a read already in flight would otherwise resolve afterwards and stamp
 * itself fresh, erasing the invalidation.
 */
function invalidateItemMemberships(
  queryClient: QueryClient,
  repo: string,
): void {
  for (const queryKey of [
    itemProjectsFamilyKey(repo),
    itemFieldValuesFamilyKey(repo),
  ]) {
    void queryClient
      .cancelQueries({ queryKey })
      .then(() => queryClient.invalidateQueries({ queryKey }));
  }
}

/** The issues and pull requests in this repo a board could take, for the
 *  add-existing search. `search` is an identity axis and the LENS is the other:
 *  previous results stay on screen while a new query lands, so the list doesn't
 *  blink to a skeleton on every keystroke — which is why callers gate what they
 *  DERIVE from the data on `!isPlaceholderData`. `retry: false` for the family's
 *  own reason: the common failure is a missing `project` scope, which no retry
 *  fixes. */
export function useBoardCandidates(
  repo: string,
  search: string,
  enabled: boolean,
  lens: RemoteLens,
) {
  return useQuery({
    queryKey: ["repo", repo, "board-candidates", lens, search] as const,
    queryFn: () => api.ghSearchBoardCandidates(repo, search, lens),
    enabled,
    staleTime: 60_000,
    retry: false,
    // The lens is an axis (index 3 above); the SEARCH at index 4 deliberately is
    // not — holding the previous query's rows is the whole point.
    placeholderData: keepPreviousDataForKeyAxes(repo, [[3, lens]]),
  });
}

/**
 * The board's add/convert/archive/remove writes. Each carries its target in the
 * call-time VARIABLES rather than this hook's scope, for the reason
 * {@link useMoveBoardCard} states: query-core re-applies a pending mutation's
 * options on every re-render, and an offline write pauses before `mutationFn` and
 * resumes through whatever closure is current.
 *
 * The writes that MINT or REWRITE a card settle through {@link writeThroughBoards}:
 * each answers with the card itself, and that answer is the only reading of it
 * guaranteed to exist — a re-read fired at settle can come off a replica still
 * serving the pre-write board, and a resolved read stamps that answer fresh for the
 * whole staleTime. The two REMOVALS keep the opposite shape: their patch is the
 * card's absence, applied at `onMutate`, and their settle is
 * {@link invalidateProjectBoards} verbatim — cancel, then invalidate, no forced
 * refetch — so the Activity gate still owns when a hidden board re-reads.
 *
 * A write that FAILED patches nothing and falls back to that same invalidation: a
 * rejection is not proof the board is unchanged.
 *
 * Reporting lives in the hooks whose host closes on fire (the card menu, the add
 * dialogs), never in the caller's `mutate` options, since react-query drops
 * mutate-scoped callbacks once the observer loses its listeners. Callers still see
 * the rejection through `mutateAsync`, which is what drives their own UI back.
 */
export function useAddDraftItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: boardWriteKey("add-draft"),
    mutationFn: (args: {
      repo: string;
      projectId: string;
      title: string;
      /** Markdown, sent VERBATIM — the card's popover renders it as such. */
      body: string;
    }) =>
      trackBoardWrite(args.repo, () =>
        api.ghAddDraftItem(args.repo, args.projectId, args.title, args.body),
      ),
    onError: toastError,
    onSettled: (item, _e, args) => {
      if (item === undefined) {
        invalidateProjectBoards(queryClient, args.repo);
        return;
      }
      writeThroughBoards(
        queryClient,
        args.repo,
        projectItemsFamilyKey(args.repo, args.projectId),
        (data) => appendBoardItem(data, item),
      );
    },
  });
}

/** Turns a draft card into a real issue. The card keeps its item id and its slot —
 *  the answer's item is the same membership with issue content under it, which is
 *  what the patch swaps in — but the repo now has an issue that didn't exist, so the
 *  memberships families go stale with it. */
export function useConvertDraftItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: boardWriteKey("convert"),
    mutationFn: (args: { repo: string; itemId: string; lens: RemoteLens }) =>
      trackBoardWrite(args.repo, () =>
        api.ghConvertDraftItem(args.repo, args.itemId, args.lens),
      ),
    onError: toastError,
    onSettled: (converted, _e, args) => {
      // Repo-wide as the patch scope, not one board's family: a convert addresses
      // the membership's item id alone and never carries a project id, and an id no
      // other board holds makes the wider scope a no-op everywhere else.
      if (converted === undefined)
        invalidateProjectBoards(queryClient, args.repo);
      else
        writeThroughBoards(
          queryClient,
          args.repo,
          projectItemsRepoKey(args.repo),
          (data) => replaceBoardItem(data, converted.item),
        );
      invalidateItemMemberships(queryClient, args.repo);
      // A convert CREATES a repo issue, so the Issues tab has to learn about it
      // the way every other membership-changing issue write tells it: the
      // issue-list family under the lens the write ran on, which is the same key
      // `useIssueLifecycleMutation` invalidates for a transfer or a delete. The
      // issue's own DETAIL key needs nothing — it had no cache entry to go stale,
      // the issue not having existed until now.
      void queryClient.invalidateQueries({
        queryKey: [...repoKeys.issueList(args.repo), args.lens],
      });
    },
  });
}

/** What both card-removing writes address: the board, and the membership on it. */
interface BoardItemWrite {
  repo: string;
  projectId: string;
  /** The membership's item id — never the content id behind it. */
  itemId: string;
}

/** What the two card-REMOVING writes address. `wasArchived` is the card's state at
 *  fire time, and it belongs on the variables rather than being read off a cache
 *  because it is a COUNT axis the key cannot supply: what a removal takes from a
 *  live-only lens's `totalCount` depends on whether that count ever held the card,
 *  which is exactly "was it archived". Archived-showing lenses counted it either way,
 *  so only the live-only arm asks. */
interface BoardItemRemoval extends BoardItemWrite {
  wasArchived: boolean;
}

/** How one cached lens was patched, so the rollback can undo exactly that: the card
 *  taken out of it, or flipped to archived in place. */
type BoardItemUndo =
  | {
      mode: "drop";
      key: QueryKey;
      /** Where the card sat, or null when this lens only ever COUNTED it — a card
       *  past the loaded pages of a lens whose count still included it. */
      at: RemovedBoardItem | null;
      /** Whether the drop took this lens's `totalCount` with it, so the undo knows
       *  whether to give it back. */
      counted: boolean;
    }
  | { mode: "archive"; key: QueryKey };

/**
 * The shared shape of the two writes that take a card OFF the board's default read,
 * with an optimistic patch of it. The card visibly changing is the feedback: the
 * round trip runs seconds, and a board that sits unchanged that long reads as a
 * click gone nowhere.
 *
 * Every cached LENS of the board is patched, not just the one on screen — a view
 * switched away from holds its own pages of the same item set, and the user can
 * switch back before the settle refetch lands. WHAT the patch is differs per lens,
 * which is why each key is read rather than assumed: an ARCHIVE on a lens that draws
 * archived cards leaves the card there, dimmed and badged, so flipping the flag is
 * the truthful patch and dropping it would hide a card that is still shown. Every
 * other pairing — an archive on the default lens, a removal on any lens — really
 * does take the card out. Cancel comes FIRST, for the reason
 * {@link invalidateProjectBoards} states: a read already in flight would otherwise
 * resolve over the patch and put the card back.
 *
 * The rollback undoes each lens the way it was patched, onto the CURRENT cache.
 * Never a snapshot of the tree: that would revert a concurrent write to a sibling
 * card and drop a `Load more` page that landed mid-flight.
 *
 * The write TARGET rides the call-time variables, never this hook's scope — the rule
 * {@link useMoveBoardCard} states, and the reason `onSettled` reads `args` rather
 * than the context, which a mutation that never reached `onMutate` would leave
 * undefined.
 */
function useBoardItemRemoval(
  kind: Extract<BoardWriteKind, "archive" | "remove">,
  call: (args: BoardItemRemoval) => Promise<void>,
  /** Whether this write changes WHICH boards the item is on. An archive doesn't —
   *  the item stays on the project, restorable in place. */
  membership: boolean,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: boardWriteKey(kind),
    mutationFn: call,
    onMutate: async (args: BoardItemRemoval) => {
      const queryKey = projectItemsFamilyKey(args.repo, args.projectId);
      await queryClient.cancelQueries({ queryKey });
      const undo: BoardItemUndo[] = [];
      for (const [key, data] of queryClient.getQueriesData<
        InfiniteData<BoardItems, string | null>
      >({ queryKey })) {
        const at = findBoardItem(data, args.itemId);
        // An archive on a lens that DRAWS archived cards leaves the card exactly
        // where it is, dimmed and badged, and moves no count: that lens counted it
        // under either state. Nothing loaded means nothing to flip.
        if (kind === "archive" && keyShowsArchived(key)) {
          if (at === null) continue;
          undo.push({ mode: "archive", key });
          queryClient.setQueryData<InfiniteData<BoardItems, string | null>>(
            key,
            (cur) => patchBoardItemArchived(cur, args.itemId, true),
          );
          continue;
        }
        // Everywhere else the card leaves this lens's ITEMS where they hold it, and
        // its COUNT where the figure provably held it. The count arm is key-driven,
        // so it also fires for a card past the loaded pages. An unfiltered LIVE-only
        // count holds live cards only, so removing an already-archived one takes
        // nothing more from it; an unfiltered INCLUSIVE count holds every member
        // whatever its state. The archive arm reduces to the key test — it reaches
        // here only on live-only keys and only ever fires on a live card — spelled
        // out rather than left to the branch above.
        const counted =
          keyIsUnfiltered(key) &&
          (kind === "archive"
            ? !keyShowsArchived(key)
            : keyShowsArchived(key) || !args.wasArchived);
        if (at === null && !counted) continue;
        undo.push({ mode: "drop", key, at, counted });
        queryClient.setQueryData<InfiniteData<BoardItems, string | null>>(
          key,
          (cur) =>
            withBoardCount(dropBoardItem(cur, args.itemId), counted ? -1 : 0),
        );
      }
      return { undo };
    },
    // Reporting and rollback live here, not in the caller's `mutate` options: the
    // menu that fires this closes as it does, and react-query drops mutate-scoped
    // callbacks once the observer loses its listeners.
    onError: (e, args, ctx) => {
      for (const entry of ctx?.undo ?? []) {
        if (entry.mode === "archive") {
          queryClient.setQueryData<InfiniteData<BoardItems, string | null>>(
            entry.key,
            (cur) => patchBoardItemArchived(cur, args.itemId, false),
          );
          continue;
        }
        // Symmetric with the drop above, arm for arm: the card goes back where it
        // sat when this lens held it, and the count goes back exactly where the
        // drop took one. A count-only drop has no slot to restore and undoes as the
        // count alone.
        const { at, counted } = entry;
        queryClient.setQueryData<InfiniteData<BoardItems, string | null>>(
          entry.key,
          (cur) =>
            withBoardCount(
              at === null ? cur : restoreBoardItem(cur, at),
              counted ? 1 : 0,
            ),
        );
      }
      toastError(e);
    },
    // ACCEPTED EDGE: this refetch can land inside GitHub's replica lag (~6s,
    // measured 2026-09-21) and answer with the pre-write card, then stamp it fresh
    // for the staleTime. {@link useRestoreBoardItem}'s fresh-patch defence does not
    // extend here because of the FILTERED lenses: the loop above corrects their
    // items but never their `totalCount`, which no cache can decide, so this read is
    // the only thing that reconciles those figures — going fresh-patch would trade a
    // transient wrong state for a durable wrong number.
    onSettled: (_d, _e, args) => {
      invalidateProjectBoards(queryClient, args.repo);
      if (membership) invalidateItemMemberships(queryClient, args.repo);
    },
  });
}

/** Archives one card. Board-only: the item stays on the project, restorable from
 *  the board itself, so no membership family is touched. */
export function useArchiveBoardItem() {
  return useBoardItemRemoval(
    "archive",
    (args) =>
      trackBoardWrite(args.repo, () =>
        api.ghArchiveBoardItem(args.repo, args.projectId, args.itemId),
      ),
    false,
  );
}

/**
 * Puts an archived card back on the board — {@link useArchiveBoardItem}'s reversal,
 * and membership-neutral in the same way, so no membership family is touched here
 * either.
 *
 * The optimistic flip lands on the lenses that draw the card; only archived-showing
 * ones do. The settle REJOINS it to every populated lens: a flip where the lens holds
 * it, and on a live-only lens that lacks it, an insert at the end of the loaded
 * pages, moving `totalCount` on the unfiltered live-only key alone
 * ({@link keyIsUnfiltered}). An archived-showing lens that lacks it holds it
 * UNLOADED, so it takes the flip alone.
 *
 * It settles through {@link writeThroughBoards} rather than
 * {@link invalidateProjectBoards} because the payload is transactionally fresh where
 * a read is not: GitHub's single-state reads lag this write in both directions (~6s,
 * measured 2026-09-21), so a refetch here can answer with the card still archived or
 * gone and stamp that fresh for the 60s staleTime. FILTERED lenses are marked anyway,
 * the payload saying nothing about whether a view keeps the card, and marks an
 * earlier write laid are captured at `onMutate` — the flip clears `isInvalidated`, so
 * a settle-time probe would find the debt already gone.
 *
 * A FAILED write re-reads as usual — its rollback is a guess at what the board had
 * rather than a reading of what it has.
 */
export function useRestoreBoardItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: boardWriteKey("restore"),
    mutationFn: (args: BoardItemWrite) =>
      trackBoardWrite(args.repo, () =>
        api.ghUnarchiveBoardItem(args.repo, args.projectId, args.itemId),
      ),
    onMutate: async (args) => {
      const queryKey = projectItemsFamilyKey(args.repo, args.projectId);
      await queryClient.cancelQueries({ queryKey });
      const flipped: QueryKey[] = [];
      // Debts an EARLIER write left, captured HERE rather than at the settle: the flip
      // below is a `setQueryData` and clears `isInvalidated` on every lens it touches,
      // so by settle time a mark this write never owned has already vanished. Read per
      // key before that key's own write, which is the last moment it is still true.
      const owed: QueryKey[] = [];
      // The card as it will read once this lands, kept for the settle: the LIVE-ONLY
      // lenses are the ones that will need it inserted, and by then the only copy of
      // it left in this repo may be the one taken here. Off the first lens that draws
      // it: every lens holds the same membership, and a staler snapshot reconciles on
      // the board's next natural read like anything else.
      let restored: BoardItem | undefined;
      for (const [key, data] of queryClient.getQueriesData<
        InfiniteData<BoardItems, string | null>
      >({ queryKey })) {
        if (queryClient.getQueryState(key)?.isInvalidated === true)
          owed.push(key);
        const at = findBoardItem(data, args.itemId);
        if (at === null) continue;
        restored ??= { ...at.item, isArchived: false };
        flipped.push(key);
        queryClient.setQueryData<InfiniteData<BoardItems, string | null>>(
          key,
          (cur) => patchBoardItemArchived(cur, args.itemId, false),
        );
      }
      return { flipped, restored, owed };
    },
    // Reporting and rollback live here for the reason {@link useBoardItemRemoval}
    // states: the menu that fires this closes as it does.
    onError: (e, args, ctx) => {
      for (const key of ctx?.flipped ?? []) {
        queryClient.setQueryData<InfiniteData<BoardItems, string | null>>(
          key,
          (cur) => patchBoardItemArchived(cur, args.itemId, true),
        );
      }
      toastError(e);
    },
    // The success arm is discriminated on the ERROR, never on the result: this write
    // answers with nothing, so an `undefined` data argument is what success looks
    // like here — unlike the write-through hooks above, which each answer with a card.
    // No card in context means no lens drew it when the write fired, so there is
    // nothing to write through and the re-read is the only honest answer.
    onSettled: (_d, e, args, ctx) => {
      const restored = ctx?.restored;
      if (e !== null || restored === undefined) {
        invalidateProjectBoards(queryClient, args.repo);
        return;
      }
      writeThroughBoards(
        queryClient,
        args.repo,
        projectItemsFamilyKey(args.repo, args.projectId),
        // PER-KEY: an archived-showing lens counted and drew the card under either
        // state, so a card missing there is unloaded rather than lost and the flip
        // alone is truthful; a live-only lens takes the insert, bumping its count
        // only where unfiltered. No card-STATE branch, unlike the removal loop: this
        // write is the unarchive, so the card was archived by construction.
        (data, key) => {
          const flipped = patchBoardItemArchived(data, args.itemId, false);
          if (keyShowsArchived(key)) return flipped;
          return appendBoardItem(flipped, restored, keyIsUnfiltered(key));
        },
        // No NEW stale mark on the keys this payload determines: one over the patch
        // would re-invalidate what it just freshened, and the next mount would
        // refetch inside the replica lag. Filtered keys are marked anyway, and the
        // debts captured at `onMutate` are re-laid — the flip there cleared them.
        false,
        ctx?.owed ?? [],
      );
    },
  });
}

/** Removes one card from the project — an unlink for an issue or pull request, a
 *  deletion for a draft. Membership-touching either way. */
export function useRemoveBoardItem() {
  return useBoardItemRemoval(
    "remove",
    (args) =>
      trackBoardWrite(args.repo, () =>
        api.ghRemoveBoardItem(args.repo, args.projectId, args.itemId),
      ),
    true,
  );
}

/** Adds one existing issue or pull request to a board and draws the card it became.
 *  `contentId` is the search result's CONTENT node id — a board item id addresses
 *  nothing here. Through the board's own single-item add rather than the issue
 *  picker's batched edit, because only the single-item command answers with the
 *  membership it minted. */
export function useAddExistingToBoard() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: boardWriteKey("add-existing"),
    mutationFn: (args: {
      repo: string;
      projectId: string;
      contentId: string;
      /** The item's number, for the board's pending strip alone — the write
       *  addresses the content id. Carried as a variable rather than looked up
       *  later because the strip reads `variables` off the in-flight mutation, and
       *  the search result it came from lives in a dialog that may be closed by
       *  then. (The same display-only shape {@link useSetIssueMilestone}'s `title`
       *  keeps.) */
      number: number;
    }) =>
      trackBoardWrite(args.repo, () =>
        api.ghAddBoardItem(args.repo, args.projectId, args.contentId),
      ),
    onError: toastError,
    onSettled: (item, _e, args) => {
      if (item === undefined) invalidateProjectBoards(queryClient, args.repo);
      else
        writeThroughBoards(
          queryClient,
          args.repo,
          projectItemsFamilyKey(args.repo, args.projectId),
          (data) => appendBoardItem(data, item),
        );
      invalidateItemMemberships(queryClient, args.repo);
    },
  });
}

/**
 * Rewrites one draft's title, notes and assignees, and patches the card with what
 * GitHub answered.
 *
 * `draftId` is the DRAFT's own content id, which is the id the write addresses;
 * `itemId` rides alongside for the board's own use — the card the patch lands on,
 * the card the panel marks busy, and the write's line in the pending strip — the
 * same display-only shape {@link useAddExistingToBoard}'s `number` keeps.
 *
 * `assigneeLogins` is tri-state, the contract {@link api.ghUpdateDraftItem} states: a
 * list replaces the set, `[]` clears it, and `undefined` leaves it alone. Callers send
 * `undefined` unless the user actually changed the picker, because the seed those
 * logins came from is a CAPPED read — replacing a set with its own truncated seed is
 * how a title-only edit would delete the assignees past the cap. Logins throughout,
 * which is what the assignable-users surface carries as its ids on GitHub.
 *
 * Reporting is the hook's, never the caller's `mutate` options: the dialog that
 * fires this can be closed over the write, and react-query drops mutate-scoped
 * callbacks once the observer loses its listeners.
 */
export function useUpdateDraftItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: boardWriteKey("edit-draft"),
    mutationFn: (args: {
      repo: string;
      /** The membership's item id — display and patch target, not the write's. */
      itemId: string;
      /** The DRAFT's content id (`DI_…`), which is what the write addresses. */
      draftId: string;
      title: string;
      /** Markdown, sent VERBATIM — the card's popover renders it as such. */
      body: string;
      /** The replacing set, `[]` to clear it, or `undefined` to leave it untouched. */
      assigneeLogins: string[] | undefined;
    }) =>
      trackBoardWrite(args.repo, () =>
        api.ghUpdateDraftItem(
          args.repo,
          args.draftId,
          args.title,
          args.body,
          args.assigneeLogins,
        ),
      ),
    onError: toastError,
    onSettled: (content, _e, args) => {
      // A failed write, or an answer that isn't a draft arm at all, falls back to
      // the re-read: only a draft's content may be patched onto a draft card, and a
      // rejection is not proof the board is unchanged.
      if (content === undefined || content.kind !== "draft") {
        invalidateProjectBoards(queryClient, args.repo);
        return;
      }
      // Repo-wide as the patch scope for {@link useConvertDraftItem}'s reason: the
      // write carries no project id, and an item id no other board holds makes the
      // wider scope a no-op everywhere else.
      writeThroughBoards(
        queryClient,
        args.repo,
        projectItemsRepoKey(args.repo),
        (data) => patchDraftContent(data, args.itemId, content),
      );
    },
  });
}

/** Adds a freshly created issue to boards, by number. No `onError` on purpose: the
 *  create dialog composes its own disclosure ("Created issue #N, but …"), and a
 *  toast here would report the same failure twice. */
export function useAddIssueToProjects() {
  const queryClient = useQueryClient();
  return useMutation({
    // Tagged into the board-write family even though no board fired it: this
    // settles through `invalidateProjectBoards`, whose cancel matches the board's
    // items key, so a Load more started during the round trip would be
    // cancel-reverted. The board can only wait on what it can see.
    mutationKey: boardWriteKey("add-issue-projects"),
    mutationFn: (args: {
      repo: string;
      number: number;
      addProjectIds: string[];
      lens: RemoteLens;
    }) =>
      trackBoardWrite(args.repo, () =>
        api.ghAddIssueToProjects(
          args.repo,
          args.number,
          args.addProjectIds,
          args.lens,
        ),
      ),
    onSettled: (_d, _e, args) => {
      invalidateProjectBoards(queryClient, args.repo);
      invalidateItemMemberships(queryClient, args.repo);
    },
  });
}

/**
 * The field editor's batched per-board write, with an optimistic patch of that
 * board's entry in the item-field-values cache. `values` is the patch itself: the
 * wire `updates` carry ids alone, so only the editor — which holds the board's
 * definitions — can say what those ids render as.
 */
export function useSetItemFieldValues(
  repo: string,
  kind: "issue" | "pr",
  number: number,
  lens: RemoteLens,
) {
  const queryClient = useQueryClient();
  const fieldsKey = itemFieldValuesKey(repo, lens, kind, number);
  return useMutation({
    mutationFn: (args: {
      projectId: string;
      /** The membership's item id on `projectId` — what the write addresses. */
      itemId: string;
      updates: ProjectFieldValueUpdate[];
      /** Field ids to UNSET; no update shape expresses a clear. */
      clears: string[];
      /** That board's values as they'll read once this lands. */
      values: ProjectFieldValue[];
      /** Boards queued behind this one. The editor writes board by board and stops
       *  at the first failure, so a failure here names what that stop left undone. */
      unwritten: number;
    }) =>
      api.ghSetItemFieldValues(
        repo,
        args.projectId,
        args.itemId,
        args.updates,
        args.clears,
      ),
    onMutate: async (args) => {
      await queryClient.cancelQueries({ queryKey: fieldsKey });
      const prev = queryClient.getQueryData<ItemFieldValues>(fieldsKey);
      if (prev) {
        // `items` alone is patched, as the memberships patch does: `truncated`
        // is the read's claim about the cap on this item's boards, which a field
        // write doesn't move.
        queryClient.setQueryData<ItemFieldValues>(fieldsKey, (current) =>
          current === undefined
            ? current
            : {
                ...current,
                items: current.items.map((entry) =>
                  entry.project.id === args.projectId
                    ? { ...entry, values: args.values }
                    : entry,
                ),
              },
        );
      }
      return { prev };
    },
    // Reporting lives here, not in the caller's `mutate` options: the popover that
    // fires this closes as it does, and react-query drops mutate-scoped callbacks
    // once the observer loses its listeners. The caller still sees the rejection
    // through `mutateAsync`, which is what stops its per-board chain.
    onError: (e, args, ctx) => {
      if (ctx?.prev)
        queryClient.setQueryData<ItemFieldValues>(fieldsKey, ctx.prev);
      if (args.unwritten === 0) {
        toastError(e);
        return;
      }
      toastErrorWithNote(
        e,
        args.unwritten === 1
          ? "One more board's changes were left unwritten."
          : `${args.unwritten} more boards' changes were left unwritten.`,
      );
    },
    // Cancel-before-invalidate, and RETURNED so `isPending` spans the refetch —
    // both for the reasons {@link useEditItemProjects}'s `onSettled` states.
    // Only the chain's LAST settle refetches: every board writes the same query and
    // the caller awaits each, so invalidating per board would pay a full read
    // between writes for a result the next write supersedes. An ERROR is also a
    // last settle — the caller stops there, so this is the only chance to reconcile
    // the boards already written. The cancel stays unconditional (an in-flight read
    // still holds pre-write values), and `isPending` spans the chain either way.
    onSettled: (_d, e, args) =>
      queryClient.cancelQueries({ queryKey: fieldsKey }).then(() => {
        if (args.unwritten !== 0 && e === null) return undefined;
        // The Projects BOARD reads these same values through its own query, so a
        // field write has to reach it as well as the rail — it rides the same
        // last-settle condition, for the same reason.
        invalidateProjectBoards(queryClient, repo);
        return queryClient.invalidateQueries({ queryKey: fieldsKey });
      }),
  });
}
