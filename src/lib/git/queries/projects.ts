import {
  hashKey,
  type InfiniteData,
  notifyManager,
  type Query,
  type QueryClient,
  type QueryKey,
  replaceEqualDeep,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useRef, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { presentError } from "@/lib/error-summary";
import { errorToastAction, toastError, toastErrorWithNote } from "@/lib/toast";
import * as api from "../api";
import type {
  AssigneeRef,
  AvailableProjects,
  BoardItem,
  BoardItemContent,
  BoardItems,
  BoardOrder,
  BulkItemOutcomes,
  DuplicateViewSource,
  ItemFieldValues,
  ItemProjects,
  ProjectFieldDef,
  ProjectFieldOptionDef,
  ProjectFieldValue,
  ProjectFieldValueUpdate,
  ProjectItemRemove,
  ProjectIterationDef,
  ProjectPatch,
  ProjectStatusContent,
  ProjectStatusUpdate,
  ProjectStatusUpdates,
  ProjectStatusValue,
  ProjectV2Ref,
  ProjectViewDef,
  ProjectViewLayout,
  ProjectViewPatch,
  ProjectViews,
  RemoteLens,
} from "../types";
import {
  applyBoardOrder,
  type BoardItemUndo,
  boardAnchorId,
  boardPredecessorId,
  captureRemovedCard,
  insertBoardCardAfter,
  reorderBoardItem,
  resolveUndoAnchor,
} from "./board-order";
import { keepPreviousDataForKeyAxes, repoKeys } from "./core";
import {
  boardReadFailed,
  boardReadOwed,
  boardRereadsRunning,
  invalidateProjectBoards,
  pendingBoardWrites,
  projectItemsRepoKey,
  subscribeBoardRereads,
} from "./internal";
import {
  dropStatusUpdate,
  insertNewestFirst,
  mayPatchStatusCache,
  prependStatusUpdate,
  replaceStatusUpdate,
} from "./project-status-cache";

/** Every lens's project catalog in one repo — the prefix
 *  {@link projectsAvailableKey} extends, which a project write's settle re-reads. */
const projectsAvailableFamilyKey = (repo: string) =>
  ["repo", repo, "projects-available"] as const;

const projectsAvailableKey = (repo: string, lens: RemoteLens) =>
  [...projectsAvailableFamilyKey(repo), lens] as const;

/** The GitHub Projects (v2) boards an item could join — repo-level plus the
 *  owner's. `retry: false` because the common failure is a missing `project`
 *  token scope, which no retry can fix; the picker renders the hint instead. */
export function useAvailableProjects(
  repo: string,
  enabled: boolean,
  lens: RemoteLens,
) {
  return useQuery({
    queryKey: projectsAvailableKey(repo, lens),
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
 *  that patches every cached lens reaches both states without knowing about them.
 *
 *  `rich` is an identity axis too, for a different reason: the rich read carries
 *  the connection-valued fields the lean one omits, so the two answers are not
 *  interchangeable caches of one read. Past the board like the other two, so every
 *  family walk reaches both richnesses; the positional readers below address the
 *  query and archived axes by INDEX, so a trailing axis can't shift them. */
const projectItemsKey = (
  repo: string,
  projectId: string,
  query: string | null,
  archived: boolean,
  rich: boolean,
) =>
  [...projectItemsFamilyKey(repo, projectId), query, archived, rich] as const;

/** Where {@link projectItemsKey} puts the query and archived axes: right after the
 *  four-element family prefix. */
const QUERY_AXIS = 4;
const ARCHIVED_AXIS = 5;
const RICH_AXIS = 6;

/** Whether a cached board key is the RICH read, whose items carry the
 *  connection-valued fields a lean one omits. */
function keyIsRich(key: QueryKey): boolean {
  return key[RICH_AXIS] === true;
}

/** Whether a cached board key is the archived-INCLUSIVE lens. Read off the key
 *  rather than passed in: one write patches every cached lens of a board at once,
 *  and what the right patch IS differs between a lens that draws archived cards and
 *  one that doesn't. */
function keyShowsArchived(key: QueryKey): boolean {
  return key[ARCHIVED_AXIS] === true;
}

/**
 * Whether a cached board key is the UNFILTERED read — the `query` axis of
 * {@link projectItemsKey}.
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
  return key[QUERY_AXIS] === null;
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

/** One project's status updates. Repo + project and no account axis, the family
 *  contract {@link projectItemsKey} states. A family of its OWN: status updates
 *  are independent of item state, so no board write touches this key, and the
 *  status writes below touch nothing else. */
const projectStatusUpdatesKey = (repo: string, projectId: string) =>
  ["repo", repo, "project-status-updates", projectId] as const;

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
  /** The four BATCH verbs, one per single-card sibling above. Apart from those
   *  kinds rather than folded into them because the panel's gates, labels and
   *  write indicator all have to tell "this one card" from "the selection" — and
   *  because a bulk write's variables carry a LIST where the single-card ones
   *  carry an `itemId`. */
  | "bulk-move"
  | "bulk-archive"
  | "bulk-restore"
  | "bulk-remove"
  /** One set of field values written across a selection. Apart from `bulk-move`,
   *  which is the same command over ONE field: this one can change several at
   *  once, including the grouping field, so nothing about the board's shape
   *  afterwards is locally derivable. */
  | "bulk-fields"
  /** One card's dates moved from the roadmap's keyboard: its date or iteration
   *  fields rewritten in one write, coalescing a held key's repeats. */
  | "shift-dates"
  /** Fired from the create-issue dialog rather than the board, and it draws no
   *  card of its own — but its settle invalidates the same board reads, so the
   *  board's pagination has to wait on it like any other write here. */
  | "add-issue-projects";

/**
 * The key every board write is tagged with: `["board-write", kind]`. It says WHAT a
 * write is and nothing else — the card/add/bulk split the panel's gates need is a
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

/** One pending board write, flattened for the panel's holds, write indicator and
 *  busy card. The two value fields are display-only reads off the write's own
 *  variables, and absent on the kinds that don't carry them. */
export interface PendingBoardWrite {
  mutationId: number;
  kind: BoardWriteKind | null;
  /** The card a write is rewriting in place — a convert, or a draft edit. Null on
   *  every BULK kind: those address a list, and a single id would name one
   *  arbitrary member of it. {@link count} is what they carry instead. */
  itemId: string | null;
  /** The issue/PR number an add-existing is putting on the board. */
  number: number | null;
  /** How many cards a BULK write addresses, or null on the single-card kinds.
   *  Keeping both fields on one total shape is what lets a consumer answer for
   *  every kind without knowing which family it is looking at. */
  count: number | null;
}

/** Every board write's variables carry the repo it addresses; the rest are per-kind
 *  and read only for labels. Untrusted at this boundary in the sense that the
 *  filter sees `Mutation<any>`, so each field is `typeof`-guarded rather than
 *  asserted. The two BULK list spellings are read here rather than at the call
 *  site for the same reason: one place decides what a write's variables mean. */
function boardWriteVars(mutation: { state: { variables?: unknown } }): {
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

/**
 * Every board write against `repo` that is currently in flight, one entry per
 * INVOCATION — the observer-independent reading the panel's gates and write
 * indicator need.
 *
 * `getSnapshot` COMPUTES from the cache rather than returning a value some
 * subscription last wrote, which is the whole point of doing this by hand instead of
 * through `useMutationState`. That hook keeps its result in a ref refreshed ONLY
 * inside its cache subscription, so any window without a live subscription is a
 * blind spot it never reconciles: this panel lives under `<Activity>`, which tears
 * passive effects down on hide, and a write settling while the tab is away notifies
 * nobody. On show, re-subscribing re-reads the same untouched ref, React sees no
 * change, and the pre-hide list latches — holds and indicator lines for writes
 * that finished minutes ago. `useMutationState` has the same blind spot for
 * `repo`, which reaches its filters through an options ref updated after render.
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
            count: vars.count,
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
 *
 * The `finally` is also every board write's SETTLE for the recovery scheduler: it
 * re-bases an armed re-read unconditionally, succeeded or failed, since either may
 * have committed server-side and opened a fresh replica window.
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
    rebaseOwedReread(repo);
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
    // A lens OWED a re-read that this write's cancel left with nothing running
    // (a reposition landing during a cell save's refresh) would otherwise wait for
    // an unrelated focus or staleTime read. Lenses that owe nothing keep the
    // no-refetch settle.
    if (
      queryClient
        .getQueryCache()
        .findAll({ queryKey: projectItemsRepoKey(repo), type: "active" })
        .some(owedIdle)
    )
      scheduleOwedReread(queryClient, repo);
  });
}

/** An owed lens with no read running. */
const owedIdle = (query: Query) =>
  boardReadOwed(query.queryHash) && query.state.fetchStatus === "idle";

/** The one armed recovery re-read per repo, so settles can't pile timers up.
 *  `full` is sticky across re-arms: once any settle has asked for a whole re-read,
 *  the timer that finally fires performs one. */
const owedRereadTimers = new Map<
  string,
  {
    timer: ReturnType<typeof setTimeout>;
    full: boolean;
    queryClient: QueryClient;
  }
>();

/**
 * The file's ONE recovery scheduler. Re-reads a repo's boards once they are
 * QUIET, past the replica window of the LATEST write that settled — so the read
 * can't bring back an order a reposition just wrote. Each call re-arms (never
 * stacks) the one timer, so it always counts from the latest settle — and while a
 * timer is armed, EVERY board write's settle re-bases it ({@link rebaseOwedReread}),
 * including a write that owes nothing and so would never arm one. At FIRE time
 * a write still pending or a reposition still chasing its cache defers it again: a
 * read landing then would overwrite that write's optimistic patch, and a chase
 * would write the clobbered order back to GitHub.
 *
 * Two strengths. By default it refetches the OWED lenses with no read running (a
 * cancel left them idle). `full` re-reads every board through
 * {@link invalidateProjectBoards} — for a failed reposition, whose immediate
 * re-read may have landed inside the replica window and CLEARED those lenses' debt
 * with pre-write data, so owed-only would find nothing left to read.
 */
function scheduleOwedReread(
  queryClient: QueryClient,
  repo: string,
  full = false,
): void {
  const armed = owedRereadTimers.get(repo);
  if (armed !== undefined) clearTimeout(armed.timer);
  const wantFull = full || (armed?.full ?? false);
  owedRereadTimers.set(repo, {
    full: wantFull,
    queryClient,
    timer: setTimeout(() => {
      owedRereadTimers.delete(repo);
      const busy =
        (pendingBoardWrites.get(repo) ?? 0) > 0 ||
        [...reorderingBoards.keys()].some(
          (key) => (JSON.parse(key) as unknown[])[0] === repo,
        );
      if (busy) {
        scheduleOwedReread(queryClient, repo, wantFull);
        return;
      }
      if (wantFull) {
        invalidateProjectBoards(queryClient, repo);
        return;
      }
      void queryClient.refetchQueries({
        queryKey: projectItemsRepoKey(repo),
        type: "active",
        predicate: owedIdle,
      });
    }, REPLICA_LAG_MS),
  });
}

/** Push an ARMED recovery re-read to a full lag margin past now, keeping its
 *  strength; arms nothing. A write settling inside the window of an older deadline
 *  isn't pending at fire time, so only this keeps the read out of its window. */
function rebaseOwedReread(repo: string): void {
  const armed = owedRereadTimers.get(repo);
  if (armed !== undefined)
    scheduleOwedReread(armed.queryClient, repo, armed.full);
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
  /** Read the connection-valued fields too — for a surface that draws them. */
  rich: boolean,
) {
  return useInfiniteQuery({
    queryKey: projectItemsKey(repo, projectId, query, includeArchived, rich),
    queryFn: ({ pageParam }) =>
      api.ghProjectItems(
        repo,
        projectId,
        pageParam,
        query,
        includeArchived,
        rich,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.truncated ? last.endCursor : null),
    enabled,
    staleTime: 60_000,
    retry: false,
    // The board is a placeholder axis (index 3 in the key literal above); the filter
    // at index 4, the archived state at index 5 and the richness at index 6
    // deliberately are not. Switching views, showing archived cards, or moving
    // between a board and a table keeps the previous read's cards on screen while
    // the new one lands, where switching BOARDS must never show another's.
    placeholderData: keepPreviousDataForKeyAxes(repo, [[3, projectId]]),
  });
}

/**
 * Whether a board re-read that a WRITE asked for is still running on this repo —
 * the tail between a write settling and the board repainting with what GitHub now
 * holds. Counted at the one place a write asks for a re-read
 * ({@link invalidateProjectBoards}), not off query state: `isInvalidated` is also
 * set by the app's window-focus invalidation, so a mere focus would read as a
 * write's tail. A write that settles through its own payload (a reposition, a
 * restore) asks for no re-read and so has no tail.
 */
export function useBoardRereading(repo: string): boolean {
  return useSyncExternalStore(
    subscribeBoardRereads,
    () => boardRereadsRunning(repo),
    () => boardRereadsRunning(repo),
  );
}

/** Where THIS lens's last write-asked re-read stands, when it hasn't yet shown
 *  the write's result: `"owed"` not yet reconciled (reading, paused offline, or
 *  never refetched), `"failed"` settled in error. Null once a read of the lens has succeeded since. */
export function useBoardRereadStall(
  repo: string,
  projectId: string,
  query: string | null,
  includeArchived: boolean,
  rich: boolean,
): "owed" | "failed" | null {
  const hash = hashKey(
    projectItemsKey(repo, projectId, query, includeArchived, rich),
  );
  const read = () =>
    boardReadOwed(hash) ? "owed" : boardReadFailed(hash) ? "failed" : null;
  return useSyncExternalStore(subscribeBoardRereads, read, read);
}

/** A margin past how long GitHub's item reads can lag its own writes — measured
 *  at ~6s both directions (PR #384's drive), so the re-read waits 8. A re-read
 *  fired inside that window can return the pre-write order and stamp it fresh. */
const REPLICA_LAG_MS = 8_000;

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
      /** Whether that lens was the rich read — its key's last axis. */
      rich: boolean;
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
        args.rich,
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
  rich: boolean;
  itemId: string;
}) =>
  JSON.stringify([
    args.repo,
    args.projectId,
    args.query,
    args.archived,
    args.rich,
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
      /** Whether that lens was the rich read — its key's last axis. */
      rich: boolean;
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
          args.rich,
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
        args.rich,
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
        scheduleOwedReread(queryClient, ctx.repo, true);
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
          if (outcome.error !== undefined)
            scheduleOwedReread(queryClient, ctx.repo, true);
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

/** The date-shift writes between their request and their answer, each with the
 *  field ids its burst has touched and how many presses have folded into it.
 *  Keyed by the CACHE a write chases (repo, board, lens, card) for the reason
 *  {@link reorderingCards} is: a press under another lens patches a cache the
 *  live write never re-reads, so it starts its own write rather than folding in. */
const shiftingItems = new Map<
  string,
  { fieldIds: Set<string>; presses: number }
>();

/** How many FOLLOW-UP writes one shift burst may spend catching up with the
 *  card's cached dates SINCE ITS LAST PRESS before the settle's re-read takes
 *  over. A press folding in is new intent and restarts the count, so the cap
 *  bounds one convergence attempt rather than how long the user keeps tapping. */
const SHIFT_CHASE_LIMIT = 8;

/** How one date-shift burst ended — {@link ReorderOutcome}'s grammar: a folded
 *  press is reconciled by the write it joined, and an exhausted one by the
 *  settle's re-read, carrying the follow-up's error when one failed. */
type ShiftOutcome =
  | { kind: "folded" }
  | { kind: "converged" }
  | { kind: "exhausted"; error?: unknown };

/** One toast per card for its failed shifts: a held key's burst would otherwise
 *  stack one per repeat, where sonner updates this one in place. */
const shiftToastId = (itemId: string) => `board-shift-failed:${itemId}`;

function toastShiftFailure(itemId: string, e: unknown) {
  const presentation = presentError(e);
  toast.error(presentation.summary, {
    id: shiftToastId(itemId),
    duration: 8000,
    action: errorToastAction(presentation),
  });
}

/** `values` with `next` replacing each field's entry in place, or appended where
 *  the card held none — the rail's line order survives a shift. */
function withFieldEntries(
  values: ProjectFieldValue[],
  next: ProjectFieldValue[],
): ProjectFieldValue[] {
  const fieldOf = (value: ProjectFieldValue) =>
    value.kind === "unknown" ? null : value.fieldId;
  const byField = new Map(next.map((value) => [fieldOf(value), value]));
  const kept = values.map((value) => byField.get(fieldOf(value)) ?? value);
  const held = new Set(values.map(fieldOf));
  return [...kept, ...next.filter((value) => !held.has(fieldOf(value)))];
}

/** `values` with the `fieldIds` entries put back to `before` — dropped where the
 *  card held none — and every other entry left alone: a rollback restores what
 *  the patch touched and nothing more. */
function restoreFieldEntries(
  values: ProjectFieldValue[],
  fieldIds: ReadonlySet<string>,
  before: ProjectFieldValue[],
): ProjectFieldValue[] {
  const touched = (value: ProjectFieldValue) =>
    value.kind !== "unknown" && fieldIds.has(value.fieldId);
  return withFieldEntries(
    values.filter((value) => !touched(value)),
    before,
  );
}

/** The wire updates for `fieldIds` as `values` hold them now, in a stable order,
 *  plus a signature two reads compare by. Only date and iteration values: those
 *  are the only kinds a shift writes, and a shift never clears. */
function shiftUpdates(
  values: ProjectFieldValue[],
  fieldIds: ReadonlySet<string>,
): { updates: ProjectFieldValueUpdate[]; signature: string } {
  const updates: ProjectFieldValueUpdate[] = [];
  for (const value of values) {
    if (value.kind === "date" && fieldIds.has(value.fieldId))
      updates.push({ kind: "date", fieldId: value.fieldId, date: value.date });
    else if (value.kind === "iteration" && fieldIds.has(value.fieldId))
      updates.push({
        kind: "iteration",
        fieldId: value.fieldId,
        iterationId: value.iterationId,
      });
  }
  updates.sort((a, b) =>
    a.fieldId < b.fieldId ? -1 : a.fieldId > b.fieldId ? 1 : 0,
  );
  return { updates, signature: JSON.stringify(updates) };
}

/**
 * Shift one card's dates — its date fields, or its iteration — from the roadmap's
 * keyboard: ONE batch field write over the card, with an item-scoped optimistic
 * patch of the lens it was fired from.
 *
 * COALESCED like {@link useReorderBoardCard}: one write per card per lens is in
 * flight, and a press arriving meanwhile patches the cache and folds in. The live
 * write re-reads the card's dates from that cache after each round trip (a
 * CALL-TIME read, never a render closure) and writes again until the two agree,
 * so a held key converges on where the bar is drawn. The write target rides the
 * variables for the family's reason.
 *
 * The rollback is one card's touched fields wide. The settle is the field
 * writes' own ({@link useBulkSetItemFieldValues}): the boards and the rail
 * re-read, since a shifted date can move the card through a view's sort.
 */
export function useShiftItemDates() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: boardWriteKey("shift-dates"),
    mutationFn: async (args: {
      repo: string;
      projectId: string;
      /** The membership's item id on `projectId` — what the write addresses. */
      itemId: string;
      /** The date or iteration values this press lands on. */
      values: ProjectFieldValue[];
      /** The lens the roadmap was showing — the cache this write patches, rolls
       *  back, and re-reads the card's dates from. */
      query: string | null;
      archived: boolean;
      rich: boolean;
    }): Promise<ShiftOutcome> => {
      const fold = JSON.stringify([
        args.repo,
        args.projectId,
        args.query,
        args.archived,
        args.rich,
        args.itemId,
      ]);
      const pressed = args.values.flatMap((value) =>
        value.kind === "unknown" ? [] : [value.fieldId],
      );
      // The fold test and the registration below stay synchronous — no await
      // between them — so two presses can never both start a write.
      const live = shiftingItems.get(fold);
      if (live !== undefined) {
        for (const fieldId of pressed) live.fieldIds.add(fieldId);
        live.presses += 1;
        return { kind: "folded" };
      }
      const burst = { fieldIds: new Set(pressed), presses: 0 };
      const fieldIds = burst.fieldIds;
      shiftingItems.set(fold, burst);
      try {
        const key = projectItemsKey(
          args.repo,
          args.projectId,
          args.query,
          args.archived,
          args.rich,
        );
        /** What the cache says the card's dates are now; null once the lens no
         *  longer draws it, which reads as agreement — nothing left to chase. */
        const cached = () => {
          const at = findBoardItem(
            queryClient.getQueryData<InfiniteData<BoardItems, string | null>>(
              key,
            ),
            args.itemId,
          );
          return at === null
            ? null
            : shiftUpdates(at.item.fieldValues, fieldIds);
        };
        const write = async (updates: ProjectFieldValueUpdate[]) => {
          const result = await trackBoardWrite(args.repo, () =>
            api.ghSetItemsFieldValues(
              args.repo,
              args.projectId,
              [args.itemId],
              updates,
              [],
            ),
          );
          // The batch command resolves with its refusal inside it; for one card
          // that refusal IS the write failing.
          const error = result.outcomes.find(
            (outcome) => outcome.error !== null,
          )?.error;
          if (typeof error === "string") throw new Error(error);
        };
        let sent = cached() ?? shiftUpdates(args.values, fieldIds);
        await write(sent.updates);
        let rounds = 0;
        let seenPresses = burst.presses;
        for (;;) {
          const next = cached();
          if (next === null || next.signature === sent.signature)
            return { kind: "converged" };
          if (burst.presses !== seenPresses) {
            seenPresses = burst.presses;
            rounds = 0;
          }
          if (rounds >= SHIFT_CHASE_LIMIT) return { kind: "exhausted" };
          rounds += 1;
          try {
            await write(next.updates);
          } catch (e) {
            // Earlier rounds LANDED, so the onMutate snapshot is stale — recovery
            // is the settle's re-read (which also toasts this error), never the
            // onError rollback. A first-write failure (it throws) rolls back the
            // owner press's fields; the settle's re-read covers the rest.
            return { kind: "exhausted", error: e };
          }
          sent = next;
        }
      } finally {
        shiftingItems.delete(fold);
      }
    },
    onMutate: async (args) => {
      const key = projectItemsKey(
        args.repo,
        args.projectId,
        args.query,
        args.archived,
        args.rich,
      );
      await queryClient.cancelQueries({ queryKey: key });
      const fieldIds = new Set(
        args.values.flatMap((value) =>
          value.kind === "unknown" ? [] : [value.fieldId],
        ),
      );
      // The touched fields' values alone — all the rollback may carry.
      const before = findBoardItem(
        queryClient.getQueryData<InfiniteData<BoardItems, string | null>>(key),
        args.itemId,
      )?.item.fieldValues.filter(
        (value) => value.kind !== "unknown" && fieldIds.has(value.fieldId),
      );
      if (before !== undefined)
        queryClient.setQueryData<InfiniteData<BoardItems, string | null>>(
          key,
          (data) => {
            const at = findBoardItem(data, args.itemId);
            return at === null
              ? data
              : patchBoardItem(
                  data,
                  args.itemId,
                  withFieldEntries(at.item.fieldValues, args.values),
                );
          },
        );
      return { key, fieldIds, before };
    },
    // Reporting lives here for the family's reason; the per-card toast id keeps a
    // held key's failures to one toast.
    onError: (e, args, ctx) => {
      if (ctx?.before !== undefined) {
        const { key, fieldIds, before } = ctx;
        queryClient.setQueryData<InfiniteData<BoardItems, string | null>>(
          key,
          (data) => {
            const at = findBoardItem(data, args.itemId);
            return at === null
              ? data
              : patchBoardItem(
                  data,
                  args.itemId,
                  restoreFieldEntries(at.item.fieldValues, fieldIds, before),
                );
          },
        );
      }
      toastShiftFailure(args.itemId, e);
    },
    onSettled: (outcome, _e, args) => {
      // The write this folded into owns the reconciliation for both.
      if (outcome?.kind === "folded") return;
      if (outcome?.kind === "exhausted" && outcome.error !== undefined)
        toastShiftFailure(args.itemId, outcome.error);
      invalidateProjectBoards(queryClient, args.repo);
      void queryClient
        .cancelQueries({ queryKey: itemFieldValuesFamilyKey(args.repo) })
        .then(() =>
          queryClient.invalidateQueries({
            queryKey: itemFieldValuesFamilyKey(args.repo),
          }),
        );
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

/**
 * What a removal-family write does to ONE card on ONE cached lens, or null where
 * that lens neither draws nor counts it.
 *
 * The whole per-lens decision of the removal family lives here, single-sited, so
 * the single-card write and the bulk one can never drift: an ARCHIVE on a lens
 * that draws archived cards leaves the card in place under its badge, and every
 * other pairing takes it out — of the lens's items where they hold it, and of its
 * `totalCount` where the BOUNDED-COUNTS test ({@link keyIsUnfiltered}) says the
 * figure provably held it until now. An unfiltered LIVE-only count holds live
 * cards only, so removing an already-archived one takes nothing more from it; an
 * unfiltered INCLUSIVE count holds every member whatever its state. The archive
 * arm reduces to the key test — it reaches the count line only on live-only keys
 * and only ever fires on a live card — spelled out rather than left to the branch
 * above.
 *
 * Planned against `data` READ BEFORE any patch of this lens: a slot recorded off a
 * cache a sibling item's drop has already shortened would restore to the wrong
 * place.
 */
function removalPlan(
  kind: Extract<BoardWriteKind, "archive" | "remove">,
  key: QueryKey,
  data: InfiniteData<BoardItems, string | null> | undefined,
  itemId: string,
  wasArchived: boolean,
): BoardItemUndo | null {
  const at = captureRemovedCard(data, itemId);
  if (kind === "archive" && keyShowsArchived(key))
    return at === null ? null : { mode: "archive", key, itemId };
  const counted =
    keyIsUnfiltered(key) &&
    (kind === "archive"
      ? !keyShowsArchived(key)
      : keyShowsArchived(key) || !wasArchived);
  if (at === null && !counted) return null;
  return { mode: "drop", key, itemId, at, counted };
}

/** `plan` applied to one lens's cached pages — the patch half of
 *  {@link removalPlan}. Composable over several plans for one key, which is what a
 *  bulk write folds. */
function applyRemovalPlan(
  data: InfiniteData<BoardItems, string | null> | undefined,
  plan: BoardItemUndo,
): InfiniteData<BoardItems, string | null> | undefined {
  if (plan.mode === "archive")
    return patchBoardItemArchived(data, plan.itemId, true);
  return withBoardCount(
    dropBoardItem(data, plan.itemId),
    plan.counted ? -1 : 0,
  );
}

/** `plan` undone, arm for arm: the card goes back after the id it followed, and the
 *  count goes back exactly where the drop took one. A count-only drop has no card
 *  to restore and undoes as the count alone. */
function undoRemovalPlan(
  data: InfiniteData<BoardItems, string | null> | undefined,
  plan: BoardItemUndo,
  chain: ReadonlyMap<string, BoardItemUndo>,
): InfiniteData<BoardItems, string | null> | undefined {
  if (plan.mode === "archive")
    return patchBoardItemArchived(data, plan.itemId, false);
  return withBoardCount(
    plan.at === null
      ? data
      : insertBoardCardAfter(
          data,
          plan.at.item,
          resolveUndoAnchor(data, plan, chain),
        ),
    plan.counted ? 1 : 0,
  );
}

/**
 * Put a removal's cards back, one `setQueryData` per cached lens.
 *
 * Grouped by key and applied in ONE pass per key so each restore sees the previous
 * one's result — an anchor that is a sibling of this same rollback has to be on the
 * board before the card that follows it looks for it. Ordered by where the cards
 * sat when they LEFT, which is what makes that true: a predecessor always left
 * before its dependents.
 *
 * `restoring` picks the subset — every card on a thrown write, the refused ones
 * alone at a partial settle.
 */
function undoRemovals(
  queryClient: QueryClient,
  undo: readonly BoardItemUndo[],
  restoring: (plan: BoardItemUndo) => boolean,
): void {
  const byKey = new Map<string, { key: QueryKey; plans: BoardItemUndo[] }>();
  for (const plan of undo) {
    // `JSON.stringify` rather than a joined string: a saved view's filter and a
    // Windows repo path both carry spaces, and array encoding is injective
    // without having to claim a delimiter is impossible.
    const id = JSON.stringify(plan.key);
    const slot = byKey.get(id) ?? { key: plan.key, plans: [] };
    slot.plans.push(plan);
    byKey.set(id, slot);
  }
  for (const { key, plans } of byKey.values()) {
    // The chain spans the whole batch, not just the restored subset: a card that
    // succeeded is walked THROUGH, which is the only way its dependents find the
    // survivor behind it.
    const chain = new Map(plans.map((plan) => [plan.itemId, plan]));
    const wanted = plans
      .filter(restoring)
      .toSorted(
        (a, b) =>
          (a.mode === "drop" ? (a.at?.flatIndex ?? -1) : -1) -
          (b.mode === "drop" ? (b.at?.flatIndex ?? -1) : -1),
      );
    if (wanted.length === 0) continue;
    queryClient.setQueryData<InfiniteData<BoardItems, string | null>>(
      key,
      (cur) =>
        wanted.reduce((acc, plan) => undoRemovalPlan(acc, plan, chain), cur),
    );
  }
}

/** The ids a batch write REFUSED, as a set the rollback tests membership in. An
 *  outcome with a null `error` landed; everything else is a failure to undo. */
function failedItemIds(result: BulkItemOutcomes): Set<string> {
  return new Set(
    result.outcomes
      .filter((outcome) => outcome.error !== null)
      .map((outcome) => outcome.itemId),
  );
}

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
        const plan = removalPlan(
          kind,
          key,
          data,
          args.itemId,
          args.wasArchived,
        );
        if (plan === null) continue;
        undo.push(plan);
        queryClient.setQueryData<InfiniteData<BoardItems, string | null>>(
          key,
          (cur) => applyRemovalPlan(cur, plan),
        );
      }
      return { undo };
    },
    // Reporting and rollback live here, not in the caller's `mutate` options: the
    // menu that fires this closes as it does, and react-query drops mutate-scoped
    // callbacks once the observer loses its listeners.
    onError: (e, _args, ctx) => {
      undoRemovals(queryClient, ctx?.undo ?? [], () => true);
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
      // it left in this repo may be the one taken here. Every lens holds the same
      // membership, so any copy will do — but a RICH lens's copy wins over a lean
      // one: it is safe in a lean cache, where the lean copy inserted into a rich
      // one would blank that table's connection-valued cells.
      let restored: BoardItem | undefined;
      let restoredRich = false;
      for (const [key, data] of queryClient.getQueriesData<
        InfiniteData<BoardItems, string | null>
      >({ queryKey })) {
        if (queryClient.getQueryState(key)?.isInvalidated === true)
          owed.push(key);
        const at = findBoardItem(data, args.itemId);
        if (at === null) continue;
        if (restored === undefined || (!restoredRich && keyIsRich(key))) {
          restored = { ...at.item, isArchived: false };
          restoredRich = keyIsRich(key);
        }
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

/** What a BULK removal addresses: the board, and one `wasArchived`-tagged
 *  membership per card. The flag is per ITEM where the single-card write has it
 *  per call, for the same reason it exists at all — it is a COUNT axis no cache
 *  key supplies, and one mixed selection carries both values at once. */
interface BulkBoardRemoval {
  repo: string;
  projectId: string;
  items: { itemId: string; wasArchived: boolean }[];
}

/**
 * {@link useBoardItemRemoval} over a SELECTION: the same per-lens plan, looped,
 * with one undo list spanning items × lenses.
 *
 * The arithmetic is not re-derived here — {@link removalPlan} is the one place
 * that decides what a removal does to a lens, and this hook only decides how many
 * times to ask it. That single-siting is the point of the extraction: a bulk
 * archive that counted its cards differently from the single-card archive would
 * leave the column headers disagreeing with themselves.
 *
 * A batch applies PER ITEM, so the settle rolls back only what GitHub refused and
 * leaves the rest of the optimistic patch standing. The ACCEPTED EDGE
 * {@link useBoardItemRemoval} names — a settle refetch landing inside GitHub's
 * replica lag — holds here for the same reason: the FILTERED lenses' `totalCount`
 * is decidable by no cache, so this read is the only thing that reconciles it.
 */
function useBulkBoardRemoval(
  kind: Extract<BoardWriteKind, "bulk-archive" | "bulk-remove">,
  call: (args: BulkBoardRemoval) => Promise<BulkItemOutcomes>,
  /** Whether this write changes WHICH boards the items are on — the same claim
   *  {@link useBoardItemRemoval} takes it for. */
  membership: boolean,
) {
  const queryClient = useQueryClient();
  // The single-card kind this batches. The plans are written against THAT kind:
  // one selection is N of exactly that write, lens for lens.
  const perCard: Extract<BoardWriteKind, "archive" | "remove"> =
    kind === "bulk-archive" ? "archive" : "remove";
  return useMutation({
    mutationKey: boardWriteKey(kind),
    mutationFn: call,
    onMutate: async (args: BulkBoardRemoval) => {
      const queryKey = projectItemsFamilyKey(args.repo, args.projectId);
      await queryClient.cancelQueries({ queryKey });
      const undo: BoardItemUndo[] = [];
      for (const [key, data] of queryClient.getQueriesData<
        InfiniteData<BoardItems, string | null>
      >({ queryKey })) {
        // Every card's plan is read off the SAME pre-patch snapshot and the lens
        // is then written once: a slot recorded after a sibling's drop had
        // already shortened its page would restore the card to the wrong place.
        const plans = args.items.flatMap((item) => {
          const plan = removalPlan(
            perCard,
            key,
            data,
            item.itemId,
            item.wasArchived,
          );
          return plan === null ? [] : [plan];
        });
        if (plans.length === 0) continue;
        undo.push(...plans);
        queryClient.setQueryData<InfiniteData<BoardItems, string | null>>(
          key,
          (cur) =>
            plans.reduce((acc, plan) => applyRemovalPlan(acc, plan), cur),
        );
      }
      return { undo };
    },
    // Reporting and rollback live here for the reason the single-card family
    // states: the bar or menu that fires this goes away as it does.
    onError: (e, _args, ctx) => {
      undoRemovals(queryClient, ctx?.undo ?? [], () => true);
      toastError(e);
    },
    onSettled: (result, e, args, ctx) => {
      // A resolved batch can still carry refusals, which is the whole reason it
      // answers per item: those cards go back and the rest keep their patch. A
      // THROWN write has already been undone whole by `onError`.
      if (e === null && result !== undefined) {
        const failed = failedItemIds(result);
        undoRemovals(queryClient, ctx?.undo ?? [], (plan) =>
          failed.has(plan.itemId),
        );
      }
      invalidateProjectBoards(queryClient, args.repo);
      if (membership) invalidateItemMemberships(queryClient, args.repo);
    },
  });
}

/** Archives a whole selection. Board-only, like its single-card sibling: the items
 *  stay on the project, restorable from the board itself. */
export function useBulkArchiveBoardItems() {
  return useBulkBoardRemoval(
    "bulk-archive",
    (args) =>
      trackBoardWrite(args.repo, () =>
        api.ghArchiveBoardItems(
          args.repo,
          args.projectId,
          args.items.map((item) => item.itemId),
        ),
      ),
    false,
  );
}

/** Removes a whole selection from the project — an unlink per issue or pull
 *  request, a deletion per draft. Membership-touching either way. */
export function useBulkRemoveBoardItems() {
  return useBulkBoardRemoval(
    "bulk-remove",
    (args) =>
      trackBoardWrite(args.repo, () =>
        api.ghRemoveBoardItems(
          args.repo,
          args.projectId,
          args.items.map((item) => item.itemId),
        ),
      ),
    true,
  );
}

/**
 * {@link useRestoreBoardItem} over a SELECTION, and it keeps that hook's whole
 * freshness shield: the payload is transactionally fresh where a read is not, so
 * the settle writes the cards through rather than re-reading inside GitHub's
 * replica lag.
 *
 * The OWED MARKS are captured once per KEY, before that key's first flip, for the
 * reason the single-card hook states and one this loop makes sharper: a
 * `setQueryData` clears `isInvalidated`, so a debt read after the first item's
 * patch has already been erased by this write's own hand.
 *
 * The settle's patch needs no record of which items each lens flipped: a lens
 * drew a card exactly when it was flipped, and both halves of the patch are
 * no-ops on a lens that holds neither.
 */
export function useBulkRestoreBoardItems() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: boardWriteKey("bulk-restore"),
    mutationFn: (args: {
      repo: string;
      projectId: string;
      itemIds: string[];
    }) =>
      trackBoardWrite(args.repo, () =>
        api.ghUnarchiveBoardItems(args.repo, args.projectId, args.itemIds),
      ),
    onMutate: async (args) => {
      const queryKey = projectItemsFamilyKey(args.repo, args.projectId);
      await queryClient.cancelQueries({ queryKey });
      const flipped: { key: QueryKey; itemIds: string[] }[] = [];
      const owed: QueryKey[] = [];
      // Each card as it will read once this lands, kept for the settle's insert
      // onto the live-only lenses — a rich lens's copy winning, the single-card
      // hook's rule and reason.
      const restored = new Map<string, BoardItem>();
      const restoredRich = new Set<string>();
      for (const [key, data] of queryClient.getQueriesData<
        InfiniteData<BoardItems, string | null>
      >({ queryKey })) {
        if (queryClient.getQueryState(key)?.isInvalidated === true)
          owed.push(key);
        const drawn: string[] = [];
        for (const itemId of args.itemIds) {
          const at = findBoardItem(data, itemId);
          if (at === null) continue;
          drawn.push(itemId);
          if (
            !restored.has(itemId) ||
            (!restoredRich.has(itemId) && keyIsRich(key))
          ) {
            restored.set(itemId, { ...at.item, isArchived: false });
            if (keyIsRich(key)) restoredRich.add(itemId);
          }
        }
        if (drawn.length === 0) continue;
        flipped.push({ key, itemIds: drawn });
        queryClient.setQueryData<InfiniteData<BoardItems, string | null>>(
          key,
          (cur) =>
            drawn.reduce(
              (acc, itemId) => patchBoardItemArchived(acc, itemId, false),
              cur,
            ),
        );
      }
      return { flipped, restored, owed };
    },
    onError: (e, _args, ctx) => {
      for (const entry of ctx?.flipped ?? [])
        queryClient.setQueryData<InfiniteData<BoardItems, string | null>>(
          entry.key,
          (cur) =>
            entry.itemIds.reduce(
              (acc, itemId) => patchBoardItemArchived(acc, itemId, true),
              cur,
            ),
        );
      toastError(e);
    },
    onSettled: (result, e, args, ctx) => {
      const restored = ctx?.restored;
      // No card in context means no lens drew any of them, so there is nothing to
      // write through and the re-read is the only honest answer — the discrimination
      // the single-card restore makes, since this write answers with outcomes rather
      // than with cards.
      if (e !== null || result === undefined || restored === undefined) {
        invalidateProjectBoards(queryClient, args.repo);
        return;
      }
      const failed = failedItemIds(result);
      const landed = [...restored.keys()].filter((id) => !failed.has(id));
      // Nothing was flipped, so there is no optimistic state to undo and nothing to
      // write through: the re-read is the only answer. An EMPTY `restored` is the
      // whole test — an all-FAILED write still flipped cards at `onMutate` and goes
      // through the patch below to put them back, which the invalidation alone
      // would not do for a lens with no observer (`invalidateQueries` refetches
      // ACTIVE queries only, so an inactive view would keep serving
      // `isArchived: false` until something else read it).
      if (restored.size === 0) {
        invalidateProjectBoards(queryClient, args.repo);
        return;
      }
      // The failures are put BACK inside the patch rather than before it:
      // `writeThroughBoards` cancels first, and query-core's cancel reverts the
      // cache past anything written between a fetch's start and it.
      //
      // Stale where the payload leaves a question open — a card GitHub refused, or
      // one no lens drew (so none can be inserted). An all-failed write is that
      // case at its limit: every card reverts and the boards are marked, which is
      // the same treatment a partial failure gets. Only a clean sweep holds the
      // shield and keeps the restored cards put through the replica lag.
      const settled =
        failed.size === 0 && restored.size === args.itemIds.length;
      writeThroughBoards(
        queryClient,
        args.repo,
        projectItemsFamilyKey(args.repo, args.projectId),
        (data, key) => {
          let next = data;
          for (const itemId of failed)
            next = patchBoardItemArchived(next, itemId, true);
          for (const itemId of landed) {
            next = patchBoardItemArchived(next, itemId, false);
            const card = restored.get(itemId);
            // An archived-showing lens counted and drew the card under either
            // state, so the flip alone is truthful there; a live-only lens takes
            // the insert, bumping its count only where unfiltered.
            if (!keyShowsArchived(key) && card !== undefined)
              next = appendBoardItem(next, card, keyIsUnfiltered(key));
          }
          return next;
        },
        !settled,
        ctx?.owed ?? [],
      );
    },
  });
}

/**
 * {@link useMoveBoardCard} over a SELECTION: ONE field write carrying every
 * membership, with the same optimistic re-bucketing applied per card on the lens
 * the move was fired from.
 *
 * Single-writer by the same contract, and for the same reason: two writes to one
 * card's grouped field settle in an order nothing promises. The panel holds every
 * bulk verb while any board write runs.
 */
export function useBulkMoveBoardCards() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: boardWriteKey("bulk-move"),
    mutationFn: (args: {
      repo: string;
      projectId: string;
      /** The memberships on `projectId` — what the write addresses. */
      itemIds: string[];
      field: BoardGroupField;
      /** The column's bucket, or null for the board's "No {field}" column. */
      bucket: BoardMoveBucket;
      /** The lens the board was showing when the move was fired — the cache this
       *  write patches and rolls back, pinned into the context at `onMutate`. */
      query: string | null;
      /** Whether that lens was drawing archived cards — the other half of the key. */
      archived: boolean;
      /** Whether that lens was the rich read — its key's last axis. */
      rich: boolean;
    }) =>
      trackBoardWrite(args.repo, () =>
        api.ghSetItemsFieldValues(
          args.repo,
          args.projectId,
          args.itemIds,
          moveUpdates(args.field.id, args.bucket),
          args.bucket === null ? [args.field.id] : [],
        ),
      ),
    onMutate: async (args) => {
      const key = projectItemsKey(
        args.repo,
        args.projectId,
        args.query,
        args.archived,
        args.rich,
      );
      const railKey = itemFieldValuesFamilyKey(args.repo);
      await queryClient.cancelQueries({ queryKey: key });
      // Each moved card's values, never the whole tree: that is all the rollback
      // needs, and all it may safely carry.
      const wanted = new Set(args.itemIds);
      const before = new Map<string, ProjectFieldValue[]>();
      for (const item of queryClient
        .getQueryData<InfiniteData<BoardItems, string | null>>(key)
        ?.pages.flatMap((page) => page.items) ?? [])
        if (wanted.has(item.itemId)) before.set(item.itemId, item.fieldValues);
      queryClient.setQueryData<InfiniteData<BoardItems, string | null>>(
        key,
        (data) =>
          args.itemIds.reduce((acc, itemId) => {
            const values = before.get(itemId);
            return values === undefined
              ? acc
              : patchBoardItem(
                  acc,
                  itemId,
                  withGroupValue(values, args.field, args.bucket),
                );
          }, data),
      );
      return { before, key, railKey, repo: args.repo };
    },
    onError: (e, _args, ctx) => {
      if (ctx !== undefined)
        for (const [itemId, values] of ctx.before)
          queryClient.setQueryData<InfiniteData<BoardItems, string | null>>(
            ctx.key,
            (data) => patchBoardItem(data, itemId, values),
          );
      toastError(e);
    },
    onSettled: (result, e, _args, ctx) => {
      if (ctx === undefined) return;
      // Only the cards GitHub refused go back to their old column; the rest keep
      // the patch until the invalidation's own read confirms it.
      if (e === null && result !== undefined) {
        const failed = failedItemIds(result);
        for (const [itemId, values] of ctx.before) {
          if (!failed.has(itemId)) continue;
          queryClient.setQueryData<InfiniteData<BoardItems, string | null>>(
            ctx.key,
            (data) => patchBoardItem(data, itemId, values),
          );
        }
      }
      invalidateProjectBoards(queryClient, ctx.repo);
      void queryClient
        .cancelQueries({ queryKey: ctx.railKey })
        .then(() => queryClient.invalidateQueries({ queryKey: ctx.railKey }));
    },
  });
}

