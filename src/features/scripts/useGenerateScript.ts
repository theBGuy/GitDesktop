import { useCallback } from "react";
import { toast } from "sonner";
import { useAiStream } from "@/features/conversations/useAiStream";
import { readRepoInstructions } from "@/lib/git/api";
import { type Interpreter, INTERPRETERS } from "@/lib/scripts/types";

const INTERPRETER_LABELS: Record<string, string> = Object.fromEntries(
  INTERPRETERS.map((i) => [i.id, i.label]),
);

/** Strips a Markdown code fence (```lang … ```) the model may wrap the script in.
 *  Tolerant of a partial buffer mid-stream (closing fence not yet arrived). */
function stripFences(text: string): string {
  return text.replace(/^\s*```[^\n]*\n/, "").replace(/\n?```\s*$/, "");
}

/**
 * Generates a script body with AI from a natural-language description, streaming
 * it into the editor (`onBody` fires per delta with fences stripped). Mirrors
 * {@link useGenerateBranchName}: `useAiStream` owns the client, cancel, and
 * missing-key handling; this only shapes the prompt and cleans the result.
 */
export function useGenerateScript(repoPath: string) {
  const { generating, cancel, run } = useAiStream(repoPath);

  const generate = useCallback(
    async (opts: {
      description: string;
      interpreter: Interpreter;
      onBody: (body: string) => void;
    }) => {
      const description = opts.description.trim();
      if (!description) {
        toast.error("Describe what the script should do first.");
        return;
      }
      const label =
        INTERPRETER_LABELS[opts.interpreter] ?? opts.interpreter;

      const buffer = await run(
        async () => {
          const repoInstructions = await readRepoInstructions(repoPath);
          const system = [
            `You write ${label} scripts for a developer's Git repository.`,
            "Return ONLY the script — no explanation and no Markdown code fences.",
            `The script runs from the repository root; keep it correct and idiomatic for ${label}.`,
            repoInstructions ? `Project notes:\n${repoInstructions}` : "",
          ]
            .filter(Boolean)
            .join("\n");
          return { system, prompt: description };
        },
        { onChunk: (buf) => opts.onBody(stripFences(buf)) },
      );

      if (buffer === null) return;
      opts.onBody(stripFences(buffer));
    },
    [repoPath, run],
  );

  return { generate, cancel, generating };
}
