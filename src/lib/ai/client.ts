import {
  generateText,
  type LanguageModel,
  stepCountIs,
  streamText,
  type ToolSet,
} from "ai";
import { getSecret } from "@/lib/git/api";
import { errorMessage } from "@/lib/tauri/invoke";
import { probeOllamaWindowTokens } from "./context-budget";
import { isCliProvider, PROVIDERS_REQUIRING_KEY } from "./providers";
import { httpToolStatusLine } from "./review-tools";
import type { AiClient, AiSettings, AiStreamRequest } from "./types";

export class MissingApiKeyError extends Error {
  constructor(provider: string) {
    super(`No API key saved for ${provider}. Add one in Settings.`);
    this.name = "MissingApiKeyError";
  }
}

/** The human-readable reason out of a provider error payload, whether it nests under
 *  `error` as an object (OpenAI, Google), sits bare on `message`, or is a plain string
 *  under `error` (Ollama's native `/api`), array-wrapped (Google) or not. One reader
 *  for both call sites below: the parsed response body and the raw in-stream payload
 *  carry the same shapes, so they must accept the same set. */
function errorTextOf(value: unknown): string | null {
  const entry = (Array.isArray(value) ? value[0] : value) as {
    error?: { message?: unknown } | string;
    message?: unknown;
  } | null;
  const nested = entry?.error;
  const message =
    typeof nested === "string" ? nested : (nested?.message ?? entry?.message);
  return typeof message === "string" && message.trim() ? message : null;
}

/**
 * The provider's own explanation for a failed call, falling back to the generic
 * message. Three constraints shape it: a body the SDK's error schema can't parse
 * leaves `APICallError.message` as the bare HTTP reason phrase with the cause unread
 * in `responseBody` (Google's is array-wrapped, so a rejected key reads "Bad Request"
 * rather than "Invalid Auth key."); a retry moves that body onto `RetryError.lastError`,
 * and `isRetryable` covers 429/5xx — the quota case; and an in-stream error part is the
 * provider's already-parsed payload rather than an Error.
 */
function providerErrorMessage(e: unknown): string {
  const unwrapped = ((e as { lastError?: unknown } | null)?.lastError ?? e) as {
    responseBody?: unknown;
  } | null;
  const body = unwrapped?.responseBody;
  if (typeof body === "string" && body.trim()) {
    try {
      const fromBody = errorTextOf(JSON.parse(body));
      if (fromBody) return fromBody;
    } catch {
      // Not JSON — the generic message is the best we have.
    }
  }
  // An Error's own `message` is what the generic fallback already returns; only a raw
  // payload object needs reading here.
  if (!(unwrapped instanceof Error)) {
    const fromPayload = errorTextOf(unwrapped);
    if (fromPayload) return fromPayload;
  }
  // Deliberately the wrapper, not `unwrapped`: a retry's message embeds the last
  // error's text and adds the attempt count, which is worth keeping.
  return errorMessage(e);
}

/**
 * Resolves `settings` to a ready model: reads the saved API key (or an unsaved
 * override), throwing {@link MissingApiKeyError} when a key-requiring provider has
 * none, then builds the guarded-fetch model. Shared by {@link createAiClient} and
 * {@link runAgenticStream}.
 */
export async function resolveModel(
  settings: AiSettings,
  apiKeyOverride?: string,
  allowedHostsOverride?: readonly string[],
): Promise<LanguageModel> {
  const needsKey = PROVIDERS_REQUIRING_KEY.includes(settings.provider);
  const override = apiKeyOverride?.trim();
  const apiKey = needsKey
    ? override || (await getSecret(settings.provider))
    : null;
  if (needsKey && !apiKey) {
    throw new MissingApiKeyError(settings.provider);
  }
  // The heavy AI-SDK provider packages live in `model-factory` and load only
  // here, on the first real generation — after the key check above, so the
  // MissingApiKeyError path never pays for (or surfaces) the import.
  const { createModel } = await import("./model-factory");
  return createModel(settings, apiKey, allowedHostsOverride);
}

