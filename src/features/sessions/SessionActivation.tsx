import { useEffect, useState } from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PlanComposer } from "@/features/plan/PlanView";
import { type PlanSeed, usePlanStore } from "@/features/plan/store";
import { ResearchComposer } from "@/features/research/ResearchView";
import { type ResearchSeed, useResearchStore } from "@/features/research/store";
import { SessionComposer } from "./SessionComposer";
import { useSessionsStore } from "./store";

const EXAMPLES = [
  "Add input validation to the login form",
  "Write unit tests for the date utils",
  "Refactor this file into smaller components",
];

type Mode = "delegate" | "plan" | "research";

/**
 * The new-task state of the canvas (shown when nothing is selected): a calm,
 * centered panel with three modes — "Delegate" hands a write-capable agent a job
 * in an isolated worktree; "Plan" starts a read-only plan run that drafts an
 * agent-ready issue; "Research" starts a read-only, web-enabled run that explores
 * (Brainstorm) or investigates (Deep research) and streams a cited report. Plan
 * and Research never write (no worktree); they sit upstream of Delegate.
 */
export function SessionActivation({ repoPath }: { repoPath: string }) {
  const [mode, setMode] = useState<Mode>("delegate");
  const [planSeed, setPlanSeed] = useState<PlanSeed | null>(null);
  const [researchSeed, setResearchSeed] = useState<ResearchSeed | null>(null);
  // Bumped when a seed is consumed, so the composer remounts and re-initializes
  // its fields from the new seed.
  const [seedNonce, setSeedNonce] = useState(0);

  // Repo switches don't remount this surface (RepositoryView + SessionActivation
  // both mount unkeyed), so a consumed seed's snapshot would submit repo A's
  // content under repo B. Reset in render — an effect paints A's fields first.
  const [prevRepoPath, setPrevRepoPath] = useState(repoPath);
  if (prevRepoPath !== repoPath) {
    setPrevRepoPath(repoPath);
    setPlanSeed(null);
    setResearchSeed(null);
    setSeedNonce((n) => n + 1);
  }

  const pendingTask = useSessionsStore((s) => s.pendingTask);
  const pendingPlanSeed = usePlanStore((s) => s.pendingPlanSeed);
  const setPendingPlanSeed = usePlanStore((s) => s.setPendingPlanSeed);
  const pendingResearchSeed = useResearchStore((s) => s.pendingResearchSeed);
  const setPendingResearchSeed = useResearchStore(
    (s) => s.setPendingResearchSeed,
  );

  // A handoff ("Implement this issue") seeds the Delegate composer.
  useEffect(() => {
    if (pendingTask) setMode("delegate");
  }, [pendingTask]);

  // The agent-plan hotkey, an issue's Plan button, or "Turn into a Plan" from a
  // research run switches to (and seeds) the Plan composer. Snapshot the seed
  // locally so it survives clearing the store.
  useEffect(() => {
    // A seed raised in another repo stays put, uncleared: this surface lives under
    // <Activity>, so a seed set before a repo switch reaches us in the new repo and
    // would prefill its composer with the old repo's work.
    if (!pendingPlanSeed || pendingPlanSeed.repoPath !== repoPath) return;
    setMode("plan");
    setPlanSeed(pendingPlanSeed);
    setSeedNonce((n) => n + 1);
    setPendingPlanSeed(null);
  }, [pendingPlanSeed, setPendingPlanSeed, repoPath]);

  // The agent-research hotkey switches to (and seeds) the Research composer.
  useEffect(() => {
    // Repo-gated like the plan seed above.
    if (!pendingResearchSeed || pendingResearchSeed.repoPath !== repoPath)
      return;
    setMode("research");
    setResearchSeed(pendingResearchSeed);
    setSeedNonce((n) => n + 1);
    setPendingResearchSeed(null);
  }, [pendingResearchSeed, setPendingResearchSeed, repoPath]);

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b px-3 py-2.5">
        <Tabs
          value={mode}
          onValueChange={(v) => {
            setMode(v as Mode);
            // A manual tab switch starts a blank composer (a pending seed comes
            // in via the effects above, not through user interaction).
            setPlanSeed(null);
            setResearchSeed(null);
          }}
        >
          <TabsList>
            <TabsTrigger value="delegate">Delegate a task</TabsTrigger>
            <TabsTrigger value="plan">Plan a task</TabsTrigger>
            <TabsTrigger value="research">Research</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {mode === "delegate" ? (
        // Docked like the conversation footer + VS Code: the welcome text floats
        // in the scrollable area above, the composer is pinned to the bottom edge,
        // so its toolbar never shifts as the textarea grows upward.
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto p-6 text-center">
            <div className="flex max-w-md flex-col gap-2">
              <h2 className="text-base font-medium text-balance">
                Delegate a task to an agent
              </h2>
              <p className="text-xs leading-relaxed text-muted-foreground">
                The agent runs full-auto in an isolated worktree — your working
                tree, index, and branch are never touched. Review its changes
                and keep them when you're happy. Run several at once.
              </p>
            </div>
          </div>
          <div className="shrink-0 border-t p-2">
            <SessionComposer
              repoPath={repoPath}
              session={null}
              examples={EXAMPLES}
              autoFocus
            />
          </div>
        </div>
      ) : mode === "plan" ? (
        <PlanComposer key={seedNonce} repoPath={repoPath} seed={planSeed} />
      ) : (
        <ResearchComposer
          key={seedNonce}
          repoPath={repoPath}
          seed={researchSeed}
        />
      )}
    </div>
  );
}
