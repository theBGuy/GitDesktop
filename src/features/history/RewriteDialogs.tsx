import { SparkleIcon, XIcon } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { createAiClient } from "@/lib/ai/client";
import { aiExcludePatterns } from "@/lib/ai/ignore";
import { buildCommitPrompt } from "@/lib/ai/prompt";
import { required, useAppForm } from "@/lib/form";
import {
  gitBranchDiff,
  gitRecentCommits,
  readRepoInstructions,
} from "@/lib/git/api";
import { useRewriteCommits } from "@/lib/git/queries";
import type { RewriteStep } from "@/lib/git/types";
import { useGenerateChord } from "@/lib/hotkeys/useGenerateChord";
import { loadSettings } from "@/lib/settings/api";
import { useAiEnabled } from "@/lib/settings/queries";
import { toastError } from "@/lib/toast";

/**
 * Streams an AI commit message from a `base..head` diff — the commit-box
 * generator pipeline, fed by an arbitrary commit range instead of the staged
 * diff. Used for a squashed run and, in the Edit-history editor, a reworded
 * commit (`<hash>^..<hash>`).
 */
export function useGenerateSquashMessage(
  repoPath: string,
  onText: (message: string) => void,
) {
  const [generating, setGenerating] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const cancel = () => abortRef.current?.abort();

  async function generate(base: string, head: string) {
    const abort = new AbortController();
    abortRef.current = abort;
    setGenerating(true);
    try {
      const settings = await loadSettings();
      // Only the diff depends on the ignore patterns — chain those two and let
      // the batch run them alongside the commits and instructions reads.
      const [diff, commits, repoInstructions] = await Promise.all([
        aiExcludePatterns(repoPath, settings.aiIgnorePatterns).then((exclude) =>
          gitBranchDiff(repoPath, base, head, 200_000, exclude),
        ),
        gitRecentCommits(repoPath, 10),
        readRepoInstructions(repoPath),
      ]);
      if (!diff.text.trim()) {
        toast.error(
          diff.excludedFiles > 0
            ? "These commits' changes all match your AI ignore patterns — nothing to describe."
            : "These commits have no combined changes to describe.",
        );
        return;
      }
      const { system, prompt } = buildCommitPrompt({
        diffText: diff.text,
        diffTruncated: diff.truncated,
        files: diff.files,
        excludedFiles: diff.excludedFiles,
        recentSubjects: commits.map((c) => c.subject),
        repoInstructions,
        globalInstructions: settings.globalInstructions,
      });
      const client = await createAiClient(settings.ai);
      let buffer = "";
      for await (const chunk of client.stream({
        system,
        prompt,
        abortSignal: abort.signal,
        repoPath,
      })) {
        buffer += chunk;
        onText(buffer);
      }
    } catch (e) {
      if (!abort.signal.aborted) toastError(e);
    } finally {
      setGenerating(false);
      abortRef.current = null;
    }
  }

  return { generate, cancel, generating };
}

/**
 * Confirms a squash of selected unpushed commits: edit the combined commit
 * message, then the rewrite engine replays `base..HEAD` with the run
 * collapsed into one commit. A conflict rolls it back.
 */
export function SquashDialog({
  repoPath,
  base,
  steps,
  count,
  defaultMessage,
  open,
  onOpenChange,
  onDone,
}: {
  repoPath: string;
  base: string;
  /** Oldest-first; exactly one multi-hash step takes the message. */
  steps: RewriteStep[];
  count: number;
  defaultMessage: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const rewrite = useRewriteCommits(repoPath);
  const aiEnabled = useAiEnabled();
  const ai = useGenerateSquashMessage(repoPath, (message) =>
    form.setFieldValue("message", message),
  );
  // The squash step is oldest-first, so its last hash is the run's tip;
  // diffing base..tip yields exactly the changes the new commit will hold.
  const runHead = steps.find((s) => s.hashes.length > 1)?.hashes.at(-1);
  // The generate chord writes the squashed message while this dialog is open.
  // Mounted on DialogContent so it also covers the X close button (a form
  // SIBLING inside the Popup); the swallow is unconditional so it can't reach
  // the global generate-commit-message action behind the dialog, and while
  // generating it swallows but DOESN'T cancel.
  const generateChord = useGenerateChord({
    enabled: aiEnabled && !ai.generating && Boolean(runHead),
    run: () => {
      if (runHead) ai.generate(base, runHead);
    },
  });

  const form = useAppForm({
    defaultValues: { message: defaultMessage },
    onSubmit: async ({ value }) => {
      try {
        await rewrite.mutateAsync({
          base,
          steps: steps.map((s) =>
            s.hashes.length > 1 ? { ...s, message: value.message.trim() } : s,
          ),
        });
        toast.success(`Squashed ${count} commits into one`);
        onOpenChange(false);
        onDone();
      } catch (e) {
        toastError(e);
      }
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onKeyDown={generateChord.onKeyDown}>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            form.handleSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Squash {count} commits?</DialogTitle>
            <DialogDescription>
              Combines the selected commits into one. This rewrites local
              history; a conflict rolls it back.
            </DialogDescription>
          </DialogHeader>
          <form.AppField
            name="message"
            validators={{ onChange: ({ value }) => required(value) }}
          >
            {(field) => (
              <field.TextareaField
                label="Commit message"
                rows={6}
                className="max-h-60 min-h-24 resize-y font-mono"
              />
            )}
          </form.AppField>
          <DialogFooter className="sm:items-center">
            {aiEnabled &&
              (ai.generating ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mr-auto"
                  onClick={ai.cancel}
                >
                  <XIcon data-icon="inline-start" />
                  Cancel
                </Button>
              ) : (
                // `runHead` is the collapsing step's tip, so without it there's no
                // range to diff.
                <DisabledReasonButton
                  type="button"
                  variant="outline"
                  size="sm"
                  wrapperClassName="mr-auto"
                  disabled={!runHead}
                  // The chord is only offered while it would do something — a
                  // disabled Generate's shortcut is dead too.
                  title={
                    runHead
                      ? `Generate the commit message with AI${generateChord.hint}`
                      : "Generate the commit message with AI"
                  }
                  reason="Nothing to generate from — this squash has no run of commits to combine"
                  onClick={() => runHead && ai.generate(base, runHead)}
                >
                  <SparkleIcon data-icon="inline-start" />
                  Generate
                </DisabledReasonButton>
              ))}
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <form.AppForm>
              <form.SubmitButton disabled={ai.generating}>
                Squash commits
              </form.SubmitButton>
            </form.AppForm>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
