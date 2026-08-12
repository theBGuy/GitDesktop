import {
  ArrowSquareOutIcon,
  GitForkIcon,
  StarIcon,
} from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useState } from "react";
import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Markdown } from "@/components/ui/markdown";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  useForkRepoByName,
  useRepoReadme,
  useRepoStarred,
  useStarRepo,
} from "@/lib/git/queries";
import {
  type ForgeForkResult,
  type ForgeProvider,
  type ForgeProviderFeatures,
  type ForgeSearchRepo,
  providerLabel,
} from "@/lib/git/types";
import { useConfirm } from "@/lib/stores/confirm";
import { toastError } from "@/lib/toast";
import type { ExploreCloneTarget } from "./ExploreCloneDialog";
import { compactNumber } from "./explore-utils";

/** The Explore detail pane: the selected repo's header, actions (clone / fork /
 *  star / view), and its lazily-fetched README. `features` gates fork/star, and
 *  `viewer` (the screen's own-repos query) additionally gates fork; a selected
 *  repo drives the star + README queries. */
export function ExploreDetail({
  provider,
  repo,
  features,
  viewer,
  onClone,
}: {
  provider: ForgeProvider;
  repo: ForgeSearchRepo | null;
  features: ForgeProviderFeatures | undefined;
  /** The signed-in user's login; null while resolving, and may be "" when the
   *  provider's viewer probe fails (both fall back to the capability-only gate). */
  viewer: string | null;
  onClone: (target: ExploreCloneTarget) => void;
}) {
  if (!repo) {
    return (
      <Empty className="border-none">
        <EmptyHeader>
          <EmptyTitle>Select a repository</EmptyTitle>
          <EmptyDescription>
            Pick a repository from the list to preview its README and clone,
            fork, or star it.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <ExploreDetailBody
      // Remount per repo so fork success/progress state resets cleanly on switch.
      key={`${provider}:${repo.fullName}`}
      provider={provider}
      repo={repo}
      features={features}
      viewer={viewer}
      onClone={onClone}
    />
  );
}

function ExploreDetailBody({
  provider,
  repo,
  features,
  viewer,
  onClone,
}: {
  provider: ForgeProvider;
  repo: ForgeSearchRepo;
  features: ForgeProviderFeatures | undefined;
  viewer: string | null;
  onClone: (target: ExploreCloneTarget) => void;
}) {
  const label = providerLabel(provider);
  // Forking always creates the copy under your own account, so a repo you own
  // personally is never a valid target — hidden, not disabled, since there's
  // nothing actionable to explain. Personal ownership, not write access: org
  // repos stay forkable; an unknown viewer (null, or the "" non-GitHub backends
  // emit) falls back to the capability gate. On Bitbucket the compare is inert in
  // practice — `owner` is a workspace slug, `viewer` a username — which is why the
  // guide scopes this behavior to GitHub and GitLab.
  const canFork =
    (features?.implemented.repoForkByName ?? false) &&
    !(viewer && repo.owner === viewer);
  const canStar = features?.implemented.repoStar ?? false;
  const canReadme = features?.implemented.repoReadme ?? false;

  const starred = useRepoStarred(provider, repo.owner, repo.name, canStar);
  const starMutation = useStarRepo();
  const fork = useForkRepoByName();
  const [forked, setForked] = useState<ForgeForkResult | null>(null);

  const readme = useRepoReadme(
    provider,
    repo.owner,
    repo.name,
    repo.defaultBranch,
    canReadme,
  );

  function toggleStar() {
    starMutation.mutate({
      provider,
      owner: repo.owner,
      name: repo.name,
      star: !starred.data,
    });
  }

  async function onFork() {
    const ok = await useConfirm.getState().ask({
      title: `Fork ${repo.fullName}?`,
      body: `Creates a fork under your account on ${label} in the background. You can clone it once it's ready.`,
      confirmLabel: "Fork",
    });
    if (!ok) return;
    fork.mutate(
      { provider, owner: repo.owner, name: repo.name },
      {
        onSuccess: (result) => setForked(result),
        onError: (e) => toastError(e),
      },
    );
  }

  // Only actionable once the starred state has resolved — a click on `undefined`
  // would compute `star: !undefined === true` and always star.
  const starLoaded = starred.data !== undefined;
  const isStarred = starred.data ?? false;

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="space-y-2">
        <div className="flex items-start gap-2">
          <h2
            className="min-w-0 flex-1 truncate font-heading text-sm font-medium"
            title={repo.fullName}
          >
            {repo.fullName}
          </h2>
        </div>
        {(repo.private || repo.fork || repo.archived) && (
          <div className="flex flex-wrap items-center gap-1.5">
            {repo.private && (
              <Badge variant="secondary" className="text-[10px]">
                Private
              </Badge>
            )}
            {repo.fork && (
              <Badge variant="secondary" className="text-[10px]">
                Fork
              </Badge>
            )}
            {repo.archived && (
              <Badge variant="secondary" className="text-[10px]">
                Archived
              </Badge>
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          {repo.stars != null && (
            <span className="flex items-center gap-0.5 tabular-nums">
              <StarIcon className="size-3" />
              {compactNumber.format(repo.stars)}
            </span>
          )}
          {repo.language && <span>{repo.language}</span>}
          {repo.updatedAt && (
            <span>
              updated <RelativeTime date={repo.updatedAt} />
            </span>
          )}
        </div>
        {repo.description && (
          <p className="text-xs/relaxed text-foreground/90">
            {repo.description}
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          onClick={() =>
            onClone({
              provider,
              cloneUrl: repo.cloneUrl,
              name: repo.name,
            })
          }
        >
          Clone
        </Button>
        {canFork && (
          <Button
            size="sm"
            variant="outline"
            onClick={onFork}
            disabled={fork.isPending}
          >
            {fork.isPending ? (
              <>
                <Spinner />
                Forking…
              </>
            ) : (
              <>
                <GitForkIcon />
                Fork
              </>
            )}
          </Button>
        )}
        {canStar && (
          // Disabled until the starred state resolves — toggling on `undefined`
          // would always star (`!undefined === true`). The wrapping span carries
          // the reason since a native-disabled button swallows its `title`.
          <span
            className="inline-flex"
            title={starLoaded ? undefined : "Checking star state…"}
          >
            <Button
              size="sm"
              variant="outline"
              aria-pressed={isStarred}
              disabled={!starLoaded}
              onClick={toggleStar}
            >
              <StarIcon weight={isStarred ? "fill" : "regular"} />
              {isStarred ? "Unstar" : "Star"}
            </Button>
          </span>
        )}
        {repo.webUrl && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => repo.webUrl && openUrl(repo.webUrl)}
          >
            <ArrowSquareOutIcon />
            View on {label}
          </Button>
        )}
      </div>

      {forked && (
        <div className="space-y-2 border border-success/40 bg-success/10 p-3">
          <p className="text-xs font-medium">Forked to {forked.fullName}</p>
          {!forked.ready && (
            <p className="text-[11px] text-muted-foreground">
              It may take a moment before the fork can be cloned.
            </p>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              onClone({
                provider,
                cloneUrl: forked.cloneUrl,
                // Use the fork's OWN name, not repo.name: GitHub renames a
                // colliding fork (rust → rust-1), so the local folder must
                // follow the fork's actual name segment.
                name: forked.fullName.split("/").pop() ?? repo.name,
              })
            }
          >
            Clone the fork
          </Button>
        </div>
      )}

      {canReadme && (
        <>
          <hr className="border-border" />
          <ReadmeSection
            loading={readme.isPending}
            content={readme.data ?? null}
          />
        </>
      )}
    </div>
  );
}

function ReadmeSection({
  loading,
  content,
}: {
  loading: boolean;
  content: string | null;
}) {
  if (loading) {
    return (
      <div className="space-y-2">
        {["a", "b", "c", "d"].map((k) => (
          <Skeleton key={k} className="h-4 w-full" />
        ))}
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  }
  if (!content) {
    return <p className="text-xs text-muted-foreground">No README.</p>;
  }
  return <Markdown>{content}</Markdown>;
}
