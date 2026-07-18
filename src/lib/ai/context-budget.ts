import { guardedFetch } from "./guarded-fetch";
import type { AiSettings } from "./types";

/** How much diff + prior-discussion context an AI review sends, scaled to the
 *  reviewing model's context window. `"auto"` probes the window (live for
 *  Ollama, a per-provider fallback tier otherwise); the others force a fixed
 *  multiplier of the default budget profile. */
export type ReviewContextSize = "auto" | "small" | "medium" | "large";

/** The set of character caps that shape a review prompt. Each field is scaled
 *  from {@link DEFAULT_BUDGET_PROFILE} by a per-model multiplier at review time;
 *  the defaults are the fixed constants the generation path still uses. */
export interface ContextBudgetProfile {
  /** Overall soft ceiling for diff + delta + prior/own/external combined. */
  promptCharBudget: number;
  /** Budget for the authoritative staged/PR diff. */
  diffCharBudget: number;
  /** Cap applied to each individual file section once over budget. */
  perFileCap: number;
  /** Cap for the "changes since last review" delta. */
  deltaCharBudget: number;
  /** Cap for the prior review's findings. */
  priorCharBudget: number;
  /** Cap for GitDesktop's own prior comments on the PR. */
  ownCharBudget: number;
  /** Cap for third-party AI-reviewer findings. */
  externalCharBudget: number;
}

/** The baseline profile — EXACTLY today's fixed constants (see truncate.ts).
 *  A 1× (`scaledProfile(1)`) profile is byte-identical to this. */
export const DEFAULT_BUDGET_PROFILE: ContextBudgetProfile = {
  promptCharBudget: 100_000,
  diffCharBudget: 80_000,
  perFileCap: 6_000,
  deltaCharBudget: 24_000,
  priorCharBudget: 8_000,
  ownCharBudget: 6_000,
  externalCharBudget: 8_000,
};

/** Scales every field of the default profile by `multiplier`, rounding each to
 *  an integer with a 1_000-char floor so a tiny multiplier never zeroes a cap. */
export function scaledProfile(multiplier: number): ContextBudgetProfile {
  const scale = (base: number) =>
    Math.max(1_000, Math.round(base * multiplier));
  return {
    promptCharBudget: scale(DEFAULT_BUDGET_PROFILE.promptCharBudget),
    diffCharBudget: scale(DEFAULT_BUDGET_PROFILE.diffCharBudget),
    perFileCap: scale(DEFAULT_BUDGET_PROFILE.perFileCap),
    deltaCharBudget: scale(DEFAULT_BUDGET_PROFILE.deltaCharBudget),
    priorCharBudget: scale(DEFAULT_BUDGET_PROFILE.priorCharBudget),
    ownCharBudget: scale(DEFAULT_BUDGET_PROFILE.ownCharBudget),
    externalCharBudget: scale(DEFAULT_BUDGET_PROFILE.externalCharBudget),
  };
}

/** Auto-mode multiplier from a known context window (in TOKENS). Frontier
 *  windows scale up (3× ≈ 300K chars ≈ 75-90K tokens — a deliberate cost
 *  ceiling), while a small local model scales DOWN so today's constants can't
 *  overflow it. */
function multiplierForWindow(windowTokens: number): number {
  if (windowTokens >= 180_000) return 3;
  if (windowTokens >= 60_000) return 1.5;
  if (windowTokens >= 24_000) return 1;
  return Math.max(0.25, windowTokens / 24_000);
}

/** Session cache of resolved profiles, keyed by provider#model#baseUrl. This is
 *  async plumbing (never render-path state), so a plain module-level Map is fine
 *  — it just avoids re-probing Ollama once per review. */
const profileCache = new Map<string, ContextBudgetProfile>();