/**
 * Builds a client for `settings`. `apiKeyOverride` lets a caller (Settings' "Test
 * connection") try a key typed but not yet saved to the keychain; empty ⇒ the saved
 * key. `allowedHostsOverride` is the analogous override for the AI host allowlist, so
 * a just-added custom host can be tested before Save; omitted elsewhere ⇒ the guarded
 * fetch reads the saved list.
 *
 * CLI providers (claude/codex/copilot/opencode) route to the agent-CLI subprocess
 * path instead — a Tier-1 (no-tools) adapter over `runAgentReview`. Both overrides
 * are HTTP-only and ignored there (CLIs authenticate via their own login and make
 * no guarded fetch); each `stream` call must carry `repoPath`.
 */
export async function createAiClient(
  settings: AiSettings,
  apiKeyOverride?: string,
  allowedHostsOverride?: readonly string[],
): Promise<AiClient> {
  // A CLI id must never reach the SDK model factory — branch before resolveModel.
  // Lazy import mirrors the model-factory pattern (heavy deps load only on use).
  if (isCliProvider(settings.provider)) {
    const { createCliClient } = await import("./cli-client");
    return createCliClient(settings);
  }
  const model = await resolveModel(
    settings,
    apiKeyOverride,
    allowedHostsOverride,
  );

  return {
    async *stream(req: AiStreamRequest) {
      // Ollama's server-side default context window is version/config-dependent and
      // unobservable from the client; without an explicit `num_ctx` a budgeted prompt
      // larger than it is SILENTLY truncated. Size `num_ctx` to THIS request's need,
      // not the model's full window, so the KV-cache allocation stays proportional
      // (the full window risks OOM on small boxes). Probe failure → omit entirely.
      // Excludes ollama-cloud: its managed host owns its defaults.
      const providerOptions = await ollamaProviderOptions(settings, req);
      const result = streamText({
        model,
        system: req.system,
        prompt: req.prompt,
        abortSignal: req.abortSignal,
        ...(providerOptions ? { providerOptions } : {}),
      });
      // `textStream` forwards ONLY text deltas and routes an in-stream provider
      // error to the default `onError` (console.error), so a failed run ends
      // cleanly and reads as a short success. `fullStream` lets it throw instead.
      try {
        for await (const part of result.fullStream) {
          switch (part.type) {
            case "text-delta":
              yield part.text;
              break;
            case "error":
              throw new Error(providerErrorMessage(part.error));
            case "abort":
              throw new DOMException(
                "The generation was cancelled.",
                "AbortError",
              );
            // Non-answer parts (reasoning deltas included) are dropped on purpose —
            // only answer text belongs in a draft; no tools are passed, so no tool
            // part can arrive.
            default:
              break;
          }
        }
      } catch (e) {
        // An abort surfaces either as the part above or as a thrown AbortError
        // mid-await; both must keep the AbortError name, which consumers gate
        // cancellation on (a cancel is "no result", never a partial buffer).
        if (
          req.abortSignal?.aborted ||
          (e instanceof DOMException && e.name === "AbortError")
        ) {
          throw new DOMException("The generation was cancelled.", "AbortError");
        }
        throw new Error(providerErrorMessage(e));
      }
    },
    async testConnection() {
      try {
        const result = await generateText({
          model,
          prompt: 'Reply with exactly the word "OK".',
        });
        return result.text.length > 0
          ? ({ ok: true } as const)
          : ({
              ok: false,
              message: "Model returned an empty response.",
            } as const);
      } catch (e) {
        return { ok: false, message: providerErrorMessage(e) } as const;
      }
    },
  };
}

/**
 * Computes the `providerOptions` payload pinning Ollama's request context window
 * (`num_ctx`) to what THIS request needs, or `null` to omit it (status quo: server
 * default). Self-hosted `ollama` only — never `ollama-cloud`, whose managed host owns
 * its defaults. The window is the estimated prompt tokens plus response headroom,
 * floored at 4,096 and capped at the model's architectural window. It MAY end up
 * smaller than a generous server default; harmless, because the estimate still covers
 * this request.
 */
