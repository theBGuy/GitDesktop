import { errorMessage } from "@/lib/tauri/invoke";
import {
  cancelAgentReview,
  detectAgentCli,
  providerKind,
  type ReviewEvent,
  runAgentReview,
} from "./agent";
import { PROVIDER_LABELS } from "./providers";
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
 * (claude/codex/copilot/opencode). Adapts the Tier-1 (non-repo-aware, zero-tools)
 * agent-review machinery — the same one the PR-review path drives via
 * `runAgentReview` — to the streaming `AiClient` contract, so every generation
 * surface (commit message, PR body, branch name, …) can run through a CLI with no
 * per-surface changes. Structural cleanliness (no CLI preamble/noise in the
 * result) is guaranteed by the Tier-1 discipline: an empty tool allowlist +
 * `--strict-mcp-config` for Claude, `exec --json` read-only for Codex, output
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
      // Cancel is two-layer: (1) instantly stop the yielded stream so the UI stops
      // painting the moment the user clicks Cancel — the `aborted` flag is checked
      // atop the pump loop before any further chunk (delta OR the done tail) is
      // yielded, and `wake()` resumes a pump blocked on the await; (2) kill the
      // subprocess via `cancelAgentReview` to free the resource. Requesting only
      // the subprocess kill isn't enough: queued/incoming deltas would keep
      // flowing until the backend noticed, so the draft fields kept updating after
      // Cancel (unlike the HTTP path, where `streamText` honors the signal at once).
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
          // Stop the moment Cancel fires — before draining the queue — so no
          // further chunk is yielded (also covers the signal aborting between
          // events). The finally still kills the subprocess if it's unsettled.
          // Thrown AbortError (not a clean return) for HTTP-path parity: callers'
          // catches are gated on `abortSignal.aborted` and resolve null, so a
          // cancelled run never hands a partial buffer to the result parsers.
          if (aborted || req.abortSignal?.aborted) {
            throw new DOMException("The generation was cancelled.", "AbortError");
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
            if (event.isError) throw new Error("The run ended with an error.");
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
