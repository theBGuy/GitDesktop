import { DisabledReasonButton } from "@/components/disabled-reason-button";
import {
  forgeProbeReason,
  forgeProbeState,
  useForgeStatus,
  useRemotes,
} from "@/lib/git/queries";
import type { RemoteLens } from "@/lib/git/types";
import {
  useLensGate,
  useRemoteSlug,
  useRepoLens,
  useRepoLensRaw,
  useSetRepoLens,
} from "@/lib/repo-lens/queries";

/**
 * The per-repo Fork | Upstream lens switch, shared by the Pull Requests and
 * Issues panels. A segmented pair of `aria-pressed` buttons mirroring the
 * Open/Closed state filter in ConversationListPanel. Rendered only on a GitHub
 * fork (useLensGate) — hidden entirely on GitLab/Bitbucket or a repo with no
 * upstream remote. Each button's `title` names the repo it targets (the
 * resolved slug), so the meaning is never conveyed by position alone. While the
 * forge check runs on a repo with an upstream remote, the pair holds disabled
 * with its reason, so the scope row is in place from the first frame.
 */
export function RepoLensSwitcher({ repoPath }: { repoPath: string }) {
  const gate = useLensGate(repoPath);
  const lens = useRepoLens(repoPath);
  const setLens = useSetRepoLens(repoPath);
  // Resolve both slugs only while the switcher is shown.
  const forkSlug = useRemoteSlug(repoPath, "origin", gate);
  const upstreamSlug = useRemoteSlug(repoPath, "upstream", gate);
  // Waits only before the forge's first answer and first failure: a refetch of
  // an errored read with no data goes pending again, and useLensState's
  // `settled` flips on every background refetch, so either would re-flash the
  // pair. The local upstream remote limits the wait to repos that can be forks.
  const forge = useForgeStatus(repoPath);
  const remotes = useRemotes(repoPath);
  const stored = useRepoLensRaw(repoPath);
  const waiting =
    !gate &&
    forgeProbeState(forge) === "checking" &&
    forge.errorUpdateCount === 0 &&
    Boolean(remotes.data?.includes("upstream"));

  if (!gate && !waiting) return null;

  const buttons: { value: RemoteLens; label: string; slug: string | null }[] = [
    { value: "origin", label: "Fork", slug: forkSlug },
    { value: "upstream", label: "Upstream", slug: upstreamSlug },
  ];
  // The gated lens reads "origin" until the gate opens, so the wait shows the
  // stored lens, which is what a supported fork settles on.
  const pressed = waiting ? (stored.data ?? "origin") : lens;
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
