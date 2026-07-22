import { useQuery } from "@tanstack/react-query";
import { invoke } from "@/lib/tauri/invoke";
import type { Interpreter } from "./types";

/** One interpreter's detected availability (from the Rust `detect_interpreters`). */
export interface DetectedInterpreter {
  id: Interpreter;
  /** Resolved absolute path, or null when it isn't on PATH. */
  path: string | null;
}

const detectInterpreters = () =>
  invoke<DetectedInterpreter[]>("detect_interpreters");

/**
 * Which task interpreters are installed on this machine, keyed by id for quick
 * lookup. Session-stable-ish (a newly-installed interpreter appears within the
 * stale window), so the task editor can show what a task can actually run with.
 */
export function useDetectedInterpreters() {
  return useQuery({
    queryKey: ["detected-interpreters"],
    queryFn: async () => {
      const list = await detectInterpreters();
      return new Map(list.map((d) => [d.id, d]));
    },
    staleTime: 5 * 60 * 1000,
  });
}

const resolveTaskInterpreter = (key: Interpreter) =>
  invoke<string | null>("resolve_task_interpreter", { key });

/**
 * Full run-resolution for the SELECTED interpreter — the same resolution an actual
 * task run performs (login-shell PATH recovery on macOS/Linux), unlike the cheap
 * PATH-only {@link useDetectedInterpreters}. Enabled lazily, only when the cheap
 * pass missed the interpreter, so we never spawn a login shell we don't need: this
 * is what stops a Finder/Dock-launched macOS app (which inherits launchd's minimal
 * PATH) from warning that an nvm/fnm-managed `node` is absent when it runs fine.
 * Resolves to the absolute path, or null when even the login shell can't find it.
 */
export function useResolvedInterpreter(key: Interpreter, enabled: boolean) {
  return useQuery({
    queryKey: ["resolve-interpreter", key],
    queryFn: () => resolveTaskInterpreter(key),
    enabled,
    staleTime: 5 * 60 * 1000,
  });
}