async function ollamaProviderOptions(
  settings: AiSettings,
  req: AiStreamRequest,
): Promise<{ ollama: { options: { num_ctx: number } } } | null> {
  if (settings.provider !== "ollama") return null;
  const windowTokens = await probeOllamaWindowTokens(settings);
  if (!windowTokens || windowTokens <= 0) return null;
  // ÷3 BYTES/token is deliberately conservative (over-estimates tokens) so the
  // window is sized against truncation. Measuring UTF-8 bytes, not UTF-16 chars,
  // keeps the margin for multi-byte content: CJK runs ~1-1.5 chars/token but ~3
  // bytes/char, so a char-based ÷3 would undershoot 2-3× and truncate exactly
  // where a generous server default would have covered it (ASCII is unchanged).
  const promptBytes = new TextEncoder().encode(
    (req.system ?? "") + req.prompt,
  ).length;
  const promptTokensEstimate = Math.ceil(promptBytes / 3);
  const numCtx = Math.min(
    windowTokens,
    Math.max(4_096, promptTokensEstimate + 8_192),
  );
  return { ollama: { options: { num_ctx: numCtx } } };
}

/** Options for {@link runAgenticStream}. */
export interface AgenticStreamOpts {
  settings: AiSettings;
  system: string;
  prompt: string;
  /** The native AI-SDK review tools the model may call to explore. */
  tools: ToolSet;
  abortSignal: AbortSignal;
  setText: (t: string) => void;
  setStatus: (s: string) => void;
  /** Called at most once, at successful settle, with the narration (prose before
   *  the last tool step) that preceded the conclusion. Never called when the run
   *  had no tool steps or no distinct narration to peel off. */
  onThoughts?: (t: string) => void;
}

/** Max reasoning/tool steps a single agentic review may take before it must
 *  answer — `streamText` defaults to a single step, which kills the loop. */
const AGENTIC_MAX_STEPS = 24;

/**
 * Drives one HTTP-provider agentic review: a native AI-SDK tool loop over `opts.tools`,
 * accumulating prose into `setText` and surfacing each tool step in `setStatus`.
 * Consumes `fullStream` (unlike the plain stream) so tool events are visible; tool
 * failures arrive as parts and don't throw (the model sees the error and adapts), while
 * an in-stream provider `error` part is thrown to fail the run honestly.
 */
