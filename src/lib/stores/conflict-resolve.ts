import { toast } from "sonner";
import { create } from "zustand";
import { conflictPathRefusal } from "@/features/repository/conflict-banner-state";
import { aiExcludePatterns } from "@/lib/ai/ignore";
import { appErrorDetail, presentError } from "@/lib/error-summary";
import { conflictSides } from "@/lib/git/conflict";
import { noLongerConflicted } from "@/lib/git/conflict-parse";
import {
  type PrefilterRead,
  partition,
  prefilterToast,
  SIDES_READ_CHUNK,
  sidesRefusal,
} from "@/lib/git/conflict-prefilter";
import { loadSettings } from "@/lib/settings/api";
import { isAppError } from "@/lib/tauri/invoke";
import { useUiStore } from "./ui";

/**
 * Drives AI conflict resolution in the diff pane. `activePath` is the conflicted
 * file currently in resolution mode (the diff pane swaps to its ConflictResolveView
 * when the selection matches); `queue` is the remaining files to walk in a
 * "resolve all" run; `scopePath` is the tree those paths belong to. The streaming +
 * accept lifecycle lives in the component — this store only tracks which file is
 * active, what's next, and whose tree it is.
 *
 * Exactly one walk at a time: starting a new one replaces whatever was armed,
 * whatever its scope. A SYNCHRONOUS read under a scope-matched parent may trust
 * that walk to be its own — ConflictResolveView's `queue`/`advance`/`stop` reads
 * rely on it. Anything resuming after an await must re-read the store and re-check
 * `scopePath` + `activePath` before advancing or stopping: the parent's gate only
 * unmounts on the next render, and a repo switch or another surface can replace
 * the walk mid-await.
 *
 * Not a liveness signal: a walk outlives the surface that armed it (nothing disarms
 * one when a takeover's worktree is finished or discarded), so a non-null
 * `activePath` means a walk EXISTS, not that one is running. Gate on scope.
 *
 * `startAll` clears the armed walk at the press and reads every file's sides
 * before arming, so the walk lands after those awaits. One prefilter at a time:
 * a new `startAll` supersedes a running one, except an exact repeat (same scope
 * and paths) of a live run, which is a no-op. Every continuation re-checks its
 * run token, `walkEpoch` (each walk change bumps it) and the ui store's
 * `interactionEpoch`, and drops silently once any moved. `prefiltering` is a
 * HOLD signal for the banner, not a liveness signal.
 */
interface ConflictResolveState {
  /** The conflicted file with an active resolution session, or null. */
  activePath: string | null;
  /** Remaining conflicted paths to resolve in sequence (excludes `activePath`).
   *  Empty for a single-file resolve. */
  queue: string[];
  /** The tree this walk belongs to — the main working tree's `repoPath`, or a
   *  resolve worktree's path for the PR takeovers; null when idle. Readers compare
   *  it to their own tree and ignore a walk scoped elsewhere, so a walk can never
   *  be adopted by a surface looking at different files. */
  scopePath: string | null;
  /** Scope whose `startAll` prefilter is reading sides; the banner and the
   *  takeovers hold their AI button while this names their tree. */
  prefiltering: string | null;

  /** Resolve one file (context-menu / diff-pane button) in `scope`'s tree. Selects
   *  it so the diff pane shows its resolution view. */
  startOne: (path: string, scope: string) => void;
  /** Resolve a list of conflicted files in `scope`'s tree in sequence (the banner's
   *  "Resolve all"), leaving out, with one summary toast, files already resolved
   *  and files the walk would refuse to send. A single file skips only when it is
   *  already resolved. No-op on an empty list. `seeded` marks a start no user
   *  pressed (a takeover's mount): it neither bumps nor watches the ui epoch. */
  startAll: (
    paths: string[],
    scope: string,
    opts?: { seeded?: boolean },
  ) => void;
  /** This file is done (accepted) or skipped — move to the next queued file, or
   *  end the run when the queue is empty. `landing` marks a move no user made
   *  (the self-heal), which selects the next file without bumping the ui epoch. */
  advance: (opts?: { landing?: boolean }) => void;
  /** End the run entirely (discard / cancel / Esc). */
  stop: () => void;
  /** End the walk and any prefilter belonging to `scope` (its merge was aborted
   *  or finished); a walk or prefilter of another tree is left untouched. */
  retire: (scope: string) => void;
}

/** Select a conflicted file so the working-tree diff pane shows it (conflicts
 *  always live on the unstaged side) — MAIN-tree walks only. A takeover walk's
 *  paths are relative to a hidden worktree, so steering the changes list with them
 *  points it at the wrong tree's files; those surfaces follow `activePath` with
 *  their own local selection instead. */
