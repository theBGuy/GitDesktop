import { type CollectionEntry, getCollection } from "astro:content";

export type Post = CollectionEntry<"blog">;

// The textbook `import.meta.env.PROD` gate breaks unpublished-post PREVIEWS:
// Cloudflare Pages preview deployments also run `astro build`, so PROD is true
// there too and an unpublished post (draft or future-dated) would be invisible
// on the very branch deploy you want to proof it on. PUBLIC_SHOW_DRAFTS is set
// only in the Pages "Preview" environment.
// Both branches are literal `import.meta.env` reads, so they DCE cleanly.
const showUnpublished =
  import.meta.env.DEV || import.meta.env.PUBLIC_SHOW_DRAFTS === "true";

// One cutoff for the entire build so every surface agrees on which posts
// exist. A future pubDate behaves exactly like `draft: true` until the
// site-scheduled-publish cron re-fires the production build after the UTC
// midnight that flips it — a date gate alone publishes nothing, because
// builds only happen on push or deploy-hook fire.
const buildTime = Date.now();

/**
 * The ONLY way to read posts. Every route, the feed, the tag pages and
 * prev/next must go through this — an unpublished post (draft or future-dated)
 * leaking into /rss.xml because one caller reached for `getCollection("blog")`
 * directly is the classic blog bug.
 */
export async function getPosts(): Promise<Post[]> {
  const posts = await getCollection(
    "blog",
    ({ data }) =>
      showUnpublished || (!data.draft && data.pubDate.valueOf() <= buildTime),
  );
  return posts.sort(
    (a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf(),
  );
}

/**
 * Every distinct tag across published posts, with counts, most-used first.
 * `aiCount` exists so Just-Git surfaces can show honest numbers
 * (`count - aiCount`) and hide all-AI tags outright instead of advertising
 * posts the view then hides.
 */
export async function getTags(): Promise<
  { tag: string; count: number; aiCount: number }[]
> {
  const posts = await getPosts();
  const counts = new Map<string, { count: number; aiCount: number }>();
  for (const post of posts) {
    for (const tag of post.data.tags) {
      const entry = counts.get(tag) ?? { count: 0, aiCount: 0 };
      entry.count += 1;
      if (post.data.ai) entry.aiCount += 1;
      counts.set(tag, entry);
    }
  }
  return [...counts.entries()]
    .map(([tag, { count, aiCount }]) => ({ tag, count, aiCount }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** 200 wpm, floored at 1 — an estimate, not a measurement. */
export function readingTime(post: Post): number {
  const words = (post.body ?? "").trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

// "/" today; honors the same base convention as the layouts if the site
// ever moves under a subpath (see the note in astro.config.mjs).
const base = import.meta.env.BASE_URL;

export function postUrl(post: Post): string {
  return `${base}blog/${post.id}/`;
}

export function tagUrl(tag: string): string {
  return `${base}blog/tags/${tag}/`;
}

/** UTC-pinned so a post never renders a day early west of Greenwich. */
export function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Machine-readable half of every <time> element. */
export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
