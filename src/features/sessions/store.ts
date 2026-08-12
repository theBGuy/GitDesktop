import { toast } from "sonner";
import { create } from "zustand";
import {
  appendTranscriptText,
  appendTranscriptTool,
  cancelAgentSession,
  runAgentSession,
  type TranscriptSegment,
} from "@/lib/ai/agent";
import { cleanupContainerSandbox, stopTestContainer } from "@/lib/ai/sandbox";
import { terminalErrorMessage } from "@/lib/ai/terminal-error";
import { repoIdentity } from "@/lib/git/repo-identity";
import {
  commitWorktreeAll,
  createWorktree,
  listWorktrees,
  pruneWorktrees,
  removeWorktree,
  resumeWorktree,
  squashWorktree,
} from "@/lib/git/worktree";
import { notify } from "@/lib/notify";
import { loadSettings } from "@/lib/settings/api";
import {
  isServerAvailable,
  mcpServerUsableBy,
  mcpSupportedFor,
} from "@/lib/settings/mcp";
import { pushNotification, repoNameFromPath } from "@/lib/stores/notifications";
import { errorMessage } from "@/lib/tauri/invoke";
import { toastError } from "@/lib/toast";
import { bumpNavVersion } from "./navVersion";
import {
  appendEffort,
  appendMcp,
  appendModel,
  appendNativeSession,
  appendResult,
  appendTurn,
  createTranscript,
  loadPersistedSessions,
  removeTranscript,
  setKept,
} from "./persistence";
import { sessionStatus } from "./status";
import { isWatchingAgentSurface } from "./watching";

/** Fire-and-forget a transcript write: persistence must never break a session,
 *  so swallow + log failures. Per-session append ordering is preserved by the
 *  store calling these in sequence (and a process-wide lock in Rust). */
const persist = (p: Promise<unknown>) =>
  void p.catch((e) => console.error("[sessions] persist failed", e));

export type TurnStatus = "running" | "committing" | "done" | "error";

/** One round-trip in a session: the user's message + the agent's response, and
 *  the per-turn checkpoint commit it produced. */
export interface SessionTurn {
  prompt: string;
  /** Streamed assistant narration for this turn. */
  narration: string;
  status: TurnStatus;
  /** Transient tool-activity note while running. */
  statusText: string;
  /** The interleaved render of this turn — prose runs + tool steps in order (`narration` is
   *  the same prose concatenated, kept for persistence/parsing). In-memory only; absent on a
   *  reloaded session, where the renderer falls back to `narration`. */
  segments?: TranscriptSegment[];
  /** This turn's checkpoint commit (null = the turn changed nothing). */
  commitHash: string | null;
  costUsd: number | null;
  error: string | null;
}

export interface AgentSession {
  /** Stable id (the worktree dir name + branch suffix). */
  id: string;
  repoPath: string;
  worktreePath: string;
  branch: string;
  /** Commit the worktree was created from — base for the cumulative diff. */
  base: string;
  /** Latest checkpoint commit (= base until the first turn commits). */
  headHash: string;
  /** Claude session uuid: `--session-id` on turn 1, `--resume` after; also the cancel key. */
  claudeSessionId: string;
  /** Current model for the next turn ("" = account default). Changeable mid-session. */
  model: string;
  /** Reasoning/effort level for the next turn ("" = provider default; else
   *  low/medium/high/xhigh). Changeable mid-session; mapped per-CLI in Rust. */
  effort: string;
  /** Isolation mode, fixed at creation: "worktree" (host, worktree-confined by the
   *  CLI's own OS sandbox) or "container" (also inside a Docker/Podman container). */
  isolation: "worktree" | "container";
  /** Which CLI drives the session, fixed at creation. */
  agent: "claude" | "codex" | "copilot" | "opencode";
  /** Ids of the MCP servers this session opted into (resolved to their registry
   *  definitions at each turn). Changeable mid-session; absent/empty = no MCP. */
  mcpServers?: string[];
  /** The CLI's native resume id, captured from turn 1 (Codex thread / opencode
   *  session) — lets a host session resume the right conversation (each shares its
   *  CLI home). Unset for Claude / Copilot / container / pre-turn-1. */
  nativeSessionId?: string;
  /** If this session is one arm of a best-of-N ensemble, the shared id of that ensemble —
   *  set at creation, identical across members. In-memory only: siblings group within a run,
   *  not across an app restart (the sessions persist; only the grouping is ephemeral). */
  ensembleId?: string;
  /** A turn is currently streaming for THIS session (sessions run independently). */
  running: boolean;
  /** Kept: the work was finalized onto `branch` and the worktree removed to free
   *  disk; the session lingers as a resumable record. `resume` re-creates the
   *  worktree on `branch` so the conversation can continue. */
  kept: boolean;
  turns: SessionTurn[];
}

