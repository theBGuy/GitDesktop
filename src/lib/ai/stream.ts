import type { ToolSet } from "ai";
import { useCallback, useRef, useState } from "react";
import {
  gitFetchObjects,
  gitRemoveWorktree,
  gitReviewWorktree,
} from "@/lib/git/api";
import { toastError } from "@/lib/toast";
import type { AgentToolKind } from "./agent";
import { cancelAgentReview, providerKind, runAgentReview } from "./agent";
import { terminalErrorMessage } from "./cli-client";
import { createAiClient, runAgenticStream } from "./client";
import { isCliProvider } from "./providers";
import type { AiSettings } from "./types";

export interface CliStreamOpts {
  ai: AiSettings;
  system: string;
  prompt: string;
  /** Working directory the CLI agent runs in (also its repo-aware root). */
  repoPath: string;
  /** PR head SHA. When repo-aware and this isn't the active checkout, the agent
   *  runs in a throwaway detached worktree at this commit, so it reads the PR's
   *  files instead of the user's current branch. Removed when the run settles. */
  headSha?: string;
  setText: (text: string) => void;
  setStatus: (status: string) => void;
  registerId: (id: string) => void;
  /** The run's reported cost (USD), delivered with the terminal `done` event.
   *  Null when the CLI doesn't report one. Optional — most callers ignore it. */
  onCost?: (costUsd: number | null) => void;
  /** Reasoning/effort level for the run ("" = provider default). Optional — only
   *  the repo-aware flows that expose a picker (e.g. Plan) set it. */
  effort?: string;
  /** Attach GitDesktop's own read-only MCP server to the run (reviews only), so an agentic
   *  reviewer can pull the full PR diff and read files at any ref. Default off. */
  mcpSelf?: boolean;
  /** Kill-timeout override for the run, in seconds. Review flows resolve it from
   *  the user's Review-timeout setting; generation / Debug-with-AI callers omit
   *  it and keep the backend's tier defaults. */
  timeoutSecs?: number | null;
  /** True only for the AI-review flows the Review-timeout setting governs; drives
   *  the timed-out message's settings hint. Omitted by Debug with AI / generation. */
  timeoutConfigurable?: boolean;
  /** Called at most once, at successful settle, with the narration that streamed
   *  before the final answer (a tool-using run's "Let me check…" prose). Never
   *  called when there is none — a codex run (no deltas) or a run whose whole
   *  buffer IS the final answer. */
  onThoughts?: (text: string) => void;
}

/** A short, human status line for a tool step, from the normalized kind + target
 *  (the `target` may be null — degrade to the bare verb). Surfaces the agentic
 *  run's exploration in the panel's existing status line. */
function toolStatusLine(tool: AgentToolKind, target: string | null): string {
  const at = target?.trim();
  switch (tool) {
    case "read":
      return at ? `Reading ${at}…` : "Reading a file…";
    case "search":
      return at ? `Searching ${at}…` : "Searching…";
    case "list":
      return at ? `Listing ${at}…` : "Listing files…";
    case "web-fetch":
    case "web-search":
      return "Searching the web…";
    case "run":
      return "Running a command…";
    default:
      return "Working…";
  }
}

/**
 * Drives one streaming agent-CLI run, accumulating deltas into `setText`.
 * Shared by the PR review and the Actions "Debug with AI" flows.
 */
