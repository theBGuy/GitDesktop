import {
  type Query,
  type QueryCache,
  type QueryClient,
  type QueryKey,
  useQueryClient,
} from "@tanstack/react-query";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { gitFetchRemote } from "@/lib/git/api";
import { remoteBranchesOptions, repoKeys } from "@/lib/git/queries";
import {
  readStraddlesSettle,
  straddleOutcome,
} from "@/lib/git/queries/write-settle";
import { isOfflineNow } from "@/lib/offline-writes";
import { useMutation } from "@/lib/started-mutation";
import { useUiStore } from "@/lib/stores/ui";
import { useOnline } from "@/lib/use-online";

/** `comparing`: a pick's fetch finished and the reads that decide Create are
 *  re-reading; the stamp still holds Create and dims the lists. */
export type CompareFetchPhase =
  | "fetching"
  | "comparing"
  | "failed"
  | "offline"
  | "done";

/** One remote fetch Compare started, stamped when it started. The panel paints
 *  a stamp only for its own repo and only while its pick is still the current
 *  one, so a settle that lost either never shows. */
export interface CompareFetchStamp {
  repoPath: string;
  remote: string;
  /** The stored pick that asked for it; null for the add-upstream follow-up,
   *  which changes no pick and so never dims the lists. */
  pickedValue: string | null;
  currentBranch: string | null;
  pickEpoch: number;
  phase: CompareFetchPhase;
  /** Fired or failed while offline: the next reconnect re-fires it once and
   *  the re-fire's fresh stamp clears the mark, so an `<Activity>` effect
   *  replay finds nothing left to fire. */
  parked: boolean;
}

export interface CompareFetchRequest {
  repo: string;
  remote: string;
  pickedValue: string | null;
  currentBranch: string | null;
}

/** The CURRENT pick's stamp, still running or parked: a follow-up must not
 *  take it over, or its hold, its line and its reconnect fetch would go. A
 *  superseded pick's stamp shows nothing, so the follow-up takes the slot. */
function isLivePick(
  s: CompareFetchStamp | null,
  repo: string,
  pick: string | null,
): boolean {
  return (
    s !== null &&
    s.repoPath === repo &&
    s.pickedValue !== null &&
    s.pickedValue === pick &&
    (s.phase === "fetching" || s.phase === "comparing" || s.parked)
  );
}

/** The current pick's line, live or failed: a waiting follow-up failure never
 *  replaces it, so the pick keeps its own Retry. */
function holdsPickLine(
  s: CompareFetchStamp | null,
  repo: string,
  pick: string | null,
): boolean {
  return (
    isLivePick(s, repo, pick) ||
    (s !== null &&
      s.repoPath === repo &&
      s.pickedValue !== null &&
      s.pickedValue === pick &&
      s.phase === "failed")
  );
}

// Repo changes, counted at the store: a hidden `<Activity>` subtree runs no
// effects, so a hook-side watch would miss a round trip made while hidden.
let repoVisits = 0;
useUiStore.subscribe((state, prev) => {
  if (state.repoPath !== prev.repoPath) repoVisits += 1;
});

// In-flight fetches by repo and remote, read only at fire time: a pick on a
// remote already being fetched joins that fetch instead of starting another.
// Each resolves to the reads that straddled its settle.
const inflight = new Map<string, Promise<ReadonlySet<Query>>>();

/** What `fetch --prune --no-prune-tags <remote>` can move, through the exported
 *  key builders: remote refs, upstream tracking state on branches and HEAD,
 *  unpushed counts, history markers, rewrite verdicts (they read upstream tips)
 *  and every comparison spelled against one of this remote's refs. The tags
 *  list has no exported key, so it keeps its own staleTime; working-tree, stash
 *  and divergence reads read local state a fetch doesn't touch. Returns the
 *  remote-list and comparison reads that straddled the settle
 *  ({@link readStraddlesSettle}), judged before the invalidation restarts the
 *  rest: their answers can predate the fetch. */
