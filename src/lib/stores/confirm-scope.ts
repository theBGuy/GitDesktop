/**
 * Which repository a confirm prompt belongs to, and the notice it leaves when a
 * repository switch or close cancels it. Import-free: `scripts/confirm-scope.test.mjs`
 * loads it under Node's type stripping, so the path normalizer arrives as a
 * parameter rather than an import.
 */

/** `"repo"` (the default) ties a prompt to the repository open when it was asked;
 *  `"app"` is for prompts that act outside it (quit, recents, settings). */
export type ConfirmScope = "repo" | "app";

/** The repository a prompt is stamped with, or `null` for an unscoped one.
 *  Stamping the closed state (no repository open) would read every later open
 *  as a switch, so a repo-scoped ask then returns `null` (unscoped). */
export function confirmStamp(
  scope: ConfirmScope | undefined,
  live: string | null,
): string | null {
  return (scope ?? "repo") === "repo" ? live : null;
}

/** Whether a prompt stamped `stamp` cancels now that `live` is the open repository
 *  (`null` = closed). Compared through `norm`, so another spelling of the same
 *  root is not a switch. */
export function cancelsOnRepoChange(
  stamp: string | null,
  live: string | null,
  norm: (p: string) => string,
): boolean {
  if (stamp === null) return false;
  return live === null || norm(live) !== norm(stamp);
}

/** The toast for a cancelled prompt, led by its title turned into a "Didn't …"
 *  clause ("Close pull request #12?" → "Didn't close pull request #12"). `away`
 *  and `closed` come from ONE `landedIn(stamp)` read. A title that isn't plain
 *  text (or is empty) falls back to a generic lead. */
export function cancelledConfirmNotice(
  title: unknown,
  away: string,
  closed: boolean,
): string {
  const action =
    typeof title === "string" ? title.trim().replace(/\?$/, "").trim() : "";
  const lead =
    action === ""
      ? "Didn't finish that action"
      : `Didn't ${action.charAt(0).toLowerCase()}${action.slice(1)}`;
  const tail = closed
    ? "you closed the repository"
    : "you switched repositories while the dialog was open";
  return `${lead}${away} — ${tail}.`;
}
