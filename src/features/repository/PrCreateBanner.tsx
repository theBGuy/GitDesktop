import { Spinner } from "@/components/ui/spinner";
import { usePrCreates } from "@/lib/stores/pr-create";

/**
 * Keeps a running pull-request creation visible after its dialog is dismissed.
 * The push plus the forge call hold the repo lock and can run for minutes, so
 * this lives in the repo view's layout flow (one line per create, pushing
 * content down) rather than in a toast that expires or an overlay that covers
 * the header. There is nothing to press: `git push` has no clean mid-flight
 * cancel, so a create can only be waited out.
 */
export function PrCreateBanner({ repoPath }: { repoPath: string }) {
  const creates = usePrCreates(repoPath);

  return (
    // Mounted unconditionally: a live region created together with its text
    // announces unreliably, so the region pre-exists and only its CONTENT
    // changes. `sr-only` keeps the empty state out of layout entirely, so no
    // phantom border sits above the panels.
    // No aria-busy: on a live region it tells a screen reader to withhold
    // announcements until it clears, the opposite of what this line is for.
    <div role="status" className={creates.length > 0 ? "border-b" : "sr-only"}>
      {creates.map((c) => (
        <div
          key={c.head}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs"
        >
          <Spinner aria-hidden className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">
            Creating pull request <span className="font-mono">{c.head}</span> →{" "}
            <span className="font-mono">{c.base}</span>…
          </span>
        </div>
      ))}
    </div>
  );
}