const SYSTEM_PROMPT =
  "You are an autonomous coding agent working inside an isolated, throwaway git " +
  "worktree — a separate checkout, so you cannot affect the user's main working " +
  "tree or branch. Implement the user's request directly by editing files in the " +
  "current directory. This is a continuing conversation: later messages refine or " +
  "build on your earlier work in this same worktree. Make focused, working changes. " +
  "A token like `@path/to/file` in the user's message is a reference to that file " +
  "in this worktree — read it for context (and edit it if the request implies). " +
  "Do NOT commit — the app commits each turn so the user can review it. When " +
  "finished with a turn, briefly summarize what you changed.";

/**
 * The handoff record that seeds the new-session composer.
 *
 * Everything past `prompt` is the composer's start-state, carried across a Settings
 * round-trip: the isolation note's "Set up in Settings…" jump unmounts RepositoryView
 * (App.tsx renders it behind `view === "repo"`), so the composer's local state would
 * otherwise be lost and the task could run as an agent the user didn't choose. A plain
 * handoff sets none of them and the composer keeps its own values.
 */
export interface PendingTask {
  repoPath: string;
  prompt: string;
  /** Absent = no explicit pick was made, so there's nothing to restore. */
  isolation?: "worktree" | "container";
  agent?: "claude" | "codex" | "copilot" | "opencode";
  /** "" = the account default model. */
  model?: string;
  /** "" = Auto. */
  effort?: string;
  mode?: "single" | "ensemble";
  /** Stashed verbatim — `null` is meaningful (follow the per-repo default set),
   *  and is NOT the same as absent. */
  mcpServers?: string[] | null;
}

interface SessionsState {
  /** All sessions, in creation order. Each runs in its own worktree. */
  sessions: AgentSession[];
  /** The session shown in the main canvas; null = the "new session" composer. */
  activeId: string | null;
  /** A new session's worktree is being created. */
  creating: boolean;
  /** The session currently being kept/discarded (its actions are disabled). */
  busyId: string | null;
  /** Whether persisted sessions have been loaded + reconciled (gates persisting). */
  hydrated: boolean;
  /** A task to seed the new-session ("Delegate") composer — set by a handoff, consumed and
   *  cleared by the activation composer. Crosses the tab/Activity boundary without an
   *  imperative ref; `repoPath` scopes it to that repo's composer. */
  pendingTask: PendingTask | null;
  hydrate: () => Promise<void>;
  setActive: (id: string | null) => void;
  setPendingTask: (task: PendingTask | null) => void;
  start: (
    repoPath: string,
    prompt: string,
    model: string,
    agent: "claude" | "codex" | "copilot" | "opencode",
    effort: string,
    ensembleId?: string,
    mcpServers?: string[],
    /** Per-session override of the global isolation setting (the composer's
     *  Isolation row). Absent = follow Settings → AI. */
    isolation?: "worktree" | "container",
  ) => Promise<string | null>;
  /** Best-of-N: start one session per `arm` on the SAME task, sharing one ensemble id, so
   *  they can be reviewed side by side and the best kept. Each arm runs its own
   *  agent/model/effort — diversity is the point. Returns the new ids (selects the first);
   *  the cost guardrail is the caller's job. */
  startEnsemble: (
    repoPath: string,
    prompt: string,
    arms: {
      agent: "claude" | "codex" | "copilot" | "opencode";
      model: string;
      effort: string;
    }[],
    /** MCP server ids shared across every arm (each arm drops the ones its own
     *  agent/isolation can't use). Absent/empty = no MCP. */
    mcpServers?: string[],
    /** Per-session isolation override, shared by every arm. Absent = follow
     *  Settings → AI. */
    isolation?: "worktree" | "container",
  ) => Promise<string[]>;
  send: (id: string, prompt: string) => Promise<void>;
  setModel: (id: string, model: string) => void;
  setEffort: (id: string, effort: string) => void;
  /** Change a live session's opted-in MCP servers; applies from the next turn. */
  setSessionMcp: (id: string, mcpServers: string[]) => void;
  cancel: (id: string) => Promise<void>;
  keep: (id: string, squash: boolean) => Promise<void>;
  /** Best-of-N resolution: keep session `id` (the winner), then discard its idle,
   *  non-kept ensemble siblings. Plain keep for a session with no ensemble. */
  keepWinner: (id: string, squash: boolean) => Promise<void>;
  resume: (id: string) => Promise<void>;
  discard: (id: string) => Promise<void>;
  /** Remove a kept session's record (its branch is preserved). */
  deleteSession: (id: string) => void;
}