function selectConflicted(path: string, scope: string | null, landing = false) {
  const ui = useUiStore.getState();
  if (scope !== ui.repoPath) return;
  const file = { path, staged: false, untracked: false };
  // A landing (a prefilter's arm, the self-heal) never bumps: no user made it
  // now, and a late bump would retire a claimant that snapshots the epoch
  // without bumping (ActivityDock's navigate).
  if (landing) ui.advanceSelectedFile(file);
  else ui.selectFile(file);
}

/** Bumped by every walk change, so a prefilter that awaited across one can tell
 *  (a field compare would miss an idle → stop → idle round trip). */
let walkEpoch = 0;

/** The walk generation, for a continuation that must tell whether the walk it
 *  started under is still the one armed (ConflictResolveView's accept). */
export function walkGeneration(): number {
  return walkEpoch;
}

/** A prefilter's identity, with the walk and ui epochs it claimed at the press.
 *  A seeded run (a mount, not a press) claims no ui epoch. */
type PrefilterRun = {
  scope: string;
  key: string;
  epoch: number;
  uiEpoch: number | null;
};
/** The live prefilter, or null when none is reading. Released the moment it
 *  stops being live (`releaseDeadRun`), so the banner can be pressed again. */
let prefilterRun: PrefilterRun | null = null;

/** A run is live while no walk change and, for a pressed run, no user
 *  navigation came after its press: either one means the user moved on, and
 *  landing the walk would override them. */
function isLive(run: PrefilterRun): boolean {
  return (
    run.epoch === walkEpoch &&
    (run.uiEpoch === null ||
      run.uiEpoch === useUiStore.getState().interactionEpoch)
  );
}

/** Drops a prefilter that is no longer live and its hold. Its continuation
 *  sees `prefilterRun !== run` and leaves the flag alone. */
function releaseDeadRun() {
  if (prefilterRun === null || isLive(prefilterRun)) return;
  prefilterRun = null;
  useConflictResolve.setState({ prefiltering: null });
}

/** The refusal a rejected read stands for, or a rethrow so `partition` queues
 *  it: only a refusal no retry can heal skips the file. */
function refusalRead(e: unknown): PrefilterRead {
  const refused =
    isAppError(e) && e.kind === "invalidArgument"
      ? sidesRefusal(
          appErrorDetail(e.kind, e.message),
          conflictPathRefusal(e.kind, presentError(e).summary),
        )
      : null;
  if (refused === null) throw e;
  return { refused };
}

type Split = ReturnType<typeof partition>;

/** A single file is checked only for being already resolved: anything else it
 *  hits is the walk's own blocked screen to explain. A failed read queues it. */
async function singleFileSplit(scope: string, path: string): Promise<Split> {
  const resolved = await conflictSides(scope, path, []).then(
    noLongerConflicted,
    () => false,
  );
  return resolved
    ? { queued: [], skipped: [{ path, reason: "resolved" }] }
    : { queued: [path], skipped: [] };
}

/** Reads every file's sides in chunks, with the exclude list the walk itself
 *  builds; null once `stale()` says the run was superseded. A failed exclude
 *  read degrades to no patterns, so it can only let files through. */
async function prefilterSplit(
  scope: string,
  paths: string[],
  stale: () => boolean,
): Promise<Split | null> {
  const exclude = await loadSettings()
    .then((settings) =>
      aiExcludePatterns(scope, settings.aiIgnorePatterns, {
        tolerateRepoReadError: true,
      }),
    )
    .catch((): string[] => []);
  if (stale()) return null;
  // Index-aligned with `paths`: chunks run in order and append in order.
  const reads: PromiseSettledResult<PrefilterRead>[] = [];
  for (let i = 0; i < paths.length; i += SIDES_READ_CHUNK) {
    const chunk = paths.slice(i, i + SIDES_READ_CHUNK);
    reads.push(
      ...(await Promise.allSettled(
        chunk.map((p) =>
          conflictSides(scope, p, exclude).then(
            (s): PrefilterRead => ({
              undecodable: s.undecodable,
              workingUndecodable: s.workingUndecodable,
              aiIgnored: s.aiIgnored,
              resolved: noLongerConflicted(s),
            }),
            refusalRead,
          ),
        ),
      )),
    );
    if (stale()) return null;
  }
  return partition(paths, reads);
}

