import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { MarkdownEditor } from "@/components/markdown-editor";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import type { ReviewVerdict } from "@/lib/git/api";
import { useSubmitReview } from "@/lib/git/queries";
import type { DraftCommentIn, RemoteLens } from "@/lib/git/types";
import {
  useClearReviewDrafts,
  useReviewDrafts,
} from "@/lib/pulls/review-drafts";
import { toastError } from "@/lib/toast";

/**
 * The submit-a-review dialog: a capability-gated verdict radio (Comment always;
 * Approve / Request changes only when the provider allows), an optional summary
 * (REQUIRED for Request changes), and a submit that posts the pending drafts as
 * one batch review. On success it clears the drafts, closes, and toasts the
 * posted count; on error it stays open and surfaces the error verbatim (it may
 * disclose partial posting on GitLab/Bitbucket, so it's shown untruncated).
 * Usable with zero drafts too (a plain verdict + summary review).
 */
export function SubmitReviewDialog({
  repoPath,
  number,
  open,
  onOpenChange,
  caps,
  remoteLabel,
  lens,
}: {
  repoPath: string;
  number: number;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  caps: { canApprove: boolean; canRequestChanges: boolean };
  remoteLabel: string;
  /** The origin|upstream lens the parent PR view resolved. */
  lens: RemoteLens;
}) {
  const drafts = useReviewDrafts(repoPath, lens, number);
  const submitReview = useSubmitReview(repoPath, lens);
  const clearDrafts = useClearReviewDrafts(repoPath, lens, number);
  const [verdict, setVerdict] = useState<ReviewVerdict>("comment");
  const [summary, setSummary] = useState("");
  const [error, setError] = useState<string | null>(null);
  // The parent re-keys this dialog on the PR identity, so a switch can unmount it
  // mid-submit — past `handleOpenChange`'s pending guard. That takes away BOTH of
  // this component's report channels: the inline error below has nowhere to render
  // (hence the catch's toast fallback), and react-query stops delivering `mutate`
  // callbacks once the observer loses its listeners (hence `mutateAsync` in the
  // cleanup). Either loss would let a failed or PARTIAL post read as success.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const draftList = drafts.data ?? [];
  const count = draftList.length;
  // Clamp to a verdict whose radio is actually offered: a stale
  // `approve`/`request_changes` (e.g. caps changed while the dialog was closed,
  // or the option was never shown) must never submit. Comment is always offered.
  const verdictOffered =
    verdict === "comment" ||
    (verdict === "approve" && caps.canApprove) ||
    (verdict === "request_changes" && caps.canRequestChanges);
  const effectiveVerdict: ReviewVerdict = verdictOffered ? verdict : "comment";
  // Request changes must say why — GitHub/GitLab reject an empty-body one.
  const summaryRequired = effectiveVerdict === "request_changes";
  const summaryMissing = summaryRequired && summary.trim() === "";
  const pending = submitReview.isPending || clearDrafts.isPending;

  // Reset transient state whenever the dialog closes (for ANY reason — Cancel,
  // Esc, backdrop, or a successful submit), so a reopen never shows a stale
  // verdict/summary/error. Blocked while a submit is in flight.
  function handleOpenChange(next: boolean) {
    if (pending) return;
    if (!next) {
      setVerdict("comment");
      setSummary("");
      setError(null);
    }
    onOpenChange(next);
  }

  async function submit() {
    if (summaryMissing || pending) return;
    setError(null);
    const comments: DraftCommentIn[] = draftList.map((d) => ({
      path: d.path,
      line: d.line,
      side: d.side,
      ...(d.startLine ? { startLine: d.startLine } : {}),
      body: d.body,
    }));
    let result: Awaited<ReturnType<typeof submitReview.mutateAsync>>;
    try {
      result = await submitReview.mutateAsync({
        number,
        verdict: effectiveVerdict,
        summary: summary.trim() || undefined,
        comments,
      });
    } catch (e) {
      // The post itself failed — keep the dialog open, Submit re-armed, and show
      // the message verbatim (on GitLab/Bitbucket it can disclose partial posting,
      // which the user needs to see in full). Unmounted mid-submit, that surface is
      // gone, so the failure rides a toast rather than vanishing.
      if (mounted.current) {
        setError(e instanceof Error ? e.message : String(e));
      } else {
        toastError(e);
      }
      return;
    }
    // The review posted. From here Submit must NEVER re-arm — a second click
    // would double-post the batch. Always close + confirm, regardless of what
    // clearing the local drafts does next.
    handleOpenChange(false);
    toast.success(
      `Review submitted — ${result.posted} comment${result.posted === 1 ? "" : "s"} posted on ${remoteLabel}`,
    );
    // Clearing the (client-only) drafts is a best-effort cleanup AFTER the post
    // landed; a failure here can't un-post, so surface it as a non-blocking
    // warning pointing at the pending bar's Discard — never as a submit error.
    clearDrafts
      .mutateAsync()
      .catch(() =>
        toast.warning(
          "Review posted, but clearing the pending comments failed — discard them from the pending review bar so they aren't submitted again.",
        ),
      );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="grid max-h-[85vh] sm:max-w-md">
        <DialogHeader className="min-w-0">
          <DialogTitle>Submit review</DialogTitle>
          <DialogDescription>
            {count > 0
              ? `Submits your verdict and summary with ${count} pending comment${count === 1 ? "" : "s"} on ${remoteLabel}.`
              : `No pending comments — this submits your verdict and summary only on ${remoteLabel}.`}
          </DialogDescription>
        </DialogHeader>

        <div className="min-w-0 space-y-3 overflow-y-auto overflow-x-hidden">
          <RadioGroup
            value={effectiveVerdict}
            onValueChange={(v) => setVerdict(v as ReviewVerdict)}
            className="gap-2 text-xs"
          >
            <label className="flex cursor-pointer items-center gap-2">
              <Radio value="comment" />
              Comment
              <span className="text-muted-foreground">
                — leave feedback without an explicit approval
              </span>
            </label>
            {caps.canApprove && (
              <label className="flex cursor-pointer items-center gap-2">
                <Radio value="approve" />
                Approve
                <span className="text-muted-foreground">
                  — approve these changes
                </span>
              </label>
            )}
            {caps.canRequestChanges && (
              <label className="flex cursor-pointer items-center gap-2">
                <Radio value="request_changes" />
                Request changes
                <span className="text-muted-foreground">
                  — ask for changes before merging
                </span>
              </label>
            )}
          </RadioGroup>

          <MarkdownEditor
            aria-label="Review summary"
            placeholder={
              summaryRequired
                ? "Explain what changes you're requesting…"
                : "Add an optional summary…"
            }
            value={summary}
            onChange={setSummary}
            rows={4}
            textareaClassName="max-h-48 min-h-20 resize-y"
          />

          {error && (
            <p className="whitespace-pre-wrap break-words text-destructive">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => handleOpenChange(false)}
          >
            Cancel
          </Button>
          <DisabledReasonButton
            disabled={summaryMissing || pending}
            reason={
              summaryMissing
                ? "A summary is required to request changes."
                : undefined
            }
            onClick={submit}
          >
            Submit review
          </DisabledReasonButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
