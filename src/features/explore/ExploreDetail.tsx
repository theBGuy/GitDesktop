import {
  ArrowSquareOutIcon,
  GitForkIcon,
  StarIcon,
} from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
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
import { parseableDate } from "@/lib/time";
import { toastError } from "@/lib/toast";
import type { ExploreCloneTarget } from "./ExploreCloneDialog";
import { starParts } from "./explore-utils";

/** The not-yet-clonable note, shared by the fork toast and the inline fork card
 *  so the two can't drift. */
const FORK_NOT_READY = "It may take a moment before the fork can be cloned.";

/** The Explore detail pane: the selected repo's header, actions (clone / fork /
 *  star / view), and its lazily-fetched README. `features` gates fork/star, and
 *  `ownedNamespaces` (the screen's own-repos query) additionally gates fork; a
 *  selected repo drives the star + README queries. */
export function ExploreDetail({
  provider,
  repo,
  features,
  ownedNamespaces,
  onClone,
}: {
  provider: ForgeProvider;
  repo: ForgeSearchRepo | null;
  features: ForgeProviderFeatures | undefined;
  /** The owner namespaces that count as the viewer's own; empty while the query
   *  resolves or when the provider's probe failed (both fall back to the
   *  capability-only gate). */
  ownedNamespaces: readonly string[];
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
      ownedNamespaces={ownedNamespaces}
      onClone={onClone}
    />
  );
}

function ExploreDetailBody({
  provider,
  repo,
  features,
  ownedNamespaces,
  onClone,
}: {
  provider: ForgeProvider;
  repo: ForgeSearchRepo;
  features: ForgeProviderFeatures | undefined;
  ownedNamespaces: readonly string[];
  onClone: (target: ExploreCloneTarget) => void;
}) {
  const label = providerLabel(provider);
  // A repo already in a namespace of yours is never a valid fork target — hidden,
  // not disabled, since there's nothing actionable to explain. The backend decides
  // what "yours" means per provider: your login on GitHub and GitLab, so org and
  // group repos stay forkable; on Bitbucket, any workspace you belong to, because it
  // exposes no usable personal-workspace signal and a fork inside a workspace you
  // already have access to carries no contribution meaning. An empty set (resolving,
  // or a failed probe) falls back to the capability gate.
  const canFork =
    (features?.implemented.repoForkByName ?? false) &&
    !ownedNamespaces.includes(repo.owner);
  const canStar = features?.implemented.repoStar ?? false;
  const canReadme = features?.implemented.repoReadme ?? false;

  const starred = useRepoStarred(provider, repo.owner, repo.name, canStar);
  const starMutation = useStarRepo();
  const fork = useForkRepoByName();
  const [forked, setForked] = useState<ForgeForkResult | null>(null);
  // The fork card below is the in-pane confirmation, but this pane is keyed per
  // repo and unmounts on a switch — so the toast covers only that case, and the
  // ref is what tells the two apart once the fork resolves.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const readme = useRepoReadme(
    provider,
    repo.owner,
    repo.name,
    repo.defaultBranch,
    canReadme,
  );

  async function toggleStar() {
    try {
      await starMutation.mutateAsync({
        provider,
        owner: repo.owner,
        name: repo.name,
        star: !starred.data,
      });
    } catch (e) {
      // The optimistic flip rolls back on failure, so without this the icon
      // snaps back with nothing explaining why.
      toastError(e);
    }
  }

  // Awaited, not per-call callbacks: this pane is keyed per repo and unmounts on
  // a switch while the fork's readiness poll still runs, and react-query drops
  // per-call callbacks once the observer has no listeners.
  async function onFork() {
    const ok = await useConfirm.getState().ask({
      title: `Fork ${repo.fullName}?`,
      body: `Creates a fork on ${label} in the background. You can clone it once it's ready.`,
      confirmLabel: "Fork",
    });
    if (!ok) return;
    try {
      const result = await fork.mutateAsync({
        provider,
        owner: repo.owner,
        name: repo.name,
      });
      // Still here: the card says it, with the Clone action attached. Gone: the
      // toast is the only surface left to say it.
      if (mounted.current) {
        setForked(result);
      } else {
        toast.success(`Forked to ${result.fullName}`, {
          description: result.ready ? undefined : FORK_NOT_READY,
        });
      }
    } catch (e) {
      toastError(e);
    }
  }

  // Only actionable once the starred state has resolved — a click on `undefined`
  // would compute `star: !undefined === true` and always star.
  const starLoaded = starred.data !== undefined;
  const isStarred = starred.data ?? false;

  const star = starParts(repo.stars ?? null);

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
          {star && (
            // role="img" prunes the icon AND the number, so the label carries
            // both the count and its unit.
            <span
              role="img"
              aria-label={star.label}
              title={star.label}
              className="flex items-center gap-0.5 tabular-nums"
            >
              <StarIcon className="size-3" aria-hidden />
              {star.text}
            </span>
          )}
          {repo.language && <span>{repo.language}</span>}
          {repo.updatedAt && parseableDate(repo.updatedAt) && (
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
          // would always star (`!undefined === true`).
          <DisabledReasonButton
            size="sm"
            variant="outline"
            aria-pressed={starLoaded ? isStarred : undefined}
            disabled={!starLoaded}
            reason="Checking star state…"
            onClick={toggleStar}
          >
            <StarIcon weight={isStarred ? "fill" : "regular"} />
            {isStarred ? "Unstar" : "Star"}
          </DisabledReasonButton>
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

      {/* The card is the only confirmation while the pane is mounted (the toast
          that would otherwise carry it fires once this pane is gone), so it has to
          announce itself. Mounted unconditionally: a live region created together
          with its text announces unreliably, so the region pre-exists and only its
          CONTENT changes, and `sr-only` keeps the empty state out of layout. */}
      <div
        role="status"
        className={
          forked
            ? "space-y-2 border border-success/40 bg-success/10 p-3"
            : "sr-only"
        }
      >
        {forked && (
          <>
            <p className="text-xs font-medium">Forked to {forked.fullName}</p>
            {!forked.ready && (
              <p className="text-[11px] text-muted-foreground">
                {FORK_NOT_READY}
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
          </>
        )}
      </div>

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
