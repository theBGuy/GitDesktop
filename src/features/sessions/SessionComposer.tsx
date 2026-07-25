import { StopIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { AnimatePresence, m } from "motion/react";
import {
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { AgentKind } from "@/lib/ai/agent";
import { estimateRunCost } from "@/lib/ai/cost";
import type { ContainerStatus } from "@/lib/ai/sandbox";
import { useContainerStatus } from "@/lib/ai/sandbox-queries";
import {
  buildPrompt,
  filterCommands,
  findCommand,
  mergeCommands,
  parseSlashInvocation,
  type SlashCommand,
} from "@/lib/ai/slash";
import { useAgentCommands, useTrackedFiles } from "@/lib/git/queries";
import { quickTransition } from "@/lib/motion";
import {
  isServerAvailable,
  isServerDefaultOn,
  mcpServerUsableBy,
  mcpSupportedFor,
} from "@/lib/settings/mcp";
import { useRepoKeys, useSettings } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { cn } from "@/lib/utils";
import {
  AGENT_LABELS,
  AgentPicker,
  ComposerOptions,
  type Isolation,
  type IsolationNote,
  ModelPicker,
  modelsForAgent,
  type RunMode,
} from "./AgentPickers";
import { EnsembleRunDialog } from "./EnsembleRunDialog";
import { type AgentSession, type PendingTask, useSessionsStore } from "./store";

const MAX_MENTIONS = 8;

/** Stable empty default so the container probe's props don't churn while settings load. */
const NO_PROVIDERS: string[] = [];

const RUNTIME_LABEL = { docker: "Docker", podman: "Podman" } as const;

/** FALLBACK reason a not-ready container disables Start, used only when the
 *  isolation note hasn't produced a specific one (see `blockedReason`). */
const CONTAINER_BLOCKED_TEXT =
  "Container isolation isn't ready — open Options for details.";

/**
 * The single line shown under the composer's Isolation control. Container is
 * pick-then-warn: choosing it (or inheriting it from Settings) surfaces the same
 * readiness probe Settings runs, with a jump to Settings → AI where the runtime and
 * image are actually set up. A missing runtime / stopped engine / unbuilt image also
 * blocks Start (see `containerBlocked`); everything after that — a stale image, an
 * agent missing from it, a probe that couldn't run — only warns, because the backend
 * verifies at turn 1 anyway and over-blocking on a guess is worse than a warning. On
 * the worktree side the only note is the downgrade disclosure — running on the host
 * when the global setting says container — so the drop in confinement is never silent.
 */
function isolationNoteFor({
  effective,
  global,
  agent,
  perAgentCopy,
  status,
  probeFailed,
  agentInImage,
}: {
  effective: Isolation;
  global: Isolation;
  /** The composer's seed agent — the one whose host-sandbox story is described. */
  agent: AgentKind;
  /** False in best-of-N, where the arms can each pick a different agent, so any
   *  agent-specific claim about the host sandbox could be false for some of them. */
  perAgentCopy: boolean;
  status: ContainerStatus | undefined;
  /** The probe ran and failed (not merely still loading). */
  probeFailed: boolean;
  /** `agent` is among the agent CLIs the saved image config bakes in. */
  agentInImage: boolean;
}): IsolationNote | undefined {
  if (effective === "worktree") {
    if (global !== "container") return undefined;
    return {
      tone: "muted",
      text:
        agent === "codex" && perAgentCopy
          ? "Runs on the host for this session — Codex keeps its own OS-enforced sandbox."
          : "Runs on the host for this session — file writes are confined by convention, not the kernel.",
    };
  }
  // A probe that failed with nothing to show for it. (Once there IS data, a later
  // refetch failing — the recovery poll hitting a blip — shouldn't replace the
  // specific reason Start is blocked with a vaguer one.)
  if (!status)
    return probeFailed
      ? {
          tone: "warn",
          text: "Couldn't check container status — the session will verify at start.",
        }
      : { tone: "muted", text: "Checking container status…" };
  if (!status.runtime)
    return {
      tone: "warn",
      text: "No Docker or Podman found — container sessions need one installed.",
      settingsAction: true,
    };
  const runtime = RUNTIME_LABEL[status.runtime];
  if (!status.ready)
    return {
      tone: "warn",
      text: `${runtime} is installed but its engine isn't running. Start it, then try again.`,
    };
  if (!status.imagePresent)
    return {
      tone: "warn",
      text: `${runtime} is ready — build the agent image first.`,
      settingsAction: true,
    };
  // More specific than the generic "doesn't match" below — the backend rejects turn
  // 1 outright when the chosen agent isn't in the image, so name that agent. Still
  // only a warning: a stale image can legitimately carry MORE agents than the saved
  // config lists, and blocking on that guess would be worse. Skipped in best-of-N
  // for the same reason as the downgrade copy — the arms pick their own agents, so
  // naming the seed's would be as likely to mislead as to help.
  if (!agentInImage && perAgentCopy)
    return {
      tone: "warn",
      text: `The agent image wasn't built with ${AGENT_LABELS[agent]} — add it under Settings → AI and rebuild.`,
      settingsAction: true,
    };
  if (!status.imageMatches)
    return {
      tone: "warn",
      text: "The agent image doesn't match the current Node / agent selection — rebuild in Settings to apply.",
      settingsAction: true,
    };
  return undefined;
}

/** An in-progress `@file` mention: the query typed after `@` and the index of
 *  the `@` in the draft (so it can be replaced on selection). */
interface Mention {
  query: string;
  start: number;
}

export interface SessionComposerHandle {
  /** Load `text` into the composer for editing (focus it, caret at end). */
  setPrompt: (text: string) => void;
}

/**
 * The agent task composer, modeled on Claude Code's VS Code input: a single
 * auto-growing box (grows with content, capped, then scrolls) pinned at the
 * bottom, with the model picker and Send/Stop on its bottom edge. Enter sends,
 * Shift+Enter inserts a newline. Type `@` to mention a repo file. Used in two
 * places with the same logic — the activation panel (no session → `start`) and
 * the conversation footer (active session → `send` a follow-up).
 */
export function SessionComposer({
  repoPath,
  session,
  examples,
  autoFocus,
  handleRef,
}: {
  repoPath: string;
  /** null = start a new session; otherwise send a follow-up to this one. */
  session: AgentSession | null;
  /** Quick-fill suggestions shown above the box while it's empty (activation). */
  examples?: string[];
  autoFocus?: boolean;
  /** Imperative handle so a turn's "Edit & resend" can load its prompt here. */
  handleRef?: React.Ref<SessionComposerHandle>;
}) {
  const start = useSessionsStore((s) => s.start);
  const startEnsemble = useSessionsStore((s) => s.startEnsemble);
  const send = useSessionsStore((s) => s.send);
  const setModel = useSessionsStore((s) => s.setModel);
  const setEffort = useSessionsStore((s) => s.setEffort);
  const setSessionMcp = useSessionsStore((s) => s.setSessionMcp);
  const cancel = useSessionsStore((s) => s.cancel);
  const creating = useSessionsStore((s) => s.creating);
  const pendingTask = useSessionsStore((s) => s.pendingTask);
  const setPendingTask = useSessionsStore((s) => s.setPendingTask);
  const sessions = useSessionsStore((s) => s.sessions);
  const [draft, setDraft] = useState("");
  const [startModel, setStartModel] = useState("");
  const [startEffort, setStartEffort] = useState("");
  const [startAgent, setStartAgent] = useState<
    "claude" | "codex" | "copilot" | "opencode"
  >("claude");
  // MCP servers opted into for a NEW session. null = "use the default" (every
  // enabled registry server); a concrete array once the user picks. Frozen at
  // turn 1, so it only matters before a session exists.
  const [startMcp, setStartMcp] = useState<string[] | null>(null);
  // Isolation for a NEW session. null = follow the global Settings → AI value; a
  // concrete pick overrides it for THIS session only. Agent-independent, so it
  // deliberately survives an agent switch.
  const [startIsolation, setStartIsolation] = useState<Isolation | null>(null);
  // Run mode for a NEW task: a single session, or best-of-N. The mode picker is
  // always clickable (the Send button isn't, until you type), so you can choose
  // best-of-N first; Send then follows the mode.
  const [mode, setMode] = useState<RunMode>("single");
  // Best-of-N: the resolved prompt held while the arm/cost dialog is open (the
  // dialog picks how many arms and each arm's agent/model/effort).
  const [ensembleOpen, setEnsembleOpen] = useState(false);
  const [pendingEnsemble, setPendingEnsemble] = useState("");
  // Honest upfront estimate from what past sessions actually cost (see cost.ts).
  const costEstimate = useMemo(() => estimateRunCost(sessions), [sessions]);
  const [mention, setMention] = useState<Mention | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  // An in-progress `/command` (the query typed after the leading `/`). Only
  // ever set when `/` opens the draft, so it owns the whole draft on selection.
  const [slash, setSlash] = useState<{ query: string } | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  // Prompt-history navigation (terminal-style Up/Down recall). `histIndex` null
  // = showing the live draft; `histStash` holds that draft while browsing.
  const [histIndex, setHistIndex] = useState<number | null>(null);
  const [histStash, setHistStash] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  // Ties the disabled-Send explanation to the button via aria-describedby.
  const blockedId = useId();
  // The record this composer stashed for a Settings round-trip. The consume effect
  // skips exactly that record (by identity) rather than latching shut, so if the
  // composer ever stops unmounting on the jump (e.g. an <Activity> refactor) a
  // LATER handoff record still consumes normally. Dies with the unmount today.
  const stashedRef = useRef<PendingTask | null>(null);

  const running = session?.running ?? false;
  const model = session ? session.model : startModel;
  // Agent is fixed once a session exists; while starting, it's user-selectable.
  const agent = session ? session.agent : startAgent;
  const models = modelsForAgent(agent);
  const onModel = session
    ? (m: string) => setModel(session.id, m)
    : setStartModel;
  // Effort is changeable mid-session (like model). Mapped per-CLI in Rust (Codex
  // config, Copilot/opencode flags, Claude thinking keyword).
  const effort = session ? session.effort : startEffort;
  const onEffort = session
    ? (e: string) => setEffort(session.id, e)
    : setStartEffort;
  // Your sent prompts, oldest→newest, for Up/Down recall.
  const history = session ? session.turns.map((t) => t.prompt) : [];

  const setDraftCaretEnd = (text: string) => {
    setDraft(text);
    requestAnimationFrame(() => {
      const ta = ref.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(text.length, text.length);
    });
  };

  // Load a prompt into the box from outside (a turn's "Edit & resend").
  // biome-ignore lint/correctness/useExhaustiveDependencies: only uses stable setters/ref
  useImperativeHandle(
    handleRef,
    () => ({
      setPrompt: (text: string) => {
        setMention(null);
        setHistIndex(null);
        setDraftCaretEnd(text);
      },
    }),
    [],
  );

  // Seed the new-session composer from a handoff ("Implement this issue" / the
  // plan canvas's "Implement now"). Only the activation composer (no session)
  // consumes it; clear it once loaded so it doesn't re-seed. The Agent tab lives
  // under <Activity>, so this effect runs when the tab becomes visible — by which
  // point SessionActivation has forced "Delegate" mode and mounted this composer.
  // biome-ignore lint/correctness/useExhaustiveDependencies: stable setters/ref only
  useEffect(() => {
    if (
      session ||
      !pendingTask ||
      pendingTask === stashedRef.current ||
      pendingTask.repoPath !== repoPath
    )
      return;
    setMention(null);
    setSlash(null);
    setHistIndex(null);
    setDraftCaretEnd(pendingTask.prompt);
    // A record stashed by the "Set up in Settings…" jump also carries the whole
    // start-state, so the round-trip can't silently change what will run. A plain
    // handoff carries none of it and the composer keeps its own values. Tested
    // with `!== undefined` throughout: "" (default model / Auto effort) and null
    // (follow the default MCP set) are real values, not absences. These are plain
    // setState calls — the agent-change RESET (model + MCP) lives in AgentPicker's
    // onChange handler, not an effect, so restoring an agent doesn't wipe the
    // model or servers restored alongside it.
    if (pendingTask.isolation !== undefined)
      setStartIsolation(pendingTask.isolation);
    if (pendingTask.agent !== undefined) setStartAgent(pendingTask.agent);
    if (pendingTask.model !== undefined) setStartModel(pendingTask.model);
    if (pendingTask.effort !== undefined) setStartEffort(pendingTask.effort);
    if (pendingTask.mode !== undefined) setMode(pendingTask.mode);
    if (pendingTask.mcpServers !== undefined)
      setStartMcp(pendingTask.mcpServers);
    setPendingTask(null);
  }, [session, pendingTask, repoPath]);

  const recallOlder = () => {
    if (history.length === 0) return;
    if (histIndex === null) setHistStash(draft);
    const i =
      histIndex === null ? history.length - 1 : Math.max(0, histIndex - 1);
    setHistIndex(i);
    setDraftCaretEnd(history[i]);
  };
  const recallNewer = () => {
    if (histIndex === null) return;
    if (histIndex < history.length - 1) {
      const i = histIndex + 1;
      setHistIndex(i);
      setDraftCaretEnd(history[i]);
    } else {
      setHistIndex(null);
      setDraftCaretEnd(histStash);
    }
  };

  // Auto-grow the textarea with its content up to ~10 lines, then scroll. Done
  // in JS (not CSS `field-sizing`) so growth is reliable across every webview we
  // ship on — WebView2, WKWebView, WebKitGTK — not only the ones with the new
  // CSS property.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resize on draft change
  useLayoutEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }, [draft]);

  // `@file` mentions: list the worktree's tracked files (or the repo's, before a
  // session exists). Only fetched once a mention is being typed.
  const baseDir = session?.worktreePath ?? repoPath;
  const tracked = useTrackedFiles(baseDir, mention !== null && !!baseDir);
  const matches = useMemo(() => {
    if (!mention) return [];
    const all = tracked.data ?? [];
    const q = mention.query.toLowerCase();
    const hits = q ? all.filter((f) => f.toLowerCase().includes(q)) : all;
    return hits.slice(0, MAX_MENTIONS);
  }, [mention, tracked.data]);

  // `/` menu: built-ins + the SELECTED agent's discovered commands AND skills
  // (project + global, incl. the canonical `.agents/skills`) + the user's custom
  // commands (Settings → Slash commands). Discovery is fetched lazily once the
  // draft is a slash invocation, keyed on the repo ROOT (not the worktree) so it
  // stays cached across the session's worktree transition, and on the agent
  // (each CLI reads different dirs).
  const settings = useSettings();
  const customCommands = settings.data?.customCommands;
  // Scope/override lookup keys for this repo (identity + raw path), so a
  // repo-scoped server or per-repo override set from a sibling worktree is
  // OFFERED here. A plain query hook (no effects) — safe under <Activity>.
  const repoKeys = useRepoKeys(repoPath);
  // MCP registry (Settings → MCP servers) → the new-session opt-in, narrowed to
  // the servers OFFERED in THIS repo (in scope and not per-repo "off"). Default
  // selection is the per-repo "on" set; the picker lets you pare it down. Applied to
  // Claude/Copilot/opencode (host or container) and Codex (container) — see
  // `mcpSupportedFor`; the picker self-hides when empty.
  const mcpRegistry = useMemo(
    () =>
      (settings.data?.mcpServers ?? []).filter((s) =>
        isServerAvailable(s, repoKeys),
      ),
    [settings.data?.mcpServers, repoKeys],
  );
  // Isolation for a NEW session: the global setting unless the composer's Options
  // popover overrode it. Fixed at creation, so an ACTIVE session has none here (its
  // own `session.isolation` governs, below). Derived during render — no effect.
  const globalIsolation: Isolation =
    settings.data?.agentIsolation ?? "worktree";
  // Resolved ONCE (override ?? global) and reused by the gate, the note, and the
  // radio value below, so the warn line and the Send gate can never disagree.
  const resolvedStartIsolation: Isolation = startIsolation ?? globalIsolation;
  const effectiveIsolation = !session ? resolvedStartIsolation : undefined;
  const isContainer = effectiveIsolation === "container";
  // Container readiness, probed lazily and shared with Settings → AI (same query
  // key, so one Docker/Podman check serves both). Only while a new session is
  // actually set to run in a container AND the Agent tab is showing — an
  // <Activity>-hidden subtree still fetches.
  const agentTabShowing = useUiStore((s) => s.repoTab === "agent");
  const openSettings = useUiStore((s) => s.openSettings);
  const containerStatus = useContainerStatus({
    nodeVersion: settings.data?.agentImageNodeVersion ?? "",
    providers: settings.data?.agentImageProviders ?? NO_PROVIDERS,
    enabled: !session && isContainer && agentTabShowing && !!settings.data,
  });
  // A RESOLVED "can't run containers" blocks Start; loading (no data yet) never
  // does, and a stale image, a missing agent, or a probe that couldn't run only warn.
  const probe = containerStatus.data;
  const probeFailed = containerStatus.isError;
  // Whether the saved image config bakes in the agent this session would run.
  const agentInImage =
    settings.data?.agentImageProviders?.includes(startAgent) ?? false;
  const containerBlocked =
    isContainer &&
    !!probe &&
    (!probe.runtime || !probe.ready || !probe.imagePresent);
  // Until settings resolve we don't yet know the global isolation, so the readiness
  // gate above hasn't run — but start() reads settings itself and would happily
  // launch a container session. Hold Start for those few milliseconds rather than
  // let one slip past the gate. Deliberately silent: it's a load, not a problem.
  // A settings load that FAILED is deliberately not pending — holding Send forever
  // would be the worse bug. Residual: start()'s own loadSettings() can succeed where
  // the query errored and launch per the real setting while the row showed the
  // worktree fallback — near-unreachable, it errs toward MORE confinement than
  // displayed, and turn 1 re-checks readiness in Rust.
  const settingsPending = !session && !settings.data && !settings.isError;
  const canSubmit =
    !running &&
    !creating &&
    draft.trim().length > 0 &&
    !containerBlocked &&
    !settingsPending;
  // The one line under the Isolation control — a container-readiness warning or the
  // host-downgrade disclosure. Hoisted out of the JSX so the blocked strip and the
  // best-of-N toast can name the SPECIFIC reason instead of the generic fallback.
  const isolationNote = session
    ? undefined
    : isolationNoteFor({
        effective: resolvedStartIsolation,
        global: globalIsolation,
        agent: startAgent,
        // Best-of-N arms each pick their own agent, so no agent-specific claim
        // (host sandbox, image membership) can be made.
        perAgentCopy: mode !== "ensemble",
        status: probe,
        probeFailed,
        agentInImage,
      });
  const blockedReason = isolationNote?.text ?? CONTAINER_BLOCKED_TEXT;
  // The note's "Set up in Settings…" jump. Opening Settings unmounts
  // RepositoryView (App.tsx renders it behind `view === "repo"`), which would take
  // this composer's draft AND its isolation pick with it — a task typed, switched
  // to Container, then sent to Settings to build the image would come back empty
  // and silently back on the host. Stash both on the existing pendingTask record
  // first; the activation composer re-seeds from it on remount.
  const openIsolationSettings = () => {
    // `openSettings` flips the view inside a view-transition callback (see
    // lib/view-transition.ts — `doc.startViewTransition(() => flushSync(update))`),
    // so the stash below commits a render BEFORE the unmount. Without the ref the
    // consume effect would eat the record in that window and there'd be nothing
    // left to restore; holding the record itself skips it by IDENTITY, so the
    // remounted composer (fresh ref) consumes normally.
    const task: PendingTask = {
      repoPath,
      prompt: draft,
      // null = no explicit pick, so there's nothing to restore — collapse to absent.
      isolation: startIsolation ?? undefined,
      agent: startAgent,
      model: startModel,
      effort: startEffort,
      mode,
      // Verbatim: null here MEANS "follow the default set", so it must survive.
      mcpServers: startMcp,
    };
    stashedRef.current = task;
    setPendingTask(task);
    openSettings("ai");
  };
  // Servers the chosen agent can actually run (Codex = local/stdio only).
  const mcpServersForAgent = useMemo(
    () => mcpRegistry.filter((s) => mcpServerUsableBy(s, startAgent)),
    [mcpRegistry, startAgent],
  );
  const enabledMcpIds = useMemo(
    () =>
      mcpServersForAgent
        .filter((s) => isServerDefaultOn(s, repoKeys))
        .map((s) => s.id),
    [mcpServersForAgent, repoKeys],
  );
  const effectiveMcp = startMcp ?? enabledMcpIds;
  // MCP runs on host + container for Claude/Copilot/opencode, and on container Codex.
  // The only unsupported combo is Codex on the host, so that's the one hint we show.
  const mcpUsable = mcpSupportedFor(startAgent, isContainer);
  const mcpDisabledReason =
    !mcpUsable && startAgent === "codex"
      ? "Codex runs MCP in container sessions — switch Isolation to Container above"
      : undefined;
  // For an ACTIVE session the agent + isolation are fixed, so gate on the session's
  // own values and let the user re-pick servers (applies from the next turn).
  const sessionMcpUsable = session
    ? mcpSupportedFor(session.agent, session.isolation === "container")
    : false;
  const sessionMcpServers = useMemo(
    () =>
      session
        ? mcpRegistry.filter((s) => mcpServerUsableBy(s, session.agent))
        : [],
    [mcpRegistry, session],
  );
  // The MCP config handed to the Options popover, resolved per session/mode: an
  // active session re-picks from its own usable servers; a new session (single OR
  // best-of-N) opts in (or shows the Codex-on-host hint). For best-of-N the one
  // selection is SHARED — passed to every arm and filtered per-arm by agent. The
  // servers/hint follow the composer's seed agent. undefined → no MCP section.
  const composerMcp = session
    ? sessionMcpUsable
      ? {
          servers: sessionMcpServers,
          value: session.mcpServers ?? [],
          onChange: (ids: string[]) => setSessionMcp(session.id, ids),
        }
      : undefined
    : mcpUsable || mcpDisabledReason
      ? {
          servers: mcpServersForAgent,
          value: effectiveMcp,
          onChange: (ids: string[]) => setStartMcp(ids),
          disabledReason: mcpDisabledReason,
        }
      : undefined;
  const discovered = useAgentCommands(
    repoPath,
    agent,
    draft.startsWith("/") && !!repoPath,
  );
  const commands = useMemo(
    () => mergeCommands(discovered.data ?? [], customCommands ?? [], agent),
    [discovered.data, customCommands, agent],
  );
  // Show the full set (scrollable) — no narrowing required to browse.
  const slashMatches = useMemo(
    () => (slash ? filterCommands(commands, slash.query) : []),
    [slash, commands],
  );

  const clearDraft = () => {
    setDraft("");
    setMention(null);
    setSlash(null);
    setHistIndex(null);
  };

  const dispatch = (text: string) => {
    if (session) send(session.id, text);
    else
      start(
        repoPath,
        text,
        startModel,
        startAgent,
        startEffort,
        undefined,
        // MCP runs in the supported (agent, isolation) combos — pass only the
        // agent-runnable picks (the rest are filtered out for this agent).
        mcpUsable
          ? effectiveMcp.filter((id) =>
              mcpServersForAgent.some((s) => s.id === id),
            )
          : undefined,
        // Absent unless the user explicitly picked — start() then reads the global
        // setting itself, exactly as before.
        startIsolation ?? undefined,
      );
  };

  // Expand a known `/command` client-side (no CLI parses `/cmd` headless) so the
  // agent and transcript see the final prompt. Returns null when the input was a
  // client-only command already handled here (e.g. /clear), so submit stops.
  const resolvePrompt = (text: string): string | null => {
    const invocation = parseSlashInvocation(text);
    if (invocation) {
      const cmd = findCommand(commands, invocation.name);
      if (cmd?.action === "clear") {
        clearDraft();
        return null;
      }
      if (cmd) return buildPrompt(cmd, invocation.args);
    }
    return text; // unknown command falls through and is sent literally
  };

  const submit = () => {
    // Container isolation that isn't ready — or settings that haven't resolved, so
    // readiness was never checked: Enter must respect the same gates the Send
    // button does (the composer's warn line explains the first one).
    if (containerBlocked || settingsPending) return;
    // Best-of-N mode: the primary action opens the arm/cost dialog instead of
    // starting one session (the dialog runs the fan-out).
    if (!session && mode === "ensemble") {
      openEnsemble();
      return;
    }
    const text = draft.trim();
    if (!text || running || creating) return;
    const prompt = resolvePrompt(text);
    if (prompt === null) return;
    dispatch(prompt);
    clearDraft();
  };

  // Best-of-N (activation only): resolve the draft, then open the arm/cost dialog
  // to pick how many ways and each arm's agent/model/effort before spending.
  const openEnsemble = () => {
    const text = draft.trim();
    if (!text || running || creating) return;
    const prompt = resolvePrompt(text);
    if (prompt === null) return;
    setPendingEnsemble(prompt);
    setEnsembleOpen(true);
  };

  // Approved in the dialog: fan out one session per arm on the same task. The MCP
  // selection is SHARED across arms — pass the seed-agent-runnable picks; each arm's
  // start() + runTurn then drop any its own agent/isolation can't use.
  const runEnsemble = (
    arms: { agent: AgentKind; model: string; effort: string }[],
  ) => {
    if (!pendingEnsemble) return;
    // The probe can resolve blocked while the arm/cost dialog sits open. Confirming
    // then would fan out N doomed arms — but the dialog has already closed itself,
    // so say why rather than appear to do nothing.
    if (containerBlocked) {
      toast.error(blockedReason);
      return;
    }
    const mcp = mcpUsable
      ? effectiveMcp.filter((id) => mcpServersForAgent.some((s) => s.id === id))
      : undefined;
    void startEnsemble(
      repoPath,
      pendingEnsemble,
      arms,
      mcp,
      // Every arm runs the same way — arms differ by agent/model/effort only.
      startIsolation ?? undefined,
    );
    clearDraft();
    setPendingEnsemble("");
  };

  // Recompute the active mention from the text up to the caret: an `@` at the
  // start or after whitespace, followed by the (space-free) query.
  const syncMention = (value: string, caret: number) => {
    const m = value.slice(0, caret).match(/(?:^|\s)@([^\s@]*)$/);
    if (m) {
      setMention({ query: m[1], start: caret - m[1].length - 1 });
      setMentionIndex(0);
    } else {
      setMention(null);
    }
  };

  // The slash menu only opens at the very start of the draft, before any space
  // (it autocompletes the command NAME — arguments come after). Once a space is
  // typed the menu closes and the args phase begins.
  const syncSlash = (value: string, caret: number) => {
    const m = value.slice(0, caret).match(/^\/([a-zA-Z0-9][\w-]*)?$/);
    if (m) {
      setSlash({ query: m[1] ?? "" });
      setSlashIndex(0);
    } else {
      setSlash(null);
    }
  };

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    const caret = e.target.selectionStart ?? value.length;
    setDraft(value);
    setHistIndex(null); // typing detaches from history browsing
    syncMention(value, caret);
    syncSlash(value, caret);
  };

  const insertMention = (path: string) => {
    const ta = ref.current;
    if (!mention || !ta) return;
    const before = draft.slice(0, mention.start);
    // Replace the whole `@query` token, not just up to the caret, and only add a
    // trailing space if there isn't one already (no double space mid-sentence).
    const rest = draft.slice(mention.start + 1 + mention.query.length);
    const sep = rest.startsWith(" ") ? "" : " ";
    setDraft(`${before}@${path}${sep}${rest}`);
    setMention(null);
    const pos = before.length + 1 + path.length + sep.length;
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(pos, pos);
    });
  };

  // Picking a command from the `/` menu. Actions (e.g. /clear) run immediately;
  // prompt commands complete the name with a trailing space so the user can
  // type arguments, then Enter expands and sends.
  const selectSlash = (cmd: SlashCommand) => {
    if (cmd.action === "clear") {
      clearDraft();
      requestAnimationFrame(() => ref.current?.focus());
      return;
    }
    setSlash(null);
    setDraftCaretEnd(`/${cmd.name} `);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // While the `/` menu is open it owns Up/Down/Enter/Tab/Esc (when there are
    // matches), so Enter completes a command instead of sending. With no
    // matches, Enter falls through and sends the literal text.
    if (slash) {
      if (e.key === "Escape") {
        e.preventDefault();
        setSlash(null);
        return;
      }
      if (slashMatches.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSlashIndex((i) => (i + 1) % slashMatches.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSlashIndex(
            (i) => (i - 1 + slashMatches.length) % slashMatches.length,
          );
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          selectSlash(slashMatches[slashIndex]);
          return;
        }
      } else if (e.key === "Tab") {
        e.preventDefault(); // nothing to complete
        return;
      }
    }
    // While a mention is being typed it owns Up/Down/Enter/Tab/Esc, so Enter
    // never submits half-typed `@text` (even when nothing matches yet).
    if (mention) {
      if (e.key === "Escape") {
        e.preventDefault();
        setMention(null);
        return;
      }
      if (matches.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setMentionIndex((i) => (i + 1) % matches.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setMentionIndex((i) => (i - 1 + matches.length) % matches.length);
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          insertMention(matches[mentionIndex]);
          return;
        }
      } else if (e.key === "Enter" || e.key === "Tab") {
        // Mention active but nothing matches: dismiss it, don't send.
        e.preventDefault();
        setMention(null);
        return;
      }
    }
    // Terminal-style history: recall previous prompts with Up/Down — but only
    // when the caret is on the first/last line, so multi-line editing still
    // moves the caret normally.
    if (!mention && !slash && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      const ta = ref.current;
      const collapsed = ta?.selectionStart === ta?.selectionEnd;
      const start = ta?.selectionStart ?? 0;
      if (
        e.key === "ArrowUp" &&
        history.length > 0 &&
        collapsed &&
        !draft.slice(0, start).includes("\n")
      ) {
        e.preventDefault();
        recallOlder();
        return;
      }
      if (
        e.key === "ArrowDown" &&
        histIndex !== null &&
        collapsed &&
        !draft.slice(start).includes("\n")
      ) {
        e.preventDefault();
        recallNewer();
        return;
      }
    }
    // Enter sends; Shift+Enter is a newline. Ignore IME composition commits.
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <>
      <div className="flex flex-col gap-2">
        {examples && draft.length === 0 && (
          <div className="flex flex-wrap gap-1.5">
            {examples.map((ex) => (
              <button
                key={ex}
                type="button"
                onClick={() => setDraft(ex)}
                className="border px-2 py-1 text-[11px] text-foreground/70 transition-colors hover:bg-muted hover:text-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
              >
                {ex}
              </button>
            ))}
          </div>
        )}
        <div className="relative">
          {mention && (
            <MentionList
              matches={matches}
              index={mentionIndex}
              loading={tracked.isPending}
              query={mention.query}
              onPick={insertMention}
              onHover={setMentionIndex}
            />
          )}
          {slash && (
            <SlashList
              matches={slashMatches}
              index={slashIndex}
              loading={discovered.isPending && draft.startsWith("/")}
              query={slash.query}
              onPick={selectSlash}
              onHover={setSlashIndex}
            />
          )}
          <div className="flex flex-col gap-2 border border-input bg-transparent p-3 transition-colors focus-within:border-ring focus-within:ring-1 focus-within:ring-ring/50 dark:bg-input/30">
            <textarea
              ref={ref}
              autoFocus={autoFocus}
              value={draft}
              onChange={onChange}
              onKeyDown={onKeyDown}
              rows={1}
              aria-label={
                session ? "Reply to the agent" : "Describe a task for the agent"
              }
              aria-autocomplete="list"
              aria-expanded={mention !== null || slash !== null}
              aria-controls={
                mention
                  ? "session-mention-list"
                  : slash
                    ? "session-slash-list"
                    : undefined
              }
              aria-activedescendant={
                mention && matches.length > 0
                  ? `session-mention-${mentionIndex}`
                  : slash && slashMatches.length > 0
                    ? `session-slash-${slashIndex}`
                    : undefined
              }
              placeholder={
                session
                  ? "Reply to the agent…  (@ file, / command)"
                  : "Describe a task for the agent…  (@ file, / command)"
              }
              className="max-h-40 min-h-9 w-full resize-none overflow-y-auto bg-transparent text-xs leading-relaxed outline-none placeholder:text-muted-foreground"
            />
            {/* Why Send is disabled, in layout flow — the global setting alone can
                put you here, in which case the Options badge doesn't move and a
                hover-only tooltip would be the sole explanation. Carries the
                SPECIFIC reason (engine down, image missing, …) and is what the Send
                button points `aria-describedby` at while blocked. Reasons Settings
                can fix carry the remedy here too, so it's reachable without ever
                opening the Options popover; an engine that isn't running has no
                `settingsAction` (Settings can't start a daemon) and gets no button. */}
            <p
              id={blockedId}
              role="status"
              // Mounted unconditionally: a live region created together with its
              // text announces unreliably, so the region has to pre-exist and only
              // its CONTENT change. `sr-only` (not `hidden`) keeps the empty state
              // in the accessibility tree while taking it out of flow entirely, so
              // the column's flex gap shows no phantom row.
              className={
                containerBlocked
                  ? "flex items-start gap-1.5 text-[11px] text-foreground"
                  : "sr-only"
              }
            >
              {containerBlocked ? (
                <>
                  <WarningCircleIcon
                    weight="fill"
                    className="mt-px size-3.5 shrink-0"
                    aria-hidden
                  />
                  <span>{blockedReason}</span>
                  {isolationNote?.settingsAction ? (
                    // Same handler as the popover's button — it stashes the whole
                    // start-state before navigating, so a bare openSettings here
                    // would silently lose the draft and every pick.
                    <Button
                      variant="ghost"
                      size="sm"
                      className="-mt-0.5 h-6 shrink-0 px-1.5 text-[11px] text-muted-foreground"
                      onClick={openIsolationSettings}
                    >
                      Set up in Settings…
                    </Button>
                  ) : null}
                </>
              ) : null}
            </p>
            <div className="flex items-center gap-2 border-t pt-2">
              {/* Provider + model stay inline for quick access; run mode, effort,
                  and MCP collapse into Options so the row never overflows. Best-of-N
                  hides the inline pickers — each arm sets its own in the dialog. */}
              {!session && mode === "single" && (
                <AgentPicker
                  value={startAgent}
                  onChange={(a) => {
                    setStartAgent(a);
                    setStartModel(""); // model lists differ between agents
                    setStartMcp(null); // re-derive the new agent's default servers
                  }}
                />
              )}
              {(session || mode === "single") && (
                <ModelPicker value={model} onChange={onModel} models={models} />
              )}
              <ComposerOptions
                effort={session || mode === "single" ? effort : undefined}
                onEffort={session || mode === "single" ? onEffort : undefined}
                mode={!session ? mode : undefined}
                onMode={!session ? setMode : undefined}
                isolation={
                  session
                    ? undefined
                    : {
                        value: resolvedStartIsolation,
                        onChange: setStartIsolation,
                        isOverride:
                          startIsolation !== null &&
                          startIsolation !== globalIsolation,
                        note: isolationNote,
                        onSettingsAction: openIsolationSettings,
                      }
                }
                mcp={composerMcp}
              />
              <AnimatePresence mode="wait" initial={false}>
                {running ? (
                  <m.div
                    key="stop"
                    className="ml-auto"
                    initial={{ opacity: 0, scale: 0.96 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.96 }}
                    transition={quickTransition}
                  >
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => session && cancel(session.id)}
                    >
                      <StopIcon weight="fill" />
                      Stop
                    </Button>
                  </m.div>
                ) : (
                  <m.div
                    key="send"
                    className="ml-auto"
                    initial={{ opacity: 0, scale: 0.96 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.96 }}
                    transition={quickTransition}
                  >
                    {/* A `title` on a DISABLED button never fires, so the
                        container-not-ready reason rides a wrapper span. */}
                    <span
                      className="inline-flex"
                      title={containerBlocked ? blockedReason : undefined}
                    >
                      <Button
                        size="sm"
                        className="min-w-20"
                        disabled={!canSubmit}
                        aria-describedby={
                          containerBlocked ? blockedId : undefined
                        }
                        onClick={submit}
                      >
                        {creating && !session
                          ? "Starting…"
                          : !session && mode === "ensemble"
                            ? "Best-of-N…"
                            : "Send"}
                      </Button>
                    </span>
                  </m.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>
      </div>
      <EnsembleRunDialog
        open={ensembleOpen}
        onOpenChange={setEnsembleOpen}
        seed={{ agent: startAgent, model: startModel, effort: startEffort }}
        estimate={costEstimate}
        onRun={runEnsemble}
      />
    </>
  );
}

