// Pure staging/diff logic for MCP server secrets, which wait for the settings
// Save like every other registry edit. Runtime-import-free so
// scripts/mcp-secret-ops.test.mjs imports it directly.

/** A typed secret value waiting for Save. Renderer memory only, never persisted. */
export interface McpStagedSecret {
  serverId: string;
  key: string;
  value: string;
}

export interface McpSecretDelete {
  serverId: string;
  key: string;
}

/** What the settings screen hands the MCP section to stage secret writes into
 *  its Save buffer. */
export interface McpSecretsHandle {
  stage(
    serverId: string,
    writes: readonly { key: string; value: string }[],
    liveSecretKeys: readonly unknown[],
  ): void;
  pruneServer(serverId: string): void;
}

const SAFE_TOKEN_CHAR = /^[A-Za-z0-9._-]$/;

/** Mirrors the backend's `safe_token` (src-tauri/src/secrets.rs): a non-empty
 *  string of ASCII alphanumerics, `.`, `_` and `-`. Total: any non-string is
 *  false, since a hand-edited settings file can carry a numeric server id. */
export function isSafeMcpSecretKey(key: unknown): boolean {
  if (typeof key !== "string" || key.length === 0) return false;
  for (const ch of key) if (!SAFE_TOKEN_CHAR.test(ch)) return false;
  return true;
}

/** Windows Credential Manager's value cap in UTF-16 units: keyring rejects a
 *  password whose UTF-16 byte length exceeds CRED_MAX_CREDENTIAL_BLOB_SIZE
 *  (2560). macOS and Linux keychains have no such cap. */
export const MAX_WINDOWS_SECRET_UTF16 = 1280;

/** Whether the OS keychain can store `value`. A JS string's `length` is its
 *  UTF-16 unit count, so an astral character counts twice. */
export function secretValueFits(value: string, windows: boolean): boolean {
  return !windows || value.length <= MAX_WINDOWS_SECRET_UTF16;
}

/** The first secret write the keychain would refuse, and why. Writes whose
 *  values are typed `string` can't hit the non-string arm, so their result type
 *  leaves `"value"` out. */
export interface McpSecretWriteProblem<V = unknown> {
  key: string;
  kind: "name" | "length" | ([V] extends [string] ? never : "value");
}

/** Checks secret writes in a fixed precedence: an unsafe name, then a value
 *  that isn't a string (a hand-edited config), then a value over the Windows
 *  cap. Returns the first failing write's key with its kind, or null. */
export function secretWriteProblem<V>(
  writes: readonly { key: string; value: V }[],
  windows: boolean,
): McpSecretWriteProblem<V> | null {
  const badName = writes.find((w) => !isSafeMcpSecretKey(w.key));
  if (badName) return { key: badName.key, kind: "name" };
  const notString = writes.find((w) => typeof w.value !== "string");
  if (notString)
    return { key: notString.key, kind: "value" } as McpSecretWriteProblem<V>;
  const tooLong = writes.find(
    (w) => !secretValueFits(w.value as string, windows),
  );
  if (tooLong) return { key: tooLong.key, kind: "length" };
  return null;
}

/** A staged value the keychain refused, with the error it raised. `entry` is
 *  the staged input object itself: the settle matches it by identity. */
export interface McpSetFailure {
  entry: McpStagedSecret;
  error: unknown;
}

/** A queue that starts each call only after every earlier call has settled,
 *  resolved or rejected. A rejection or sync throw becomes that call's own
 *  rejection and never stalls the calls behind it. */
