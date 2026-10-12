import { WrenchIcon } from "@phosphor-icons/react";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { buildSolveIssuePrompt } from "@/lib/ai/prompt";
import { useAiEnabled } from "@/lib/settings/queries";
import { handoffToAgent } from "./handoff";

/**
 * "Solve with agent" action for an issue: hands the issue to a new write-capable
 * agent session to investigate and resolve it. Distinct from a plan's "Implement
 * now" — an issue is a problem to diagnose and fix, not a vetted spec — so it gets
 * a solve/debug framing (see {@link buildSolveIssuePrompt}). It doesn't spend
 * tokens immediately: it seeds the "Delegate a task" composer (the human gate)
 * where the user picks the agent/model/effort and confirms. AI-gated.
 */
export function SolveIssueButton({
  repoPath,
  title,
  body,
  disabledReason,
}: {
  repoPath: string;
  title: string;
  body: string;
  /** Set while `title`/`body` can't seed a session yet (the issue is still
   *  loading): the button stays in place, disabled, with this as its reason. */
  disabledReason?: string;
}) {
  const aiEnabled = useAiEnabled();
  if (!aiEnabled) return null;

  return (
    <DisabledReasonButton
      variant="outline"
      size="xs"
      disabled={!!disabledReason}
      reason={disabledReason}
      title="Hand this issue to a write-capable agent to investigate and fix"
      onClick={() =>
        handoffToAgent(repoPath, buildSolveIssuePrompt({ title, body }))
      }
    >
      <WrenchIcon data-icon="inline-start" />
      Solve with agent
    </DisabledReasonButton>
  );
}
