import type { RewriteStep } from "@/lib/git/types";

/**
 * The interactive-rebase vocabulary for one unpushed commit. Mirrors
 * `git rebase -i`: **pick** keeps it, **reword** changes its message, **squash**
 * folds it into the next older kept commit combining messages, **fixup** folds it
 * in keeping the leader's message, **edit** pauses there so you can amend its
 * contents, **drop** removes it.
 */
export type RowAction =
  | "pick"
  | "reword"
  | "squash"
  | "fixup"
  | "edit"
  | "drop";

export interface EditRow {
  hash: string;
  /** The commit's original subject — for display and fold hints. */
  subject: string;
  action: RowAction;
  /** The row's message — the user's edit, or the commit's full original message
   *  as the default. Used as the leader's part for a reword or a squash leader,
   *  and as a squash row's contribution; ignored for pick/fixup/drop. */
  message: string;
}

export interface RowView {
  /** Whether this row should render an editable message field. */
  showMessage: boolean;
  /** The subject of the nearest kept leader older than this row, or null when
   *  none is. Recorded for every row, so whatever a squash or fixup here would
   *  combine into reads from this one value. */
  foldTarget: string | null;
  /** That leader's hash: its identity, since two commits can share a subject. */
  foldTargetHash: string | null;
}

export interface CompiledPlan {
  /** Oldest-first steps for `git_rewrite_commits`. */
  steps: RewriteStep[];
  /** Hashes of the drop rows: the backend refuses any omission not listed. */
  dropped: string[];
  /** How many commits the rewrite produces. */
  resultCount: number;
  /** Per-row display metadata, parallel to the input rows. */
  views: RowView[];
  /** The first blocking problem, or null when the plan is valid to apply. */
  error: string | null;
  /** The hash of the row `error` is about, or null when it names no row. */
  errorHash: string | null;
  /** Whether the plan differs from the no-op (original order, all picked). */
  changed: boolean;
  /** Whether any commit is set to `edit` — routes the apply to the resumable
   *  interactive rebase instead of the atomic replay engine. */
  hasEdit: boolean;
}

/** A held fold's row label, and the move announcement's suffix for it. */
export const FOLD_HELD_LABEL = "no older kept commit to combine into";

// A leader produces its own commit; folds attach to the nearest older one.
const leads = (a: RowAction) => a === "pick" || a === "reword" || a === "edit";

/**
 * Compiles Edit-history rows (newest-first display order) into the oldest-first
 * `RewriteStep[]` the replay engine runs, plus per-row view metadata and
 * validation.
 *
 * A squash/fixup row folds into its **leader** — the nearest kept
 * pick/reword/edit row older than it. Steps are built oldest-first; a fold
 * appends its hash to the leader's step in chronological order, so the leader
 * replays first and its folds after it. A leader step's message encodes the
 * vocabulary: omitted → pick or fixup (the leader's own message); present →
 * reword or squash (the step's message).
 * Each row's `message` supplies its own part of a combined squash message —
 * including a *pick* leader that receives a squash, which therefore shows an
 * editable message too (so its contribution isn't silently baked in invisibly).
 */
