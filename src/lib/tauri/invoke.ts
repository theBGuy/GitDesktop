import { getTransport } from "@/lib/transport";

export interface AppError {
  kind:
    | "git"
    | "notARepo"
    | "gitNotFound"
    | "ghNotFound"
    | "gh"
    | "issuesDisabled"
    | "glabNotFound"
    | "glab"
    | "bitbucketNotConfigured"
    | "bitbucket"
    | "jira"
    | "keyring"
    | "invalidArgument"
    | "command"
    | "io"
    | "timeout";
  message: string;
  code?: number;
  stderr?: string;
}

export function isAppError(e: unknown): e is AppError {
  return (
    typeof e === "object" &&
    e !== null &&
    "kind" in e &&
    "message" in e &&
    typeof (e as AppError).message === "string"
  );
}

export function errorMessage(e: unknown): string {
  if (isAppError(e)) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Typed wrapper around the installed transport's invoke that normalizes
 *  thrown errors to AppError. */
export async function invoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  // Outside the try: a missing installer surfaces as its own raw Error
  // instead of being reclassified as an `io` AppError below.
  const transport = getTransport();
  try {
    return await transport.invoke<T>(cmd, args);
  } catch (e) {
    if (isAppError(e)) throw e;
    throw {
      kind: "io",
      message: typeof e === "string" ? e : errorMessage(e),
    } satisfies AppError;
  }
}
