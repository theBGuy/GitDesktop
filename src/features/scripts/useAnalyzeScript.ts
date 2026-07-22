import { useCallback } from "react";
import { toast } from "sonner";
import { useAiStream } from "@/features/conversations/useAiStream";
import { readTextFile } from "@/lib/git/api";
import { normalizeArgDocs } from "@/lib/scripts/store";
import {
  type ArgDoc,
  INTERPRETERS,
  type Interpreter,
} from "@/lib/scripts/types";
import { stripFences } from "./useGenerateScript";

/** Prompt budget for the script content — release/build scripts are tiny; a
 *  giant file gets truncated with a note rather than blowing the context. */
const MAX_SCRIPT_CHARS = 48_000;

const INTERPRETER_LABELS: Record<string, string> = Object.fromEntries(
  INTERPRETERS.map((i) => [i.id, i.label]),
);

/** What analysis yields — every field optional-by-honesty: a field the model
 *  didn't produce (or produced malformed) stays null/empty rather than being
 *  filled with a confident guess. */
export interface ScriptAnalysis {
  name: string | null;
  description: string | null;
  argDocs: ArgDoc[];
}

/** Parses the model's answer into a {@link ScriptAnalysis}, type-guarding every
 *  field (AI output is untrusted input). Returns null when it isn't JSON at all. */
function parseAnalysis(buffer: string): ScriptAnalysis | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stripFences(buffer).trim());
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as { name?: unknown; description?: unknown; args?: unknown };
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim() !== "" ? v.trim() : null;
  return {
    name: str(obj.name),
    description: str(obj.description),
    argDocs: normalizeArgDocs(obj.args),
  };
}

/** True for an absolute path on either platform (`C:\…`, `C:/…`, or `/…`). */
function isAbsolute(p: string): boolean {
  return /^([A-Za-z]:[\\/]|\/)/.test(p);
}

/**
 * Reads a task's script (the registered file, or the inline body) and asks AI to
 * document it: a short name, a one-line description, and the arguments it
 * accepts (`--help`-style). Results land via `onResult` into the editor's draft
 * fields — nothing persists until the user saves. Mirrors the other one-shot
 * generators: `useAiStream` owns the client, cancel, and missing-key handling.
 */
export function useAnalyzeScript(repoPath: string) {
  const { generating: analyzing, cancel, run } = useAiStream(repoPath);

  const analyze = useCallback(
    async (opts: {
      interpreter: Interpreter;
      /** File source: the registered path (repo-relative or absolute). */
      path?: string;
      /** Inline source: the current body. */
      body?: string;
      onResult: (analysis: ScriptAnalysis) => void;
    }) => {
      const label = INTERPRETER_LABELS[opts.interpreter] ?? opts.interpreter;

      const buffer = await run(async () => {
        let content: string;
        let sourceLine: string;
        if (opts.path) {
          const full = isAbsolute(opts.path)
            ? opts.path
            : `${repoPath}/${opts.path}`;
          try {
            content = await readTextFile(full);
          } catch {
            toast.error(`Couldn't read ${opts.path} — does the file exist?`);
            return null;
          }
          sourceLine = `Script file: ${opts.path}`;
        } else {
          content = opts.body ?? "";
          sourceLine = "Inline script";
        }
        if (content.trim() === "") {
          toast.error("Nothing to analyze — the script is empty.");
          return null;
        }
        const truncated = content.length > MAX_SCRIPT_CHARS;
        if (truncated) content = content.slice(0, MAX_SCRIPT_CHARS);

        const system = [
          `You document developer scripts. Analyze the ${label} script and reply with ONLY a JSON object — no prose, no Markdown fences:`,
          `{"name": string, "description": string, "args": [{"arg": string, "description": string}]}`,
          `- "name": a short display name for the task (2–4 words, plain words not a filename).`,
          `- "description": ONE sentence, plain language, what running it does.`,
          `- "args": the command-line arguments/flags the script actually accepts (from its argv/flag parsing), each with a one-line description. [] when it takes none.`,
          `Only document arguments the script really reads — never invent any.`,
        ].join("\n");
        const prompt = `${sourceLine}${truncated ? " (truncated)" : ""}\n\n${content}`;
        return { system, prompt };
      });

      if (buffer === null) return;
      const analysis = parseAnalysis(buffer);
      if (analysis) opts.onResult(analysis);
      else toast.error("Couldn't analyze the script — try again.");
    },
    [repoPath, run],
  );

  return { analyze, cancel, analyzing };
}
