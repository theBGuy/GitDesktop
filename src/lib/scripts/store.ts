import {
  memoizedStoreLoader,
  reloadToleratingEmptyStore,
} from "@/lib/plugin-store";
import { norm } from "@/lib/repo-key";
import {
  foldTaskScopeKeys,
  TASK_SCOPE_GLOBAL,
  TASK_SCOPE_UNKNOWN,
} from "./scope";
import {
  type ArgDoc,
  EMPTY_SCRIPTS,
  isInterpreter,
  type ScriptsConfig,
  type TaskDef,
  type TaskSource,
} from "./types";

// Personal app-data — task definitions are the user's, NEVER read from repo
// content, so a cloned/malicious repo can't plant a runnable task.
const getStore = memoizedStoreLoader("scripts.json");

// Serialize every read-modify-write through one in-process queue so two
// overlapping saves can't each read the same pre-flush snapshot and drop each
// other's change (the lost-update the automations/settings stores also guard).
let opChain: Promise<unknown> = Promise.resolve();
function serialize<T>(op: () => Promise<T>): Promise<T> {
  const run = opChain.then(op, op);
  opChain = run.catch(() => undefined);
  return run;
}

/** Serialized read-modify-write against fresh disk state. The queue position is
 *  taken when this is CALLED and the whole entry — an async `mutate` included —
 *  runs to completion before the next starts, so ops commit in INVOCATION order.
 *  Per-write resolution that can block (scope folding spawns git) therefore
 *  belongs inside `mutate`: awaited before the call, a slow one would commit
 *  after a later write and overwrite it. */
function mutateConfig(
  mutate: (current: ScriptsConfig) => ScriptsConfig | Promise<ScriptsConfig>,
): Promise<void> {
  return serialize(async () => {
    const store = await getStore();
    await reloadToleratingEmptyStore(store);
    const current = normalizeScripts(await store.get<unknown>("config"));
    const next = await mutate(current);
    await store.set("config", next);
    await store.save();
  });
}

/** Type-checks a task's source, falling back to an inline body (including a
 *  legacy flat `body` from before `source` existed) when malformed. */
function normalizeSource(source: unknown, legacyBody: unknown): TaskSource {
  if (source && typeof source === "object") {
    const s = source as { kind?: unknown; path?: unknown; body?: unknown };
    if (s.kind === "file" && typeof s.path === "string" && s.path !== "") {
      return { kind: "file", path: s.path };
    }
    if (s.kind === "inline" && typeof s.body === "string") {
      return { kind: "inline", body: s.body };
    }
  }
  return {
    kind: "inline",
    body: typeof legacyBody === "string" ? legacyBody : "",
  };
}

/** Type-checks an untrusted arg-docs list, dropping malformed entries. Also the
 *  guard for AI-analyzed output before it reaches the editor. */
export function normalizeArgDocs(v: unknown): ArgDoc[] {
  if (!Array.isArray(v)) return [];
  const out: ArgDoc[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const doc = item as { arg?: unknown; description?: unknown };
    if (typeof doc.arg !== "string" || doc.arg.trim() === "") continue;
    out.push({
      arg: doc.arg,
      description: typeof doc.description === "string" ? doc.description : "",
    });
  }
  return out;
}

/** Type-checks an untrusted list of repo keys, dropping blank and non-string
 *  entries. Values stay verbatim: either key form (identity or legacy raw path)
 *  is meaningful, and only the repo itself can tell them apart. */
function normalizeRepoKeys(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((k): k is string => typeof k === "string" && k.trim() !== "");
}

/** Type-checks a task's scope. Only ABSENCE — a missing or blank value, as tasks
 *  saved before scoping existed have — may be read as "every repository"; a
 *  present-but-malformed value gets a non-global sentinel instead, which fails
 *  closed through the scope partition and the task editor can repair. A non-empty
 *  string is kept verbatim, matching repo or not. */
function normalizeScope(v: unknown): string {
  if (v === undefined) return TASK_SCOPE_GLOBAL;
  if (typeof v !== "string") return TASK_SCOPE_UNKNOWN;
  return v.trim() || TASK_SCOPE_GLOBAL;
}

