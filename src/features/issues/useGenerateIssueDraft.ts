import { useCallback } from "react";
import { toast } from "sonner";
import { useAiStream } from "@/features/conversations/useAiStream";
import { buildIssueDraftPrompt, extractIssueDraft } from "@/lib/ai/prompt";
import { readIssueTemplates, readRepoInstructions } from "@/lib/git/api";

/**
 * Expands a user's rough notes into a structured GitHub issue (title + body),
 * following the repo's issue template(s) when present. Mirrors
 * useGenerateRepoDescription.
 */
export function useGenerateIssueDraft(repoPath: string) {
  const { generating, cancel, run } = useAiStream(repoPath);

  const generate = useCallback(
    async (opts: {
      notes: string;
      repoName: string;
      onResult: (result: { title: string; body: string }) => void;
    }) => {
      const buffer = await run(async (settings) => {
        const [templates, repoInstructions] = await Promise.all([
          readIssueTemplates(repoPath).catch(() => [] as string[]),
          readRepoInstructions(repoPath),
        ]);
        return buildIssueDraftPrompt({
          notes: opts.notes,
          templates,
          repoName: opts.repoName,
          repoInstructions,
          globalInstructions: settings.globalInstructions,
        });
      });
      if (buffer === null) return;
      const draft = extractIssueDraft(buffer);
      if (draft.body.trim()) opts.onResult(draft);
      else toast.error("Couldn't draft an issue — try again.");
    },
    [repoPath, run],
  );

  return { generate, cancel, generating };
}
