import { useEffectEvent, useMemo, useState } from "react";
import { toast } from "sonner";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { MarkdownEditor } from "@/components/markdown-editor";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/ui/markdown";
import { CommentComposer } from "@/features/conversations/CommentComposer";
import { DeleteCommentDialog } from "@/features/conversations/DeleteCommentDialog";
import { Thread } from "@/features/conversations/Thread";
import type { DiffLineAnchor } from "@/features/diff/DiffSurface";
import type { splitUnifiedDiff } from "@/lib/git/diff-split";
import {
  useCommitComments,
  useCreateCommitComment,
  useDeleteCommitComment,
  useEditCommitComment,
} from "@/lib/git/queries";
import type {
  CommitCommentOut,
  ForgeProvider,
  PrThreadOut,
  RemoteLens,
} from "@/lib/git/types";
import { SUBMIT_HINT } from "@/lib/hotkeys/binding";
import { toastError } from "@/lib/toast";

export type DiffSections = ReturnType<typeof splitUnifiedDiff>;

/**
 * Derive the new-side (right) line a GitHub commit comment anchors to from its
 * diff `position`. GitHub sends `position` (1-based index of the line within the
 * file's patch, counting EVERY line after the first `@@` header — subsequent hunk
 * headers included) but often leaves `line` null, so the position must be walked
 * against the file's own diff section. Returns null when the section is absent, the
 * position is out of range, or the target isn't on the new side.
 *
 * `\ No newline at end of file` markers COUNT toward `position` but are not
 * content: they never advance the new-side counter and are never a valid anchor
 * (advancing on them would shift every line after the transition by one).
 */
export function lineFromPosition(
  section: string | undefined,
  position: number | null,
): number | null {
  if (!section || position == null || position < 1) return null;
  const lines = section.split("\n");
  // Walk from the first hunk header; count every line after it (position 1 is
  // the first line following that header).
  let firstHunk = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("@@")) {
      firstHunk = i;
      break;
    }
  }
  if (firstHunk === -1) return null;

  let pos = 0;
  let newLine = 0;
  for (let i = firstHunk; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("@@")) {
      // Re-seat the new-side counter from this hunk's header (`@@ -a,b +c,d @@`).
      const m = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) newLine = Number(m[1]) - 1;
      if (i !== firstHunk) pos += 1; // subsequent headers count toward position
      if (pos === position) return null; // a header line has no new-side line
      continue;
    }
    pos += 1;
    if (l.startsWith("\\")) {
      // `\ No newline…`: counts toward position, but is not content — never an anchor.
      if (pos === position) return null;
      continue;
    }
    if (l.startsWith("-")) {
      // Removed line: no new-side number; if the position lands here, unresolved.
      if (pos === position) return null;
      continue;
    }
    // Context (" ") or added ("+") line advances the new-side counter.
    newLine += 1;
    if (pos === position) return newLine;
  }
  return null;
}

/**
 * The inverse of {@link lineFromPosition}: given a new-side line number, return the
 * GitHub commit-comment `position` that anchors to it, walking the file's diff
 * section with the same counting rules forward. Returns null when the section is
 * absent, has no hunk header, or the line never appears on the new side (it wasn't
 * in this commit's diff for that file) — the caller then disables the post with a
 * visible reason. `\` lines count toward `position` but never anchor a comment.
 */
export function positionFromLine(
  section: string | undefined,
  line: number | null,
): number | null {
  if (!section || line == null || line < 1) return null;
  const lines = section.split("\n");
  // Find the first hunk header; position 1 is the first line following it.
  let firstHunk = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("@@")) {
      firstHunk = i;
      break;
    }
  }
  if (firstHunk === -1) return null;

  let pos = 0;
  let newLine = 0;
  for (let i = firstHunk; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("@@")) {
      // Re-seat the new-side counter from this hunk's header (`@@ -a,b +c,d @@`).
      const m = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) newLine = Number(m[1]) - 1;
      if (i !== firstHunk) pos += 1; // subsequent headers count toward position
      continue;
    }
    pos += 1;
    // `\ No newline…`: counts toward position, never advances the new-side counter.
    if (l.startsWith("\\")) continue;
    // Removed line: no new-side number, so it can never match the target line.
    if (l.startsWith("-")) continue;
    // Context (" ") or added ("+") line advances the new-side counter.
    newLine += 1;
    if (newLine === line) return pos;
  }
  return null;
}

