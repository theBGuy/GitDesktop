import { load, type Store } from "@tauri-apps/plugin-store";
import { storeName } from "@/lib/test-mode";
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
let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  storePromise ??= load(storeName("scripts.json"), {
    autoSave: true,
    defaults: {},
  });
  return storePromise;
}

// Serialize every read-modify-write through one in-process queue so two
// overlapping saves can't each read the same pre-flush snapshot and drop each
// other's change (the lost-update the automations/settings stores also guard).
let opChain: Promise<unknown> = Promise.resolve();
function serialize<T>(op: () => Promise<T>): Promise<T> {
  const run = opChain.then(op, op);
  opChain = run.catch(() => undefined);
  return run;
}

/** Re-read `scripts.json` into the store, tolerating a missing file (until the
 *  first `save()` creates it, `reload()` rejects — proceed with in-memory state). */
async function reloadRaw(store: Store): Promise<void> {
  try {
    await store.reload({ ignoreDefaults: true });
  } catch {
    // Missing/unreadable — the next save() bootstraps the file.
  }
}

/** Serialized read-modify-write against fresh disk state. */
function mutateConfig(
  mutate: (current: ScriptsConfig) => ScriptsConfig,
): Promise<void> {
  return serialize(async () => {
    const store = await getStore();
    await reloadRaw(store);
    const current = normalizeScripts(await store.get<unknown>("config"));
    const next = mutate(current);
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
    ? obj.tasks
        .map(normalizeTask)
        .filter((t): t is TaskDef => t !== undefined)
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

export function addTask(task: TaskDef): Promise<void> {
  return mutateConfig((c) => ({ ...c, tasks: [...c.tasks, task] }));
}

export function updateTask(task: TaskDef): Promise<void> {
  return mutateConfig((c) => ({
    ...c,
    tasks: c.tasks.map((t) => (t.id === task.id ? task : t)),
  }));
}

export function removeTask(id: string): Promise<void> {
  return mutateConfig((c) => ({
    ...c,
    tasks: c.tasks.filter((t) => t.id !== id),
  }));
}