export const useConflictResolve = create<ConflictResolveState>()(
  (set, get) => ({
    activePath: null,
    queue: [],
    scopePath: null,
    prefiltering: null,

    startOne: (path, scope) => {
      walkEpoch++;
      releaseDeadRun();
      set({ activePath: path, queue: [], scopePath: scope });
      selectConflicted(path, scope);
    },

    startAll: (paths, scope, opts) => {
      if (paths.length === 0) return;
      const seeded = opts?.seeded === true;
      // Ahead of the single-file arm, so a repeat of any size stays a no-op.
      const key = JSON.stringify([...paths].sort());
      if (
        prefilterRun?.scope === scope &&
        prefilterRun.key === key &&
        isLive(prefilterRun)
      ) {
        return;
      }
      // A press is the request: bump here, since a selection landing after the
      // reads would bump late and retire whatever the user did meanwhile.
      if (!seeded) useUiStore.getState().noteUserInteraction();
      const run: PrefilterRun = {
        scope,
        key,
        epoch: ++walkEpoch,
        uiEpoch: seeded ? null : useUiStore.getState().interactionEpoch,
      };
      prefilterRun = run;
      // The generation bump above keeps an older walk's accept from advancing
      // into this run. A file of this set already on screen in this tree keeps
      // its session; anything else is cleared at the press.
      const { activePath, scopePath } = get();
      const keep =
        scopePath === scope &&
        activePath !== null &&
        paths.includes(activePath);
      set(
        keep
          ? { prefiltering: scope, queue: [] }
          : {
              prefiltering: scope,
              activePath: null,
              queue: [],
              scopePath: null,
            },
      );
      const stale = () => prefilterRun !== run || !isLive(run);
      void (async () => {
        try {
          const split =
            paths.length === 1
              ? await singleFileSplit(scope, paths[0])
              : await prefilterSplit(scope, paths, stale);
          if (split === null || stale()) return;
          const line = prefilterToast({ total: paths.length, ...split });
          if (line !== null) toast.info(line);
          if (split.queued.length === 0) {
            // The kept session isn't part of a walk anymore.
            if (keep) get().stop();
            return;
          }
          // The session kept on screen goes first, so it isn't torn down.
          const order =
            keep && activePath !== null && split.queued.includes(activePath)
              ? [activePath, ...split.queued.filter((p) => p !== activePath)]
              : split.queued;
          const [first, ...rest] = order;
          walkEpoch++;
          set({ activePath: first, queue: rest, scopePath: scope });
          selectConflicted(first, scope, true);
        } finally {
          // A superseding run, a release or a repo switch already owns the flag.
          if (prefilterRun === run) {
            prefilterRun = null;
            set({ prefiltering: null });
          }
        }
      })();
    },

    advance: (opts) => {
      walkEpoch++;
      releaseDeadRun();
      const { queue, scopePath } = get();
      if (queue.length === 0) {
        set({ activePath: null, queue: [], scopePath: null });
        return;
      }
      const [next, ...rest] = queue;
      set({ activePath: next, queue: rest });
      selectConflicted(next, scopePath, opts?.landing === true);
    },

    stop: () => {
      walkEpoch++;
      releaseDeadRun();
      set({ activePath: null, queue: [], scopePath: null });
    },

    retire: (scope) => {
      // A live prefilter's tree holds the walk too (its press cleared any
      // other), so bumping here never moves another tree's accept.
      if (get().scopePath !== scope && prefilterRun?.scope !== scope) return;
      walkEpoch++;
      releaseDeadRun();
      set({ activePath: null, queue: [], scopePath: null });
    },
  }),
);

// A walk belongs to one tree and every reader gates on `scopePath`, so no other
// surface can adopt it — a tab switch leaves it armed (an `<Activity>`-hidden view
// cancels its stream on effect cleanup and restarts it on show). A repo switch still
// ends it: this store is separate, so the ui store's CROSS_REPO_RESET can't reach it.
// Subscriptions fire synchronously inside the ui setter, ahead of the commit that
// flips visibility. A prefilter still reading is dropped too, and its hold released;
// any other navigation releases a pressed run's hold the moment it goes stale.
useUiStore.subscribe((s, prev) => {
  if (s.repoPath === prev.repoPath) {
    if (s.interactionEpoch !== prev.interactionEpoch) releaseDeadRun();
    return;
  }
  walkEpoch++;
  prefilterRun = null;
  const { activePath, queue, prefiltering } = useConflictResolve.getState();
  if (activePath !== null || queue.length > 0 || prefiltering !== null) {
    useConflictResolve.setState({
      activePath: null,
      queue: [],
      scopePath: null,
      prefiltering: null,
    });
  }
});
