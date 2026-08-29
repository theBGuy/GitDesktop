import { getTransport } from "@/lib/transport";

/** The kinds whose wire shape is kind + message alone (Rust `AppError`
 *  serializes a payload only for the three members below). */
type PlainErrorKind =
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

/** Mirrors Rust's `AppError` — a union on `kind`, so a payload is only in reach
 *  once the kind that carries it has been narrowed. */
export type AppError =
  | { kind: "git"; message: string; code?: number; stderr?: string }
  /** A git operation stopped on conflicts and left the repo mid-op: `op` names
   *  what the user now has to finish, `paths` the conflicted files, `report`
   *  git's own output across both streams. */
  | {
      kind: "conflict";
      message: string;
      op: string;
      paths: string[];
      report: string;
    }
  /** A rebase pull refused because replaying would rewrite local commits away.
   *  Only `message` is declared here: the seven-key decision payload is read
   *  exclusively through `isPullWouldDrop`, which narrows to `PullWouldDrop`
   *  (lib/git/api.ts) — declaring it twice would let the two shapes drift. */
  | { kind: "pullRebaseWouldDrop"; message: string }
  | { kind: PlainErrorKind; message: string };

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
