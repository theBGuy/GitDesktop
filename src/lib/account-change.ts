/**
 * The account-change reset: forge query caches carry no account axis, so when a
 * forge-status read reports a different signed-in login on a host, every cached
 * forge read is reset before it can repaint the previous account's view
 * (viewer-relative fields, my-work, boards' permissions).
 *
 * Import-free at runtime on purpose (types only, erased): query-client.ts wires it
 * at construction, and `scripts/account-change.test.mjs` loads it straight from
 * `src/` under Node's type stripping. A runtime import added here fails that test.
 */
import type { NetworkMode } from "@tanstack/react-query";

/** What a login transition on one host calls for. */
export type LoginVerdict = "none" | "reset";

/** `prev` is the host's recorded login (`undefined` before the first sighting),
 *  `next` the one a forge-status read just reported. Null is UNKNOWN, never a
 *  sign-out: GitLab's status login is best-effort and reads null on a failed
 *  lookup while the session stays authenticated, and a real sign-out needs no
 *  reset because `forgeReady` already gates the hosted panels. */
export function loginChange(
  prev: string | null | undefined,
  next: string | null,
): LoginVerdict {
  if (prev == null || next === null || prev === next) return "none";
  return "reset";
}

/** Top-level key roots whose reads answer as the signed-in forge account. A
 *  POSITIVE scope, so app-global reads that never touch the forge (the update
 *  check's cached handle, pollers, AI model lists, public web reads) stay put. */
export const FORGE_ROOTS: ReadonlySet<string> = new Set([
  "repo",
  "gh-accounts",
  "gh-repos",
  "gh-repo-stats",
  "gh",
  "bb",
  "accounts-health",
  "forge-repos",
  "forge-owned-namespaces",
  "forge-my-work",
  "forge-starred",
  "forge-search",
  "forge-readme",
  "forge-provider-features",
  "external-reviews",
  "reviewer-notes",
  "bot-avatar",
  "commit-author-avatars",
]);

/** The slice of a react-query `Query` the reset predicate reads. */
export type ResetCandidate = {
  queryKey: readonly unknown[];
  options: { networkMode?: NetworkMode };
};

const isJiraSlot = (slot: unknown) =>
  typeof slot === "string" && slot.startsWith("jira");

/** Whether an account change resets this cached query. Local reads under "repo"
 *  fall out as "always" (scripts/networkmode-local-queries.test.mjs guards it), and
 *  Jira reads sit under a forge root only as the `repo` root's kind slot. */
export function shouldResetOnAccountChange(query: ResetCandidate): boolean {
  const [root, , kind] = query.queryKey;
  return (
    query.options.networkMode !== "always" &&
    typeof root === "string" &&
    FORGE_ROOTS.has(root) &&
    !(root === "repo" && isJiraSlot(kind))
  );
}

/** A query-cache event, as far as the installer reads one. */
export type AccountChangeEvent = {
  type: string;
  action?: { type: string };
  query: { queryKey: readonly unknown[]; state: { data: unknown } };
};

/** The subset of a `QueryClient` the installer drives. */
export type AccountChangeClient = {
  getQueryCache(): {
    subscribe(listener: (event: AccountChangeEvent) => void): () => void;
  };
  resetQueries(filters: {
    predicate: (query: ResetCandidate) => boolean;
  }): Promise<void>;
  invalidateQueries(filters: { queryKey: readonly unknown[] }): Promise<void>;
};

function isForgeStatusKey(key: readonly unknown[]): boolean {
  return key.length === 3 && key[0] === "repo" && key[2] === "forge-status";
}

/** Watches every forge-status success and resets the forge caches when a host's
 *  login changes. `invalidateKeys` names the account-dependent "always" reads the
 *  predicate skips, refreshed after the reset. */
export function installAccountChangeReset(
  client: AccountChangeClient,
  { invalidateKeys }: { invalidateKeys: readonly (readonly unknown[])[] },
): () => void {
  // Keyed by host, never by query (its repo path would read a new repo as a change).
  // Host-less statuses are skipped: the login may be another gh host's, `forgeReady`
  // keeps their `repo: null` panels off, and the next resolved status catches it.
  const baseline = new Map<string, string>();
  return client.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.action?.type !== "success") return;
    if (!isForgeStatusKey(event.query.queryKey)) return;
    const data = event.query.state.data;
    if (typeof data !== "object" || data === null) return;
    const { host, login } = data as { host?: unknown; login?: unknown };
    if (typeof host !== "string") return;
    const next = typeof login === "string" ? login : null;
    if (next === null) return;
    const verdict = loginChange(baseline.get(host), next);
    baseline.set(host, next);
    if (verdict !== "reset") return;
    void client.resetQueries({ predicate: shouldResetOnAccountChange });
    for (const queryKey of invalidateKeys)
      void client.invalidateQueries({ queryKey });
  });
}
