import { Spinner } from "@/components/ui/spinner";
import { clipTitleFromText } from "@/lib/clip-title";
import { type PendingPublish, usePendingPublishes } from "@/lib/git/queries";

/** Each publish provider's display name. */
export const PUBLISH_PROVIDER_LABELS: Record<
  PendingPublish["provider"],
  string
> = {
  github: "GitHub",
  gitlab: "GitLab",
  bitbucket: "Bitbucket",
};

/** The one spelling of a running publish's line, split around the name so the
 *  banner can set it in mono while the reasons read it as plain text. */
export function publishingHoldParts(p: PendingPublish): {
  before: string;
  name: string;
  after: string;
} {
  return {
    before: "Publishing ",
    name: p.name,
    after: ` to ${PUBLISH_PROVIDER_LABELS[p.provider]}…`,
  };
}

/** {@link publishingHoldParts} as one string: the hold reason of the Publish
 *  triggers and of a dialog that didn't start the publish. */
export function publishingHold(p: PendingPublish): string {
  const { before, name, after } = publishingHoldParts(p);
  return `${before}${name}${after}`;
}

/**
 * Keeps a running repository publish visible after its dialog is dismissed. A
 * publish pushes the whole history and can run for minutes, so it lives in the
 * repo view's layout flow, like the worktree-removal line. Read from the mutation
 * cache, so it follows the repo that started it across switches and clears when
 * the publish settles either way. There is nothing to press: a publish can't be
 * cancelled.
 */
export function PublishPendingBanner({ repoPath }: { repoPath: string }) {
  const publishes = usePendingPublishes(repoPath);

  return (
    // Mounted unconditionally: a live region created together with its text
    // announces unreliably, so the region pre-exists and only its CONTENT
    // changes. `sr-only` keeps the empty state out of layout entirely.
    // No aria-busy: on a live region it tells a screen reader to withhold
    // announcements until it clears, the opposite of what this line is for.
    <div
      role="status"
      className={publishes.length > 0 ? "border-b" : "sr-only"}
    >
      {publishes.map((p) => {
        const line = publishingHoldParts(p);
        return (
          <div
            key={`${p.provider}:${p.name}`}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs"
          >
            <Spinner aria-hidden className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate" onMouseEnter={clipTitleFromText}>
              {line.before}
              <span className="font-mono">{line.name}</span>
              {line.after} This can take a few minutes for a long history.
            </span>
          </div>
        );
      })}
    </div>
  );
}