function newTurn(prompt: string): SessionTurn {
  return {
    prompt,
    narration: "",
    status: "running",
    statusText: "Starting the agent…",
    segments: [],
    commitHash: null,
    costUsd: null,
    error: null,
  };
}

type Get = () => SessionsState;
type SetState = (partial: Partial<SessionsState>) => void;

/** Normalize a path for comparison (git reports forward slashes; Windows paths
 *  arrive with backslashes, and are case-insensitive). */
function normPath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

/** A session loaded from disk can't have a live turn — its CLI process is gone.
 *  Mark a mid-run turn as interrupted so the session is idle (resumes on the
 *  next message). */
function markInterrupted(s: AgentSession): AgentSession {
  const i = s.turns.length - 1;
  const last = s.turns[i];
  if (
    !s.running &&
    !(last?.status === "running" || last?.status === "committing")
  )
    return { ...s, running: false };
  const turns = s.turns.slice();
  if (last)
    turns[i] = {
      ...last,
      status: last.status === "done" ? "done" : "error",
      error:
        last.status === "running" || last.status === "committing"
          ? "Interrupted by restart."
          : last.error,
      statusText: "",
    };
  return { ...s, running: false, turns };
}

/** Removes a session from the list, moving `activeId` to a survivor (or null). */
function removeSession(get: Get, set: SetState, id: string) {
  const remaining = get().sessions.filter((s) => s.id !== id);
  const activeId =
    get().activeId === id
      ? (remaining[remaining.length - 1]?.id ?? null)
      : get().activeId;
  set({ sessions: remaining, activeId, busyId: null });
}

/**
 * Runs session `id`'s LAST (already-appended) turn: streams the agent into it, then commits
 * the turn as a checkpoint. Each `set` maps over the CURRENT sessions array and touches only
 * this id, so concurrent sessions don't clobber each other; every write re-checks the
 * session still exists (it may have been discarded mid-stream).
 */