export async function runCliStream({
  ai,
  system,
  prompt,
  repoPath,
  headSha,
  setText,
  setStatus,
  registerId,
  onCost,
  effort,
  mcpSelf,
  timeoutSecs,
  timeoutConfigurable,
  onThoughts,
}: CliStreamOpts): Promise<void> {
  const kind = providerKind(ai.provider);
  if (!kind) throw new Error(`Unsupported CLI provider: ${ai.provider}`);

  const reviewId = crypto.randomUUID();
  registerId(reviewId);

  // Repo-aware reviews read files from the working tree. When the PR head isn't
  // the active checkout, run the agent in a throwaway detached worktree pinned at
  // that commit so it reads the PR's files, not the user's current branch.
  let cwd = repoPath;
  let worktree: string | null = null;
  if (ai.cliRepoAware && headSha) {
    setStatus("Preparing review workspace…");
    // A remote PR head (fork / pushed elsewhere) may not be a local object, so
    // best-effort fetch it first — otherwise the worktree can't pin it and the
    // agent silently falls back to the user's checked-out branch.
    await gitFetchObjects(repoPath, [headSha]).catch(() => undefined);
    worktree = await gitReviewWorktree(repoPath, headSha).catch(() => null);
    if (worktree) cwd = worktree;
  }

  try {
    let buffer = "";
    let settled = false;
    await new Promise<void>((resolve, reject) => {
      runAgentReview({
        kind,
        binPath: ai.cliPath?.trim() || null,
        model: ai.model,
        effort: effort ?? "",
        systemPrompt: system,
        userPrompt: prompt,
        repoPath: cwd,
        repoAware: Boolean(ai.cliRepoAware),
        mcpSelf: Boolean(mcpSelf),
        timeoutSecs: timeoutSecs ?? null,
        timeoutConfigurable: Boolean(timeoutConfigurable),
        reviewId,
        onEvent: (event) => {
          if (event.kind === "delta") {
            buffer += event.text;
            setText(buffer);
          } else if (event.kind === "status") {
            setStatus(event.text);
          } else if (event.kind === "tool") {
            setStatus(toolStatusLine(event.tool, event.target));
          } else if (event.kind === "done") {
            settled = true;
            onCost?.(event.costUsd);
            // An errored run keeps whatever streamed — partial text plus the error, no strip.
            // Its terminal text is the CLI's error message, not review content: surface it.
            if (event.isError) {
              reject(new Error(terminalErrorMessage(event.text)));
              return;
            }
            // The terminal event's text IS the agent's final answer. The delta buffer
            // additionally holds any tool-using narration ("Let me check…") that streamed
            // ahead of it, and adopting the buffer here leaks that narration into the review
            // — so the final answer wins (buffer only as a fallback for a degenerate empty
            // terminal event) and the narration is peeled off as separate "thoughts".
            const final = event.text.trim() ? event.text : buffer;
            setText(final);
            // Peel narration ONLY on a genuine suffix match (deltas may prepend a separator
            // before the final answer). A mismatched buffer is NOT narration — it's a
            // fallen-short delta stream or a drifted wire format, and a spurious "thoughts"
            // copy of the review body is worse than no thoughts.
            if (
              event.text.trim() &&
              buffer !== event.text &&
              buffer.endsWith(event.text)
            ) {
              const thoughts = buffer
                .slice(0, buffer.length - event.text.length)
                .trim();
              if (thoughts) onThoughts?.(thoughts);
            }
            resolve();
          } else if (event.kind === "error") {
            settled = true;
            reject(new Error(event.message));
          }
          // nativeSession (the CLI's turn-1 resume id) is session-only — reviews ignore it.
        },
      })
        // Backend returned without a terminal event — the cancel path.
        .then(() => {
          if (!settled) resolve();
        })
        .catch(reject);
    });
  } finally {
    // Tear down the ephemeral worktree on every exit (done/cancel/error).
    if (worktree) {
      void gitRemoveWorktree(repoPath, worktree).catch(() => undefined);
    }
  }
}

export interface StreamAiOpts {
  ai: AiSettings;
  system: string;
  prompt: string;
  /** Working directory / repo root (CLI providers only). */
  repoPath: string;
  /** PR head SHA for a CLI repo-aware worktree; omit for non-PR flows. */
  headSha?: string;
  /** Attach GitDesktop's own read-only MCP server to the run (reviews only); omitted by
   *  non-review callers (Debug with AI, generation). */
  mcpSelf?: boolean;
  /** Kill-timeout override in seconds for a CLI review run, from the user's
   *  Review-timeout setting. CLI path only — the HTTP branch ignores it; other
   *  callers omit it and keep the backend's tier defaults. */
  timeoutSecs?: number | null;
  /** True only for the AI-review flows the Review-timeout setting governs; drives
   *  the timed-out message's settings hint. CLI path only. */
  timeoutConfigurable?: boolean;
  /** Native AI-SDK review tools for an HTTP-provider agentic review — the model explores
   *  via a tool loop (no MCP, no worktree). HTTP agentic reviews only; CLI and non-review
   *  callers omit it. */
  reviewTools?: ToolSet;
  setText: (text: string) => void;
  setStatus: (status: string) => void;
  /** Called at most once, at successful settle, with the narration that streamed
   *  before the final answer (agentic CLI + HTTP runs only). The plain HTTP text
   *  path has no narration and never calls it. */
  onThoughts?: (text: string) => void;
  /** CLI path: receives the agent review id (cancel via `cancelAgentReview`). */
  onCliId: (id: string) => void;
  /** HTTP path: receives the AbortController driving the stream (cancel via
   *  `.abort()`). Not called for CLI providers. */
  onAbort: (controller: AbortController) => void;
}