/**
 * The inline diff anchors for a commit's line-anchored comments on ONE file:
 * every comment on `path` that resolves to a new-side line, grouped by that line
 * into a single stacked {@link DiffLineAnchor} (DiffSurface keeps one entry per
 * line/side, so same-line comments MUST be pre-grouped). A comment's line is its
 * own `line` when present, else recovered from `position` via
 * {@link lineFromPosition}; unresolvable comments are dropped here and surface in
 * {@link CommitComments}' labelled group instead. A ranged comment gets a small
 * mono range chip.
 */
export function useCommitLineAnchors(
  comments: CommitCommentOut[] | undefined,
  sections: DiffSections | undefined,
  path: string | null,
): DiffLineAnchor[] {
  return useMemo<DiffLineAnchor[]>(() => {
    if (!path) return [];
    const byLine = new Map<number, CommitCommentOut[]>();
    for (const c of comments ?? []) {
      if (c.path !== path) continue;
      const line = c.line ?? lineFromPosition(sections?.get(path), c.position);
      if (line == null) continue;
      const bucket = byLine.get(line);
      if (bucket) bucket.push(c);
      else byLine.set(line, [c]);
    }
    return [...byLine.entries()].map(([line, group]) => ({
      side: "new" as const,
      line,
      render: () => (
        <div className="space-y-2">
          {group.map((c) => (
            <div key={c.id} className="space-y-1">
              <div className="flex items-center gap-1.5">
                {c.startLine != null && c.startLine !== line && (
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    Lines {c.startLine}–{line}
                  </span>
                )}
                <p className="text-[11px] font-medium">{c.author}</p>
              </div>
              <Markdown>{c.body}</Markdown>
            </div>
          ))}
        </div>
      ),
    }));
  }, [comments, sections, path]);
}

/** Map a flat commit comment onto the {@link Thread} prop shape — commit
 *  comments carry no review state / minimize / permalink, so those go empty. */
function toThread(c: CommitCommentOut): PrThreadOut {
  return {
    author: c.author,
    // The commit-comment payload carries no avatar URL on any provider, so pass "" —
    // ForgeUserAvatar derives one from the login on GitHub and falls back to initials
    // elsewhere.
    authorAvatarUrl: "",
    state: "",
    body: c.body,
    date: c.createdAt,
    id: c.id,
    url: "",
    viewerDidAuthor: c.viewerDidAuthor,
    isMinimized: false,
    minimizedReason: "",
    // Commit comments belong to no review.
    reviewId: "",
  };
}

/**
 * The comment surface for a single commit: whole-commit comments as a flat thread
 * list, line-anchored comments grouped by `path:line`, and a whole-commit composer.
 * The diff pane renders anchored comments inline via `lineAnchors`, but ONLY for
 * the selected file — so the labelled group here lists every anchored comment that
 * isn't visible inline (another file, or unresolvable to a new-side line), so none
 * is ever silently dropped.
 */
