/**
 * Where a Projects board card's issue or pull request opens, and what its menu
 * rows say. Pure: no React, no store, no IPC, so the labels and the open read
 * one classification and cannot promise a destination the open won't use.
 */
import type { BoardItem, BoardItemContent, RemoteLens } from "@/lib/git/types";
import {
  type LocalLandingTarget,
  openableMatches,
  urlAuthority,
} from "@/lib/local-landing/match";
import type { RecentRepo } from "@/lib/settings/api";

/** A card the app can open: an issue or a pull request. */
export type OpenableContent = Extract<
  BoardItemContent,
  { kind: "issue" | "pullRequest" }
>;

/** What the board knows about the open repository when a card is classified. */
export interface CardOpenContext {
  /** The open repository's slug under the ACTIVE lens; null until its remote URL read answers. */
  repoSlug: string | null;
  /** The other fork side; null where the lens does not apply. `slug` null until its read answers. */
  otherSide: { lens: RemoteLens; slug: string | null } | null;
  /** The open repository's forge host (`forge_status.host`). */
  forgeHost: string;
  recents: readonly RecentRepo[];
}

type CardDestination =
  | { kind: "here" }
  | { kind: "lens"; lens: RemoteLens }
  | { kind: "clone"; target: LocalLandingTarget; candidates: RecentRepo[] }
  | { kind: "browser" };

/** The one spelling of each fork side, shared by the menu row and the spoken
 *  arrival so the two cannot drift; the switcher's own words. */
const SIDE_WORD: Record<RemoteLens, string> = {
  upstream: "Upstream",
  origin: "Fork",
};

const OPEN_ON_WEB = "Open on GitHub";

const WEB_PATH: Record<OpenableContent["kind"], string> = {
  issue: "issues",
  pullRequest: "pull",
};

/** THE same-repository rule: two "owner/name" slugs, compared case-insensitively. */
export function sameRepoSlug(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * The resolver's target for a card, or null when it can't be proven: a slug
 * that isn't exactly `owner/name`, or a forge host that won't parse. `host`
 * drops any port (the spelling the origin read and recents store) while
 * `authority` keeps it, so a port-less forge host over a ported origin fails
 * the proof and the card takes the browser.
 */
export function cardLandingTarget(
  content: OpenableContent,
  forgeHost: string,
): LocalLandingTarget | null {
  const parts = content.repoNameWithOwner.split("/");
  if (parts.length !== 2 || parts[0] === "" || parts[1] === "") return null;
  const url = `https://${forgeHost}`;
  const authority = urlAuthority(url);
  if (authority === null) return null;
  return {
    // The board reads projects only on GitHub.
    provider: "github",
    host: new URL(url).hostname.toLowerCase(),
    authority,
    repoOwner: parts[0],
    repoName: parts[1],
    repoFullName: content.repoNameWithOwner,
    number: content.number,
    isPullRequest: content.kind === "pullRequest",
  };
}

/**
 * Where a card opens; the first match wins. An unresolved active slug takes the
 * browser: until it answers, "another repository" can't be told from this one,
 * and an in-app open on an unconfirmed match would paint the wrong repository's
 * detail view under this number.
 */
export function cardDestination(
  content: OpenableContent,
  ctx: CardOpenContext,
): CardDestination {
  if (ctx.repoSlug === null) return { kind: "browser" };
  if (sameRepoSlug(content.repoNameWithOwner, ctx.repoSlug))
    return { kind: "here" };
  const other = ctx.otherSide;
  if (
    other !== null &&
    other.slug !== null &&
    sameRepoSlug(content.repoNameWithOwner, other.slug)
  )
    return { kind: "lens", lens: other.lens };
  const target = cardLandingTarget(content, ctx.forgeHost);
  if (target === null) return { kind: "browser" };
  const candidates = openableMatches(target, ctx.recents);
  if (candidates.length === 0) return { kind: "browser" };
  return { kind: "clone", target, candidates };
}

/** `https://${forgeHost}/${repoNameWithOwner}/${"issues" | "pull"}/${number}` */
export function cardWebUrl(
  content: OpenableContent,
  forgeHost: string,
): string {
  return `https://${forgeHost}/${content.repoNameWithOwner}/${WEB_PATH[content.kind]}/${content.number}`;
}

/** The primary row's words for a destination. A clone row names the card's own
 *  repository, never the clone's folder. */
function primaryLabel(destination: CardDestination): string {
  switch (destination.kind) {
    case "here":
      return "Open";
    case "lens":
      return `Open in ${SIDE_WORD[destination.lens]}`;
    case "clone":
      return `Open in ${destination.target.repoName}`;
    case "browser":
      return OPEN_ON_WEB;
  }
}

/** The card menu's Open rows, or null where the menu carries none: a draft
 *  opens its notes from the card itself, and a redacted item has no
 *  destination. `secondary` is null when `primary` is "Open on GitHub". */
export function openRowLabels(
  item: BoardItem | undefined,
  ctx: CardOpenContext,
): { primary: string; secondary: string | null } | null {
  const content = item?.content;
  if (
    content === undefined ||
    (content.kind !== "issue" && content.kind !== "pullRequest")
  )
    return null;
  const primary = primaryLabel(cardDestination(content, ctx));
  return { primary, secondary: primary === OPEN_ON_WEB ? null : OPEN_ON_WEB };
}

/** "Opened in <repoName>" */
export function openedInStatus(repoName: string): string {
  return `Opened in ${repoName}`;
}

/** "Opened in Upstream" / "Opened in Fork": the side word the menu row uses. */
export function openedInSideStatus(lens: RemoteLens): string {
  return `Opened in ${SIDE_WORD[lens]}`;
}
