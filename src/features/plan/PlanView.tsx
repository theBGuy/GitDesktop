import {
  ArrowClockwiseIcon,
  ArrowLeftIcon,
  SparkleIcon,
  StopIcon,
  TrashIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { AgentNarration } from "@/features/sessions/AgentNarration";
import {
  AgentPicker,
  ComposerOptions,
  ModelPicker,
  modelsForAgent,
} from "@/features/sessions/AgentPickers";
import { AgentTranscript } from "@/features/sessions/AgentTranscript";
import { selectSession } from "@/features/sessions/agentSelect";
import { useSessionsStore } from "@/features/sessions/store";
import { type AgentKind, defaultAgentKind } from "@/lib/ai/agent";
import { formatUsd } from "@/lib/ai/cost";
import { extractPlanQuestions } from "@/lib/ai/prompt";
import { forgeFeatureReady, useForgeStatus } from "@/lib/git/queries";
import { formatBinding } from "@/lib/hotkeys/binding";
import { useSettings } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { CreateLocalIssueDialog } from "../issues/CreateLocalIssueDialog";
import { ImplementPlanButton } from "./ImplementPlanButton";
import { PlanQuestions } from "./PlanQuestions";
import {
  type PlanRun,
  type PlanSeed,
  useActivePlanRun,
  usePlanStore,
} from "./store";

/**
 * The read-only planning canvas — peer of the session canvas in the agent
 * surface. Shows the *selected* plan run's streamed result + a human gate to
 * file it as a local or GitHub issue, refine it, or implement it. Several plan
 * runs can be open at once (the composer that starts them lives in the activation
 * surface); this renders whichever is selected.
 */
export function PlanView({ repoPath }: { repoPath: string }) {
  const run = useActivePlanRun();
  // SessionView only routes here when a plan for this repo is selected.
  if (!run) return null;
  return (
    <div className="flex h-full flex-col">
      <PlanHeader run={run} />
      <PlanResult run={run} repoPath={repoPath} />
    </div>
  );
}

/** The plan canvas header: what's being planned, plus Back (deselect, keep the
 *  run) and Dismiss (drop it). */
function PlanHeader({ run }: { run: PlanRun }) {
  const setActivePlan = usePlanStore((s) => s.setActivePlan);
  const remove = usePlanStore((s) => s.remove);
  const label =
    run.origin?.issueTitle?.trim() || run.origin?.goal?.trim() || "Plan";
  return (
    <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2.5">
      <SparkleIcon className="size-4 shrink-0 text-primary" />
      <span
        className="min-w-0 flex-1 truncate text-sm font-medium"
        title={label}
      >
        {label}
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="shrink-0 gap-1.5 text-muted-foreground"
        onClick={() => setActivePlan(null)}
        title="Back to the agent surface (keeps this plan)"
      >
        <ArrowLeftIcon className="size-3.5" />
        Back
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        className="shrink-0 text-muted-foreground"
        aria-label="Dismiss this plan"
        title="Dismiss this plan"
        onClick={() => remove(run.id)}
      >
        <TrashIcon className="size-4" />
      </Button>
    </div>
  );
}

/**
 * The new-plan composer (lives in the activation surface, beside "Delegate a
 * task"). Submitting starts a keyed plan run and selects it. `seed` prefills it
 * from an issue's Plan button or a "Re-plan".
 */
export function PlanComposer({
  repoPath,
  seed,
}: {
  repoPath: string;
  seed: PlanSeed | null;
}) {
  const start = usePlanStore((s) => s.start);
  const settings = useSettings();
  const [goal, setGoal] = useState(seed?.goal ?? "");
  // An explicit pick; null = follow the Settings default. Derived during render
  // — no effect — so settings arriving late can't clobber a pick.
  const [agentPick, setAgentPick] = useState<AgentKind | null>(null);
  const agent: AgentKind = agentPick ?? defaultAgentKind(settings.data);
  const [model, setModel] = useState("");
  // The agent `model` was chosen for; null = nothing chosen yet. Any model id is
  // accepted, so list membership can't decide whether one still fits the agent.
  const [modelAgent, setModelAgent] = useState<AgentKind | null>(null);
  const [effort, setEffort] = useState("");
  // A model belongs to the agent it was chosen for; "" = the account default.
  // Derived, so a default-agent change drops a model that agent wasn't given.
  const modelForAgent = modelAgent === agent ? model : "";

  const planningIssue = Boolean(seed?.issueTitle || seed?.issueBody);
  const canPlan = goal.trim().length > 0 || planningIssue;

  const submit = () => {
    if (!canPlan) return;
    start({
      repoPath,
      goal,
      issueTitle: seed?.issueTitle,
      issueBody: seed?.issueBody,
      originResearchId: seed?.originResearchId,
      contextPack: seed?.contextPack,
      agent,
      model: modelForAgent,
      effort,
    });
  };

  return (
    // Docked like the Delegate panel: intro floats above, the composer is pinned
    // to the bottom edge so its toolbar holds steady as the textarea grows.
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto p-6 text-center">
        <div className="flex max-w-md flex-col gap-2">
          <h2 className="text-base font-medium text-balance">
            Plan a task, grounded in your code
          </h2>
          <p className="text-xs leading-relaxed text-muted-foreground">
            A read-only agent explores the repo and drafts an agent-ready issue
            — problem, approach, affected files, acceptance criteria, and a
            verify plan. Nothing is changed; review it, then file it as an
            issue. Start several — they run side by side.
          </p>
        </div>
        {planningIssue && (
          <div className="mt-4 w-full max-w-xl border border-primary/30 bg-muted/40 px-3 py-2 text-left text-xs">
            <p className="text-muted-foreground">Planning this issue:</p>
            <p className="mt-0.5 font-medium">{seed?.issueTitle}</p>
          </div>
        )}
      </div>

      <div className="shrink-0 border-t p-2">
        <div className="flex flex-col gap-2 border border-input bg-transparent p-3 transition-colors focus-within:border-ring focus-within:ring-1 focus-within:ring-ring/50 dark:bg-input/30">
          <textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            autoFocus
            rows={3}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={
              planningIssue
                ? "Optional: extra guidance for the plan…"
                : "Describe the task to plan (e.g. “add rate limiting to the API client”)…"
            }
            aria-label="Describe a task to plan"
            className="max-h-48 min-h-16 w-full resize-none bg-transparent text-xs leading-relaxed outline-none placeholder:text-muted-foreground"
          />
          <div className="flex items-center gap-2 border-t pt-2">
            <AgentPicker
              value={agent}
              onChange={(a) => {
                setAgentPick(a);
                setModel("");
                setModelAgent(null);
              }}
            />
            <ModelPicker
              value={modelForAgent}
              onChange={(m) => {
                setModel(m);
                setModelAgent(agent);
              }}
              models={modelsForAgent(agent)}
            />
            <ComposerOptions effort={effort} onEffort={setEffort} />
            <div className="ml-auto flex items-center gap-2">
              <span className="hidden truncate text-[11px] text-muted-foreground sm:inline">
                {formatBinding("mod+enter")} to plan
              </span>
              <Button
                size="sm"
                className="min-w-20"
                disabled={!canPlan}
                onClick={submit}
              >
                Plan
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function PlanResult({ run, repoPath }: { run: PlanRun; repoPath: string }) {
  const refine = usePlanStore((s) => s.refine);
  const remove = usePlanStore((s) => s.remove);
  const cancel = usePlanStore((s) => s.cancel);
  const restart = usePlanStore((s) => s.restart);
  const setPendingPlanSeed = usePlanStore((s) => s.setPendingPlanSeed);

  const setPendingIssueDraft = useUiStore((s) => s.setPendingIssueDraft);
  const setRepoTab = useUiStore((s) => s.setRepoTab);
  const gh = useForgeStatus(repoPath);
  // The remote-issue handoff follows the per-action create flag (GitHub + GitLab).
  const ghReady = forgeFeatureReady(gh.data, "issueCreate");
  const remoteLabel = gh.data?.provider === "gitlab" ? "GitLab" : "GitHub";
  const [localOpen, setLocalOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const { generating, stopped, text, status, draft, costUsd, error } = run;

  // Once a session is implementing this plan, the plan becomes a read-only
  // reference (editing it would drift from what the session is building). Locked
  // while that session exists; if it's later discarded, the plan is editable again.
  const implementSession = useSessionsStore((s) =>
    run.implementedSessionId
      ? s.sessions.find((x) => x.id === run.implementedSessionId)
      : undefined,
  );
  const locked = Boolean(implementSession);
  const keptImpl = implementSession?.kept ?? false;
  const goToSession = () => {
    if (implementSession) selectSession(implementSession.id);
  };

  // Questions the plan left open ([NEEDS CLARIFICATION: …]), with the candidate
  // answers it suggested — the human gate answers these to refine the spec.
  const questions = useMemo(
    () => (draft ? extractPlanQuestions(draft.body) : []),
    [draft],
  );

  // When a plan lands with open questions, scroll its body to the end so the
  // answer panel comes into view — the user needs to act on them, not hunt.
  useEffect(() => {
    if (draft && questions.length > 0) {
      scrollRef.current?.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
  }, [draft, questions.length]);

  const createGithub = () => {
    if (!draft) return;
    setPendingIssueDraft({ title: draft.title, body: draft.body });
    setRepoTab("issues");
  };

  // Reopen the composer seeded from this plan to tweak the goal and try again —
  // dropping this result (the new attempt is its own run).
  const replan = () => {
    setPendingPlanSeed(run.seed ?? { goal: run.origin?.goal ?? "" });
    remove(run.id);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {(generating || status || stopped) && (
        <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2 text-[11px] text-muted-foreground">
          {generating && (
            <span className="inline-block size-1.5 animate-pulse rounded-full bg-primary" />
          )}
          <span className="truncate">
            {status ||
              (generating
                ? "Exploring the repository…"
                : stopped
                  ? "Stopped"
                  : "")}
          </span>
          {generating ? (
            <Button
              size="sm"
              variant="outline"
              className="ml-auto"
              onClick={() => cancel(run.id)}
            >
              <StopIcon weight="fill" />
              Stop
            </Button>
          ) : stopped ? (
            <Button
              size="sm"
              variant="outline"
              className="ml-auto"
              onClick={() => restart(run.id)}
            >
              <ArrowClockwiseIcon className="size-3.5" />
              Restart
            </Button>
          ) : null}
        </div>
      )}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <div className="flex flex-col gap-3">
          {error ? (
            <div className="flex items-start gap-2 text-xs text-destructive">
              <WarningIcon className="mt-0.5 size-4 shrink-0" />
              <span>{error}</span>
            </div>
          ) : run.segments?.length ? (
            <AgentTranscript segments={run.segments} baseDir={repoPath} />
          ) : text ? (
            // Reloaded plan (segments are in-memory) — render the saved prose.
            <div className="text-xs leading-relaxed">
              <AgentNarration text={text} baseDir={repoPath} />
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Starting…</p>
          )}
        </div>
        {!generating && !locked && questions.length > 0 && (
          <PlanQuestions
            key={questions.map((q) => q.question).join("|")}
            questions={questions}
            generating={generating}
            onRefine={(d) => refine(run.id, d)}
          />
        )}
      </div>

      {(draft || error) && (
        <div className="shrink-0 border-t">
          {draft && !locked && draft.unverified.length > 0 && (
            <div className="flex items-start gap-2 border-b bg-warning/10 px-3 py-2 text-[11px] text-warning">
              <WarningIcon className="mt-0.5 size-3.5 shrink-0" />
              <span>
                {draft.unverified.length} cited path
                {draft.unverified.length === 1 ? "" : "s"} couldn't be matched
                to a real file — double-check before filing:{" "}
                <span className="font-mono">{draft.unverified.join(", ")}</span>
              </span>
            </div>
          )}
          {locked ? (
            <div className="flex items-center gap-2 px-3 py-2.5">
              <span className="min-w-0 text-[11px] text-muted-foreground">
                {keptImpl
                  ? "Implemented and kept."
                  : "Being implemented by a session."}{" "}
                Read-only.
              </span>
              {draft && (
                <div className="ml-auto flex shrink-0 items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setLocalOpen(true)}
                  >
                    Create local issue
                  </Button>
                  <Button size="sm" onClick={goToSession}>
                    View session
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2 px-3 py-2.5">
              <Button variant="outline" size="sm" onClick={replan}>
                Re-plan
              </Button>
              {costUsd != null && (
                <span
                  className="text-[11px] text-muted-foreground tabular-nums"
                  title="Estimated cost of this planning run"
                >
                  {formatUsd(costUsd)}
                </span>
              )}
              {draft && (
                <div className="ml-auto flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setLocalOpen(true)}
                  >
                    Create local issue
                  </Button>
                  {ghReady && (
                    <Button variant="outline" size="sm" onClick={createGithub}>
                      Create {remoteLabel} issue
                    </Button>
                  )}
                  <ImplementPlanButton run={run} />
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {draft && !locked && (
        <div className="shrink-0 border-t p-2">
          <PlanFollowUp run={run} />
        </div>
      )}

      <CreateLocalIssueDialog
        repoPath={repoPath}
        open={localOpen}
        onOpenChange={setLocalOpen}
        initialDraft={
          draft ? { title: draft.title, body: draft.body } : undefined
        }
      />
    </div>
  );
}

/**
 * The plan's follow-up composer — a chat input pinned below the result so you can
 * keep refining after the questions are answered (or accepted). Each message
 * resumes the conversation, so the agent revises the plan with full context.
 * Styled to match the session (Delegate) composer.
 */
function PlanFollowUp({ run }: { run: PlanRun }) {
  const sendFollowUp = usePlanStore((s) => s.sendFollowUp);
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    if (!text.trim() || run.generating) return;
    sendFollowUp(run.id, text);
    setText("");
  };

  // Auto-grow the textarea with its content (JS, not CSS field-sizing, for webview
  // portability — see SessionComposer).
  // biome-ignore lint/correctness/useExhaustiveDependencies: resize on text change
  useLayoutEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
  }, [text]);

  return (
    <div className="flex flex-col gap-2 border border-input bg-transparent p-3 transition-colors focus-within:border-ring focus-within:ring-1 focus-within:ring-ring/50 dark:bg-input/30">
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        rows={1}
        disabled={run.generating}
        placeholder="Refine the plan, or ask for a change…"
        aria-label="Refine the plan"
        className="max-h-32 min-h-9 w-full resize-none overflow-y-auto bg-transparent text-xs leading-relaxed outline-none placeholder:text-muted-foreground disabled:opacity-60"
      />
      <div className="flex items-center gap-2 border-t pt-2">
        <span className="hidden truncate text-[11px] text-muted-foreground sm:inline">
          ↵ send · ⇧↵ newline
        </span>
        <Button
          size="sm"
          className="ml-auto min-w-16"
          disabled={!text.trim() || run.generating}
          onClick={submit}
        >
          Send
        </Button>
      </div>
    </div>
  );
}
