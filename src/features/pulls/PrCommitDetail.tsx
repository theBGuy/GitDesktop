import { CopyIcon } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { DetailRail, DetailRailRow } from "@/components/detail-rail";
import { DiffStat } from "@/components/diff-stat";
import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { DiffPlaceholder } from "@/features/diff/DiffPlaceholder";
import { DiffContent, type LineWidget } from "@/features/diff/DiffSurfaceLazy";
import { FileRowActions } from "@/features/history/FileRowActions";
import { copyText } from "@/lib/clipboard";
import { splitUnifiedDiff } from "@/lib/git/diff-split";
import { useCommitComments, usePrCommitDiff } from "@/lib/git/queries";
import type { PrCommitOut, RemoteLens } from "@/lib/git/types";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { parseableDate } from "@/lib/time";
import { cn } from "@/lib/utils";
import {
  CommitComments,
  CommitLineComposer,
  useCommitLineAnchors,
} from "./CommitComments";

interface PrCommitDetailProps {
  repoPath: string;
  /** PR number. */
  number: number;
  commit: PrCommitOut;
  onBack: () => void;
  canCommentCommits: boolean;
  /** "GitHub" | "GitLab" | "Bitbucket" — for provider-named copy. */
  remoteLabel: string;
  /** The forge provider, for the line-comment composer's anchoring (GitHub needs
   *  a diff `position`; GitLab/Bitbucket anchor by line). Defaults to "github". */
  provider?: "github" | "gitlab" | "bitbucket";
  /** The origin|upstream lens the parent PR view resolved. */
  lens: RemoteLens;
}

/** Adds/deletions in one file's unified-diff section (its `+`/`-` body lines,
 *  excluding the `+++`/`---` file headers). */
function countChanges(section: string): { added: number; deleted: number } {
  let added = 0;
  let deleted = 0;
  for (const line of section.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) deleted += 1;
  }
  return { added, deleted };
}

/**
 * The remote commit-detail surface for a PR's Commits tab drill-in: subject +
 * full message body, a changed-file sidebar with arrow-key nav, the selected
 * file's diff (with any line-anchored commit comments rendered inline), and the
 * whole-commit comment thread + composer. Read-only on the commit itself — a
 * remote commit may not exist locally, so no amend/checkout/revert/cherry-pick.
 *
 * The parent (P5) wires this into the PR view; it never touches those files.
 */
