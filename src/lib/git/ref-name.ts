/**
 * GitHub Desktop-style ref-name handling: instead of rejecting names with
 * spaces, sanitize them (spaces → dashes) and tell the user what will be
 * created.
 */
export function sanitizeRefName(raw: string): string {
  return raw.trim().replace(/\s+/g, "-");
}

/** The namespace reserved for agent-session branches. */
export const SESSION_BRANCH_PREFIX = "gd/session/";

/** Whether `name` falls in the agent-session namespace, in any case: a
 *  case-insensitive filesystem can land `GD/Session/x` inside `gd/session/`. */
export function isSessionBranchName(name: string): boolean {
  return name.toLowerCase().startsWith(SESSION_BRANCH_PREFIX);
}

/** Warning line for ref-name fields; null when the name is used as typed. */
export function refNameWarning(value: string): string | null {
  const sanitized = sanitizeRefName(value);
  if (!sanitized || sanitized === value.trim()) return null;
  return `Will be created as ${sanitized}`;
}
