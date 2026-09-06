import {
  ArrowClockwiseIcon,
  CopyIcon,
  SparkleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Markdown } from "@/components/markdown/markdown";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { buildDebugPrompt, extractAgentPrompt } from "@/lib/ai/prompt";
import { PROVIDER_LABELS } from "@/lib/ai/providers";
import { useAiTextStream } from "@/lib/ai/stream";
import type { AiSettings } from "@/lib/ai/types";
import { copyText } from "@/lib/clipboard";
import { forgeJobLogs, type RunJob } from "@/lib/github/actions";
import { useSettings } from "@/lib/settings/queries";
import { toastError } from "@/lib/toast";
import { isFailureConclusion } from "./status";

/**
 * Pulls a failed job's logs and streams an AI diagnosis + fix. Uses the
 * configured Review model (Settings → AI provider → Review model); CLI agents
 * additionally read repo files for context when "repo-aware" is on.
 */
export function DebugJobDialog({
  repoPath,
  workflowName,
  job,
  open,
  onOpenChange,
}: {
  repoPath: string;
  workflowName: string;
  job: RunJob | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const settings = useSettings();
  const reviewAi = settings.data?.reviewAi;
  const { run, cancel, reset, generating, text, status } = useAiTextStream();
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [logsError, setLogsError] = useState<string | null>(null);
  // The job id we've already kicked off an analysis for, so reopening the dialog
  // resumes that run instead of restarting it.
  const startedJobId = useRef<number | null>(null);

  async function runDebug(j: RunJob, ai: AiSettings) {
    // Stop any prior run before starting a new one (e.g. switching jobs). Done
    // before the log fetch so the aborted run settles while `cancelled` is still
    // set and doesn't surface an error toast.
    cancel();
    setLogsError(null);
    reset();
    setLoadingLogs(true);
    let logs: string;
    try {
      logs = await forgeJobLogs(repoPath, j);
    } catch (e) {
      toastError(e);
      return;
    } finally {
      setLoadingLogs(false);
    }
    if (!logs.trim()) {
      setLogsError("No logs were available for this job.");
      return;
    }
    const failedSteps = j.steps
      .filter((s) => isFailureConclusion(s.conclusion))
      .map((s) => s.name);
    const { system, prompt } = buildDebugPrompt({
      workflowName,
      jobName: j.name,
      conclusion: j.conclusion,
      failedSteps,
      logs,
    });
    await run(ai, { system, prompt, repoPath });
  }

  // Kick off automatically the first time a job is selected — once per job, not
  // on every reopen. Closing the dialog does NOT cancel: this component stays
  // mounted (the parent always renders it), so the run keeps streaming while
  // hidden and reopening resumes it. Only the Cancel button stops a run.
  const start = useEffectEvent(() => {
    if (job && reviewAi) {
      startedJobId.current = job.id;
      void runDebug(job, reviewAi);
    }
  });
  useEffect(() => {
    if (job && job.id !== startedJobId.current) start();
  }, [job]);

  const busy = loadingLogs || generating;
  const agentPrompt = extractAgentPrompt(text);
  const model = reviewAi?.model || "default model";
  const providerLabel = reviewAi
    ? PROVIDER_LABELS[reviewAi.provider]
    : "the review model";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] flex-col sm:max-w-2xl">
        {job && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <SparkleIcon className="size-4 text-primary" />
                Debug “{job.name}” with AI
              </DialogTitle>
              <DialogDescription>
                {workflowName} · analyzed with {providerLabel} ({model}). The
                result stays local unless you act on it.
              </DialogDescription>
            </DialogHeader>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {logsError ? (
                <p className="text-xs text-muted-foreground">{logsError}</p>
              ) : text.trim() ? (
                <Markdown>{text}</Markdown>
              ) : busy ? (
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Spinner className="size-3" />
                  {loadingLogs
                    ? "Reading job logs…"
                    : status || "Analyzing the failure…"}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {reviewAi
                    ? "Click Analyze to diagnose this failure."
                    : "Configure a review model in Settings → AI provider to debug with AI."}
                </p>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2 border-t pt-3">
              {generating ? (
                <Button variant="outline" size="sm" onClick={cancel}>
                  <XIcon data-icon="inline-start" />
                  Cancel
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || !reviewAi}
                  onClick={() => reviewAi && runDebug(job, reviewAi)}
                >
                  <ArrowClockwiseIcon data-icon="inline-start" />
                  {text.trim() || logsError ? "Re-run" : "Analyze"}
                </Button>
              )}
              {agentPrompt && !generating && (
                <Button
                  size="sm"
                  onClick={() =>
                    copyText(
                      agentPrompt,
                      "Fix prompt copied — paste it to your agent",
                    )
                  }
                >
                  <SparkleIcon data-icon="inline-start" />
                  Copy fix prompt
                </Button>
              )}
              {text.trim() && !generating && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => copyText(text, "Diagnosis copied")}
                >
                  <CopyIcon data-icon="inline-start" />
                  Copy all
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto"
                onClick={() => onOpenChange(false)}
              >
                Close
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
