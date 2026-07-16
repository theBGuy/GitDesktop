import { Button } from "@/components/ui/button";
import type { RemoteLens } from "@/lib/git/types";
import {
  useLensGate,
  useRemoteSlug,
  useRepoLens,
  useSetRepoLens,
} from "@/lib/repo-lens/queries";

/**
 * The per-repo Fork | Upstream lens switch, shared by the Pull Requests and
 * Issues panels. A segmented pair of `aria-pressed` buttons mirroring the
 * Open/Closed state filter in ConversationListPanel. Rendered only on a GitHub
 * fork (useLensGate) — hidden entirely on GitLab/Bitbucket or a repo with no
 * upstream remote. Each button's `title` names the repo it targets (the
 * resolved slug), so the meaning is never conveyed by position alone.
 */
export function RepoLensSwitcher({ repoPath }: { repoPath: string }) {
  const gate = useLensGate(repoPath);
  const lens = useRepoLens(repoPath);
  const setLens = useSetRepoLens(repoPath);
  // Resolve both slugs only while the switcher is shown.
  const forkSlug = useRemoteSlug(repoPath, "origin", gate);
  const upstreamSlug = useRemoteSlug(repoPath, "upstream", gate);

  if (!gate) return null;

  const buttons: { value: RemoteLens; label: string; slug: string | null }[] = [
    { value: "origin", label: "Fork", slug: forkSlug },
    { value: "upstream", label: "Upstream", slug: upstreamSlug },
  ];

  return (
    <div className="flex items-center gap-1">
      {buttons.map((b) => (
        <Button
          key={b.value}
          variant={lens === b.value ? "secondary" : "ghost"}
          size="xs"
          aria-pressed={lens === b.value}
          title={b.slug ?? undefined}
          onClick={() => setLens(b.value)}
        >
          {b.label}
        </Button>
      ))}
    </div>
  );
}