/** Type-checks one untrusted task, dropping it (undefined) when unusable. */
function normalizeTask(v: unknown): TaskDef | undefined {
  if (!v || typeof v !== "object") return undefined;
  const obj = v as {
    id?: unknown;
    name?: unknown;
    description?: unknown;
    interpreter?: unknown;
    source?: unknown;
    body?: unknown;
    args?: unknown;
    argDocs?: unknown;
    confirmBeforeRun?: unknown;
    scope?: unknown;
    runConfirmedIn?: unknown;
  };
  if (typeof obj.id !== "string" || obj.id === "") return undefined;
  if (!isInterpreter(obj.interpreter)) return undefined;
  return {
    id: obj.id,
    name: typeof obj.name === "string" ? obj.name : "Untitled task",
    description: typeof obj.description === "string" ? obj.description : "",
    interpreter: obj.interpreter,
    source: normalizeSource(obj.source, obj.body),
    args: typeof obj.args === "string" ? obj.args : "",
    argDocs: normalizeArgDocs(obj.argDocs),
    // Absent (older) or non-boolean → confirm, the safe default.
    confirmBeforeRun: obj.confirmBeforeRun !== false,
    // Never widens: a scope we can't match — stale key or malformed value —
    // keeps a non-global value, so a task written for one repo can't leak into
    // another.
    scope: normalizeScope(obj.scope),
    runConfirmedIn: normalizeRepoKeys(obj.runConfirmedIn),
  };
}

/**
 * Coerces a loosely-typed (older, hand-edited, or partially corrupt) value into a
 * full ScriptsConfig, dropping malformed tasks rather than letting one bad entry
 * sink the whole load. Mirrors `normalizeAutomations`.
 */
export function normalizeScripts(saved: unknown): ScriptsConfig {
  if (!saved || typeof saved !== "object") return { ...EMPTY_SCRIPTS };
  const obj = saved as { enabled?: unknown; tasks?: unknown };
  const tasks = Array.isArray(obj.tasks)
    ? obj.tasks.map(normalizeTask).filter((t): t is TaskDef => t !== undefined)
    : [];
  // Drop duplicate ids (keep first) so list keys stay unique.
  const seen = new Set<string>();
  const deduped = tasks.filter((t) =>
    seen.has(t.id) ? false : (seen.add(t.id), true),
  );
  return {
    schemaVersion: 1,
    enabled: obj.enabled === true,
    tasks: deduped,
  };
}

export async function loadScripts(): Promise<ScriptsConfig> {
  const store = await getStore();
  return normalizeScripts(await store.get<unknown>("config"));
}

/** Flip the one-time consent to run tasks. */
export function setTasksEnabled(enabled: boolean): Promise<void> {
  return mutateConfig((c) => ({ ...c, enabled }));
}

// Both writers fold the task's scope keys INSIDE the serialized entry, so every
// persisted key lands on the worktree-stable identity when git can resolve it
// without the resolution's latency reordering the writes against each other.

export function addTask(task: TaskDef): Promise<void> {
  return mutateConfig(async (c) => ({
    ...c,
    tasks: [...c.tasks, await foldTaskScopeKeys(task)],
  }));
}

export function updateTask(task: TaskDef): Promise<void> {
  return mutateConfig(async (c) => {
    const folded = await foldTaskScopeKeys(task);
    return {
      ...c,
      tasks: c.tasks.map((t) => (t.id === folded.id ? folded : t)),
    };
  });
}

export function removeTask(id: string): Promise<void> {
  return mutateConfig((c) => ({
    ...c,
    tasks: c.tasks.filter((t) => t.id !== id),
  }));
}

/**
 * Re-home every task scope and run-confirmation key from a relocated repo onto
 * `newKey` (the resolved identity of its new location), in one serialized pass.
 * The old key can't be recomputed — `--git-common-dir` needs the vanished folder —
 * so both on-disk forms are matched, `<oldPath>/.git` (identity) and `<oldPath>`
 * verbatim, case-insensitively via {@link norm} — the shared key rule the app-data
 * migration matches with. Tasks scoped elsewhere, and global ones, pass through
 * untouched.
 */
export async function rehomeTaskScopes(
  oldPath: string,
  newKey: string,
): Promise<void> {
  const raw = norm(oldPath);
  const dotGit = `${raw}/.git`;
  const isOld = (key: string) => {
    const k = norm(key);
    return k === dotGit || k === raw;
  };
  // Read-only pre-check, so a relocate that touches no task neither rewrites
  // scripts.json nor creates it for someone who never used Tasks. A concurrent
  // writer adding a matching task between this read and the bail is the same
  // residual the relocate migration already accepts.
  const { tasks: current } = await loadScripts();
  if (!current.some((t) => isOld(t.scope) || t.runConfirmedIn.some(isOld)))
    return;
  return mutateConfig((c) => {
    let changed = false;
    const tasks = c.tasks.map((t) => {
      const scope = isOld(t.scope) ? newKey : t.scope;
      const hitConfirmed = t.runConfirmedIn.some(isOld);
      // Dedup: the repo may already be confirmed under the new key.
      const runConfirmedIn = hitConfirmed
        ? [...new Set(t.runConfirmedIn.map((k) => (isOld(k) ? newKey : k)))]
        : t.runConfirmedIn;
      if (scope === t.scope && !hitConfirmed) return t;
      changed = true;
      return { ...t, scope, runConfirmedIn };
    });
    return changed ? { ...c, tasks } : c;
  });
}
