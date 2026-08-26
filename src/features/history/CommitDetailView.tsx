import { CopyIcon, DotsThreeVerticalIcon } from "@phosphor-icons/react";
import { useDeferredValue, useMemo, useState } from "react";
import { toast } from "sonner";
import { CommitAuthorAvatar } from "@/components/commit-author-avatar";
import { DetailRail, DetailRailRow } from "@/components/detail-rail";
import { DiffStat } from "@/components/diff-stat";
import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { MarkdownRefs } from "@/components/ui/markdown-refs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { AmendForcePushDialog } from "@/features/commit/AmendForcePushDialog";
import { DiffPlaceholder } from "@/features/diff/DiffPlaceholder";
import { DiffSurface, type LineWidget } from "@/features/diff/DiffSurfaceLazy";
import { JiraRefRow } from "@/features/issues/JiraRefRow";
import { LinearRefRow } from "@/features/issues/LinearRefRow";
import {
  CommitComments,
  CommitLineComposer,
  useCommitLineAnchors,
} from "@/features/pulls/CommitComments";
import { usePrCapabilities } from "@/features/pulls/usePrCapabilities";
import { copyText } from "@/lib/clipboard";
import { splitUnifiedDiff } from "@/lib/git/diff-split";
import {
  forgeReady,
  useCheckoutCommit,
  useCherryPick,
  useCommitAuthorAvatarIndex,
  useCommitComments,
  useCommitDetails,
  useCommitFileDiff,
  useCommitFiles,
  useCommitOnRemote,
  useForgeStatus,
  useHoverPrefetch,
  useLog,
  usePrefetchCommitFileDiff,
  useRemoteCommitDiff,
  useRevertCommit,
} from "@/lib/git/queries";
import { providerLabel } from "@/lib/git/types";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { useConfirm } from "@/lib/stores/confirm";
import { toastError } from "@/lib/toast";
import { cn, PLACEHOLDER_FADE } from "@/lib/utils";
import {
  checkoutCommitConfirm,
  checkoutCommitSuccessToast,
  cherryPickCommitConfirm,
  revertCommitConfirm,
} from "./commit-confirms";
import { FileRowActions } from "./FileRowActions";
import { useAmendWithConfirm } from "./useAmendCommit";