/**
 * ONE set of field values written across a selection — {@link useSetItemFieldValues}
 * for several cards of one board, through the batch command.
 *
 * NO optimistic patch, deliberately, where every other bulk verb has one. A field
 * write can move several fields at once and one of them may be the board's GROUPING
 * field, so what the board looks like afterwards is not a local derivation: the card
 * changes column, its position in that column is the server's answer, and a filtered
 * lens may stop drawing it entirely. A patch would have to guess all three. The write
 * is fast enough that the cards simply redraw on the settle's read.
 *
 * The settle therefore re-reads rather than writing through: `invalidateProjectBoards`
 * for the boards, and the item-field-values family for the rail, cancel-before-
 * invalidate on both for the reason {@link invalidateProjectBoards} states. The rail
 * family is invalidated WHOLE rather than per succeeded item: a board write holds an
 * item id and a project id, never an item's lens, kind and number, so the per-item
 * keys are out of reach here — the same limit {@link invalidateItemMemberships}
 * documents. Nothing optimistic is in flight, so the wider re-read costs only reads.
 *
 * Memberships are NOT touched: a field write changes what a card holds, never which
 * boards it is on.
 */
export function useBulkSetItemFieldValues() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: boardWriteKey("bulk-fields"),
    mutationFn: (args: {
      repo: string;
      projectId: string;
      /** The memberships on `projectId` — what the write addresses. */
      itemIds: string[];
      updates: ProjectFieldValueUpdate[];
      /** Field ids to UNSET; no update shape expresses a clear. */
      clears: string[];
    }) =>
      trackBoardWrite(args.repo, () =>
        api.ghSetItemsFieldValues(
          args.repo,
          args.projectId,
          args.itemIds,
          args.updates,
          args.clears,
        ),
      ),
    // Reporting lives here for the family's reason: the dialog that fires this
    // closes on success, and react-query drops mutate-scoped callbacks once the
    // observer loses its listeners. A PARTIAL failure is the caller's to report —
    // it reads the per-item outcomes this resolves with.
    onError: toastError,
    onSettled: (_result, _e, args) => {
      invalidateProjectBoards(queryClient, args.repo);
      void queryClient
        .cancelQueries({ queryKey: itemFieldValuesFamilyKey(args.repo) })
        .then(() =>
          queryClient.invalidateQueries({
            queryKey: itemFieldValuesFamilyKey(args.repo),
          }),
        );
    },
  });
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
      /** The item's number, for the toolbar's write indicator alone — the write
       *  addresses the content id. Carried as a variable rather than looked up
       *  later because the indicator reads `variables` off the in-flight mutation,
       *  and the search result it came from lives in a dialog that may be closed
       *  by then. (The same display-only shape {@link useSetIssueMilestone}'s
       *  `title` keeps.) */
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
 * the card the panel marks busy, and the write's line in the toolbar's write
 * indicator — the same display-only shape {@link useAddExistingToBoard}'s `number`
 * keeps.
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

