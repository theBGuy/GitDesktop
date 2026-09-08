import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
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

/** Where a run that settles while its dialog is closed should surface. */
export interface FinishAndSurfaceOpts {
  /** toast.success title, e.g. "Pull request description ready". */
  readyTitle: string;
  /** Toast description, e.g. "It's waiting in the dialog." */
  readyDescription?: string;
  /** Reopens the surface (the toast's "View" action). Omit when no reliable
   *  reopen path exists from a toast. */
  reopen?: () => void;
}

/**
 * Closing a generator dialog never cancels its run — this decides where the
 * result lands instead. A run settling while the dialog is CLOSED latches
 * skip-seed (the reopen keeps the whole draft rather than resetting it) and, on
 * success, toasts with a "View" reopen; one settling while the dialog is OPEN is
 * already visible in place, so it latches nothing.
 *
 * The latch is a ref, so it survives an `<Activity>` tab hide (which tears down
 * effects but keeps refs) and dies with a true unmount, where nothing is left to
 * skip. The toast alone gates on effects being live, since after an unmount
 * there is no draft to promise — the accepted cost being that a run settling
 * while its host tab is hidden resurfaces silently on reopen instead of
 * toasting.
 */
export function useFinishAndSurface(
  open: boolean,
  opts: FinishAndSurfaceOpts,
): {
  /** Report a run settling; ok = a non-null result landed. */
  noteRunSettled: (ok: boolean) => void;
  /** Consume the settled-while-closed latch; true ⇒ the caller's seedOnOpen
   *  must return without reseeding. */
  consumeSkipSeed: () => boolean;
} {
  // Effects, never render-time ref writes: React may discard and replay a
  // render, and both flags are read from stream continuations outside render.
  // The open sync is a LAYOUT effect: a settle landing between the commit and a
  // passive flush would otherwise read the previous open state and either miss
  // the latch or toast over a dialog that is back on screen.
  const openRef = useRef(open);
  useLayoutEffect(() => {
    openRef.current = open;
  }, [open]);
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const skipSeedRef = useRef(false);

  return {
    noteRunSettled: (ok: boolean) => {
      if (openRef.current) return;
      skipSeedRef.current = true;
      if (!ok || !mountedRef.current) return;
      toast.success(opts.readyTitle, {
        description: opts.readyDescription,
        duration: 10_000,
        action: opts.reopen
          ? { label: "View", onClick: opts.reopen }
          : undefined,
      });
    },
    consumeSkipSeed: () => {
      const skip = skipSeedRef.current;
      skipSeedRef.current = false;
      return skip;
    },
  };
}
