// The diff panes' one reader of a whole file at a rev, from this clone's
// objects or from the forge by sha. Imports nothing that reaches ./DiffSurface,
// so PR hosts import it without pulling in the diff chunk.
import {
  type UseQueryOptions,
  type UseQueryResult,
  useQuery,
} from "@tanstack/react-query";
import { useState } from "react";
import type { FileBytes } from "@/lib/git/api";
import { fileAtRevOptions, forgeFileAtShaOptions } from "@/lib/git/queries";
import type { RemoteLens } from "@/lib/git/types";

/** Where a diff's whole-file reads come from: this clone's objects, or the forge by sha under a lens. */
export type DiffContentSource = "local" | { lens: RemoteLens };

/** The diff text came from a forge, not from `contentRevs`. A host passes it
 *  from its first paint, with `source` null until the source is known, so the
 *  diff records that paint as on screen and only ever upgrades over it. */
export interface ForgePatch {
  source: DiffContentSource | null;
  /** The record the diff belongs to (a pull request, a commit): image panes
   *  keep a pair only within it. Absent = one record. */
  scope?: string;
  /** The current pair's read settled in error: image panes drop a pair they
   *  kept instead of drawing it under this diff. */
  pairUnavailable?: boolean;
}

/** The first value `key` is given, kept while the key holds (null: no key), so
 *  a later or failed answer for the same key never replaces it. */
export function useLatchedFor<T>(
  key: string | null,
  value: T | undefined,
): T | undefined {
  const [latch, setLatch] = useState<{ key: string; value: T } | null>(null);
  if (key !== null && latch?.key === key) return latch.value;
  const next = key !== null && value !== undefined ? { key, value } : null;
  if (next !== null || latch !== null) setLatch(next);
  return next?.value;
}

/** A source as ONE query-key segment: "local", or `forge:${lens}` ("forge:origin", "forge:upstream"). */
export function contentSourceKey(source: DiffContentSource): string {
  return source === "local" ? "local" : `forge:${source.lens}`;
}

/** Content mode's byte budget for one forge-read side. Content mode rejects a side over 100_000 chars
 *  once decoded, and UTF-8 spends at most 3 bytes per UTF-16 code unit, so a side over 300_000 bytes is
 *  always over that cap. */
export const FORGE_CONTENT_BUDGET_BYTES = 300_000;

/** A forge read names its commit by a full object id only. */
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** One side of a diff at a rev. Local: `rev` is a rev, or null for the working tree. Forge: `rev` must
 *  be a full sha; anything else is a disabled read with no data, never sent to `git_file_base64`.
 *  `maxBytes` applies to a forge read only (null = the 20 MB image cap). */
export function useFileAtSource(args: {
  repo: string;
  source: DiffContentSource;
  rev: string | null;
  path: string;
  enabled: boolean;
  maxBytes?: number | null;
}): UseQueryResult<FileBytes | null> {
  const { repo, source, rev, path, enabled, maxBytes = null } = args;
  const sha = rev !== null && FULL_SHA.test(rev) ? rev : null;
  // One query whatever the source, so a source flip never changes hook order.
  const options: UseQueryOptions<FileBytes | null> =
    source === "local"
      ? fileAtRevOptions(repo, rev, path)
      : forgeFileAtShaOptions(repo, source.lens, sha ?? "", path, maxBytes);
  return useQuery({
    ...options,
    enabled: enabled && (source === "local" || sha !== null),
  });
}
