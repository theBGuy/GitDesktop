import {
  CheckCircleIcon,
  CircleDashedIcon,
  GitMergeIcon,
  type Icon,
} from "@phosphor-icons/react";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { ForgeUserAvatar } from "@/components/forge-user-avatar";
import { isUserDismissal } from "@/components/panel-portal";
import { RelativeTime } from "@/components/relative-time";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { Skeleton } from "@/components/ui/skeleton";
import { useForgeGhHost } from "@/lib/git/host";
import { issueDetailsOptions, prDetailsOptions } from "@/lib/git/queries";
import type {
  ForgeUserRef,
  IssueDetails,
  PrDetails,
  RemoteLens,
} from "@/lib/git/types";
import { parseableDate } from "@/lib/time";
import { useRetained } from "@/lib/use-retained";
import { cn } from "@/lib/utils";
import type { MarkdownRefKind, MarkdownRefs } from "./markdown-refs";

/** A reference that fully validated against the emitting renderer's grammar —
 *  what both the click dispatch and this card route on. */
export type MarkdownRefTarget =
  | { kind: "user"; user: string }
  | { kind: Exclude<MarkdownRefKind, "user">; number: number };

/** What a reference IS, independent of the object carrying it — the dispatch
 *  mints a fresh target per pointer event, so resolved content is matched on
 *  this rather than identity, and a re-hover paints from cache without a
 *  skeleton in between. */
function refKey(target: MarkdownRefTarget): string {
  return target.kind === "user"
    ? `user:${target.user}`
    : `${target.kind}:${target.number}`;
}

/**
 * Which of the repo's cached lists already holds `number`, or null when neither
 * does. GitHub's `#N` addresses one number space and its issue lists exclude
 * pull requests, so a cached hit settles the kind with no request at all.
 */
export function cachedRefKind(
  queryClient: QueryClient,
  repoPath: string,
  lens: RemoteLens,
  number: number,
): "pr" | "issue" | null {
  const holds = (list: "pr-list" | "issue-list") =>
    queryClient
      .getQueriesData<{ number: number }[]>({
        queryKey: ["repo", repoPath, list, lens],
      })
      .some(([, rows]) => rows?.some((row) => row.number === number));
  if (holds("pr-list")) return "pr";
  if (holds("issue-list")) return "issue";
  return null;
}

/** Whether a resolved item's web URL addresses a pull request. The issues
 *  endpoint answers for PR numbers too, and the URL's resource segment
 *  (…/pull/N vs …/issues/N) tells the two apart; a substring test would misfire
 *  on a repo named `pull`. */
export function isPullRefUrl(url: string): boolean {
  return new URL(url).pathname.split("/").at(-2) === "pull";
}

/** The calm card's whole payload. `createdAt` is present only where the resolved
 *  shape carries one — pull request details have no creation timestamp. */
interface RefItem {
  state: string;
  title: string;
  author: string;
  createdAt?: string;
}

function issueItem(issue: IssueDetails): RefItem {
  return {
    state: issue.state,
    title: issue.title,
    author: issue.author,
    createdAt: issue.createdAt,
  };
}

/** Draft qualifies an OPEN pull request only — a merged or closed one reports
 *  its own state even where `isDraft` lingers. */
function prItem(pr: PrDetails): RefItem {
  return {
    state: pr.isDraft && pr.state === "OPEN" ? "DRAFT" : pr.state,
    title: pr.title,
    author: pr.author,
  };
}

/**
 * Resolve a number reference under the body's own lens, matching what a click on
 * it would open. Every fetch is cache-first, so a warm list or a second hover
 * costs nothing.
 */
async function resolveRefItem(
  queryClient: QueryClient,
  repoPath: string,
  lens: RemoteLens,
  target: Extract<MarkdownRefTarget, { number: number }>,
): Promise<RefItem> {
  const { number } = target;
  if (target.kind === "mr") {
    return prItem(
      await queryClient.fetchQuery(prDetailsOptions(repoPath, number, lens)),
    );
  }
  if (target.kind === "issue") {
    return issueItem(
      await queryClient.fetchQuery(issueDetailsOptions(repoPath, number, lens)),
    );
  }
  let kind = cachedRefKind(queryClient, repoPath, lens, number);
  // Kept when the classifying read is what answered: it already describes this
  // number, so it can stand in below if the PR read then fails.
  let issue: IssueDetails | null = null;
  if (kind === null) {
    issue = await queryClient.fetchQuery(
      issueDetailsOptions(repoPath, number, lens),
    );
    if (!isPullRefUrl(issue.url)) return issueItem(issue);
    kind = "pr";
  }
  if (kind === "issue") {
    // Only a cached hit lands here — a classifying read that says "issue" has
    // already returned above — so there is nothing kept to reuse.
    return issueItem(
      await queryClient.fetchQuery(issueDetailsOptions(repoPath, number, lens)),
    );
  }
  try {
    // Only the PR shape carries the real merged/draft state.
    return prItem(
      await queryClient.fetchQuery(prDetailsOptions(repoPath, number, lens)),
    );
  } catch (e) {
    // The reference DID resolve; only the merged/draft distinction is lost, so
    // the issue read stands in rather than the card claiming a failure.
    if (issue) return issueItem(issue);
    throw e;
  }
}