function MentionList({
  matches,
  index,
  loading,
  query,
  onPick,
  onHover,
}: {
  matches: string[];
  index: number;
  loading: boolean;
  query: string;
  onPick: (path: string) => void;
  onHover: (i: number) => void;
}) {
  return (
    <div
      id="session-mention-list"
      role="listbox"
      aria-label="Repository files"
      className="absolute bottom-full left-0 z-20 mb-1 max-h-56 w-full overflow-y-auto border bg-popover shadow-md ring-1 ring-foreground/10"
    >
      {matches.length === 0 ? (
        <p className="px-2.5 py-2 text-[11px] text-muted-foreground">
          {loading ? "Loading files…" : `No files match “${query}”.`}
        </p>
      ) : (
        matches.map((f, i) => {
          const slash = f.lastIndexOf("/");
          const dir = slash >= 0 ? f.slice(0, slash + 1) : "";
          const name = slash >= 0 ? f.slice(slash + 1) : f;
          return (
            <button
              key={f}
              id={`session-mention-${i}`}
              role="option"
              aria-selected={i === index}
              type="button"
              // mousedown (not click) so the textarea doesn't blur before insert
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(f);
              }}
              onMouseMove={() => onHover(i)}
              className={cn(
                "flex w-full min-w-0 items-baseline gap-1.5 px-2.5 py-1.5 text-left text-xs",
                i === index
                  ? "bg-accent text-accent-foreground"
                  : "hover:bg-muted/60",
              )}
            >
              <span className="truncate font-medium">{name}</span>
              {dir && (
                <span className="truncate text-[11px] text-muted-foreground">
                  {dir}
                </span>
              )}
            </button>
          );
        })
      )}
    </div>
  );
}

