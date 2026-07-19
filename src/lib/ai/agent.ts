import { Channel } from "@tauri-apps/api/core";
import type { McpServer } from "@/lib/settings/api";
import { invoke } from "@/lib/tauri/invoke";
import type { AiProviderId } from "./types";

/** Which agent CLI the Rust backend should drive. */
export type AgentKind = "claude" | "codex" | "copilot" | "opencode";

export type AuthStatus = "authed" | "notAuthed" | "unknown";

export interface AgentInfo {
  found: boolean;
  path: string | null;
  version: string | null;
  authed: AuthStatus;
}

/** A normalized tool category for the activity timeline (mirrors the Rust
 *  `normalize_tool` output). Drives the icon + verb shown per step. */
export type AgentToolKind =
  | "read"
  | "search"
  | "list"
  | "edit"
  | "write"
  | "run"
  | "web-fetch"
  | "web-search"
  | "task"
  | "other";

/** One piece of an agent turn's rendered transcript, in the order it happened: a run of
 *  streamed prose, or a tool step interleaved between prose. Built live from `delta` +
 *  `tool` events so the UI reads as one chronological log (text → tool → text). */
export type TranscriptSegment =
  | { type: "text"; text: string }
  | { type: "tool"; tool: AgentToolKind; target: string | null };

/** The deduped, structured record of what a pipeline stage already examined —
 *  distilled from its transcript's tool steps so the next stage (research → plan →
 *  implement) can be handed it as grounding data instead of re-exploring from zero. */
export interface ContextPack {
  /** File/dir paths the stage read or listed (deduped, first-touch order). */
  files: string[];
  /** Search patterns/queries it ran (deduped). */
  searches: string[];
  /** URLs fetched / web queries run (deduped). */
  web: string[];
}

/** Distill a transcript into a {@link ContextPack}: file reads/lists, searches, and
 *  web fetches/searches, keyed by tool kind. Steps with no target (or another tool
 *  kind — edit/write/run/task/other) are skipped. Each list dedupes on exact string
 *  and preserves first-touch order. */
export function extractContextPack(segments: TranscriptSegment[]): ContextPack {
  const files: string[] = [];
  const searches: string[] = [];
  const web: string[] = [];
  const filesSeen = new Set<string>();
  const searchesSeen = new Set<string>();
  const webSeen = new Set<string>();
  const pushUnique = (seen: Set<string>, list: string[], value: string) => {
    if (seen.has(value)) return;
    seen.add(value);
    list.push(value);
  };
  for (const seg of segments) {
    if (seg.type !== "tool") continue;
    const target = seg.target?.trim();
    if (!target) continue;
    switch (seg.tool) {
      case "read":
      case "list":
        pushUnique(filesSeen, files, target);
        break;
      case "search":
        pushUnique(searchesSeen, searches, target);
        break;
      case "web-fetch":
      case "web-search":
        pushUnique(webSeen, web, target);
        break;
      // edit/write/run/task/other carry no grounding value for the next stage.
    }
  }
  return { files, searches, web };
}

/** Append streamed text to the transcript, coalescing into the trailing text run
 *  (so consecutive deltas don't fragment a paragraph). Returns a new array. */
export function appendTranscriptText(
  segments: TranscriptSegment[],
  text: string,
): TranscriptSegment[] {
  const last = segments[segments.length - 1];
  if (last?.type === "text")
    return [...segments.slice(0, -1), { type: "text", text: last.text + text }];
  return [...segments, { type: "text", text }];
}

/** Append a tool step, which also ends the current text run so the next delta
 *  starts a fresh paragraph after the step. Returns a new array. */
export function appendTranscriptTool(
  segments: TranscriptSegment[],
  tool: AgentToolKind,
  target: string | null,
): TranscriptSegment[] {
  return [...segments, { type: "tool", tool, target }];
}

/** Ensure a turn's final text is represented in the transcript. Whole-message
 *  agents (Codex) emit no `delta`s — only a final text in their `done` event — so
 *  their transcript would otherwise show tool steps but no prose. No-op once any
 *  text run exists (streaming agents already have one). Returns a new array. */
export function ensureTranscriptText(
  segments: TranscriptSegment[],
  text: string,
): TranscriptSegment[] {
  if (!text || segments.some((s) => s.type === "text")) return segments;
  return appendTranscriptText(segments, text);
}

