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
  /** Attach GitDesktop's own read-only MCP server to the run (reviews only), so an
   *  agentic reviewer can pull the full PR diff and read files at any ref. Default
   *  off keeps every other CLI flow (Debug with AI, generation) byte-identical. */
  mcpSelf?: boolean;
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
        reviewId,
        onEvent: (event) => {
          if (event.kind === "delta") {
            buffer += event.text;
            setText(buffer);
          } else if (event.kind === "status") {
            setStatus(event.text);
          } else if (event.kind === "tool") {
            // Make the agent's exploration visible in the panel's status line
            // (previously silent between the CLI's own status events).
            setStatus(toolStatusLine(event.tool, event.target));
          } else if (event.kind === "done") {
            settled = true;
            onCost?.(event.costUsd);
            // The terminal event carries the authoritative full text; prefer it
            // if the partial stream fell short (e.g. deltas were coalesced).
            if (event.text.length > buffer.length) setText(event.text);
            if (event.isError)
              reject(new Error("The run ended with an error."));
            else resolve();
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
  /** Attach GitDesktop's own read-only MCP server to the run (reviews only).
   *  Omitted by non-review callers (Debug with AI, generation), keeping them
   *  byte-identical. */
  mcpSelf?: boolean;
  /** Native AI-SDK review tools for an HTTP-provider agentic review — the model
   *  explores via a tool loop (no MCP, no worktree). HTTP agentic reviews only;
   *  CLI and non-review callers omit it, keeping their path byte-identical. */
  reviewTools?: ToolSet;
  setText: (text: string) => void;
  setStatus: (status: string) => void;
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
  reviewTools,
  setText,
  setStatus,
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
      setText,
      setStatus,
      registerId: onCliId,
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
    });
    return;
  }
  const client = await createAiClient(ai);
  let buffer = "";
  for await (const chunk of client.stream({
    system,
    prompt,
    abortSignal: abort.signal,
    // Only reached for HTTP providers — CLI providers returned early above.
    // Passing repoPath regardless keeps every stream call carrying it, so the
    // invariant stays grep-clean.
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
 * `repoPath` is only used by CLI providers.
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

  const run = useCallback(async (ai: AiSettings, args: RunStreamArgs) => {
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
    } catch (e) {
      if (!cancelledRef.current && isCurrent()) toastError(e);
    } finally {
      // Only the latest run settles the shared state.
      if (isCurrent()) {
        setGenerating(false);
        setStatus("");
        abortRef.current = null;
        cliIdRef.current = null;
      }
    }
  }, []);

  return { run, cancel, reset, generating, text, status };
}
