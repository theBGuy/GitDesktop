import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { forgeProbeReason } from "@/lib/git/queries";
import type { RemoteLens } from "@/lib/git/types";
import {
  useLensState,
  useRemoteSlug,
  useSetRepoLens,
} from "@/lib/repo-lens/queries";

/**
 * The per-repo Fork | Upstream lens switch, shared by the Pull Requests and
 * Issues panels. A segmented pair of `aria-pressed` buttons mirroring the
 * Open/Closed state filter in ConversationListPanel. Once the forge answers it
 * renders only on a GitHub fork (useLensState's `gate`), hidden on
 * GitLab/Bitbucket or a repo with no upstream remote, and each button's
 * `title` names the repo it targets (the resolved slug). Before that first
 * answer (`waiting`), any repo with an upstream remote shows the pair disabled
 * with its reason and no titles (the slugs resolve only behind the gate), so
 * the scope row is in place from the first frame; the Fork / Upstream labels
 * carry the meaning either way.
 */
export function RepoLensSwitcher({ repoPath }: { repoPath: string }) {
  const { gate, lens, waiting, storedLens } = useLensState(repoPath);
  const setLens = useSetRepoLens(repoPath);
  // Resolve both slugs only while the switcher is shown.
  const forkSlug = useRemoteSlug(repoPath, "origin", gate);
  const upstreamSlug = useRemoteSlug(repoPath, "upstream", gate);

  if (!gate && !waiting) return null;

  const buttons: { value: RemoteLens; label: string; slug: string | null }[] = [
    { value: "origin", label: "Fork", slug: forkSlug },
    { value: "upstream", label: "Upstream", slug: upstreamSlug },
  ];
  // The gated lens reads "origin" until the gate opens, so the wait shows the
  // stored lens, which is what a supported fork settles on.
  const pressed = waiting ? storedLens : lens;
  const reason = waiting
    ? forgeProbeReason("checking", "switch between fork and upstream")
    : null;

  return (
    // ml-auto: flush-right on the scope row so Upstream's edge lines up with the
    // filter funnel's on the row above (this root div is the row's own child —
    // ConversationListPanel can't wrap it without defeating its `empty:hidden`).
    <div className="ml-auto flex items-center gap-1">
      {/* One element type in both arms, so a focused button survives the
          settle (a waiting-only wrapper would remount it). */}
      {buttons.map((b) => (
        <DisabledReasonButton
          key={b.value}
          variant={pressed === b.value ? "secondary" : "ghost"}
          size="xs"
          className="px-1.5"
          aria-pressed={pressed === b.value}
          title={b.slug ?? undefined}
          disabled={waiting}
          reason={reason}
          onClick={() => setLens(b.value)}
        >
          {b.label}
        </DisabledReasonButton>
      ))}
    </div>
  );
}
