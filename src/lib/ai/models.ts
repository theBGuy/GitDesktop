import { useQuery } from "@tanstack/react-query";
import { getSecret } from "@/lib/git/api";
import { guardedFetch } from "./guarded-fetch";
import { providerErrorMessage } from "./provider-error";
import {
  GOOGLE_AI_STUDIO_BASE_URL,
  MODEL_SUGGESTIONS,
  OLLAMA_CLOUD_HOST,
  OPENAI_COMPATIBLE_PRESETS,
} from "./providers";
import type { AiSettings } from "./types";

/** Static fallback model list when the live catalog is unavailable. For the
 *  openai-compatible provider it's the matching preset's own models (not the
 *  generic default), so e.g. picking DeepSeek without a key still suggests
 *  DeepSeek models. A base URL left over from the retired Gemini preset matches
 *  no preset, so it takes the `google` suggestions rather than falling through to
 *  the generic default's aggregator ids, which Google's endpoint rejects. */
function fallbackModels(settings: AiSettings): string[] {
  if (settings.provider === "openai-compatible") {
    const base = settings.openaiCompatibleBaseUrl.replace(/\/$/, "");
    if (base === GOOGLE_AI_STUDIO_BASE_URL) return MODEL_SUGGESTIONS.google;
    const preset = OPENAI_COMPATIBLE_PRESETS.find((p) => p.baseUrl === base);
    if (preset) return preset.models;
  }
  return MODEL_SUGGESTIONS[settings.provider];
}

export interface AvailableModels {
  models: string[];
  /** false when these are static fallback suggestions, not a provider list. */
  live: boolean;
  /** The provider's own explanation, set only for `cause: "failed"` — the other
   *  fallback routes have nothing provider-specific to say. Unbounded provider
   *  prose: clamp it wherever it renders. */
  reason?: string;
  /** Which fallback route produced these suggestions. The four are not
   *  interchangeable to a user: no key saved yet, no base URL configured, the
   *  request failed, or the provider listed nothing. A CLI provider has no live
   *  catalog at all and lands on `empty`, so any consumer branching on `cause`
   *  must handle the CLI case ahead of it. */
  cause?: "no-key" | "no-base" | "failed" | "empty";
}

/** OpenAI's /v1/models mixes in embeddings, audio, images… keep chat models. */
const OPENAI_NON_CHAT =
  /embed|whisper|tts|dall-e|audio|realtime|moderation|image|transcribe|babbage|davinci|codex|search/i;

/** Google's catalog mixes its text families in with media generators and other
 *  non-chat entries (veo, lyria, nano-banana, aqa, antigravity) that share no
 *  vocabulary with {@link OPENAI_NON_CHAT}. Allowlisting the two text families
 *  excludes future media families by default instead of chasing each new name. */
const GOOGLE_CHAT_FAMILY = /^(gemini|gemma)-/;

/** Google's catalog, normalized for the model picker. The prefix strip must run
 *  BEFORE the family test — a `models/`-prefixed id fails `^gemini-` and would
 *  filter the whole catalog away. Also used for a custom base URL aimed at the
 *  same endpoint. */