async function runTurn(
  get: Get,
  set: SetState,
  id: string,
  prompt: string,
  resume: boolean,
) {
  const find = () => get().sessions.find((s) => s.id === id);
  const s0 = find();
  if (!s0) return;
  const {
    claudeSessionId,
    worktreePath,
    model,
    effort,
    isolation,
    agent,
    nativeSessionId,
  } = s0;

  // Resolve the session's opted-in MCP ids against the CURRENT registry (re-read each turn,
  // so editing a server applies next turn) and drop any no longer OFFERED in this repo —
  // re-scoping a server away or setting it per-repo "off" stops it applying, matching what
  // the picker would now offer. The backend resolves secrets from the keychain.
  const mcpIds = s0.mcpServers ?? [];
  // Scope/override lookup keys for the session's repo (its worktree-stable
  // identity + the raw checkout path), so a server scoped/overridden from a
  // sibling worktree still resolves as OFFERED here.
  const repoKeys = mcpIds.length
    ? await repoIdentity(s0.repoPath).then((id) =>
        id !== s0.repoPath ? [s0.repoPath, id] : [s0.repoPath],
      )
    : [];
  const mcpServers = mcpIds.length
    ? ((await loadSettings().catch(() => null))?.mcpServers ?? []).filter(
        (srv) =>
          mcpIds.includes(srv.id) &&
          isServerAvailable(srv, repoKeys) &&
          mcpServerUsableBy(srv, s0.agent),
      )
    : undefined;

  const setSession = (updater: (s: AgentSession) => AgentSession) =>
    set({
      sessions: get().sessions.map((s) => (s.id === id ? updater(s) : s)),
    });
  const patchTurn = (p: Partial<SessionTurn>) =>
    setSession((s) => {
      if (s.turns.length === 0) return s;
      const turns = s.turns.slice();
      turns[turns.length - 1] = { ...turns[turns.length - 1], ...p };
      return { ...s, turns };
    });
  // End of a turn: persist the now-terminal last turn (one append per turn) and,
  // unless you're watching this session live, fire an OS notification.
  const endTurn = () => {
    const s = find();
    const i = (s?.turns.length ?? 0) - 1;
    const t = s?.turns[i];
    if (!s || !t) return;
    persist(
      appendResult(
        id,
        i,
        t.status,
        t.narration,
        t.segments,
        t.commitHash,
        t.costUsd,
        t.error,
      ),
    );
    // "Watching" = focused + this session's repo open on its Agent tab + this session
    // selected; then the streamed result is already visible, so stay quiet. Notifying
    // otherwise covers multi-session, other-repo and other-tab cases. A user Cancel is
    // intentional, so it's never announced.
    if (isWatchingAgentSurface(get().activeId, id, s.repoPath)) return;
    if (t.status === "error" && t.error === "Cancelled.") return;
    const label =
      s.turns[0]?.prompt.trim().replace(/\s+/g, " ").slice(0, 70) ||
      "Agent session";
    const failed = sessionStatus(s).kind === "error";
    const headline = failed ? "Agent failed" : "Agent finished";
    void notify(headline, label);
    pushNotification({
      kind: "agent-done",
      tone: failed ? "danger" : "success",
      title: headline,
      subtitle: label,
      repoPath: s.repoPath,
      repoName: repoNameFromPath(s.repoPath),
      target: { type: "agent" },
      dedupeKey: `agent:${id}:${i}`,
    });
  };

  setSession((s) => ({ ...s, running: true }));
  try {
    await runAgentSession({
      binPath: null,
      model,
      effort,
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: prompt,
      worktreePath,
      sessionId: claudeSessionId,
      resume,
      readOnly: false,
      isolation,
      agent,
      nativeSessionId: nativeSessionId ?? null,
      mcpServers,
      onEvent: (ev) => {
        const s = find();
        if (!s) return;
        if (ev.kind === "nativeSession") {
          // Capture once (turn 1) + persist, so a host resume targets this session.
          if (!s.nativeSessionId) {
            setSession((x) => ({ ...x, nativeSessionId: ev.id }));
            persist(appendNativeSession(id, ev.id));
          }
          return;
        }
        const last = s.turns[s.turns.length - 1];
        if (!last) return;
        if (ev.kind === "delta")
          patchTurn({
            narration: last.narration + ev.text,
            segments: appendTranscriptText(last.segments ?? [], ev.text),
            statusText: "",
          });
        else if (ev.kind === "status") patchTurn({ statusText: ev.text });
        else if (ev.kind === "tool")
          patchTurn({
            segments: appendTranscriptTool(
              last.segments ?? [],
              ev.tool,
              ev.target,
            ),
            statusText: "",
          });
        else if (ev.kind === "error")
          patchTurn({ status: "error", error: ev.message, statusText: "" });
        else if (ev.kind === "done")
          patchTurn({
            costUsd: ev.costUsd,
            statusText: "",
            // Codex delivers its whole message in the done event, not as `delta`s, so adopt
            // `ev.text` when nothing was streamed — otherwise the turn shows blank. Added as
            // a text segment too so the transcript shows it after its tool steps; streaming
            // agents already have both. Never on an errored Done, whose text is the failure
            // REASON — adopting it would render the reason as the agent's own message.
            ...(ev.text && !last.narration && !ev.isError
              ? {
                  narration: ev.text,
                  segments: appendTranscriptText(last.segments ?? [], ev.text),
                }
              : {}),
            ...(ev.isError
              ? {
                  status: "error",
                  error: terminalErrorMessage(
                    ev.text,
                    "The agent reported an error.",
                  ),
                }
              : {}),
          });
      },
    });
  } catch (e) {
    patchTurn({ status: "error", error: errorMessage(e), statusText: "" });
    setSession((s) => ({ ...s, running: false }));
    endTurn();
    return;
  }

  const s1 = find();
  if (!s1) return;
  if (s1.turns[s1.turns.length - 1]?.status === "error") {
    setSession((s) => ({ ...s, running: false }));
    endTurn();
    return;
  }
  patchTurn({ status: "committing", statusText: "Committing this turn…" });
  try {
    const msg = prompt.split("\n")[0].slice(0, 72).trim() || "Agent turn";
    const hash = await commitWorktreeAll(worktreePath, msg);
    setSession((s) => {
      const turns = s.turns.slice();
      turns[turns.length - 1] = {
        ...turns[turns.length - 1],
        status: "done",
        statusText: "",
        commitHash: hash,
      };
      return { ...s, running: false, turns, headHash: hash ?? s.headHash };
    });
    endTurn();
  } catch (e) {
    patchTurn({ status: "error", error: errorMessage(e), statusText: "" });
    setSession((s) => ({ ...s, running: false }));
    endTurn();
  }
}

