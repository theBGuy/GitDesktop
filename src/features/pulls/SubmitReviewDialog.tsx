import { type RefObject, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { DIALOG_SCROLL_X_HIDDEN } from "@/components/dialog-scroll";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { hostedImagesFor } from "@/components/markdown/markdown-images";
import { MarkdownEditor } from "@/components/markdown-editor";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import { presentError, reviewMayHavePosted } from "@/lib/error-summary";
import type { ReviewVerdict } from "@/lib/git/api";
import { useForgeGhHost } from "@/lib/git/host";
import {
  isPendingFor,
  usePendingPrWrites,
  useSubmitReview,
} from "@/lib/git/queries";
import type { DraftCommentIn, RemoteLens } from "@/lib/git/types";
import {
  ACT_PENDING_REASON,
  pendingWriteReason,
  refuseWhileOffline,
  useOfflineHold,
} from "@/lib/offline-writes";
import type { PrNoun } from "@/lib/pulls/pr-state";
import {
  useClearReviewDrafts,
  useReviewDrafts,
} from "@/lib/pulls/review-drafts";
import { type ConfirmRequest, useConfirm } from "@/lib/stores/confirm";
import { toastError } from "@/lib/toast";
import { useLatestRef } from "@/lib/use-latest-ref";
import { cn } from "@/lib/utils";

/**
 * One verdict option. An unavailable verdict stays VISIBLE and disabled, its reason
 * taking the hint's place — the radio twin of `DisabledReasonButton` (wrapper title +
 * `aria-describedby`), except the reason renders visibly: a natively-disabled radio
 * can't take focus, so a hover-only tooltip would reach neither keyboard nor AT users.
 */
function VerdictOption({
  value,
  label,
  hint,
  reason,
}: {
  value: ReviewVerdict;
  label: string;
  /** What choosing this verdict does — shown when it's available. */
  hint: string;
  /** Why it isn't available; absent when it is. */
  reason?: string;
}) {
  const hintId = useId();
  return (
    <label
      className={cn(
        "flex items-center gap-2",
        reason ? "cursor-not-allowed text-muted-foreground" : "cursor-pointer",
      )}
      title={reason}
    >
      <Radio
        value={value}
        disabled={Boolean(reason)}
        aria-describedby={hintId}
      />
      {label}
      <span id={hintId} className="text-muted-foreground">
        — {reason ?? hint}
      </span>
    </label>
  );
}

/** Cancels the prompt `asked` holds, only while it is still the open one: once
 *  answered, the store's live request belongs to whoever asked next. */
function dropAsked(asked: RefObject<ConfirmRequest | null>) {
  const request = asked.current;
  asked.current = null;
  if (request !== null && useConfirm.getState().request === request)
    request.resolve(false, false);
}

/**
 * The submit-a-review dialog: a verdict radio (Comment always; Approve / Request
 * changes disabled-with-reason until the provider allows them), an optional summary
 * (REQUIRED for Request changes), and a submit that posts the pending drafts as
 * one batch review. On success it clears the drafts, closes, and toasts the
 * posted count; on error it stays open and shows the error's one-line summary,
 * which keeps a partial-posting headline from GitLab/Bitbucket ahead of any
 * rewrite. Usable with zero drafts too (a plain verdict + summary review).
 */
export function SubmitReviewDialog({
  repoPath,
  number,
  open,
  onOpenChange,
  caps,
  remoteLabel,
  prNoun,
  lens,
}: {
  repoPath: string;
  number: number;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  caps: { canApprove: boolean; canRequestChanges: boolean };
  remoteLabel: string;
  /** What this forge calls the item under review. */
  prNoun: PrNoun;
  /** The origin|upstream lens the parent PR view resolved. */
  lens: RemoteLens;
}) {
  const drafts = useReviewDrafts(repoPath, lens, number);
  const submitReview = useSubmitReview(repoPath, lens);
  // Silent: the post already landed by the time this runs, so a clear failure is
  // reported below in words that say the drafts are still safe — not as a bare error.
  const clearDrafts = useClearReviewDrafts(repoPath, lens, { silent: true });
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
  // The prompt this dialog opened. It is repo-scoped, so it would outlive a
  // same-repo PR switch (which re-keys this dialog) or a parent-side close.
  const asked = useRef<ConfirmRequest | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      dropAsked(asked);
    };
  }, []);
  // A parent-side close skips `handleOpenChange`, so it ends the memory here too.
  useEffect(() => {
    if (open) return;
    dropAsked(asked);
    mayHavePosted.current = false;
  }, [open]);

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
  // Locks the dialog open, so it reads this mount's own writes: a submit an
  // earlier mount started (before a PR switch) must not trap a reopened dialog.
  const pending = submitReview.isPending || clearDrafts.isPending;
  // Holds Submit, so it reads the cache: the parent remounts this dialog per PR,
  // and a fresh observer would re-arm Submit beside a submit still posting. The
  // variables carry no lens, so the same number in the other lens holds too.
  const pendingWrites = usePendingPrWrites(repoPath);
  const ghHost = useForgeGhHost(repoPath);
  const submitInFlight = isPendingFor(
    pendingWrites,
    "submit-review",
    number,
    lens,
  );
  // Parked only when ALL matching submits are: a running one means work is
  // happening, so the hold says in-flight.
  const submitPaused =
    submitInFlight &&
    !isPendingFor(
      pendingWrites.filter((w) => !w.paused),
      "submit-review",
      number,
      lens,
    );
  const submitHeld = pending || submitInFlight;
  // Submit holds offline rather than park: a parked post keeps `pending` set,
  // which locks this dialog open until the connection returns.
  const offlineHold = useOfflineHold();
  // Both verdicts are gated on the same thing (`usePrCapabilities`): the host's
  // approve / request-changes wiring, which reads as unavailable until the forge
  // connection resolves. One reason serves both, and "connects" holds in every
  // reachable state: GitLab and Bitbucket both implement the verdicts
  // (forge/model.rs `for_provider`), so a false cap on them means disconnected,
  // and GitHub never reaches the disabled arm (`canWrite ||` at the call site).
  const unavailable = `available once GitDesktop connects to ${remoteLabel}`;
  // Set by a failure that may have posted part of this review, so the next
  // Submit asks first: a second post can duplicate its comments.
  const mayHavePosted = useRef(false);
  // submit() re-reads these after its prompt, when the press's render is stale.
  const live = useLatestRef({
    open,
    summaryMissing,
    submitHeld,
    draftList,
    summary,
    effectiveVerdict,
  });

  // Reset transient state whenever the dialog closes (for ANY reason — Cancel,
  // Esc, backdrop, or a successful submit), so a reopen never shows a stale
  // verdict/summary/error. Blocked while a submit is in flight.
  function handleOpenChange(next: boolean) {
    if (pending) return;
    if (!next) {
      setVerdict("comment");
      setSummary("");
      setError(null);
      mayHavePosted.current = false;
    }
    onOpenChange(next);
  }

  async function submit() {
    if (summaryMissing || submitHeld || refuseWhileOffline()) return;
    let state = { draftList, summary, effectiveVerdict };
    if (mayHavePosted.current) {
      const answer = useConfirm.getState().ask({
        title: "Submit this review again?",
        body: `The last attempt may have posted some or all of this review on ${remoteLabel}. Submitting again can post the same comments twice. Check the ${prNoun} first.`,
        confirmLabel: "Submit again",
        holdOffline: true,
      });
      // `ask` sets the request synchronously, so this is the one just opened.
      const mine = useConfirm.getState().request;
      asked.current = mine;
      const ok = await answer;
      if (asked.current === mine) asked.current = null;
      const now = live.current;
      if (
        !ok ||
        !mounted.current ||
        !now.open ||
        now.summaryMissing ||
        now.submitHeld ||
        refuseWhileOffline()
      )
        return;
      state = now;
    }
    setError(null);
    const comments: DraftCommentIn[] = state.draftList.map((d) => ({
      path: d.path,
      line: d.line,
      side: d.side,
      ...(d.startLine ? { startLine: d.startLine } : {}),
      body: d.body,
    }));
    const sentSummary = state.summary.trim() || undefined;
    let result: Awaited<ReturnType<typeof submitReview.mutateAsync>>;
    try {
      result = await submitReview.mutateAsync({
        number,
        verdict: state.effectiveVerdict,
        summary: sentSummary,
        comments,
      });
    } catch (e) {
      // The post itself failed — keep the dialog open, Submit re-armed, and show
      // the error's one-line summary, partial-posting headline included. Unmounted
      // mid-submit, that surface is gone, so the failure rides a toast instead.
      // Set outside the guard: a tab hide also clears `mounted` while the dialog
      // stays open. A verdict alone has nothing a second post could duplicate.
      // Limit: a "Posted 0 of N" or "Saved 0 of N" failure with no summary asks.
      mayHavePosted.current =
        (sentSummary !== undefined || comments.length > 0) &&
        reviewMayHavePosted(e);
      if (mounted.current) {
        setError(presentError(e).summary);
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
      .mutateAsync({ number })
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

        <div className={cn(DIALOG_SCROLL_X_HIDDEN, "min-w-0 space-y-3")}>
          <RadioGroup
            aria-label="Review verdict"
            value={effectiveVerdict}
            onValueChange={(v) => setVerdict(v as ReviewVerdict)}
            className="gap-2 text-xs"
          >
            <VerdictOption
              value="comment"
              label="Comment"
              hint="leave feedback without an explicit approval"
            />
            <VerdictOption
              value="approve"
              label="Approve"
              hint="approve these changes"
              reason={caps.canApprove ? undefined : unavailable}
            />
            <VerdictOption
              value="request_changes"
              label="Request changes"
              hint="ask for changes before merging"
              reason={caps.canRequestChanges ? undefined : unavailable}
            />
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
            hostedImages={hostedImagesFor(repoPath, ghHost)}
          />

          {error && (
            <p className="whitespace-pre-wrap break-words text-destructive">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <DisabledReasonButton
            variant="outline"
            disabled={pending}
            // Paused from the same observer as the lock it explains.
            reason={
              pending
                ? pendingWriteReason(submitReview.isPaused, ACT_PENDING_REASON)
                : undefined
            }
            onClick={() => handleOpenChange(false)}
          >
            Cancel
          </DisabledReasonButton>
          <DisabledReasonButton
            disabled={summaryMissing || submitHeld || !!offlineHold}
            // The running submit outranks the offline hold; giving it a reason
            // keeps the button aria-disabled through either flip.
            reason={(() => {
              switch (true) {
                case summaryMissing:
                  return "A summary is required to request changes.";
                case submitInFlight:
                  return pendingWriteReason(submitPaused, ACT_PENDING_REASON);
                case pending:
                  return ACT_PENDING_REASON;
                default:
                  return offlineHold;
              }
            })()}
            onClick={submit}
          >
            Submit review
          </DisabledReasonButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