function googleChatModels(data: { id: string }[]): string[] {
  return data
    .map((m) => m.id.replace(/^models\//, ""))
    .filter((id) => GOOGLE_CHAT_FAMILY.test(id) && !OPENAI_NON_CHAT.test(id))
    .sort();
}

/** Returned instead of a list when a key-requiring provider has no saved key: no
 *  request was made, so the UI must not blame a failed one. A local sentinel rather
 *  than client.ts's MissingApiKeyError — importing that module would pull its eager
 *  `ai` SDK core into every graph this hook renders in. */
const MISSING_KEY = Symbol("missing-key");

/** The twin of {@link MISSING_KEY} for an openai-compatible provider with a key but
 *  no base URL: also a no-request state, but the user has a different thing to fix. */
const MISSING_BASE_URL = Symbol("missing-base-url");

async function fetchProviderModels(
  settings: AiSettings,
  allowedHosts?: readonly string[],
): Promise<string[] | typeof MISSING_KEY | typeof MISSING_BASE_URL> {
  // The live model list hits the same hosts as inference (incl. a custom Ollama /
  // OpenAI-compatible base URL), so it goes through the same host allowlist — the
  // unsaved draft list (`allowedHosts`) when called from Settings, else the saved
  // list. A blocked or unreachable host just falls back to the static suggestions.
  const aiFetch = guardedFetch(allowedHosts);
  const fetchJson = async (url: string, headers?: Record<string, string>) => {
    const res = await aiFetch(url, { headers });
    if (!res.ok) {
      // The body carries the provider's own explanation (Google's rejected-key 400
      // is array-wrapped under `error.message`). `responseBody` is the field the AI
      // SDK sets, so providerErrorMessage reads this throw and a failed inference
      // call alike.
      const body = await res.text().catch(() => "");
      throw Object.assign(new Error(`${url} returned ${res.status}`), {
        responseBody: body,
        status: res.status,
      });
    }
    return res.json();
  };
  switch (settings.provider) {
    case "openai": {
      const key = await getSecret("openai");
      if (!key) return MISSING_KEY;
      const json = await fetchJson("https://api.openai.com/v1/models", {
        Authorization: `Bearer ${key}`,
      });
      return (json.data as { id: string }[])
        .map((m) => m.id)
        .filter((id) => !OPENAI_NON_CHAT.test(id))
        .sort();
    }
    case "anthropic": {
      const key = await getSecret("anthropic");
      if (!key) return MISSING_KEY;
      const json = await fetchJson(
        "https://api.anthropic.com/v1/models?limit=100",
        {
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
      );
      return (json.data as { id: string }[]).map((m) => m.id);
    }
    case "google": {
      const key = await getSecret("google");
      if (!key) return MISSING_KEY;
      const json = await fetchJson(`${GOOGLE_AI_STUDIO_BASE_URL}/models`, {
        Authorization: `Bearer ${key}`,
      });
      return googleChatModels(json.data as { id: string }[]);
    }
    case "openai-compatible": {
      const key = await getSecret("openai-compatible");
      const base = settings.openaiCompatibleBaseUrl.replace(/\/$/, "");
      // Key first: with neither saved, saving a key is the step that comes first.
      if (!key) return MISSING_KEY;
      if (!base) return MISSING_BASE_URL;
      // OpenAI-compatible catalog endpoint on the configured base URL.
      const json = await fetchJson(`${base}/models`, {
        Authorization: `Bearer ${key}`,
      });
      const data = json.data as { id: string }[];
      // A custom base URL can still point at Google's catalog (and saved settings
      // from the retired Gemini preset do), which needs the `google` normalization;
      // other endpoints list only their own models.
      if (base === GOOGLE_AI_STUDIO_BASE_URL) return googleChatModels(data);
      return data.map((m) => m.id).sort();
    }
    case "openrouter": {
      // public endpoint, no key required
      const json = await fetchJson("https://openrouter.ai/api/v1/models");
      return (json.data as { id: string }[]).map((m) => m.id).sort();
    }
    case "ollama": {
      const base = settings.ollamaBaseUrl.replace(/\/$/, "");
      const json = await fetchJson(`${base}/api/tags`);
      return ((json.models ?? []) as { name: string }[])
        .map((m) => m.name)
        .sort();
    }
    case "ollama-cloud": {
      const key = await getSecret("ollama-cloud");
      if (!key) return MISSING_KEY;
      // OpenAI-compatible catalog endpoint on the cloud host.
      const json = await fetchJson(`${OLLAMA_CLOUD_HOST}/v1/models`, {
        Authorization: `Bearer ${key}`,
      });
      return (json.data as { id: string }[]).map((m) => m.id).sort();
    }
    case "claude-cli":
    case "codex-cli":
    case "copilot-cli":
    case "opencode-cli":
      // No live model list; the static MODEL_SUGGESTIONS aliases are used.
      return [];
  }
}

/**
 * Live model list for the current provider, falling back to the static
 * suggestions when there's no key or base URL configured, the request fails, or
 * the provider lists nothing. `opts.enabled` lets a caller defer the provider
 * request until the user shows intent to pick a model.
 */
export function useAvailableModels(
  settings: AiSettings,
  keySaved: boolean,
  allowedHosts?: readonly string[],
  opts?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: [
      "models",
      settings.provider,
      keySaved,
      settings.ollamaBaseUrl,
      settings.openaiCompatibleBaseUrl,
      allowedHosts ?? [],
    ] as const,
    queryFn: async (): Promise<AvailableModels> => {
      try {
        const result = await fetchProviderModels(settings, allowedHosts);
        if (result === MISSING_KEY) {
          return {
            models: fallbackModels(settings),
            live: false,
            cause: "no-key",
          };
        }
        if (result === MISSING_BASE_URL) {
          return {
            models: fallbackModels(settings),
            live: false,
            cause: "no-base",
          };
        }
        if (result.length > 0) {
          return { models: result, live: true };
        }
        return {
          models: fallbackModels(settings),
          live: false,
          cause: "empty",
        };
      } catch (e) {
        return {
          models: fallbackModels(settings),
          live: false,
          reason: providerErrorMessage(e),
          cause: "failed",
        };
      }
    },
    enabled: opts?.enabled ?? true,
    staleTime: 5 * 60 * 1000,
  });
}