/**
 * Routes a system+prompt to a CLI agent ({@link runCliStream}) or an HTTP
 * provider (Vercel AI SDK), accumulating response deltas via `setText`. The two
 * cancel handles differ — CLI by review id, HTTP by AbortController — so the
 * caller registers whichever applies via `onCliId` / `onAbort`. The single
 * streaming engine shared by {@link useAiTextStream} and the PR-review store.
 */
export async function streamAi({
  ai,
  system,
  prompt,
  repoPath,
  headSha,
  mcpSelf,
  timeoutSecs,
  timeoutConfigurable,
  reviewTools,
  setText,
  setStatus,
  onThoughts,
  onCliId,
  onAbort,
}: StreamAiOpts): Promise<void> {
  if (isCliProvider(ai.provider)) {
    await runCliStream({
      ai,
      system,
      prompt,
      repoPath,
      headSha,
      mcpSelf,
      timeoutSecs,
      timeoutConfigurable,
      setText,
      setStatus,
      registerId: onCliId,
      onThoughts,
    });
    return;
  }
  const abort = new AbortController();
  onAbort(abort);
  // HTTP-provider agentic review: drive a native tool loop instead of the plain
  // text stream. The tools read at the PR head ref (no worktree), so best-effort
  // fetch that commit first — a fork PR's head may not be a local object yet
  // (the Rust command short-circuits when it already is, so this is cheap).
  if (reviewTools) {
    if (headSha) {
      await gitFetchObjects(repoPath, [headSha]).catch(() => undefined);
    }
    await runAgenticStream({
      settings: ai,
      system,
      prompt,
      tools: reviewTools,
      abortSignal: abort.signal,
      setText,
      setStatus,
      onThoughts,
    });
    return;
  }
  const client = await createAiClient(ai);
  let buffer = "";
  for await (const chunk of client.stream({
    system,
    prompt,
    abortSignal: abort.signal,
    // HTTP-only path (CLI returned early); repoPath is passed regardless so every stream
    // call carries it and the invariant stays grep-clean.
    repoPath,
  })) {
    buffer += chunk;
    setText(buffer);
  }
}

export interface RunStreamArgs {
  system: string;
  prompt: string;
  repoPath: string;
}

/**
 * Generic streaming-AI hook: routes a system+prompt to an HTTP provider (Vercel
 * AI SDK) or a CLI agent subprocess, accumulating the response into `text`.
 * `repoPath` is only used by CLI providers. `run` resolves true only for a run that
 * completed without error and without a cancel, so a caller that consumes `text`
 * afterwards can tell a real result from a failed/cancelled partial.
 */
export function useAiTextStream() {
  const [generating, setGenerating] = useState(false);
  const [text, setText] = useState("");
  const [status, setStatus] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const cliIdRef = useRef<string | null>(null);
  const cancelledRef = useRef(false);
  // Bumped on every run() so a superseded run (e.g. switching debug jobs while
  // the previous run is still streaming) can't clobber the newer run's shared
  // state or surface a stale error toast.
  const runGenRef = useRef(0);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    abortRef.current?.abort();
    if (cliIdRef.current) {
      cancelAgentReview(cliIdRef.current).catch(() => undefined);
    }
  }, []);

  const reset = useCallback(() => {
    setText("");
    setStatus("");
  }, []);

  const run = useCallback(
    async (ai: AiSettings, args: RunStreamArgs): Promise<boolean> => {
      const gen = ++runGenRef.current;
      const isCurrent = () => gen === runGenRef.current;
      // A superseded run must not touch the shared state the newer run now owns.
      const putText = (t: string) => {
        if (isCurrent()) setText(t);
      };
      const putStatus = (s: string) => {
        if (isCurrent()) setStatus(s);
      };
      cancelledRef.current = false;
      setGenerating(true);
      setText("");
      setStatus("");
      try {
        await streamAi({
          ai,
          system: args.system,
          prompt: args.prompt,
          repoPath: args.repoPath,
          setText: putText,
          setStatus: putStatus,
          onCliId: (id) => {
            if (isCurrent()) cliIdRef.current = id;
          },
          onAbort: (a) => {
            if (isCurrent()) abortRef.current = a;
          },
        });
        // A cancel can also settle cleanly (a killed CLI run returns with no
        // terminal event), so success is "no throw AND not cancelled".
        return !cancelledRef.current;
      } catch (e) {
        if (!cancelledRef.current && isCurrent()) toastError(e);
        return false;
      } finally {
        // Only the latest run settles the shared state.
        if (isCurrent()) {
          setGenerating(false);
          setStatus("");
          abortRef.current = null;
          cliIdRef.current = null;
        }
      }
    },
    [],
  );

  return { run, cancel, reset, generating, text, status };
}
