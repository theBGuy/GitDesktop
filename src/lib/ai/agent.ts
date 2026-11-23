import { Channel } from "@tauri-apps/api/core";
import type { AppSettings, McpServer } from "@/lib/settings/api";
import { invoke } from "@/lib/tauri/invoke";
import { type ChannelGate, createChannelGate } from "./stream-settle";
import type { AiProviderId } from "./types";

const AGENT_KINDS = ["claude", "codex", "copilot", "opencode"] as const;

/** Which agent CLI the Rust backend should drive. Derived from the list so a new
 *  entry widens the type and `isAgentKind` together. */
export type AgentKind = (typeof AGENT_KINDS)[number];

/** Whether a raw value names an agent CLI — a picker hands back its select's
 *  own value (`string | null`), and an unrecognized one falls back to a
 *  default. */
export function isAgentKind(value: unknown): value is AgentKind {
  return (
    typeof value === "string" &&
    (AGENT_KINDS as readonly string[]).includes(value)
  );
}

/** Mirrors the Rust `AuthStatus`. `unreachable` = the sign-in check never got an
 *  answer on the credential (an outage); only About's gh/glab rows produce it. */
export type AuthStatus = "authed" | "notAuthed" | "unreachable" | "unknown";

export interface AgentInfo {
  found: boolean;
  path: string | null;
  version: string | null;
  authed: AuthStatus;
  /** The backend's standing sentence for a found binary it will not run (an opencode
   *  outside the supported range), else null. Rendered verbatim; only its presence
   *  is ever tested. Optional: older literals omit it. */
  unsupported?: string | null;
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
 *  streamed prose, a tool step interleaved between prose, or a note from GitDesktop
 *  itself (a `notice` event: never the agent's output). Built live from the stream
 *  events so the UI reads as one chronological log (text → tool → text). */
export type TranscriptSegment =
  | { type: "text"; text: string }
  | { type: "tool"; tool: AgentToolKind; target: string | null }
  | { type: "note"; text: string };

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

/** Append a note, which ends the current text run like a tool step. Returns
 *  `segments` unchanged for an empty or whitespace-only text. */
export function appendTranscriptNote(
  segments: TranscriptSegment[],
  text: string,
): TranscriptSegment[] {
  if (!text.trim()) return segments;
  return [...segments, { type: "note", text }];
}

/** The notice that the turn's conversation was restarted (mirrors the Rust
 *  `NOTICE_SESSION_RESET`). */
const NOTICE_SESSION_RESET = "nativeSessionReset";

/** The notice codes after which the run's next `nativeSession` replaces the stored
 *  conversation id (mirrors the Rust `NOTICE_SESSION_RESET` / `NOTICE_SESSION_REKEY`). */
const NOTICE_REPLACES_NATIVE_SESSION: ReadonlySet<string> = new Set([
  NOTICE_SESSION_RESET,
  "nativeSessionRekey",
]);
/** Notices that show nothing: a successful sign-in copy is the expected case. */
const NOTICE_SILENT: ReadonlySet<string> = new Set(["signInsCopied"]);

/** What a store does with one notice. `note` is the text to show, or null.
 *  `replaceNativeSession`: the next `nativeSession` of the SAME run replaces the
 *  stored id; the notice alone never drops it, so a turn that ends without one
 *  leaves the stored id as it was. Unknown codes show their text and change nothing. */
export function noticeEffect(ev: { code: string; text: string }): {
  note: string | null;
  replaceNativeSession: boolean;
} {
  const shown =
    !NOTICE_SILENT.has(ev.code) &&
    typeof ev.text === "string" &&
    ev.text.trim() !== "";
  return {
    note: shown ? ev.text : null,
    replaceNativeSession: NOTICE_REPLACES_NATIVE_SESSION.has(ev.code),
  };
}

/** Streaming events from `agent_review`, mirroring the Rust `ReviewEvent`. */
export type ReviewEvent =
  | { kind: "delta"; text: string }
  | { kind: "status"; text: string }
  /** One structured tool step (read/edit/run/web-fetch/…) for the activity
   *  timeline; `tool` is the normalized category, `target` the thing it acted on. */
  | { kind: "tool"; tool: AgentToolKind; target: string | null }
  | { kind: "done"; text: string; isError: boolean; costUsd: number | null }
  /** Terminal failure. `partialText` carries output a whole-message CLI (Codex)
   *  accumulated but never streamed as deltas — null when the run's text already
   *  streamed. `timedOut` marks the backend's own kill at the run deadline. Both keys
   *  always ship (see `review_event_wire_shape_is_camel_case`). */
  | {
      kind: "error";
      message: string;
      partialText: string | null;
      timedOut: boolean;
    }
  /** The CLI's own resume id captured on turn 1 (Codex thread / opencode session)
   *  — persisted so a host session resumes the right conversation. Only sessions
   *  care; reviews ignore it. */
  | { kind: "nativeSession"; id: string }
  /** A one-line note for the turn's timeline that is not the agent's output; `code`
   *  says what a store does with it (`noticeEffect`), `text` is the finished sentence
   *  or empty. Only `agent_session` turns send it. */
  | { kind: "notice"; code: string; text: string };

/** The provider id each agent kind belongs to — a total map, so a new kind can't
 *  silently lose its provider. Both directions read it, so the relation has a
 *  single definition. */
const KIND_PROVIDERS: Record<AgentKind, AiProviderId> = {
  claude: "claude-cli",
  codex: "codex-cli",
  copilot: "copilot-cli",
  opencode: "opencode-cli",
};

/** Maps a review provider id to its backend agent kind, or null if not a CLI. */
export function providerKind(provider: AiProviderId): AgentKind | null {
  return (
    (Object.keys(KIND_PROVIDERS) as AgentKind[]).find(
      (k) => KIND_PROVIDERS[k] === provider,
    ) ?? null
  );
}

/** The inverse of {@link providerKind}: the review provider id an agent kind is
 *  configured under. */
export function kindProvider(kind: AgentKind): AiProviderId {
  return KIND_PROVIDERS[kind];
}

/** The agent a NEW session, plan, or research run starts on: the explicit
 *  Settings → AI default when set, else the main AI provider when it's an
 *  agent CLI, else Claude — including while settings are still loading. */
export function defaultAgentKind(
  settings?: Pick<AppSettings, "defaultAgent" | "ai">,
): AgentKind {
  if (!settings) return "claude";
  return (
    settings.defaultAgent ?? providerKind(settings.ai.provider) ?? "claude"
  );
}

/** Resolves the CLI binary and reports version + login status for Settings. */
export const detectAgentCli = (kind: AgentKind, path?: string) =>
  invoke<AgentInfo>("agent_detect", {
    kind,
    binPath: path?.trim() || null,
  });

/** The model ids the CLI itself lists, for the model pickers' live catalog.
 *  Empty for the kinds whose CLI exposes no catalog. */
export const listAgentModels = (kind: AgentKind, path?: string) =>
  invoke<string[]>("agent_models", { kind, binPath: path?.trim() || null });

/** One effort level as the backend judges it for a model: selectable exactly
 *  when `variant` is non-null, else `reason` says why not. */
interface EffortLevelState {
  level: string;
  variant: string | null;
  reason: string | null;
}

/** Which effort levels a model offers. `perModel: false` = the agent takes any
 *  level (not opencode, or opencode 1.x on the host). */
export interface EffortSupport {
  perModel: boolean;
  levels: EffortLevelState[];
  reason: string | null;
}

/** Asks the agent CLI which effort levels `model` offers, with the binary and
 *  isolation its run will use. Spawns the host CLI for opencode. */
export const listAgentEffortLevels = ({
  kind,
  binPath,
  model,
  isolation,
}: {
  kind: AgentKind;
  binPath: string | null;
  model: string;
  isolation: string | null;
}) =>
  invoke<EffortSupport>("agent_effort_levels", {
    kind,
    binPath,
    model,
    isolation,
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

/** How long a terminal the command returned waits for the channel's own copy
 *  (and any deltas still in flight ahead of it) before it is replayed. */
const CHANNEL_TERMINAL_WAIT_MS = 5000;

/** Hands one event to a consumer; a throwing consumer is logged and skipped. */
function safeDeliver(
  onEvent: (event: ReviewEvent) => void,
  event: ReviewEvent,
): void {
  try {
    onEvent(event);
  } catch (e) {
    console.error("[agent] event handler failed", e);
  }
}

/** A channel for one agent run, gated so `onEvent` sees at most one terminal,
 *  after every delta the channel delivers before it. A throwing consumer is logged
 *  and skipped: a handler that throws must never stall the channel's ordered queue. */
function gatedChannel(onEvent: (event: ReviewEvent) => void): {
  channel: Channel<ReviewEvent>;
  gate: ChannelGate;
} {
  const gate = createChannelGate({
    boundMs: CHANNEL_TERMINAL_WAIT_MS,
    deliver: (event) => safeDeliver(onEvent, event),
  });
  const channel = new Channel<ReviewEvent>();
  channel.onmessage = gate.onMessage;
  return { channel, gate };
}

/**
 * Runs a streaming review through the agent CLI. Resolves with the run's
 * terminal event once `onEvent` has received a terminal (after every delta the
 * channel delivers before it), or at once with `null` when the run was cancelled.
 */
export async function runAgentReview(
  args: AgentReviewArgs,
): Promise<ReviewEvent | null> {
  const { channel, gate } = gatedChannel(args.onEvent);
  const returned = await invoke<ReviewEvent | null>("agent_review", {
    kind: args.kind,
    binPath: args.binPath,
    model: args.model,
    effort: args.effort,
    systemPrompt: args.systemPrompt,
    userPrompt: args.userPrompt,
    repoPath: args.repoPath,
    repoAware: args.repoAware,
    mcpSelf: Boolean(args.mcpSelf),
    timeoutSecs: args.timeoutSecs ?? null,
    timeoutConfigurable: Boolean(args.timeoutConfigurable),
    reviewId: args.reviewId,
    onEvent: channel,
  });
  await gate.finish(returned);
  return returned;
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
  /** The conversation's stable uuid: `--session-id` on turn 1, `--resume` after, the
   *  container name and the MCP config. Never the cancel key (see `runId`). */
  sessionId: string;
  /** This turn's own cancel id, fresh per turn (the resume retry's second call
   *  reuses it): the key `cancelAgentSession` takes. 8-64 chars of ASCII letters,
   *  digits or '-'. */
  runId: string;
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
 * also run in a container (kernel boundary). Settles like {@link runAgentReview}:
 * with the turn's terminal event after `onEvent` received one, or with `null` at
 * once on cancel. A Claude or Copilot resume (not a fork) whose CLI answers, before
 * any output, that the conversation does not exist runs once more as a first turn
 * under the same ids; that answer never reaches `onEvent`, and a notice goes out
 * just ahead of the second attempt's first event unless that event is a failure.
 */
export async function runAgentSession(
  args: AgentSessionArgs,
): Promise<ReviewEvent | null> {
  const { agent, runId } = args;
  if ((agent !== "claude" && agent !== "copilot") || !args.resume || args.fork)
    return sessionTurn(args, args.onEvent);
  // Recorded before the first await, so a Stop issued at once still counts.
  liveRuns.add(runId);
  try {
    let held = false;
    let output = false;
    const first = await sessionTurn(args, (event) => {
      if (!held && !output && isResumeMiss(agent, args.sessionId, event)) {
        held = true;
        return;
      }
      if ((event.kind === "delta" && event.text) || event.kind === "tool")
        output = true;
      args.onEvent(event);
    });
    if (!held) return first;
    // A Stop aimed at the first attempt may have reached its entry or found none;
    // this record carries it across to the second.
    if (cancelledRuns.has(runId)) return null;
    // Told only once the new conversation answers: a second attempt stopped before its
    // spawn, refused, or failing at once started nothing worth a note.
    let awaitingFirst = true;
    return await sessionTurn({ ...args, resume: false }, (event) => {
      if (awaitingFirst) {
        awaitingFirst = false;
        if (event.kind !== "error" && !(event.kind === "done" && event.isError))
          safeDeliver(args.onEvent, {
            kind: "notice",
            code: NOTICE_SESSION_RESET,
            text: resumeMissNote(RESUME_MISS_LABELS[agent]),
          });
      }
      args.onEvent(event);
    });
  } finally {
    liveRuns.delete(runId);
    cancelledRuns.delete(runId);
  }
}

/** The run ids of the resume turns that may still retry, and those of them a Stop
 *  was sent for. Both hold only runs in flight. */
const liveRuns = new Set<string>();
const cancelledRuns = new Set<string>();

/** The agents whose missing conversation `isResumeMiss` recognises, as the pickers
 *  name them. */
const RESUME_MISS_LABELS: Record<"claude" | "copilot", string> = {
  claude: "Claude",
  copilot: "GitHub Copilot",
};

/** The note for a turn that started a new conversation; one template with the Rust
 *  `NOTICE_RESET_GENERIC` and `fresh_start_note`. */
export function resumeMissNote(label: string): string {
  return `GitDesktop could not continue the earlier ${label} conversation, so this turn started a new one. The agent does not remember the earlier turns.`;
}

/** Whether `event` is the CLI's own answer that conversation `sessionId` does not
 *  exist (Claude 2.1.311, Copilot CLI 1.0.105, probed on the host). Anything else,
 *  a reworded answer included, is not, so an unrecognised miss fails as before. */
export function isResumeMiss(
  agent: AgentSessionArgs["agent"],
  sessionId: string,
  event: ReviewEvent,
): boolean {
  if (agent === "claude")
    return (
      event.kind === "done" &&
      event.isError &&
      event.text.trim() ===
        `No conversation found with session ID: ${sessionId}`
    );
  if (agent !== "copilot" || event.kind !== "error" || event.timedOut)
    return false;
  // Copilot prints the sentence as stderr's first line, then a usage block.
  const line = event.message.split(/\r?\n/, 1)[0].trim();
  const sentence = line.startsWith("Error: ")
    ? line.slice("Error: ".length)
    : line;
  return sentence === `No session, task, or name matched '${sessionId}'.`;
}

/** One `agent_session` invoke through its own gated channel. */
async function sessionTurn(
  args: AgentSessionArgs,
  onEvent: (event: ReviewEvent) => void,
): Promise<ReviewEvent | null> {
  const { channel, gate } = gatedChannel(onEvent);
  const returned = await invoke<ReviewEvent | null>("agent_session", {
    agent: args.agent,
    binPath: args.binPath,
    model: args.model,
    effort: args.effort,
    systemPrompt: args.systemPrompt,
    userPrompt: args.userPrompt,
    worktreePath: args.worktreePath,
    sessionId: args.sessionId,
    runId: args.runId,
    resume: args.resume,
    fork: args.fork ?? false,
    readOnly: args.readOnly,
    web: args.web ?? false,
    isolation: args.isolation,
    nativeSessionId: args.nativeSessionId,
    mcpServers: args.mcpServers,
    onEvent: channel,
  });
  await gate.finish(returned);
  return returned;
}

/** Signals an in-flight session turn to stop (shares the backend cancel registry).
 *  Takes the turn's `runId`: registry ids are single-use, so a session id shared
 *  by a stopped turn and its quick re-send would let the stopped turn's exit or a
 *  stale Stop land on the new one. */
export const cancelAgentSession = (runId: string) => {
  // Recorded before the invoke, so a first attempt settling meanwhile still sees it.
  if (liveRuns.has(runId)) cancelledRuns.add(runId);
  return invoke<void>("agent_review_cancel", { reviewId: runId });
};
