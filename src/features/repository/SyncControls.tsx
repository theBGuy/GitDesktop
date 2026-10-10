import {
  ArrowDownIcon,
  ArrowsClockwiseIcon,
  ArrowUpIcon,
  CaretDownIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { useRelativeNow } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { useFocusOnControlsSwap } from "@/features/diff/use-hidden-trigger-focus";
import {
  forgeDetectForkPrForBranch,
  type PullMode,
  type PushGuard,
} from "@/lib/git/api";
import {
  useAutoFetch,
  useFetchStatusStore,
  useLastFetchedAt,
} from "@/lib/git/auto-fetch";
import {
  useBranchRewriteStatus,
  useFetchRemote,
  useHardResetToCommit,
  usePull,
  usePush,
  useRemotes,
  useRepoStatus,
  useUpdateFromUpstream,
} from "@/lib/git/queries";
import type { ForkPrMatch } from "@/lib/git/types";
import {
  bindingToAriaKeyshortcuts,
  formatBinding,
} from "@/lib/hotkeys/binding";
import { useEffectiveBindings, useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import {
  ACT_PENDING_REASON,
  OFFLINE_ITEM_REASON,
  refuseWhileOffline,
  useOfflineHold,
} from "@/lib/offline-writes";
import { useSettings } from "@/lib/settings/queries";
import { useConfirm } from "@/lib/stores/confirm";
import { landedIn, originNoteFor } from "@/lib/stores/notifications";
import { promotionBlocksCheckout } from "@/lib/stores/worktree-removal";
import { formatRelativeTime } from "@/lib/time";
import { toastError, toastErrorWithNote } from "@/lib/toast";
import { PROMOTION_BLOCKS_CHECKOUT } from "./checkout-copy";
import { ForkPrPublishGuard } from "./ForkPrPublishGuard";
import { PublishRepoControl, usePublishProviders } from "./PublishRepoControl";
import { deriveSyncControls, headFacts } from "./sync-controls-state";
import { usePullDropGuard } from "./usePullDropGuard";
import { useStashReapplyRecovery } from "./useStashReapplyRecovery";

/** What a force push fell back to, for the guarantees weaker than the intended
 *  `--force-with-lease --force-if-includes` pair. TOTAL on purpose: a new
 *  `PushGuard` variant has to fail the typecheck here rather than ship the bare
 *  "Force pushed" this table exists to stop overclaiming. Same two reasons the
 *  MCP `force_push` tool reports (mcp_server/write_git.rs) — keep the wording in
 *  step. */
const FORCE_PUSH_DEGRADED: Record<PushGuard, string | undefined> = {
  // The intended pair is what the plain confirmation already means.
  leaseAndIncludes: undefined,
  leaseOnlyOldGit:
    "Protected by the lease alone: this Git predates --force-if-includes.",
  leaseOnlyNoReflog:
    "Protected by the lease alone: the branch has no reflog for --force-if-includes to check.",
};

export function SyncControls({ repoPath }: { repoPath: string }) {
  const status = useRepoStatus(repoPath);
  const remotes = useRemotes(repoPath);
  const settings = useSettings();
  const fetchRemote = useFetchRemote(repoPath);
  const pull = usePull(repoPath);
  const push = usePush(repoPath);
  const updateUpstream = useUpdateFromUpstream(repoPath);
  const recovery = useStashReapplyRecovery(repoPath);
  // Shares that recovery: a decided re-run can still hit a dirty tree, and one
  // stash prompt on this surface is the whole point of handing it down.
  const pullDropGuard = usePullDropGuard(repoPath, recovery);
  // Read only from async continuations, never in render.
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const markFetched = useFetchStatusStore((s) => s.markFetched);
  const lastFetchedAt = useLastFetchedAt(repoPath);
  // Effective bindings drive the discoverability hints on the sync buttons:
  // the formatted combo is appended to each button's tooltip, and its ARIA
  // form goes on `aria-keyshortcuts`. `null` = user explicitly unbound → no
  // hint. These respect Settings → Keyboard rebindings for free.
  const bindings = useEffectiveBindings();
  const [forceConfirmOpen, setForceConfirmOpen] = useState(false);
  // The publish intercepted by the fork-PR guard. The branch is captured at
  // click time and travels with the match, so the dialog can only ever push the
  // branch the detection ran for.
  const [forkGuard, setForkGuard] = useState<{
    match: ForkPrMatch;
    branch: string;
  } | null>(null);
  // The repo the guard last opened in, kept past its close: the guard's own
  // fork push is still in flight then, and its `usePush` must not follow a
  // switch to the live repo.
  const [forkGuardRepo, setForkGuardRepo] = useState(repoPath);
  const [detecting, setDetecting] = useState(false);
  // This component survives repo switches (RepoHeader mounts unkeyed), so both
  // confirm dialogs close in the render that switches: a confirm left open
  // would push the live repo with the old one's branch and match. Reset in
  // render, since an effect would paint them open over the new repo first.
  const [dialogsRepo, setDialogsRepo] = useState(repoPath);
  if (dialogsRepo !== repoPath) {
    setDialogsRepo(repoPath);
    setForceConfirmOpen(false);
    setForkGuard(null);
  }

  // Data, never isPending/isFetching: undefined means unknown for THIS repo
  // (the reads carry no placeholder), and a refetch must not re-hold the bar.
  const head = status.data?.branch;
  const { diverged, detached } = headFacts(head);
  // Only a diverged branch has anything to classify, so the probe (several
  // rev-list spawns) never runs on the ordinary in-sync path.
  const rewrite = useBranchRewriteStatus(repoPath, head?.name ?? null, {
    enabled: diverged && !detached,
  });
  // `isFetching` matters as much as `diverged`: a repo-wide invalidation keeps
  // serving the previous answer while the refetch is in flight, and that answer
  // is the evidence a destructive confirm would quote.
  const rewriteData =
    diverged && !rewrite.isFetching ? rewrite.data : undefined;
  // The reflog verdict ALONE matches ordinary divergence too; only paired with
  // "no local commit lacks a patch-twin upstream" does it describe an upstream
  // that already carries this branch's work — and offering a reset while unique
  // work exists would destroy it.
  const remoteRebased =
    rewriteData?.remoteRewritten === true &&
    rewriteData.localOnly === 0 &&
    Boolean(rewriteData.upstreamTip);
  // Patch twins upstream AND commits without one: a reset would destroy the
  // latter, a merge would re-import the former beside the copies already there.
  // `patchEqual > 0` is strong evidence, not proof — two sides can apply the same
  // patch independently, or cherry-pick both ways, with no rewrite involved. This
  // arm only WITHHOLDS the merge, so its failure direction is inaction.
  const mixedRewrite =
    rewriteData?.remoteRewritten === true &&
    rewriteData.localOnly > 0 &&
    rewriteData.patchEqual > 0;
  // Commits a force push would keep and a reset would drop. This is NOT
  // rewrite-proof on its own — it counts the same under ordinary divergence,
  // where the advice it carries is equally correct.
  const localAtRisk =
    rewriteData?.remoteRewritten === true ? rewriteData.localOnly : 0;
  // True only where the status actually measured commits on the other side.
  const remoteAhead = rewriteData?.remoteOnly ?? 0;
  const hardReset = useHardResetToCommit(repoPath);
  const busy =
    fetchRemote.isPending ||
    pull.isPending ||
    push.isPending ||
    updateUpstream.isPending ||
    hardReset.isPending ||
    detecting ||
    recovery.pending ||
    pullDropGuard.pending;
  const onError = (e: unknown) => toastError(e);
  // Every network arm here (fetch, pull, push, update from upstream) holds
  // offline rather than park: a parked push or force push would land whenever
  // the connection returns. Reset to upstream is local and stays live.
  const offlineHold = useOfflineHold();
  const offlineSuffix = offlineHold ? ` (${OFFLINE_ITEM_REASON})` : "";
  const sync = deriveSyncControls({
    head,
    statusError: status.isError,
    remotes: remotes.data,
    busy,
    offlineHold,
    remoteRebased,
    mixedRewrite,
    localAtRisk,
  });
  const {
    noOrigin,
    hasOrigin,
    hasUpstream,
    canUpdateUpstream,
    aheadCount,
    behindCount,
    pushLabel,
    pullDescription,
    pushDescription,
  } = sync;
  // A repo with no `origin` (e.g. created locally in GitDesktop) can't push;
  // offer to create the hosted repo instead. Which providers can take it is
  // probed by usePublishProviders (there's no remote to detect one from).
  const publish = usePublishProviders(repoPath, noOrigin);
  // The cluster → Publish swap unmounts whichever sync button held focus.
  const controlsRef = useRef<HTMLDivElement>(null);
  useFocusOnControlsSwap(noOrigin, controlsRef);

  // One entry point for every fetch — manual (button/hotkey) and automatic —
  // so a successful fetch always records its freshness. Auto-fetches stay quiet
  // (a failed background fetch just retries next tick).
  async function doFetch(silent: boolean) {
    // Auto-fetch carries its own connectivity gate (auto-fetch.ts).
    if (!silent && refuseWhileOffline()) return;
    try {
      await fetchRemote.mutateAsync(undefined);
      markFetched(repoPath);
    } catch (e) {
      if (!silent) onError(e);
    }
  }

  // Opt-out periodic background fetch (Settings → General). Shares the fetch
  // mutation above, so the Fetch spinner covers it too.
  useAutoFetch({
    repoPath,
    enabled: settings.data?.autoFetch ?? false,
    intervalMs: Number(settings.data?.autoFetchInterval ?? "10") * 60_000,
    hasOrigin,
    busy,
    fetch: () => void doFetch(true),
  });

  // The Fetch tooltip is a plain attribute string, so the shared clock has to be
  // threaded in by hand — `<RelativeTime>` can't render there. It also keeps the
  // time honest while the window sits idle (the status poll only re-renders on
  // change).
  const now = useRelativeNow();

  // The live branch name, readable after an await: a handler's closure still
  // holds the `head` of the render that created it, which can't tell whether
  // HEAD moved during an async round-trip.
  const headNameRef = useRef(head?.name);
  useEffect(() => {
    headNameRef.current = head?.name;
  }, [head?.name]);

  const fetchTitle =
    lastFetchedAt === undefined
      ? "Fetch from origin"
      : `Last fetched ${formatRelativeTime(new Date(lastFetchedAt).toISOString(), now)}`;

  // One wording for the refusal, shared by the disabled menu item and the tooltip
  // the branch menu shows for the same shape.
  const mergeDuplicatesReason = `${head?.upstream} already carries these changes under different ids — a merge would duplicate them. Use Pull with rebase.`;

  // Tooltip = the button's description (or its bare label when synced +
  // undefined) with the effective shortcut appended, e.g. "Push (Ctrl+P)".
  // When the action is explicitly unbound (null), the title stays exactly
  // today's value — the raw description, possibly undefined. `aria-keyshortcuts`
  // carries the shortcut on the proper ARIA channel so it stays OUT of each
  // button's accessible name — for Push/Pull that name is the description-only
  // `aria-label`; Fetch pins its own to the same word as its visible label,
  // because below `md` that label is hidden and the volatile "Last fetched …"
  // title would otherwise become the name. Omitted when unbound.
  const pushBinding = bindings.get("push") ?? null;
  const pullBinding = bindings.get("pull") ?? null;
  const fetchBinding = bindings.get("fetch") ?? null;
  const pushTitle =
    pushBinding === null
      ? pushDescription
      : `${sync.pushName} (${formatBinding(pushBinding)})`;
  const pullTitle =
    pullBinding === null
      ? pullDescription
      : `${sync.pullName} (${formatBinding(pullBinding)})`;
  const fetchHintTitle =
    fetchBinding === null
      ? fetchTitle
      : `${fetchTitle} (${formatBinding(fetchBinding)})`;
  const pushKeyshortcuts =
    pushBinding === null ? undefined : bindingToAriaKeyshortcuts(pushBinding);
  const pullKeyshortcuts =
    pullBinding === null ? undefined : bindingToAriaKeyshortcuts(pullBinding);
  const fetchKeyshortcuts =
    fetchBinding === null ? undefined : bindingToAriaKeyshortcuts(fetchBinding);

  // The plain-success toast for a pull: ff-only stays silent (the counts on the
  // buttons already tell the story), the reconciling modes name what they did.
  function pullSuccessMessage(mode: PullMode): string | undefined {
    if (mode === "rebase") return "Pulled with rebase";
    if (mode === "merge") return "Pulled with merge";
    return undefined;
  }

  // Two refusals a pull can recover from, in the order they can occur. The
  // fork-point guard runs before git touches the tree, so it is asked first; the
  // dirty-tree recovery only ever sees refusals from the run itself. Every other
  // error keeps its normal toast. Both are triggered by the refusal, never
  // pre-flighted.
  async function doPull(mode: PullMode) {
    if (refuseWhileOffline()) return;
    if (promotionBlocksCheckout(repoPath)) {
      toast.info(PROMOTION_BLOCKS_CHECKOUT);
      return;
    }
    const plain = pullSuccessMessage(mode);
    const pulledIn = repoPath;
    try {
      await pull.mutateAsync(mode);
      if (plain) toast.success(plain);
    } catch (e) {
      // These controls survive a repo switch, so a refusal from a repo the user
      // has left (or one settling after an unmount) only toasts, naming its
      // repo: its dialogs would open under the live repo, and act on it with
      // the old one's SHAs.
      const originNote = originNoteFor(pulledIn);
      if (originNote) {
        toastErrorWithNote(e, originNote);
        return;
      }
      if (!mounted.current) {
        onError(e);
        return;
      }
      if (pullDropGuard.handleError(e)) return;
      const taken = recovery.handleError(e, {
        operationLabel: "pull",
        reappliedMessage: "Pulled and reapplied your changes.",
        // ff-only has no ordinary success toast, but a recovery the user ran
        // deliberately still has to confirm itself.
        plainMessage: plain ?? "Pulled.",
        run: { op: "pull", mode },
        // The retried pull re-runs the fork-point guard before it stashes, so
        // a rebase pull can raise the decision here too.
        onUnhandledError: pullDropGuard.handleRecoveryError,
      });
      if (!taken) onError(e);
    }
  }

  // Sync the current branch with the fork's upstream: fetch upstream, resolve
  // its default branch, then fast-forward or merge. Honest terminal toast per
  // outcome; a conflicting merge rejects and the conflict banner takes over
  // (its error still toasts). No auto-push — Push lights up on its own.
  async function doUpdateFromUpstream() {
    if (refuseWhileOffline()) return;
    if (promotionBlocksCheckout(repoPath)) {
      toast.info(PROMOTION_BLOCKS_CHECKOUT);
      return;
    }
    const updatedIn = repoPath;
    try {
      const outcome = await updateUpstream.mutateAsync(undefined);
      const originNote = originNoteFor(updatedIn);
      const ref = `upstream/${outcome.branch}`;
      if (outcome.kind === "up-to-date") {
        toast.success(`Already up to date with ${ref}.`);
      } else if (outcome.kind === "fast-forwarded") {
        toast.success(`Fast-forwarded to ${ref}.`);
      } else if (
        outcome.kind === "dirty-blocked" &&
        (!mounted.current || originNote !== undefined)
      ) {
        // Unmounted mid-update, or the user has left this repo: a recovery
        // prompt would go unseen or land on the wrong repo, so say what blocked
        // the merge instead, naming the repo when it is no longer on screen.
        toast(
          `Didn't update from ${ref} — uncommitted changes are in the way. Commit or stash them, then update again.`,
          { description: originNote },
        );
      } else if (outcome.kind === "dirty-blocked") {
        // The merge was refused, not attempted-and-broken: recover from the
        // already-resolved ref, so confirming costs no second fetch.
        recovery.begin({
          operationLabel: "update",
          detail: ref,
          reappliedMessage: `Updated from ${ref} and reapplied your changes.`,
          plainMessage: `Merged ${ref} into your branch.`,
          run: { op: "merge", ref: outcome.ref },
        });
      } else {
        toast.success(`Merged ${ref} into your branch.`);
      }
    } catch (e) {
      onError(e);
    }
  }

  // The remedy when the upstream already carries this branch's commits under
  // other ids and nothing local is unique: move the branch (and the working tree)
  // onto the upstream tip the status was measured against, so the two match again
  // with every commit intact.
  async function doResetToUpstream() {
    const branch = head?.name;
    const upstream = head?.upstream;
    const tip = rewriteData?.upstreamTip;
    if (!branch || !upstream || !tip) return;
    // The count is `ahead` rather than the status's patchEqual, which tallies
    // both sides of every matched pair; localOnly === 0 is what shows all of them
    // landed upstream.
    const alreadyThere =
      aheadCount === 1
        ? `The only commit on ${branch} is already on ${upstream} under a different id`
        : `All ${aheadCount} commits on ${branch} are already on ${upstream} under different ids`;
    const resetIn = repoPath;
    const ok = await useConfirm.getState().ask({
      title: `Reset ${branch} to ${upstream}?`,
      body: `${alreadyThere}. Resetting moves ${branch} to ${upstream}'s tip and rewrites your files to match, so no unique work is lost. Uncommitted changes block the reset — commit or stash them first.`,
      confirmLabel: `Reset to ${upstream}`,
      confirmVariant: "destructive",
    });
    if (!ok) return;
    // `hardReset` follows the live repo, where a same-named branch would pass
    // the HEAD check below; a switch under the prompt refuses instead.
    const { live, away } = landedIn(resetIn);
    if (!live) {
      toast.info(
        `You switched repositories while the dialog was open — nothing was reset${away}.`,
      );
      return;
    }
    // HEAD can move while the dialog sits open; the captured branch is the only
    // one the confirmation described. Says so rather than returning quietly: the
    // user just confirmed a destructive action, and silence reads as "it worked".
    // Wording kept in step with the branch menu's twin.
    if (headNameRef.current !== branch) {
      toast.info("HEAD moved while the dialog was open — nothing was reset.");
      return;
    }
    if (promotionBlocksCheckout(repoPath)) {
      toast.info(PROMOTION_BLOCKS_CHECKOUT);
      return;
    }
    try {
      await hardReset.mutateAsync(tip);
      toast.success(`Reset ${branch} to ${upstream}`);
    } catch (e) {
      onError(e);
    }
  }

  // `branch` names the pushed branch outright instead of HEAD, for a push
  // decided before an await that HEAD may have moved across. A named push
  // leaves `-u` to the backend, which reads THAT branch's tracking (untracked
  // or gone publishes with `-u`, tracked never retracks): `hasUpstream`
  // describes HEAD, which may no longer be that branch.
  async function doPush(force: boolean, branch?: string) {
    // The force confirm and the fork-PR guard can both sit open across a
    // disconnect, and each lands here.
    if (refuseWhileOffline()) return;
    try {
      const guard = await push.mutateAsync({
        setUpstream: branch === undefined && !hasUpstream,
        force,
        branch,
      });
      // Only a force push has a guarantee to report, and only the two
      // degraded values say more than the plain confirmation does.
      if (force)
        toast.success("Force pushed", {
          description: FORCE_PUSH_DEGRADED[guard],
        });
      setForceConfirmOpen(false);
    } catch (e) {
      onError(e);
      setForceConfirmOpen(false);
    }
  }

  // Publishing an untracked branch that is really a local copy of a fork PR's
  // head pushes a separate copy to origin and leaves the PR untouched — check
  // for that before publishing, and let the guard offer the fork instead. Purely
  // advisory: a detection failure is indistinguishable from no match and just
  // publishes. Pushes to a tracked upstream (and force pushes, which need one)
  // are correct as they stand and never ask.
  async function beginPush(force: boolean) {
    if (refuseWhileOffline()) return;
    const branch = head?.name;
    if (force || hasUpstream || !branch) {
      void doPush(force);
      return;
    }
    const pushedIn = repoPath;
    setDetecting(true);
    const match = await forgeDetectForkPrForBranch(repoPath, branch).catch(
      () => null,
    );
    setDetecting(false);
    // `push` follows the live repo, and this closure's `-u` was decided for the
    // old one: a switch during the round-trip refuses rather than publish there.
    const { live, away } = landedIn(pushedIn);
    if (!live) {
      toast.info(
        `Didn't publish ${branch}${away} — you switched repositories before the push started.`,
      );
      return;
    }
    // Every route from here pushes `branch` by name, so a HEAD that moved
    // during the round-trip changes nothing: the match still describes it.
    if (match) {
      setForkGuardRepo(pushedIn);
      setForkGuard({ match, branch });
    } else void doPush(false, branch);
  }

  // Hotkeys mirror the buttons' holds exactly (sync-controls-state.ts).
  useHotkeyAction("fetch", () => void doFetch(false), sync.hotkeys.fetch);
  useHotkeyAction("pull", () => void doPull("ffOnly"), sync.hotkeys.pull);
  useHotkeyAction(
    "push",
    () => {
      if (diverged) setForceConfirmOpen(true);
      else void beginPush(false);
    },
    sync.hotkeys.push,
  );
  // Palette-only (defaultBinding: null) and gated on the fork's `upstream`
  // remote existing (and not detached), so it hides itself when there's nothing
  // to sync from or nowhere to merge into.
  useHotkeyAction(
    "update-from-upstream",
    () => void doUpdateFromUpstream(),
    sync.hotkeys.updateFromUpstream,
  );

  if (noOrigin) {
    return (
      // A silent landing spot for focus across the swap with the sync cluster.
      <div ref={controlsRef} tabIndex={-1} className="flex outline-none">
        <PublishRepoControl
          repoPath={repoPath}
          providers={publish.providers}
          reserveCaret
          disabledTitle={
            publish.settled
              ? "Sign in with the GitHub CLI (gh auth login), GitLab CLI (glab auth login), or connect a Bitbucket account to publish"
              : "Checking publish accounts…"
          }
        />
      </div>
    );
  }

  return (
    <div
      ref={controlsRef}
      tabIndex={-1}
      className="flex items-center gap-2 outline-none"
    >
      {/* Every segment rides DisabledReasonButton's wrapper span. Those spans
          have no `data-slot`, so they opt out of ButtonGroup's
          border-collapse/rounding child selectors
          (`*:data-slot:rounded-r-none` + `[&>[data-slot]~[data-slot]]`) —
          ButtonGroup then contributes only layout + `role="group"`, and THIS
          call site owns the seams explicitly on the Buttons. The vendored Button
          is square (`rounded-none` in its cva root and `sm` variant), so the only
          load-bearing seam class is `border-l-0` on the joins. Keep it that way: a
          future reorder must set these classes, not lean on ButtonGroup's
          adjacency magic (it has now misfired on two arrangements). The group's
          `*:focus-visible:z-10` also can't reach the Buttons through the spans,
          so each Button carries `focus-visible:relative focus-visible:z-10`. */}
      <ButtonGroup aria-label="Sync actions">
        <DisabledReasonButton
          variant="outline"
          size="sm"
          // Every hold carries a reason, so none of the flips between them
          // drops focus by turning the button natively disabled. A running sync
          // outranks offline: it is real, and fails live if the connection drops.
          disabled={sync.fetch.disabled}
          reason={sync.fetch.reason}
          title={fetchHintTitle}
          aria-label="Fetch"
          aria-keyshortcuts={fetchKeyshortcuts}
          // max-md:pr-1.5 re-centers the glyph once the label is hidden: the
          // sm size is px-2.5 and the leading-icon rule already pulls the left
          // side to pl-1.5, so without this the icon sits 4px off-center.
          className="focus-visible:relative focus-visible:z-10 max-md:pr-1.5"
          onClick={() => void doFetch(false)}
        >
          {/* Every spinner here takes the sm icon box (size-3.5): the Spinner's
              own size-4 would shift the cluster 2px each time a sync starts. */}
          {fetchRemote.isPending ? (
            <Spinner data-icon="inline-start" className="size-3.5" />
          ) : (
            <ArrowsClockwiseIcon data-icon="inline-start" />
          )}
          {/* Labels drop below `md` so the header fits a 640px window; every
              icon, count, and accessible name stays put at every width. */}
          <span className="hidden md:inline">Fetch</span>
        </DisabledReasonButton>
        <DisabledReasonButton
          variant="outline"
          size="sm"
          // A description-only reason repeats the `aria-label` (read twice by
          // AT, the price of the mechanism). The wrapper hovers the reason, else
          // `pullTitle`.
          disabled={sync.pull.disabled}
          reason={sync.pull.reason}
          title={pullTitle}
          aria-label={sync.pullName}
          aria-keyshortcuts={pullKeyshortcuts}
          className="border-l-0 focus-visible:relative focus-visible:z-10 max-md:pr-1.5"
          onClick={() => void doPull("ffOnly")}
        >
          {/* Covers the recovery compounds too: with the preference on they
              run with no dialog open to show progress. */}
          {pull.isPending || recovery.pending ? (
            <Spinner data-icon="inline-start" className="size-3.5" />
          ) : (
            <ArrowDownIcon data-icon="inline-start" />
          )}
          <span className="hidden md:inline">Pull</span>
          {behindCount > 0 && (
            <span
              aria-hidden="true"
              className="text-muted-foreground tabular-nums"
            >
              {behindCount}
            </span>
          )}
        </DisabledReasonButton>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <DisabledReasonButton
                variant="outline"
                size="sm"
                aria-label="Pull options"
                // Reachable whenever there's a menu item to show: the pull
                // reconcile options (need a tracking upstream) or "Update from
                // upstream" (needs the fork's upstream remote).
                disabled={sync.pullOptions.disabled}
                reason={sync.pullOptions.reason}
                className="border-l-0 px-1.5 focus-visible:relative focus-visible:z-10"
              >
                <CaretDownIcon />
              </DisabledReasonButton>
            }
          />
          <DropdownMenuContent align="end" className="min-w-48">
            {hasUpstream && (
              <>
                <DropdownMenuItem
                  disabled={!!offlineHold}
                  onClick={() => void doPull("rebase")}
                >
                  Pull with rebase{offlineSuffix}
                </DropdownMenuItem>
                {/* Disabled with the reason IN the label: a disabled menu item
                    surfaces no tooltip, and the branch menu states the same
                    refusal the same way. */}
                <DropdownMenuItem
                  disabled={mixedRewrite || !!offlineHold}
                  title={mixedRewrite ? mergeDuplicatesReason : undefined}
                  onClick={() => void doPull("merge")}
                >
                  {mixedRewrite
                    ? `Pull with merge (${head?.upstream} already carries these changes under different ids)`
                    : `Pull with merge${offlineSuffix}`}
                </DropdownMenuItem>
                {/* Offered only once the probe has measured an upstream that
                    carries every one of these commits, with no unique local
                    work; every other divergence keeps the two pull items
                    alone. */}
                {remoteRebased && (
                  <DropdownMenuItem onClick={() => void doResetToUpstream()}>
                    Reset to {head?.upstream}…
                  </DropdownMenuItem>
                )}
              </>
            )}
            {canUpdateUpstream && (
              <>
                {hasUpstream && <DropdownMenuSeparator />}
                {/* Base UI menu items fire on onClick, NOT onSelect. */}
                <DropdownMenuItem
                  disabled={!!offlineHold}
                  onClick={() => void doUpdateFromUpstream()}
                >
                  Update from upstream{offlineSuffix}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <DisabledReasonButton
          variant="outline"
          size="sm"
          // Same ranking as Pull's.
          disabled={sync.push.disabled}
          reason={sync.push.reason}
          title={pushTitle}
          aria-label={sync.pushName}
          aria-keyshortcuts={pushKeyshortcuts}
          className="border-l-0 focus-visible:relative focus-visible:z-10 max-md:pr-1.5"
          onClick={() => {
            if (diverged) {
              setForceConfirmOpen(true);
            } else {
              void beginPush(false);
            }
          }}
        >
          {push.isPending || detecting ? (
            <Spinner data-icon="inline-start" className="size-3.5" />
          ) : diverged ? (
            <WarningIcon data-icon="inline-start" />
          ) : (
            <ArrowUpIcon data-icon="inline-start" />
          )}
          <span className="hidden md:inline">{pushLabel}</span>
          {aheadCount > 0 && (
            <span
              aria-hidden="true"
              className="text-muted-foreground tabular-nums"
            >
              {aheadCount}
            </span>
          )}
        </DisabledReasonButton>
      </ButtonGroup>

      <Dialog open={forceConfirmOpen} onOpenChange={setForceConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Force push?</DialogTitle>
            <DialogDescription>
              Your branch and {head?.upstream} have diverged (usually after
              amending or resetting a pushed commit). Force pushing rewrites the
              remote branch to match your local one. Uses --force-with-lease
              and, where your Git can check it, --force-if-includes — the pair
              aborts rather than overwrite work your branch doesn't include,
              even work a background fetch has already seen.
            </DialogDescription>
          </DialogHeader>
          {/* The measured arms — both state what the counts SHOW, never how the
              upstream came to look that way (a rebase, a force push and a
              cherry-pick all leave patch twins). `localAtRisk` counts the work
              only this branch has, for which a rebasing pull (not a force push)
              is the remedy — equally true under ordinary divergence. Neither arm
              renders while the probe is unresolved. */}
          {remoteRebased && (
            <p className="text-muted-foreground text-sm">
              {head?.upstream} already carries every commit on your branch under
              different ids. Force pushing would replace them with your copies;
              "Reset to {head?.upstream}" in the Pull menu keeps the same work
              and matches the remote instead.
            </p>
          )}
          {localAtRisk > 0 && (
            <p className="text-muted-foreground text-sm">
              {localAtRisk} commit{localAtRisk === 1 ? "" : "s"} exist
              {localAtRisk === 1 ? "s" : ""} only on your branch
              {/* Only asserted where the counts actually found commits on the
                  other side — an amended tip plus one new local commit leaves
                  `remoteOnly` at zero, and the clause would be false. */}
              {remoteAhead > 0
                ? `, and ${head?.upstream} has ${remoteAhead} commit${remoteAhead === 1 ? "" : "s"} yours doesn't`
                : ""}
              . Pull with rebase keeps yours and replays them on top of{" "}
              {head?.upstream}.
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setForceConfirmOpen(false)}
            >
              Cancel
            </Button>
            <DisabledReasonButton
              variant="destructive"
              disabled={push.isPending || !!offlineHold}
              reason={push.isPending ? ACT_PENDING_REASON : offlineHold}
              onClick={() => void doPush(true)}
            >
              {push.isPending && <Spinner data-icon="inline-start" />}
              Force push
            </DisabledReasonButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ForkPrPublishGuard
        repoPath={forkGuardRepo}
        match={forkGuard?.match ?? null}
        branch={forkGuard?.branch ?? ""}
        onClose={() => setForkGuard(null)}
        onPublishAnyway={() => {
          const branch = forkGuard?.branch;
          setForkGuard(null);
          void doPush(false, branch);
        }}
      />

      {recovery.dialog}
      {pullDropGuard.dialog}
    </div>
  );
}