export async function runAgenticStream(opts: AgenticStreamOpts): Promise<void> {
  const model = await resolveModel(opts.settings);

  // On local Ollama, pin `num_ctx` to the FULL probed window — the deliberate REVERSAL
  // of the non-agentic stream's request-sized rationale. A tool loop grows unboundedly
  // (results accumulate across up to AGENTIC_MAX_STEPS), so there's no fixed prompt
  // size to size against, and for a mode the user opted into a visible allocation
  // failure beats silently truncating the tool results the mode exists to fetch.
  // Self-hosted `ollama` only; probe failure → omit (server default).
  let agenticProviderOptions:
    | { ollama: { options: { num_ctx: number } } }
    | undefined;
  if (opts.settings.provider === "ollama") {
    const windowTokens = await probeOllamaWindowTokens(opts.settings);
    if (windowTokens && windowTokens > 0) {
      agenticProviderOptions = {
        ollama: { options: { num_ctx: windowTokens } },
      };
    }
  }

  let result: ReturnType<typeof streamText>;
  try {
    result = streamText({
      model,
      system: opts.system,
      prompt: opts.prompt,
      tools: opts.tools,
      abortSignal: opts.abortSignal,
      stopWhen: stepCountIs(AGENTIC_MAX_STEPS),
      ...(agenticProviderOptions
        ? { providerOptions: agenticProviderOptions }
        : {}),
    });
  } catch (e) {
    throw new Error(annotateToolError(providerErrorMessage(e)));
  }

  let buffer = "";
  // Set when a text block ends or a tool step ran; the next `text-start`/`text-delta`
  // clears any stale status and, if prior text exists, inserts a paragraph break so
  // successive blocks don't concatenate mid-word. Cleared on the first text after it.
  let pendingBreak = false;
  // Terminal state, captured on `finish` so a zero-text run can explain itself.
  let finishReason = "unknown";
  let toolSteps = 0;
  // Offset in `buffer` where the conclusion begins — advanced to the current
  // buffer length after every tool step, so it ends up pointing just past the LAST
  // tool activity. Prose after it is the review body; prose before it is narration.
  let conclusionStart = 0;
  try {
    for await (const part of result.fullStream) {
      switch (part.type) {
        case "text-start": {
          if (pendingBreak) {
            opts.setStatus("");
            if (buffer) buffer += "\n\n";
            pendingBreak = false;
          }
          break;
        }
        case "text-delta": {
          if (pendingBreak) {
            // A model that emits deltas without a preceding text-start still
            // needs the status cleared and the paragraph break inserted.
            opts.setStatus("");
            if (buffer) buffer += "\n\n";
            pendingBreak = false;
          }
          buffer += part.text;
          opts.setText(buffer);
          break;
        }
        case "text-end": {
          // A fresh text block may follow within the same step (no tool call
          // between) — break before it so blocks don't run together.
          pendingBreak = true;
          break;
        }
        case "tool-call": {
          toolSteps++;
          opts.setStatus(httpToolStatusLine(part.toolName, part.input));
          pendingBreak = true;
          // Everything after this last tool activity is (so far) the conclusion.
          conclusionStart = buffer.length;
          break;
        }
        case "tool-error": {
          opts.setStatus(`Tool ${part.toolName} failed — continuing…`);
          pendingBreak = true;
          conclusionStart = buffer.length;
          break;
        }
        case "finish": {
          finishReason = part.finishReason;
          break;
        }
        case "error": {
          throw new Error(annotateToolError(providerErrorMessage(part.error)));
        }
        case "abort": {
          // `type: 'abort'` is real in the installed ai@6 TextStreamPart union; an
          // abort may ALSO surface as a thrown AbortError mid-await (the catch below).
          // Either way: clean cancellation, not an error.
          return;
        }
        default:
          break;
      }
    }
  } catch (e) {
    if (opts.abortSignal.aborted) return; // clean cancellation — not an error
    throw new Error(annotateToolError(providerErrorMessage(e)));
  }

  // A clean finish that produced no prose (all steps spent on tool calls, or ended on
  // `length`/`tool-calls`) would resolve silently → the panel shows the never-ran
  // placeholder. Fail honestly so nothing gets persisted. An abort returns above.
  if (!buffer.trim()) {
    throw new Error(
      `The review ended after ${toolSteps} tool step(s) without producing a conclusion (${finishReason}). Try again, or turn off Agentic review for a single-pass response.`,
    );
  }

  // A tool-using run streams exploration narration ahead of the final review. Prose
  // after the LAST tool step is the conclusion (the authoritative body); prose before
  // it is narration, peeled into "thoughts". An empty conclusion (a heuristic miss)
  // leaves the full buffer as the body, never dropping content.
  //
  // Accepted limitation: a model that interleaves findings with verification calls gets
  // its pre-tool findings demoted into the disclosure — content preserved, placement
  // imperfect. This mirrors the CLI providers' native semantics.
  if (conclusionStart > 0) {
    const conclusion = buffer.slice(conclusionStart).trim();
    if (conclusion) {
      opts.setText(conclusion);
      const thoughts = buffer.slice(0, conclusionStart).trim();
      if (thoughts) opts.onThoughts?.(thoughts);
    }
  }
}

const TOOL_HINT =
  " — this model may not support tools; turn off Agentic review or pick another model.";

/** Matches an error that specifically says the model does NOT support tool /
 *  function calling — requiring BOTH a support-negation AND tool/function
 *  context, so a message merely mentioning "toolchain" or a per-call argument
 *  error doesn't trip it. */
const TOOL_UNSUPPORTED =
  /(does not|doesn't|do not|not) support(ed)?[^.]*\b(tool|function)|tool[ _-]?(use|call(ing|s)?)[^.]*\b(not|un)support/i;

/** If an error reads like the model rejected tool/function calling, append a
 *  hint pointing the user at the escape hatch. A dumb, side-effect-free check;
 *  idempotent so the loop's outer catch never double-appends. */
function annotateToolError(message: string): string {
  if (message.endsWith(TOOL_HINT)) return message;
  if (TOOL_UNSUPPORTED.test(message)) {
    return `${message}${TOOL_HINT}`;
  }
  return message;
}