export function PrCommitDetail({
  repoPath,
  number,
  commit,
  onBack,
  canCommentCommits,
  remoteLabel,
  provider = "github",
  lens,
}: PrCommitDetailProps) {
  const diff = usePrCommitDiff(repoPath, number, commit.oid, lens);
  const comments = useCommitComments(repoPath, commit.oid, lens);

  const sections = useMemo(
    () => splitUnifiedDiff(diff.data ?? ""),
    [diff.data],
  );
  const files = useMemo(
    () =>
      [...sections.entries()].map(([path, section]) => ({
        path,
        section,
        ...countChanges(section),
        isBinary: section.includes("Binary files "),
      })),
    [sections],
  );

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  // Default to the first file until the user picks one (derived, so there's no
  // empty-selection frame while an effect catches up).
  const effectivePath =
    selectedPath && files.some((f) => f.path === selectedPath)
      ? selectedPath
      : (files[0]?.path ?? null);

  const onFilesKeyDown = listKeyboardNav({
    items: files,
    activeIndex: files.findIndex((f) => f.path === effectivePath),
    onActivate: (f) => setSelectedPath(f.path),
    rowKey: (f) => f.path,
    rowAttr: "data-path",
  });

  // Line-anchored comments on the SELECTED file that resolve to a new-side line
  // render inline in the diff; ones that can't resolve fall back to the
  // CommitComments labelled group. Grouping + range chips live in the shared hook.
  const lineAnchors = useCommitLineAnchors(
    comments.data,
    sections,
    effectivePath,
    { provider, repoPath, lens },
  );

  const selected = files.find((f) => f.path === effectivePath);
  const fileDiff = selected
    ? {
        filePath: selected.path,
        text: selected.section,
        isBinary: selected.isBinary,
        isTruncated: false,
      }
    : undefined;

  // Line-anchored comment creation: when the viewer can comment, clicking a diff
  // line opens the inline composer below it. Anchored to the SELECTED file's
  // section (GitHub recovers the diff `position` from it). Absent otherwise, so
  // the diff stays read-only exactly as before.
  const lineWidget = useMemo<LineWidget | undefined>(() => {
    if (!canCommentCommits || !effectivePath) return undefined;
    return {
      enabled: true,
      render: ({ side, line, fromLine, onClose }) => (
        <CommitLineComposer
          repoPath={repoPath}
          sha={commit.oid}
          path={effectivePath}
          side={side}
          line={line}
          fromLine={fromLine}
          provider={provider}
          fileSection={sections.get(effectivePath)}
          onClose={onClose}
          lens={lens}
        />
      ),
    };
  }, [
    canCommentCommits,
    effectivePath,
    repoPath,
    commit.oid,
    provider,
    sections,
    lens,
  ]);

  return (
    <div className="flex h-full flex-col">
      <header className="space-y-1 border-b px-4 py-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={onBack}
          aria-label="Back to commits"
          className="-ml-2 h-7 text-muted-foreground hover:text-foreground"
        >
          ‹ Commits
        </Button>
        <h2 className="text-sm font-medium">{commit.headline}</h2>
        {commit.messageBody && (
          <pre className="max-h-24 overflow-y-auto font-mono text-xs whitespace-pre-wrap text-muted-foreground">
            {commit.messageBody}
          </pre>
        )}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="flex size-4 items-center justify-center rounded-full bg-muted text-[9px] uppercase">
            {commit.author.slice(0, 1)}
          </span>
          <span>{commit.author}</span>
          {/* Separator and date are one unit: an unparseable date renders
              nothing, and a lone bullet would dangle beside it. */}
          {parseableDate(commit.date) && (
            <>
              <span>•</span>
              <span>
                <RelativeTime date={commit.date} />
              </span>
            </>
          )}
          <span>•</span>
          <button
            type="button"
            className="inline-flex items-center gap-1 font-mono hover:text-foreground"
            onClick={() => copyText(commit.oid, "SHA copied")}
            title="Copy full SHA"
          >
            {commit.oid.slice(0, 7)}
            <CopyIcon className="size-3" />
          </button>
        </div>
      </header>

      {diff.isPending ? (
        <div className="space-y-3 p-4">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : diff.isError ? (
        <DiffPlaceholder message="Could not load this commit's changes" />
      ) : (
        <DetailRailRow>
          <DetailRail
            ariaLabel="Changed files"
            header={
              <p className="truncate text-xs text-muted-foreground">
                {files.length} changed file{files.length === 1 ? "" : "s"}
              </p>
            }
          >
            {/* overflow-hidden contains the list's natural height (vendored Root
                is `relative`-only) so a long file list can't leak a window scrollbar. */}
            <ScrollArea className="min-h-0 flex-1 overflow-hidden">
              <FileRowActions
                repoPath={repoPath}
                blameRev={commit.oid}
                onKeyDown={onFilesKeyDown}
              >
                {files.map((file) => (
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
          <main className="flex min-w-0 flex-1 flex-col">
            <div className="min-h-0 flex-1">
              {effectivePath && fileDiff ? (
                <DiffContent
                  filePath={effectivePath}
                  data={fileDiff}
                  isPending={false}
                  isError={false}
                  lineAnchors={lineAnchors}
                  lineWidget={lineWidget}
                />
              ) : (
                <DiffPlaceholder message="No file changes in this commit" />
              )}
            </div>
            <CommitComments
              repoPath={repoPath}
              sha={commit.oid}
              canComment={canCommentCommits}
              remoteLabel={remoteLabel}
              diffSections={sections}
              // While placeholder, `sections` belongs to the previously selected
              // commit, so a position-derived line would resolve against the wrong
              // patch. (This mounts only once the diff settled, so load/error
              // windows never reach it.)
              diffReady={diff.isSuccess && !diff.isPlaceholderData}
              selectedPath={effectivePath}
              onSelectFile={setSelectedPath}
              lens={lens}
            />
          </main>
        </DetailRailRow>
      )}
    </div>
  );
}
