import { ArrowCounterClockwiseIcon, XIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useDismissOplog, useOplogCheck } from "@/lib/git/queries";
import { useLocalPrs } from "@/lib/pulls/queries";
import { toastError } from "@/lib/toast";
import { OperationHistoryDialog } from "./OperationHistoryDialog";
import { StashesDialog } from "./StashesDialog";

/**
 * A calm, inform-only recovery line shown when GitDesktop's operation journal
 * finds that a risky compound op was interrupted (e.g. by a crash or restart).
 * It attributes WHAT was interrupted and WHERE the repo was before it started;
 * it never resets or continues anything — the git-native Continue/Abort live in
 * ConflictBanner (in the Changes panel) when the op is mid-flight. Renders as a
 * full-width bar at the top of the repo view, or nothing when no op was interrupted.
 */
export function OpRecoveryBanner({ repoPath }: { repoPath: string }) {
  const check = useOplogCheck(repoPath);
  const dismiss = useDismissOplog(repoPath);
  const localPrs = useLocalPrs(repoPath);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [recoverOpen, setRecoverOpen] = useState(false);

  // A paused local-PR merge leaves its oplog entry pending, but the guided-finish
  // banner already owns that op (Finish/Abort). Skip any interrupted op whose id
  // matches an active pendingMerge so it isn't double-surfaced here.
  const guidedOpIds = new Set(
    (localPrs.data ?? [])
      .map((p) => p.pendingMerge?.opId)
      .filter((id): id is string => Boolean(id)),
  );
  const op = check.data?.find((o) => !guidedOpIds.has(o.id));
  if (!op) return null;

  const sha7 = op.originalSha ? op.originalSha.slice(0, 7) : "";
  // A detached start is recorded as the string "HEAD"; show it as "detached HEAD".
  const refLabel =
    op.originalRef && op.originalRef !== "HEAD"
      ? op.originalRef
      : "detached HEAD";

  return (
    // Full-width single line: the interrupted op + where the repo was, then the
    // recovery actions. Inform-only — no reset/continue (those live in ConflictBanner
    // in the Changes panel when the op is mid-flight).
    <div className="flex items-center justify-between gap-x-3 border-b px-3 py-1.5 text-xs">
      <span className="flex min-w-0 items-center gap-1.5">
        <ArrowCounterClockwiseIcon className="size-3.5 shrink-0 text-warning" />
        <span
          className="min-w-0 truncate"
          title={`Interrupted: ${op.label} · was on ${refLabel}${sha7 ? ` @ ${sha7}` : ""}`}
        >
          <span className="text-warning">Interrupted: {op.label}</span>
          <span className="text-muted-foreground">
            {" · "}was on {refLabel}
            {sha7 ? ` @ ${sha7}` : ""}
          </span>
        </span>
      </span>
      <div className="flex shrink-0 items-center gap-0.5">
        <Button variant="ghost" size="xs" onClick={() => setHistoryOpen(true)}>
          History
        </Button>
        <Button variant="ghost" size="xs" onClick={() => setRecoverOpen(true)}>
          Recover…
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Dismiss"
          disabled={dismiss.isPending}
          onClick={() => void dismiss.mutateAsync(op.id).catch(toastError)}
        >
          {dismiss.isPending ? <Spinner /> : <XIcon />}
        </Button>
      </div>

      <OperationHistoryDialog
        repoPath={repoPath}
        open={historyOpen}
        onOpenChange={setHistoryOpen}
      />
      <StashesDialog
        repoPath={repoPath}
        open={recoverOpen}
        onOpenChange={setRecoverOpen}
        initialView="recoverable"
      />
    </div>
  );
}
