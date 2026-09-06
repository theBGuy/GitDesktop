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
  extractContextPack,
  runAgentSession,
  type TranscriptSegment,
} from "@/lib/ai/agent";
import {
  buildResearchDistillPrompt,
  buildResearchFollowUp,
  buildResearchPrompt,
  extractResearchReport,
} from "@/lib/ai/prompt";
import { terminalErrorMessage } from "@/lib/ai/terminal-error";
import { readRepoInstructions } from "@/lib/git/api";
import { notify } from "@/lib/notify";
import { norm } from "@/lib/repo-data-migration";
import { loadSettings } from "@/lib/settings/api";
import { pushNotification, repoNameFromPath } from "@/lib/stores/notifications";
import { errorMessage, invoke } from "@/lib/tauri/invoke";
import { loadPersistedResearch, savePersistedResearch } from "./persistence";

/** Where a saved Research report is written, relative to the repo root: the app's committed
 *  `.gitdesktop/` metadata folder, so it shows in Changes and is the user's to commit — we
 *  never commit it. */
const RESEARCH_REPORT_DIR = ".gitdesktop/research";

/** Which research persona drives a turn. "brainstorm" diverges (breadth, options);
 *  "deep" investigates one direction (depth, cited). Set at creation, but the user
 *  can switch it mid-session from the follow-up composer (like switching models). */
export type ResearchDepth = "brainstorm" | "deep";

/** The parsed result of a research turn — the full report markdown plus the
 *  title lifted from its first heading (sidebar row + saved file name). */
export interface ResearchReport {
  title: string;
  report: string;
}

/** A completed earlier turn of a research session, kept so the whole conversation
 *  stays visible (the current turn lives in the run's top-level fields). */
export interface ResearchHistoryTurn {
  /** The user's message for this turn — "" for turn 1 (its topic is the header). */
  prompt: string;
  /** Interleaved render (persisted; absent only on turns saved before this field
   *  existed → falls back to `text`). */
  segments?: TranscriptSegment[];
  /** Full prose of the turn (persisted, so the session survives a reload). */
  text: string;
  report: ResearchReport | null;
  costUsd: number | null;
  /** The persona this turn ran in — so the canvas can mark where the session
   *  switched modes (brainstorm ↔ deep). Absent on runs persisted before this
   *  field existed → treated as "no switch". */
  depth?: ResearchDepth;
}

/** Prefill for the research composer: a topic + persona (from the agent-research
 *  hotkey). Going deeper on a brainstorm happens by switching the persona
 *  mid-session in the follow-up composer, not by seeding a separate run. */
export interface ResearchSeed {
  /** The repo this seed was raised in. The Agent tab lives under `<Activity>`, so
   *  an unconsumed seed outlives a repo switch — the consumer matches on this
   *  rather than prefilling another repo's composer. */
  repoPath: string;
  topic?: string;
  depth?: ResearchDepth;
}

/** A seed as recorded on its run — `repoPath` is absent on runs persisted before
 *  the repo axis existed, so readers of a rehydrated seed must handle its absence. */
export type StoredResearchSeed = Omit<ResearchSeed, "repoPath"> & {
  repoPath?: string;
};

export interface ResearchGenerateArgs extends ResearchSeed {
  /** Which CLI runs the research — each uses its own native web tools. */
  agent: AgentKind;
  model: string;
  effort: string;
  topic: string;
  depth: ResearchDepth;
}

/**
 * One concurrent research run — a web-enabled READ-ONLY agent conversation. Turn 1 explores
 * (repo + web) and streams a cited markdown report; a follow-up resumes the SAME conversation
 * so the agent keeps its sources in context. Never writes: the per-CLI read-only toolset
 * (read + web tools, no Edit/Write/Bash) is the hard guarantee.
 */