/** Glyph and tone per state, following the related-issue `StateIcon` pairing.
 *  The word beside the glyph is what actually carries the state — color never
 *  does — so an unrecognized state (wire drift) falls through to the neutral
 *  dot without losing meaning. */
const STATE_PILL: Record<
  string,
  { Icon: Icon; className: string } | undefined
> = {
  OPEN: { Icon: CircleDashedIcon, className: "text-success" },
  CLOSED: { Icon: CheckCircleIcon, className: "text-merged" },
  MERGED: { Icon: GitMergeIcon, className: "text-merged" },
  DRAFT: { Icon: CircleDashedIcon, className: "text-muted-foreground" },
};
const NEUTRAL_PILL = {
  Icon: CircleDashedIcon,
  className: "text-muted-foreground",
};

/** Bars sized like the rows they stand in for, so the card doesn't resize under
 *  the pointer when the content lands. */
function RefCardSkeleton() {
  return (
    <div className="flex flex-col gap-1.5">
      <Skeleton className="h-3.5 w-20" />
      <Skeleton className="h-3.5 w-full" />
      <Skeleton className="h-3.5 w-4/5" />
      <Skeleton className="h-3.5 w-24" />
    </div>
  );
}

function RefUserCard({
  repoPath,
  lens,
  login,
}: {
  repoPath: string;
  lens: RemoteLens;
  login: string;
}) {
  const queryClient = useQueryClient();
  const ghHost = useForgeGhHost(repoPath);
  // A one-shot cache read: the popup mounts fresh per open, so a later fill can
  // never leave a stale URL behind. GitLab populates `avatarUrl`; GitHub leaves
  // it empty and `ForgeUserAvatar` derives the login's `.png` from `ghHost`.
  const avatarUrl = queryClient
    .getQueryData<ForgeUserRef[]>(["repo", repoPath, "assignable-users", lens])
    ?.find((u) => u.id === login)?.avatarUrl;
  return (
    <div className="flex items-center gap-2">
      <ForgeUserAvatar
        login={login}
        avatarUrl={avatarUrl}
        ghHost={ghHost}
        decorative
      />
      <div className="min-w-0">
        <p className="truncate font-medium">@{login}</p>
        <p className="text-muted-foreground">Opens profile in browser</p>
      </div>
    </div>
  );
}

function RefCardBody({
  repoPath,
  lens,
  target,
  item,
}: {
  repoPath: string;
  lens: RemoteLens;
  target: MarkdownRefTarget | null;
  /** `undefined` while the reference is still resolving, `null` once it failed. */
  item: RefItem | null | undefined;
}) {
  if (!target) return null;
  if (target.kind === "user") {
    return <RefUserCard repoPath={repoPath} lens={lens} login={target.user} />;
  }
  // GitLab numbers merge requests in their own space, so `!5` and `#5` are two
  // different items — the card has to spell the one the body linked.
  const label = `${target.kind === "mr" ? "!" : "#"}${target.number}`;
  if (item === undefined) return <RefCardSkeleton />;
  if (item === null) {
    return <p className="text-muted-foreground">{`Couldn't load ${label}`}</p>;
  }
  const pill = STATE_PILL[item.state] ?? NEUTRAL_PILL;
  const { createdAt } = item;
  return (
    <div className="flex flex-col gap-1.5">
      <p className="flex items-center gap-1.5">
        <pill.Icon className={cn("size-3.5 shrink-0", pill.className)} />
        <span className="capitalize">{item.state.toLowerCase()}</span>
        <span className="text-muted-foreground tabular-nums">{label}</span>
      </p>
      <p className="line-clamp-2 font-medium break-words">{item.title}</p>
      <p className="text-muted-foreground">
        {item.author}
        {createdAt && parseableDate(createdAt) ? (
          <>
            {" · "}
            <RelativeTime date={createdAt} />
          </>
        ) : null}
      </p>
    </div>
  );
}

