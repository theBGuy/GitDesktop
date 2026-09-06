import {
  CheckCircleIcon,
  CircleDashedIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  type Icon,
} from "@phosphor-icons/react";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
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
import {
  issueDetailsOptions,
  prDetailsOptions,
  useAssignableUsers,
} from "@/lib/git/queries";
import type { IssueDetails, PrDetails, RemoteLens } from "@/lib/git/types";
import { parseableDate } from "@/lib/time";
import { useRetained } from "@/lib/use-retained";
import { cn } from "@/lib/utils";
import {
  MarkdownInertLinkCard,
  MarkdownLinkCard,
  MarkdownRepoFileCard,
} from "./markdown-link-card";
import type { MarkdownRefKind, MarkdownRefs } from "./markdown-refs";

/** Why an anchor won't open, which is also which one-line reason its card
 *  shows: no address at all, a same-page fragment, a scheme the app doesn't
 *  hand off, a destination outside the repository (`//host`), or a
 *  repository-relative path on a body with no forge to resolve it against. */
export type InertVariant =
  | "empty"
  | "fragment"
  | "scheme"
  | "external"
  | "repoNoForge";

/** What an anchor in a rendered body opens a card for: a forge reference that
 *  fully validated against the emitting renderer's grammar (what the click
 *  dispatch routes on), a link leaving the app — `mailto:` included, which the
 *  card tells apart by scheme — a repository-relative path the click resolves to
 *  a file on the forge, or a link that won't open at all, whose card names where
 *  it points (where it points anywhere) and why the click does nothing. */
export type MarkdownRefTarget =
  | { kind: "user"; user: string }
  | { kind: Exclude<MarkdownRefKind, "user">; number: number }
  | { kind: "external"; href: string }
  | { kind: "repoFile"; href: string }
  | { kind: "inert"; variant: InertVariant; href: string };

/** The forge-reference half of that union: what the click dispatch navigates
 *  in-app and what the card's resolve runs for. No link kind is one. */
export type MarkdownForgeTarget = Exclude<
  MarkdownRefTarget,
  { kind: "external" | "repoFile" | "inert" }
>;

/** The other half: what an anchor resolves to on its href alone, with no
 *  reference grammar involved — the three the click acts on (external opens, and
 *  the click-inert kinds that only ever get a card). One classifier answers with
 *  this, and the click dispatch and the card both obey that answer. */
export type MarkdownLinkTarget = Extract<
  MarkdownRefTarget,
  { kind: "external" | "repoFile" | "inert" }
>;

/** Which half of the union a target sits in — a forge reference the card
 *  resolves, versus a link kind it describes without a fetch. Every gate on the
 *  resolve reads this one answer, so a new link kind can't be admitted to the
 *  resolve by a test that only knew about the previous ones. */
function isForgeTarget(
  target: MarkdownRefTarget,
): target is MarkdownForgeTarget {
  return (
    target.kind !== "external" &&
    target.kind !== "repoFile" &&
    target.kind !== "inert"
  );
}

/** What a reference IS, independent of the object carrying it — the dispatch
 *  mints a fresh target per pointer event, so resolved content is matched on
 *  this rather than identity, and a re-hover paints from cache without a
 *  skeleton in between. All three axes the resolve reads: the same number under
 *  the other repo or lens is a different item, and a key blind to them would
 *  paint the previous scope's title under the new scope's number. */
