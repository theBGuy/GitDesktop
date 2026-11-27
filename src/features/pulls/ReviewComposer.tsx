import { type KeyboardEvent, useState } from "react";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { hostedImagesFor } from "@/components/markdown/markdown-images";
import { MarkdownEditor } from "@/components/markdown-editor";
import { Button } from "@/components/ui/button";
import { useMentionCandidates } from "@/features/conversations/useMentionCandidates";
import {
  LINE_COMPOSER_KEEP_ID,
  useDiffRowsHeld,
  useKeptDraft,
} from "@/features/diff/editor-keep";
import { DIFF_ROWS_HELD_REASON } from "@/features/diff/whitespace-mode";
import { patchLines } from "@/lib/git/diff-split";
import { useCreateReviewThread } from "@/lib/git/queries";
import type { RemoteLens } from "@/lib/git/types";
import { eventToBinding, SUBMIT_HINT } from "@/lib/hotkeys/binding";
import { PR_NOUN } from "@/lib/pulls/pr-state";
import { useAddReviewDraft } from "@/lib/pulls/review-drafts";
import { toastError } from "@/lib/toast";
import {
  HEAD_COLD_REVIEW_REASON,
  HEAD_PENDING_REVIEW_REASON,
  HEAD_UNPROVEN_REVIEW_REASON,
  type HeadPendingKind,
} from "./head-pending";
import { buildSuggestionFence, extractNewSideLines } from "./suggestion-utils";

/** Why a composer on lines outside the pull request's patch can't post. */
export const OFF_PATCH_REVIEW_REASON: Record<"line" | "range", string> = {
  line: "This line isn't in the pull request's diff for this file.",
  range:
    "Some lines in this range aren't in the pull request's diff for this file.",
};

export interface ReviewComposerProps {
  repoPath: string;
  number: number;
  path: string;
  side: "new" | "old";
  /** The anchored (end) line of the comment. */
  line: number;
  /** Range start when a range was drag-selected; absent for a single line. */
  fromLine?: number;
  provider: "github" | "gitlab" | "bitbucket";
  /** This file's unified-diff section, for prefilling a suggestion's code. */
  fileSection: string;
  /** Current pending-review size — drives the Add-to-review button label. */
  draftCount: number;
  canCreateThread: boolean;
  /** The origin|upstream lens the parent PR view resolved (scopes the thread). */
  lens: RemoteLens;
  onClose: () => void;
  /** Set while the painted diff is an older head's, or a moved answer is under
   *  check (loading, failed or offline): both submit paths hold with its
   *  reason. */
  headPending?: HeadPendingKind | null;
  /** Set while this target has no own diff answer yet (a cold read, or one
   *  that failed or parked): both submit paths hold on the cold reasons,
   *  which claim no update. */
  headCold?: HeadPendingKind | null;
  /** Set while the painted diff is this head's own text and no head read has
   *  proven it, or the details name no full head commit to prove it against:
   *  both submit paths hold, below `headPending`'s reason. */
  headUnproven?: boolean;
  /** The diff's rows on screen are not yet the live text's (`LineWidget`'s
   *  `rowsBehind`): held as a loading head, since `fileSection` already is. */
  rowsBehind?: boolean;
}

/**
 * The inline composer rendered inside a diff line-widget slot: a compact
 * MarkdownEditor with the anchor label, an "Add suggestion" action that inserts
 * the provider-correct ```suggestion fence pre-filled with the selected code, and
 * two submit paths — "Add single comment" (posts one line comment optimistically)
 * and "Add to review" (stages a pending-review draft). Wired by PrFilesPane via
 * DiffSurface's `lineWidget`; P5 supplies the props from the PR view.
 */
