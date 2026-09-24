/**
 * The pure cache patches behind the project status update writes. Import-free at
 * runtime on purpose (types only, erased): `scripts/project-status-cache.test.mjs`
 * imports this file straight from `src/` under Node's type stripping, which
 * resolves no bundler aliases, so a runtime import added here fails that test.
 */
import type { ProjectStatusUpdate, ProjectStatusUpdates } from "../types";

/** Whether a post may patch the cache the read left in `state`. Everything may but
 *  a read that FAILED with nothing cached: a seed would flip it to success, and
 *  should the settle re-read fail too, one entry would stand as the whole history
 *  where the strip otherwise draws nothing. A read not landed yet may be seeded, so
 *  a post made before it still shows. */
export function mayPatchStatusCache(
  state: { status: string; data: unknown } | undefined,
): boolean {
  return !(state?.status === "error" && state.data === undefined);
}

/** `data` with `update` leading it and the count moved with it. An empty cache is
 *  SEEDED with the entry alone, so a post fired before the first read lands still
 *  shows at once; the seed's count and cap are claims only the settle re-read can
 *  replace. Callers gate the seed on {@link mayPatchStatusCache}. */
export function prependStatusUpdate(
  data: ProjectStatusUpdates | undefined,
  update: ProjectStatusUpdate,
): ProjectStatusUpdates {
  if (data === undefined)
    return { updates: [update], totalCount: 1, truncated: false };
  return {
    ...data,
    updates: [update, ...data.updates],
    totalCount: data.totalCount + 1,
  };
}

/** `data` with `id`'s entry replaced by `next`'s answer, or `data` untouched when it
 *  no longer holds that entry. */
export function replaceStatusUpdate(
  data: ProjectStatusUpdates | undefined,
  id: string,
  next: ProjectStatusUpdate,
): ProjectStatusUpdates | undefined {
  if (data === undefined || !data.updates.some((u) => u.id === id)) return data;
  return {
    ...data,
    updates: data.updates.map((u) => (u.id === id ? next : u)),
  };
}

/** `data` without `id`'s entry, its count moved with it. A cache that no longer
 *  holds the entry is left alone, so a second removal can't take the count twice. */
export function dropStatusUpdate(
  data: ProjectStatusUpdates | undefined,
  id: string,
): ProjectStatusUpdates | undefined {
  if (data === undefined || !data.updates.some((u) => u.id === id)) return data;
  return {
    ...data,
    updates: data.updates.filter((u) => u.id !== id),
    totalCount: Math.max(0, data.totalCount - 1),
  };
}

/** `updates` with `update` placed by its `createdAt`, newest first — the read's own
 *  order, which a rollback keeps even when entries landed above the slot it left.
 *  An unparseable timestamp sorts after every readable one. */
export function insertNewestFirst(
  updates: ProjectStatusUpdate[],
  update: ProjectStatusUpdate,
): ProjectStatusUpdate[] {
  const at = Date.parse(update.createdAt);
  const index = updates.findIndex((u) => {
    const other = Date.parse(u.createdAt);
    return Number.isNaN(other) || (!Number.isNaN(at) && other < at);
  });
  return updates.toSpliced(index < 0 ? updates.length : index, 0, update);
}
