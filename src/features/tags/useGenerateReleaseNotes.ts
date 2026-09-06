import { useCallback } from "react";
import { toast } from "sonner";
import { useAiStream } from "@/features/conversations/useAiStream";
import { buildReleaseNotesPrompt } from "@/lib/ai/prompt";
import {
  ghReleaseGenerateNotes,
  gitBranchAhead,
  gitRecentCommits,
  readRepoInstructions,
} from "@/lib/git/api";

/**
 * Gathers the source material for the release notes: GitHub's auto-generated
 * changelog when available (PR titles, authors, links — so the AI can organize
 * + credit like GitHub does), otherwise the commit subjects in this range,
 * falling back to recent commits. Lives at module scope (outside the hook) so
 * its try/catch + `??` control flow doesn't bail the hook out of the React
 * Compiler.
 */
async function gatherReleaseSource(
  repoPath: string,
  opts: {
    tag: string;
    target: string;
    previousTag: string;
    isGitHub: boolean;
  },
): Promise<{ changelog: string; subjects: string[] }> {
  // Prefer GitHub's auto-generated changelog as the source. Only GitHub
  // provides this, so skip the (otherwise doomed) `gh` subprocess on other
  // providers.
  let changelog = "";
  if (opts.isGitHub) {
    try {
      const gen = await ghReleaseGenerateNotes(
        repoPath,
        opts.tag,
        opts.target,
        opts.previousTag,
      );
      changelog = gen.body ?? "";
    } catch {
      // gh unavailable / not usable here — fall back to local commits.
    }
  }

  let subjects: string[] = [];
  if (!changelog.trim()) {
    try {
      if (opts.previousTag && opts.target) {
        const ahead = await gitBranchAhead(
          repoPath,
          opts.previousTag,
          opts.target,
        );
        subjects = ahead.map((c) => c.subject);
      }
    } catch {
      // Range failed (e.g. unrelated refs) — fall back to recent commits.
    }
    if (subjects.length === 0) {
      subjects = (await gitRecentCommits(repoPath, 50)).map((c) => c.subject);
    }
  }

  return { changelog, subjects };
}

/**
 * Drafts release notes with AI from the commits in this release — those in
 * `target` since `previousTag` (the prior release), falling back to recent
 * commits. Streams into the notes field so the user previews + edits before
 * publishing. Mirrors useGenerateIssueDraft.
 */
export function useGenerateReleaseNotes(repoPath: string) {
  const { generating, cancel, run } = useAiStream(repoPath);

  const generate = useCallback(
    async (opts: {
      tag: string;
      target: string;
      previousTag: string;
      repoName: string;
      /** True when the repo's provider is GitHub — gates the `gh` auto-changelog
       *  call so a GitLab/Bitbucket generate doesn't spawn a doomed subprocess. */
      isGitHub: boolean;
      onResult: (body: string) => void;
    }) => {
      const buffer = await run(
        async (settings) => {
          const [source, repoInstructions] = await Promise.all([
            gatherReleaseSource(repoPath, opts),
            readRepoInstructions(repoPath),
          ]);
          const { changelog, subjects } = source;

          return buildReleaseNotesPrompt({
            repoName: opts.repoName,
            version: opts.tag,
            commits: subjects,
            changelog,
            repoInstructions,
            globalInstructions: settings.globalInstructions,
          });
        },
        { onChunk: (buffer) => opts.onResult(buffer) },
      );

      if (buffer !== null && !buffer.trim())
        toast.error("Couldn't generate notes — try again.");
    },
    [repoPath, run],
  );

  return { generate, cancel, generating };
}