/** Streaming events from `agent_review`, mirroring the Rust `ReviewEvent`. */
export type ReviewEvent =
  | { kind: "delta"; text: string }
  | { kind: "status"; text: string }
  /** One structured tool step (read/edit/run/web-fetch/…) for the activity
   *  timeline; `tool` is the normalized category, `target` the thing it acted on. */
  | { kind: "tool"; tool: AgentToolKind; target: string | null }
  | { kind: "done"; text: string; isError: boolean; costUsd: number | null }
  | { kind: "error"; message: string }
  /** The CLI's own resume id captured on turn 1 (Codex thread / opencode session)
   *  — persisted so a host session resumes the right conversation. Only sessions
   *  care; reviews ignore it. */
  | { kind: "nativeSession"; id: string };

/** Maps a review provider id to its backend agent kind, or null if not a CLI. */
export function providerKind(provider: AiProviderId): AgentKind | null {
  if (provider === "claude-cli") return "claude";
  if (provider === "codex-cli") return "codex";
  if (provider === "copilot-cli") return "copilot";
  if (provider === "opencode-cli") return "opencode";
  return null;
}

/** Resolves the CLI binary and reports version + login status for Settings. */
export const detectAgentCli = (kind: AgentKind, path?: string) =>
  invoke<AgentInfo>("agent_detect", {
    kind,
    binPath: path?.trim() || null,
  });

export interface AgentReviewArgs {
  kind: AgentKind;
  /** Explicit binary path, or null to auto-detect. */
  binPath: string | null;
  model: string;
  /** Reasoning/effort level ("" = provider default; else low/medium/high/xhigh).
   *  Mapped per-CLI in Rust (Codex/Copilot/opencode flags, Claude thinking keyword). */
  effort: string;
  systemPrompt: string;
  /** The diff-bearing prompt, fed to the CLI on stdin. */
  userPrompt: string;
  repoPath: string;
  /** The ORIGIN repo a repo-aware PR-head review was spawned from. `repoPath` may be
   *  a throwaway detached worktree pinned at the PR head; the LAN monitor scopes
   *  streams by origin repo, so pass it to keep the review visible to a paired phone.
   *  Omit for a non-worktree review (the backend falls back to `repoPath`). */
  originRepoPath?: string;
  /** Tier 2: allow the agent read-only access to the repo for context. */
  repoAware: boolean;
  /** Attach GitDesktop's own read-only MCP server (`gitdesktop` tools) to the run so an
   *  agentic reviewer can pull the full PR diff, read files at any ref, blame, and list PR
   *  comments. Reviews only; default off. */
  mcpSelf?: boolean;
  /** Kill-timeout override for the run, in seconds (clamped backend-side to
   *  60–7200); null/absent = the backend's tier defaults (300s, 1200s agentic). */
  timeoutSecs?: number | null;
  /** True only for flows the user's Review-timeout setting governs (the AI reviews).
   *  Drives the timed-out message's settings hint, so generation and Debug-with-AI — which
   *  share this command — don't advertise a knob that can't help them. */
  timeoutConfigurable?: boolean;
  /** Caller-generated id used to cancel this run via `cancelAgentReview`. */
  reviewId: string;
  onEvent: (event: ReviewEvent) => void;
}

/**
 * Runs a streaming review through the agent CLI. Resolves when the backend
 * command returns (terminal `done`/`error` events arrive via `onEvent`).
 */
export async function runAgentReview(args: AgentReviewArgs): Promise<void> {
  const channel = new Channel<ReviewEvent>();
  channel.onmessage = args.onEvent;
  await invoke<void>("agent_review", {
    kind: args.kind,
    binPath: args.binPath,
    model: args.model,
    effort: args.effort,
    systemPrompt: args.systemPrompt,
    userPrompt: args.userPrompt,
    repoPath: args.repoPath,
    originRepoPath: args.originRepoPath ?? null,
    repoAware: args.repoAware,
    mcpSelf: Boolean(args.mcpSelf),
    timeoutSecs: args.timeoutSecs ?? null,
    timeoutConfigurable: Boolean(args.timeoutConfigurable),
    reviewId: args.reviewId,
    onEvent: channel,
  });
}

/** Signals an in-flight review to stop (kills the subprocess). */
export const cancelAgentReview = (reviewId: string) =>
  invoke<void>("agent_review_cancel", { reviewId });

