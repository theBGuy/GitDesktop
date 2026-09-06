import { SparkleIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { clearAgentSelection } from "@/features/sessions/agentSelect";
import { useAiEnabled } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { usePlanStore } from "./store";

/**
 * "Plan" action for an issue detail view: opens the read-only plan composer in
 * the Agent surface, seeded with this issue, so a Tier-2 agent can explore the
 * repo and enrich it into an agent-ready spec. AI-gated (hidden when AI is off).
 */
export function PlanIssueButton({
  title,
  body,
}: {
  title: string;
  body: string;
}) {
  const aiEnabled = useAiEnabled();
  const setPendingPlanSeed = usePlanStore((s) => s.setPendingPlanSeed);
  const setRepoTab = useUiStore((s) => s.setRepoTab);
  if (!aiEnabled) return null;

  return (
    <Button
      variant="outline"
      size="xs"
      title="Plan an implementation for this issue with a read-only agent"
      onClick={() => {
        // The seed is keyed to the repo it was raised in, so read the live one
        // rather than take it as a prop (this button renders deep inside issue
        // views). No repo open = no Agent surface to seed.
        const repoPath = useUiStore.getState().repoPath;
        if (!repoPath) return;
        // Show the activation Plan composer, seeded from this issue.
        clearAgentSelection();
        setPendingPlanSeed({ repoPath, issueTitle: title, issueBody: body });
        setRepoTab("agent");
      }}
    >
      <SparkleIcon data-icon="inline-start" />
      Plan
    </Button>
  );
}
