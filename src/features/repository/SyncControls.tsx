import {
  ArrowDownIcon,
  ArrowsClockwiseIcon,
  ArrowUpIcon,
  CaretDownIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { MENU_HELD_ROW_CLASS } from "@/components/menu-held-row";
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
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { useFocusOnControlsSwap } from "@/features/diff/use-hidden-trigger-focus";
import {
  forgeDetectForkPrForBranch,
  gitRemotePushUrl,
  gitRemoteUrl,
  type PullMode,
  type PushGuard,
} from "@/lib/git/api";
import {
  useAutoFetch,
  useFetchStatusStore,
  useLastFetchedAt,
} from "@/lib/git/auto-fetch";
import {
  BRANCH_PUSH_ACTIVE_MESSAGE,
  branchPushHoldItemReason,
  branchPushHoldReason,
  branchRewriteStatusOptions,
  carriesAllLocalCommits,
  pendingMutationEntries,
  refuseWhilePushRuns,
  remoteBranchesOptions,
  repoStatusOptions,
  useBranchRewriteStatus,
  useFetchRemote,
  useHardResetToCommit,
  usePendingBranchPushes,
  usePendingPublishes,
  usePull,
  usePush,
  useRemoteBranches,
  useRemotes,
  useRepoStatus,
  useUpdateFromUpstream,
} from "@/lib/git/queries";
import {
  branchPushKey,
  pendingBranchPushesFor,
} from "@/lib/git/queries/push-writes";
import type { BranchRewriteStatus, ForkPrMatch } from "@/lib/git/types";
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
import { type ConfirmRequest, useConfirm } from "@/lib/stores/confirm";
import {
  landedIn,
  originNoteFor,
  refuseIfSwitched,
} from "@/lib/stores/notifications";
import {
  promotionBlocksCheckout,
  useWorktreeRemovals,
} from "@/lib/stores/worktree-removal";
import { formatRelativeTime } from "@/lib/time";
import { toastError, toastErrorWithNote } from "@/lib/toast";
import {
  type PushOutcome,
  presenceUnderUrls,
  pushesBranch,
  pushOutcome,
  pushSuccessCopy,
  pushWouldCreate,
  remoteHasBranch,
  visibilityApplies,
  willCreateOnRemote,
  willPublish,
} from "./branch-sync-state";
import { PROMOTION_BLOCKS_CHECKOUT } from "./checkout-copy";
import { ForkPrPublishGuard } from "./ForkPrPublishGuard";
import { refuseWhilePublishing } from "./PublishPendingBanner";
import {
  PublishRepoControl,
  publishPendingReason,
  usePublishProviders,
} from "./PublishRepoControl";
import {
  askPublishConfirm,
  recordedVisibility,
  useCloseSettled,
  withdrawPublishConfirm,
} from "./publish-confirm";
import { statusReadFailed } from "./StatusReadError";
import {
  deriveSyncControls,
  headFacts,
  type MismatchMenu,
  type MismatchMenuItem,
  SYNC_BUSY_REASON,
} from "./sync-controls-state";
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

/** Reset to upstream's refusals when the confirm-time re-read no longer matches
 *  what the menu offered: the upstream tip moved, the branch itself did, or the
 *  read couldn't prove the upstream still carries every commit. KEEP IN STEP:
 *  BranchSwitcher's twins name the branch menu instead of the Pull menu
 *  (pinned by scripts/head-watcher.test.mjs). */
const UPSTREAM_MOVED_NOTICE = (upstream: string) =>
  `${upstream} moved since you opened this, so nothing was reset. Reopen the Pull menu to see where it stands now.`;
const LOCAL_MOVED_NOTICE = (branch: string) =>
  `${branch} changed since you opened this, so nothing was reset. Reopen the Pull menu to see where it stands now.`;
const UNCONFIRMED_NOTICE = (upstream: string, branch: string) =>
  `Couldn't confirm that ${upstream} still has every commit on ${branch}, so nothing was reset. Reopen the Pull menu to check again.`;

export function SyncControls({ repoPath }: { repoPath: string }) {
  const status = useRepoStatus(repoPath);
  const remotes = useRemotes(repoPath);
  const settings = useSettings();
  const fetchRemote = useFetchRemote(repoPath);
  // Auto-fetch runs on its own instance, so it never holds the manual controls:
  // a push pressed during one queues behind it on the backend's network lock.
  const autoFetch = useFetchRemote(repoPath);
  const removals = useWorktreeRemovals(repoPath);
  const pull = usePull(repoPath);
  const push = usePush(repoPath);
  const queryClient = useQueryClient();
  // This repo's pushes in flight, read from the cache: the observer goes idle at
  // a repo switch and never re-attaches, so a switch back mid-push would read
  // idle. The bar's own pushes are tagged `source: "header"`.
  const pendingPushes = usePendingBranchPushes(repoPath);
  const headerPushPending = pendingPushes.some((p) => p.fromHeader);
  // A push started elsewhere (the branch dropdown, a fork guard) holds the same
  // network lock, so the bar's network controls wait on it too; only the bar's
  // own pushes turn its Push spinner.
  const otherPushes = pendingPushes.filter((p) => !p.fromHeader);
  const otherPushRunning = otherPushes.length > 0;
  const otherPushPaused = otherPushes.some((p) => p.paused);
  const otherPushReason = branchPushHoldReason(otherPushPaused);
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
  // The force-push confirm, holding the branch its divergence verdict was
  // measured on and that branch's upstream, so a HEAD move never retitles the
  // dialog. A closed confirm keeps its capture so the exit transition still
  // shows it.
  const [forceConfirm, setForceConfirm] = useState<{
    branch: string | null;
    upstream: string | null;
    open: boolean;
  } | null>(null);
  const closeForceConfirm = () =>
    setForceConfirm((c) => c && { ...c, open: false });
  // The live confirm, readable after confirmForcePush's status read: a cancel or
  // reopen during the read replaces the object, which the identity check sees.
  const forceConfirmRef = useRef(forceConfirm);
  useEffect(() => {
    forceConfirmRef.current = forceConfirm;
  }, [forceConfirm]);
  // Set while a confirm's status read is in flight: the ref makes a second click
  // a synchronous no-op, the state holds the act button visibly.
  const forceChecking = useRef(false);
  const [forceReading, setForceReading] = useState(false);
  // The publish intercepted by the fork-PR guard. The branch is captured at
  // click time and travels with the match, so the dialog can only ever push the
  // branch the detection ran for. Each open carries its own `repo` and a
  // `token` that keys the guard, so every open is a fresh instance whose
  // repoPath never changes: its `usePush` stays on that repo (an in-flight
  // mutation keeps those options through an unmount), and a closed open's late
  // continuation can't close a newer one. A closed open stays mounted only for
  // the dialog's exit transition and closed-state render; the next open, or
  // the no-origin arm, unmounts it.
  const [forkGuard, setForkGuard] = useState<{
    token: number;
    repo: string;
    match: ForkPrMatch;
    branch: string;
    open: boolean;
  } | null>(null);
  const forkGuardSeq = useRef(0);
  const closeForkGuard = (token: number) =>
    setForkGuard((g) => (g?.token === token ? { ...g, open: false } : g));
  // In-flight fork-PR detections, counted per repo: each holds its own repo's
  // sync bar and no other, so a switch mid-probe neither holds the new repo nor
  // releases the old one before its probe settles.
  const [detections, setDetections] = useState<
    Readonly<Record<string, number>>
  >({});
  const detecting = (detections[repoPath] ?? 0) > 0;
  // The mismatch Push menu, controlled so the push hotkey and the palette open
  // it too. Its destinations are pinned when it opens, with the repo they belong
  // to: a status poll under the open menu can't change what a click pushes.
  const [pushMenuOpen, setPushMenuOpen] = useState(false);
  const pushMenuClose = useCloseSettled(pushMenuOpen);
  // The publish prompt this bar asked last, so it withdraws only its own.
  const publishAsk = useRef<ConfirmRequest | null>(null);
  const [pushMenuCapture, setPushMenuCapture] = useState<{
    repo: string;
    menu: MismatchMenu;
  } | null>(null);
  // This component survives repo switches (RepoHeader mounts unkeyed), so both
  // confirm dialogs close in the render that switches. Left open, the force
  // confirm would force-push the live HEAD on the old repo's divergence
  // verdict, and the fork guard would offer a push for a repository the user
  // has left (defense in depth beside its per-open pin). Reset in render: an
  // effect would paint them open first. The Push menu closes with them.
  const [dialogsRepo, setDialogsRepo] = useState(repoPath);
  if (dialogsRepo !== repoPath) {
    setDialogsRepo(repoPath);
    setForceConfirm((c) => c && { ...c, open: false });
    setForkGuard((g) => g && { ...g, open: false });
    setPushMenuOpen(false);
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
  // While the probe re-reads, the merge and reset rows hold in place rather than
  // act on (or vanish over) an answer that may no longer stand.
  const rewriteChecking = diverged && !detached && rewrite.isFetching;
  // The reflog verdict ALONE matches ordinary divergence too; only paired with
  // "no local commit lacks a patch-twin upstream" does it describe an upstream
  // that already carries this branch's work — and offering a reset while unique
  // work exists would destroy it.
  const remoteRebased = carriesAllLocalCommits(rewriteData);
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
  const ownBusy =
    fetchRemote.isPending ||
    pull.isPending ||
    headerPushPending ||
    updateUpstream.isPending ||
    hardReset.isPending ||
    detecting ||
    recovery.pending ||
    pullDropGuard.pending;
  const busy = ownBusy || otherPushRunning;
  const onError = (e: unknown) => toastError(e);
  // Every network arm here (fetch, pull, push, update from upstream) holds
  // offline rather than park: a parked push or force push would land whenever
  // the connection returns. Reset to upstream is local and stays live.
  const offlineHold = useOfflineHold();
  const offlineSuffix = offlineHold ? ` (${OFFLINE_ITEM_REASON})` : "";
  // Says whether publishing under the new name would land on a branch the last
  // fetch already saw there. Read only while the mismatch menu is open, as the
  // hook's doc requires; a disabled query still serves the warm-up's cached list,
  // so a list still refreshing at open can relabel that item once.
  const remoteBranches = useRemoteBranches(
    repoPath,
    pushMenuOpen && head?.pushNameMismatch === true,
  );
  const remoteNewExists =
    remoteBranches.data?.some(
      (r) => r.remote === head?.upstreamRemote && r.name === head?.name,
    ) ?? false;
  // Sticky failure predicates, never `isError`: a never-loaded query that errored
  // goes back to pending on every refetch, which would flip the reason per poll.
  const syncInput = {
    head,
    statusError: statusReadFailed(status),
    remotes: remotes.data,
    remotesError: remotes.data === undefined && remotes.errorUpdateCount > 0,
    busy,
    // Held only by another surface's push, the bar names that push.
    busyReason: ownBusy ? SYNC_BUSY_REASON : otherPushReason,
    offlineHold,
    remoteRebased,
    mixedRewrite,
    localAtRisk,
    remoteNewExists,
  };
  const sync = deriveSyncControls(syncInput);
  // The hotkeys follow the bar's OWN holds, so a press during another surface's
  // push reaches its fire-time refusal instead of doing nothing.
  const hotkeys = deriveSyncControls({ ...syncInput, busy: ownBusy }).hotkeys;
  // The menu's trigger unmounts when the mismatch clears, closing the menu with
  // it; a menu left "open" would reappear by itself the next time it mounts.
  if (pushMenuOpen && !sync.mismatchMenu) setPushMenuOpen(false);
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
  // No `origin` (a repo created locally) means Publish instead of the cluster.
  // Every provider adds `origin` before its push, so the arm, its providers probe
  // and its focus rescue also hold while this repo's publish runs, until it settles.
  const publishPending = usePendingPublishes(repoPath).length > 0;
  const publishArm = noOrigin || publishPending;
  const publish = usePublishProviders(repoPath, publishArm);
  // The cluster ↔ Publish swap unmounts whichever control held focus, and a
  // settle onto 2+ providers swaps Publish's button for the dropdown's trigger.
  const controlsRef = useRef<HTMLDivElement>(null);
  useFocusOnControlsSwap(publishArm, controlsRef);
  useFocusOnControlsSwap(publish.providers.length >= 2, controlsRef);
  // The plain Push button and the mismatch menu's trigger swap whenever the
  // mismatch flips (a successful publish retracks the branch), so focus lands on
  // whichever push control replaced the one that held it.
  const pushControlRef = useRef<HTMLButtonElement>(null);
  useFocusOnControlsSwap(sync.mismatch, pushControlRef);

  // One entry point for every fetch — manual (button/hotkey) and automatic —
  // so a successful fetch always records its freshness. Auto-fetches stay quiet
  // (a failed background fetch just retries next tick).
  async function doFetch(silent: boolean) {
    // Auto-fetch carries its own connectivity gate (auto-fetch.ts), and waits out
    // a push through `busy` without a word.
    if (!silent && (refuseWhileOffline() || refuseWhilePushing())) return;
    try {
      await (silent ? autoFetch : fetchRemote).mutateAsync(undefined);
      markFetched(repoPath);
    } catch (e) {
      if (!silent) onError(e);
    }
  }

  // Opt-out periodic background fetch (Settings → General), on its own mutation;
  // the Fetch spinner still covers it. Ticks skip while a worktree removal runs,
  // and while this repo's publish runs (its `origin` appears before the push).
  useAutoFetch({
    repoPath,
    enabled: settings.data?.autoFetch ?? false,
    intervalMs: Number(settings.data?.autoFetchInterval ?? "10") * 60_000,
    hasOrigin,
    busy: busy || autoFetch.isPending || removals.length > 0 || publishPending,
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

  // Pull with merge, checking FIRST: while the probe re-reads, the duplicate
  // guard has no answer to stand on.
  const mergeArm = ((): "checking" | "duplicates" | "offline" | "ready" => {
    switch (true) {
      case rewriteChecking:
        return "checking";
      case mixedRewrite:
        return "duplicates";
      case !!offlineHold:
        return "offline";
      default:
        return "ready";
    }
  })();
  const pullWithMerge: Record<
    typeof mergeArm,
    { label: string; disabled: boolean; title?: string }
  > = {
    checking: {
      label: "Pull with merge (checking the remote…)",
      disabled: true,
    },
    duplicates: {
      label: `Pull with merge (${head?.upstream} already carries these changes under different ids)`,
      disabled: true,
      title: mergeDuplicatesReason,
    },
    offline: { label: `Pull with merge${offlineSuffix}`, disabled: true },
    ready: { label: "Pull with merge", disabled: false },
  };
  const mergeRow = pullWithMerge[mergeArm];

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
    // The Pull menu can be open from before a push started.
    if (refuseWhileOffline() || refuseWhilePushing()) return;
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
    if (refuseWhileOffline() || refuseWhilePushing()) return;
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
    const localTip = rewriteData?.localTip;
    if (!branch || !upstream || !tip || !localTip) return;
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
    if (refuseIfSwitched(resetIn, "nothing was reset")) return;
    // HEAD can move while the dialog sits open; the captured branch is the only
    // one the confirmation described. Says so rather than returning quietly: the
    // user just confirmed a destructive action, and silence reads as "it worked".
    // Wording kept in step with the branch menu's twin and with HistoryDialogs'
    // Reset to commit pre-check.
    if (headNameRef.current !== branch) {
      toast.info("HEAD moved while the dialog was open — nothing was reset.");
      return;
    }
    if (refuseWhileBranchPushes(branch)) return;
    // An outside fetch can move the upstream while the prompt sits open, so the
    // reset re-measures before it acts. A read that joins one in flight may have
    // begun before that fetch's ref write and return the older tip; the reset
    // then lands on the tip the probe proved carries every local commit.
    let fresh: BranchRewriteStatus;
    try {
      fresh = await queryClient.fetchQuery({
        ...branchRewriteStatusOptions(repoPath, branch),
        staleTime: 0,
      });
    } catch (e) {
      toastErrorWithNote(e, "Nothing was reset.");
      return;
    }
    if (refuseIfSwitched(resetIn, "nothing was reset")) return;
    // A push can start during the re-read; the reset moves the tip it sends.
    if (refuseWhileBranchPushes(branch)) return;
    // No measurable upstream tip proves nothing moved.
    if (fresh.upstreamTip === null) {
      toast.info(UNCONFIRMED_NOTICE(upstream, branch));
      return;
    }
    if (fresh.upstreamTip !== tip) {
      toast.info(UPSTREAM_MOVED_NOTICE(upstream));
      return;
    }
    // Same upstream tip, but the read no longer proves the upstream carries
    // every commit: name a local move only when the read measured one, since an
    // unknown verdict (a failed reflog walk) proves nothing moved. A local move
    // that is still carried proceeds, and the backend's pin refuses it.
    if (!carriesAllLocalCommits(fresh)) {
      if (fresh.localTip !== null && fresh.localTip !== localTip) {
        toast.info(LOCAL_MOVED_NOTICE(branch));
      } else {
        toast.info(UNCONFIRMED_NOTICE(upstream, branch));
      }
      return;
    }
    if (promotionBlocksCheckout(repoPath)) {
      toast.info(PROMOTION_BLOCKS_CHECKOUT);
      return;
    }
    try {
      await hardReset.mutateAsync({
        hash: tip,
        expectedHead: localTip,
        expectedBranch: branch,
      });
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
  async function doPush(
    force: boolean,
    branch?: string,
    outcome?: PushOutcome,
  ) {
    // The force confirm and the fork-PR guard can both sit open across a
    // disconnect, and each lands here. Some routes also arrive after an await (a
    // status read, a fork-PR detection) another surface's push can start in.
    if (
      refuseWhileOffline() ||
      refuseWhilePushing() ||
      refuseWhilePublishing(queryClient, repoPath)
    )
      return;
    try {
      const guard = await push.mutateAsync({
        setUpstream: branch === undefined && !hasUpstream,
        force,
        branch,
        source: "header",
      });
      const { away } = landedIn(repoPath);
      // The outcome toast claims only the pre-push decision (the push IPC
      // reports no create signal); the force toast's two degraded guard values
      // are the only post-push facts reported.
      if (force)
        toast.success(`Force pushed${away}`, {
          description: FORCE_PUSH_DEGRADED[guard],
        });
      else if (outcome !== undefined && branch !== undefined) {
        const copy = pushSuccessCopy({
          outcome,
          branch,
          remote: "origin",
          tracks: true,
          away,
        });
        if (copy) toast.success(copy.title, { description: copy.description });
      }
      closeForceConfirm();
    } catch (e) {
      onError(e);
      closeForceConfirm();
    }
  }

  // HEAD can move while the confirm sits open; the branch it opened on is the
  // only one its divergence verdict described. A move the status poll has seen
  // refuses at once; one it hasn't is caught by a direct status read before the
  // push. The push stays on the HEAD path: a named push would bypass git's
  // pushRemote / pushDefault / push.default routing and could rewrite the
  // upstream's branch in a fork workflow.
  async function confirmForcePush() {
    // A click during the closing dialog's exit transition: nothing to confirm.
    if (!forceConfirm?.open) return;
    if (headNameRef.current !== forceConfirm.branch) {
      toast.info("HEAD moved while the dialog was open — nothing was pushed.");
      closeForceConfirm();
      return;
    }
    if (forceChecking.current) return;
    // Every pre-await read the continuation needs, pinned here: the repo, the
    // branch, and the confirm object itself (its identity is the open session).
    const confirmRepo = repoPath;
    const confirm = forceConfirm;
    const branch = confirm.branch;
    forceChecking.current = true;
    setForceReading(true);
    let readName: string | null;
    try {
      // The factory's queryFn straight, never fetchQuery: that joins an
      // in-flight poll, which may have been spawned before the click.
      readName = (await repoStatusOptions(confirmRepo).queryFn()).branch.name;
    } catch {
      toast.info("Couldn't confirm the current branch — nothing was pushed.");
      if (forceConfirmRef.current === confirm) closeForceConfirm();
      return;
    } finally {
      forceChecking.current = false;
      setForceReading(false);
    }
    // `push` follows the live repo, so a switch during the read refuses.
    if (refuseIfSwitched(confirmRepo, "nothing was pushed")) return;
    // Cancelled or reopened during the read: that click no longer stands.
    if (forceConfirmRef.current !== confirm) return;
    if (readName !== branch) {
      toast.info("HEAD moved while the dialog was open — nothing was pushed.");
      closeForceConfirm();
      return;
    }
    // A checkout between this read and the push's spawn remains, including any
    // wait on the repo's network lock.
    void doPush(true);
  }

  function openForceConfirm() {
    setForceConfirm({
      branch: head?.name ?? null,
      upstream: head?.upstream ?? null,
      open: true,
    });
  }
  const forceUpstream = forceConfirm?.upstream;
  // The live verdicts describe HEAD, so they show only while HEAD is still the
  // dialog's branch (a moved HEAD is refused by the confirm on the same test),
  // and never in the exit frames, which may already belong to another repo.
  const forceEvidence =
    forceConfirm?.open === true && head?.name === forceConfirm.branch;
  const forceActPending = headerPushPending || forceReading;

  // Publishing an untracked branch that is really a local copy of a fork PR's
  // head pushes a separate copy to origin and leaves the PR untouched — check
  // for that before publishing, and let the guard offer the fork instead. Purely
  // advisory: a detection failure is indistinguishable from no match and falls
  // through to the publish confirm. Pushes to a tracked upstream (and force
  // pushes, which need one) are correct as they stand and never ask.
  async function beginPush(force: boolean) {
    if (refuseWhileOffline()) return;
    const branch = head?.name;
    const facts = {
      upstream: head?.upstream ?? null,
      upstreamGone: head?.upstreamGone === true,
    };
    if (force || !branch || !willPublish(facts)) {
      // A bare push lands where git's push config sends it, which can be a
      // branch the remote doesn't have yet. The everyday push goes to its own
      // upstream, which exists, so it pays no read at all.
      const pushRemote = head?.pushRemote ?? null;
      const pushBranch = head?.pushBranch ?? null;
      const toUpstream =
        pushRemote === (head?.upstreamRemote ?? null) &&
        pushBranch === (head?.upstreamBranch ?? null);
      if (
        force ||
        !branch ||
        toUpstream ||
        pushRemote === null ||
        pushBranch === null
      ) {
        void doPush(force);
        return;
      }
      void beginBarePush(branch, pushRemote, pushBranch);
      return;
    }
    const pushedIn = repoPath;
    setDetections((d) => ({ ...d, [pushedIn]: (d[pushedIn] ?? 0) + 1 }));
    const match = await forgeDetectForkPrForBranch(repoPath, branch).catch(
      () => null,
    );
    setDetections((d) => {
      const { [pushedIn]: n = 0, ...rest } = d;
      return n > 1 ? { ...rest, [pushedIn]: n - 1 } : rest;
    });
    // `push` follows the live repo, while the branch name, the fork match and
    // the decision to publish all belong to the old one: a switch during the
    // round-trip refuses rather than publish there.
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
      // A repeat press can match while this bar's own publish prompt is still
      // up; the guard replaces it rather than stacking over it.
      withdrawPublishConfirm(publishAsk);
      forkGuardSeq.current += 1;
      setForkGuard({
        token: forkGuardSeq.current,
        repo: pushedIn,
        match,
        branch,
        open: true,
      });
      return;
    }
    // A push that started during the detection refuses before any prompt.
    if (refuseWhilePushing() || refuseWhilePublishing(queryClient, repoPath))
      return;
    // The HEAD arm publishes to origin. A branch origin already has (as of the
    // last fetch) only fast-forwards and tracks, so only a create asks first;
    // the list mirrors origin's FETCH side, so a differing push URL asks too.
    const [list, fetchUrl, pushUrl] = await Promise.all([
      queryClient
        .fetchQuery(remoteBranchesOptions(pushedIn))
        .catch(() => undefined),
      gitRemoteUrl(pushedIn, "origin").catch(() => null),
      gitRemotePushUrl(pushedIn, "origin").catch(() => null),
    ]);
    // The prompt stamps whichever repo is live when it asks.
    if (
      refuseIfSwitched(
        pushedIn,
        "nothing was published",
        "before the push started",
      )
    )
      return;
    const presence = presenceUnderUrls(
      remoteHasBranch(list, "origin", branch),
      fetchUrl,
      pushUrl,
    );
    const create = willCreateOnRemote({
      ...facts,
      remoteHasSameName: presence,
    });
    if (create) {
      const ok = await askPublishConfirm(
        {
          branch,
          remote: "origin",
          pushUrl,
          visibility: visibilityApplies("origin", fetchUrl, pushUrl)
            ? recordedVisibility(settings.data?.recentRepos, pushedIn)
            : null,
          goneUpstream: facts.upstreamGone,
          upstreamRemote: head?.upstreamRemote ?? null,
          upstreamBranch: head?.upstreamBranch ?? null,
        },
        publishAsk,
      );
      if (!ok) return;
    }
    // Pushes `branch` by name: a HEAD that moved under the prompt publishes the
    // branch it named. doPush re-checks offline and running pushes itself.
    void doPush(
      false,
      branch,
      pushOutcome({ willPublish: true, create, presence }),
    );
  }

  // A tracked branch whose bare push git sends somewhere other than its upstream
  // (push.default=current on a differently named upstream, a pushRemote or
  // remote.pushDefault): asks first when that destination doesn't exist yet. A
  // confirmed push names branch, remote and destination outright, so a HEAD move
  // or a config edit under the prompt can't change what the prompt described.
  async function beginBarePush(
    branch: string,
    pushRemote: string,
    pushBranch: string,
  ) {
    const pushedIn = repoPath;
    const switchedAway = () =>
      refuseIfSwitched(
        pushedIn,
        "nothing was pushed",
        "before the push started",
      );
    const [list, fetchUrl, pushUrl] = await Promise.all([
      queryClient
        .fetchQuery(remoteBranchesOptions(pushedIn))
        .catch(() => undefined),
      gitRemoteUrl(pushedIn, pushRemote).catch(() => null),
      gitRemotePushUrl(pushedIn, pushRemote).catch(() => null),
    ]);
    if (switchedAway()) return;
    const presence = presenceUnderUrls(
      remoteHasBranch(list, pushRemote, pushBranch),
      fetchUrl,
      pushUrl,
    );
    const create = pushWouldCreate({ pushRemote, pushBranch, presence });
    if (create !== true) {
      // doPush pushes HEAD, and the destination was read for `branch`.
      if (headNameRef.current !== branch) {
        toast.info("HEAD moved — nothing was pushed.");
        return;
      }
      void doPush(false);
      return;
    }
    // A push that started during the reads refuses before any prompt.
    if (refuseWhilePushing() || refuseWhilePublishing(queryClient, repoPath))
      return;
    const ok = await askPublishConfirm(
      {
        branch,
        remote: pushRemote,
        pushUrl,
        visibility: visibilityApplies(pushRemote, fetchUrl, pushUrl)
          ? recordedVisibility(settings.data?.recentRepos, pushedIn)
          : null,
        goneUpstream: false,
        upstreamRemote: null,
        upstreamBranch: null,
        ...(pushBranch === branch ? {} : { createdBranch: pushBranch }),
      },
      publishAsk,
    );
    if (!ok) return;
    if (switchedAway()) return;
    if (
      refuseWhileOffline() ||
      refuseWhilePushing() ||
      refuseWhilePublishing(queryClient, repoPath)
    )
      return;
    try {
      // Sets no upstream, exactly like the bare push it stands in for.
      await push.mutateAsync({
        setUpstream: false,
        branch,
        remote: pushRemote,
        remoteBranch: pushBranch,
        source: "header",
      });
      const copy = pushSuccessCopy({
        outcome: pushOutcome({ willPublish: true, create, presence }),
        branch,
        remote: pushRemote,
        ...(pushBranch === branch ? {} : { remoteBranch: pushBranch }),
        tracks: false,
        away: landedIn(pushedIn).away,
      });
      if (copy) toast.success(copy.title, { description: copy.description });
    } catch (e) {
      onError(e);
    }
  }

  function openPushMenu() {
    const menu = sync.mismatchMenu;
    if (!menu) return;
    setPushMenuCapture({ repo: repoPath, menu });
    setPushMenuOpen(true);
  }

  // Each item pushes the destination the menu showed when it opened, by name:
  // never the HEAD arm, whose bare push git refuses here and whose `-u` names
  // origin. "Publish" retracks to the SAME remote; the tracked push never does.
  async function pushFromMenu(target: "tracked" | "publish") {
    const capture = pushMenuCapture;
    if (!capture) return;
    if (refuseWhileOffline()) return;
    if (
      refuseIfSwitched(
        capture.repo,
        "nothing was pushed",
        "while the menu was open",
      )
    )
      return;
    if (refuseWhilePushing() || refuseWhilePublishing(queryClient, repoPath))
      return;
    const { branch, remote, remoteBranch } = capture.menu;
    if (headNameRef.current !== branch) {
      toast.info("HEAD moved — nothing was pushed.");
      return;
    }
    try {
      if (target === "tracked") {
        await push.mutateAsync({
          setUpstream: false,
          branch,
          remote,
          remoteBranch,
          source: "header",
        });
        toast.success(
          `Pushed ${branch} to ${remote}/${remoteBranch}${landedIn(capture.repo).away}`,
        );
      } else {
        // A same-named branch the remote already has (as of the last fetch) is
        // only fast-forwarded and tracked; an unloaded list asks, and so does a
        // remote whose push URL differs from the fetch side the list mirrors.
        const listed = remoteHasBranch(remoteBranches.data, remote, branch);
        const [fetchUrl, pushUrl] = await Promise.all([
          gitRemoteUrl(capture.repo, remote).catch(() => null),
          gitRemotePushUrl(capture.repo, remote).catch(() => null),
        ]);
        const switchedAway = () =>
          refuseIfSwitched(
            capture.repo,
            "nothing was pushed",
            "before the push started",
          );
        if (switchedAway()) return;
        const presence = presenceUnderUrls(listed, fetchUrl, pushUrl);
        const create = willCreateOnRemote({
          upstream: head?.upstream ?? null,
          upstreamGone: head?.upstreamGone === true,
          setUpstream: true,
          remoteHasSameName: presence,
        });
        const outcome = pushOutcome({ willPublish: true, create, presence });
        if (create) {
          // The prompt stamps whichever repo is live when it asks, and Base UI
          // returns focus to the menu's trigger once its close finishes.
          await pushMenuClose.waitClosed();
          if (switchedAway()) return;
          const ok = await askPublishConfirm(
            {
              branch,
              remote,
              pushUrl,
              visibility: visibilityApplies(remote, fetchUrl, pushUrl)
                ? recordedVisibility(settings.data?.recentRepos, capture.repo)
                : null,
              goneUpstream: false,
              upstreamRemote: null,
              upstreamBranch: null,
            },
            publishAsk,
          );
          if (!ok) return;
        }
        // This route pushes directly, so the window its reads (and any prompt)
        // opened re-runs the checks doPush would: a push started meanwhile, or
        // a HEAD move.
        if (
          refuseWhileOffline() ||
          refuseWhilePushing() ||
          refuseWhilePublishing(queryClient, repoPath)
        )
          return;
        if (headNameRef.current !== branch) {
          toast.info("HEAD moved — nothing was pushed.");
          return;
        }
        await push.mutateAsync({
          setUpstream: true,
          branch,
          remote,
          source: "header",
        });
        const { away } = landedIn(capture.repo);
        // A create keeps the retrack tail; the other outcomes' description
        // carries it.
        const copy =
          outcome === "created"
            ? {
                title: `Published ${branch} to ${remote}${away} — Push now sends to ${remote}/${branch}`,
              }
            : pushSuccessCopy({ outcome, branch, remote, tracks: true, away });
        if (copy) toast.success(copy.title, { description: copy.description });
      }
    } catch (e) {
      onError(e);
    }
  }

  // One dispatch for the button and the hotkey. A mismatch outranks divergence:
  // force through a cross-name refspec would bypass the push routing the force
  // confirm relies on.
  function pressPush() {
    if (sync.mismatchMenu) openPushMenu();
    else if (diverged) openForceConfirm();
    else void beginPush(false);
  }

  // An open menu row, live while the status still names the pinned destinations
  // (so its hold reason matches its state); held with its pinned label once HEAD
  // or the upstream moved under it. A click always pushes the pinned names.
  const pinnedMenu = pushMenuCapture?.menu;
  const liveMenu = sync.mismatchMenu;
  const sameTarget =
    liveMenu !== null &&
    pinnedMenu !== undefined &&
    liveMenu.branch === pinnedMenu.branch &&
    liveMenu.remote === pinnedMenu.remote &&
    liveMenu.remoteBranch === pinnedMenu.remoteBranch;
  const menuRow = (
    pinned: MismatchMenuItem,
    live: MismatchMenuItem | null | undefined,
  ): MismatchMenuItem => {
    if (!sameTarget || !live) return { label: pinned.label, disabled: true };
    if (live.disabled) return live;
    // The menu can be open when another surface's push starts.
    if (otherPushRunning)
      return {
        label: `${live.label} (${branchPushHoldItemReason(otherPushPaused)})`,
        disabled: true,
      };
    return {
      label: `${live.label}${offlineSuffix}`,
      disabled: !!offlineHold,
    };
  };
  const trackedRow =
    pinnedMenu?.pushToTracked &&
    menuRow(pinnedMenu.pushToTracked, liveMenu?.pushToTracked);
  const publishRow =
    pinnedMenu && menuRow(pinnedMenu.publish, liveMenu?.publish);

  // A network op started now would queue behind a running push on the repo's
  // network lock for up to a minute, so it refuses and says why instead.
  function refuseWhilePushing(): boolean {
    return refuseWhilePushRuns(queryClient, repoPath);
  }

  // A reset moves `branch`'s ref, so only that branch's push holds it. Read live:
  // a push can start while the confirm or the re-measure is pending.
  function refuseWhileBranchPushes(branch: string): boolean {
    const pushes = pendingBranchPushesFor(
      pendingMutationEntries(
        queryClient
          .getMutationCache()
          .findAll({ mutationKey: branchPushKey(repoPath), status: "pending" }),
      ),
      repoPath,
    );
    if (!pushesBranch(pushes, branch, headNameRef.current ?? null))
      return false;
    toast.info(BRANCH_PUSH_ACTIVE_MESSAGE);
    return true;
  }

  // Hotkeys mirror the buttons' own holds (sync-controls-state.ts); the routes
  // they start refuse while another surface's push runs. The held Publish arm
  // renders none of these four buttons, so every one of their hotkeys holds too.
  useHotkeyAction(
    "fetch",
    () => void doFetch(false),
    hotkeys.fetch && !publishPending,
  );
  useHotkeyAction(
    "pull",
    () => void doPull("ffOnly"),
    hotkeys.pull && !publishPending,
  );
  useHotkeyAction(
    "push",
    () => {
      if (!refuseWhilePushing()) pressPush();
    },
    hotkeys.push && !publishPending,
  );
  // Palette-only (defaultBinding: null) and gated on the fork's `upstream`
  // remote existing (and not detached), so it hides itself when there's nothing
  // to sync from or nowhere to merge into.
  useHotkeyAction(
    "update-from-upstream",
    () => void doUpdateFromUpstream(),
    hotkeys.updateFromUpstream && !publishPending,
  );

  if (publishArm) {
    return (
      // A silent landing spot for focus across the swap with the sync cluster.
      <div ref={controlsRef} tabIndex={-1} className="flex outline-none">
        <PublishRepoControl
          repoPath={repoPath}
          providers={publish.providers}
          reserveCaret
          // A settled answer is already known, so it wins even offline; before
          // that, offline says the check waits for the connection.
          disabledTitle={
            publish.settled
              ? "Sign in with the GitHub CLI (gh auth login), GitLab CLI (glab auth login), or connect a Bitbucket account to publish"
              : publishPendingReason(offlineHold)
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
          {fetchRemote.isPending || autoFetch.isPending ? (
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
                  className={MENU_HELD_ROW_CLASS}
                  disabled={!!offlineHold}
                  onClick={() => void doPull("rebase")}
                >
                  Pull with rebase{offlineSuffix}
                </DropdownMenuItem>
                {/* Disabled with the reason IN the label: a disabled menu item
                    surfaces no tooltip, and the branch menu states the same
                    refusal the same way. */}
                <DropdownMenuItem
                  className={MENU_HELD_ROW_CLASS}
                  disabled={mergeRow.disabled}
                  title={mergeRow.title}
                  onClick={() => void doPull("merge")}
                >
                  {mergeRow.label}
                </DropdownMenuItem>
                {/* Offered only once the probe has measured an upstream that
                    carries every one of these commits, with no unique local
                    work; every other divergence keeps the two pull items
                    alone. While the probe re-reads over an answer that offered
                    it, the row holds its place with no onClick at all. */}
                {rewriteChecking && carriesAllLocalCommits(rewrite.data) ? (
                  <DropdownMenuItem className={MENU_HELD_ROW_CLASS} disabled>
                    Reset to {head?.upstream}… (checking the remote…)
                  </DropdownMenuItem>
                ) : (
                  remoteRebased && (
                    <DropdownMenuItem
                      className={MENU_HELD_ROW_CLASS}
                      onClick={() => void doResetToUpstream()}
                    >
                      Reset to {head?.upstream}…
                    </DropdownMenuItem>
                  )
                )}
              </>
            )}
            {canUpdateUpstream && (
              <>
                {hasUpstream && <DropdownMenuSeparator />}
                {/* Base UI menu items fire on onClick, NOT onSelect. */}
                <DropdownMenuItem
                  className={MENU_HELD_ROW_CLASS}
                  disabled={!!offlineHold}
                  onClick={() => void doUpdateFromUpstream()}
                >
                  Update from upstream{offlineSuffix}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        {sync.mismatchMenu ? (
          // git would refuse a bare push here, so Push is a menu of named
          // destinations. The trigger never pushes, and shows no diverged warning:
          // there is no force arm in this state.
          <DropdownMenu
            open={pushMenuOpen}
            onOpenChange={(o) => {
              if (o) openPushMenu();
              else setPushMenuOpen(false);
            }}
            onOpenChangeComplete={pushMenuClose.onOpenChangeComplete}
          >
            <DropdownMenuTrigger
              render={
                <DisabledReasonButton
                  ref={pushControlRef}
                  variant="outline"
                  size="sm"
                  disabled={sync.push.disabled}
                  reason={sync.push.reason}
                  title={pushTitle}
                  aria-label={sync.pushName}
                  aria-keyshortcuts={pushKeyshortcuts}
                  className="border-l-0 focus-visible:relative focus-visible:z-10 max-md:pr-1.5"
                >
                  {headerPushPending || detecting ? (
                    <Spinner data-icon="inline-start" className="size-3.5" />
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
                  <CaretDownIcon data-icon="inline-end" />
                </DisabledReasonButton>
              }
            />
            <DropdownMenuContent align="end" className="min-w-48">
              {pinnedMenu && (
                // The label names the group for assistive tech; Base UI's
                // GroupLabel must sit inside a group.
                <DropdownMenuGroup>
                  <DropdownMenuLabel>{pinnedMenu.groupLabel}</DropdownMenuLabel>
                  {trackedRow && (
                    <DropdownMenuItem
                      className={MENU_HELD_ROW_CLASS}
                      disabled={trackedRow.disabled}
                      onClick={() => void pushFromMenu("tracked")}
                    >
                      {trackedRow.label}
                    </DropdownMenuItem>
                  )}
                  {publishRow && (
                    <DropdownMenuItem
                      className={MENU_HELD_ROW_CLASS}
                      disabled={publishRow.disabled}
                      onClick={() => void pushFromMenu("publish")}
                    >
                      {publishRow.label}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuGroup>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <DisabledReasonButton
            ref={pushControlRef}
            variant="outline"
            size="sm"
            disabled={sync.push.disabled}
            reason={sync.push.reason}
            title={pushTitle}
            aria-label={sync.pushName}
            aria-keyshortcuts={pushKeyshortcuts}
            className="border-l-0 focus-visible:relative focus-visible:z-10 max-md:pr-1.5"
            onClick={pressPush}
          >
            {headerPushPending || detecting ? (
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
        )}
      </ButtonGroup>

      <Dialog
        open={forceConfirm?.open ?? false}
        onOpenChange={(o) => {
          if (!o) closeForceConfirm();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Force push?</DialogTitle>
            <DialogDescription>
              Your branch and {forceUpstream} have diverged (usually after
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
              is the remedy — equally true under ordinary divergence. Both are
              live, so a probe landing after the dialog opens still shows, and
              both hide while the status shows another HEAD. */}
          {forceEvidence && remoteRebased && (
            <p className="text-muted-foreground text-sm">
              {forceUpstream} already carries every commit on your branch under
              different ids. Force pushing would replace them with your copies;
              "Reset to {forceUpstream}" in the Pull menu keeps the same work
              and matches the remote instead.
            </p>
          )}
          {forceEvidence && localAtRisk > 0 && (
            <p className="text-muted-foreground text-sm">
              {localAtRisk} commit{localAtRisk === 1 ? "" : "s"} exist
              {localAtRisk === 1 ? "s" : ""} only on your branch
              {/* Only asserted where the counts actually found commits on the
                  other side — an amended tip plus one new local commit leaves
                  `remoteOnly` at zero, and the clause would be false. */}
              {remoteAhead > 0
                ? `, and ${forceUpstream} has ${remoteAhead} commit${remoteAhead === 1 ? "" : "s"} yours doesn't`
                : ""}
              . Pull with rebase keeps yours and replays them on top of{" "}
              {forceUpstream}.
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={closeForceConfirm}>
              Cancel
            </Button>
            <DisabledReasonButton
              variant="destructive"
              disabled={forceActPending || otherPushRunning || !!offlineHold}
              reason={(() => {
                switch (true) {
                  case forceActPending:
                    return ACT_PENDING_REASON;
                  case otherPushRunning:
                    return otherPushReason;
                  default:
                    return offlineHold;
                }
              })()}
              onClick={() => void confirmForcePush()}
            >
              {forceActPending && <Spinner data-icon="inline-start" />}
              Force push
            </DisabledReasonButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {forkGuard && (
        <ForkPrPublishGuard
          key={forkGuard.token}
          repoPath={forkGuard.repo}
          match={forkGuard.open ? forkGuard.match : null}
          branch={forkGuard.branch}
          onClose={() => closeForkGuard(forkGuard.token)}
          onPublishAnyway={() => {
            // Refused before the dialog closes, so it stays to retry from.
            if (
              forkGuard.open &&
              forkGuard.repo === repoPath &&
              (refuseWhilePushing() ||
                refuseWhilePublishing(queryClient, repoPath))
            )
              return;
            closeForkGuard(forkGuard.token);
            // Only this open, in its own still-live repo: `open` covers a
            // click during the dialog's close transition (silently), the
            // repo check a switch.
            if (
              !forkGuard.open ||
              refuseIfSwitched(forkGuard.repo, "nothing was published")
            )
              return;
            void doPush(
              false,
              forkGuard.branch,
              pushOutcome({
                willPublish: true,
                create: undefined,
                presence: undefined,
              }),
            );
          }}
        />
      )}

      {recovery.dialog}
      {pullDropGuard.dialog}
    </div>
  );
}
