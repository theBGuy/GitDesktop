import { type KeyboardEvent, useState } from "react";
import { MarkdownEditor } from "@/components/markdown-editor";
import { Button } from "@/components/ui/button";
import { useCreateReviewThread } from "@/lib/git/queries";
import type { RemoteLens } from "@/lib/git/types";
import { formatBinding } from "@/lib/hotkeys/binding";
import { useAddReviewDraft } from "@/lib/pulls/review-drafts";
import { toastError } from "@/lib/toast";
import { buildSuggestionFence, extractNewSideLines } from "./suggestion-utils";

/** Platform-correct submit hint (Cmd+Enter on macOS, Ctrl+Enter else) — never a
 *  literal modifier (house platform-mod-key rule). */
const SUBMIT_HINT = formatBinding("mod+enter");

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
}: ReviewComposerProps) {
  const [body, setBody] = useState("");
  const [pending, setPending] = useState(false);
  const createThread = useCreateReviewThread(repoPath, lens);
  const addDraft = useAddReviewDraft(repoPath, number);

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
    if (!canCreateThread || !body.trim() || pending) return;
    setPending(true);
    // Posting is optimistic (the thread lands in the cache immediately), so close
    // right away — the synthetic thread renders under the line without waiting.
    createThread.mutate(
      { number, path, line, side, startLine, body: body.trim() },
      { onError: (e) => toastError(e) },
    );
    onClose();
  }

  async function addToReview() {
    if (!body.trim() || pending) return;
    setPending(true);
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
      onClose();
    } catch (e) {
      toastError(e);
      setPending(false);
    }
  }

  // mod+Enter: add-to-review when a review is already in progress, else the
  // single-comment path (mirrors the primary button's meaning below).
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
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

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
          {anchorLabel}
        </span>
        {/* Wrap the (possibly) disabled suggestion button so its `title` — the
            reason — still shows (a native-disabled button swallows the tooltip). */}
        <span title={suggestionDisabledReason ?? undefined}>
          <Button
            variant="ghost"
            size="xs"
            className="shrink-0 text-muted-foreground"
            disabled={!canSuggest}
            onClick={insertSuggestion}
          >
            Add suggestion
          </Button>
        </span>
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
        autoFocus
        rows={3}
        textareaClassName="max-h-48 min-h-16 resize-y"
      />
      <div className="flex items-center gap-2">
        {canCreateThread && (
          <span
            title={
              !body.trim()
                ? "Write a comment first"
                : draftCount > 0
                  ? undefined
                  : SUBMIT_HINT
            }
          >
            <Button
              variant="outline"
              size="sm"
              disabled={!body.trim() || pending}
              onClick={addSingleComment}
            >
              Add single comment
            </Button>
          </span>
        )}
        <span
          title={
            !body.trim()
              ? "Write a comment first"
              : draftCount > 0
                ? SUBMIT_HINT
                : undefined
          }
        >
          <Button
            variant={canCreateThread ? "secondary" : "outline"}
            size="sm"
            disabled={!body.trim() || pending}
            onClick={addToReview}
          >
            {addToReviewLabel}
          </Button>
        </span>
        <Button variant="ghost" size="sm" disabled={pending} onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
