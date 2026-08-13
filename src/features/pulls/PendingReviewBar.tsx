import { useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/ui/markdown";
import { CommentEditor } from "@/features/conversations/CommentEditor";
import type { RemoteLens } from "@/lib/git/types";
import {
  type ReviewDraft,
  useClearReviewDrafts,
  useRemoveReviewDraft,
  useReviewDrafts,
  useUpdateReviewDraft,
} from "@/lib/pulls/review-drafts";
import { toastError } from "@/lib/toast";

/** The anchor label for a draft: "Lines a–b" for a range, "Line b" otherwise. */
function draftLabel(draft: ReviewDraft): string {
  if (draft.startLine && draft.startLine !== draft.line) {
    return `Lines ${draft.startLine}–${draft.line}`;
  }
  return `Line ${draft.line}`;
}

/**
 * One pending draft comment, rendered under its anchored diff line (the Files
 * tab) or in a list: a `Pending` badge (semantic token + text, never color
 * alone), a markdown body preview, and always-visible Edit (inline editor swap)
 * and Delete (confirm) controls — no hover-reveal. Wired to the draft store's
 * update/remove hooks. Exported for PrFilesPane's draft anchors.
 */
export function DraftCommentCard({
  repoPath,
  lens,
  number,
  draft,
}: {
  repoPath: string;
  /** The origin|upstream lens the parent PR view resolved (scopes the drafts). */
  lens: RemoteLens;
  number: number;
  draft: ReviewDraft;
}) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(draft.body);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const updateDraft = useUpdateReviewDraft(repoPath, lens, number);
  const removeDraft = useRemoveReviewDraft(repoPath, lens, number);

  const next = body.trim();
  const canSave = next.length > 0 && next !== draft.body.trim();

  function saveEdit() {
    if (!canSave) return;
    updateDraft.mutate(
      { id: draft.id, body: next },
      {
        onError: (e) => toastError(e),
        onSuccess: () => setEditing(false),
      },
    );
  }

  return (
    <div className="space-y-1.5 rounded border bg-background px-3 py-2 text-xs">
      <div className="flex items-center gap-2">
        <Badge variant="secondary" className="shrink-0 text-warning">
          Pending
        </Badge>
        <span className="truncate font-mono text-muted-foreground">
          {draftLabel(draft)}
        </span>
        {!editing && (
          <>
            <span className="flex-1" />
            <Button
              variant="ghost"
              size="xs"
              className="text-muted-foreground"
              onClick={() => {
                setBody(draft.body);
                setEditing(true);
              }}
            >
              Edit
            </Button>
            <Button
              variant="ghost"
              size="xs"
              className="text-destructive"
              onClick={() => setConfirmDelete(true)}
            >
              Delete
            </Button>
          </>
        )}
      </div>
      {editing ? (
        <CommentEditor
          value={body}
          onChange={setBody}
          onSubmit={saveEdit}
          onCancel={() => setEditing(false)}
          canSubmit={canSave}
          pending={updateDraft.isPending}
          ariaLabel="Edit pending comment"
          textareaClassName="max-h-48 min-h-16 resize-y"
        />
      ) : (
        <Markdown>{draft.body}</Markdown>
      )}
      <ConfirmDialog
        open={confirmDelete}
        onCancel={() => setConfirmDelete(false)}
        title="Delete pending comment?"
        body="This removes the draft comment from your pending review. It hasn't been posted yet."
        confirmLabel="Delete"
        confirmVariant="destructive"
        pending={removeDraft.isPending}
        onConfirm={() =>
          removeDraft.mutate(draft.id, {
            onError: (e) => toastError(e),
            onSuccess: () => setConfirmDelete(false),
          })
        }
      />
    </div>
  );
}

/**
 * The pending-review status bar: hidden until at least one draft comment exists,
 * then a compact "Review in progress · N pending comment(s)" line with a primary
 * "Submit review…" (opens the parent's submit dialog via `onSubmit`) and a
 * destructive-styled "Discard" (confirmed before clearing). Reads its own draft
 * count; self-contained and non-sticky (P5 places it at a stable slot). No layout
 * shift on appearance — it simply renders nothing at zero drafts.
 */
export function PendingReviewBar({
  repoPath,
  lens,
  number,
  onSubmit,
}: {
  repoPath: string;
  /** The origin|upstream lens the parent PR view resolved (scopes the drafts). */
  lens: RemoteLens;
  number: number;
  onSubmit: () => void;
}) {
  const drafts = useReviewDrafts(repoPath, lens, number);
  const clearDrafts = useClearReviewDrafts(repoPath, lens, number);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const count = drafts.data?.length ?? 0;

  if (count === 0) return null;

  return (
    <div className="flex items-center gap-3 border-y bg-muted/40 px-3 py-1.5 text-xs">
      <span className="min-w-0 flex-1 text-muted-foreground">
        <span className="font-medium text-foreground">Review in progress</span>{" "}
        · {count} pending comment{count === 1 ? "" : "s"}
      </span>
      <Button size="xs" onClick={onSubmit}>
        Submit review…
      </Button>
      <Button
        size="xs"
        variant="ghost"
        className="text-destructive"
        onClick={() => setConfirmDiscard(true)}
      >
        Discard
      </Button>
      <ConfirmDialog
        open={confirmDiscard}
        onCancel={() => setConfirmDiscard(false)}
        title="Discard pending review?"
        body={`This deletes all ${count} pending comment${count === 1 ? "" : "s"}. They haven't been posted yet and can't be recovered.`}
        confirmLabel="Discard review"
        confirmVariant="destructive"
        pending={clearDrafts.isPending}
        onConfirm={() =>
          clearDrafts.mutate(undefined, {
            onError: (e) => toastError(e),
            onSuccess: () => setConfirmDiscard(false),
          })
        }
      />
    </div>
  );
}
