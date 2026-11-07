import { useSyncExternalStore } from "react";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { failedSinceLastSuccess } from "@/features/conversations/remote-section-state";
import { useAddRemote, useForgeStatus, useRemotes } from "@/lib/git/queries";
import { useLensGate } from "@/lib/repo-lens/queries";
import { useSettings } from "@/lib/settings/queries";
import { originNoteFor } from "@/lib/stores/notifications";
import { toastError, toastErrorWithNote } from "@/lib/toast";

// Repos with an add running, shared by every mount: the add observer is
// unpinned, so neither its isPending nor one per-mount slot can tell which
// repo a running add belongs to across repo switches.
const addsInFlight = new Set<string>();
const addListeners = new Set<() => void>();
function subscribeAdds(listener: () => void) {
  addListeners.add(listener);
  return () => {
    addListeners.delete(listener);
  };
}
function setAddInFlight(repo: string, running: boolean) {
  if (running) addsInFlight.add(repo);
  else addsInFlight.delete(repo);
  for (const listener of addListeners) listener();
}

/**
 * The offer to add an `upstream` remote to a GitHub fork cloned without one: the
 * lens gate is off there, so the pinned origin path would silently open PRs on
 * the fork. Shared by the Create PR dialog's card and any other surface that
 * offers the same remote.
 */
export function useAddUpstreamOffer(repoPath: string): {
  canOffer: boolean;
  /** `canOffer` is an answer: every input it reads answered, or one that did
   *  already rules the offer out. An errored read is not an answer, even over
   *  cached data. */
  settled: boolean;
  /** Not settled because a read failed, held while it retries (a poll or
   *  `retry`) so a host's failed arm doesn't blink; `retry` re-reads the
   *  failed ones. */
  failed: boolean;
  /** `failed` rests on the forge read alone, the one input a reconnect re-runs;
   *  a failed local read (remotes, settings) still wants `retry` offline. */
  failedOnForgeOnly: boolean;
  retry: () => void;
  forkParent: string | null;
  /** An add started in THIS repo is running. */
  pending: boolean;
  addUpstream: () => Promise<{ ok: boolean }>;
} {
  const forge = useForgeStatus(repoPath);
  const lensGate = useLensGate(repoPath);
  const remotes = useRemotes(repoPath);
  const settings = useSettings();
  const isGithub = forge.data?.provider === "github";
  const forkRecord = settings.data?.recentRepos.find(
    (r) => r.path === repoPath,
  );
  const forkParent = forkRecord?.forkParent ?? null;
  // Only when: GitHub, the lens gate is OFF, settings have loaded (no flash), the
  // repo is a fork, AND the parent slug is known. A fork whose parent is
  // unreadable renders nothing rather than a broken hint. The remotes check is
  // separate from the gate, which also needs gh auth: a signed-out fork that
  // already has the remote must not be offered it again. Like `answeredNo`, it
  // reads only a successful remotes read: a failed refresh over a cached list
  // is no answer.
  const canOffer =
    isGithub &&
    !lensGate &&
    settings.isSuccess &&
    forkRecord?.isFork === true &&
    forkParent !== null &&
    remotes.isSuccess &&
    !remotes.data.includes("upstream");
  // One successful read that already rules the offer out answers it, whatever
  // the other reads did.
  const answeredNo =
    lensGate ||
    (forge.isSuccess && forge.data.provider !== "github") ||
    (settings.isSuccess &&
      (forkRecord?.isFork !== true || forkParent === null)) ||
    (remotes.isSuccess && remotes.data.includes("upstream"));
  const inputs = [forge, remotes, settings];
  const settled = answeredNo || inputs.every((q) => q.isSuccess);
  const failed = !answeredNo && inputs.some(failedSinceLastSuccess);
  const failedOnForgeOnly =
    failed &&
    !failedSinceLastSuccess(remotes) &&
    !failedSinceLastSuccess(settings);
  function retry() {
    for (const q of inputs) if (q.isError) void q.refetch();
  }
  const addRemote = useAddRemote(repoPath);
  const pending = useSyncExternalStore(subscribeAdds, () =>
    addsInFlight.has(repoPath),
  );
  // Awaited rather than per-call callbacks: the host can close or unmount
  // mid-write, and react-query drops those once the observer has no listeners.
  // On success the broad invalidation refreshes remotes → `useLensGate` flips
  // true, so fork-target surfaces light up live.
  async function addUpstream(): Promise<{ ok: boolean }> {
    if (!forkParent || addsInFlight.has(repoPath)) return { ok: false };
    const addIn = repoPath;
    setAddInFlight(addIn, true);
    // Derive the host — on GitHub Enterprise `isGithub` still holds, and a
    // hardcoded github.com would add a wrong-host remote that fails later.
    const ghHost = forge.data?.host || "github.com";
    try {
      await addRemote.mutateAsync({
        name: "upstream",
        url: `https://${ghHost}/${forkParent}.git`,
      });
      return { ok: true };
    } catch (e) {
      // A failure that lands after the user left names the repo it was for.
      const note = originNoteFor(addIn);
      if (note === undefined) toastError(e);
      else toastErrorWithNote(e, note);
      return { ok: false };
    } finally {
      setAddInFlight(addIn, false);
    }
  }
  return {
    canOffer,
    settled,
    failed,
    failedOnForgeOnly,
    retry,
    forkParent,
    pending,
    addUpstream,
  };
}

const ADDING_REASON = "Adding the upstream remote";

/** The Create PR dialog's offer box: names the parent and adds the remote. */
export function AddUpstreamOfferCard({
  forkParent,
  pending,
  onAdd,
}: {
  forkParent: string;
  pending: boolean;
  onAdd: () => void;
}) {
  return (
    <div className="space-y-1.5 rounded-none bg-muted/40 p-2.5 ring-1 ring-foreground/10">
      <p className="text-xs text-muted-foreground">
        This repository is a fork of{" "}
        <span className="font-mono text-foreground/80">{forkParent}</span>. Add
        an upstream remote to open pull requests against{" "}
        <span className="font-mono text-foreground/80">{forkParent}</span>.
      </p>
      <DisabledReasonButton
        type="button"
        variant="outline"
        size="xs"
        disabled={pending}
        reason={pending ? ADDING_REASON : null}
        onClick={onAdd}
      >
        {pending ? "Adding upstream remote…" : "Add upstream remote"}
      </DisabledReasonButton>
    </div>
  );
}
