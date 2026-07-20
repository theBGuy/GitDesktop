// The History tab: the commit log, a commit detail (message + changed files), and
// a per-file commit diff. F0 froze the export names + props; this package (F23)
// fills the bodies.

import {
  ArrowLeftIcon,
  CaretRightIcon,
  GitMergeIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { DiffText, splitCommitDiff } from "../components/DiffText";
import {
  EmptyState,
  ErrorState,
  isRepoGoneError,
  RepoGoneState,
  SkeletonRows,
  StaleBanner,
} from "../components/states";
import type { CommitSummary, DiffStatEntry } from "../lib/api";
import { timeAgo } from "../lib/format";
import { useCommit, useCommitDiff, useLog } from "../lib/queries";
import { encodeFileSegment, navigate, repoHash } from "../lib/router";
import { useRovingList } from "../lib/use-roving-list";
import { DetailBackBar } from "./Changes";

// The log is paged with a single GROWING query keyed [log, repoId, 0, limit]: the
// server re-serves the whole prefix each time, so "Load more" just bumps `limit`
// (cheap + cache-friendly) rather than stitching a multi-query pages array.
const PAGE = 50;

/** The commit history list. `active` gates polling. */
export function HistoryBody({
  repoId,
  active,
}: {
  repoId: string;
  active: boolean;
}) {
  const [limit, setLimit] = useState(PAGE);
  const { data, isError, error, refetch } = useLog(repoId, active, 0, limit);
  const { register, onKeyDown } = useRovingList();

  // Definitive gone WINS over stale data (mirrors StatusBody/PrsBody).
  if (isRepoGoneError(error)) return <RepoGoneState />;

  if (!data) {
    if (isError) return <ErrorState error={error} onRetry={() => refetch()} />;
    return <SkeletonRows />;
  }

  // The last page came back short (fewer commits than we asked for) → we've reached
  // the root, so there's nothing more to load. Hide the button then.
  const hasMore = data.length >= limit;

  return (
    <div className="flex flex-col">
      {isError ? <StaleBanner error={error} onRetry={() => refetch()} /> : null}
      {data.length === 0 ? (
        <EmptyState
          title="No commits yet."
          hint="This repository's history will show up here."
        />
      ) : (
        <>
          <ul className="flex flex-col divide-y divide-border">
            {data.map((commit, i) => (
              <li key={commit.hash}>
                <button
                  type="button"
                  ref={register(i)}
                  onKeyDown={onKeyDown}
                  onClick={() =>
                    navigate(repoHash(repoId, `history/${commit.hash}`))
                  }
                  className="flex w-full min-h-14 items-center gap-3 px-4 py-3 text-left"
                >
                  <CommitRow commit={commit} />
                  <CaretRightIcon
                    size={16}
                    className="shrink-0 text-muted-foreground"
                  />
                </button>
              </li>
            ))}
          </ul>
          {hasMore ? (
            <button
              type="button"
              onClick={() => setLimit((n) => n + PAGE)}
              className="min-h-11 border-t border-border px-4 py-3 text-sm font-medium text-primary"
            >
              Load more
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

/** One commit-log row: subject, author + relative date, short hash, tag chips, and
 *  a merge marker. */
function CommitRow({ commit }: { commit: CommitSummary }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2">
        {commit.isMerge ? (
          <GitMergeIcon
            size={14}
            className="shrink-0 text-merged"
            aria-label="Merge commit"
          />
        ) : null}
        <p className="truncate text-sm font-medium text-foreground">
          {commit.subject}
        </p>
      </div>
      <p className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
        <span className="truncate">{commit.author}</span>
        <span className="shrink-0">·</span>
        <span className="shrink-0">{timeAgo(commit.date)}</span>
        <span className="shrink-0 font-mono">{shortHash(commit.hash)}</span>
      </p>
      {commit.tags.length > 0 ? (
        <div className="mt-1 flex flex-wrap gap-1">
          {commit.tags.slice(0, 2).map((tag) => (
            <span
              key={tag}
              className="max-w-[12rem] truncate rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
            >
              {tag}
            </span>
          ))}
          {commit.tags.length > 2 ? (
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              +{commit.tags.length - 2}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** One commit's detail: the message (subject + body) and its changed-file stats. */
export function CommitBody({ repoId, sha }: { repoId: string; sha: string }) {
  const commit = useCommit(repoId, sha);
  const diff = useCommitDiff(repoId, sha);

  // Definitive gone WINS on either query (mirrors PrDetail).
  if (isRepoGoneError(commit.error) || isRepoGoneError(diff.error)) {
    return <RepoGoneState />;
  }

  return (
    <div className="flex flex-col">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-background/95 px-2 py-2 backdrop-blur">
        <button
          type="button"
          onClick={() => navigate(repoHash(repoId, "history"))}
          className="inline-flex min-h-11 items-center gap-1 rounded px-2 text-sm font-medium text-primary"
        >
          <ArrowLeftIcon size={16} />
          History
        </button>
      </div>

      {commit.isError ? (
        <ErrorState error={commit.error} onRetry={() => commit.refetch()} />
      ) : commit.isPending || !commit.data ? (
        <SkeletonRows count={3} />
      ) : (
        <article className="flex flex-col gap-4 px-4 py-5">
          <header className="flex flex-col gap-2">
            <h1 className="text-base font-semibold text-foreground">
              {commit.data.subject}
            </h1>
            <p className="text-xs text-muted-foreground">
              <span className="font-mono">{shortHash(commit.data.hash)}</span> ·{" "}
              {commit.data.author}
            </p>
            <p className="text-xs text-muted-foreground">
              {timeAgo(commit.data.date)}
              {absoluteDate(commit.data.date)
                ? ` · ${absoluteDate(commit.data.date)}`
                : ""}
            </p>
          </header>

          {/* Commit messages are NOT markdown — render the body as plain,
              line-break-preserving text (never a Markdown parser). Omitted when the
              body is empty. */}
          {commit.data.body.trim() ? (
            <p className="whitespace-pre-wrap text-sm text-foreground/90">
              {commit.data.body}
            </p>
          ) : null}

          <CommitFiles repoId={repoId} sha={sha} diff={diff} />
        </article>
      )}
    </div>
  );
}

/** The changed-file list for a commit, plus the truncation notice. Reads the SAME
 *  `useCommitDiff` query the parent already has in flight (passed in), so there's no
 *  second fetch. Its own pending/error state is inline — a diff failure must not
 *  blank the commit message above it. */
function CommitFiles({
  repoId,
  sha,
  diff,
}: {
  repoId: string;
  sha: string;
  diff: ReturnType<typeof useCommitDiff>;
}) {
  if (diff.isError) {
    return <ErrorState error={diff.error} onRetry={() => diff.refetch()} />;
  }
  if (diff.isPending || !diff.data) return <SkeletonRows count={2} />;

  const { files, truncated, excludedFiles } = diff.data;
  return (
    <section className="flex flex-col gap-2">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">
        {files.length} file{files.length === 1 ? "" : "s"} changed
      </p>
      {files.length === 0 ? (
        <p className="text-sm text-muted-foreground">No file changes.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
          {files.map((file) => (
            <li key={file.path}>
              <button
                type="button"
                onClick={() =>
                  navigate(
                    repoHash(
                      repoId,
                      `history/${sha}/${encodeFileSegment(file.path)}`,
                    ),
                  )
                }
                className="flex w-full min-h-12 items-center gap-3 px-3 py-2.5 text-left"
              >
                <CommitFileStat file={file} />
                <CaretRightIcon
                  size={16}
                  className="shrink-0 text-muted-foreground"
                />
              </button>
            </li>
          ))}
        </ul>
      )}
      {truncated || excludedFiles > 0 ? (
        <p className="text-xs text-muted-foreground">
          {truncated
            ? "Diff truncated — view the full diff on the desktop."
            : `${excludedFiles} file${
                excludedFiles === 1 ? "" : "s"
              } hidden by ignore patterns.`}
        </p>
      ) : null}
    </section>
  );
}

/** One commit-file stat row: the path (tail kept visible) with its `+n −n` or a
 *  binary chip. */
function CommitFileStat({ file }: { file: DiffStatEntry }) {
  return (
    <div className="min-w-0 flex-1">
      <p
        className="truncate font-mono text-xs text-foreground"
        title={file.path}
      >
        {file.path}
      </p>
      <p className="mt-0.5 text-xs">
        {file.isBinary ? (
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-muted-foreground">
            binary
          </span>
        ) : (
          <span className="tabular-nums">
            <span className="text-success">+{file.added}</span>{" "}
            <span className="text-destructive">−{file.deleted}</span>
          </span>
        )}
      </p>
    </div>
  );
}

/** One file's diff within a commit. Slices the commit's multi-file diff by path via
 *  `splitCommitDiff` and renders the file's chunk in DiffText.
 *
 *  A file can have NO chunk for three distinct reasons, disambiguated below in
 *  priority order:
 *   1. The commit diff was TRUNCATED at the server's 1MB cap. Crucially the
 *      `files[]` stat list is computed from a SEPARATE, uncapped numstat — so a file
 *      whose diff block fell beyond the cut still has a (non-binary) stat entry but no
 *      chunk. It is NOT "no content changes"; show the truncation notice.
 *   2. The file is BINARY (git emits no textual hunk) — the binary note.
 *   3. Genuinely no textual hunk on a non-binary, non-truncated file — a rare
 *      metadata-only change such as a mode (permission) change. (A pure RENAME is NOT
 *      this case: git emits a `diff --git` + `rename from/to` chunk for it, which
 *      renders as meta lines through DiffText.) The "No content changes." note. */
export function CommitFileBody({
  repoId,
  sha,
  filePath,
}: {
  repoId: string;
  sha: string;
  filePath: string;
}) {
  const { data, isPending, isError, error, refetch } = useCommitDiff(
    repoId,
    sha,
  );

  // Definitive gone WINS (mirrors PrDetail).
  if (isRepoGoneError(error)) return <RepoGoneState />;

  // The matching file-stat entry (its `isBinary` flag), and the file's own diff
  // chunk sliced out of the commit's multi-file text.
  const fileStat = data?.files.find((f) => f.path === filePath);
  const chunk = data ? splitCommitDiff(data.text).get(filePath) : undefined;

  return (
    <div className="flex flex-col">
      <DetailBackBar
        label="Commit"
        onBack={() => navigate(repoHash(repoId, `history/${sha}`))}
        path={filePath}
      />
      {isError ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : isPending || !data ? (
        <SkeletonRows count={4} />
      ) : chunk !== undefined ? (
        // The normal path: this file has a diff chunk. Honor the stat entry's binary
        // flag (a binary file with a chunk still renders as the binary note).
        <DiffText
          text={chunk}
          truncated={data.truncated}
          isBinary={fileStat?.isBinary ?? false}
        />
      ) : data.truncated ? (
        // No chunk because the diff was cut at the cap and this file's block fell
        // beyond it — the stat entry (from the uncapped numstat) survived but the text
        // didn't. Point at the desktop, NOT the misleading "no content changes".
        <p className="flex items-center gap-2 border-b border-border bg-warning/15 px-4 py-2 text-xs text-foreground">
          <WarningCircleIcon size={14} className="shrink-0 text-warning" />
          Diff truncated — view the full diff on the desktop.
        </p>
      ) : fileStat?.isBinary ? (
        // A binary file with no textual hunk.
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">
          Binary file — no text diff.
        </p>
      ) : (
        // A non-binary, non-truncated file with no hunk — a rare metadata-only change
        // (e.g. a file-mode change). NOT a rename (which emits a chunk).
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">
          No content changes.
        </p>
      )}
    </div>
  );
}

/** Shorten a commit hash to its 7-char short form. */
function shortHash(hash: string): string {
  return hash.slice(0, 7);
}

/** An absolute, locale-formatted date for a commit ("Jul 20, 2026, 3:14 PM"), or
 *  "" for an empty/invalid ISO string (so the caller can omit it). */
function absoluteDate(iso: string): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return new Date(t).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