/** The `/command` autocomplete popover. Mirrors MentionList: a keyboard-driven
 *  listbox above the composer, mouse hover/select via mousedown (so the textarea
 *  keeps focus). Repo/custom commands carry a small source badge. */
function SlashList({
  matches,
  index,
  loading,
  query,
  onPick,
  onHover,
}: {
  matches: SlashCommand[];
  index: number;
  loading: boolean;
  query: string;
  onPick: (cmd: SlashCommand) => void;
  onHover: (i: number) => void;
}) {
  // Keep the keyboard-highlighted row visible as you arrow through the full,
  // un-narrowed (scrollable) list.
  useEffect(() => {
    document
      .getElementById(`session-slash-${index}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [index]);

  return (
    <div
      id="session-slash-list"
      role="listbox"
      aria-label="Slash commands"
      className="absolute bottom-full left-0 z-20 mb-1 max-h-56 w-full overflow-y-auto border bg-popover shadow-md ring-1 ring-foreground/10"
    >
      {matches.length === 0 ? (
        <p className="px-2.5 py-2 text-[11px] text-muted-foreground">
          {loading ? "Loading…" : `No commands or skills match “/${query}”.`}
        </p>
      ) : (
        matches.map((c, i) => {
          // One small right-aligned tag: skills and native CLI commands stand
          // out, then custom, then global scope. Project-scoped agent commands
          // get none (the default).
          const badge =
            c.kind === "skill"
              ? "skill"
              : c.kind === "native"
                ? "built-in"
                : c.source === "custom"
                  ? "custom"
                  : c.scope === "global"
                    ? "global"
                    : null;
          return (
            <button
              key={`${c.kind}:${c.name}`}
              id={`session-slash-${i}`}
              role="option"
              aria-selected={i === index}
              type="button"
              // mousedown (not click) so the textarea doesn't blur before select
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(c);
              }}
              onMouseMove={() => onHover(i)}
              className={cn(
                "flex w-full min-w-0 items-baseline gap-1.5 px-2.5 py-1.5 text-left text-xs",
                i === index
                  ? "bg-accent text-accent-foreground"
                  : "hover:bg-muted/60",
              )}
            >
              <span className="shrink-0 font-medium">/{c.name}</span>
              {c.argumentHint && (
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {c.argumentHint}
                </span>
              )}
              <span className="truncate text-[11px] text-muted-foreground">
                {c.description}
              </span>
              {badge && (
                <span
                  className={cn(
                    "ml-auto shrink-0 text-[10px] uppercase tracking-wide",
                    c.kind === "skill"
                      ? "text-primary/80"
                      : "text-muted-foreground/70",
                  )}
                >
                  {badge}
                </span>
              )}
            </button>
          );
        })
      )}
    </div>
  );
}
