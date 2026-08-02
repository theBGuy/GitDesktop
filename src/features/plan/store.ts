import { create } from "zustand";
import { bumpNavVersion } from "@/features/sessions/navVersion";
import { isWatchingAgentSurface } from "@/features/sessions/watching";
import {
  type AgentKind,
  appendTranscriptText,
  appendTranscriptTool,
  type ContextPack,
  cancelAgentSession,
  ensureTranscriptText,
  runAgentSession,
  type TranscriptSegment,
} from "@/lib/ai/agent";
import {
  buildPlanPrompt,
  extractPlanDraft,
  validatePlanPaths,
} from "@/lib/ai/prompt";
import { terminalErrorMessage } from "@/lib/ai/terminal-error";
import { gitListTracked, readRepoInstructions } from "@/lib/git/api";
import { notify } from "@/lib/notify";
import { loadSettings } from "@/lib/settings/api";
import { pushNotification, repoNameFromPath } from "@/lib/stores/notifications";
import { errorMessage } from "@/lib/tauri/invoke";
import { loadPersistedPlans, savePersistedPlans } from "./persistence";

export interface PlanDraft {
  title: string;
  body: string;
  /** Cited paths that didn't resolve to a real tracked file/dir — possible
   *  hallucinations for the human gate to scrutinize before filing the issue. */
  unverified: string[];
}

/** Prefill for the plan composer — a free-form goal and/or an existing issue. */
export interface PlanSeed {
  goal?: string;
  issueTitle?: string | null;
  issueBody?: string | null;
  /** The research run this plan was handed off from ("Turn into a Plan"), if any.
   *  Recorded on the plan so the research sidebar can derive that its run was
   *  converted (and archive it). Reversible: discard the plan and it reverts. */
  originResearchId?: string;
  /** What the origin research stage already examined (files/searches/web), carried
   *  forward as grounding data for the planner. Plain JSON ⇒ persists with the seed
   *  and survives the Re-plan round-trip. Absent on a bare Plan (no handoff). */
  contextPack?: ContextPack;
}

export interface GenerateArgs extends PlanSeed {
  repoPath: string;
  /** Planning needs repo-aware reads, which only the CLI agents have. */
  agent: AgentKind;
  model: string;
  /** Reasoning/effort level ("" = provider default; else low/medium/high/xhigh). */
  effort: string;
  /** The original prompt to display. Derived from goal/issueTitle when omitted. */
  origin?: { goal: string; issueTitle: string | null };
}

/**
 * One concurrent plan run — a **read-only agent conversation**. Turn 1 explores
 * the repo and drafts an agent-ready issue; answering its open questions resumes
 * the SAME conversation (the agent keeps its exploration + the prior draft in
 * context) and refines incrementally, rather than re-planning from scratch. Kept
 * in the list so switching away never loses it — the keyed analogue of a session.
 */
export interface PlanRun {
  /** Stable id (also the row key + active-selection key). */
  id: string;
  repoPath: string;
  /** Which CLI drives the conversation, fixed at creation. */
  agent: AgentKind;
  model: string;
  effort: string;
  /** The conversation's stable uuid: `--session-id` on turn 1, `--resume` after;
   *  also the cancel key. */
  sessionId: string;
  /** The CLI's native resume id captured on turn 1 (Codex thread / opencode
   *  session), so a host conversation resumes the right thread. Unset until then. */
  nativeSessionId: string | null;
  /** The original prompt, for the sidebar row + the result header. */
  origin: { goal: string; issueTitle: string | null } | null;
  /** The seed this run was started from, so "Re-plan" can reopen the composer. */
  seed: PlanSeed | null;
  generating: boolean;
  /** The user stopped this run mid-turn (Stop). Idle but restartable; tells the
   *  result view to offer Restart instead of treating partial output as a draft. */
  stopped: boolean;
  /** The latest streamed plan markdown (replaced each turn — a refine re-outputs
   *  the full updated plan). */
  text: string;
  /** Transient tool-activity note (e.g. "Reading files…"). */
  status: string;
  /** The interleaved render of the latest turn — prose runs + tool steps in order
   *  (`text` is the same prose, concatenated, kept for parsing the draft).
   *  Persisted with the run (absent only on runs saved before this field existed →
   *  the transcript falls back to `text`). */
  segments?: TranscriptSegment[];
  /** Parsed + path-validated result, set when the turn completes. */
  draft: PlanDraft | null;
  /** The latest turn's reported cost (USD); null if unreported. */
  costUsd: number | null;
  /** The write-capable session this plan was implemented into (via "Implement"),
   *  so the sidebar row mirrors that session's status instead of "Plan ready". */
  implementedSessionId: string | null;
  error: string | null;
}

