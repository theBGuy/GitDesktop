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

/** Auto-mode multiplier from a known context window (in TOKENS). Derived as
 *  headroom, not a tier ladder, so the prompt body can't overflow the model:
 *  code-heavy prompts run ~3.5 chars/token and only ~55% of the window is
 *  budgeted for the body (system prompt + response take the rest) ⇒ safe
 *  prompt-chars ≈ windowTokens × 1.9, over the 1× profile's 100K budget. The
 *  0.15 floor keeps every section usable; the cap of 3 is the cost ceiling. */
function multiplierForWindow(windowTokens: number): number {
  return Math.min(3, Math.max(0.15, (windowTokens * 1.9) / 100_000));
}

/** Session cache of resolved profiles, keyed by provider#model#baseUrl. This is
 *  async plumbing (never render-path state), so a plain module-level Map is fine
 *  — it just avoids re-probing Ollama once per review. */
const profileCache = new Map<string, ContextBudgetProfile>();

/** Session cache of raw probed window tokens (or null when a probe failed),
 *  keyed `${ollamaBaseUrl}#${model}`. Separate from {@link profileCache} so the
 *  budget-profile resolver and the AI client (which sizes each request's
 *  `num_ctx`) share one `/api/show` round-trip per model per session. Caches the
 *  null result too, so an unreachable host is probed at most once. */
const ollamaWindowCache = new Map<string, number | null>();

/** Probes a local Ollama model's context window (in tokens) via `/api/show`: the
 *  window is the `model_info` entry whose key ends with ".context_length"
 *  (architecture-prefixed, e.g. "llama.context_length"). Never throws by contract
 *  — any fetch/parse failure or a missing key resolves to null, and the caller
 *  then falls back to a conservative profile / omits `num_ctx`. Nulls cache per
 *  `${ollamaBaseUrl}#${model}` too, so an unreachable host is probed once a session.
 *  Bounded to 5s via `AbortSignal.timeout`: neither guardedFetch nor the Tauri
 *  HTTP plugin imposes a timeout, so an asleep LAN host would otherwise hang the
 *  session's first review for the full OS TCP timeout. */
export async function probeOllamaWindowTokens(
  ai: AiSettings,
): Promise<number | null> {
  const base = ai.ollamaBaseUrl.replace(/\/$/, "");
  const cacheKey = `${base}#${ai.model}`;
  const cached = ollamaWindowCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const tokens = await probeOllamaWindowUncached(base, ai.model);
  ollamaWindowCache.set(cacheKey, tokens);
  return tokens;
}

/** The uncached probe. Wrapped so {@link probeOllamaWindowTokens} can honour its
 *  never-throw contract while still caching a failed probe as null. */
async function probeOllamaWindowUncached(
  base: string,
  model: string,
): Promise<number | null> {
  try {
    const aiFetch = guardedFetch();
    const res = await aiFetch(`${base}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
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
  } catch {
    return null;
  }
}

/**
 * Resolves the context-budget profile for a review. Manual sizes force a fixed
 * multiple of the default profile; `"auto"`/undefined scales to the model actually
 * reviewing — live for Ollama (probe its window), a conservative per-provider
 * fallback tier otherwise (never assumes a Claude table). Best-effort by contract:
 * never throws, never blocks a review. Cached per provider#model#baseUrl.
 */
export async function resolveBudgetProfile(
  ai: AiSettings,
  size: ReviewContextSize | undefined,
): Promise<ContextBudgetProfile> {
  if (size === "small") return scaledProfile(0.5);
  if (size === "medium") return scaledProfile(1);
  if (size === "large") return scaledProfile(4);

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
      const windowTokens = await probeOllamaWindowTokens(ai);
      if (windowTokens && windowTokens > 0) {
        return scaledProfile(multiplierForWindow(windowTokens));
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
      // Hosted/CLI frontier models all have ≥200K-token windows; 3× ≈ 300K chars
      // ≈ 75-90K tokens — a deliberate cost ceiling well inside the smallest of them.
      return scaledProfile(3);
    case "openai-compatible":
      // Could be a local llama.cpp server behind an OpenAI-compatible endpoint;
      // no reliable window probe, so stay conservative.
      return scaledProfile(1);
    default:
      // Runtime hardening for unvalidated persisted settings — TS exhaustiveness
      // is compile-time only, and a hand-edited/corrupt provider string on disk
      // would otherwise fall through and return undefined.
      return scaledProfile(1);
  }
}
