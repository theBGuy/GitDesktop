import rss from "@astrojs/rss";
import type { APIContext } from "astro";
import { getPosts, postUrl } from "../lib/posts";

// Served at /rss.xml with NO trailing slash. Endpoints carrying a file
// extension 404 on a trailing slash regardless of `trailingSlash: "always"`,
// and Cloudflare only ADDS slashes to extension-less paths, so it will not
// rescue a bad link. Head.astro emits the slash-less form.
export async function GET(context: APIContext) {
  const site = context.site;
  if (!site) {
    throw new Error(
      "astro.config.mjs must set `site` for the RSS feed to build",
    );
  }

  // getPosts(), never getCollection("blog") — this is exactly where a draft
  // leaks if the filter is forgotten.
  const posts = await getPosts();

  return rss({
    title: "GitDesktop",
    description:
      "Engineering notes from building a native Git client for GitHub, GitLab and Bitbucket.",
    site,
    // Match the site's own URL shape so readers and analytics agree.
    trailingSlash: true,
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: post.data.pubDate,
      link: postUrl(post),
      author: post.data.author,
      categories: post.data.tags,
    })),
    customData: "<language>en-us</language>",
  });
}
