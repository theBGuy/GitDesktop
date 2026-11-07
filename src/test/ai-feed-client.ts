import type { AiClient } from "@/lib/ai/types";

/** A stream a test drives by hand: `push` yields a chunk, `end` finishes it. */
export type Feed = { push: (chunk: string) => void; end: () => void };

/**
 * An AI client whose streams wait on their test: each stream reports its abort
 * signal and its feed, never yields on its own, and rejects as soon as its
 * signal aborts (like a provider request cancelled mid-flight).
 */
export function feedingClient(
  onSignal: (signal: AbortSignal) => void,
  onFeed: (feed: Feed) => void,
): AiClient {
  return {
    stream: (req) =>
      (async function* () {
        const signal = req.abortSignal;
        if (signal) onSignal(signal);
        const queue: (string | null)[] = [];
        let wake: (() => void) | null = null;
        const enqueue = (item: string | null) => {
          queue.push(item);
          wake?.();
        };
        onFeed({ push: enqueue, end: () => enqueue(null) });
        const aborted = () => new DOMException("Aborted", "AbortError");
        for (;;) {
          // An abort that already happened fires no event for the wait below.
          if (signal?.aborted) throw aborted();
          if (queue.length === 0) {
            await new Promise<void>((r) => {
              wake = r;
              signal?.addEventListener("abort", () => r(), { once: true });
            });
          }
          if (signal?.aborted) throw aborted();
          const next = queue.shift();
          if (next === null) return;
          if (next !== undefined) yield next;
        }
      })(),
    testConnection: async () => ({ ok: true }),
  };
}
