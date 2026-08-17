import { Spinner } from "@/components/ui/spinner";
import { useWorktreeRemovals } from "@/lib/stores/worktree-removal";

/**
 * Keeps a running worktree removal visible after its dialog is dismissed. A
 * removal holds the repo lock and can run for minutes, so it lives in the repo
 * view's layout flow (one line per removal, pushing content down) rather than
 * in a toast that expires or an overlay that covers the header. There is
 * nothing to press: a removal can't be cancelled, only waited out.
 */
export function WorktreeRemovalBanner({ repoPath }: { repoPath: string }) {
  const removals = useWorktreeRemovals(repoPath);

  return (
    // Mounted unconditionally: a live region created together with its text
    // announces unreliably, so the region pre-exists and only its CONTENT
    // changes. `sr-only` keeps the empty state out of layout entirely, so no
    // phantom border sits above the panels.
    // No aria-busy: on a live region it tells a screen reader to withhold
    // announcements until it clears, the opposite of what this line is for.
    <div role="status" className={removals.length > 0 ? "border-b" : "sr-only"}>
      {removals.map((r) => (
        <div
          key={r.path}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs"
        >
          <Spinner aria-hidden className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate" title={r.path}>
            Removing worktree <span className="font-mono">{r.name}</span>… This
            can take a few minutes.
          </span>
        </div>
      ))}
    </div>
  );
}
