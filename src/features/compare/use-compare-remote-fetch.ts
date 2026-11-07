import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { gitFetchRemote } from "@/lib/git/api";
import { remoteBranchesOptions, repoKeys } from "@/lib/git/queries";
import { isOfflineNow } from "@/lib/offline-writes";
import { useMutation } from "@/lib/started-mutation";
import { useUiStore } from "@/lib/stores/ui";
import { useOnline } from "@/lib/use-online";

export type CompareFetchPhase = "fetching" | "failed" | "offline" | "done";

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

// In-flight fetches by repo and remote, read only at fire time: a pick on a
// remote already being fetched joins that fetch instead of starting another.
const inflight = new Map<string, Promise<void>>();

/** What `fetch --prune --no-prune-tags <remote>` can move, through the exported
 *  key builders: remote refs, upstream tracking state on branches and HEAD,
 *  unpushed counts, history markers, rewrite verdicts (they read upstream tips)
 *  and every comparison spelled against one of this remote's refs. The tags
 *  list has no exported key, so it keeps its own staleTime; working-tree, stash
 *  and divergence reads read local state a fetch doesn't touch. */
function invalidateAfterFetch(
  queryClient: QueryClient,
  repo: string,
  remote: string,
) {
  for (const queryKey of [
    remoteBranchesOptions(repo).queryKey,
    repoKeys.branches(repo),
    repoKeys.status(repo),
    repoKeys.unpushedCount(repo),
    repoKeys.unpushedMessages(repo),
    repoKeys.log(repo),
    repoKeys.commits(repo),
    repoKeys.rewriteStatus(repo),
  ])
    void queryClient.invalidateQueries({ queryKey });
  const refPrefix = `refs/remotes/${remote}/`;
  const compareSegment = repoKeys.compare(repo, "", "")[2];
  void queryClient.invalidateQueries({
    queryKey: repoKeys.all(repo),
    predicate: ({ queryKey }) =>
      queryKey[2] === compareSegment &&
      queryKey.some(
        (seg) => typeof seg === "string" && seg.startsWith(refPrefix),
      ),
  });
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
  // A repo change drops whatever stamp the last repo left, a parked one
  // included: its line and its reconnect re-fire belong to that repo.
  const [stampRepo, setStampRepo] = useState(repoPath);
  if (stampRepo !== repoPath) {
    setStampRepo(repoPath);
    setStamp(null);
    setHiddenFollowUp(null);
  }
  const epoch = useRef(0);
  const fetchRemote = useMutation({
    mutationKey: ["compare-fetch-remote", repoPath],
    mutationFn: (vars: { repo: string; remote: string }) =>
      gitFetchRemote(vars.repo, vars.remote),
  });

  function run(repo: string, remote: string): Promise<void> {
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

  /** The CURRENT pick's stamp, still running or parked: a follow-up must not
   *  take it over, or its hold, its line and its reconnect fetch would go. A
   *  superseded pick's stamp shows nothing, so the follow-up takes the slot. */
  function holdsLivePick(repo: string): boolean {
    const s = slot.current;
    return (
      s !== null &&
      s.repoPath === repo &&
      s.pickedValue !== null &&
      s.pickedValue === pickNow.current &&
      (s.phase === "fetching" || s.parked)
    );
  }

  async function fire(req: CompareFetchRequest) {
    // Over the current pick's live fetch the follow-up runs unseen: online at
    // once, offline parked as the hidden follow-up reconnect fetches.
    if (req.pickedValue === null && holdsLivePick(req.repo)) {
      const hide = () =>
        setHiddenFollowUp({ repoPath: req.repo, remote: req.remote });
      if (isOfflineNow()) {
        hide();
        return;
      }
      await run(req.repo, req.remote).catch(() => {
        if (isOfflineNow() && useUiStore.getState().repoPath === req.repo)
          hide();
      });
      return;
    }
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
      await run(req.repo, req.remote);
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

  /** Any pick retires the add-upstream follow-up's line: it described no pick.
   *  A parked one keeps its reconnect fetch, unseen. */
  function clearFollowUp() {
    if (stamp?.pickedValue === null && stamp.parked)
      setHiddenFollowUp({ repoPath: stamp.repoPath, remote: stamp.remote });
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
    run(repo, remote).catch(() => {
      if (isOfflineNow() && useUiStore.getState().repoPath === repo)
        setHiddenFollowUp({ repoPath: repo, remote });
    });
  });
  useEffect(() => {
    if (online && hiddenFollowUp !== null) refireHidden();
  }, [online, hiddenFollowUp]);

  return { stamp, fire, clearFollowUp };
}