export interface ResearchRun {
  id: string;
  repoPath: string;
  agent: AgentKind;
  model: string;
  effort: string;
  depth: ResearchDepth;
  /** The conversation's stable uuid: `--session-id` on turn 1, `--resume` after;
   *  also the cancel key. */
  sessionId: string;
  /** The CLI's native resume id captured on turn 1; unset until then. */
  nativeSessionId: string | null;
  /** The original topic + persona, for the sidebar row + canvas header. */
  origin: { topic: string; depth: ResearchDepth } | null;
  /** The seed this run was started from, so a re-run can reopen the composer. */
  seed: StoredResearchSeed | null;
  /** Completed earlier turns, oldest first — shown above the current turn so the
   *  whole research session stays visible (the current turn is the fields below). */
  history?: ResearchHistoryTurn[];
  /** The current turn's user message — "" for turn 1 (topic is the header); a
   *  follow-up shows this as a "You" bubble above its transcript. */
  currentPrompt?: string;
  generating: boolean;
  /** True while a "Turn into a Plan" handoff is running its one-shot distill turn
   *  (resumes the conversation to synthesize a plan brief). Transient UI state only:
   *  deliberately NOT persisted (see persistence.ts `toPersisted`), so a reload can
   *  never resurrect a stuck flag on a run whose distill was interrupted. */
  distilling?: boolean;
  /** The user stopped this run mid-turn (Stop). Idle but restartable; tells the
   *  canvas to offer Restart instead of treating partial output as a report. */
  stopped: boolean;
  /** The latest streamed report markdown (replaced each turn). */
  text: string;
  /** Transient tool-activity note (e.g. "Searching the web…"). */
  status: string;
  /** The interleaved render of the latest turn — prose runs + tool steps in order (`text` is
   *  the same prose, kept for parsing the report). Persisted; absent only on runs saved
   *  before this field existed → the transcript falls back to `text`. */
  segments?: TranscriptSegment[];
  /** Parsed report (title + markdown), set when the turn completes. */
  report: ResearchReport | null;
  /** The latest turn's reported cost (USD); null if unreported. */
  costUsd: number | null;
  /** Repo-relative path of the saved report file once saved (null = unsaved). */
  reportPath: string | null;
  error: string | null;
}

interface ResearchState {
  /** All concurrent research runs, in creation order. */
  runs: ResearchRun[];
  /** The research run shown in the agent canvas; null = none (shares the surface
   *  with sessions and plans — see `agentSelect.ts` for mutual exclusion). */
  activeResearchId: string | null;
  /** A seed for the activation "Research" composer (set by the agent-research
   *  hotkey), consumed by SessionActivation. */
  pendingResearchSeed: ResearchSeed | null;
  /** Whether persisted runs have loaded (gates autosave so the initial empty
   *  state never overwrites disk). */
  hydrated: boolean;

  hydrate: () => Promise<void>;
  setActiveResearch: (id: string | null) => void;
  setPendingResearchSeed: (seed: ResearchSeed | null) => void;
  /** Start a new research run (creates it, selects it, streams turn 1). Returns its id. */
  start: (args: ResearchGenerateArgs) => string;
  /** Send a free-form follow-up — resumes the conversation so the agent digs deeper. `depth`
   *  is the persona for this turn (switchable mid-session; a change re-injects it inline) and
   *  `model` applies from this turn on. No-op if the run is missing, mid-turn, or blank. */
  sendFollowUp: (
    id: string,
    message: string,
    depth: ResearchDepth,
    model: string,
  ) => void;
  /** Distill the whole session into a plan-ready brief by resuming the run's own
   *  CLI conversation for ONE synthesis turn (the agent already holds the full
   *  context). Resolves to the cleaned brief, or `null` on no-op / error / cancel /
   *  empty result — the caller then falls back to the raw session assembly. Never
   *  throws, never mutates the run's visible transcript (`text`/`segments`/`report`). */
  distillPlanBrief: (id: string) => Promise<string | null>;
  /** Save the run's report as a local Markdown file (scaffold-local-files: the
   *  user commits it, we never do). Resolves to the repo-relative path written. */
  saveReport: (id: string) => Promise<string>;
  /** Signal an in-flight turn to stop (leaves the run restartable). */
  cancel: (id: string) => void;
  /** Re-run a stopped (or errored) research run from its original topic — a fresh
   *  conversation, reusing the row. No-op while generating. */
  restart: (id: string) => void;
  /** Drop a run from the list (cancelling any in-flight turn). */
  remove: (id: string) => void;
  /** Repoint every run of a relocated repo at its new path, so they stay in the
   *  sidebar and the next autosave writes the migrated paths back (an unpatched
   *  list would re-persist the old ones over the on-disk migration). */
  relocateRepoPath: (oldPath: string, newPath: string) => void;
}