/**
 * Concurrent, multi-turn agent sessions: each runs full-auto in its own
 * throwaway worktree, streaming independently. Start a session → run turns
 * (each resumes the prior context, commits a checkpoint) → Keep (optionally
 * squashing the per-turn commits) or Discard.
 */
export const useSessionsStore = create<SessionsState>((set, get) => ({
  sessions: [],
  activeId: null,
  creating: false,
  busyId: null,
  hydrated: false,
  pendingTask: null,

  hydrate: async () => {
    if (get().hydrated) return;
    let persisted: AgentSession[] = [];
    try {
      persisted = await loadPersistedSessions();
    } catch {
      // No store yet / unreadable — start clean.
    }
    if (persisted.length) {
      const idled = persisted.map(markInterrupted);
      // Reconcile per repo: prune orphan admin entries, then keep only sessions
      // whose worktree still exists on disk (a crash/reload may have left some).
      const repos = [...new Set(idled.map((s) => s.repoPath))];
      const live: Record<string, Set<string>> = {};
      for (const repo of repos) {
        try {
          await pruneWorktrees(repo);
          const list = await listWorktrees(repo);
          live[repo] = new Set(list.map((w) => normPath(w.path)));
        } catch {
          // Repo unreadable/gone → its sessions drop out (no entry in `live`).
        }
      }
      // Kept sessions intentionally have no worktree (freed on Keep) — spare
      // them from the orphan sweep; everything else must have a live worktree.
      const alive = idled.filter(
        (s) => s.kept || live[s.repoPath]?.has(normPath(s.worktreePath)),
      );
      // A non-kept session whose repo WAS reachable but whose worktree is gone is confirmed
      // dead — delete its transcript. Sessions in an unreachable repo are kept on disk and
      // return when the repo is back, rather than being silently lost.
      for (const s of idled) {
        if (
          !s.kept &&
          live[s.repoPath] &&
          !live[s.repoPath].has(normPath(s.worktreePath))
        )
          persist(removeTranscript(s.id));
      }
      // Merge under any sessions created before hydration finished (newest state
      // wins) — `start` isn't gated on hydration, so a replace would drop one.
      const created = new Set(get().sessions.map((s) => s.id));
      set({
        sessions: [
          ...alive.filter((s) => !created.has(s.id)),
          ...get().sessions,
        ],
      });
    }
    set({ hydrated: true });
  },

  setActive: (id) => {
    // Tick the agent-surface nav counter so an in-flight handoff can tell the
    // user navigated (see navVersion.ts).
    bumpNavVersion();
    set({ activeId: id });
  },

  setPendingTask: (pendingTask) => set({ pendingTask }),

  start: async (
    repoPath,
    prompt,
    model,
    agent,
    effort,
    ensembleId,
    mcpServers,
    isolationOverride,
  ) => {
    const task = prompt.trim();
    if (!task || get().creating) return null;
    set({ creating: true });
    // Isolation is fixed for the life of the session (every turn must run the same way), so
    // resolve it once. On the host every agent is worktree-confined by its own OS sandbox
    // (Codex via `-s workspace-write`); "container" adds a kernel boundary. Every agent
    // honors it — Copilot's container authenticates from `gh auth token` (no mountable creds
    // file). The composer's Isolation row overrides for THIS session; the global setting is
    // only read (`??` short-circuits the await) when it didn't.
    const isolation =
      isolationOverride ??
      (await loadSettings().catch(() => null))?.agentIsolation ??
      "worktree";
    let wt: Awaited<ReturnType<typeof createWorktree>>;
    try {
      wt = await createWorktree(repoPath);
    } catch (e) {
      toastError(e);
      set({ creating: false });
      return null;
    }
    const session: AgentSession = {
      id: wt.id,
      repoPath,
      worktreePath: wt.path,
      branch: wt.branch,
      base: wt.base,
      headHash: wt.base,
      claudeSessionId: crypto.randomUUID(),
      model,
      effort,
      isolation,
      agent,
      // MCP runs in the supported (agent, isolation) combos (host + container for
      // Claude/Copilot/opencode, container for Codex); drop the selection for any
      // unsupported combo so a session never carries servers the backend would reject.
      mcpServers: mcpSupportedFor(agent, isolation === "container")
        ? mcpServers
        : undefined,
      ensembleId,
      running: false,
      kept: false,
      turns: [newTurn(task)],
    };
    set({
      creating: false,
      sessions: [...get().sessions, session],
      activeId: wt.id,
    });
    persist(
      createTranscript({
        id: session.id,
        repoPath: session.repoPath,
        worktreePath: session.worktreePath,
        branch: session.branch,
        base: session.base,
        claudeSessionId: session.claudeSessionId,
        model: session.model,
        isolation: session.isolation,
        agent: session.agent,
        effort: session.effort,
        mcpServers: session.mcpServers,
      }),
    );
    persist(appendTurn(wt.id, 0, task, model));
    // Fire the first turn in the background and return the new session id so a caller (e.g.
    // the plan "Implement") can link to it.
    void runTurn(get, set, wt.id, task, false);
    return wt.id;
  },

  startEnsemble: async (repoPath, prompt, arms, mcpServers, isolation) => {
    const task = prompt.trim();
    if (!task || arms.length === 0) return [];
    // One shared id ties the arms together; each is otherwise a normal session
    // with its own worktree/branch so there's no shared state and no merge.
    const ensembleId = crypto.randomUUID();
    const ids: string[] = [];
    // Sequential, not Promise.all: start() guards on `creating` and each
    // createWorktree must settle before the next (they'd otherwise race the
    // worktree name counter). N is small (≤ a handful), so this is fine.
    for (const arm of arms) {
      const id = await get().start(
        repoPath,
        task,
        arm.model,
        arm.agent,
        arm.effort,
        ensembleId,
        // The shared MCP selection; start() drops it for an arm whose
        // agent/isolation can't run MCP, and runTurn filters per-agent each turn.
        mcpServers,
        // One shared isolation for the whole ensemble (arms differ by agent/model,
        // never by how they're sandboxed).
        isolation,
      );
      if (id) ids.push(id);
    }
    // Land on the first arm so the ensemble is visible immediately.
    if (ids[0]) set({ activeId: ids[0] });
    return ids;
  },

  send: async (id, prompt) => {
    const s = get().sessions.find((x) => x.id === id);
    // A kept session has no worktree to run in — it must be resumed first.
    if (!s || s.running || s.kept) return;
    const task = prompt.trim();
    if (!task) return;
    const seq = s.turns.length;
    set({
      sessions: get().sessions.map((x) =>
        x.id === id ? { ...x, turns: [...x.turns, newTurn(task)] } : x,
      ),
    });
    persist(appendTurn(id, seq, task, s.model));
    await runTurn(get, set, id, task, true);
  },

  setModel: (id, model) => {
    set({
      sessions: get().sessions.map((s) => (s.id === id ? { ...s, model } : s)),
    });
    persist(appendModel(id, model));
  },

  setEffort: (id, effort) => {
    set({
      sessions: get().sessions.map((s) => (s.id === id ? { ...s, effort } : s)),
    });
    persist(appendEffort(id, effort));
  },

  // Mid-session MCP change: update live state (runTurn re-resolves ids→specs each
  // turn, so it takes effect next turn) and persist so a reload keeps the choice.
  setSessionMcp: (id, mcpServers) => {
    set({
      sessions: get().sessions.map((s) =>
        s.id === id ? { ...s, mcpServers } : s,
      ),
    });
    persist(appendMcp(id, mcpServers));
  },

  cancel: async (id) => {
    const s = get().sessions.find((x) => x.id === id);
    if (!s || !s.running) return;
    try {
      await cancelAgentSession(s.claudeSessionId);
    } catch (e) {
      toastError(e);
    }
    set({
      sessions: get().sessions.map((x) => {
        if (x.id !== id) return x;
        const turns = x.turns.slice();
        const i = turns.length - 1;
        if (
          i >= 0 &&
          (turns[i].status === "running" || turns[i].status === "committing")
        )
          turns[i] = {
            ...turns[i],
            status: "error",
            error: "Cancelled.",
            statusText: "",
          };
        return { ...x, running: false, turns };
      }),
    });
  },

  keep: async (id, squash) => {
    const s = get().sessions.find((x) => x.id === id);
    if (!s || s.kept || s.running || get().busyId) return;
    set({ busyId: id });
    try {
      // A running test container bind-mounts this worktree; stop it first so its
      // mount can't block removing the dir and doesn't linger after Keep.
      if (s.isolation === "container")
        await stopTestContainer(s.worktreePath).catch(() => undefined);
      if (squash && s.headHash !== s.base) {
        const msg =
          s.turns[0]?.prompt.split("\n")[0].slice(0, 72).trim() ||
          "Agent session";
        await squashWorktree(s.worktreePath, s.base, msg);
      }
      // Free the worktree dir but keep the branch (it holds the work). The
      // session lingers as a `kept` record you can resume later.
      await removeWorktree(s.repoPath, s.worktreePath, null, false);
      toast.success(`Kept on branch ${s.branch}`);
      persist(setKept(id, true));
      set({
        busyId: null,
        sessions: get().sessions.map((x) =>
          x.id === id ? { ...x, kept: true, running: false } : x,
        ),
      });
    } catch (e) {
      toastError(e);
      set({ busyId: null });
    }
  },

  keepWinner: async (id, squash) => {
    const me = get().sessions.find((x) => x.id === id);
    if (!me) return;
    await get().keep(id, squash);
    // Only drop the siblings if the keep actually landed (it no-ops while busy).
    if (!get().sessions.find((x) => x.id === id)?.kept || !me.ensembleId)
      return;
    // Discard the other arms — idle, non-kept members of the same ensemble.
    // Sequential because discard() serializes on busyId; running arms are left
    // for the user to stop, kept arms are independent records.
    const siblings = get().sessions.filter(
      (x) =>
        x.ensembleId === me.ensembleId && x.id !== id && !x.kept && !x.running,
    );
    for (const s of siblings) await get().discard(s.id);
  },

  resume: async (id) => {
    const s = get().sessions.find((x) => x.id === id);
    if (!s || !s.kept || get().busyId) return;
    set({ busyId: id });
    try {
      // Re-create the worktree on the kept branch (which holds the work); the
      // conversation resumes via `--resume` on the next message.
      await resumeWorktree(s.repoPath, s.worktreePath, s.branch);
      persist(setKept(id, false));
      set({
        busyId: null,
        sessions: get().sessions.map((x) =>
          x.id === id ? { ...x, kept: false } : x,
        ),
      });
    } catch (e) {
      toastError(e);
      set({ busyId: null });
    }
  },

  discard: async (id) => {
    const s = get().sessions.find((x) => x.id === id);
    if (!s || s.kept || s.running || get().busyId) return;
    set({ busyId: id });
    // The container home holds a credentials copy and is independent of the worktree, so clean
    // it (idempotently) up front — a failed worktree removal shouldn't leave it. A running test
    // container bind-mounts the worktree, so stop it (awaited) before removing the dir.
    if (s.isolation === "container") {
      persist(cleanupContainerSandbox(id));
      await stopTestContainer(s.worktreePath).catch(() => undefined);
    }
    try {
      await removeWorktree(s.repoPath, s.worktreePath, s.branch, true);
      persist(removeTranscript(id));
      removeSession(get, set, id);
    } catch (e) {
      toastError(e);
      set({ busyId: null });
    }
  },

  // Remove a kept session's record. Its branch is left intact (the work was
  // kept); the user can delete the branch via the Branches view if they want.
  deleteSession: (id) => {
    const s = get().sessions.find((x) => x.id === id);
    if (!s || !s.kept) return;
    persist(removeTranscript(id));
    if (s.isolation === "container") persist(cleanupContainerSandbox(id));
    removeSession(get, set, id);
  },
}));

// Persistence is event-sourced: each action appends the one transcript event it
// produced (the `persist(...)` calls above) — no whole-list write to maintain.

// Load persisted sessions + reconcile orphaned worktrees once at startup (sessions survive a
// restart: worktrees + CLI transcripts live on disk, so a follow-up message resumes).
void useSessionsStore.getState().hydrate();