/** One project's status updates, newest first — the first page GitHub answers
 *  with. No placeholder axis: switching projects must never show another
 *  project's health. `retry: false` for the reason the rest of the Projects family
 *  gives, the common failure being a missing `project` scope. */
export function useProjectStatusUpdates(
  repo: string,
  projectId: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: projectStatusUpdatesKey(repo, projectId),
    queryFn: () => api.ghProjectStatusUpdates(repo, projectId),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

/** The prefix a placeholder status update's id carries between a post and its
 *  answer. Nothing may address one on GitHub, so a reader holds its Edit and
 *  Delete until the real id replaces it. */
const OPTIMISTIC_STATUS_PREFIX = "optimistic:";
let optimisticStatusSeq = 0;

/** Whether `update` is a post still waiting on GitHub's answer. */
export function isOptimisticStatusUpdate(update: ProjectStatusUpdate): boolean {
  return update.id.startsWith(OPTIMISTIC_STATUS_PREFIX);
}

/** What every status write addresses: the repo it runs from and the project whose
 *  cache it patches. Call-time VARIABLES rather than hook scope, as the board writes
 *  keep them, so a repo switch mid-flight can't retarget the write or its patch. */
interface StatusWriteScope {
  repo: string;
  projectId: string;
}

/** The key every status write carries. Its own prefix, never under `board-write`:
 *  {@link usePendingBoardWrites} enumerates that prefix, and would start counting
 *  these. Which repo and project a write addresses rides its VARIABLES, for the
 *  reason {@link boardWriteKey} gives. */
const STATUS_WRITE_KEY = ["project-status-write"] as const;

/** Whether a mutation's variables address `scope`. The filter sees
 *  `Mutation<any>`, so the fields are `typeof`-guarded rather than asserted. */
function writesScope(
  mutation: { state: { variables?: unknown } },
  scope: StatusWriteScope,
): boolean {
  const vars = mutation.state.variables;
  if (typeof vars !== "object" || vars === null) return false;
  const { repo, projectId } = vars as Record<string, unknown>;
  return repo === scope.repo && projectId === scope.projectId;
}

/** Settles a status write by re-reading the project's updates — but only from the
 *  LAST write still pending on that project. A re-read landing while a sibling
 *  write is out answers from before it, clobbering that write's patch until its own
 *  settle; the sibling's settle re-reads for both. `> 1` because query-core awaits
 *  `options.onSettled` BEFORE dispatching the settle (5.102.8 mutation.js
 *  :109/:132), so the write calling this still counts as pending. The status
 *  hooks' callbacks stay SYNCHRONOUS: each IPC reply settles in its own task
 *  today, and an awaited callback could let two settles share a checkpoint,
 *  each counting the other, so that both skip. */
function settleStatusUpdates(queryClient: QueryClient, args: StatusWriteScope) {
  const pending = queryClient.isMutating({
    mutationKey: STATUS_WRITE_KEY,
    predicate: (mutation) => writesScope(mutation, args),
  });
  if (pending > 1) return;
  void queryClient.invalidateQueries({
    queryKey: projectStatusUpdatesKey(args.repo, args.projectId),
  });
}

/**
 * Posts a status update, OPTIMISTIC: a placeholder entry leads the history at
 * once, and GitHub's answer replaces it — the real id is what makes Edit and
 * Delete reachable. A failure takes the placeholder back out of whatever the cache
 * holds by then, never a snapshot of the whole list, so a concurrent edit or
 * delete of another entry survives the rollback.
 *
 * Reporting is the hook's, never the caller's `mutate` options: the dialog that
 * fires this can be closed over the write, and react-query drops mutate-scoped
 * callbacks once the observer loses its listeners.
 */
export function useCreateProjectStatusUpdate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: STATUS_WRITE_KEY,
    mutationFn: (
      args: StatusWriteScope & {
        status: ProjectStatusValue;
        content: ProjectStatusContent;
        /** Who the placeholder names — the signed-in account, when known. */
        creator: AssigneeRef | null;
      },
    ) =>
      api.ghCreateProjectStatusUpdate(
        args.repo,
        args.projectId,
        args.status,
        args.content,
      ),
    onMutate: async (args) => {
      const key = projectStatusUpdatesKey(args.repo, args.projectId);
      await queryClient.cancelQueries({ queryKey: key });
      optimisticStatusSeq += 1;
      const placeholder: ProjectStatusUpdate = {
        id: `${OPTIMISTIC_STATUS_PREFIX}${optimisticStatusSeq}`,
        status: args.status,
        ...args.content,
        creator: args.creator,
        createdAt: new Date().toISOString(),
        updatedAt: null,
      };
      if (mayPatchStatusCache(queryClient.getQueryState(key)))
        queryClient.setQueryData<ProjectStatusUpdates>(key, (current) =>
          prependStatusUpdate(current, placeholder),
        );
      return { placeholderId: placeholder.id };
    },
    onSuccess: (created, args, ctx) => {
      queryClient.setQueryData<ProjectStatusUpdates>(
        projectStatusUpdatesKey(args.repo, args.projectId),
        (current) => replaceStatusUpdate(current, ctx.placeholderId, created),
      );
    },
    onError: (e, args, ctx) => {
      const placeholderId = ctx?.placeholderId;
      if (placeholderId !== undefined)
        queryClient.setQueryData<ProjectStatusUpdates>(
          projectStatusUpdatesKey(args.repo, args.projectId),
          (current) => dropStatusUpdate(current, placeholderId),
        );
      toastError(e);
    },
    onSettled: (_d, _e, args) => settleStatusUpdates(queryClient, args),
  });
}