export function CommitDetailView({
  repoPath,
  hash,
}: {
  repoPath: string;
  hash: string;
}) {
  const details = useCommitDetails(repoPath, hash);
  const files = useCommitFiles(repoPath, hash);
  // Batch-resolve commit-author avatars (GitHub-only; deduped by react-query).
  useCommitAuthorAvatarIndex(repoPath);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  // Reset the manual selection when a different commit is shown — a render
  // -time state adjustment, not an effect.
  const [lastHash, setLastHash] = useState(hash);
  if (hash !== lastHash) {
    setLastHash(hash);
    setSelectedPath(null);
  }
  // Default to the first changed file until the user picks one (derived, so
  // there's no empty-selection frame while an effect catches up).
  const effectivePath =
    selectedPath && files.data?.some((f) => f.path === selectedPath)
      ? selectedPath
      : (files.data?.[0]?.path ?? null);
  // Drive the diff off a deferred path so rapidly arrowing the file list only
  // fetches + renders the file you land on, not every one passed (each fetch's
  // large IPC payload otherwise deserializes on the main thread and stalls
  // input). The file-list highlight still uses effectivePath, so it stays live.
  const deferredPath = useDeferredValue(effectivePath);
  // Fetch only once the path is one this commit actually changed. The path comes
  // FROM the file list, so it's the previous commit's both while that list is a
  // placeholder AND for the deferred frame after it settles — and a fetch there
  // "succeeds" with an empty diff, flashing "No changes to show".
  const diffEnabled =
    !files.isPlaceholderData &&
    (files.data?.some((f) => f.path === deferredPath) ?? false);
  const diff = useCommitFileDiff(repoPath, hash, deferredPath, diffEnabled);

  // Commit-comment surface — mirrors the PR Commits drill-in (PrCommitDetail),
  // but lights up ONLY when the repo has a ready forge, the provider supports
  // commit comments, AND this commit actually exists on the remote. Every fetch
  // below is gated so a local-only repo issues ZERO forge calls and this view
  // renders byte-identically to before. All these hooks sit ABOVE the early
  // returns to keep hook order stable across the skeleton/error frames.
  const forge = useForgeStatus(repoPath);
  const provider = forge.data?.provider;
  const providerKey = provider ?? "github";
  const remoteLabel = providerLabel(provider);
  const ready = forgeReady(forge.data);
  const { canCommentCommits } = usePrCapabilities(forge.data, provider);
  const gate = ready && canCommentCommits;
  const onRemote = useCommitOnRemote(repoPath, gate ? hash : null);
  const commentsEnabled = gate && onRemote.data === true;
  // Origin lens: the History surface reads a repo's OWN commits (the fork's
  // origin); the fork/upstream lens is a PR/Issues-tab affordance.
  const comments = useCommitComments(
    repoPath,
    commentsEnabled ? hash : null,
    "origin",
  );
  // GitHub commit-comment `position` mapping must walk GitHub's OWN patch (local
  // git's diff can differ — rename detection, context), so we fetch the forge's
  // diff only for GitHub. GitLab/Bitbucket anchor by plain line and need none.
  const remoteDiff = useRemoteCommitDiff(
    repoPath,
    providerKey === "github" && commentsEnabled ? hash : null,
  );
  const remoteSections = useMemo(
    () => splitUnifiedDiff(remoteDiff.data ?? ""),
    [remoteDiff.data],
  );

  // Line-anchored comments + the inline composer target the RENDERED file, which
  // the diff drives off `deferredPath` (not effectivePath) — so use deferredPath
  // throughout, letting anchors/widget follow the file the diff actually shows
  // while rapid arrow-keying settles.
  // Inline comment bodies linkify against the same origin-lens repo they were
  // read from; the resolved provider only, never `providerKey`'s GitHub default.
  const commentRefs: MarkdownRefs | undefined = provider
    ? { provider, repoPath, lens: "origin" }
    : undefined;
  const lineAnchors = useCommitLineAnchors(
    comments.data,
    providerKey === "github" ? remoteSections : undefined,
    commentsEnabled ? deferredPath : null,
    commentRefs,
  );
  // Both commit queries keep serving the PREVIOUS commit while the selected one
  // loads, so everything derived from them is that commit's until it lands.
  const stale = details.isPlaceholderData || files.isPlaceholderData;
  // The diff query outlasts that window with the previous FILE's diff, so the
  // rendered lines can belong to another file or commit than `hash`+`deferredPath`.
  const diffStale = stale || diff.isPlaceholderData;
  const lineWidget = useMemo<LineWidget | undefined>(() => {
    if (!commentsEnabled || !deferredPath) return undefined;
    // A line click while stale would address `hash` — the newly selected commit —
    // with a path and line read off the previous one's diff.
    if (diffStale) return undefined;
    // On GitHub the composer recovers its `position` from the FORGE diff; until
    // that fetch succeeds `remoteSections` is empty, so every line would open the
    // composer disabled with "This line isn't in the commit's diff for this file"
    // — a reason that blames the line rather than the missing patch. So keep the
    // line numbers un-clickable (read-only diff) until the remote diff loads; the
    // whole-commit composer in the pane below still works. GitLab/Bitbucket anchor
    // by plain line and need no remote diff, so they're unaffected.
    if (providerKey === "github" && !remoteDiff.isSuccess) return undefined;
    return {
      enabled: true,
      render: ({ side, line, fromLine, onClose }) => (
        <CommitLineComposer
          repoPath={repoPath}
          sha={hash}
          path={deferredPath}
          side={side}
          line={line}
          fromLine={fromLine}
          provider={providerKey}
          fileSection={
            providerKey === "github"
              ? remoteSections.get(deferredPath)
              : undefined
          }
          onClose={onClose}
          lens="origin"
        />
      ),
    };
  }, [
    commentsEnabled,
    diffStale,
    deferredPath,
    repoPath,
    hash,
    providerKey,
    remoteSections,
    remoteDiff.isSuccess,
  ]);

  // Same actions as the history list's right-click menu (minus the
  // dialog-driven ones), surfaced behind a visible ⋯ for discoverability.
  const log = useLog(repoPath);
  const { requestAmend, forcePushDialog } = useAmendWithConfirm(repoPath);
  const checkoutCommit = useCheckoutCommit(repoPath);
  const revertCommit = useRevertCommit(repoPath);
  const cherryPick = useCherryPick(repoPath);
  const prefetchFileDiff = usePrefetchCommitFileDiff(repoPath);
  const hoverPrefetch = useHoverPrefetch();
  const isLatest = log.data?.pages[0]?.[0]?.hash === hash;
  const onError = (e: unknown) => toastError(e);

  if (details.isPending || files.isPending) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }
  if (details.isError || files.isError) {
    return <DiffPlaceholder message="Could not load this commit" />;
  }

  const commit = details.data;
  const totalAdded = files.data.reduce((sum, f) => sum + f.added, 0);
  const totalDeleted = files.data.reduce((sum, f) => sum + f.deleted, 0);
  // Fade the stale content so the pane never passes it off as current. The ⋯
  // actions act on the `hash` prop, so they stay solid.
  const staleDim = stale && "opacity-80";
  // The diff pane keeps serving the previous file's diff for longer than the rest
  // (its query stays on placeholder data through the gated window above), so it
  // fades on its own state. Never nested inside another dim — 0.8² reads as
  // disabled.
  const diffDim = (staleDim || diff.isPlaceholderData) && "opacity-80";

  // Identity comes from the `hash` PROP, never `commit.hash`: while the next
  // commit's details load, `details.data` is still the previous commit's
  // placeholder — copying from it would hand over the wrong SHA.
  async function copyHash() {
    try {
      await navigator.clipboard.writeText(hash);
      toast.success("Commit hash copied");
    } catch {
      toast.error("Could not copy to clipboard");
    }
  }

  // Each of these asks before it runs, in the same words as the History list's
  // menu. All three act on the `hash` PROP for the same reason `copyHash` does.
  async function doCheckoutCommit() {
    if (!(await useConfirm.getState().ask(checkoutCommitConfirm(hash)))) return;
    checkoutCommit.mutate(hash, {
      onSuccess: () => toast.success(checkoutCommitSuccessToast(hash)),
      onError,
    });
  }

  async function doRevertCommit() {
    if (!(await useConfirm.getState().ask(revertCommitConfirm(hash)))) return;
    revertCommit.mutate(hash, { onError });
  }

  // No branch name: this view doesn't subscribe to repo status, and doing so for
  // one prompt's wording would re-render the diff pane on every status poll.
  async function doCherryPick() {
    const ok = await useConfirm
      .getState()
      .ask(cherryPickCommitConfirm(hash, null));
    if (!ok) return;
    cherryPick.mutate(hash, {
      onSuccess: (applied) => {
        if (applied) {
          toast.success(`Cherry-picked ${hash.slice(0, 7)}`);
        } else {
          toast.info(
            "Nothing to cherry-pick — these changes are already on this branch.",
          );
        }
      },
      onError,
    });
  }

  const fileList = files.data;
  // The comments pane's file jumps carry a FORGE-derived path (GitHub's patch),
  // but the sidebar + effectivePath guard come from LOCAL `useCommitFiles`. On a
  // rename the two can name the same file differently, so a raw setSelectedPath
  // would silently no-op and snap the diff to the first file. Only honor the jump
  // when the local diff actually has that path; otherwise say so instead.
  const selectFileFromComments = (path: string) => {
    if (fileList.some((f) => f.path === path)) setSelectedPath(path);
    else toast.info(`${path} isn't in this commit's local diff`);
  };
  // Arrow keys walk the file list; the diff loads off a deferred path (above),
  // so rapid arrowing never fetches a diff per file passed — only the one
  // landed on. No neighbor prefetch on arrow: it fired on every pause and
  // stalled input. Mouse hover still warms a row's diff.
  const onFilesKeyDown = listKeyboardNav({
    items: fileList,
    activeIndex: fileList.findIndex((f) => f.path === effectivePath),
    onActivate: (file) => setSelectedPath(file.path),
    rowKey: (file) => file.path,
    rowAttr: "data-path",
  });

  return (
    <div className="flex h-full flex-col" aria-busy={Boolean(staleDim)}>
      <header className="space-y-1 border-b px-4 py-3">
        <h2 className={cn("text-sm font-medium", PLACEHOLDER_FADE, staleDim)}>
          {commit.subject}
        </h2>
        {commit.body && (
          <p
            className={cn(
              "max-h-24 overflow-y-auto text-xs whitespace-pre-wrap text-muted-foreground",
              PLACEHOLDER_FADE,
              staleDim,
            )}
          >
            {commit.body}
          </p>
        )}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span
            className={cn(
              "flex items-center gap-2",
              PLACEHOLDER_FADE,
              staleDim,
            )}
          >
            <CommitAuthorAvatar
              name={commit.author}
              email={commit.authorEmail}
            />
            <span>{commit.author}</span>
            <span>•</span>
            <span>
              <RelativeTime date={commit.date} />
            </span>
            <span>•</span>
          </span>
          <button
            type="button"
            className="inline-flex items-center gap-1 font-mono hover:text-foreground"
            onClick={copyHash}
            title="Copy full hash"
          >
            {hash.slice(0, 7)}
            <CopyIcon className="size-3" />
          </button>
          <span className="flex-1" />
          <DiffStat
            added={totalAdded}
            deleted={totalDeleted}
            className={cn(
              "flex items-center gap-2",
              PLACEHOLDER_FADE,
              staleDim,
            )}
          />
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Commit actions"
                />
              }
            >
              <DotsThreeVerticalIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent className="min-w-56" align="end">
              <DropdownMenuItem
                disabled={!isLatest}
                onClick={() => requestAmend(hash)}
              >
                Amend commit…
              </DropdownMenuItem>
              <DropdownMenuItem onClick={doCheckoutCommit}>
                Checkout commit
              </DropdownMenuItem>
              <DropdownMenuItem onClick={doRevertCommit}>
                Revert changes in commit
              </DropdownMenuItem>
              <DropdownMenuItem onClick={doCherryPick}>
                Cherry-pick commit
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => copyText(hash, "SHA copied")}>
                Copy SHA
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {/* Absent rather than faded while the details are a placeholder: these
            are CLICKABLE links mined from the message text, and a dimmed one
            still navigates to the previous commit's issue. */}
        {!details.isPlaceholderData && (
          <>
            <JiraRefRow
              repoPath={repoPath}
              sources={[
                { label: "commit subject", text: commit.subject },
                { label: "commit message body", text: commit.body },
              ]}
            />
            <LinearRefRow
              repoPath={repoPath}
              sources={[
                { label: "commit subject", text: commit.subject },
                { label: "commit message body", text: commit.body },
              ]}
            />
          </>
        )}
      </header>

      <DetailRailRow>
        <DetailRail
          ariaLabel="Changed files"
          className={cn(PLACEHOLDER_FADE, staleDim)}
          header={
            <p className="truncate text-xs text-muted-foreground">
              {files.data.length} changed file
              {files.data.length === 1 ? "" : "s"}
            </p>
          }
        >
          {/* overflow-hidden contains the list's natural height (vendored Root is
              `relative`-only) so a long file list can't leak a window scrollbar. */}
          <ScrollArea className="min-h-0 flex-1 overflow-hidden">
            <FileRowActions
              repoPath={repoPath}
              blameRev={hash}
              onKeyDown={onFilesKeyDown}
            >
              {files.data.map((file) => (
                <button
                  type="button"
                  key={file.path}
                  data-path={file.path}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs",
                    effectivePath === file.path
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-muted/60",
                  )}
                  onClick={() => setSelectedPath(file.path)}
                  onMouseEnter={() =>
                    hoverPrefetch(() => prefetchFileDiff(hash, file.path))
                  }
                  title={file.path}
                >
                  <span className="min-w-0 flex-1 truncate font-mono">
                    {file.path}
                  </span>
                  <DiffStat
                    added={file.added}
                    deleted={file.deleted}
                    isBinary={file.isBinary}
                  />
                </button>
              ))}
            </FileRowActions>
          </ScrollArea>
        </DetailRail>
        <main
          aria-busy={Boolean(diffDim)}
          className={cn("min-w-0 flex-1", PLACEHOLDER_FADE, diffDim)}
        >
          {deferredPath ? (
            <DiffSurface
              filePath={deferredPath}
              diff={diff}
              repoPath={repoPath}
              imageRevs={{ old: `${hash}~1`, new: hash }}
              contentRevs={{ oldRev: `${hash}~1`, newRev: hash }}
              lineAnchors={lineAnchors}
              lineWidget={lineWidget}
            />
          ) : (
            <DiffPlaceholder message="Select a file to see its changes" />
          )}
        </main>
      </DetailRailRow>

      {/* Mounted for every commit, rendering only where comments are supported:
          arrowing through history must not tear down its per-commit drafts. */}
      <CommitComments
        enabled={commentsEnabled}
        repoPath={repoPath}
        sha={hash}
        canComment={canCommentCommits}
        remoteLabel={remoteLabel}
        diffSections={providerKey === "github" ? remoteSections : undefined}
        selectedPath={deferredPath}
        onSelectFile={selectFileFromComments}
        lens="origin"
        stale={stale}
      />
      {gate && onRemote.data === false ? (
        // The forge query RESOLVED false — this commit isn't pushed yet. Shown
        // only after resolution (never while pending), so there's no flash for a
        // commit that is on the remote.
        <p className="border-t px-4 py-2 text-xs text-muted-foreground">
          This commit isn't on {remoteLabel} yet — push it to comment.
        </p>
      ) : null}

      <AmendForcePushDialog {...forcePushDialog} />
    </div>
  );
}