/**
 * The preview a rendered `#N` / `!N` / `@user` opens on hover or keyboard focus,
 * so the user can judge the reference without spending a view switch on it.
 *
 * One instance serves a whole body: the caller owns which anchor is active (and
 * every open/close delay, since a card with no `PreviewCard.Trigger` gets none of
 * Base UI's hover machinery), and hands the element in as the positioner's
 * anchor. Resolving a number reference warms exactly the queries its destination
 * view reads, so the click after a hover lands on a primed cache.
 */
export function MarkdownRefCard({
  id,
  refs,
  target,
  anchor,
  onOpenChange,
  onPointerEnter,
  onPointerLeave,
}: {
  /** The popup's element id, so the open card's anchor can point an
   *  `aria-describedby` at it. */
  id: string;
  refs: MarkdownRefs;
  /** The reference to show, or null to close. */
  target: MarkdownRefTarget | null;
  /** The anchor to position against. */
  anchor: HTMLElement | null;
  /** Base UI's own dismissals (Escape, outside press) arrive here. */
  onOpenChange: (open: boolean) => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}) {
  const queryClient = useQueryClient();
  const { repoPath, lens } = refs;
  // The positioner's `anchor` prop never yields a measurable reference here —
  // probed live: the popup positioned against a 0×0 rect (element and virtual
  // forms alike) while a store-registered trigger in the same build measured
  // correctly. So the card rides the trigger path instead: an inert invisible
  // span pinned to the active anchor's rect registers as the reference exactly
  // the way a real trigger does. Read once per anchor — the card closes before
  // anything can move it.
  const rect = useMemo(() => anchor?.getBoundingClientRect() ?? null, [anchor]);
  // Keyed by WHICH reference it answers, so a card switching targets reads as
  // resolving rather than painting the previous reference's content under the
  // new one's number — and so re-hovering a resolved one paints straight from
  // this state.
  const [resolved, setResolved] = useState<{
    key: string;
    item: RefItem | null;
  } | null>(null);
  // The live target gates `open`; the retained one drives the content, so the
  // close animation doesn't play over an emptied card.
  const shown = useRetained(target);
  const item =
    shown && resolved?.key === refKey(shown) ? resolved.item : undefined;

  useEffect(() => {
    if (!target || target.kind === "user") return;
    const key = refKey(target);
    let cancelled = false;
    resolveRefItem(queryClient, repoPath, lens, target)
      .then((resolvedItem) => {
        if (!cancelled) setResolved({ key, item: resolvedItem });
      })
      .catch(() => {
        // Quiet by design: the card opens either way, and a toast for a preview
        // the user only hovered would be louder than the miss.
        if (!cancelled) setResolved({ key, item: null });
      });
    return () => {
      cancelled = true;
    };
  }, [target, repoPath, lens, queryClient]);

  return (
    <HoverCard
      open={target !== null}
      // The inert trigger's own hover machinery can never see the pointer over
      // it (pointer-events: none), so ~300ms after every open it schedules a
      // hover close — measured as a metronomic open/close flicker. The caller
      // owns hover; only a real dismissal may close the card.
      onOpenChange={(open, eventDetails) => {
        if (!open && !isUserDismissal(eventDetails.reason)) {
          eventDetails.cancel();
          return;
        }
        onOpenChange(open);
      }}
    >
      {/* Kept mounted through the close fade — an unmounting active trigger
          force-closes the card mid-animation. */}
      <HoverCardTrigger
        render={
          <span
            aria-hidden
            className="pointer-events-none fixed"
            style={
              rect
                ? {
                    left: rect.left,
                    top: rect.top,
                    width: rect.width,
                    height: rect.height,
                  }
                : { display: "none" }
            }
          />
        }
      />
      <HoverCardContent
        id={id}
        align="start"
        alignOffset={0}
        // Wider than a row-anchored card's 4px: the pointer rests ON a `#123`
        // link, and a popup edge that close can capture it.
        sideOffset={8}
        className="w-72"
        // The skeleton is the sighted busy signal; this is its twin for anyone
        // reading the card through the anchor's `aria-describedby`.
        aria-busy={
          shown !== null && shown.kind !== "user" && item === undefined
        }
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
      >
        <RefCardBody
          repoPath={repoPath}
          lens={lens}
          target={shown}
          item={item}
        />
      </HoverCardContent>
    </HoverCard>
  );
}
