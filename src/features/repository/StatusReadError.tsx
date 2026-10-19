import {
  ArrowClockwiseIcon,
  InfoIcon,
  TerminalIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { type Ref, useEffect, useState } from "react";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { DegradedListNotice } from "@/features/conversations/ConversationListPanel";
import { DEGRADED_ACTION_CLASS } from "@/features/conversations/remote-section-state";
import { STATUS_READ_FAILED_REASON } from "@/features/repository/sync-controls-state";
import { clipTitleFromText } from "@/lib/clip-title";
import { presentError } from "@/lib/error-summary";
import { openInTerminal } from "@/lib/git/api";
import { useSettings } from "@/lib/settings/queries";
import { useErrorDialog } from "@/lib/stores/error-dialog";
import { toastError } from "@/lib/toast";
import { cn } from "@/lib/utils";

/** Details on a status error that has no object yet: a remount over a cached
 *  failure holds only the sticky gate until the next failed check lands. */
const NO_DETAILS_YET_REASON = "Details arrive with the next check";

/** A status read that failed with nothing loaded. Sticky, never `isError`: a
 *  never-loaded query that errored goes back to pending on every poll, which
 *  would flip each surface back to its loading state. */
export function statusReadFailed(q: {
  data: unknown;
  errorUpdateCount: number;
}): boolean {
  return q.data === undefined && q.errorUpdateCount > 0;
}

/** Opens the shared error dialog (full raw text with Copy) on a status error. */
export function openStatusErrorDetails(error: unknown) {
  useErrorDialog.getState().open(presentError(error));
}

/**
 * The newest status error OBJECT seen under `repoPath`, for the message and
 * Details: react-query nulls `error` and `failureReason` at each dataless
 * refetch, so the block would otherwise lose its message every poll. Stamped
 * with its repo and compared at read, never cleared in an effect: the hosts
 * stay mounted across repo switches. Not a gate; callers gate on query state.
 */
export function useRetainedStatusError({
  repoPath,
  error,
}: {
  repoPath: string;
  error: unknown;
}): unknown {
  const [retained, setRetained] = useState<{
    repoPath: string;
    error: unknown;
  } | null>(null);
  useEffect(() => {
    if (error == null) return;
    setRetained((prev) =>
      prev?.repoPath === repoPath && prev.error === error
        ? prev
        : { repoPath, error },
    );
  }, [repoPath, error]);
  return retained?.repoPath === repoPath ? retained.error : null;
}

/**
 * Stands in for a status read that failed with nothing loaded, in the empty
 * state's geometry. The host owns the announcement: an always-mounted
 * `role="status"` region whose text becomes {@link STATUS_READ_FAILED_REASON},
 * since a region mounted with its text already in it may never announce.
 * `error` may be null (a remount over a cached failure): the message line is
 * omitted until the next failed check fills it.
 */
export function StatusReadErrorState({
  error,
  onRetry,
  repoPath,
  rescueRef,
  compact = false,
}: {
  error: unknown;
  onRetry: () => void;
  repoPath: string;
  /** `useRetryFocusRescue`'s `retryRef`, on the box holding every action, so
   *  the host knows whether focus was in the block when it unmounted. */
  rescueRef?: Ref<HTMLDivElement>;
  /** Tighter spacing for a pane that is not the whole Changes tab. */
  compact?: boolean;
}) {
  const settings = useSettings();
  const summary = error == null ? null : presentError(error).summary;

  return (
    <Empty ref={rescueRef} className={cn("flex-1", compact && "gap-3 p-4")}>
      <EmptyHeader className="w-full">
        <EmptyMedia variant="icon">
          {/* Tint on the icon only: the title carries the state in words. */}
          <WarningIcon className="text-warning" />
        </EmptyMedia>
        <EmptyTitle>{STATUS_READ_FAILED_REASON}</EmptyTitle>
        {summary ? (
          <EmptyDescription
            className="w-full truncate"
            onMouseEnter={clipTitleFromText}
          >
            {summary}
          </EmptyDescription>
        ) : null}
      </EmptyHeader>
      <EmptyContent className={cn(compact && "gap-2")}>
        <div className="flex w-full max-w-60 flex-col gap-2">
          <Button variant="outline" size="sm" onClick={onRetry}>
            <ArrowClockwiseIcon data-icon="inline-start" />
            Retry
          </Button>
          <DisabledReasonButton
            variant="outline"
            size="sm"
            wrapperClassName="w-full"
            className="w-full"
            disabled={error == null}
            reason={error == null ? NO_DETAILS_YET_REASON : null}
            onClick={() => openStatusErrorDetails(error)}
          >
            <InfoIcon data-icon="inline-start" />
            Details
          </DisabledReasonButton>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              openInTerminal(
                repoPath,
                settings.data?.terminal,
                settings.data?.terminalPath,
                settings.data?.terminalCommand,
              ).catch((e: unknown) => toastError(e))
            }
          >
            <TerminalIcon data-icon="inline-start" />
            Open in terminal
          </Button>
        </div>
        <p className="text-muted-foreground">Checks again automatically.</p>
      </EmptyContent>
    </Empty>
  );
}

/**
 * The in-flow line above a status the last read couldn't refresh. Mount it
 * whenever the list renders, with `degraded` saying whether the latest read
 * failed: the notice keeps its live region and focus landing mounted while
 * healthy.
 */
export function StatusRefreshFailedStrip({
  degraded,
  onRetry,
  onDetails,
}: {
  degraded: boolean;
  onRetry: () => void;
  onDetails: () => void;
}) {
  return (
    <DegradedListNotice
      noun="the status"
      degraded={degraded}
      onRetry={onRetry}
      message="Couldn't refresh the status — showing the last read."
      retryLabel="Retry reading the status"
      extraAction={
        <button
          type="button"
          aria-label="Show the status error details"
          onClick={onDetails}
          className={DEGRADED_ACTION_CLASS}
        >
          Details
        </button>
      }
      className="border-b py-1.5"
    />
  );
}
