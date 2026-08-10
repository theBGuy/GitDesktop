import { useQuery } from "@tanstack/react-query";
import { getSecret } from "@/lib/git/api";
import { guardedFetch } from "./guarded-fetch";
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
 *  DeepSeek models. */
function fallbackModels(settings: AiSettings): string[] {
  if (settings.provider === "openai-compatible") {
    const base = settings.openaiCompatibleBaseUrl.replace(/\/$/, "");
    const preset = OPENAI_COMPATIBLE_PRESETS.find((p) => p.baseUrl === base);
    if (preset) return preset.models;
  }
  return MODEL_SUGGESTIONS[settings.provider];
}

export interface AvailableModels {
  models: string[];
  /** false when these are static fallback suggestions, not a provider list. */
  live: boolean;
}

/** OpenAI's /v1/models mixes in embeddings, audio, images… keep chat models. */
const OPENAI_NON_CHAT =
  /embed|whisper|tts|dall-e|audio|realtime|moderation|image|transcribe|babbage|davinci|codex|search/i;

/** Google's catalog mixes its text families in with media generators and other
 *  non-chat entries (veo, lyria, nano-banana, aqa, antigravity) that share no
 *  vocabulary with {@link OPENAI_NON_CHAT}. Allowlisting the two text families
 *  excludes future media families by default instead of chasing each new name. */
const GOOGLE_CHAT_FAMILY = /^(gemini|gemma)-/;

async function fetchProviderModels(
  settings: AiSettings,
  allowedHosts?: readonly string[],
): Promise<string[]> {
  // The live model list hits the same hosts as inference (incl. a custom Ollama /
  // OpenAI-compatible base URL), so it goes through the same host allowlist — the
  // unsaved draft list (`allowedHosts`) when called from Settings, else the saved
  // list. A blocked or unreachable host just falls back to the static suggestions.
  const aiFetch = guardedFetch(allowedHosts);
  const fetchJson = async (url: string, headers?: Record<string, string>) => {
    const res = await aiFetch(url, { headers });
    if (!res.ok) {
      throw new Error(`${url} returned ${res.status}`);
    }
    return res.json();
  };
  switch (settings.provider) {
    case "openai": {
      const key = await getSecret("openai");
      if (!key) return [];
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
      if (!key) return [];
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
      if (!key) return [];
      const json = await fetchJson(`${GOOGLE_AI_STUDIO_BASE_URL}/models`, {
        Authorization: `Bearer ${key}`,
      });
      // Catalog ids can carry a `models/` prefix the inference call won't accept;
      // stripping it is a no-op when they don't.
      return (json.data as { id: string }[])
        .map((m) => m.id.replace(/^models\//, ""))
        .filter(
          (id) => GOOGLE_CHAT_FAMILY.test(id) && !OPENAI_NON_CHAT.test(id),
        )
        .sort();
    }
    case "openai-compatible": {
      const key = await getSecret("openai-compatible");
      const base = settings.openaiCompatibleBaseUrl.replace(/\/$/, "");
      if (!key || !base) return [];
      // OpenAI-compatible catalog endpoint on the configured base URL.
      const json = await fetchJson(`${base}/models`, {
        Authorization: `Bearer ${key}`,
      });
      return (json.data as { id: string }[]).map((m) => m.id).sort();
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
      if (!key) return [];
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
 * suggestions when there's no key or the request fails. `opts.enabled` lets a
 * caller defer the provider request until the user shows intent to pick a model.
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
        const models = await fetchProviderModels(settings, allowedHosts);
        if (models.length > 0) {
          return { models, live: true };
        }
      } catch {
        // fall through to suggestions
      }
      return { models: fallbackModels(settings), live: false };
    },
    enabled: opts?.enabled ?? true,
    staleTime: 5 * 60 * 1000,
  });
}