interface PlanState {
  /** All concurrent plan runs, in creation order. */
  runs: PlanRun[];
  /** The plan run shown in the agent canvas; null = no plan selected (it shares
   *  the surface with sessions — see `agentSelect.ts` for mutual exclusion). */
  activePlanId: string | null;
  /** A seed for the activation "Plan a task" composer (set by the agent-plan
   *  hotkey, or an issue's Plan button), consumed by SessionActivation. */
  pendingPlanSeed: PlanSeed | null;
  /** Whether persisted plans have been loaded (gates autosave so the initial
   *  empty state never overwrites what's on disk). */
  hydrated: boolean;

  /** Load persisted plans from disk into the list (once, at startup). */
  hydrate: () => Promise<void>;
  setActivePlan: (id: string | null) => void;
  setPendingPlanSeed: (seed: PlanSeed | null) => void;
  /** Start a new plan run (creates it, selects it, streams turn 1). Returns its id. */
  start: (args: GenerateArgs) => string;
  /** Resume the conversation with the user's answers folded in, so the agent
   *  refines incrementally. No-op if it's missing or mid-turn. */
  refine: (
    id: string,
    decisions: { question: string; answer: string }[],
  ) => void;
  /** Send a free-form follow-up — resumes the conversation so the agent revises
   *  the plan. No-op if it's missing, mid-turn, or the message is blank. */
  sendFollowUp: (id: string, message: string) => void;
  /** Link a plan to the write-capable session "Implement" spawned from it. */
  markImplemented: (id: string, sessionId: string) => void;
  /** Signal an in-flight turn to stop (leaves the run restartable). */
  cancel: (id: string) => void;
  /** Re-run a stopped (or errored) plan from its original seed — a fresh
   *  conversation, reusing the row. No-op while generating. */
  restart: (id: string) => void;
  /** Drop a run from the list (cancelling any in-flight turn). */
  remove: (id: string) => void;
}

function repoName(p: string): string {
  return (
    p
      .replace(/[/\\]+$/, "")
      .split(/[/\\]/)
      .pop() ?? p
  );
}

/**
 * Read-only planning surface. Each plan run is a **resumable read-only agent
 * conversation** (the `agent_session` backend with `readOnly: true` — read tools
 * only, no worktree, runs in the live repo). Turn 1 explores + drafts + asks; a
 * refine resumes the same conversation with the answers, so the agent keeps its
 * context and refines incrementally. Cited paths are validated against
 * `git ls-files`. Never writes: the per-CLI read-only toolset is the hard guarantee.
 */