export function ReviewComposer({
  repoPath,
  number,
  path,
  side,
  line,
  fromLine,
  provider,
  fileSection,
  draftCount,
  canCreateThread,
  lens,
  onClose,
  headPending = null,
  headCold = null,
  headUnproven = false,
  rowsBehind = false,
}: ReviewComposerProps) {
  // Kept by the diff's line widget, so a remount of its rows reopens the
  // composer with this text; a restored one takes focus only if it had it.
  const {
    text: body,
    setText: setBody,
    restored,
    forget,
    setBusy,
  } = useKeptDraft(LINE_COMPOSER_KEEP_ID);
  const [pending, setPending] = useState(false);
  const createThread = useCreateReviewThread(repoPath, lens);
  const addDraft = useAddReviewDraft(repoPath, lens, number);
  const mentions = useMentionCandidates({ repoPath, lens, provider });

  // The multi-line range, normalized: [from, line] with from <= line.
  const rangeFrom = fromLine !== undefined && fromLine < line ? fromLine : line;
  const isRange = rangeFrom !== line;
  // GitHub and GitLab both carry a real range on the thread anchor (startLine);
  // Bitbucket's API anchors at the end line only (fromLine shown in the label
  // plus a disclosure below). So send startLine on GitHub/GitLab for a real
  // range, and never on Bitbucket.
  const startLine =
    (provider === "github" || provider === "gitlab") && isRange
      ? rangeFrom
      : undefined;

  const anchorLabel = isRange
    ? `Lines ${rangeFrom}–${line} · ${path}`
    : `Line ${line} · ${path}`;

  // An expanded gap draws lines the forge's patch lacks, and no forge anchors
  // a review comment there. GitHub also refuses a range leaving its end line's
  // hunk. GitLab and Bitbucket accept a range whose start is outside the diff,
  // so only the end line must be in it (GitLab still receives the start line).
  // A side's lines in one hunk are consecutive and hunks never touch, so every
  // line from start to end being a patch line means one hunk.
  const offPatch = ((): keyof typeof OFF_PATCH_REVIEW_REASON | null => {
    const drawn = patchLines(fileSection)[side];
    if (provider !== "github") return drawn.has(line) ? null : "line";
    for (let n = rangeFrom; n <= line; n++)
      if (!drawn.has(n)) return isRange ? "range" : "line";
    return null;
  })();
  const offPatchReason =
    offPatch === null ? null : OFF_PATCH_REVIEW_REASON[offPatch];
  // PR-wide holds outrank the file's own, so nobody is told to close an
  // editor to unlock a submit that would stay held.
  const noun = PR_NOUN[provider];
  const rowsHeld = useDiffRowsHeld();
  const heldReason = (() => {
    switch (true) {
      case headPending !== null:
        return HEAD_PENDING_REVIEW_REASON[headPending](noun);
      case headCold !== null:
        return HEAD_COLD_REVIEW_REASON[headCold](noun);
      case headUnproven:
        return HEAD_UNPROVEN_REVIEW_REASON(noun);
      case rowsHeld:
        return DIFF_ROWS_HELD_REASON;
      case rowsBehind:
        return HEAD_PENDING_REVIEW_REASON.loading(noun);
      default:
        return null;
    }
  })();

  // Suggestions replace NEW-side code, so an old-side anchor can't be suggested
  // on. Bitbucket suggestions are single-line only. Otherwise we need the current
  // code for the range to prefill; if it can't be recovered, degrade the action.
  const currentLines =
    side === "new" ? extractNewSideLines(fileSection, rangeFrom, line) : null;
  const bitbucketMultiline = provider === "bitbucket" && isRange;
  const suggestionDisabledReason =
    side === "old"
      ? "Suggestions replace new-side code — pick a line on the right."
      : bitbucketMultiline
        ? "Bitbucket suggestions replace a single line."
        : currentLines === null
          ? "Can't read the current code for these lines here."
          : null;
  const canSuggest = suggestionDisabledReason === null;
  // Rows a deferred render has not caught up yet load by themselves, so they
  // read like the submits' wait; only held rows ask to close the editor.
  const suggestionReason = (() => {
    switch (true) {
      case rowsHeld:
        return DIFF_ROWS_HELD_REASON;
      case rowsBehind:
        return HEAD_PENDING_REVIEW_REASON.loading(noun);
      default:
        return suggestionDisabledReason;
    }
  })();

  function insertSuggestion() {
    if (!currentLines) return;
    const fence = buildSuggestionFence(
      provider,
      { from: rangeFrom, to: line },
      currentLines,
    );
    // Append to the end of the body (a blank line before it when there's already
    // content), then let the user keep editing.
    setBody((prev) =>
      prev.trim() ? `${prev.replace(/\n*$/, "")}\n\n${fence}\n` : `${fence}\n`,
    );
  }

  async function addSingleComment() {
    if (
      !canCreateThread ||
      !body.trim() ||
      pending ||
      heldReason !== null ||
      offPatchReason !== null
    )
      return;
    setPending(true);
    // Posting is optimistic (the thread lands in the cache immediately), so close
    // right away — the synthetic thread renders under the line without waiting.
    // The failure rides the promise (detached, so the close still happens on this
    // tick): closing unmounts this composer, and react-query drops per-call mutate
    // callbacks once an observer has no listeners.
    void createThread
      .mutateAsync({ number, path, line, side, startLine, body: body.trim() })
      .catch((e) => toastError(e));
    forget();
    onClose();
  }

  async function addToReview() {
    if (
      !body.trim() ||
      pending ||
      heldReason !== null ||
      offPatchReason !== null
    )
      return;
    setPending(true);
    // In flight, the kept composer holds its rows: a rebuild under it would
    // remount it mid-submit.
    setBusy(true);
    try {
      await addDraft.mutateAsync({
        id: crypto.randomUUID(),
        path,
        line,
        side,
        ...(startLine !== undefined ? { startLine } : {}),
        body: body.trim(),
        createdAt: new Date().toISOString(),
      });
      // A settle after the widget moved on (another line, or the same path
      // in another pull request) leaves that composer and its range alone.
      if (forget()) onClose();
    } catch (e) {
      toastError(e);
      setPending(false);
      setBusy(false);
    }
  }

  // mod+Enter: add-to-review when a review is already in progress, else the
  // single-comment path (mirrors the primary button's meaning below).
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (eventToBinding(e) === "mod+enter") {
      e.preventDefault();
      if (draftCount > 0) addToReview();
      else if (canCreateThread) addSingleComment();
    } else if (e.key === "Escape") {
      // Close only this widget — don't leak Escape to global handlers.
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  }

  const addToReviewLabel =
    draftCount === 0 ? "Start a review" : "Add to review";
  // A head-pending verdict outranks the off-patch one (a verdict about the
  // older head's text), which outranks the empty body's.
  const blockedReason =
    heldReason ??
    offPatchReason ??
    (!body.trim() ? "Write a comment first" : null);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
          {anchorLabel}
        </span>
        <DisabledReasonButton
          variant="ghost"
          size="xs"
          className="shrink-0 text-muted-foreground"
          // Held rows, or rows a deferred render has not caught up yet, draw
          // an earlier text than `fileSection`, which the suggestion would
          // prefill from.
          disabled={!canSuggest || rowsHeld || rowsBehind}
          reason={suggestionReason}
          onClick={insertSuggestion}
        >
          Add suggestion
        </DisabledReasonButton>
      </div>
      {provider === "bitbucket" && isRange && (
        <p className="text-[11px] text-muted-foreground">
          Bitbucket anchors multi-line comments at the last line.
        </p>
      )}
      <MarkdownEditor
        aria-label={`Comment on ${anchorLabel}`}
        placeholder="Leave a comment…"
        value={body}
        onChange={setBody}
        onKeyDown={onKeyDown}
        autoFocus={!restored}
        rows={3}
        textareaClassName="max-h-48 min-h-16 resize-y"
        mentions={mentions}
        hostedImages={hostedImagesFor(mentions.refs?.repoPath, mentions.ghHost)}
      />
      <div className="flex items-center gap-2">
        {canCreateThread && (
          <DisabledReasonButton
            variant="outline"
            size="sm"
            disabled={blockedReason !== null || pending}
            reason={blockedReason}
            title={draftCount > 0 ? undefined : SUBMIT_HINT}
            onClick={addSingleComment}
          >
            Add single comment
          </DisabledReasonButton>
        )}
        <DisabledReasonButton
          variant={canCreateThread ? "secondary" : "outline"}
          size="sm"
          disabled={blockedReason !== null || pending}
          reason={blockedReason}
          title={draftCount > 0 ? SUBMIT_HINT : undefined}
          onClick={addToReview}
        >
          {addToReviewLabel}
        </DisabledReasonButton>
        <Button variant="ghost" size="sm" disabled={pending} onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
