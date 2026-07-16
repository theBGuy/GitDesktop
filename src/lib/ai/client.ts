import {
  generateText,
  type LanguageModel,
  stepCountIs,
  streamText,
  type ToolSet,
} from "ai";
import { getSecret } from "@/lib/git/api";
import { errorMessage } from "@/lib/tauri/invoke";
import { isCliProvider, PROVIDERS_REQUIRING_KEY } from "./providers";
import { httpToolStatusLine } from "./review-tools";
import type { AiClient, AiSettings, AiStreamRequest } from "./types";

export class MissingApiKeyError extends Error {
  constructor(provider: string) {
    super(`No API key saved for ${provider}. Add one in Settings.`);
    this.name = "MissingApiKeyError";
  }
}

/**
 * Resolves `settings` to a ready model: reads the saved API key (or an unsaved
 * override), throwing {@link MissingApiKeyError} when a key-requiring provider
 * has none, then builds the guarded-fetch model. Shared by {@link createAiClient}
 * and {@link runAgenticStream}; `apiKeyOverride`/`allowedHostsOverride` behave as
 * documented on `createAiClient`.
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
 * Builds a client for `settings`. `apiKeyOverride` lets a caller (e.g. the
 * Settings "Test connection" button) try a key that's been typed but not yet
 * saved to the keychain; when empty, the saved key is used. `allowedHostsOverride`
 * is the analogous override for the AI host allowlist — Settings passes the
 * unsaved draft list so a just-added custom host can be tested before Save;
 * omitted elsewhere so the guarded fetch reads the saved list.
 *
 * CLI providers (claude/codex/copilot/opencode) route to the agent-CLI subprocess
 * path instead — a Tier-1 (no-tools) adapter over `runAgentReview`. Both overrides
 * are HTTP-only and ignored for those (CLIs authenticate via their own login and
 * make no guarded HTTP fetch); each `stream` call must carry `repoPath`.
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
      const result = streamText({
        model,
        system: req.system,
        prompt: req.prompt,
        abortSignal: req.abortSignal,
      });
      for await (const chunk of result.textStream) {
        yield chunk;
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
        return { ok: false, message: errorMessage(e) } as const;
      }
    },
  };
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
}

/** Max reasoning/tool steps a single agentic review may take before it must
 *  answer — `streamText` defaults to a single step, which kills the loop. */
const AGENTIC_MAX_STEPS = 24;

/**
 * Drives one HTTP-provider agentic review: a native AI-SDK tool loop over
 * `opts.tools`, accumulating the model's prose into `setText` and surfacing each
 * tool step in `setStatus`. Unlike the plain {@link createAiClient} stream, this
 * consumes `fullStream` so tool-call/-result/-error events are visible; tool
 * failures arrive as parts and don't throw (the model sees the error and adapts),
 * while an in-stream provider `error` part is thrown to fail the run honestly.
 */
export async function runAgenticStream(opts: AgenticStreamOpts): Promise<void> {
  const model = await resolveModel(opts.settings);
  let result: ReturnType<typeof streamText>;
  try {
    result = streamText({
      model,
      system: opts.system,
      prompt: opts.prompt,
      tools: opts.tools,
      abortSignal: opts.abortSignal,
      stopWhen: stepCountIs(AGENTIC_MAX_STEPS),
    });
  } catch (e) {
    throw new Error(annotateToolError(errorMessage(e)));
  }

  let buffer = "";
  // Set when a text block ends or a tool step ran; the next `text-start`/
  // `text-delta` clears any stale status and, if prior text exists, inserts a
  // paragraph break so successive text blocks / step texts don't concatenate
  // mid-word. Cleared on the first text emitted after it, so the normal
  // single-block flow (deltas with no prior break) never gets a spurious break.
  let pendingBreak = false;
  // Terminal state, captured on `finish` so a zero-text run can explain itself.
  let finishReason = "unknown";
  let toolSteps = 0;
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
          break;
        }
        case "tool-error": {
          opts.setStatus(`Tool ${part.toolName} failed — continuing…`);
          pendingBreak = true;
          break;
        }
        case "finish": {
          finishReason = part.finishReason;
          break;
        }
        case "error": {
          throw new Error(annotateToolError(errorMessage(part.error)));
        }
        case "abort": {
          // Real per the installed SDK: ai@6's TextStreamPart union includes
          // `type: 'abort'` (node_modules/ai/dist/index.d.ts ~L2599). An abort
          // may ALSO surface as a thrown AbortError mid-await — the catch below
          // handles that shape. Either way: clean cancellation, not an error.
          return;
        }
        default:
          break;
      }
    }
  } catch (e) {
    if (opts.abortSignal.aborted) return; // clean cancellation — not an error
    throw new Error(annotateToolError(errorMessage(e)));
  }

  // A clean finish that produced no prose (e.g. the model spent all its steps
  // on tool calls, or ended on `length`/`tool-calls`) would otherwise resolve
  // silently → the panel shows the never-ran placeholder. Fail honestly so the
  // error path surfaces it (nothing gets persisted). An abort returns above.
  if (!buffer.trim()) {
    throw new Error(
      `The review ended after ${toolSteps} tool step(s) without producing a conclusion (${finishReason}). Try again, or turn off Agentic review for a single-pass response.`,
    );
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
