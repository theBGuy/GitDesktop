import { type CollectionEntry, getCollection } from "astro:content";

export type Post = CollectionEntry<"blog">;

// The textbook `import.meta.env.PROD` gate breaks draft PREVIEWS: Cloudflare
// Pages preview deployments also run `astro build`, so PROD is true there too
// and a draft would be invisible on the very branch deploy you want to read it
// on. PUBLIC_SHOW_DRAFTS is set only in the Pages "Preview" environment.
// Both branches are literal `import.meta.env` reads, so they DCE cleanly.
const showDrafts =
  import.meta.env.DEV || import.meta.env.PUBLIC_SHOW_DRAFTS === "true";

/**
 * The ONLY way to read posts. Every route, the feed, the tag pages and
 * prev/next must go through this — a draft leaking into /rss.xml because one
 * caller reached for `getCollection("blog")` directly is the classic blog bug.
 */
export async function getPosts(): Promise<Post[]> {
  const posts = await getCollection(
    "blog",
    ({ data }) => showDrafts || !data.draft,
  );
  return posts.sort(
    (a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf(),
  );
}

/** Every distinct tag across published posts, with counts, most-used first. */
export async function getTags(): Promise<{ tag: string; count: number }[]> {
  const posts = await getPosts();
  const counts = new Map<string, number>();
  for (const post of posts) {
    for (const tag of post.data.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** 200 wpm, floored at 1 — an estimate, not a measurement. */
export function readingTime(post: Post): number {
  const words = (post.body ?? "").trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

export function postUrl(post: Post): string {
  return `/blog/${post.id}/`;
}

export function tagUrl(tag: string): string {
  return `/blog/tags/${tag}/`;
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