function refKey(
  repoPath: string,
  lens: RemoteLens,
  target: MarkdownForgeTarget,
): string {
  const ref =
    target.kind === "user"
      ? `user:${target.user}`
      : `${target.kind}:${target.number}`;
  return `${repoPath}|${lens}|${ref}`;
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
 *  on a repo named `pull`.
 *  A malformed or empty URL throws here by design — both callers contain it: the
 *  card's resolve `.catch` paints "Couldn't load", and `openRef`'s try toasts. */
export function isPullRefUrl(url: string): boolean {
  return new URL(url).pathname.split("/").at(-2) === "pull";
}

/** The calm card's whole payload. `createdAt` is present only where the resolved
 *  shape carries one — pull request details have no creation timestamp. */
interface RefItem {
  /** Which shape answered. A GitHub `#N` can be either, and the two read CLOSED
   *  differently, so the pill needs the answer the resolve already had. */
  flavor: "issue" | "pr";
  state: string;
  title: string;
  author: string;
  createdAt?: string;
}

function issueItem(issue: IssueDetails): RefItem {
  return {
    flavor: "issue",
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
    flavor: "pr",
    state: pr.isDraft && pr.state === "OPEN" ? "DRAFT" : pr.state,
    title: pr.title,
    author: pr.author,
  };
}

/**
 * Resolve a number reference under the body's own lens, matching what a click on
 * it would open. Reads are cache-first within each query's staleTime, and a warm
 * list settles the kind without the classifying read — but a cold GitHub `#N`
 * still costs two reads, so the caller's open delay is what keeps a pointer
 * crossing a body of references from resolving every one of them.
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

interface StatePill {
  Icon: Icon;
  className: string;
}

/** Glyph and tone per state, shared by both shapes. The word beside the glyph is
 *  what actually carries the state — color never does — so an unrecognized state
 *  (wire drift) falls through to the neutral dot without losing meaning. */
const STATE_PILL: Record<string, StatePill | undefined> = {
  OPEN: { Icon: CircleDashedIcon, className: "text-success" },
  MERGED: { Icon: GitMergeIcon, className: "text-merged" },
  DRAFT: { Icon: CircleDashedIcon, className: "text-muted-foreground" },
};

/** CLOSED is the one state the app's two conventions part on: a closed issue is
 *  resolved (the related-issue `StateIcon`), a closed pull request is abandoned
 *  (`prPresentation` in IssueDevelopment), and a card that borrowed one for the
 *  other would name the right state beside the wrong glyph. */
const CLOSED_PILL: Record<RefItem["flavor"], StatePill> = {
  issue: { Icon: CheckCircleIcon, className: "text-merged" },
  pr: { Icon: GitPullRequestIcon, className: "text-destructive" },
};

const NEUTRAL_PILL: StatePill = {
  Icon: CircleDashedIcon,
  className: "text-muted-foreground",
};

/** The card's settled maximum, reserved up front: a state row, a `line-clamp-2`
 *  title, and an author row — four lines at the popup's own `text-xs/relaxed`
 *  line box. The card may SHRINK when the reference resolves (the bottom edge
 *  retracts, away from the anchor) but must never grow: Base UI re-runs
 *  collision avoidance as the popup resizes, and one that flips to the anchor's
 *  other side lands out from under the pointer and closes itself. */
function RefCardSkeleton() {
  return (
    <div className="flex flex-col gap-1.5">
      <Skeleton className="h-[1.625em] w-20" />
      <Skeleton className="h-[1.625em] w-full" />
      <Skeleton className="h-[1.625em] w-4/5" />
      <Skeleton className="h-[1.625em] w-24" />
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
  const ghHost = useForgeGhHost(repoPath);
  // Whatever the pickers have already fetched, read through the same hook they
  // use so the card repaints if the list lands under it — disabled, because a
  // preview must never be what pulls the repo's whole user list. GitLab
  // populates `avatarUrl`; GitHub leaves it empty and `ForgeUserAvatar` derives
  // the login's `.png` from `ghHost`.
  const { data: users } = useAssignableUsers(repoPath, false, lens);
  const avatarUrl = users?.find((u) => u.id === login)?.avatarUrl;
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
  refs,
  target,
  item,
}: {
  /** Absent on bodies rendered with no forge context (the help screen, AI
   *  output) — only external targets can arise there. */
  refs: MarkdownRefs | undefined;
  target: MarkdownRefTarget | null;
  /** `undefined` while the reference is still resolving, `null` once it failed. */
  item: RefItem | null | undefined;
}) {
  if (!target) return null;
  if (target.kind === "external")
    return <MarkdownLinkCard href={target.href} />;
  // Inert links arise on ANY body, forge or not (an empty href, a `//host` in
  // an AI-output body) — so this branch sits before the `!refs` guard below.
  if (target.kind === "inert")
    return (
      <MarkdownInertLinkCard variant={target.variant} href={target.href} />
    );
  // A forge reference only exists because the context that linkified it does,
  // and a repository-relative path is only claimed where that same context can
  // resolve it — so this is unreachable rather than a state to render.
  if (!refs) return null;
  const { repoPath, lens } = refs;
  if (target.kind === "repoFile")
    return <MarkdownRepoFileCard href={target.href} provider={refs.provider} />;
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
  const pill =
    (item.state === "CLOSED"
      ? CLOSED_PILL[item.flavor]
      : STATE_PILL[item.state]) ?? NEUTRAL_PILL;
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
 * Base UI's hover machinery), and hands in the rect it measured at open.
 * Resolving a number reference warms exactly the queries its destination view
 * reads, so the click after a hover lands on a primed cache.
 */
export function MarkdownRefCard({
  id,
  refs,
  target,
  rect,
  onOpenChange,
  onPointerEnter,
  onPointerLeave,
}: {
  /** The popup's element id, so the open card's anchor can point an
   *  `aria-describedby` at it. */
  id: string;
  /** Forge context for the reference kinds. Omitted on bodies that have none —
   *  an external link needs no repo to describe itself. */
  refs?: MarkdownRefs;
  /** The reference to show, or null to close. */
  target: MarkdownRefTarget | null;
  /** Viewport geometry of the active anchor, measured when the card opened. */
  rect: DOMRect | null;
  /** Base UI's own dismissals (Escape, outside press) arrive here. */
  onOpenChange: (open: boolean) => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}) {
  const queryClient = useQueryClient();
  // Read as primitives rather than through `refs`, so a caller rebuilding that
  // object each render can't re-run the resolve below.
  const repoPath = refs?.repoPath;
  const lens = refs?.lens;
  // The positioner's `anchor` prop never yields a measurable reference here —
  // probed live: the popup positioned against a 0×0 rect (element and virtual
  // forms alike) while a store-registered trigger in the same build measured
  // correctly. So the card rides the trigger path instead: an inert invisible
  // span pinned to the active anchor's rect registers as the reference exactly
  // the way a real trigger does. The caller measures at each open and closes the
  // card on the first scroll or resize, so the rect it opened at is the only one
  // it is ever shown at.
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
  // Null for anything the resolve never runs for — either link kind, or a
  // reference on a body with no forge context.
  const shownKey =
    shown && isForgeTarget(shown) && repoPath && lens
      ? refKey(repoPath, lens, shown)
      : null;
  const item =
    shownKey !== null && resolved?.key === shownKey ? resolved.item : undefined;

  useEffect(() => {
    if (!repoPath || !lens) return;
    if (!target || !isForgeTarget(target) || target.kind === "user") return;
    const key = refKey(repoPath, lens, target);
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
        // The card opens empty and fills in, but `aria-describedby` resolves
        // once, at focus — so the popup is a polite live region and the resolved
        // state, title and author announce themselves as they land. `aria-busy`
        // is the skeleton's twin for the same reader, and holds the announcement
        // until the swap is done.
        role="status"
        // Link cards are never busy: what they say is on screen the frame the
        // card opens, and only an external link's og section below it is still
        // arriving. Holding the announcement for that would silence the part
        // that always lands.
        aria-busy={
          shown !== null &&
          isForgeTarget(shown) &&
          shown.kind !== "user" &&
          item === undefined
        }
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
      >
        <RefCardBody refs={refs} target={shown} item={item} />
      </HoverCardContent>
    </HoverCard>
  );
}
