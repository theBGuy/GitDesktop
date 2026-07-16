import { useCallback } from "react";
import { toast } from "sonner";
import { useAiStream } from "@/features/conversations/useAiStream";
import {
  buildRepoDescriptionPrompt,
  extractRepoDetails,
} from "@/lib/ai/prompt";
import { readRepoInstructions, readTextFile } from "@/lib/git/api";

// READMEs the AI description is most usefully grounded in, in priority order.
const README_CANDIDATES = [
  "README.md",
  "Readme.md",
  "readme.md",
  "README",
  "README.rst",
  "README.txt",
  "docs/README.md",
];

async function readReadme(repoPath: string): Promise<string> {
  for (const name of README_CANDIDATES) {
    try {
      const text = await readTextFile(`${repoPath}/${name}`);
      if (text.trim()) return text;
    } catch {
      // missing/unreadable — try the next candidate
    }
  }
  return "";
}

/**
 * Suggests a GitHub "About" description + topics for the repo, grounded in its
 * README (falling back to the name alone). Mirrors useGenerateBranchName.
 */
export function useGenerateRepoDescription(repoPath: string) {
  const { generating, cancel, run } = useAiStream(repoPath);

  const generate = useCallback(
    async (opts: {
      repoName: string;
      onResult: (result: { description: string; topics: string[] }) => void;
    }) => {
      const buffer = await run(async (settings) => {
        const [readme, repoInstructions] = await Promise.all([
          readReadme(repoPath),
          readRepoInstructions(repoPath),
        ]);

        return buildRepoDescriptionPrompt({
          repoName: opts.repoName,
          readme,
          repoInstructions,
          globalInstructions: settings.globalInstructions,
        });
      });

      if (buffer === null) return;
      const details = extractRepoDetails(buffer);
      if (details.description || details.topics.length) opts.onResult(details);
      else toast.error("Couldn't generate a description — try again.");
    },
    [repoPath, run],
  );

  return { generate, cancel, generating };
}