export function createCallQueue(): <T>(call: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(call: () => Promise<T>): Promise<T> => {
    const run = tail.then(call);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

/** The dialog's one derivation of a server's entries from its editor rows. A
 *  typed secret value goes only to `secretWrites`, never into `entries` or
 *  `secretKeys`, which become part of the settings draft. */
export function entryPlanFromRows(
  rows: readonly {
    key: string;
    value: string;
    secret: boolean;
    secretInput: string;
  }[],
): {
  entries: { key: string; value: string }[];
  secretKeys: string[];
  secretWrites: { key: string; value: string }[];
} {
  const entries: { key: string; value: string }[] = [];
  const secretKeys: string[] = [];
  const secretWrites: { key: string; value: string }[] = [];
  for (const r of rows) {
    const key = r.key.trim();
    entries.push({ key, value: r.secret ? "" : r.value });
    if (!r.secret) continue;
    secretKeys.push(key);
    if (r.secretInput.trim()) secretWrites.push({ key, value: r.secretInput });
  }
  return { entries, secretKeys, secretWrites };
}

const samePair = (
  a: { serverId: string; key: string },
  b: { serverId: string; key: string },
) => a.serverId === b.serverId && a.key === b.key;

/** Stages `writes` for one server: its entries for keys no longer live are
 *  dropped, an upsert replaces every entry for its pair, and every other entry
 *  passes through by reference (the settle matches entries by identity). */
export function stageMcpSecretSets({
  staged,
  serverId,
  writes,
  liveSecretKeys,
}: {
  staged: readonly McpStagedSecret[];
  serverId: string;
  writes: readonly { key: string; value: string }[];
  liveSecretKeys: readonly unknown[];
}): McpStagedSecret[] {
  const live = new Set(
    liveSecretKeys.filter((k): k is string => typeof k === "string"),
  );
  let next = staged.filter((s) => s.serverId !== serverId || live.has(s.key));
  for (const w of writes) {
    const entry = { serverId, key: w.key, value: w.value };
    next = next.filter((s) => !samePair(s, entry));
    next.push(entry);
  }
  return next;
}

/** Drops every staged entry for `serverId`; the rest pass through by reference. */
export function pruneStagedServer(
  staged: readonly McpStagedSecret[],
  serverId: string,
): McpStagedSecret[] {
  return staged.filter((s) => s.serverId !== serverId);
}

/** Settles the buffer after a flush: removes the `pressed` entries that are not
 *  in `keep`, by reference. Never adds anything back, so an entry replaced,
 *  pruned or discarded while the flush ran stays gone even if it failed. */
export function settleStaged({
  current,
  pressed,
  keep,
}: {
  current: readonly McpStagedSecret[];
  pressed: readonly McpStagedSecret[];
  keep: readonly McpStagedSecret[];
}): McpStagedSecret[] {
  const done = new Set(pressed.filter((s) => !keep.includes(s)));
  return current.filter((s) => !done.has(s));
}

const isRow = (row: unknown): row is Record<string, unknown> =>
  typeof row === "object" && row !== null && !Array.isArray(row);

/** Every (server id, string secret key) pair a registry container references.
 *  Rows that aren't plain objects, or whose id isn't a non-empty string, are
 *  skipped. Reads the rows only; never rebuilds or mutates them. */
function referencedPairs(
  container: readonly unknown[],
): Map<string, Set<string>> {
  const pairs = new Map<string, Set<string>>();
  for (const row of container) {
    if (!isRow(row)) continue;
    const id = row.id;
    if (typeof id !== "string" || id === "") continue;
    const keys = pairs.get(id) ?? new Set<string>();
    pairs.set(id, keys);
    const secretKeys = row.secretKeys;
    if (!Array.isArray(secretKeys)) continue;
    for (const k of secretKeys) if (typeof k === "string") keys.add(k);
  }
  return pairs;
}

const hasPair = (
  pairs: Map<string, Set<string>>,
  serverId: string,
  key: string,
) => pairs.get(serverId)?.has(key) === true;

/** Which staged values a Save may write: only pairs the just-committed registry
 *  references (a draft-only pair is dropped unwritten). A container that isn't
 *  an array proves nothing, so everything is retained and nothing flushes.
 *  Every returned element IS an input object (the settle matches by identity). */
export function stagedSetFlushPlan({
  staged,
  committed,
}: {
  staged: readonly McpStagedSecret[];
  committed: unknown;
}): { flush: McpStagedSecret[]; retain: McpStagedSecret[] } {
  if (!Array.isArray(committed)) return { flush: [], retain: [...staged] };
  const pairs = referencedPairs(committed);
  const referenced = staged.filter((s) => hasPair(pairs, s.serverId, s.key));
  // Last-wins dedupe: keep an entry only when no later entry names its pair.
  const flush = referenced.filter(
    (s, i) => !referenced.slice(i + 1).some((later) => samePair(s, later)),
  );
  return { flush, retain: [] };
}

/** Keychain entries a Save must delete: pairs in BOTH the form's baseline and
 *  the saved registry that the committed registry no longer references. The
 *  baseline intersection keeps a server another window added out of the diff;
 *  any non-array container yields nothing, so a corrupt registry can't
 *  mass-delete. */
export function mcpSecretDeletes({
  baseline,
  saved,
  committed,
}: {
  baseline: unknown;
  saved: unknown;
  committed: unknown;
}): McpSecretDelete[] {
  if (
    !Array.isArray(baseline) ||
    !Array.isArray(saved) ||
    !Array.isArray(committed)
  )
    return [];
  const base = referencedPairs(baseline);
  const before = referencedPairs(saved);
  const after = referencedPairs(committed);
  const out: McpSecretDelete[] = [];
  for (const [serverId, keys] of before) {
    for (const key of keys) {
      if (hasPair(base, serverId, key) && !hasPair(after, serverId, key))
        out.push({ serverId, key });
    }
  }
  return out;
}

/** The keychain-failure Details heading for each failure: its key and its
 *  server's name from the committed registry, so two servers failing on the
 *  same key read apart (the keychain's own error never names the account). A
 *  row without a non-blank string name falls back to the server id. */
export function mcpSetFailureHeadings({
  failures,
  committed,
}: {
  failures: readonly McpSetFailure[];
  committed: unknown;
}): string[] {
  const names = new Map<string, string>();
  if (Array.isArray(committed))
    for (const row of committed) {
      if (!isRow(row) || typeof row.id !== "string" || names.has(row.id))
        continue;
      if (typeof row.name === "string" && row.name.trim())
        names.set(row.id, row.name);
    }
  return failures.map(
    ({ entry }) =>
      `Secret "${entry.key}" on "${names.get(entry.serverId) ?? entry.serverId}"`,
  );
}