export function compilePlan(
  rows: EditRow[],
  originalHashes: string[],
): CompiledPlan {
  const n = rows.length;
  const views: RowView[] = rows.map((r) => ({
    showMessage: r.action === "reword" || r.action === "squash",
    foldTarget: null,
    foldTargetHash: null,
  }));

  const steps: RewriteStep[] = [];
  const dropped: string[] = [];
  const stepByLeader = new Map<number, RewriteStep>();
  const leaderHasSquash: boolean[] = rows.map(() => false);
  let currentLeader = -1;
  let error: string | null = null;
  let errorHash: string | null = null;

  // Walk oldest→newest (display bottom-up). Leaders create a step; folds attach
  // to the nearest older leader and append their hash (chronological).
  for (let i = n - 1; i >= 0; i--) {
    const { action } = rows[i];
    // Before the drop skip and before this row can become the leader, so every
    // row records the nearest kept leader strictly older than itself.
    const leader = currentLeader === -1 ? null : rows[currentLeader];
    views[i].foldTarget = leader?.subject ?? null;
    views[i].foldTargetHash = leader?.hash ?? null;
    if (action === "drop") {
      dropped.push(rows[i].hash);
      continue;
    }
    if (leads(action)) {
      currentLeader = i;
      const step: RewriteStep = { hashes: [rows[i].hash] };
      if (action === "edit") step.edit = true;
      steps.push(step);
      stepByLeader.set(i, step);
    } else if (currentLeader === -1) {
      if (error === null) {
        errorHash = rows[i].hash;
        error = `"${rows[i].subject}" can't be ${
          action === "squash" ? "squashed" : "fixed up"
        } — no older commit in this list is kept to combine it into.`;
      }
    } else {
      stepByLeader.get(currentLeader)?.hashes.push(rows[i].hash);
      if (action === "squash") leaderHasSquash[currentLeader] = true;
    }
  }

  // A pick/edit leader that receives a squash also exposes its message — its
  // full body goes into the combined commit, so it must be visible and editable.
  for (let i = 0; i < n; i++) {
    const a = rows[i].action;
    if ((a === "pick" || a === "edit") && leaderHasSquash[i]) {
      views[i].showMessage = true;
    }
  }

  // Resolve each leader step's message from its own part + its squash folds.
  const rowByHash = new Map(rows.map((r) => [r.hash, r]));
  for (const [leaderIdx, step] of stepByLeader) {
    const leader = rows[leaderIdx];
    const reworded = leader.action === "reword";
    const hasSquash = leaderHasSquash[leaderIdx];
    // Plain pick (cherry-pick keeps the message) or pick + fixups only (engine
    // `commit -C` reuses the leader's message): leave the step message undefined.
    if (!hasSquash && !reworded) continue;
    const parts = [leader.message];
    for (const h of step.hashes.slice(1)) {
      const r = rowByHash.get(h);
      if (r?.action === "squash") parts.push(r.message);
    }
    step.message = parts
      .map((p) => p.trim())
      .filter((p) => p !== "")
      .join("\n\n");
  }

  // Validation (first blocker wins; a fold-without-leader error takes priority).
  if (!error && rows.every((r) => r.action === "drop")) {
    error = "Keep at least one commit — you can't drop them all.";
  }
  if (!error) {
    const blank = rows.find(
      (r) => r.action === "reword" && r.message.trim() === "",
    );
    if (blank) {
      error = `Rewording "${blank.subject}" needs a commit message.`;
      errorHash = blank.hash;
    }
  }

  const reordered =
    rows.length !== originalHashes.length ||
    rows.some((r, i) => r.hash !== originalHashes[i]);
  const changed = reordered || rows.some((r) => r.action !== "pick");
  const hasEdit = rows.some((r) => r.action === "edit");

  return {
    steps,
    dropped,
    resultCount: steps.length,
    views,
    error,
    errorHash,
    changed,
    hasEdit,
  };
}

/**
 * The live-region text for a move of the row at `from` (action `action`, hash
 * `hash`) to `to` of `total`, given the plans before and after it. It names the
 * landing; for a moved squash or fixup whose target commit changed, the new
 * target or that it has none; and a new footer error, unless that suffix already
 * said it. Another row's silent retarget is not announced.
 */
export function moveAnnouncement({
  prev,
  next,
  action,
  hash,
  from,
  to,
  total,
}: {
  prev: CompiledPlan;
  next: CompiledPlan;
  action: RowAction;
  hash: string;
  from: number;
  to: number;
  total: number;
}): string {
  let text = `Moved to ${to + 1} of ${total}`;
  // By hash: two leaders can share a subject.
  const retargeted =
    next.views[to].foldTargetHash !== prev.views[from].foldTargetHash;
  const spoke = (action === "squash" || action === "fixup") && retargeted;
  if (spoke) {
    const target = next.views[to].foldTarget;
    text += target === null ? `, ${FOLD_HELD_LABEL}` : `, into "${target}"`;
  }
  if (
    next.error !== null &&
    next.error !== prev.error &&
    !(spoke && next.errorHash === hash)
  ) {
    text += `. ${next.error}`;
  }
  return text;
}