function invalidateAfterFetch(
  queryClient: QueryClient,
  repo: string,
  remote: string,
): ReadonlySet<Query> {
  const refPrefix = `refs/remotes/${remote}/`;
  const compareSegment = repoKeys.compare(repo, "", "")[2];
  const isComparison = (queryKey: QueryKey) =>
    queryKey[2] === compareSegment &&
    queryKey.some(
      (seg) => typeof seg === "string" && seg.startsWith(refPrefix),
    );
  const remoteListKey = remoteBranchesOptions(repo).queryKey;
  const straddling = new Set(
    queryClient
      .getQueryCache()
      .findAll({ queryKey: repoKeys.all(repo) })
      .filter(
        (query) =>
          (isComparison(query.queryKey) ||
            (query.queryKey.length === remoteListKey.length &&
              remoteListKey.every((seg, i) => query.queryKey[i] === seg))) &&
          readStraddlesSettle(query),
      ),
  );
  for (const queryKey of [
    remoteListKey,
    repoKeys.branches(repo),
    repoKeys.status(repo),
    repoKeys.unpushedCount(repo),
    repoKeys.unpushedMessages(repo),
    repoKeys.log(repo),
    repoKeys.commits(repo),
    repoKeys.rewriteStatus(repo),
  ])
    void queryClient.invalidateQueries({ queryKey });
  void queryClient.invalidateQueries({
    queryKey: repoKeys.all(repo),
    predicate: ({ queryKey }) => isComparison(queryKey),
  });
  return straddling;
}

/** Whether a fetching read landed (true) or left the cache (false). */
function landing(cache: QueryCache, query: Query): Promise<boolean> {
  if (query.state.fetchStatus !== "fetching") return Promise.resolve(true);
  return new Promise((resolve) => {
    const unsubscribe = cache.subscribe((event) => {
      if (event.query !== query) return;
      const outcome = straddleOutcome(event);
      if (outcome === null) return;
      unsubscribe();
      resolve(outcome === "landed");
    });
  });
}

/**
 * Settles once each cached query of `keys` has been read after the fetch: a
 * read the invalidation restarted is joined; a straddling one is read again
 * once it lands; one the invalidation only marked stale (no enabled observer,
 * e.g. Compare hidden) is read now. Those two re-reads call `query.fetch`,
 * since `refetchQueries` skips a query whose observers are all disabled. Only
 * the reads that decide a pick's Create hold and pruned line are passed, so a
 * slow unrelated read (an open file diff) never holds the stamp. Never
 * rejects: resolves, per key, null when its read after the fetch succeeded
 * (or it had none to make), else the `dataUpdatedAt` its failure left cached,
 * sampled as it failed so a later success elsewhere can't pass as it; the
 * read's own arms report its error.
 */
async function settleFreshReads(
  queryClient: QueryClient,
  straddling: ReadonlySet<Query>,
  keys: readonly QueryKey[],
): Promise<(number | null)[]> {
  const cache = queryClient.getQueryCache();
  const read = (query: Query) =>
    query.fetch().then(
      () => null,
      () => query.state.dataUpdatedAt,
    );
  return Promise.all(
    keys.map(async (queryKey) => {
      const query = cache.find({ queryKey, exact: true });
      if (query === undefined) return null;
      if (straddling.has(query))
        return (await landing(cache, query)) ? read(query) : null;
      if (query.state.fetchStatus === "fetching") {
        await queryClient.refetchQueries(
          { queryKey, exact: true },
          { cancelRefetch: false },
        );
        return query.state.status === "error"
          ? query.state.dataUpdatedAt
          : null;
      }
      // No enabled observer: the invalidation only marked it stale.
      if (query.state.isInvalidated) return read(query);
      return null;
    }),
  );
}

/** A pick's post-fetch comparison read failed: `over` is the `dataUpdatedAt`
 *  of the answer it left cached (0 for none), which predates the fetch, so
 *  Create holds until a newer answer lands. Kept apart from the stamp, whose
 *  slot a follow-up can take over. */
export interface CompareFailedRead {
  repoPath: string;
  pickedValue: string;
  currentBranch: string;
  over: number;
}

/**
 * Fetches a remote for the Compare picker, single-flight per repo and remote.
 * Never toasts: the status line is the surface. A fire while offline doesn't
 * run; it parks in the stamp, and reconnect re-fires it once while that pick is
 * still current (`currentPick`) in the same repo. `currentPickRemote` is that
 * pick's canonical remote now, which the reconnect fetches: a pick parked under
 * a fallback split may resolve to another remote once the remotes list answers.
 */
