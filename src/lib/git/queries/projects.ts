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
  ProjectV2Ref,
  RemoteLens,
} from "../types";
import {
  applyBoardOrder,
  boardAnchorId,
  boardPredecessorId,
  reorderBoardItem,
} from "./board-order";
import { keepPreviousDataForKeyAxes } from "./core";
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

const projectItemsKey = (
  repo: string,
  projectId: string,
  query: string | null,
) => [...projectItemsFamilyKey(repo, projectId), query] as const;

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
 */
function writeThroughBoards(
  queryClient: QueryClient,
  repo: string,
  patchKey: QueryKey,
  patch: (
    data: InfiniteData<BoardItems, string | null> | undefined,
  ) => InfiniteData<BoardItems, string | null> | undefined,
): void {
  void queryClient.cancelQueries({ queryKey: patchKey }).then(() => {
    for (const [key] of queryClient.getQueriesData<
      InfiniteData<BoardItems, string | null>
    >({ queryKey: patchKey }))
      queryClient.setQueryData<InfiniteData<BoardItems, string | null>>(
        key,
        patch,
      );
    markProjectBoardsStale(queryClient, repo);
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

/** One board's items under one LENS, paged. Keyed on the board and the saved
 *  view's filter — a board is the same object whichever remote reached it, but a
 *  filtered read is a different set of items — and `retry: false` for the same
 *  reason the rest of the Projects family uses it: the common failure is a
 *  missing `project` scope, which no retry fixes. The backend auto-pages, so a
 *  page here is up to 500 items and `truncated` drives "Load more" rather than an
 *  automatic walk to the end of a 5,000-item board.
 *
 *  `query` rides to the server verbatim; null is the unfiltered board. Switching
 *  lenses keeps the previous one's cards on screen (the axes below), so callers
 *  gate every claim they DERIVE from the data — a count, a page control — on
 *  `!isPlaceholderData`. */
export function useProjectItems(
  repo: string,
  projectId: string,
  query: string | null,
  enabled: boolean,
) {
  return useInfiniteQuery({
    queryKey: projectItemsKey(repo, projectId, query),
    queryFn: ({ pageParam }) =>
      api.ghProjectItems(repo, projectId, pageParam, query),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.truncated ? last.endCursor : null),
    enabled,
    staleTime: 60_000,
    retry: false,
    // The board is an axis (index 3 in the key literal above); the LENS at index
    // 4 deliberately is not. Switching views keeps the previous lens's cards on
    // screen while the filtered read lands, where switching BOARDS must never
    // show the other board's.
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

/** The board field a move writes: the single-select arm alone, since only that
 *  kind makes columns. */
type BoardGroupField = Extract<ProjectFieldDef, { kind: "singleSelect" }>;

/** The moved item's field values with `field` set to `option`, or dropped when
 *  `option` is null — the clear. Replaced IN PLACE where an entry already exists
 *  so the rail's line order survives a move. */
function withGroupValue(
  values: ProjectFieldValue[],
  field: BoardGroupField,
  option: ProjectFieldOptionDef | null,
): ProjectFieldValue[] {
  const next: ProjectFieldValue | null =
    option === null
      ? null
      : {
          kind: "singleSelect",
          fieldId: field.id,
          fieldName: field.name,
          optionId: option.id,
          name: option.name,
          color: option.color,
          isIssueField: field.isIssueField,
        };
  const held = values.some(
    (value) => value.kind === "singleSelect" && value.fieldId === field.id,
  );
  if (!held) return next === null ? values : [...values, next];
  return values.flatMap((value) => {
    if (value.kind !== "singleSelect" || value.fieldId !== field.id)
      return [value];
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

/** One new item appended to the LAST loaded page, which is where the board itself
 *  puts it: the pages are in the board's own position order, and a fresh item lands
 *  at the end of it. Never twice — a refetch that already carried the card wins, and
 *  a second copy would be a card the menu and the move path can both target.
 *
 *  `totalCount` moves with the insert, unlike {@link dropBoardItem}'s deliberate
 *  refusal to touch it: the figure counts ARCHIVED items too, so an archive really
 *  doesn't change it where an add really does. A cache with no pages is left alone —
 *  there is no board drawn to append to. */
function appendBoardItem(
  data: InfiniteData<BoardItems, string | null> | undefined,
  item: BoardItem,
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
            totalCount: page.totalCount + 1,
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
 *  removal has to remember to be able to put it back exactly where it was. The
 *  `key` is the LENS this record belongs to: one removal patches every cached lens
 *  of the board, and each needs its own place. */
interface RemovedBoardItem {
  key: QueryKey;
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
 *  the other kind of write. `totalCount` is deliberately untouched: it is the
 *  board's own figure and COUNTS ARCHIVED ITEMS, so an archive must not move it and
 *  a removal's correction rides the settle refetch rather than a guess made here. */
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
      /** The column's option, or null for the board's "No {field}" column. */
      option: ProjectFieldOptionDef | null;
      /** The lens the board was showing when the move was fired — the cache this
       *  write patches and rolls back. Switching views mid-flight is safe because
       *  `onMutate` pins the key into the context the settle handlers read, not
       *  because anything cancels the write. */
      query: string | null;
    }) =>
      trackBoardWrite(args.repo, () =>
        api.ghSetItemFieldValues(
          args.repo,
          args.projectId,
          args.itemId,
          args.option === null
            ? []
            : [
                {
                  kind: "singleSelect",
                  fieldId: args.field.id,
                  optionId: args.option.id,
                },
              ],
          args.option === null ? [args.field.id] : [],
        ),
      ),
    onMutate: async (args) => {
      // Derived from the variables, like every other target here: `onMutate` runs
      // before the pause so its own scope is safe, but one source of truth for
      // WHERE the write lands is what keeps the settle handlers honest.
      const key = projectItemsKey(args.repo, args.projectId, args.query);
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
              withGroupValue(before, args.field, args.option),
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
 * each one chases: repo, board, lens and card together. Module scope for the reason
 * {@link pendingBoardWrites} is — the serializer has to hold across renders and
 * across the hook instance.
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
  itemId: string;
}) => JSON.stringify([args.repo, args.projectId, args.query, args.itemId]);

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
        const key = projectItemsKey(args.repo, args.projectId, args.query);
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
      const key = projectItemsKey(args.repo, args.projectId, args.query);
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
        queryKey: ["repo", args.repo, "issue-list", args.lens],
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

/**
 * The shared shape of the two writes that take a card OFF the board, with an
 * optimistic removal of it. The card vanishing is the feedback: the round trip runs
 * seconds, and a board that sits unchanged that long reads as a click gone nowhere.
 *
 * Every cached LENS of the board is patched, not just the one on screen — a view
 * switched away from holds its own pages of the same item set, and the user can
 * switch back before the settle refetch lands. Cancel comes FIRST, for the reason
 * {@link invalidateProjectBoards} states: a read already in flight would otherwise
 * resolve over the patch and put the card back.
 *
 * The rollback re-inserts exactly what was taken, at the page and slot it left, onto
 * the CURRENT cache. Never a snapshot of the tree: that would revert a concurrent
 * write to a sibling card and drop a `Load more` page that landed mid-flight.
 *
 * The write TARGET rides the call-time variables, never this hook's scope — the rule
 * {@link useMoveBoardCard} states, and the reason `onSettled` reads `args` rather
 * than the context, which a mutation that never reached `onMutate` would leave
 * undefined.
 */
function useBoardItemRemoval(
  kind: Extract<BoardWriteKind, "archive" | "remove">,
  call: (args: BoardItemWrite) => Promise<void>,
  /** Whether this write changes WHICH boards the item is on. An archive doesn't —
   *  the item stays on the project, restorable from its archived items. */
  membership: boolean,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: boardWriteKey(kind),
    mutationFn: call,
    onMutate: async (args: BoardItemWrite) => {
      const queryKey = projectItemsFamilyKey(args.repo, args.projectId);
      await queryClient.cancelQueries({ queryKey });
      const removed: RemovedBoardItem[] = [];
      for (const [key, data] of queryClient.getQueriesData<
        InfiniteData<BoardItems, string | null>
      >({ queryKey })) {
        const at = findBoardItem(data, args.itemId);
        if (at === null) continue;
        removed.push({ key, ...at });
        queryClient.setQueryData<InfiniteData<BoardItems, string | null>>(
          key,
          (cur) => dropBoardItem(cur, args.itemId),
        );
      }
      return { removed };
    },
    // Reporting and rollback live here, not in the caller's `mutate` options: the
    // menu that fires this closes as it does, and react-query drops mutate-scoped
    // callbacks once the observer loses its listeners.
    onError: (e, _args, ctx) => {
      for (const at of ctx?.removed ?? []) {
        queryClient.setQueryData<InfiniteData<BoardItems, string | null>>(
          at.key,
          (cur) => restoreBoardItem(cur, at),
        );
      }
      toastError(e);
    },
    onSettled: (_d, _e, args) => {
      invalidateProjectBoards(queryClient, args.repo);
      if (membership) invalidateItemMemberships(queryClient, args.repo);
    },
  });
}

/** Archives one card. Board-only: the item stays on the project (restorable from
 *  its archived items on GitHub), so no membership family is touched. */
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