export function CommitComments({
  repoPath,
  sha,
  canComment,
  remoteLabel,
  diffSections,
  selectedPath,
  onSelectFile,
  lens,
}: {
  repoPath: string;
  sha: string;
  canComment: boolean;
  remoteLabel: string;
  /** Per-file diff sections, so line-anchored comments can resolve their line. */
  diffSections?: DiffSections;
  /** The file currently open in the diff pane — its resolvable anchored comments
   *  render inline there, so they're excluded from the labelled group below. */
  selectedPath?: string | null;
  /** Selects a file in the sidebar; makes each group's path label a button that
   *  jumps to that file's diff. Absent = the label is plain text. */
  onSelectFile?: (path: string) => void;
  /** Which repo the commit's comments live on: "origin" (the History surface, or
   *  a non-fork) or the parent under the upstream lens (PR-commit context). */
  lens: RemoteLens;
}) {
  const comments = useCommitComments(repoPath, sha, lens);
  const createComment = useCreateCommitComment(repoPath, lens);
  const editComment = useEditCommitComment(repoPath, lens);
  const deleteComment = useDeleteCommitComment(repoPath, lens);

  const [body, setBody] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // Neither call site keys this component on the commit, so a different commit
  // must never inherit the previous one's draft or pending delete confirm — a
  // render-time state adjustment, not an effect. Identity is the same triple the
  // comments are read and written under.
  const commitIdentity = `${repoPath}#${lens}#${sha}`;
  const [lastIdentity, setLastIdentity] = useState(commitIdentity);
  if (commitIdentity !== lastIdentity) {
    setLastIdentity(commitIdentity);
    setBody("");
    setDeletingId(null);
  }
  // The restore below can land after the user moved to another commit; an effect
  // event reads the LIVE identity so a late rejection can't resurrect text there.
  const restoreDraft = useEffectEvent((submittedFor: string, text: string) => {
    if (submittedFor !== commitIdentity) return;
    setBody((cur) => (cur.trim() ? cur : text));
  });

  const list = comments.data ?? [];
  const whole = list.filter((c) => c.path == null);
  const anchored = list.filter((c) => c.path != null);

  // Anchored comments NOT visible inline: one renders inline only when it's on the
  // selected file AND resolves to a new-side line. Everything else surfaces below
  // under its `path:line` label, with the resolved line when we have one.
  const hiddenAnchored = useMemo(() => {
    return anchored
      .map((c) => {
        const path = c.path as string;
        const line =
          c.line ?? lineFromPosition(diffSections?.get(path), c.position);
        return { comment: c, path, line, startLine: c.startLine };
      })
      .filter(({ path, line }) => !(path === selectedPath && line != null));
  }, [anchored, diffSections, selectedPath]);

  const busy =
    createComment.isPending || editComment.isPending || deleteComment.isPending;

  function submit() {
    const text = body.trim();
    if (!text) return;
    // Clear the draft immediately (perceived-speed win); the hook appends the
    // synthetic comment optimistically. On error restore the draft, but only if
    // the composer is still empty so newly-typed text is never clobbered.
    const submittedFor = commitIdentity;
    setBody("");
    createComment.mutate(
      { sha, body: text },
      {
        onSuccess: () => toast.success("Comment added"),
        onError: (e) => {
          restoreDraft(submittedFor, text);
          toastError(e);
        },
      },
    );
  }

  function saveEdit(commentId: string, next: string) {
    editComment.mutate(
      { sha, commentId, body: next },
      {
        onSuccess: () => toast.success("Comment updated"),
        onError: (e) => toastError(e),
      },
    );
  }

  return (
    <div className="flex min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        {comments.isError ? (
          <p className="text-xs text-destructive">
            Couldn't load comments for this commit.
          </p>
        ) : (
          <>
            {whole.map((c) => (
              <Thread
                key={c.id}
                thread={toThread(c)}
                onSaveEdit={
                  c.viewerDidAuthor ? (next) => saveEdit(c.id, next) : undefined
                }
                onDelete={
                  c.viewerDidAuthor ? () => setDeletingId(c.id) : undefined
                }
              />
            ))}

            {hiddenAnchored.length > 0 && (
              <div className="space-y-3">
                {hiddenAnchored.map(({ comment: c, path, line, startLine }) => {
                  // A valid range labels `path:start–end`; a single line (or an
                  // unresolved line) keeps `path:line` / `path`.
                  const lineLabel =
                    line == null
                      ? ""
                      : startLine != null && startLine !== line
                        ? `:${startLine}–${line}`
                        : `:${line}`;
                  const label = `${path}${lineLabel}`;
                  return (
                    <div key={c.id} className="space-y-1">
                      {onSelectFile ? (
                        <button
                          type="button"
                          onClick={() => onSelectFile(path)}
                          className="block max-w-full cursor-pointer truncate text-left font-mono text-[11px] text-muted-foreground hover:text-foreground hover:underline"
                          title={`Open ${label} in the diff`}
                        >
                          {label}
                        </button>
                      ) : (
                        <p className="truncate font-mono text-[11px] text-muted-foreground">
                          {label}
                        </p>
                      )}
                      <Thread
                        thread={toThread(c)}
                        onSaveEdit={
                          c.viewerDidAuthor
                            ? (next) => saveEdit(c.id, next)
                            : undefined
                        }
                        onDelete={
                          c.viewerDidAuthor
                            ? () => setDeletingId(c.id)
                            : undefined
                        }
                      />
                    </div>
                  );
                })}
              </div>
            )}

            {!comments.isPending && list.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No comments on this commit yet.
              </p>
            )}
          </>
        )}
      </div>

      {canComment && (
        <CommentComposer
          ariaLabel="Comment on this commit"
          placeholder="Leave a comment…"
          value={body}
          onChange={setBody}
          onSubmit={submit}
          submitLabel="Comment"
          busy={busy}
        />
      )}

      <DeleteCommentDialog
        commentId={deletingId}
        onClose={() => setDeletingId(null)}
        pending={deleteComment.isPending}
        description={`This permanently deletes the comment on ${remoteLabel}. This cannot be undone.`}
        onConfirm={(commentId) =>
          deleteComment.mutate(
            { sha, commentId },
            {
              onSuccess: () => {
                toast.success("Comment deleted");
                setDeletingId(null);
              },
              onError: (e) => {
                toastError(e);
                setDeletingId(null);
              },
            },
          )
        }
      />
    </div>
  );
}

/** What a dragged range collapses to, per provider. Only GitLab commit discussions
 *  carry a real range; GitHub/Bitbucket commit comments are single-line APIs
 *  anchored at the END line, so they disclose the collapse rather than let it pass
 *  silently. */