function repoName(p: string): string {
  return (
    p
      .replace(/[/\\]+$/, "")
      .split(/[/\\]/)
      .pop() ?? p
  );
}

/** A filesystem-safe stem from a report title (the Rust side sanitizes again as a
 *  safety net; this just keeps the saved name readable). */
function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "research"
  );
}

/** Drop any pre-report narration (the streamed report is already cleaned by
 *  `extractResearchReport`; this is the fallback for a turn we only have raw text
 *  for, e.g. reloaded). */
function cleanReportText(text: string): string {
  const t = text
    .replace(/^\s*```[a-z]*\n?/i, "")
    .replace(/```\s*$/g, "")
    .trim();
  const at = t.search(/^#{1,6}\s+\S/m);
  return at > 0 ? t.slice(at).trim() : t;
}

/**
 * Assemble the whole research session into one Markdown document for saving or handing to
 * Plan: the latest report first, then each earlier turn (its question + report), kept for
 * transparency. Pre-report narration is stripped throughout.
 */
export function assembleSessionReport(run: ResearchRun): string {
  const reportOf = (text: string, report: ResearchReport | null) =>
    report?.report ?? cleanReportText(text);
  const current = reportOf(run.text, run.report);
  const history = run.history ?? [];
  if (history.length === 0) return current;
  const prior = history
    .map((h) => {
      const asked = h.prompt?.trim();
      const head = asked
        ? `> **Asked:** ${asked}`
        : "> **Initial exploration**";
      return `${head}\n\n${reportOf(h.text, h.report)}`;
    })
    .join("\n\n---\n\n");
  return `${current}\n\n---\n\n## Earlier in this research session\n\n_Prior turns of this session, kept for full transparency._\n\n${prior}`;
}

/**
 * Distill every turn's tool steps (prior history + the current turn) into a
 * {@link ContextPack}, so a "Turn into a Plan" handoff carries what research already read,
 * searched, and fetched. Turns saved before segments existed contribute nothing (empty pack).
 */
export function researchRunContextPack(run: ResearchRun): ContextPack {
  return extractContextPack([
    ...(run.history ?? []).flatMap((h) => h.segments ?? []),
    ...(run.segments ?? []),
  ]);
}

/**
 * Read-only research surface: each run is a resumable web-enabled agent conversation (the
 * `agent_session` backend with `readOnly: true` + `web: true` — no worktree, runs in the live
 * repo). See {@link ResearchRun} for the per-run model.
 */
export const useResearchStore = create<ResearchState>((set, get) => {
  /** Patch one run by id — touches only that run, so concurrent runs streaming
   *  at once never clobber each other. */
  const patch = (id: string, p: Partial<ResearchRun>) =>
    set({ runs: get().runs.map((r) => (r.id === id ? { ...r, ...p } : r)) });

  /** Stream one turn of run `id` (a web-enabled read-only session turn), then
   *  parse the result into a report. `resume` continues the conversation. */
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
      report: null,
      costUsd: null,
      // Clear the saved-file marker too: a new turn re-outputs the report, so a
      // previously-saved path is stale even if this turn errors (the row would
      // otherwise show "Saved to …" next to an emptied/errored run).
      reportPath: null,
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
    let finalText = "";
    let errored = false;
    // Announce a finished run (success OR failure), but stay quiet when the user is looking
    // at this run (focused + Agent tab + selected); another tab still gets it.
    const notifyDone = (failed: boolean) => {
      const run = get().runs.find((r) => r.id === id);
      if (!run) return;
      if (isWatchingAgentSurface(get().activeResearchId, id, run.repoPath))
        return;
      const label = run.origin?.topic?.trim() || "Research";
      const headline = failed ? "Research failed" : "Research ready";
      // Hiding AI features mutes the OS ping — a hidden feature must not tap you
      // on the shoulder. The inbox row below still lands (the dock filters it at
      // render time), and a settings read that fails falls through to notifying.
      void loadSettings()
        .catch(() => null)
        .then((s) => {
          if (!s?.hideAi) void notify(headline, label);
        });
      pushNotification({
        kind: "research-done",
        tone: failed ? "danger" : "success",
        title: headline,
        subtitle: label,
        repoPath: run.repoPath,
        repoName: repoNameFromPath(run.repoPath),
        target: { type: "agent" },
        dedupeKey: `research:${id}:${failed}`,
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
        // The web-enabled read-only profile — adds WebSearch/WebFetch, still no writes.
        web: true,
        isolation: "worktree",
        nativeSessionId: run0.nativeSessionId,
        onEvent: (ev) => {
          if (ev.kind === "nativeSession") {
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
            // Prefer the terminal event's authoritative full text — except on an
            // errored Done, whose text is the failure reason and must not fold
            // into the transcript (visible on the superseded path).
            if (!ev.isError && ev.text.length > finalText.length)
              finalText = ev.text;
            if (ev.costUsd != null) patch(id, { costUsd: ev.costUsd });
            // Whole-message agents (e.g. Codex) stream no deltas — fold the final
            // text in so the transcript shows it after its tool steps (uniform with
            // the other surfaces).
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
                  // The terminal event's OWN text — never the delta accumulation,
                  // whose narration could pass the error-shape net as the "reason".
                  error: terminalErrorMessage(
                    ev.text,
                    "The research agent reported an error.",
                  ),
                });
            }
          } else if (ev.kind === "error") {
            errored = true;
            // Keep what a killed run wrote — a whole-message agent (codex) delivers it
            // only here, so adopt it when nothing streamed and fold it in exactly as the
            // done branch does. `errored` returns before `extractResearchReport` below,
            // so a truncated report can still never become the saved report. Superseded-
            // guarded like the error patch: a stopped or restarted run's dying event
            // must not write into the transcript that replaced it.
            if (!superseded() && ev.partialText?.trim() && !finalText) {
              finalText = ev.partialText;
              const cur = get().runs.find((r) => r.id === id);
              patch(id, {
                text: finalText,
                segments: ensureTranscriptText(cur?.segments ?? [], finalText),
              });
            }
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
    const { title, report } = extractResearchReport(finalText);
    if (!report.trim()) {
      patch(id, {
        generating: false,
        error: "The research agent returned nothing — try again.",
      });
      notifyDone(true);
      return;
    }
    patch(id, {
      generating: false,
      report: { title, report },
    });
    notifyDone(false);
  };

  /** Build turn 1's system + user prompt (grounded in the repo's instructions),
   *  then stream it. */
  const runFirstTurn = async (id: string, args: ResearchGenerateArgs) => {
    const { repoPath, topic, depth } = args;
    const [repoInstructions, settings] = await Promise.all([
      readRepoInstructions(repoPath).catch(() => null),
      loadSettings().catch(() => null),
    ]);
    const { system, prompt } = buildResearchPrompt({
      depth,
      topic,
      repoName: repoName(repoPath),
      repoInstructions,
      globalInstructions: settings?.globalInstructions ?? "",
    });
    await runTurn(id, system, prompt, false);
  };

  return {
    runs: [],
    activeResearchId: null,
    pendingResearchSeed: null,
    hydrated: false,

    hydrate: async () => {
      if (get().hydrated) return;
      let persisted: ResearchRun[] = [];
      try {
        persisted = await loadPersistedResearch();
      } catch {
        // No store yet / unreadable — start clean.
      }
      const live = new Set(get().runs.map((r) => r.id));
      set({
        runs: [...persisted.filter((p) => !live.has(p.id)), ...get().runs],
        hydrated: true,
      });
    },

    setActiveResearch: (activeResearchId) => {
      // Tick the agent-surface nav counter so an in-flight handoff can tell the
      // user navigated (see navVersion.ts) — covers the direct "Back" button too.
      bumpNavVersion();
      set({ activeResearchId });
    },
    setPendingResearchSeed: (pendingResearchSeed) =>
      set({ pendingResearchSeed }),

    start: (args) => {
      const id = crypto.randomUUID();
      const run: ResearchRun = {
        id,
        repoPath: args.repoPath,
        agent: args.agent,
        model: args.model,
        effort: args.effort,
        depth: args.depth,
        sessionId: crypto.randomUUID(),
        nativeSessionId: null,
        origin: { topic: args.topic, depth: args.depth },
        seed: { repoPath: args.repoPath, topic: args.topic, depth: args.depth },
        history: [],
        currentPrompt: "",
        generating: true,
        stopped: false,
        text: "",
        status: "",
        report: null,
        costUsd: null,
        reportPath: null,
        error: null,
      };
      set({
        runs: [...get().runs, run],
        activeResearchId: id,
        pendingResearchSeed: null,
      });
      void runFirstTurn(id, args);
      return id;
    },

    sendFollowUp: (id, message, depth, model) => {
      const run = get().runs.find((r) => r.id === id);
      const text = message.trim();
      // A distill turn is resuming the same conversation — treat it like generating.
      if (!run || run.generating || run.distilling || !text) return;
      // A persona change vs the turn that just ran — re-inject the new persona for
      // this and following turns (see buildResearchFollowUp).
      const switched = depth !== run.depth;
      // Keep the just-finished turn visible: snapshot it into history (with the
      // persona it ran in) before the new turn clears the current fields, so the
      // whole research session stays on screen (the current turn streams into the
      // top-level fields as before).
      patch(id, {
        history: [
          ...(run.history ?? []),
          {
            prompt: run.currentPrompt ?? "",
            segments: run.segments,
            text: run.text,
            report: run.report,
            costUsd: run.costUsd,
            depth: run.depth,
          },
        ],
        currentPrompt: text,
        depth,
        // The model for this turn onward (runTurn reads the run's current model).
        model,
      });
      const userPrompt = buildResearchFollowUp({
        message: text,
        depth,
        switched,
      });
      void runTurn(id, "", userPrompt, true);
    },

    saveReport: async (id) => {
      const run = get().runs.find((r) => r.id === id);
      if (!run?.report) throw new Error("No report to save yet.");
      const rel = await invoke<string>("research_save_report", {
        repoPath: run.repoPath,
        dir: RESEARCH_REPORT_DIR,
        slug: slugify(run.report.title),
        // Save the whole session (latest report + prior turns), preamble stripped.
        content: assembleSessionReport(run),
      });
      patch(id, { reportPath: rel });
      return rel;
    },

    distillPlanBrief: async (id) => {
      const run0 = get().runs.find((r) => r.id === id);
      // No-op unless idle — a mid-turn or already-distilling run has nothing stable to resume
      // against. Claude-only: the distill runs on a FORKED session (`--fork-session`) so it
      // never pollutes the conversation; no other CLI can fork, so distilling them would append
      // to their transcript — the raw fallback (null) is the correct behavior there.
      if (
        !run0 ||
        run0.generating ||
        run0.distilling ||
        run0.agent !== "claude"
      )
        return null;
      patch(id, { distilling: true });
      // Stale once the run is gone, its session was replaced (restart), it was
      // stopped, or the distill flag was cleared (cancel) — mirrors runTurn's guard.
      const superseded = () => {
        const cur = get().runs.find((r) => r.id === id);
        return (
          !cur ||
          cur.sessionId !== run0.sessionId ||
          cur.stopped ||
          !cur.distilling
        );
      };
      let finalText = "";
      let errored = false;
      // Captured in `finally` BEFORE `distilling` is cleared: superseded() reads
      // `cur.distilling`, so evaluating it after the clear would discard every successful
      // distill (the raw fallback would mask it).
      let wasSuperseded = true;
      try {
        await runAgentSession({
          binPath: null,
          agent: run0.agent,
          model: run0.model,
          effort: run0.effort,
          // Resume: system prompt is set only on turn 1 (empty here, like a follow-up).
          systemPrompt: "",
          userPrompt: buildResearchDistillPrompt(),
          worktreePath: run0.repoPath,
          sessionId: run0.sessionId,
          resume: true,
          // Fork the resumed conversation to a throwaway session: the distill reads
          // the full research context but never appends to the original transcript,
          // so a later follow-up resumes a clean conversation (no distill turn in it).
          fork: true,
          readOnly: true,
          web: true,
          isolation: "worktree",
          nativeSessionId: run0.nativeSessionId,
          // Deliberately DON'T touch text/segments/report/status/reportPath: this is
          // a background synthesis turn, the visible transcript must stay byte-identical.
          onEvent: (ev) => {
            if (ev.kind === "delta") {
              finalText += ev.text;
            } else if (ev.kind === "done") {
              // The distill has web tools, so its deltas are working narration ahead of the
              // synthesized report — the terminal event's text is the authoritative answer.
              // Adopt it whenever present (deltas only for a degenerate empty terminal event).
              if (ev.text.trim()) finalText = ev.text;
              // The distill IS the latest turn, so its cost is the run's latest cost.
              if (ev.costUsd != null) patch(id, { costUsd: ev.costUsd });
              if (ev.isError) errored = true;
            } else if (ev.kind === "error") {
              // A killed distill's `partialText` is deliberately dropped: the errored
              // path hands off the RAW report, which beats a truncated synthesis of it.
              errored = true;
            }
          },
        });
      } catch {
        // A killed/failed process (incl. cancel) — fall through to the null return.
        errored = true;
      } finally {
        // Capture the verdict BEFORE clearing the flag (clearing it makes superseded() true).
        wasSuperseded = superseded();
        if (!wasSuperseded) patch(id, { distilling: false });
      }
      if (wasSuperseded || errored) return null;
      // Defensively strip a leading fence / pre-heading narration (cleanReportText
      // returns the text unchanged when there's no heading — the brief has no H1).
      const brief = cleanReportText(finalText);
      return brief.trim() ? brief : null;
    },

    cancel: (id) => {
      const run = get().runs.find((r) => r.id === id);
      // Cancel covers both a streaming turn and a running distill. Killing the
      // session makes the in-flight runAgentSession error → distillPlanBrief
      // resolves null → the handoff proceeds with the raw fallback.
      if (run?.distilling) {
        void cancelAgentSession(run.sessionId);
        patch(id, { distilling: false });
        return;
      }
      if (!run?.generating) return;
      void cancelAgentSession(run.sessionId);
      // Settle to a clear stopped state right away; the in-flight turn sees
      // `stopped` when its killed process returns and bails without overwriting.
      patch(id, { generating: false, status: "", stopped: true });
    },

    restart: (id) => {
      const run = get().runs.find((r) => r.id === id);
      if (!run || run.generating || run.distilling) return;
      // Fresh conversation (the stopped one was killed): a new session id so a still-resolving
      // old turn is detected as stale and bails, then re-run turn 1 from the original topic +
      // persona (a mid-session persona switch doesn't carry into a restart).
      const depth = run.origin?.depth ?? run.depth;
      patch(id, {
        sessionId: crypto.randomUUID(),
        nativeSessionId: null,
        depth,
        generating: true,
        status: "",
        stopped: false,
        error: null,
      });
      void runFirstTurn(id, {
        repoPath: run.repoPath,
        agent: run.agent,
        model: run.model,
        effort: run.effort,
        topic: run.seed?.topic ?? run.origin?.topic ?? "",
        depth,
      });
    },

    remove: (id) => {
      const run = get().runs.find((r) => r.id === id);
      if (run?.generating) void cancelAgentSession(run.sessionId);
      set({
        runs: get().runs.filter((r) => r.id !== id),
        activeResearchId:
          get().activeResearchId === id ? null : get().activeResearchId,
      });
    },

    relocateRepoPath: (oldPath, newPath) => {
      // No-match guard: a fresh array would trip the persistence subscribe
      // into rewriting research.json with identical content.
      if (!get().runs.some((r) => norm(r.repoPath) === norm(oldPath))) return;
      set({
        runs: get().runs.map((r) =>
          norm(r.repoPath) === norm(oldPath) ? { ...r, repoPath: newPath } : r,
        ),
      });
    },
  };
});

// Persist the research list to disk, debounced so a streaming run's rapid updates coalesce
// (latest snapshot wins, and it captures the native session id mid-stream so a resume survives
// a restart). Gated on `hydrated` so the initial empty state never clobbers disk.
let saveTimer: ReturnType<typeof setTimeout> | null = null;
useResearchStore.subscribe((state, prev) => {
  if (!state.hydrated || state.runs === prev.runs) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void savePersistedResearch(useResearchStore.getState().runs);
  }, 800);
});

// Load persisted research once at startup (so runs are back in the sidebar).
void useResearchStore.getState().hydrate();

/** The currently-selected research run, or null. Reference-stable while that run
 *  is unchanged (so streaming another run won't re-render the active one). */
export function useActiveResearchRun(): ResearchRun | null {
  return useResearchStore(
    (s) => s.runs.find((r) => r.id === s.activeResearchId) ?? null,
  );
}