/**
 * Rewrites one status update WHOLE — every field rides, and null clears it (the
 * contract {@link api.ghUpdateProjectStatusUpdate} states). OPTIMISTIC: the entry
 * reads as edited at once, then as GitHub's answer; a failure puts back that ONE
 * entry as it was, onto the current cache.
 */
export function useUpdateProjectStatusUpdate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: STATUS_WRITE_KEY,
    mutationFn: (
      args: StatusWriteScope & {
        statusUpdateId: string;
        status: string | null;
        content: ProjectStatusContent;
      },
    ) =>
      api.ghUpdateProjectStatusUpdate(
        args.repo,
        args.statusUpdateId,
        args.status,
        args.content,
      ),
    onMutate: async (args) => {
      const key = projectStatusUpdatesKey(args.repo, args.projectId);
      await queryClient.cancelQueries({ queryKey: key });
      const prev = queryClient
        .getQueryData<ProjectStatusUpdates>(key)
        ?.updates.find((u) => u.id === args.statusUpdateId);
      if (prev !== undefined)
        queryClient.setQueryData<ProjectStatusUpdates>(key, (current) =>
          replaceStatusUpdate(current, prev.id, {
            ...prev,
            status: args.status,
            ...args.content,
          }),
        );
      return { prev };
    },
    onSuccess: (updated, args) => {
      queryClient.setQueryData<ProjectStatusUpdates>(
        projectStatusUpdatesKey(args.repo, args.projectId),
        (current) => replaceStatusUpdate(current, updated.id, updated),
      );
    },
    onError: (e, args, ctx) => {
      const prev = ctx?.prev;
      if (prev !== undefined)
        queryClient.setQueryData<ProjectStatusUpdates>(
          projectStatusUpdatesKey(args.repo, args.projectId),
          (current) => replaceStatusUpdate(current, prev.id, prev),
        );
      toastError(e);
    },
    onSettled: (_d, _e, args) => settleStatusUpdates(queryClient, args),
  });
}

