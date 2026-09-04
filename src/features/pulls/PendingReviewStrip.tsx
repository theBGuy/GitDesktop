import { ArrowSquareOutIcon, NotePencilIcon } from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useDiscardPendingReview } from "@/lib/git/queries";
import type { PrThreadOut, RemoteLens } from "@/lib/git/types";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { useConfirm } from "@/lib/stores/confirm";
import { toastError } from "@/lib/toast";

/**
 * The notice for a review the viewer started on the forge and never submitted, in the
 * slot and vocabulary of the mergeability banner above it. Renders nothing without
 * one, which is also why nothing here is provider-gated: only GitHub models reviews at
 * all, so a GitLab/Bitbucket pull request supplies none and the strip stays absent.
 *
 * Both actions name the forge, because both act on the review that lives THERE — the
 * app's own on-disk draft comments have their own bar and their own discard.
 */
export function PendingReviewStrip({
  repoPath,
  lens,
  number,
  review,
  prUrl,
  remoteLabel,
  stale,
  selected,
}: {
  repoPath: string;
  lens: RemoteLens;
  number: number;
  /** The viewer's unfinished review; absent when there is none. */
  review: PrThreadOut | undefined;
  /** The pull request's page on the forge, where the review can be submitted. */
  prUrl: string;
  /** The detected provider's label ("GitHub"), for the action labels. */
  remoteLabel: string;
  /** The view is showing the PREVIOUS pull request's details while the switch lands.
   *  Everything here addresses `number`, which is already the new one, so the strip
   *  goes quiet rather than acting on the wrong pull request. */
  stale: boolean;
  /** This view owns the current selection — a lagging still-mounted view must not
   *  answer the palette for a pull request the user has navigated away from. */
  selected: boolean;
}) {
  const discard = useDiscardPendingReview(repoPath, lens);
  const reviewId = review?.id;
  // Held by both the buttons and the palette entries, so a keyboard route can never
  // do what the disabled control refuses. An absent id is spelled "" here, the way
  // the backend spells a review whose source supplied none.
  const ready = !!reviewId && !stale && !discard.isPending;

  function finishReview() {
    if (!ready) return;
    openUrl(prUrl);
  }

  async function discardReview() {
    if (!ready) return;
    const ok = await useConfirm.getState().ask({
      title: `Discard your review on ${remoteLabel}?`,
      body: "Your unfinished review and any draft comments in it are permanently deleted on GitHub.",
      confirmLabel: `Discard on ${remoteLabel}`,
      confirmVariant: "destructive",
    });
    if (!ok) return;
    // The optimistic patch drops the review — and this strip with it — before the
    // call settles, so the outcome rides the awaited continuation; per-call mutate
    // callbacks would go with the unmounted observer.
    try {
      await discard.mutateAsync({ number, reviewId });
      toast.success("Pending review discarded");
    } catch (e) {
      toastError(e);
    }
  }

  // The dispatch route re-checks `selected` at invoke: `enabled` de-registers one
  // commit late and the dispatcher runs the LATEST closure, so a keydown in that
  // window would otherwise act on a pull request the user has already left. A click
  // can't land that way — its closure is all one PR's — so the buttons don't consult it.
  useHotkeyAction(
    "finish-review-on-github",
    () => {
      if (selected) finishReview();
    },
    ready && selected,
  );
  useHotkeyAction(
    "discard-review-on-github",
    () => {
      if (selected) void discardReview();
    },
    ready && selected,
  );

  if (!review?.id || stale) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b px-3 py-1.5 text-xs">
      <span className="flex min-w-0 items-center gap-1.5 text-info">
        {/* Decorative — the sentence carries the meaning, not the icon or the tone. */}
        <NotePencilIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0">
          You have an unfinished review on this pull request.
        </span>
      </span>
      <div className="flex items-center gap-1.5">
        <Button
          variant="ghost"
          size="xs"
          className="text-destructive"
          disabled={discard.isPending}
          onClick={() => void discardReview()}
        >
          {`Discard on ${remoteLabel}…`}
        </Button>
        <Button
          variant="outline"
          size="xs"
          disabled={discard.isPending}
          onClick={finishReview}
          title={`Open this pull request on ${remoteLabel} to submit or edit your review`}
        >
          <ArrowSquareOutIcon data-icon="inline-start" />
          {`Finish on ${remoteLabel}`}
        </Button>
      </div>
    </div>
  );
}
