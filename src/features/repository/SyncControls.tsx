import {
  ArrowDownIcon,
  ArrowsClockwiseIcon,
  ArrowUpIcon,
  CaretDownIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";
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
import type { PullMode } from "@/lib/git/api";
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
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { useSettings } from "@/lib/settings/queries";
import { formatRelativeTime } from "@/lib/time";
import { toastError } from "@/lib/toast";
import { PublishRepoControl, usePublishProviders } from "./PublishRepoControl";

export function SyncControls({ repoPath }: { repoPath: string }) {
  const status = useRepoStatus(repoPath);
  const remotes = useRemotes(repoPath);
  const settings = useSettings();
  const fetchRemote = useFetchRemote(repoPath);
  const pull = usePull(repoPath);
  const push = usePush(repoPath);
  const updateUpstream = useUpdateFromUpstream(repoPath);
  const markFetched = useFetchStatusStore((s) => s.markFetched);
  const lastFetchedAt = useLastFetchedAt(repoPath);
  const [forceConfirmOpen, setForceConfirmOpen] = useState(false);

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
    updateUpstream.isPending;
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

  function doPull(mode: PullMode) {
    pull.mutate(mode, {
      onSuccess: () => {
        if (mode === "rebase") toast.success("Pulled with rebase");
        else if (mode === "merge") toast.success("Pulled with merge");
      },
      onError,
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
    () => (diverged ? setForceConfirmOpen(true) : doPush(false)),
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
        <span className="inline-flex" title={pushDescription}>
          <Button
            variant="outline"
            size="sm"
            disabled={busy || detached}
            aria-label={pushDescription}
            className="focus-visible:relative focus-visible:z-10"
            onClick={() => {
              if (diverged) {
                setForceConfirmOpen(true);
              } else {
                doPush(false);
              }
            }}
          >
            {push.isPending ? (
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
        <span className="inline-flex" title={pullDescription}>
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !hasUpstream || diverged}
            aria-label={pullDescription}
            className="border-l-0 focus-visible:relative focus-visible:z-10"
            onClick={() => doPull("ffOnly")}
          >
            {pull.isPending ? (
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
        <span className="inline-flex" title={fetchTitle}>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            className="border-l-0 focus-visible:relative focus-visible:z-10"
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
    </div>
  );
}
