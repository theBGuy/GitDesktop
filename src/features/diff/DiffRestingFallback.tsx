import { statusReadFailed } from "@/features/repository/StatusReadError";
import { useRepoStatus } from "@/lib/git/queries";
import { DiffPlaceholder } from "./DiffPlaceholder";
import { restingDiffMessage } from "./diff-resting-message";

/**
 * The Changes pane while DiffViewer's chunk loads: the same geometry and
 * message as its settled no-selection state, so the reveal changes nothing on
 * screen. Must not import DiffViewer or DiffSurface, or the split undoes.
 */
export function DiffRestingFallback({ repoPath }: { repoPath: string }) {
  const status = useRepoStatus(repoPath);
  return (
    <div className="relative h-full">
      {/* A sibling of the busy region, never inside it: aria-busy suppresses
          its descendants' live announcements. */}
      <span role="status" className="sr-only">
        Loading the diff…
      </span>
      <div className="h-full" aria-busy>
        <DiffPlaceholder
          message={restingDiffMessage(
            status.isPending,
            status.data?.entries.length ?? 0,
            statusReadFailed(status),
          )}
        />
      </div>
    </div>
  );
}
