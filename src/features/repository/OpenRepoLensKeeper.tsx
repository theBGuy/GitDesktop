import { useRepoLensRaw } from "@/lib/repo-lens/queries";
import { useUiStore } from "@/lib/stores/ui";

/** Holds the open repository's cached lens observed whatever view is on screen.
 *  A session-only lens lives in that cache entry alone, and the selections minted
 *  under it outlive the repository view through Settings, Help, Explore and My
 *  work; a repository left behind loses its observer and keeps the default
 *  expiry. Mounted once by App, outside its per-view branches. */
export function OpenRepoLensKeeper() {
  const repoPath = useUiStore((s) => s.repoPath);
  return repoPath === null ? null : <KeepLens repo={repoPath} />;
}

function KeepLens({ repo }: { repo: string }) {
  useRepoLensRaw(repo);
  return null;
}
