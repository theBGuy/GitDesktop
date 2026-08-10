import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import { createOllama } from "ollama-ai-provider-v2";
import { guardedFetch } from "./guarded-fetch";
import { OLLAMA_CLOUD_HOST } from "./providers";
import type { AiSettings } from "./types";

// All providers go through `guardedFetch` (guarded-fetch.ts) — the Tauri fetch
// (proxied through Rust, exempt from the webview CORS most AI APIs reject) behind
// the host allowlist. `allowedHostsOverride` is the unsaved draft list for
// Settings "Test connection"; omitted elsewhere so the saved list applies.
//
// This module owns the four heavyweight AI-SDK provider packages
// (@ai-sdk/anthropic, @ai-sdk/openai, @openrouter/ai-sdk-provider,
// ollama-ai-provider-v2). It's kept separate from providers.ts — whose light
// constants are imported eagerly across the app — and loaded via dynamic
// import from client.ts so those packages stay off the boot path until an AI
// generation actually runs.
export function createModel(
  settings: AiSettings,
  apiKey: string | null,
  allowedHostsOverride?: readonly string[],
): LanguageModel {
  const fetch = guardedFetch(allowedHostsOverride);
  switch (settings.provider) {
    case "anthropic":
      return createAnthropic({ apiKey: apiKey ?? "", fetch })(settings.model);
    case "openai":
      return createOpenAI({ apiKey: apiKey ?? "", fetch })(settings.model);
    case "google":
      return createOpenAI({
        baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
        apiKey: apiKey ?? "",
        fetch,
      }).chat(settings.model);
    case "openai-compatible":
      // Any OpenAI-compatible endpoint (custom base URL). `.chat()` forces the
      // `/chat/completions` API — third-party endpoints don't implement OpenAI's
      // Responses API that the default `openai(model)` would target.
      return createOpenAI({
        baseURL: settings.openaiCompatibleBaseUrl.replace(/\/$/, ""),
        apiKey: apiKey ?? "",
        fetch,
      }).chat(settings.model);
    case "openrouter":
      return createOpenRouter({ apiKey: apiKey ?? "", fetch })(settings.model);
    case "ollama":
      return createOllama({
        baseURL: `${settings.ollamaBaseUrl.replace(/\/$/, "")}/api`,
        fetch,
      })(settings.model);
    case "ollama-cloud":
      return createOllama({
        baseURL: `${OLLAMA_CLOUD_HOST}/api`,
        headers: { Authorization: `Bearer ${apiKey ?? ""}` },
        fetch,
      })(settings.model);
    case "claude-cli":
    case "codex-cli":
    case "copilot-cli":
    case "opencode-cli":
      // CLI agents run as a subprocess, not through the AI SDK. Callers must
      // route these through the agent-CLI path before reaching createModel.
      throw new Error("CLI providers do not use the AI SDK model path");
  }
}