/**
 * Deletes one status update. OPTIMISTIC: the entry leaves the history at once; a
 * failure puts it back in its newest-first place among what the list holds by
 * then, unless something else already restored it.
 */
export function useDeleteProjectStatusUpdate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: STATUS_WRITE_KEY,
    mutationFn: (args: StatusWriteScope & { statusUpdateId: string }) =>
      api.ghDeleteProjectStatusUpdate(args.repo, args.statusUpdateId),
    onMutate: async (args) => {
      const key = projectStatusUpdatesKey(args.repo, args.projectId);
      await queryClient.cancelQueries({ queryKey: key });
      const prev = queryClient
        .getQueryData<ProjectStatusUpdates>(key)
        ?.updates.find((u) => u.id === args.statusUpdateId);
      queryClient.setQueryData<ProjectStatusUpdates>(key, (current) =>
        dropStatusUpdate(current, args.statusUpdateId),
      );
      return { prev };
    },
    onError: (e, args, ctx) => {
      const prev = ctx?.prev;
      if (prev !== undefined)
        queryClient.setQueryData<ProjectStatusUpdates>(
          projectStatusUpdatesKey(args.repo, args.projectId),
          (current) => {
            if (
              current === undefined ||
              current.updates.some((u) => u.id === prev.id)
            )
              return current;
            return {
              ...current,
              updates: insertNewestFirst(current.updates, prev),
              totalCount: current.totalCount + 1,
            };
          },
        );
      toastError(e);
    },
    onSettled: (_d, _e, args) => settleStatusUpdates(queryClient, args),
  });
}

