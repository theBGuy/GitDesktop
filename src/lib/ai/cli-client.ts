import { errorMessage } from "@/lib/tauri/invoke";
import {
  cancelAgentReview,
  detectAgentCli,
  providerKind,
  type ReviewEvent,
  runAgentReview,
} from "./agent";
import { PROVIDER_LABELS } from "./providers";
import { terminalErrorMessage } from "./terminal-error";
import type { AiClient, AiSettings, AiStreamRequest } from "./types";

/** The `<CLI> login` command each agent uses to authenticate — mirrors the
 *  mapping AiProviderSection renders in its "not signed in" hint. */
const LOGIN_COMMAND = {
  claude: "claude login",
  codex: "codex login",
  copilot: "copilot login",
  opencode: "opencode auth login",
} as const;

/**
 * Builds an {@link AiClient} backed by a locally-installed agent CLI
 * (claude/codex/copilot/opencode), adapting the Tier-1 (non-repo-aware, zero-tools)
 * agent-review machinery to the streaming `AiClient` contract so every generation surface
 * (commit message, PR body, branch name, …) runs through a CLI with no per-surface changes.
 * Tier-1 discipline is what keeps the result free of CLI preamble/noise: an empty tool
 * allowlist + `--strict-mcp-config` for Claude, `exec --json` read-only for Codex, output
 * parsed from stream-json rather than raw stdout.
 */
export function createCliClient(settings: AiSettings): AiClient {
  return {
    async *stream(req: AiStreamRequest) {
      const kind = providerKind(settings.provider);
      // Defensive: createAiClient only routes CLI ids here, so this is unreachable.
      if (!kind) {
        throw new Error(`Unsupported CLI provider: ${settings.provider}`);
      }
      if (!req.repoPath?.trim()) {
        throw new Error(
          `${PROVIDER_LABELS[settings.provider]} runs as a local CLI and needs an open repository.`,
        );
      }
      // Cancelled before spawn — no subprocess. Thrown (not returned) for parity
      // with the HTTP path, where `streamText` rejects with AbortError: consumers
      // treat a cancelled run as "no result" (null), never a partial buffer.
      if (req.abortSignal?.aborted) {
        throw new DOMException("The generation was cancelled.", "AbortError");
      }

      const reviewId = crypto.randomUUID();
      // Cancel is two-layer: (1) stop the yielded stream at once — `aborted` is checked
      // atop the pump loop before any further chunk (delta OR the done tail) is yielded, and
      // `wake()` resumes a pump blocked on the await; (2) kill the subprocess via
      // `cancelAgentReview`. The kill alone isn't enough: queued/incoming deltas keep flowing
      // until the backend notices, so the draft fields would keep updating after Cancel.
      let aborted = false;
      const abort = () => {
        aborted = true;
        cancelAgentReview(reviewId).catch(() => undefined);
        wake?.();
      };
      req.abortSignal?.addEventListener("abort", abort);

      // Async queue bridging the `onEvent` callback (push side) to the generator's
      // pulls: events land in `queue`, and a waiting consumer is resumed via `wake`.
      const queue: ReviewEvent[] = [];
      let wake: (() => void) | null = null;
      const push = (event: ReviewEvent) => {
        queue.push(event);
        wake?.();
      };

      // The backend promise. It resolves either after a terminal event (done/error)
      // OR without one on the cancel path (subprocess killed) — mirroring
      // runCliStream. `settled` tracks whether a terminal event was seen so the
      // generator's finally knows if it still needs to cancel.
      let settled = false;
      let backendDone = false;
      let backendError: unknown = null;
      void runAgentReview({
        kind,
        binPath: settings.cliPath?.trim() || null,
        model: settings.model,
        effort: "",
        systemPrompt: req.system,
        userPrompt: req.prompt,
        repoPath: req.repoPath,
        repoAware: false,
        mcpSelf: false,
        reviewId,
        onEvent: push,
      })
        .catch((e) => {
          backendError = e;
        })
        .finally(() => {
          backendDone = true;
          wake?.();
        });

      let emitted = 0;
      try {
        while (true) {
          // Stop the moment Cancel fires — before draining the queue — so no further chunk
          // is yielded (also covers the signal aborting between events). The finally still
          // kills the subprocess if it's unsettled. Thrown, not returned, for the HTTP-path
          // parity noted at the pre-spawn check above.
          if (aborted || req.abortSignal?.aborted) {
            throw new DOMException(
              "The generation was cancelled.",
              "AbortError",
            );
          }
          if (queue.length === 0) {
            // Nothing buffered: if the backend already returned without a terminal
            // event, this is the cancel path — end iteration cleanly (no throw). A
            // rejected invoke promise is re-thrown below.
            if (backendDone) {
              if (backendError && !settled) {
                throw new Error(errorMessage(backendError));
              }
              return;
            }
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            wake = null;
            continue;
          }
          const event = queue.shift() as ReviewEvent;
          if (event.kind === "delta") {
            emitted += event.text.length;
            yield event.text;
          } else if (event.kind === "done") {
            settled = true;
            // An errored run throws BEFORE the tail is yielded, matching the
            // `error`-kind branch — a failed run never paints its final text
            // into the caller's draft field.
            if (event.isError)
              throw new Error(terminalErrorMessage(event.text));
            // The terminal event carries the authoritative full text. A coalescing
            // CLI (Codex emits NO deltas — only this final text) has emitted nothing
            // yet, so yield the untold tail; streaming CLIs already emitted it all.
            if (event.text.length > emitted) {
              yield event.text.slice(emitted);
            }
            return;
          } else if (event.kind === "error") {
            settled = true;
            throw new Error(event.message);
          }
          // status / tool / nativeSession are ignored: Tier-1 runs no tools and
          // the AiClient contract has no status channel (the generate button's own
          // spinner covers the startup gap).
        }
      } finally {
        req.abortSignal?.removeEventListener("abort", abort);
        // A consumer that breaks out of the for-await early (or an unsettled run
        // still pending) must not leak the subprocess.
        if (!settled && !backendDone) abort();
      }
    },
    async testConnection() {
      // Detect-only — never a generation round-trip, which would burn a premium
      // CLI request just to check the connection.
      try {
        const kind = providerKind(settings.provider);
        if (!kind) {
          return {
            ok: false,
            message: `Unsupported CLI provider: ${settings.provider}`,
          } as const;
        }
        const label = PROVIDER_LABELS[settings.provider];
        const info = await detectAgentCli(kind, settings.cliPath);
        if (!info.found) {
          return {
            ok: false,
            message: `${label} CLI not found — install it or set its path in Settings.`,
          } as const;
        }
        if (info.authed === "notAuthed") {
          return {
            ok: false,
            message: `${label} found but not signed in — run \`${LOGIN_COMMAND[kind]}\`.`,
          } as const;
        }
        return { ok: true } as const;
      } catch (e) {
        return { ok: false, message: errorMessage(e) } as const;
      }
    },
  };
}
