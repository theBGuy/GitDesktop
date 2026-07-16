import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { createAiClient, MissingApiKeyError } from "@/lib/ai/client";
import { loadSettings } from "@/lib/settings/api";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";

type Settings = Awaited<ReturnType<typeof loadSettings>>;

export interface AiStreamRequest {
  system: string;
  prompt: string;
}

/**
 * The streaming-AI scaffold shared by the PR-description and issue-draft
 * generators (and reusable by other one-shot generators): owns the
 * AbortController, the `generating` flag, settings load, client creation, the
 * for-await accumulation loop, and the MissingApiKeyError / error toasts.
 *
 * `buildRequest` does its own context fetch + prompt build and may return null
 * to bail silently (after toasting itself). `onChunk` fires with the cumulative
 * buffer per delta for live previews. `run` resolves with the final buffer, or
 * null if it bailed / aborted / errored, so the caller can parse the result.
 *
 * The one-shot generator path (`createAiClient`): HTTP providers stream over the
 * AI SDK, CLI providers stream from an agent-CLI subprocess through
 * `createAiClient`'s CLI branch — `repoPath` is forwarded to `client.stream` for
 * those (ignored by HTTP). Still intentionally separate from lib/ai/stream.ts's
 * `useAiTextStream` (the review path). CLI providers never throw
 * MissingApiKeyError — they're not in PROVIDERS_REQUIRING_KEY.
 */
export function useAiStream(repoPath: string) {
  const [generating, setGenerating] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  const run = useCallback(
    async (
      buildRequest: (settings: Settings) => Promise<AiStreamRequest | null>,
      opts?: { onChunk?: (buffer: string) => void },
    ): Promise<string | null> => {
      const abort = new AbortController();
      abortRef.current = abort;
      setGenerating(true);
      try {
        const settings = await loadSettings();
        const request = await buildRequest(settings);
        if (!request) return null;
        const client = await createAiClient(settings.ai);
        let buffer = "";
        for await (const chunk of client.stream({
          system: request.system,
          prompt: request.prompt,
          abortSignal: abort.signal,
          repoPath,
        })) {
          buffer += chunk;
          opts?.onChunk?.(buffer);
        }
        return buffer;
      } catch (e) {
        if (!abort.signal.aborted) {
          if (e instanceof MissingApiKeyError) {
            toast.error(e.message, {
              duration: 8000,
              action: {
                label: "Open settings",
                onClick: () => useUiStore.getState().openSettings("ai"),
              },
            });
          } else {
            toastError(e);
          }
        }
        return null;
      } finally {
        setGenerating(false);
        abortRef.current = null;
      }
    },
    [repoPath],
  );

  return { generating, cancel, run };
}
