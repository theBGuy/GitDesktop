import { useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import type { PullDecision, PullWouldDrop } from "@/lib/git/api";
import { useRetained } from "@/lib/use-retained";

/** "1 commit" / "3 commits". */
function commitCount(n: number): string {
  return `${n} commit${n === 1 ? "" : "s"}`;
}

/** Everything an answer says: the verb on its button, the sentence explaining
 *  what that verb does, and the description its success toast carries. TOTAL on
 *  purpose (FORCE_PUSH_DEGRADED's idiom) — a third decision has to fail the
 *  typecheck here rather than ship a face with no copy. The verbs carry the
 *  meaning on their own, so nothing rests on the destructive styling. */
export const PULL_DECISION_COPY: Record<
  PullDecision,
  {
    action: string;
    explain: (upstream: string) => string;
    outcome: (count: number) => string;
  }
> = {
  keep: {
    action: "Keep my commits",
    explain: (upstream) =>
      `Replays them on top of ${upstream}, so they stay on the branch under new commit ids.`,
    outcome: (count) => `kept ${commitCount(count)}`,
  },
  drop: {
    action: "Drop them",
    explain: (upstream) =>
      `Rebases past them, so the branch continues from ${upstream} without them.`,
    outcome: (count) =>
      `dropped ${commitCount(count)}, recorded in Operation history`,
  },
};

/** Keep leads: it is the safe answer and the focused default. */
const DECISION_ORDER = ["keep", "drop"] as const;

/**
 * The keep-or-drop question a rebase pull raises when the upstream was rewritten
 * out from under commits that are still on the branch. Open when `refusal` is
 * the guard's payload (null = closed). Presentational — the guard hook owns the
 * decided mutation and the SHAs, so this can only ever ask about the commits it
 * is showing.
 */
export function PullRebaseDropDialog({
  refusal,
  busy,
  running,
  onCancel,
  onDecide,
}: {
  refusal: PullWouldDrop | null;
  busy: boolean;
  /** Which answer is in flight, for the spinner. Null while idle. */
  running: PullDecision | null;
  onCancel: () => void;
  onDecide: (decision: PullDecision) => void;
}) {
  const shown = useRetained(refusal);
  const keepRef = useRef<HTMLButtonElement | null>(null);
  const count = shown?.commits.length ?? 0;
  return (
    <Dialog
      open={refusal !== null}
      // Close requests are ignored while the rebase runs: the answer is already
      // acting on the branch, and this dialog still owes the user its outcome.
      onOpenChange={(next) => {
        if (!next && !busy) onCancel();
      }}
    >
      <DialogContent
        className="flex max-h-[85vh] flex-col"
        // The corner X would be dead while the guard above swallows every close
        // path, so it goes away for the duration.
        showCloseButton={!busy}
        initialFocus={keepRef}
      >
        <DialogHeader>
          <DialogTitle>Keep or drop these commits?</DialogTitle>
          <DialogDescription>
            {shown?.upstream} was rewritten — {commitCount(count)} on your
            branch {count === 1 ? "is" : "are"} no longer part of it.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
          {/* Every commit, never a preview: the surrounding copy promises to
              name them, and the list scrolls rather than truncating. */}
          <ul
            aria-label={`${commitCount(count)} at risk`}
            className="max-h-40 space-y-1 overflow-y-auto rounded-md border bg-muted/30 p-2"
          >
            {shown?.commits.map((c) => (
              <li key={c.sha} className="flex gap-2 text-xs">
                <span className="shrink-0 font-mono text-muted-foreground">
                  {c.sha.slice(0, 7)}
                </span>
                <span className="min-w-0 truncate" title={c.subject}>
                  {c.subject}
                </span>
              </li>
            ))}
          </ul>

          <dl className="space-y-1.5 text-xs">
            {DECISION_ORDER.map((decision) => (
              <div key={decision} className="flex gap-2">
                <dt className="w-32 shrink-0 font-medium">
                  {PULL_DECISION_COPY[decision].action}
                </dt>
                <dd className="min-w-0 text-muted-foreground">
                  {PULL_DECISION_COPY[decision].explain(shown?.upstream ?? "")}
                </dd>
              </div>
            ))}
          </dl>
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() => onDecide("drop")}
          >
            {running === "drop" && <Spinner data-icon="inline-start" />}
            {PULL_DECISION_COPY.drop.action}
          </Button>
          <Button
            ref={keepRef}
            disabled={busy}
            onClick={() => onDecide("keep")}
          >
            {running === "keep" && <Spinner data-icon="inline-start" />}
            {PULL_DECISION_COPY.keep.action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
