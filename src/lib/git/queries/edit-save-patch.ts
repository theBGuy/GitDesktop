// The optimistic cache patch the issue and pull request Edit saves share.
// Package-private: index.ts does not re-export this module.
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { mayHaveLanded, otherChangesSaved } from "@/lib/error-summary";
import type { AttachmentRefs } from "../types";

/** What an Edit save sends for one issue or pull request. */
export interface EditSaveArgs {
  number: number;
  title: string;
  body: string;
  attachments?: AttachmentRefs;
}

/** The optimistic patch an Edit save made: the details key it wrote and, per
 *  field it changed, the value before and the value it wrote. */
export interface EditSavePatch {
  key: QueryKey;
  fields: { field: "title" | "body"; prev: string; next: string }[];
}

/** Patches an Edit save's title, and its description unless the save carries an
 *  image (the forge rewrites image references, so the stored text is not the
 *  sent text), into the item's cached details. Nothing else is patched, and a
 *  key holding no data is neither cancelled nor written. */
export async function patchEditSave<T extends { title: string; body: string }>(
  queryClient: QueryClient,
  key: QueryKey,
  args: EditSaveArgs,
): Promise<EditSavePatch | undefined> {
  if (queryClient.getQueryData<T>(key) === undefined) return undefined;
  // Exact: a pull request's diff key extends its details key.
  await queryClient.cancelQueries({ queryKey: key, exact: true });
  const cur = queryClient.getQueryData<T>(key);
  if (cur === undefined) return undefined;
  const next: { title: string; body?: string } = { title: args.title };
  if (!args.attachments?.names.length) next.body = args.body;
  const fields: EditSavePatch["fields"] = [];
  for (const field of ["title", "body"] as const) {
    const value = next[field];
    if (value !== undefined && value !== cur[field])
      fields.push({ field, prev: cur[field], next: value });
  }
  if (fields.length === 0) return undefined;
  queryClient.setQueryData<T>(key, (d) => (d ? { ...d, ...next } : d));
  return { key, fields };
}

/** Restores each field an Edit save patched, only while the cache still holds
 *  the value that save wrote: a newer different value survives, while a newer
 *  read returning the value the save wrote can't be told apart and is restored
 *  over until the settle's re-read lands. A failure that may have landed, or
 *  that says its other changes were saved (an image save patches only the
 *  title, which gh saved), restores nothing: the settle's re-read decides which
 *  values the forge holds. */
export function rollbackEditSave<T extends { title: string; body: string }>(
  queryClient: QueryClient,
  patch: EditSavePatch | undefined,
  error: unknown,
) {
  if (!patch || mayHaveLanded(error) || otherChangesSaved(error)) return;
  queryClient.setQueryData<T>(patch.key, (cur) => {
    if (!cur) return cur;
    const back = patch.fields.filter((f) => cur[f.field] === f.next);
    if (back.length === 0) return undefined;
    const out = { ...cur };
    for (const f of back) out[f.field] = f.prev as T[typeof f.field];
    return out;
  });
}