/** Probes a local Ollama model's context window (in tokens) via `/api/show`,
 *  mirroring the fetch idiom in models.ts (guardedFetch → res.json()) but as a
 *  POST with a JSON body. The window is the `model_info` entry whose key ends
 *  with ".context_length" (architecture-prefixed, e.g. "llama.context_length").
 *  Returns null on any failure or when the key is absent — the caller then falls
 *  back to a conservative profile.
 *
 *  Bounded to 5s via `AbortSignal.timeout`: neither guardedFetch nor the Tauri
 *  HTTP plugin imposes a timeout, so an unreachable/asleep LAN Ollama host would
 *  otherwise hang the first review of a session for the full OS TCP timeout. The
 *  timeout aborts the fetch, which throws → the conservative 1× fallback. */
async function probeOllamaWindow(ai: AiSettings): Promise<number | null> {
  const base = ai.ollamaBaseUrl.replace(/\/$/, "");
  const aiFetch = guardedFetch();
  const res = await aiFetch(`${base}/api/show`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: ai.model }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as {
    model_info?: Record<string, unknown>;
  };
  const info = json.model_info;
  if (!info || typeof info !== "object") return null;
  for (const [key, value] of Object.entries(info)) {
    if (key.endsWith(".context_length") && typeof value === "number") {
      return value;
    }
  }
  return null;
}

/**
 * Resolves the context-budget profile for a review, given the review AI config
 * and the user's `reviewContextSize` knob. Manual sizes force a fixed multiple
 * of the default profile; `"auto"`/undefined scales to the model actually
 * reviewing — live for Ollama (probe its window), a conservative per-provider
 * fallback tier for everything else (never assumes a Claude table).
 *
 * Best-effort by contract: it never throws and never blocks a review — any probe
 * failure falls back to a conservative profile. Resolved profiles are cached
 * per provider#model#baseUrl for the session.
 */
export async function resolveBudgetProfile(
  ai: AiSettings,
  size: ReviewContextSize | undefined,
): Promise<ContextBudgetProfile> {
  if (size === "small") return scaledProfile(0.5);
  if (size === "medium") return scaledProfile(1);
  if (size === "large") return scaledProfile(4);

  // "auto" / undefined — resolve dynamically per provider+model.
  const baseUrl =
    ai.provider === "ollama"
      ? ai.ollamaBaseUrl
      : ai.provider === "openai-compatible"
        ? ai.openaiCompatibleBaseUrl
        : "";
  const cacheKey = `${ai.provider}#${ai.model}#${baseUrl}`;
  const cached = profileCache.get(cacheKey);
  if (cached) return cached;

  const profile = await resolveAutoProfile(ai);
  profileCache.set(cacheKey, profile);
  return profile;
}

/** The `"auto"` resolution, per provider. Wrapped so any probe failure falls
 *  back to a conservative 1× profile rather than throwing. */
async function resolveAutoProfile(
  ai: AiSettings,
): Promise<ContextBudgetProfile> {
  switch (ai.provider) {
    case "ollama": {
      try {
        const windowTokens = await probeOllamaWindow(ai);
        if (windowTokens && windowTokens > 0) {
          return scaledProfile(multiplierForWindow(windowTokens));
        }
      } catch {
        // Probe failure — fall through to the conservative default.
      }
      return scaledProfile(1);
    }
    case "anthropic":
    case "openai":
    case "openrouter":
    case "ollama-cloud":
    case "claude-cli":
    case "codex-cli":
    case "copilot-cli":
    case "opencode-cli":
      // Hosted/CLI frontier models all have ≥200K-token windows; 3× ≈ 300K
      // chars ≈ 75-90K tokens, a deliberate cost ceiling well inside the
      // smallest such window. FUTURE: a live Anthropic Models API
      // `max_input_tokens` probe would refine this per-model — recorded, not v1.
      return scaledProfile(3);
    case "openai-compatible":
      // Could be a local llama.cpp server behind an OpenAI-compatible endpoint;
      // no reliable window probe, so stay conservative.
      return scaledProfile(1);
  }
}
