/** Parent folder of a path, where a clone's subfolder gets created. */
export function parentDir(p: string): string {
  const idx = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return idx > 0 ? p.slice(0, idx) : "";
}

/** Repo name inferred from a clone URL, for the "will clone into" hint. */
export function nameFromUrl(url: string): string {
  const last = url.trim().replace(/\/+$/, "").split(/[/:]/).pop() ?? "";
  return last.replace(/\.git$/, "");
}
