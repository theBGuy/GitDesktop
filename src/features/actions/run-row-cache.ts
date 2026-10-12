// The run view's loading frame paints its header from a cached runs-list row.
// Pinned by scripts/run-row-cache.test.mjs, which imports this file under
// Node's type stripping, so it must stay free of runtime imports.

/** The header fields a runs-list row and the run's detail share: what the
 *  loading frame can paint before the detail read answers. */
export interface RunRowSeed {
  id: number;
  number: number;
  displayTitle: string;
  status: string;
  conclusion: string;
  workflowName: string;
  headBranch: string;
  event: string;
  createdAt: string;
  url: string;
}

/** One cached query under the repo's `["repo", repo, "actions"]` subtree. */
export interface RunCacheEntry {
  key: readonly unknown[];
  /** Untrusted: every field is guarded before it seeds. */
  data: unknown;
  dataUpdatedAt: number;
}

/** The list-shaped families, in tie-break order. Every other family under the
 *  prefix is rejected by name, before any shape check: `workflows` holds
 *  numeric WORKFLOW ids that can equal a run id, and `run` holds the detail
 *  read the frame stands in for. */
const FAMILY_RANK: ReadonlyMap<unknown, number> = new Map([
  ["runs-paged", 0],
  ["runs", 1],
  ["notify", 2],
  ["latest", 3],
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The row as a seed when every field has its declared type, else undefined. */
function seedFrom(row: Record<string, unknown>): RunRowSeed | undefined {
  const {
    id,
    number,
    displayTitle,
    status,
    conclusion,
    workflowName,
    headBranch,
    event,
    createdAt,
    url,
  } = row;
  if (
    typeof id !== "number" ||
    typeof number !== "number" ||
    typeof displayTitle !== "string" ||
    typeof status !== "string" ||
    typeof conclusion !== "string" ||
    typeof workflowName !== "string" ||
    typeof headBranch !== "string" ||
    typeof event !== "string" ||
    typeof createdAt !== "string" ||
    typeof url !== "string"
  ) {
    return undefined;
  }
  return {
    id,
    number,
    displayTitle,
    status,
    conclusion,
    workflowName,
    headBranch,
    event,
    createdAt,
    url,
  };
}

/** The family's candidate rows: runs-paged is InfiniteData of run pages,
 *  runs and notify are run arrays, latest is one run or null. */
function rowsOf(family: unknown, data: unknown): readonly unknown[] {
  if (family === "latest") return data === null ? [] : [data];
  if (family !== "runs-paged") return Array.isArray(data) ? data : [];
  if (!isRecord(data) || !Array.isArray(data.pages)) return [];
  return data.pages.flatMap((page: unknown) =>
    isRecord(page) && Array.isArray(page.runs) ? page.runs : [],
  );
}

/** The guarded row with `id === runId` from the freshest list-shaped entry
 *  (greatest `dataUpdatedAt`, ties by {@link FAMILY_RANK}). A malformed entry
 *  or row is skipped, never thrown, so it can't blank the frame. */
export function cachedRunRow(
  entries: readonly RunCacheEntry[],
  runId: number,
): RunRowSeed | undefined {
  let best: { row: RunRowSeed; at: number; rank: number } | undefined;
  for (const entry of entries) {
    try {
      if (entry.key[2] !== "actions") continue;
      const rank = FAMILY_RANK.get(entry.key[3]);
      if (rank === undefined) continue;
      // The first well-formed match: runs-paged can repeat a row across a
      // page boundary, and a malformed copy must not hide a good one.
      let row: RunRowSeed | undefined;
      for (const candidate of rowsOf(entry.key[3], entry.data)) {
        if (!isRecord(candidate) || candidate.id !== runId) continue;
        row = seedFrom(candidate);
        if (row !== undefined) break;
      }
      if (row === undefined) continue;
      const at = Number.isFinite(entry.dataUpdatedAt) ? entry.dataUpdatedAt : 0;
      if (
        best === undefined ||
        at > best.at ||
        (at === best.at && rank < best.rank)
      ) {
        best = { row, at, rank };
      }
    } catch {
      // One unreadable entry never costs the others their row.
    }
  }
  return best?.row;
}