const RANGE_HINT: Record<ForgeProvider, (line: number) => string | null> = {
  github: (line) =>
    `GitHub commit comments anchor to a single line — this posts on line ${line}.`,
  bitbucket: (line) =>
    `Bitbucket commit comments anchor to a single line — this posts on line ${line}.`,
  gitlab: () => null,
};

/**
 * The inline composer in a commit-diff line-widget slot: a compact MarkdownEditor +
 * Comment that creates a line-anchored commit comment. Commit comments anchor to
 * the NEW side only, so an old-side line is disabled with a visible reason. On
 * GitHub the `position` is recovered from the file's diff section via
 * {@link positionFromLine}; a line not in this commit's diff yields null and the
 * post is disabled with a reason. GitLab commit notes anchor by `line` alone.
 * Posting is optimistic, so the slot closes immediately.
 */
export function CommitLineComposer({
  repoPath,
  sha,
  path,
  side,
  line,
  fromLine,
  provider,
  fileSection,
  onClose,
  lens,
}: {
  repoPath: string;
  sha: string;
  path: string;
  side: "new" | "old";
  /** The anchored (end) line of the comment. */
  line: number;
  /** Range start when a range was drag-selected; absent for a single line. */
  fromLine?: number;
  provider: "github" | "gitlab" | "bitbucket";
  /** This file's unified-diff section, for recovering the GitHub `position`. */
  fileSection: string | undefined;
  onClose: () => void;
  /** Which repo the commit lives on (origin vs upstream lens). */
  lens: RemoteLens;
}) {
  const createComment = useCreateCommitComment(repoPath, lens);
  const [body, setBody] = useState("");

  // The multi-line range, normalized: [from, line] with from <= line.
  const rangeFrom = fromLine !== undefined && fromLine < line ? fromLine : line;
  const isRange = rangeFrom !== line;

  // GitHub needs the diff `position`; null means the line isn't on the new side of
  // this commit's diff for the file → disable with a reason. The position is always
  // the END line (GitHub/Bitbucket commit comments are single-line APIs).
  const position =
    provider === "github" ? positionFromLine(fileSection, line) : null;
  const disabledReason =
    side === "old"
      ? "Commit comments anchor to the new side — pick a line on the right."
      : provider === "github" && position === null
        ? "This line isn't in the commit's diff for this file."
        : null;
  const canPost = disabledReason === null;

  const rangeHint = isRange ? RANGE_HINT[provider](line) : null;

  function submit() {
    const text = body.trim();
    if (!text || !canPost) return;
    // Optimistic: the hook appends the synthetic comment, so close right away.
    createComment.mutate(
      {
        sha,
        body: text,
        path,
        line,
        // GitLab commit discussions support ranges; send startLine only for a
        // real GitLab range. GitHub/Bitbucket stay end-anchored (single-line).
        ...(provider === "gitlab" && isRange ? { startLine: rangeFrom } : {}),
        ...(position !== null ? { position } : {}),
      },
      {
        onSuccess: () => toast.success("Comment added"),
        onError: (e) => toastError(e),
      },
    );
    onClose();
  }

  const anchorLabel = isRange
    ? `Lines ${rangeFrom}–${line} · ${path}`
    : `Line ${line} · ${path}`;

  return (
    <div className="space-y-2">
      <span className="block min-w-0 truncate font-mono text-[11px] text-muted-foreground">
        {anchorLabel}
      </span>
      {rangeHint && (
        <p className="text-[11px] text-muted-foreground">{rangeHint}</p>
      )}
      <MarkdownEditor
        aria-label={`Comment on ${anchorLabel}`}
        placeholder="Leave a comment…"
        value={body}
        onChange={setBody}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
            // preventDefault unconditionally: `commit` is bound to mod+enter and
            // fires inside editable targets, so a chord this handler declines to
            // submit would otherwise reach the global action.
            e.preventDefault();
            if (canPost && !createComment.isPending) submit();
          } else if (e.key === "Escape") {
            // Close only this widget — don't leak Escape to global handlers.
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
        autoFocus
        rows={3}
        textareaClassName="max-h-48 min-h-16 resize-y"
      />
      <div className="flex items-center gap-2">
        <DisabledReasonButton
          variant="outline"
          size="sm"
          disabled={!body.trim() || !canPost || createComment.isPending}
          reason={
            disabledReason ?? (!body.trim() ? "Write a comment first" : null)
          }
          title={SUBMIT_HINT}
          onClick={submit}
        >
          Comment
        </DisabledReasonButton>
        <Button
          variant="ghost"
          size="sm"
          disabled={createComment.isPending}
          onClick={onClose}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
