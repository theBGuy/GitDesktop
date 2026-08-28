import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { copyText } from "@/lib/clipboard";
import { type ForgeProvider, providerLabel } from "@/lib/git/types";
import type { WorkflowRun } from "@/lib/github/actions";
import {
  type CiRunNoun,
  cancelLabel,
  cancelOffered,
  ciRunNoun,
  isPipelineProvider,
  RERUN_TITLES,
  rerunOffers,
} from "./status";

/** Sentence-initial noun for the copy toast; the item's own label carries it
 *  mid-sentence, where `ciRunNoun` is used directly. */
const COPIED_URL_TOAST: Record<CiRunNoun, string> = {
  run: "Run URL copied",
  pipeline: "Pipeline URL copied",
};

/** Callbacks the menu items invoke — owned by the runs panel, which holds the
 *  mutations, toasts, and dialog state so this stays presentational. */
export interface RunMenuActions {
  rerun: (runId: number, failedOnly: boolean) => void;
  cancel: (runId: number) => void;
  /** Open the run dialog. A workflow id preselects that workflow (GitHub);
   *  null just opens it — the pipeline forges have one config per project. */
  runAgain: (workflowId: number | null) => void;
}

/**
 * The runs-list right-click actions. Which re-runs are offered, and what they're
 * called, come from the shared helpers in `status.tsx`, so this menu and the run
 * detail view can't drift. Actions a provider can't perform are absent; ones the
 * viewer lacks push access for stay visible and disabled, with the reason riding
 * the label (a disabled menu item can't carry a tooltip).
 */
export function RunContextMenuItems({
  run,
  provider,
  actions,
  canRerun,
  canCancel,
  canRunAgain,
  writeBlocked,
  writeReason,
}: {
  run: WorkflowRun;
  provider: ForgeProvider | null | undefined;
  actions: RunMenuActions;
  /** Forge capability, not permission: false hides the group entirely. */
  canRerun: boolean;
  canCancel: boolean;
  canRunAgain: boolean;
  writeBlocked: boolean;
  writeReason?: string;
}) {
  // Destructured so each callback closes over a const binding rather than a
  // property read off the actions object.
  const { rerun, cancel, runAgain } = actions;
  const offers = canRerun
    ? rerunOffers(provider, run.status, run.conclusion)
    : [];
  const showCancel =
    canCancel && cancelOffered(provider, run.status, run.conclusion);
  const isPipelines = isPipelineProvider(provider);
  const noun = ciRunNoun(provider);
  // GitHub re-dispatches THIS run's workflow, so the item needs its database id;
  // GitLab and Bitbucket have nothing to preselect.
  const showRunAgain =
    canRunAgain && (isPipelines || run.workflowDatabaseId > 0);
  const hasWriteItems = offers.length > 0 || showCancel || showRunAgain;
  const blockedHint = writeBlocked && writeReason ? ` (${writeReason})` : "";

  return (
    <>
      {offers.map((offer) => (
        <ContextMenuItem
          key={offer.kind}
          disabled={writeBlocked}
          // A disabled item's tooltip never shows, so a blocked item explains
          // itself through the label parenthetical instead.
          title={writeBlocked ? undefined : RERUN_TITLES[offer.kind]}
          onClick={() => rerun(run.id, offer.kind === "failed")}
        >
          {offer.label}
          {blockedHint}
        </ContextMenuItem>
      ))}
      {showCancel && (
        <>
          {offers.length > 0 && <ContextMenuSeparator />}
          <ContextMenuItem
            disabled={writeBlocked}
            onClick={() => cancel(run.id)}
          >
            {cancelLabel(provider)}
            {blockedHint}
          </ContextMenuItem>
        </>
      )}
      {showRunAgain && (
        <>
          {(offers.length > 0 || showCancel) && <ContextMenuSeparator />}
          <ContextMenuItem
            disabled={writeBlocked}
            onClick={() =>
              runAgain(isPipelines ? null : run.workflowDatabaseId)
            }
          >
            {isPipelines ? "Run pipeline…" : "Run workflow again…"}
            {blockedHint}
          </ContextMenuItem>
        </>
      )}
      {run.url && (
        <>
          {hasWriteItems && <ContextMenuSeparator />}
          <ContextMenuItem onClick={() => openUrl(run.url)}>
            View on {providerLabel(provider)}
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => copyText(run.url, COPIED_URL_TOAST[noun])}
          >
            Copy {noun} URL
          </ContextMenuItem>
        </>
      )}
    </>
  );
}
