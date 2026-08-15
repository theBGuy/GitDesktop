import { errorMessage } from "@/lib/tauri/invoke";

/** The human-readable reason out of a provider error payload, whether it nests under
 *  `error` as an object (OpenAI, Google), sits bare on `message`, is a plain string
 *  under `error` (Ollama's native `/api`), or IS the whole payload — a bare JSON
 *  string is valid JSON — array-wrapped (Google) or not. One reader for both call
 *  sites below: the parsed response body and the raw in-stream payload carry the
 *  same shapes, so they must accept the same set. */
function errorTextOf(value: unknown): string | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  // A runtime string has to be caught before the property reads: the assertion
  // below is compile-time only, so a bare string would fall through them as null.
  if (typeof candidate === "string") return candidate.trim() ? candidate : null;
  const entry = candidate as {
    error?: { message?: unknown } | string;
    message?: unknown;
  } | null;
  const nested = entry?.error;
  const message =
    typeof nested === "string" ? nested : (nested?.message ?? entry?.message);
  return typeof message === "string" && message.trim() ? message : null;
}

/**
 * The provider's own explanation for a failed call, falling back to the generic
 * message. Three constraints shape it: a body the SDK's error schema can't parse
 * leaves `APICallError.message` as the bare HTTP reason phrase with the cause unread
 * in `responseBody` (Google's is array-wrapped, so a rejected key reads "Bad Request"
 * rather than "Invalid Auth key."); a retry moves that body onto `RetryError.lastError`,
 * and `isRetryable` covers 429/5xx — the quota case; and an in-stream error part is the
 * provider's already-parsed payload rather than an Error.
 *
 * Lives outside `client.ts` so the model-catalog fetch can reuse it without pulling
 * that module's eager `ai` SDK core into the Settings graph.
 */
export function providerErrorMessage(e: unknown): string {
  const unwrapped = ((e as { lastError?: unknown } | null)?.lastError ?? e) as {
    responseBody?: unknown;
  } | null;
  const body = unwrapped?.responseBody;
  if (typeof body === "string" && body.trim()) {
    try {
      const fromBody = errorTextOf(JSON.parse(body));
      if (fromBody) return fromBody;
    } catch {
      // Not JSON — the generic message is the best we have.
    }
  }
  // An Error's own `message` is what the generic fallback already returns; only a raw
  // payload object needs reading here.
  if (!(unwrapped instanceof Error)) {
    const fromPayload = errorTextOf(unwrapped);
    if (fromPayload) return fromPayload;
  }
  // Nothing installed emits a payload errorTextOf can't read; the dump is dev-only so
  // a future provider's shape is debuggable without raw JSON reaching a user-facing
  // banner. The literal `import.meta.env.DEV` leads the `&&` — that's what lets Vite
  // statically drop the branch from the production bundle.
  if (import.meta.env.DEV && unwrapped && !(unwrapped instanceof Error)) {
    try {
      return JSON.stringify(unwrapped).slice(0, 200);
    } catch {
      // cyclic
    }
  }
  // Deliberately the wrapper, not `unwrapped`: a retry's message embeds the last
  // error's text and adds the attempt count, which is worth keeping.
  return errorMessage(e);
}