export function useCompareRemoteFetch(
  repoPath: string,
  currentPick: string | null,
  currentPickRemote: string | null,
) {
  const queryClient = useQueryClient();
  const [stamp, setStamp] = useState<CompareFetchStamp | null>(null);
  // A parked add-upstream follow-up a pick hid: it still fetches once on
  // reconnect, with no line and no stamp, so the remote isn't left unfetched.
  const [hiddenFollowUp, setHiddenFollowUp] = useState<{
    repoPath: string;
    remote: string;
  } | null>(null);
  // An unseen follow-up that failed online: its failed line and Retry wait
  // for the live pick to free the slot, then take it.
  const [failedFollowUp, setFailedFollowUp] = useState<{
    repoPath: string;
    remote: string;
  } | null>(null);
  const [failedRead, setFailedRead] = useState<CompareFailedRead | null>(null);
  // A repo change drops whatever stamp the last repo left, a parked one
  // included: its line and its reconnect re-fire belong to that repo.
  const [stampRepo, setStampRepo] = useState(repoPath);
  if (stampRepo !== repoPath) {
    setStampRepo(repoPath);
    setStamp(null);
    setHiddenFollowUp(null);
    setFailedFollowUp(null);
    setFailedRead(null);
  }
  // Counts pick fires: a settle a newer pick fire started after records no
  // failed read.
  const pickFires = useRef(0);
  const epoch = useRef(0);
  const fetchRemote = useMutation({
    mutationKey: ["compare-fetch-remote", repoPath],
    mutationFn: (vars: { repo: string; remote: string }) =>
      gitFetchRemote(vars.repo, vars.remote),
  });

  function run(repo: string, remote: string): Promise<ReadonlySet<Query>> {
    const key = `${repo}\0${remote}`;
    const joined = inflight.get(key);
    if (joined) return joined;
    const tracked = fetchRemote
      .mutateAsync({ repo, remote })
      .then(() => invalidateAfterFetch(queryClient, repo, remote))
      .finally(() => {
        if (inflight.get(key) === tracked) inflight.delete(key);
      });
    inflight.set(key, tracked);
    return tracked;
  }

  // The slot as last written and the committed pick with its canonical remote,
  // for fire-time and refire-time reads: fire runs from closures an await can
  // leave renders behind.
  const slot = useRef(stamp);
  const pickNow = useRef(currentPick);
  const pickRemoteNow = useRef(currentPickRemote);
  useLayoutEffect(() => {
    slot.current = stamp;
    pickNow.current = currentPick;
    pickRemoteNow.current = currentPickRemote;
  }, [stamp, currentPick, currentPickRemote]);

  // Moves with every pick and repo change: an unseen follow-up's failure that
  // lands after one describes nothing on screen any more, so it is dropped.
  const picks = useRef(0);
  const followUpGen = () => picks.current + repoVisits;

  /** An unseen follow-up's failure. Offline it re-parks, keeping its reconnect
   *  fetch whatever happened since; online it waits for the slot, since nothing
   *  else fetches that remote again, unless a pick or repo change since its
   *  start retired it. */
  function keepFailure(repo: string, remote: string, gen: number) {
    if (useUiStore.getState().repoPath !== repo) return;
    if (isOfflineNow()) setHiddenFollowUp({ repoPath: repo, remote });
    else if (followUpGen() === gen)
      setFailedFollowUp({ repoPath: repo, remote });
  }

  async function fire(req: CompareFetchRequest) {
    // Over the current pick's line, live or failed, the follow-up runs unseen:
    // online at once, offline parked as the hidden follow-up reconnect fetches.
    if (
      req.pickedValue === null &&
      holdsPickLine(slot.current, req.repo, pickNow.current)
    ) {
      const gen = followUpGen();
      if (isOfflineNow()) {
        setHiddenFollowUp({ repoPath: req.repo, remote: req.remote });
        return;
      }
      await run(req.repo, req.remote).catch(() =>
        keepFailure(req.repo, req.remote, gen),
      );
      return;
    }
    const pickFire = req.pickedValue === null ? null : ++pickFires.current;
    if (pickFire !== null) setFailedRead(null);
    epoch.current += 1;
    const next: CompareFetchStamp = {
      repoPath: req.repo,
      remote: req.remote,
      pickedValue: req.pickedValue,
      currentBranch: req.currentBranch,
      pickEpoch: epoch.current,
      phase: "fetching",
      parked: false,
    };
    const started = isOfflineNow()
      ? { ...next, phase: "offline" as const, parked: true }
      : next;
    slot.current = started;
    setStamp(started);
    if (started !== next) return;
    let failed = false;
    try {
      const straddling = await run(req.repo, req.remote);
      // A pick's stamp holds Create until its comparison and the remote list
      // answer from after the fetch.
      // A superseded fire's reads decide nothing on screen.
      if (
        req.pickedValue !== null &&
        req.currentBranch !== null &&
        epoch.current === next.pickEpoch &&
        useUiStore.getState().repoPath === req.repo
      ) {
        setStamp((s) =>
          s?.pickEpoch === next.pickEpoch && s.phase === "fetching"
            ? { ...s, phase: "comparing" }
            : s,
        );
        const [, failedOver] = await settleFreshReads(queryClient, straddling, [
          remoteBranchesOptions(req.repo).queryKey,
          repoKeys.compare(req.repo, req.pickedValue, req.currentBranch),
        ]);
        if (
          failedOver !== null &&
          pickFire === pickFires.current &&
          useUiStore.getState().repoPath === req.repo
        )
          setFailedRead({
            repoPath: req.repo,
            pickedValue: req.pickedValue,
            currentBranch: req.currentBranch,
            over: failedOver,
          });
      }
    } catch {
      failed = true;
    }
    const liveRepo = useUiStore.getState().repoPath;
    setStamp((s) => {
      if (s === null || s.pickEpoch !== next.pickEpoch) return s;
      if (liveRepo !== next.repoPath) return null;
      if (!failed) return { ...s, phase: "done" };
      const parked = isOfflineNow();
      return { ...s, phase: parked ? "offline" : "failed", parked };
    });
  }

  /** Any pick retires the add-upstream follow-up's line, and one still
   *  waiting for the slot: it described no pick. A parked one keeps its
   *  reconnect fetch, unseen. */
  function clearFollowUp() {
    if (stamp?.pickedValue === null && stamp.parked)
      setHiddenFollowUp({
        repoPath: stamp.repoPath,
        remote: stamp.remote,
      });
    picks.current += 1;
    setFailedFollowUp(null);
    setStamp((s) => (s?.pickedValue === null ? null : s));
  }

  const online = useOnline();
  const refireParked = useEffectEvent(() => {
    if (!stamp?.parked || stamp.repoPath !== repoPath) return;
    if (stamp.pickedValue !== null && stamp.pickedValue !== currentPick) return;
    // A pick refetches its identity as it reads now; a follow-up names its own.
    const pickRemote = pickRemoteNow.current;
    void fire({
      repo: stamp.repoPath,
      remote:
        stamp.pickedValue !== null && pickRemote !== null
          ? pickRemote
          : stamp.remote,
      pickedValue: stamp.pickedValue,
      currentBranch: stamp.currentBranch,
    });
  });
  const parkedEpoch = stamp?.parked ? stamp.pickEpoch : null;
  useEffect(() => {
    if (online && parkedEpoch !== null) refireParked();
  }, [online, parkedEpoch]);

  // Single-flight joins a replayed effect's second run onto the first.
  const refireHidden = useEffectEvent(() => {
    if (hiddenFollowUp === null || hiddenFollowUp.repoPath !== repoPath) return;
    const { repoPath: repo, remote } = hiddenFollowUp;
    setHiddenFollowUp(null);
    // A refire is a new attempt: picks before it retired nothing it reports.
    const gen = followUpGen();
    run(repo, remote).catch(() => keepFailure(repo, remote, gen));
  });
  useEffect(() => {
    if (online && hiddenFollowUp !== null) refireHidden();
  }, [online, hiddenFollowUp]);

  // A kept failure takes the slot as the follow-up's failed line once the
  // current pick's line is gone (its fetch done or the pick left); its Retry
  // re-fires the follow-up.
  const slotFree = !holdsPickLine(stamp, repoPath, currentPick);
  const promoteFailure = useEffectEvent(() => {
    if (failedFollowUp === null || failedFollowUp.repoPath !== repoPath) return;
    if (holdsPickLine(slot.current, repoPath, pickNow.current)) return;
    epoch.current += 1;
    const promoted: CompareFetchStamp = {
      repoPath,
      remote: failedFollowUp.remote,
      pickedValue: null,
      currentBranch: null,
      pickEpoch: epoch.current,
      phase: "failed",
      parked: false,
    };
    slot.current = promoted;
    setStamp(promoted);
    setFailedFollowUp(null);
  });
  useEffect(() => {
    if (slotFree && failedFollowUp !== null) promoteFailure();
  }, [slotFree, failedFollowUp]);

  return { stamp, failedRead, fire, clearFollowUp };
}