/** What a project write addresses: the repo it runs from and the catalog LENS a
 *  create lands in. Call-time VARIABLES, as the status writes keep them, so a repo
 *  switch mid-flight can't retarget the write or its patch. */
interface ProjectWriteScope {
  repo: string;
  lens: RemoteLens;
}

/** What a saved-view write addresses: the repo and the project whose views it
 *  patches, as variables for {@link ProjectWriteScope}'s reason. */
interface ViewWriteScope {
  repo: string;
  projectId: string;
}

/** The keys the project and view writes carry. Prefixes of their own, never under
 *  `board-write` or the status writes' key, for the reason {@link STATUS_WRITE_KEY}
 *  gives; which project or repo a write addresses rides its variables. */
const PROJECT_WRITE_KEY = ["project-write"] as const;
const VIEW_WRITE_KEY = ["project-view-write"] as const;

/** How many container settles are still waiting out the replica lag, per query
 *  key hash. A read fired inside that window can answer from before the write,
 *  undoing the answer the write patched in, so an on-demand refresh waits it out. */
const lagWindowSettles = new Map<string, number>();

/**
 * Settles a project or view write by re-reading `queryKeys`: after GitHub's
 * replicas have caught up (the item reads' measured margin; these container reads
 * are unmeasured, so they take the same one). Each write's own answer is already
 * in the cache, so an earlier read could only put back what it replaced: a new
 * view vanishing retires the pick made on it. So a settle reads only when it is
 * the LAST to close its scope's lag window and no sibling write is still out; any
 * other settle leaves the read to that last one, which covers the same keys.
 */
