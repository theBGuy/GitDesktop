import {
  ArrowClockwiseIcon,
  ArrowLeftIcon,
  BinocularsIcon,
  CopyIcon,
  FloppyDiskIcon,
  StopIcon,
  TrashIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/ui/markdown";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usePlanStore } from "@/features/plan/store";
import {
  AgentPicker,
  ComposerOptions,
  ModelPicker,
  modelsForAgent,
} from "@/features/sessions/AgentPickers";
import { AgentTranscript } from "@/features/sessions/AgentTranscript";
import {
  agentSelectionUnchanged,
  captureAgentSelection,
  clearAgentSelection,
} from "@/features/sessions/agentSelect";
import { type AgentKind, defaultAgentKind } from "@/lib/ai/agent";
import { formatUsd } from "@/lib/ai/cost";
import { copyText } from "@/lib/clipboard";
import { formatBinding } from "@/lib/hotkeys/binding";
import { useSettings } from "@/lib/settings/queries";
import { toastError } from "@/lib/toast";
import {
  assembleSessionReport,
  type ResearchDepth,
  type ResearchHistoryTurn,
  type ResearchRun,
  type ResearchSeed,
  researchRunContextPack,
  useActiveResearchRun,
  useResearchStore,
} from "./store";

/** Labels for the research intent — the Select's trigger and popup and the
 *  switched-to notice all read this one map, so they can never drift. */
const INTENT_LABEL: Record<ResearchDepth, string> = {
  brainstorm: "Brainstorm",
  deep: "Deep research",
};

/** Compact agent labels for the header / follow-up composer (which provider ran
 *  the research — surfaced so a failure can be traced to its CLI). */
const AGENT_LABEL: Record<AgentKind, string> = {
  claude: "Claude",
  codex: "Codex",
  copilot: "Copilot",
  opencode: "opencode",
};

/** Per-intent copy: heading + textarea placeholder + a one-line read-only note. */
const INTENT_COPY: Record<
  ResearchDepth,
  { heading: string; placeholder: string; note: string }
> = {
  brainstorm: {
    heading: "Brainstorm directions, grounded in the web and your code",
    placeholder:
      "What do you want to explore? (e.g. “ways to add a LAN companion mode”)…",
    note: "Surveys the web and your repo for several directions with prior art. Read-only — nothing is changed.",
  },
  deep: {
    heading: "Investigate one direction, in depth and cited",
    placeholder:
      "What should I investigate? (e.g. “embedding an axum server in the Tauri process”)…",
    note: "Reads primary sources and your repo, then writes a cited report. Read-only — it can run longer and cost more than a plan.",
  },
};

/**
 * The read-only research canvas — peer of the plan and session canvases in the
 * agent surface. Shows the *selected* research run's streamed cited report (in-app,
 * never bounced to an external editor) plus a handoff bar to turn it into a plan,
 * copy it, or save it. The follow-up composer can switch the persona (brainstorm ↔
 * deep research) mid-session. Several runs can be open at once; this renders
 * whichever is selected.
 */
export function ResearchView() {
  const run = useActiveResearchRun();
  // SessionView only routes here when a research run for this repo is selected,
  // and each run carries its own repoPath — so no repo prop is needed here.
  if (!run) return null;
  return (
    <div className="flex h-full flex-col">
      <ResearchHeader run={run} />
      <ResearchResult run={run} />
    </div>
  );
}

/** The canvas header: topic + intent, plus Back (deselect, keep the run) and
 *  Dismiss (drop it). */
function ResearchHeader({ run }: { run: ResearchRun }) {
  const setActiveResearch = useResearchStore((s) => s.setActiveResearch);
  const remove = useResearchStore((s) => s.remove);
  const label = run.origin?.topic?.trim() || "Research";
  const intent = run.depth === "deep" ? "Deep research" : "Brainstorm";
  // Which CLI + model ran this research — surfaced so a failure or odd behavior is
  // traceable to its provider (you can't otherwise tell which agent did what).
  const provider = `${AGENT_LABEL[run.agent]}${run.model ? ` · ${run.model}` : ""}`;
  return (
    <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2.5">
      <BinocularsIcon className="size-4 shrink-0 text-primary" />
      <span
        className="min-w-0 flex-1 truncate text-sm font-medium"
        title={label}
      >
        {label}
      </span>
      <span
        className="shrink-0 font-mono text-[11px] text-muted-foreground"
        title="Agent and model running this research"
      >
        {provider}
      </span>
      <span className="shrink-0 text-[11px] text-muted-foreground">
        {intent}
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="shrink-0 gap-1.5 text-muted-foreground"
        onClick={() => setActiveResearch(null)}
        title="Back to the agent surface (keeps this research)"
      >
        <ArrowLeftIcon className="size-3.5" />
        Back
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        className="shrink-0 text-muted-foreground"
        aria-label="Dismiss this research"
        title="Dismiss this research"
        onClick={() => remove(run.id)}
      >
        <TrashIcon className="size-4" />
      </Button>
    </div>
  );
}

/** The research-intent picker — a compact Select matching the composer's other
 *  pickers. Picks the persona (Brainstorm / Deep research) for a new run; the
 *  binoculars icon marks it as the intent so it isn't mistaken for the model. */
function IntentPicker({
  value,
  onChange,
}: {
  value: ResearchDepth;
  onChange: (v: ResearchDepth) => void;
}) {
  return (
    <Select
      items={INTENT_LABEL}
      value={value}
      // The popup publishes every INTENT_LABEL key, so accept only keys that are
      // still in it — collapsing an unknown value to "brainstorm" would let a
      // future depth render an option that silently selects a different one.
      onValueChange={(v) => {
        if (typeof v === "string" && v in INTENT_LABEL)
          onChange(v as ResearchDepth);
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label="Research intent"
        className="w-auto gap-1 border-0 text-muted-foreground shadow-none hover:bg-muted dark:bg-transparent"
      >
        <BinocularsIcon className="size-3.5" />
        <SelectValue />
      </SelectTrigger>
      {/* Size to content so "Deep research" isn't clipped at the narrow trigger
          width when "Brainstorm" is the selected (shorter) value. */}
      <SelectContent className="w-fit">
        {Object.entries(INTENT_LABEL).map(([depth, label]) => (
          <SelectItem key={depth} value={depth}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * The new-research composer (lives in the activation surface, beside "Delegate"
 * and "Plan"). An intent picker selects the persona (Brainstorm / Deep research)
 * and reframes the intro; submitting starts a keyed research run and selects it.
 * `seed` prefills the topic + persona from the agent-research hotkey. (To go
 * deeper on a brainstorm, switch the persona mid-session in the follow-up composer
 * — no separate run.)
 */
export function ResearchComposer({
  repoPath,
  seed,
}: {
  repoPath: string;
  seed: ResearchSeed | null;
}) {
  const start = useResearchStore((s) => s.start);
  const settings = useSettings();
  const [topic, setTopic] = useState(seed?.topic ?? "");
  const [depth, setDepth] = useState<ResearchDepth>(
    seed?.depth ?? "brainstorm",
  );
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

  const canRun = topic.trim().length > 0;
  const copy = INTENT_COPY[depth];

  const submit = () => {
    if (!canRun) return;
    start({ repoPath, agent, model: modelForAgent, effort, topic, depth });
  };

  return (
    // Docked like the Delegate/Plan panels: intro floats above, the composer is
    // pinned to the bottom edge so its toolbar holds steady as the textarea grows.
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto p-6 text-center">
        <div className="flex max-w-md flex-col gap-2">
          <h2 className="text-base font-medium text-balance">{copy.heading}</h2>
          <p className="text-xs leading-relaxed text-muted-foreground">
            A read-only agent searches the web and reads your repo, then streams
            a cited report here. Nothing is changed; turn it into a plan or save
            it when you're happy. Start several — they run side by side.
          </p>
        </div>
      </div>

      <div className="shrink-0 border-t p-2">
        <div className="flex flex-col gap-2 border border-input bg-transparent p-3 transition-colors focus-within:border-ring focus-within:ring-1 focus-within:ring-ring/50 dark:bg-input/30">
          <textarea
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            autoFocus
            rows={3}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={copy.placeholder}
            aria-label="Describe a topic to research"
            className="max-h-48 min-h-16 w-full resize-none bg-transparent text-xs leading-relaxed outline-none placeholder:text-muted-foreground"
          />
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {copy.note}
          </p>
          <div className="flex items-center gap-2 border-t pt-2">
            <IntentPicker value={depth} onChange={setDepth} />
            <AgentPicker
              value={agent}
              onChange={(a) => {
                setAgentPick(a);
                setModel(""); // model lists differ between agents
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
                {formatBinding("mod+enter")} to research
              </span>
              <Button
                size="sm"
                className="min-w-20"
                disabled={!canRun}
                onClick={submit}
              >
                Research
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The user's message for a follow-up turn, shown above the agent's response so
 *  the research session reads as a conversation. When this turn switched the
 *  persona, a small chip marks the transition (brainstorm ↔ deep research). */
function UserMessage({
  text,
  switchedTo,
}: {
  text: string;
  switchedTo?: ResearchDepth;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-medium text-foreground/70">You</span>
        {switchedTo && (
          <span className="inline-flex items-center gap-1 bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            <BinocularsIcon className="size-3" />
            Switched to {INTENT_LABEL[switchedTo]}
          </span>
        )}
      </div>
      <div className="bg-muted/50 px-3 py-2 text-xs leading-relaxed break-words whitespace-pre-wrap">
        {text}
      </div>
    </div>
  );
}

/** One completed earlier turn of the session: its follow-up prompt (turn 1 has
 *  none — its topic is the header) + the agent's transcript (live segments when
 *  in-memory, the saved prose after a reload). */
function ResearchHistoryTurnView({
  turn,
  baseDir,
  switchedTo,
}: {
  turn: ResearchHistoryTurn;
  baseDir: string;
  switchedTo?: ResearchDepth;
}) {
  return (
    <div className="flex flex-col gap-3 border-t border-border/50 pt-4 first:border-t-0 first:pt-0">
      {turn.prompt && (
        <UserMessage text={turn.prompt} switchedTo={switchedTo} />
      )}
      {turn.segments?.length ? (
        <AgentTranscript
          segments={turn.segments}
          baseDir={baseDir}
          fileLinks={false}
        />
      ) : turn.text ? (
        <Markdown>{turn.text}</Markdown>
      ) : null}
    </div>
  );
}

function ResearchResult({ run }: { run: ResearchRun }) {
  const cancel = useResearchStore((s) => s.cancel);
  const restart = useResearchStore((s) => s.restart);
  const saveReport = useResearchStore((s) => s.saveReport);
  const distillPlanBrief = useResearchStore((s) => s.distillPlanBrief);
  const setPendingPlanSeed = usePlanStore((s) => s.setPendingPlanSeed);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [saving, setSaving] = useState(false);

  const distilling = run.distilling ?? false;

  const {
    generating,
    stopped,
    text,
    status,
    report,
    costUsd,
    error,
    reportPath,
  } = run;

  // The current (latest) turn switched personas when its mode differs from the
  // turn before it — marked with a chip on its "You" message (history turns
  // compute the same against their predecessor below).
  const history = run.history ?? [];
  const prevDepth = history.length
    ? history[history.length - 1].depth
    : undefined;
  const currentSwitchedTo =
    prevDepth !== undefined && run.depth !== prevDepth ? run.depth : undefined;

  // Hand the report to the Plan composer as data (treated as the goal to converge,
  // not as instructions). We first distill the whole session into a plan-ready brief
  // (one resumed turn on the same conversation) so the plan gets a clean synthesis
  // instead of the raw multi-turn transcript; on error/cancel/empty we fall back to
  // the raw assembly (never blocks the handoff). Recording originResearchId archives
  // this run's sidebar row once the plan exists.
  const turnIntoPlan = async () => {
    if (!report || run.distilling) return;
    // Snapshot the agent-surface selection AT CLICK, so on completion we can tell
    // whether the user has since navigated to another run/plan/session.
    const selectionAtClick = captureAgentSelection();
    const brief = await distillPlanBrief(run.id);
    // Read fresh from the store: the run captured above is stale after the await
    // (and it may even be gone — bail silently if so).
    const cur = useResearchStore.getState().runs.find((r) => r.id === run.id);
    if (!cur?.report) return;
    // Only steal the canvas if the selection hasn't changed since the click — the
    // user is still waiting on this handoff, so navigating fulfills their click. If
    // they moved to another surface mid-distill, leave their view alone; the pending
    // seed still lands and the activation surface consumes it whenever it next shows.
    if (agentSelectionUnchanged(selectionAtClick)) clearAgentSelection();
    setPendingPlanSeed({
      issueTitle: cur.report.title,
      // The distilled brief, or the raw whole-session assembly as a fallback.
      issueBody: brief ?? assembleSessionReport(cur),
      originResearchId: run.id,
      // Carry forward what research already examined (all turns), as grounding data.
      contextPack: researchRunContextPack(cur),
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      await saveReport(run.id);
    } catch (e) {
      toastError(e);
    } finally {
      setSaving(false);
    }
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
                ? run.depth === "deep"
                  ? "Researching the web…"
                  : "Exploring the web and your repo…"
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

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <div className="flex flex-col gap-4">
          {/* The whole session: each completed earlier turn, then the current one. */}
          {history.map((turn, i, arr) => {
            // Mark a turn that changed persona from the one before it.
            const prev = i === 0 ? undefined : arr[i - 1].depth;
            const switchedTo =
              prev !== undefined &&
              turn.depth !== undefined &&
              turn.depth !== prev
                ? turn.depth
                : undefined;
            return (
              <ResearchHistoryTurnView
                // History is append-only, so the index is a stable key.
                key={i}
                turn={turn}
                baseDir={run.repoPath}
                switchedTo={switchedTo}
              />
            );
          })}
          <div className="flex flex-col gap-3 border-t border-border/50 pt-4 first:border-t-0 first:pt-0">
            {run.currentPrompt ? (
              <UserMessage
                text={run.currentPrompt}
                switchedTo={currentSwitchedTo}
              />
            ) : null}
            {error ? (
              <div className="flex items-start gap-2 text-xs text-destructive">
                <WarningIcon className="mt-0.5 size-4 shrink-0" />
                <span>{error}</span>
              </div>
            ) : run.segments?.length ? (
              <AgentTranscript
                segments={run.segments}
                baseDir={run.repoPath}
                fileLinks={false}
              />
            ) : text ? (
              // Reloaded run (segments are in-memory) — render the saved report.
              <Markdown>{text}</Markdown>
            ) : (
              <p className="text-xs text-muted-foreground">Starting…</p>
            )}
          </div>
        </div>
      </div>

      {(report || error) && (
        <div className="shrink-0 border-t">
          <div className="flex items-center gap-2 px-3 py-2.5">
            {costUsd != null && (
              <span
                className="text-[11px] text-muted-foreground tabular-nums"
                title="Estimated cost of this research run"
              >
                {formatUsd(costUsd)}
              </span>
            )}
            {reportPath && (
              <span
                className="min-w-0 truncate text-[11px] text-muted-foreground"
                title={`Saved to ${reportPath}`}
              >
                Saved to <span className="font-mono">{reportPath}</span>
              </span>
            )}
            {report && (
              <div className="ml-auto flex shrink-0 items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    copyText(assembleSessionReport(run), "Report copied")
                  }
                  title="Copy the report (with the session history) to the clipboard"
                >
                  <CopyIcon className="size-3.5" />
                  Copy
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={save}
                  disabled={saving}
                >
                  <FloppyDiskIcon className="size-3.5" />
                  {reportPath ? "Re-save" : "Save report"}
                </Button>
                {/* Always rendered to reserve its slot so the row doesn't reflow
                    when distillation starts/ends. When idle: `invisible`
                    (visibility:hidden) already removes it from the tab order + a11y
                    tree, and pointer-events-none makes the reserved slot unclickable
                    — `tabIndex={-1}` + `aria-hidden` make that explicit and hold even
                    if the hiding mechanism later changes. */}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => cancel(run.id)}
                  tabIndex={distilling ? undefined : -1}
                  aria-hidden={!distilling}
                  className={
                    distilling ? undefined : "invisible pointer-events-none"
                  }
                >
                  <StopIcon weight="fill" />
                  Stop
                </Button>
                <Button
                  size="sm"
                  onClick={() => void turnIntoPlan()}
                  disabled={distilling}
                >
                  {distilling ? "Distilling…" : "Turn into a Plan"}
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      {report && !error && (
        <div className="shrink-0 border-t p-2">
          <ResearchFollowUp key={run.id} run={run} />
        </div>
      )}
    </div>
  );
}

/**
 * The follow-up composer pinned below the report so you can keep digging after
 * the first pass ("dig deeper into option 2", "find primary sources for the perf
 * claim"). Each message resumes the conversation, so the agent keeps its sources
 * in context. Styled to match the session/plan composers.
 */
function ResearchFollowUp({ run }: { run: ResearchRun }) {
  const sendFollowUp = useResearchStore((s) => s.sendFollowUp);
  const [text, setText] = useState("");
  // Seeded from the run's current persona + model; changing either applies to the
  // next turn (mounted per run via `key={run.id}`, so it tracks the active run).
  // The agent itself can't change mid-conversation (the CLI resume is per-agent).
  const [depth, setDepth] = useState<ResearchDepth>(run.depth);
  const [model, setModel] = useState(run.model);
  const ref = useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    if (!text.trim() || run.generating) return;
    sendFollowUp(run.id, text, depth, model);
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
        placeholder="Dig deeper, or steer the research…"
        aria-label="Continue the research"
        className="max-h-32 min-h-9 w-full resize-none overflow-y-auto bg-transparent text-xs leading-relaxed outline-none placeholder:text-muted-foreground disabled:opacity-60"
      />
      <div className="flex items-center gap-2 border-t pt-2">
        <IntentPicker value={depth} onChange={setDepth} />
        {/* The agent is fixed for the conversation — a quiet label, not a picker. */}
        <span
          className="shrink-0 text-[11px] text-muted-foreground"
          title="The agent can't change mid-conversation"
        >
          {AGENT_LABEL[run.agent]}
        </span>
        <ModelPicker
          value={model}
          onChange={setModel}
          models={modelsForAgent(run.agent)}
        />
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
