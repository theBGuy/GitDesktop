/** Parent folder of a path, where a clone's subfolder gets created. */
export function parentDir(p: string): string {
  const idx = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return idx > 0 ? p.slice(0, idx) : "";
}

/** Repo name inferred from a clone URL — the "will clone into" hint and the
 *  submodule dialog's path placeholder, both advisory: a clone's real name comes
 *  from `default_clone_dir_name` (src-tauri/src/git/repo.rs) and a submodule's
 *  from git itself — keep the separator sets in sync with that Rust twin. */
export function nameFromUrl(url: string): string {
  const last = url.trim().replace(/[/\\]+$/, "").split(/[/\\:]/).pop() ?? "";
  return last.replace(/\.git$/, "");
}