function settleContainerWrite(
  queryClient: QueryClient,
  mutationKey: QueryKey,
  inScope: (vars: Record<string, unknown>) => boolean,
  queryKeys: QueryKey[],
) {
  const hashes = queryKeys.map((queryKey) => hashKey(queryKey));
  for (const hash of hashes)
    lagWindowSettles.set(hash, (lagWindowSettles.get(hash) ?? 0) + 1);
  setTimeout(() => {
    let siblingWindowOpen = false;
    for (const hash of hashes) {
      const left = (lagWindowSettles.get(hash) ?? 1) - 1;
      if (left > 0) {
        lagWindowSettles.set(hash, left);
        siblingWindowOpen = true;
      } else lagWindowSettles.delete(hash);
    }
    // A sibling's window is still open: its settle closes last and reads for both.
    if (siblingWindowOpen) return;
    const pending = queryClient.isMutating({
      mutationKey,
      predicate: (mutation) => {
        const vars = mutation.state.variables;
        return (
          typeof vars === "object" &&
          vars !== null &&
          inScope(vars as Record<string, unknown>)
        );
      },
    });
    if (pending > 0) return;
    for (const queryKey of queryKeys)
      void queryClient.invalidateQueries({ queryKey });
  }, REPLICA_LAG_MS);
}

/** A project write's settle: the catalog, and the membership reads the issue and
 *  pull request rails show a project's title and state through. EVERY project
 *  write re-reads all three, a create included: a settle skipped for a sibling
 *  still in flight leaves the survivor to re-read for it, so each one must cover
 *  every key any sibling would have. */
function settleProjectWrite(queryClient: QueryClient, repo: string) {
  settleContainerWrite(
    queryClient,
    PROJECT_WRITE_KEY,
    (vars) => vars.repo === repo,
    [
      projectsAvailableFamilyKey(repo),
      itemProjectsFamilyKey(repo),
      itemFieldValuesFamilyKey(repo),
    ],
  );
}

function settleViewWrite(queryClient: QueryClient, scope: ViewWriteScope) {
  settleContainerWrite(
    queryClient,
    VIEW_WRITE_KEY,
    (vars) => vars.repo === scope.repo && vars.projectId === scope.projectId,
    [projectViewsKey(scope.repo, scope.projectId)],
  );
}

/**
 * Re-reads one project's saved views on demand, so a view edited on GitHub shows
 * without waiting out the 5-minute staleTime. Skipped while a view write on that
 * project is in flight or its settle is still inside the replica lag: either way
 * the cache holds a write's own answer, which an early read would undo.
 */
export function useRefreshProjectViews() {
  const queryClient = useQueryClient();
  return useCallback(
    (repo: string, projectId: string) => {
      const key = projectViewsKey(repo, projectId);
      if (lagWindowSettles.has(hashKey(key))) return;
      const writing = queryClient.isMutating({
        mutationKey: VIEW_WRITE_KEY,
        predicate: (mutation) => {
          const vars = mutation.state.variables;
          if (typeof vars !== "object" || vars === null) return false;
          const scope = vars as Record<string, unknown>;
          return scope.repo === repo && scope.projectId === projectId;
        },
      });
      if (writing > 0) return;
      void queryClient.invalidateQueries({ queryKey: key });
    },
    [queryClient],
  );
}

/**
 * Cancels `queryKey`'s in-flight reads before a write patches the cache, and
 * names the ones that were FIRST loads: query-core's cancel reverts those to no
 * data at all, and nothing but the lagged settle would fetch them again. The
 * write re-fetches them itself (see {@link refetchStranded}).
 */
async function cancelForWrite(
  queryClient: QueryClient,
  queryKey: QueryKey,
): Promise<QueryKey[]> {
  const stranded = queryClient
    .getQueryCache()
    .findAll({ queryKey })
    .filter(
      (query) =>
        query.state.data === undefined &&
        query.state.fetchStatus === "fetching",
    )
    .map((query) => query.queryKey);
  await queryClient.cancelQueries({ queryKey });
  return stranded;
}

/** Re-fetches the first loads {@link cancelForWrite} cancelled, at once. */
function refetchStranded(
  queryClient: QueryClient,
  stranded: QueryKey[] | undefined,
) {
  for (const queryKey of stranded ?? [])
    void queryClient.invalidateQueries({ queryKey, exact: true });
}

function patchCatalog(
  data: AvailableProjects | undefined,
  patch: (projects: ProjectV2Ref[]) => ProjectV2Ref[],
): AvailableProjects | undefined {
  return data === undefined
    ? data
    : { ...data, projects: patch(data.projects) };
}

/** `project` with `patch` applied the way GitHub applies it: absent keys keep
 *  their value, and an emptied description reads as none. */
function patchedProject(
  project: ProjectV2Ref,
  patch: ProjectPatch,
): ProjectV2Ref {
  const next: ProjectV2Ref = {
    ...project,
    title: patch.title ?? project.title,
    closed: patch.closed ?? project.closed,
  };
  if (patch.shortDescription !== undefined) {
    if (patch.shortDescription === "") delete next.shortDescription;
    else next.shortDescription = patch.shortDescription;
  }
  return next;
}

/**
 * Creates a project under the catalog's owner, linked to this repository when a
 * repository id is given. The answer joins the lens's catalog at once, first in
 * the list (linked or not), since GitHub's reads can lag the write; the settle's
 * re-read puts it where GitHub files it once they have caught up.
 *
 * Reporting is the hook's, never the caller's `mutate` options: the dialog that
 * fires this can be closed over the write, and react-query drops mutate-scoped
 * callbacks once the observer loses its listeners.
 */
export function useCreateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: PROJECT_WRITE_KEY,
    mutationFn: (
      args: ProjectWriteScope & {
        ownerId: string;
        repositoryId: string | null;
        title: string;
      },
    ) =>
      api.ghCreateProject(
        args.repo,
        args.ownerId,
        args.title,
        args.repositoryId,
      ),
    onMutate: async (args) => ({
      stranded: await cancelForWrite(
        queryClient,
        projectsAvailableKey(args.repo, args.lens),
      ),
    }),
    onSuccess: (created, args) => {
      queryClient.setQueryData<AvailableProjects>(
        projectsAvailableKey(args.repo, args.lens),
        (current) =>
          patchCatalog(current, (projects) => [
            created,
            ...projects.filter((p) => p.id !== created.id),
          ]),
      );
    },
    onError: (e) => toastError(e),
    onSettled: (_d, _e, args, ctx) => {
      refetchStranded(queryClient, ctx?.stranded);
      settleProjectWrite(queryClient, args.repo);
    },
  });
}

