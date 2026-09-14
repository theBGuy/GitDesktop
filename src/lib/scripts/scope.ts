import { repoIdentity } from "@/lib/git/repo-identity";
import type { TaskDef } from "./types";

// Task scoping deliberately mirrors the MCP server scope helpers rather than
// importing them: scripts stay decoupled from the settings store, and the two
// registries are free to diverge.

/** The sentinel scope meaning "offered in every repository". */
export const TASK_SCOPE_GLOBAL = "global";

/** The sentinel a malformed stored scope normalizes to. Non-global, so it
 *  partitions closed through the helpers below and matches no repo until the
 *  user re-scopes the task. */
export const TASK_SCOPE_UNKNOWN = "unknown";

/** A task's effective scope ("global" when unset, for back-compat with tasks
 *  saved before scoping existed). */
export function taskScope(task: TaskDef): string {
  const s = task.scope.trim();
  return s ? s : TASK_SCOPE_GLOBAL;
}

/** Whether a task is offered in the repo named by `repoKeys` (its identity and
 *  raw checkout path, as built by `useTaskRepoKeys`): global tasks always are, a
 *  repo-scoped task only when its scope matches one of those keys. An
 *  unrecognized scope matches nothing — it never widens to global. */
export function taskInScope(
  task: TaskDef,
  repoKeys: readonly string[],
): boolean {
  const scope = taskScope(task);
  return scope === TASK_SCOPE_GLOBAL || repoKeys.includes(scope);
}

/** Whether a task belongs to some OTHER repo — the complement of
 *  {@link taskInScope}, which panels use to bucket tasks they still list. */
export function taskScopedElsewhere(
  task: TaskDef,
  repoKeys: readonly string[],
): boolean {
  return !taskInScope(task, repoKeys);
}

/** A key already in identity form (`<repo>/.git`): canonical, so folding spawns no
 *  git for it. A raw checkout path literally ending in `.git` therefore never
 *  folds — harmless, because reads match both key forms. Case-insensitive, and
 *  {@link scopeRepoLabel} strips by the same pattern so a key that counts as
 *  canonical can't still show its `.git` segment in the label. */
const CANONICAL_KEY_RE = /[\\/]\.git[\\/]?$/i;

/** A scope key rendered for humans: the repo folder's name. Strips a trailing
 *  `.git` common-dir segment (the identity key is `<repo>/.git`) so the label
 *  shows the repo, not a bare `.git`, then takes the last path segment; a raw
 *  legacy path yields its own last segment. Display only — the stored value is
 *  never altered. */
export function scopeRepoLabel(scope: string): string {
  const path = scope.replace(CANONICAL_KEY_RE, "");
  return path.split(/[/\\]/).filter(Boolean).at(-1) ?? path;
}

/** Whether this task's first run was already confirmed in the repo named by
 *  `repoKeys` (either key form counts — a confirmation stored under the legacy
 *  raw path still holds). */
export function isRunConfirmedIn(
  task: TaskDef,
  repoKeys: readonly string[],
): boolean {
  return task.runConfirmedIn.some((key) => repoKeys.includes(key));
}

/** Fold a written task's LEGACY raw-path scope and confirmation keys onto the
 *  repo's worktree-stable identity, so a value set from one checkout is honored
 *  from a sibling worktree. Call at write time on the single task being written —
 *  never a global sweep, so untouched legacy entries stay harmless (reads already
 *  match both forms). Resolution failures keep the original key rather than
 *  throwing: a half-folded task is still a correct one. */
export async function foldTaskScopeKeys(task: TaskDef): Promise<TaskDef> {
  let next = task;

  const scope = task.scope.trim();
  if (scope && scope !== TASK_SCOPE_GLOBAL && !CANONICAL_KEY_RE.test(scope)) {
    const id = await repoIdentity(scope).catch(() => scope);
    if (id !== scope) next = { ...next, scope: id };
  }

  const confirmed = task.runConfirmedIn;
  if (confirmed.length > 0) {
    const ids = await Promise.all(
      confirmed.map((key) =>
        CANONICAL_KEY_RE.test(key) ? key : repoIdentity(key).catch(() => key),
      ),
    );
    // Dedup on the identity: a legacy raw form and an already-folded twin of the
    // same repo resolve to one key, so the folded entry absorbs the legacy one.
    next = { ...next, runConfirmedIn: [...new Set(ids)] };
  }

  return next;
}