export const usePlanStore = create<PlanState>((set, get) => {
  /** Patch one run by id — maps over the array, touching only that run, so
   *  concurrent runs streaming at once never clobber each other. */
  const patch = (id: string, p: Partial<PlanRun>) =>
    set({ runs: get().runs.map((r) => (r.id === id ? { ...r, ...p } : r)) });

  /** Stream one turn of run `id` (a read-only agent session turn), then parse the
   *  result into a draft. `resume` continues the conversation (a refine). */
  const runTurn = async (
    id: string,
    system: string,
    userPrompt: string,
    resume: boolean,
  ) => {
    const run0 = get().runs.find((r) => r.id === id);
    if (!run0) return;
    patch(id, {
      generating: true,
      text: "",
      status: "",
      segments: [],
      draft: null,
      costUsd: null,
      stopped: false,
      error: null,
    });
    // True once this turn's result is stale: the user stopped it (`stopped`), or a
    // restart issued a fresh session id. Either way its (killed/partial) output must
    // not overwrite the run — guards every terminal patch below.
    const superseded = () => {
      const cur = get().runs.find((r) => r.id === id);
      return !cur || cur.sessionId !== run0.sessionId || cur.stopped;
    };
    const tracked = await gitListTracked(run0.repoPath).catch(
      () => [] as string[],
    );
    let finalText = "";
    let errored = false;
    // Announce a finished plan run (success OR failure) the way agent sessions do.
    // A plan that finished WITH clarifying questions is a blocking handoff — it
    // idles until the user answers — so always nudge, even while they're watching
    // it (a redundant toast costs nothing; a stranded handoff costs a lost turn).
    // Otherwise stay quiet only when they're actually looking at this plan
    // (focused + Agent tab + selected); a focused user on another tab still gets
    // it. Skips a run removed mid-flight (its row is gone, nothing to return to).
    const notifyDone = (failed: boolean, hasQuestions = false) => {
      const run = get().runs.find((r) => r.id === id);
      if (!run) return;
      if (!hasQuestions && isWatchingAgentSurface(get().activePlanId, id))
        return;
      const label =
        run.origin?.issueTitle?.trim() || run.origin?.goal?.trim() || "Plan";
      const headline = failed
        ? "Plan failed"
        : hasQuestions
          ? "Plan ready — answer its questions"
          : "Plan ready";
      void notify(headline, label);
      pushNotification({
        kind: "plan-done",
        tone: failed ? "danger" : hasQuestions ? "warning" : "success",
        title: headline,
        subtitle: label,
        repoPath: run.repoPath,
        repoName: repoNameFromPath(run.repoPath),
        target: { type: "agent" },
        dedupeKey: `plan:${id}:${failed}:${hasQuestions}`,
      });
    };
    try {
      await runAgentSession({
        binPath: null,
        agent: run0.agent,
        model: run0.model,
        effort: run0.effort,
        systemPrompt: system,
        userPrompt,
        // Read-only: runs in the live repo, never a worktree, and can't write.
        worktreePath: run0.repoPath,
        sessionId: run0.sessionId,
        resume,
        readOnly: true,
        isolation: "worktree",
        nativeSessionId: run0.nativeSessionId,
        onEvent: (ev) => {
          if (ev.kind === "nativeSession") {
            // Capture once (turn 1) so a host resume targets this conversation.
            const cur = get().runs.find((r) => r.id === id);
            if (cur && !cur.nativeSessionId)
              patch(id, { nativeSessionId: ev.id });
          } else if (ev.kind === "delta") {
            finalText += ev.text;
            const cur = get().runs.find((r) => r.id === id);
            patch(id, {
              text: finalText,
              segments: appendTranscriptText(cur?.segments ?? [], ev.text),
              status: "",
            });
          } else if (ev.kind === "status") {
            patch(id, { status: ev.text });
          } else if (ev.kind === "tool") {
            const cur = get().runs.find((r) => r.id === id);
            patch(id, {
              segments: appendTranscriptTool(
                cur?.segments ?? [],
                ev.tool,
                ev.target,
              ),
              status: "",
            });
          } else if (ev.kind === "done") {
            // The terminal event carries the authoritative full text; prefer it.
            if (ev.text.length > finalText.length) finalText = ev.text;
            if (ev.costUsd != null) patch(id, { costUsd: ev.costUsd });
            // Whole-message agents (codex) stream no deltas — fold the final text
            // in so the transcript shows it after its tool steps.
            const cur = get().runs.find((r) => r.id === id);
            patch(id, {
              segments: ensureTranscriptText(cur?.segments ?? [], finalText),
            });
            if (ev.isError) {
              errored = true;
              // Don't paint an error onto a run the user just stopped (or a turn a
              // restart superseded) — a killed process may emit one on the way out.
              if (!superseded())
                patch(id, {
                  error: terminalErrorMessage(
                    finalText,
                    "The planner reported an error.",
                  ),
                });
            }
          } else if (ev.kind === "error") {
            errored = true;
            if (!superseded()) patch(id, { error: ev.message });
          }
        },
      });
    } catch (e) {
      if (superseded()) return;
      patch(id, { generating: false, error: errorMessage(e) });
      notifyDone(true);
      return;
    }
    if (superseded()) return;
    if (errored) {
      patch(id, { generating: false });
      notifyDone(true);
      return;
    }
    const { title, body } = extractPlanDraft(finalText);
    if (!body.trim()) {
      patch(id, {
        generating: false,
        error: "The planner returned nothing — try again.",
      });
      notifyDone(true);
      return;
    }
    patch(id, {
      generating: false,
      draft: {
        title,
        body,
        unverified: validatePlanPaths(body, new Set(tracked)),
      },
    });
    notifyDone(false, /\[NEEDS\s+CLARIFICATION/i.test(body));
  };

  /** Build turn 1's system + user prompt (grounded in the repo's instructions),
   *  then stream it. */
  const runFirstTurn = async (id: string, args: GenerateArgs) => {
    const { repoPath, goal = "", issueTitle, issueBody, contextPack } = args;
    const [repoInstructions, settings] = await Promise.all([
      readRepoInstructions(repoPath).catch(() => null),
      loadSettings().catch(() => null),
    ]);
    const { system, prompt } = buildPlanPrompt({
      goal,
      issueTitle,
      issueBody,
      repoName: repoName(repoPath),
      repoInstructions,
      globalInstructions: settings?.globalInstructions ?? "",
      contextPack,
    });
    await runTurn(id, system, prompt, false);
  };

  return {
    runs: [],
    activePlanId: null,
    pendingPlanSeed: null,
    hydrated: false,

    hydrate: async () => {
      if (get().hydrated) return;
      let persisted: PlanRun[] = [];
      try {
        persisted = await loadPersistedPlans();
      } catch {
        // No store yet / unreadable — start clean.
      }
      // Merge under any runs created before hydration finished (newest state wins).
      const live = new Set(get().runs.map((r) => r.id));
      set({
        runs: [...persisted.filter((p) => !live.has(p.id)), ...get().runs],
        hydrated: true,
      });
    },

    setActivePlan: (activePlanId) => {
      // Tick the agent-surface nav counter so an in-flight handoff can tell the
      // user navigated (see navVersion.ts) — covers the direct "Back" button too.
      bumpNavVersion();
      set({ activePlanId });
    },
    setPendingPlanSeed: (pendingPlanSeed) => set({ pendingPlanSeed }),

    start: (args) => {
      const id = crypto.randomUUID();
      const { goal = "", issueTitle } = args;
      const run: PlanRun = {
        id,
        repoPath: args.repoPath,
        agent: args.agent,
        model: args.model,
        effort: args.effort,
        sessionId: crypto.randomUUID(),
        nativeSessionId: null,
        origin: args.origin ?? { goal, issueTitle: issueTitle ?? null },
        seed: {
          goal: args.goal,
          issueTitle: args.issueTitle,
          issueBody: args.issueBody,
          originResearchId: args.originResearchId,
          contextPack: args.contextPack,
        },
        generating: true,
        stopped: false,
        text: "",
        status: "",
        draft: null,
        costUsd: null,
        implementedSessionId: null,
        error: null,
      };
      set({
        runs: [...get().runs, run],
        activePlanId: id,
        pendingPlanSeed: null,
      });
      void runFirstTurn(id, args);
      return id;
    },

    refine: (id, decisions) => {
      const run = get().runs.find((r) => r.id === id);
      if (!run || run.generating) return;
      const answered = decisions.filter((d) => d.answer.trim());
      if (answered.length === 0) return;
      const block = answered
        .map((d) => `- ${d.question} → ${d.answer.trim()}`)
        .join("\n");
      // Resume the conversation: the agent already has its exploration + the prior
      // draft in context, so this refines incrementally (no re-exploration).
      const userPrompt = `I've answered the open questions:\n${block}\n\nIncorporate these decisions into the plan (resolve them — don't ask them again), and re-output the COMPLETE updated agent-ready issue in the same format.`;
      void runTurn(id, "", userPrompt, true);
    },

    sendFollowUp: (id, message) => {
      const run = get().runs.find((r) => r.id === id);
      const text = message.trim();
      if (!run || run.generating || !text) return;
      const userPrompt = `${text}\n\nApply this and re-output the COMPLETE updated agent-ready issue in the same format.`;
      void runTurn(id, "", userPrompt, true);
    },

    markImplemented: (id, sessionId) =>
      patch(id, { implementedSessionId: sessionId }),

    cancel: (id) => {
      const run = get().runs.find((r) => r.id === id);
      if (!run?.generating) return;
      void cancelAgentSession(run.sessionId);
      // Settle to a clear stopped state right away; the in-flight turn sees
      // `stopped` when its killed process returns and bails without overwriting.
      patch(id, { generating: false, status: "", stopped: true });
    },

    restart: (id) => {
      const run = get().runs.find((r) => r.id === id);
      if (!run || run.generating) return;
      // Fresh conversation (the stopped one was killed): a new session id so the
      // old turn — if it's still resolving — is detected as stale and bails, then
      // re-run turn 1 from the original seed.
      patch(id, {
        sessionId: crypto.randomUUID(),
        nativeSessionId: null,
        generating: true,
        status: "",
        stopped: false,
        error: null,
      });
      void runFirstTurn(id, {
        repoPath: run.repoPath,
        goal: run.seed?.goal ?? run.origin?.goal ?? "",
        issueTitle: run.seed?.issueTitle,
        issueBody: run.seed?.issueBody,
        contextPack: run.seed?.contextPack,
        agent: run.agent,
        model: run.model,
        effort: run.effort,
        origin: run.origin ?? undefined,
      });
    },

    remove: (id) => {
      const run = get().runs.find((r) => r.id === id);
      if (run?.generating) void cancelAgentSession(run.sessionId);
      set({
        runs: get().runs.filter((r) => r.id !== id),
        activePlanId: get().activePlanId === id ? null : get().activePlanId,
      });
    },
  };
});

// Persist the plan list to disk, debounced so a streaming run's rapid text
// updates coalesce into roughly one write a second (the latest snapshot wins, and
// captures the native session id mid-stream so a resume survives a restart). Gated
// on `hydrated` so the initial empty state never clobbers what's on disk.
let saveTimer: ReturnType<typeof setTimeout> | null = null;
usePlanStore.subscribe((state, prev) => {
  if (!state.hydrated || state.runs === prev.runs) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void savePersistedPlans(usePlanStore.getState().runs);
  }, 800);
});

// Load persisted plans once at startup (so they're back in the sidebar, resumable).
void usePlanStore.getState().hydrate();

/** The currently-selected plan run, or null. Reference-stable while that run is
 *  unchanged (so streaming another run won't re-render the active one). */
export function useActivePlanRun(): PlanRun | null {
  return usePlanStore(
    (s) => s.runs.find((r) => r.id === s.activePlanId) ?? null,
  );
}