/**
 * Renames, describes, closes or reopens a project. OPTIMISTIC in every lens's
 * catalog: the picker reads the change at once, then GitHub's answer; a failure
 * puts back that ONE project as it was.
 */
export function useUpdateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: PROJECT_WRITE_KEY,
    mutationFn: (
      args: ProjectWriteScope & { projectId: string; patch: ProjectPatch },
    ) => api.ghUpdateProject(args.repo, args.projectId, args.patch),
    onMutate: async (args) => {
      const family = projectsAvailableFamilyKey(args.repo);
      const stranded = await cancelForWrite(queryClient, family);
      const prev = queryClient
        .getQueriesData<AvailableProjects>({ queryKey: family })
        .flatMap(([, data]) => data?.projects ?? [])
        .find((p) => p.id === args.projectId);
      if (prev !== undefined)
        queryClient.setQueriesData<AvailableProjects>(
          { queryKey: family },
          (current) =>
            patchCatalog(current, (projects) =>
              projects.map((p) =>
                p.id === args.projectId ? patchedProject(p, args.patch) : p,
              ),
            ),
        );
      return { prev, stranded };
    },
    onSuccess: (updated, args) => {
      queryClient.setQueriesData<AvailableProjects>(
        { queryKey: projectsAvailableFamilyKey(args.repo) },
        (current) =>
          patchCatalog(current, (projects) =>
            projects.map((p) => (p.id === updated.id ? updated : p)),
          ),
      );
    },
    onError: (e, args, ctx) => {
      const prev = ctx?.prev;
      if (prev !== undefined)
        queryClient.setQueriesData<AvailableProjects>(
          { queryKey: projectsAvailableFamilyKey(args.repo) },
          (current) =>
            patchCatalog(current, (projects) =>
              projects.map((p) => (p.id === prev.id ? prev : p)),
            ),
        );
      toastError(e);
    },
    onSettled: (_d, _e, args, ctx) => {
      refetchStranded(queryClient, ctx?.stranded);
      settleProjectWrite(queryClient, args.repo);
    },
  });
}

/** Deletes a project. Settle-driven rather than optimistic: the project leaves
 *  every catalog once GitHub confirms, since there is no undelete to roll back to. */
export function useDeleteProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: PROJECT_WRITE_KEY,
    mutationFn: (args: ProjectWriteScope & { projectId: string }) =>
      api.ghDeleteProject(args.repo, args.projectId),
    onMutate: async (args) => ({
      stranded: await cancelForWrite(
        queryClient,
        projectsAvailableFamilyKey(args.repo),
      ),
    }),
    onSuccess: (_d, args) => {
      queryClient.setQueriesData<AvailableProjects>(
        { queryKey: projectsAvailableFamilyKey(args.repo) },
        (current) =>
          patchCatalog(current, (projects) =>
            projects.filter((p) => p.id !== args.projectId),
          ),
      );
    },
    onError: (e) => toastError(e),
    onSettled: (_d, _e, args, ctx) => {
      refetchStranded(queryClient, ctx?.stranded);
      settleProjectWrite(queryClient, args.repo);
    },
  });
}

function patchViews(
  data: ProjectViews | undefined,
  patch: (views: ProjectViewDef[]) => ProjectViewDef[],
): ProjectViews | undefined {
  return data === undefined ? data : { ...data, views: patch(data.views) };
}

/** `view` joined to the END of the list (where GitHub adds a new view), or put in
 *  its own place when the list already carries it. For CREATES only. */
function withView(views: ProjectViewDef[], view: ProjectViewDef) {
  return views.some((v) => v.id === view.id)
    ? views.map((v) => (v.id === view.id ? view : v))
    : [...views, view];
}

/** `view` in its own place, and nothing when the list no longer carries it: an
 *  update answering after a delete must not bring the deleted view back. */
function replaceView(views: ProjectViewDef[], view: ProjectViewDef) {
  return views.some((v) => v.id === view.id)
    ? views.map((v) => (v.id === view.id ? view : v))
    : views;
}

/** Joins a created view to its project's cached list. With NO list cached (the
 *  write's own cancel reverted a first load) the answer seeds a one-view list,
 *  marked TRUNCATED since it holds only what this write knows: a read fired now
 *  could lag the write and come back without the new view, retiring the pick
 *  made on it, so the settle's re-read replaces the seed. */
function joinCreatedView(
  queryClient: QueryClient,
  scope: ViewWriteScope,
  created: ProjectViewDef,
) {
  const key = projectViewsKey(scope.repo, scope.projectId);
  if (queryClient.getQueryData<ProjectViews>(key) === undefined) {
    queryClient.setQueryData<ProjectViews>(key, {
      views: [created],
      truncated: true,
    });
    return;
  }
  queryClient.setQueryData<ProjectViews>(key, (current) =>
    patchViews(current, (views) => withView(views, created)),
  );
}

/** Adds a saved view. GitHub's answer joins the switcher at once, for the lag
 *  {@link useCreateProject} describes, so the caller can pick it straight away. */
export function useCreateProjectView() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: VIEW_WRITE_KEY,
    mutationFn: (
      args: ViewWriteScope & { name: string; layout: ProjectViewLayout },
    ) => api.ghCreateView(args.repo, args.projectId, args.name, args.layout),
    onMutate: async (args) => ({
      stranded: await cancelForWrite(
        queryClient,
        projectViewsKey(args.repo, args.projectId),
      ),
    }),
    onSuccess: (created, args) => joinCreatedView(queryClient, args, created),
    onError: (e, _args, ctx) => {
      refetchStranded(queryClient, ctx?.stranded);
      toastError(e);
    },
    onSettled: (_d, _e, args) => settleViewWrite(queryClient, args),
  });
}

/** Copies a saved view: its layout, filter and visible fields. The copy joins the
 *  switcher as {@link useCreateProjectView}'s does. A failure after the copy was
 *  created says so, and the settle's re-read brings that copy in. */
export function useDuplicateProjectView() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: VIEW_WRITE_KEY,
    mutationFn: (args: ViewWriteScope & { source: DuplicateViewSource }) =>
      api.ghDuplicateView(args.repo, args.projectId, args.source),
    onMutate: async (args) => ({
      stranded: await cancelForWrite(
        queryClient,
        projectViewsKey(args.repo, args.projectId),
      ),
    }),
    onSuccess: (created, args) => joinCreatedView(queryClient, args, created),
    onError: (e, _args, ctx) => {
      refetchStranded(queryClient, ctx?.stranded);
      toastError(e);
    },
    onSettled: (_d, _e, args) => settleViewWrite(queryClient, args),
  });
}

/**
 * Renames a view, changes its layout, or sets its visible fields. OPTIMISTIC: the
 * view reads as edited at once, then as GitHub's answer; a failure puts back that
 * ONE view as it was, onto the current cache.
 */
export function useUpdateProjectView() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: VIEW_WRITE_KEY,
    mutationFn: (
      args: ViewWriteScope & { viewId: string; patch: ProjectViewPatch },
    ) => api.ghUpdateView(args.repo, args.viewId, args.patch),
    onMutate: async (args) => {
      const key = projectViewsKey(args.repo, args.projectId);
      const stranded = await cancelForWrite(queryClient, key);
      const prev = queryClient
        .getQueryData<ProjectViews>(key)
        ?.views.find((v) => v.id === args.viewId);
      if (prev !== undefined)
        queryClient.setQueryData<ProjectViews>(key, (current) =>
          patchViews(current, (views) =>
            views.map((v) => (v.id === prev.id ? { ...v, ...args.patch } : v)),
          ),
        );
      return { prev, stranded };
    },
    onSuccess: (updated, args) => {
      queryClient.setQueryData<ProjectViews>(
        projectViewsKey(args.repo, args.projectId),
        (current) =>
          patchViews(current, (views) => replaceView(views, updated)),
      );
    },
    onError: (e, args, ctx) => {
      const prev = ctx?.prev;
      if (prev !== undefined)
        queryClient.setQueryData<ProjectViews>(
          projectViewsKey(args.repo, args.projectId),
          (current) =>
            patchViews(current, (views) =>
              views.map((v) => (v.id === prev.id ? prev : v)),
            ),
        );
      toastError(e);
    },
    onSettled: (_d, _e, args, ctx) => {
      refetchStranded(queryClient, ctx?.stranded);
      settleViewWrite(queryClient, args);
    },
  });
}

/** Deletes a saved view. Settle-driven for {@link useDeleteProject}'s reason: the
 *  view leaves the switcher once GitHub confirms, and a board drawn under it falls
 *  back to no view the way any vanished view does. */
export function useDeleteProjectView() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: VIEW_WRITE_KEY,
    mutationFn: (args: ViewWriteScope & { viewId: string }) =>
      api.ghDeleteView(args.repo, args.viewId),
    onMutate: async (args) => ({
      stranded: await cancelForWrite(
        queryClient,
        projectViewsKey(args.repo, args.projectId),
      ),
    }),
    onSuccess: (_d, args) => {
      queryClient.setQueryData<ProjectViews>(
        projectViewsKey(args.repo, args.projectId),
        (current) =>
          patchViews(current, (views) =>
            views.filter((v) => v.id !== args.viewId),
          ),
      );
    },
    onError: (e) => toastError(e),
    onSettled: (_d, _e, args, ctx) => {
      refetchStranded(queryClient, ctx?.stranded);
      settleViewWrite(queryClient, args);
    },
  });
}
