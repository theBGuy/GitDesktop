import {
  headFacts,
  rowNameMismatch,
  rowPushTarget,
} from "@/features/repository/sync-controls-state";
import { upstreamBranchName } from "@/lib/git/push-tracking";
import { isSessionBranchName } from "@/lib/git/ref-name";
import type { Branch, BranchHead } from "@/lib/git/types";

// Create PR's guidance for a head the backend refused as a renamed copy of the
// differently named remote branch it still tracks (`pushUpstreamNameMismatch`).
// The backend's lead is kept as written; its remedy is swapped for the control
// this head's routing actually offers.

/** The remedy the backend's Display line ends with (error.rs; pinned by
 *  src/test/pr-ref.test.ts against the Rust literal). */
export const PUSH_MENU_REMEDY = "Choose where to push from the Push menu.";

/** Which control can publish the head under its own name. */
export type CrossNameRemedy = "pushMenu" | "rowMenu" | "terminal";

// A name a shell passes through unquoted and unexpanded; any other name gets
// prose, since a printed command would mean something else once pasted.
const SHELL_NEUTRAL_NAME = /^[A-Za-z0-9._/-]+$/;

const REMEDY_SENTENCE: Record<CrossNameRemedy, (branch: string) => string> = {
  pushMenu: () => PUSH_MENU_REMEDY,
  rowMenu: (branch) =>
    `Choose where to push it from ${branch}'s menu in the branch list.`,
  terminal: (branch) =>
    SHELL_NEUTRAL_NAME.test(branch)
      ? `Publish it under its own name first, for example with git push -u origin refs/heads/${branch}:refs/heads/${branch} in a terminal.`
      : "Publish it under its own name first, by pushing it to origin from a terminal.",
};

/** The reads the remedy is chosen from; undefined while a read is unanswered. */
export interface CrossNameRouting {
  head: BranchHead | undefined;
  branches: readonly Branch[] | undefined;
  remoteNames: readonly string[] | undefined;
}

/** The sync bar's Push menu exists only for a checked-out head git would refuse
 *  a bare push of (`deriveSyncControls`); the row's "Publish as" item only for a
 *  listed row with a different-name upstream its push isn't routed off
 *  (BranchSwitcher's `rowMismatch`). Anything unread falls to the terminal. */
export function crossNameRemedy(
  branch: string,
  r: CrossNameRouting,
): CrossNameRemedy {
  const head = r.head;
  if (
    head?.name === branch &&
    head.pushNameMismatch === true &&
    headFacts(head).hasUpstream
  )
    return "pushMenu";
  const row = r.branches?.find((b) => b.name === branch);
  if (row === undefined || isSessionBranchName(branch)) return "terminal";
  const facts = {
    ...row,
    upstreamBranch: upstreamBranchName(row.upstreamRemoteRef),
  };
  const target = rowPushTarget(facts);
  if (target.kind === "to" && !target.toUpstream) return "terminal";
  return rowNameMismatch(facts, r.remoteNames ?? []) !== null
    ? "rowMenu"
    : "terminal";
}

/** `error` with its remedy replaced when it is a pushUpstreamNameMismatch whose
 *  head has no Push menu; anything else is returned as it is. */
export function withCrossNameGuidance(
  error: unknown,
  routing: CrossNameRouting,
): unknown {
  if (typeof error !== "object" || error === null) return error;
  const e = error as Record<string, unknown>;
  if (e.kind !== "pushUpstreamNameMismatch") return error;
  const { branch, message } = e;
  if (
    typeof branch !== "string" ||
    typeof message !== "string" ||
    !message.endsWith(` ${PUSH_MENU_REMEDY}`)
  )
    return error;
  const remedy = crossNameRemedy(branch, routing);
  if (remedy === "pushMenu") return error;
  return {
    ...e,
    message: `${message.slice(0, -PUSH_MENU_REMEDY.length)}${REMEDY_SENTENCE[remedy](branch)}`,
  };
}
