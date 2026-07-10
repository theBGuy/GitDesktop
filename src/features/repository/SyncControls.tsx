import {
  ArrowDownIcon,
  ArrowsClockwiseIcon,
  ArrowUpIcon,
  CaretDownIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { AnimatePresence, m } from "motion/react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
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
} from "@/lib/git/queries";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { quickTransition } from "@/lib/motion";
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
  const busy = fetchRemote.isPending || pull.isPending || push.isPending;
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

  function doPull(mode: PullMode) {
    pull.mutate(mode, {
      onSuccess: () => {
        if (mode === "rebase") toast.success("Pulled with rebase");
        else if (mode === "merge") toast.success("Pulled with merge");
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
  useHotkeyAction(
    "pull",
    () => doPull("ffOnly"),
    !noOrigin && !busy && hasUpstream && !diverged,
  );
  useHotkeyAction(
    "push",
    () => (diverged ? setForceConfirmOpen(true) : doPush(false)),
    !noOrigin && !busy,
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
      <AnimatePresence>
        {head && head.ahead > 0 && (
          <m.div
            key="ahead"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            transition={quickTransition}
          >
            <Badge variant="secondary">
              <ArrowUpIcon className="size-3" />
              {head.ahead}
            </Badge>
          </m.div>
        )}
        {head && head.behind > 0 && (
          <m.div
            key="behind"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            transition={quickTransition}
          >
            <Badge variant="secondary">
              <ArrowDownIcon className="size-3" />
              {head.behind}
            </Badge>
          </m.div>
        )}
      </AnimatePresence>
      <ButtonGroup>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          title={fetchTitle}
          onClick={() => doFetch(false)}
        >
          {fetchRemote.isPending ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <ArrowsClockwiseIcon data-icon="inline-start" />
          )}
          Fetch
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !hasUpstream || diverged}
          title={
            diverged
              ? "Branch has diverged — use Pull with rebase or merge from the menu"
              : undefined
          }
          onClick={() => doPull("ffOnly")}
        >
          {pull.isPending ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <ArrowDownIcon data-icon="inline-start" />
          )}
          Pull
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="outline"
                size="sm"
                aria-label="Pull options"
                disabled={busy || !hasUpstream}
                className="px-1.5"
              >
                <CaretDownIcon />
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="min-w-48">
            <DropdownMenuItem onClick={() => doPull("rebase")}>
              Pull with rebase
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => doPull("merge")}>
              Pull with merge
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
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
          {diverged ? "Force push" : hasUpstream ? "Push" : "Publish branch"}
        </Button>
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
