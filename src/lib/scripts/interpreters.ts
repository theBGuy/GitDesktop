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
