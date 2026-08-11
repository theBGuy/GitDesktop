import {
  ArrowDownIcon,
  ArrowsClockwiseIcon,
  ArrowUpIcon,
  CaretDownIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
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
import { forgeDetectForkPrForBranch, type PullMode } from "@/lib/git/api";
import {
  useAutoFetch,
  useFetchStatusStore,
  useLastFetchedAt,
} from "@/lib/git/auto-fetch";
import {
  useFetchRemote,
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
import { useSettings } from "@/lib/settings/queries";
import { formatRelativeTime } from "@/lib/time";
import { toastError } from "@/lib/toast";
import { ForkPrPublishGuard } from "./ForkPrPublishGuard";
import { PublishRepoControl, usePublishProviders } from "./PublishRepoControl";
import { useStashReapplyRecovery } from "./useStashReapplyRecovery";

export function SyncControls({ repoPath }: { repoPath: string }) {
  const status = useRepoStatus(repoPath);
  const remotes = useRemotes(repoPath);
  const settings = useSettings();
  const fetchRemote = useFetchRemote(repoPath);
  const pull = usePull(repoPath);
  const push = usePush(repoPath);
  const updateUpstream = useUpdateFromUpstream(repoPath);
  const recovery = useStashReapplyRecovery(repoPath);
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
  const [detecting, setDetecting] = useState(false);

  // A repo with no `origin` (e.g. created locally in GitDesktop) can't push;
  // offer to create the hosted repo instead. Which providers can take this
  // origin-less repo is probed by usePublishProviders (there's no remote to
  // detect one from), returning them in a stable GitHub → GitLab → Bitbucket
  // order.
  const noOrigin = remotes.isSuccess && !remotes.data.includes("origin");
  const hasOrigin = remotes.isSuccess && remotes.data.includes("origin");
  // A fork carries an `upstream` remote pointing at the source repo. Only then
  // do we offer "Update from upstream" (in the Pull menu and the palette).
  const hasUpstreamRemote =
    remotes.isSuccess && remotes.data.includes("upstream");
  const readyProviders = usePublishProviders(repoPath, noOrigin);

  const head = status.data?.branch;
  // A gone upstream (remote branch deleted, config lingers) reads as "no
  // upstream": the button flips to "Publish branch" and its push sends
  // `-u origin HEAD`, recreating the remote branch; Pull disables against the
  // dead ref.
  const hasUpstream = Boolean(head?.upstream) && !head?.upstreamGone;
  // amended/rewritten local history: local and remote both have commits the
  // other lacks, so neither pull --ff-only nor a normal push can succeed
  const diverged = Boolean(head && head.ahead > 0 && head.behind > 0);
  // A detached HEAD (mid-rebase, or `git checkout <sha>`) has no branch to push
  // or publish, and merging upstream INTO it would orphan the merge commit. A
  // push would otherwise hit the raw "refs/heads/HEAD" git error; gate both.
  // The BranchSwitcher alongside already surfaces the detached state.
  const detached = Boolean(head?.detached);
  const canUpdateUpstream = hasUpstreamRemote && !detached;
  const busy =
    fetchRemote.isPending ||
    pull.isPending ||
    push.isPending ||
    updateUpstream.isPending ||
    detecting ||
    recovery.pending;
  const onError = (e: unknown) => toastError(e);

  // One entry point for every fetch — manual (button/hotkey) and automatic —
  // so a successful fetch always records its freshness. Auto-fetches stay quiet
  // (a failed background fetch just retries next tick).
  function doFetch(silent: boolean) {
    fetchRemote.mutate(undefined, {
      onSuccess: () => markFetched(repoPath),
      onError: silent ? undefined : onError,
    });
  }

  // Opt-out periodic background fetch (Settings → General). Shares the fetch
  // mutation above, so the Fetch spinner covers it too.
  useAutoFetch({
    repoPath,
    enabled: settings.data?.autoFetch ?? false,
    intervalMs: Number(settings.data?.autoFetchInterval ?? "10") * 60_000,
    hasOrigin,
    busy,
    fetch: () => doFetch(true),
  });

  // Keep the Fetch tooltip's relative time honest while the window sits idle
  // (the status poll only re-renders on change). Cheap; only while we have a
  // timestamp to age.
  const [, tick] = useState(0);
  useEffect(() => {
    if (lastFetchedAt === undefined) return;
    const id = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, [lastFetchedAt]);

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
      : `Last fetched ${formatRelativeTime(new Date(lastFetchedAt).toISOString())}`;

  // Ahead/behind counts now ride on the Push and Pull buttons themselves (the
  // old standalone badges didn't say which button acted on them). Compute ONE
  // description string per button and reuse it for BOTH the wrapper span's
  // `title` and the Button's `aria-label`, so the pointer tooltip and the
  // accessible name never drift. Each string starts with the button's visible
  // label (WCAG 2.5.3, "label in name") and, when the button is disabled,
  // carries the reason + remedy AND the count — the count needs a full-contrast
  // home while the button itself sits at disabled opacity. The chains pick the
  // first matching state; `undefined` means the visible label alone suffices
  // (enabled + synced), so no tooltip and no aria-label are emitted.
  const aheadCount = head?.ahead ?? 0;
  const behindCount = head?.behind ?? 0;
  const pushLabel = diverged
    ? "Force push"
    : hasUpstream
      ? "Push"
      : "Publish branch";
  const aheadLabel =
    aheadCount > 0
      ? `${pushLabel} — ${aheadCount} commit${aheadCount === 1 ? "" : "s"} to push to ${head?.upstream}`
      : undefined;
  const behindLabel =
    behindCount > 0
      ? `Pull — ${behindCount} commit${behindCount === 1 ? "" : "s"} to pull from ${head?.upstream}`
      : undefined;
  const pushDescription = detached
    ? `${pushLabel} — you're on a detached HEAD; check out a branch to push`
    : aheadLabel;
  const pullDescription = diverged
    ? `Pull — branch has diverged (${behindCount} commit${behindCount === 1 ? "" : "s"} behind ${head?.upstream}); use Pull with rebase or merge from the menu`
    : detached
      ? "Pull — you're on a detached HEAD; check out a branch to pull"
      : head?.upstreamGone
        ? // A gone upstream is configured-but-dead (branch deleted on the
          // remote, e.g. after a merge) — not never-published; say so.
          `Pull — upstream ${head?.upstream} was deleted on the remote (likely merged); use Publish branch to recreate it`
        : !hasUpstream
          ? "Pull — no upstream branch to pull from yet; publish the branch first"
          : behindLabel;

  // Tooltip = the button's description (or its bare label when synced +
  // undefined) with the effective shortcut appended, e.g. "Push (Ctrl+P)".
  // When the action is explicitly unbound (null), the title stays exactly
  // today's value — the raw description, possibly undefined. `aria-keyshortcuts`
  // carries the shortcut on the proper ARIA channel so it stays OUT of each
  // button's accessible name — for Push/Pull that name is the description-only
  // `aria-label`; Fetch sets none, so its name is the visible "Fetch" label
  // (deliberate: its description is the volatile "Last fetched …" string, which
  // must stay tooltip-only, never a name). Omitted when unbound.
  const pushBinding = bindings.get("push") ?? null;
  const pullBinding = bindings.get("pull") ?? null;
  const fetchBinding = bindings.get("fetch") ?? null;
  const pushTitle =
    pushBinding === null
      ? pushDescription
      : `${pushDescription ?? pushLabel} (${formatBinding(pushBinding)})`;
  const pullTitle =
    pullBinding === null
      ? pullDescription
      : `${pullDescription ?? "Pull"} (${formatBinding(pullBinding)})`;
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

  // A pull refused because it would overwrite uncommitted changes isn't a dead
  // end: offer (or, with the preference on, just run) stash → pull → reapply.
  // Every other error keeps its normal toast. Triggered by the refusal itself,
  // never pre-flighted.
  function doPull(mode: PullMode) {
    const plain = pullSuccessMessage(mode);
    pull.mutate(mode, {
      onSuccess: () => {
        if (plain) toast.success(plain);
      },
      onError: (e) => {
        const taken = recovery.handleError(e, {
          operationLabel: "pull",
          reappliedMessage: "Pulled and reapplied your changes.",
          // ff-only has no ordinary success toast, but a recovery the user ran
          // deliberately still has to confirm itself.
          plainMessage: plain ?? "Pulled.",
          run: { op: "pull", mode },
        });
        if (!taken) onError(e);
      },
    });
  }

  // Sync the current branch with the fork's upstream: fetch upstream, resolve
  // its default branch, then fast-forward or merge. Honest terminal toast per
  // outcome; a conflicting merge rejects and the conflict banner takes over
  // (its error still toasts). No auto-push — Push lights up on its own.
  function doUpdateFromUpstream() {
    updateUpstream.mutate(undefined, {
      onSuccess: (outcome) => {
        const ref = `upstream/${outcome.branch}`;
        if (outcome.kind === "up-to-date") {
          toast.success(`Already up to date with ${ref}.`);
        } else if (outcome.kind === "fast-forwarded") {
          toast.success(`Fast-forwarded to ${ref}.`);
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
      },
      onError,
    });
  }

  function doPush(force: boolean) {
    push.mutate(
      { setUpstream: !hasUpstream, force },
      {
        onSuccess: () => {
          if (force) toast.success("Force pushed");
          setForceConfirmOpen(false);
        },
        onError: (e) => {
          onError(e);
          setForceConfirmOpen(false);
        },
      },
    );
  }

  // Publishing an untracked branch that is really a local copy of a fork PR's
  // head pushes a separate copy to origin and leaves the PR untouched — check
  // for that before publishing, and let the guard offer the fork instead. Purely
  // advisory: a detection failure is indistinguishable from no match and just
  // publishes. Pushes to a tracked upstream (and force pushes, which need one)
  // are correct as they stand and never ask.
  async function beginPush(force: boolean) {
    const branch = head?.name;
    if (force || hasUpstream || !branch) {
      doPush(force);
      return;
    }
    setDetecting(true);
    const match = await forgeDetectForkPrForBranch(repoPath, branch).catch(
      () => null,
    );
    setDetecting(false);
    // A HEAD that moved during the round-trip makes the match describe a branch
    // we're no longer on; pushing it onto the PR head would be a legal
    // fast-forward of the wrong work, so the moment has passed — just publish.
    if (match && headNameRef.current === branch)
      setForkGuard({ match, branch });
    else doPush(false);
  }

  // Hotkeys mirror the buttons' disabled states exactly.
  useHotkeyAction("fetch", () => doFetch(false), !noOrigin && !busy);
  // Pull needs no explicit `!detached` term: `hasUpstream` is already false on a
  // detached HEAD (the backend leaves `head.upstream` null, mirroring git's "no
  // upstream for a detached HEAD"), so this hotkey and the Pull button below are
  // disabled there for free — unlike Push, which has no upstream precondition.
  useHotkeyAction(
    "pull",
    () => doPull("ffOnly"),
    !noOrigin && !busy && hasUpstream && !diverged,
  );
  useHotkeyAction(
    "push",
    () => {
      if (diverged) setForceConfirmOpen(true);
      else void beginPush(false);
    },
    !noOrigin && !busy && !detached,
  );
  // Palette-only (defaultBinding: null) and gated on the fork's `upstream`
  // remote existing (and not detached), so it hides itself when there's nothing
  // to sync from or nowhere to merge into.
  useHotkeyAction(
    "update-from-upstream",
    doUpdateFromUpstream,
    canUpdateUpstream && !busy,
  );

  if (noOrigin) {
    return (
      <PublishRepoControl
        repoPath={repoPath}
        providers={readyProviders}
        disabledTitle="Sign in with the GitHub CLI (gh auth login), GitLab CLI (glab auth login), or connect a Bitbucket account to publish"
      />
    );
  }

  return (
    <div className="flex items-center gap-2">
      {/* Every segment is wrapped in a `title` <span> so a disabled button's
          reason still shows on hover (a natively disabled button swallows its
          own tooltip). Those spans have no `data-slot`, so they opt out of
          ButtonGroup's border-collapse/rounding child selectors
          (`*:data-slot:rounded-r-none` + `[&>[data-slot]~[data-slot]]`) — the
          primitive then contributes only layout + `role="group"`, and THIS call
          site owns the seams explicitly on the Buttons. The vendored Button is
          square (`rounded-none` in its cva root and `sm` variant), so the only
          load-bearing seam class is `border-l-0` on the joins. Keep it that way: a
          future reorder must set these classes, not lean on the primitive's
          adjacency magic (it has now misfired on two arrangements). The group's
          `*:focus-visible:z-10` also can't reach the Buttons through the spans,
          so each Button carries `focus-visible:relative focus-visible:z-10`. */}
      <ButtonGroup>
        <span className="inline-flex" title={fetchHintTitle}>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            aria-keyshortcuts={fetchKeyshortcuts}
            className="focus-visible:relative focus-visible:z-10"
            onClick={() => doFetch(false)}
          >
            {fetchRemote.isPending ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <ArrowsClockwiseIcon data-icon="inline-start" />
            )}
            Fetch
          </Button>
        </span>
        <span className="inline-flex" title={pullTitle}>
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !hasUpstream || diverged}
            aria-label={pullDescription}
            aria-keyshortcuts={pullKeyshortcuts}
            className="border-l-0 focus-visible:relative focus-visible:z-10"
            onClick={() => doPull("ffOnly")}
          >
            {/* Covers the recovery compounds too: with the preference on they
                run with no dialog open to show progress. */}
            {pull.isPending || recovery.pending ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <ArrowDownIcon data-icon="inline-start" />
            )}
            Pull
            {behindCount > 0 && (
              <span
                aria-hidden="true"
                className="text-muted-foreground tabular-nums"
              >
                {behindCount}
              </span>
            )}
          </Button>
        </span>
        <span className="inline-flex">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="outline"
                  size="sm"
                  aria-label="Pull options"
                  // Reachable whenever there's a menu item to show: the pull
                  // reconcile options (need a tracking upstream) or "Update from
                  // upstream" (needs the fork's upstream remote).
                  disabled={busy || (!hasUpstream && !canUpdateUpstream)}
                  className="border-l-0 px-1.5 focus-visible:relative focus-visible:z-10"
                >
                  <CaretDownIcon />
                </Button>
              }
            />
            <DropdownMenuContent align="end" className="min-w-48">
              {hasUpstream && (
                <>
                  <DropdownMenuItem onClick={() => doPull("rebase")}>
                    Pull with rebase
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => doPull("merge")}>
                    Pull with merge
                  </DropdownMenuItem>
                </>
              )}
              {canUpdateUpstream && (
                <>
                  {hasUpstream && <DropdownMenuSeparator />}
                  {/* Base UI menu items fire on onClick, NOT onSelect. */}
                  <DropdownMenuItem onClick={doUpdateFromUpstream}>
                    Update from upstream
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
        <span className="inline-flex" title={pushTitle}>
          <Button
            variant="outline"
            size="sm"
            disabled={busy || detached}
            aria-label={pushDescription}
            aria-keyshortcuts={pushKeyshortcuts}
            className="border-l-0 focus-visible:relative focus-visible:z-10"
            onClick={() => {
              if (diverged) {
                setForceConfirmOpen(true);
              } else {
                void beginPush(false);
              }
            }}
          >
            {push.isPending || detecting ? (
              <Spinner data-icon="inline-start" />
            ) : diverged ? (
              <WarningIcon data-icon="inline-start" />
            ) : (
              <ArrowUpIcon data-icon="inline-start" />
            )}
            {pushLabel}
            {aheadCount > 0 && (
              <span
                aria-hidden="true"
                className="text-muted-foreground tabular-nums"
              >
                {aheadCount}
              </span>
            )}
          </Button>
        </span>
      </ButtonGroup>

      <Dialog open={forceConfirmOpen} onOpenChange={setForceConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Force push?</DialogTitle>
            <DialogDescription>
              Your branch and {head?.upstream} have diverged (usually after
              amending or resetting a pushed commit). Force pushing rewrites the
              remote branch to match your local one. Uses --force-with-lease, so
              it aborts if someone else pushed new work in the meantime.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setForceConfirmOpen(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={push.isPending}
              onClick={() => doPush(true)}
            >
              {push.isPending && <Spinner data-icon="inline-start" />}
              Force push
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ForkPrPublishGuard
        repoPath={repoPath}
        match={forkGuard?.match ?? null}
        branch={forkGuard?.branch ?? ""}
        onClose={() => setForkGuard(null)}
        onPublishAnyway={() => {
          setForkGuard(null);
          doPush(false);
        }}
      />

      {recovery.dialog}
    </div>
  );
}