export interface AgentSessionArgs {
  /** Which CLI drives the session. */
  agent: "claude" | "codex" | "copilot" | "opencode";
  /** Explicit binary path for the chosen `agent`, or null to auto-detect. */
  binPath: string | null;
  model: string;
  /** Reasoning/effort level ("" = provider default; else low/medium/high/xhigh).
   *  Mapped per-CLI in Rust (Codex flag, Copilot flag, Claude thinking keyword). */
  effort: string;
  systemPrompt: string;
  /** The task/message for this turn, fed to the CLI on stdin. */
  userPrompt: string;
  /** The directory the agent runs in — a throwaway worktree for a write session,
   *  or the live repo for a read-only Plan conversation. */
  worktreePath: string;
  /** The open repo this session was spawned from. For a write session this is the
   *  parent repo of the `gd/session/*` `worktreePath`; for a read-only Plan/Research
   *  session it's the live repo (same value as `worktreePath`). The LAN monitor
   *  scopes stream visibility to the SHARED repo, which is this value — so a session
   *  spawned from the shared repo stays watchable on a paired phone. */
  originRepoPath: string;
  /** The session's stable uuid (sets `--session-id` on turn 1, `--resume` after);
   *  also the cancel key for `cancelAgentSession`. */
  sessionId: string;
  /** false = first turn (start the session), true = a follow-up turn (resume it). */
  resume: boolean;
  /** Claude-only: a resume turn forks the conversation to a throwaway session id
   *  (`--fork-session`) so it reads the full transcript as context without polluting it.
   *  Ignored by the other agents. Set only by the research→plan distill turn. */
  fork?: boolean;
  /** Read-only mode (a Plan conversation): swaps each CLI's write toolset for its
   *  read-only one, so the resumable turn can explore but never write. */
  readOnly: boolean;
  /** Web-enabled read-only profile (a Research conversation): each CLI gains its native web
   *  tools (Claude WebSearch/WebFetch, Codex live web_search, Copilot web_fetch, opencode a
   *  generated read-only-web agent), so the turn can investigate the web while still never
   *  writing. Ignored without `readOnly`; omitted everywhere else (Plan, Delegate). */
  web?: boolean;
  /** Isolation mode, fixed at session creation. "container" runs the turn inside
   *  a Docker/Podman container; anything else runs on the host (worktree-confined
   *  by each CLI's own OS sandbox). */
  isolation: string;
  /** The CLI's native resume id from turn 1 (the `nativeSession` event), passed
   *  back on resume so a host session continues the right conversation (Codex
   *  thread / opencode session); null otherwise. */
  nativeSessionId: string | null;
  /** The session's opted-in MCP servers (resolved registry definitions, secrets
   *  excluded — the backend pulls those from the keychain). Omitted = no MCP.
   *  Honored for host Claude/Copilot/opencode and container Codex sessions (see
   *  `mcpSupportedFor`); other combinations omit it. */
  mcpServers?: McpServer[];
  onEvent: (event: ReviewEvent) => void;
}

/**
 * Runs one turn of a write-capable agent session: the CLI implements
 * `userPrompt` full-auto inside the worktree, streaming the same events as a
 * review. Follow-up turns (`resume: true`) keep the full conversation + worktree
 * state. On the host each CLI is worktree-confined — Codex via its own OS sandbox
 * (`-s workspace-write`), the others "soft" (Claude `bypassPermissions`, Copilot
 * `--add-dir`, opencode `--dangerously-skip-permissions`); Claude and Codex can
 * also run in a container (kernel boundary).
 */
export async function runAgentSession(args: AgentSessionArgs): Promise<void> {
  const channel = new Channel<ReviewEvent>();
  channel.onmessage = args.onEvent;
  await invoke<void>("agent_session", {
    agent: args.agent,
    binPath: args.binPath,
    model: args.model,
    effort: args.effort,
    systemPrompt: args.systemPrompt,
    userPrompt: args.userPrompt,
    worktreePath: args.worktreePath,
    originRepoPath: args.originRepoPath,
    sessionId: args.sessionId,
    resume: args.resume,
    fork: args.fork ?? false,
    readOnly: args.readOnly,
    web: args.web ?? false,
    isolation: args.isolation,
    nativeSessionId: args.nativeSessionId,
    mcpServers: args.mcpServers,
    onEvent: channel,
  });
}

/** Signals an in-flight session to stop (shares the backend cancel registry). */
export const cancelAgentSession = (sessionId: string) =>
  invoke<void>("agent_review_cancel", { reviewId: sessionId });
