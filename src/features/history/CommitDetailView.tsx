import { CopyIcon, DotsThreeVerticalIcon } from "@phosphor-icons/react";
import { useDeferredValue, useMemo, useState } from "react";
import { toast } from "sonner";
import { CommitAuthorAvatar } from "@/components/commit-author-avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { AmendForcePushDialog } from "@/features/commit/AmendForcePushDialog";
import { DiffPlaceholder } from "@/features/diff/DiffPlaceholder";
import { DiffSurface, type LineWidget } from "@/features/diff/DiffSurfaceLazy";
import { JiraRefRow } from "@/features/issues/JiraRefRow";
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
import { formatRelativeTime } from "@/lib/time";
import { toastError } from "@/lib/toast";
import { cn } from "@/lib/utils";
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
  const diff = useCommitFileDiff(repoPath, hash, deferredPath);

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
  const comments = useCommitComments(repoPath, commentsEnabled ? hash : null);
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
  const lineAnchors = useCommitLineAnchors(
    comments.data,
    providerKey === "github" ? remoteSections : undefined,
    commentsEnabled ? deferredPath : null,
  );
  const lineWidget = useMemo<LineWidget | undefined>(() => {
    if (!commentsEnabled || !deferredPath) return undefined;
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
        />
      ),
    };
  }, [
    commentsEnabled,
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

  async function copyHash() {
    try {
      await navigator.clipboard.writeText(commit.hash);
      toast.success("Commit hash copied");
    } catch {
      toast.error("Could not copy to clipboard");
    }
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
    <div className="flex h-full flex-col">
      <header className="space-y-1 border-b px-4 py-3">
        <h2 className="text-sm font-medium">{commit.subject}</h2>
        {commit.body && (
          <p className="max-h-24 overflow-y-auto text-xs whitespace-pre-wrap text-muted-foreground">
            {commit.body}
          </p>
        )}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <CommitAuthorAvatar name={commit.author} email={commit.authorEmail} />
          <span>{commit.author}</span>
          <span>•</span>
          <span>{formatRelativeTime(commit.date)}</span>
          <span>•</span>
          <button
            type="button"
            className="inline-flex items-center gap-1 font-mono hover:text-foreground"
            onClick={copyHash}
            title="Copy full hash"
          >
            {commit.hash.slice(0, 7)}
            <CopyIcon className="size-3" />
          </button>
          <span className="flex-1" />
          <span className="text-success">+{totalAdded}</span>
          <span className="text-destructive">-{totalDeleted}</span>
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
              <DropdownMenuItem
                onClick={() => checkoutCommit.mutate(hash, { onError })}
              >
                Checkout commit
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => revertCommit.mutate(hash, { onError })}
              >
                Revert changes in commit
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() =>
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
                  })
                }
              >
                Cherry-pick commit
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => copyText(commit.hash, "SHA copied")}
              >
                Copy SHA
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <JiraRefRow
          repoPath={repoPath}
          sources={[
            { label: "commit subject", text: commit.subject },
            { label: "commit message body", text: commit.body },
          ]}
        />
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-72 shrink-0 flex-col border-r">
          <p className="border-b px-3 py-1.5 text-xs text-muted-foreground">
            {files.data.length} changed file{files.data.length === 1 ? "" : "s"}
          </p>
          <ScrollArea className="min-h-0 flex-1">
            <div onKeyDown={onFilesKeyDown}>
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
                  {file.isBinary ? (
                    <span className="shrink-0 text-muted-foreground">bin</span>
                  ) : (
                    <span className="shrink-0 tabular-nums">
                      <span className="text-success">+{file.added}</span>{" "}
                      <span className="text-destructive">-{file.deleted}</span>
                    </span>
                  )}
                </button>
              ))}
            </div>
          </ScrollArea>
        </aside>
        <main className="min-w-0 flex-1">
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
      </div>

      {commentsEnabled ? (
        <div className="max-h-[45%] shrink-0 border-t">
          <CommitComments
            repoPath={repoPath}
            sha={hash}
            canComment={canCommentCommits}
            remoteLabel={remoteLabel}
            diffSections={providerKey === "github" ? remoteSections : undefined}
            selectedPath={deferredPath}
            onSelectFile={selectFileFromComments}
          />
        </div>
      ) : gate && onRemote.data === false ? (
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
