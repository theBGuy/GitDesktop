import { invoke as tauriInvoke } from "@tauri-apps/api/core";

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

/** Typed wrapper around Tauri invoke that normalizes thrown errors to AppError. */
export async function invoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return await tauriInvoke<T>(cmd, args);
  } catch (e) {
    if (isAppError(e)) throw e;
    throw {
      kind: "io",
      message: typeof e === "string" ? e : errorMessage(e),
    } satisfies AppError;
  }
}
