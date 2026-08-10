import rss from "@astrojs/rss";
import type { APIContext } from "astro";
import { getPosts, postUrl } from "../lib/posts";

// Author names are free strings in the schema. NAMED entities only — the
// library re-parses item customData (fast-xml-parser), which round-trips
// &amp;/&lt;/&gt; but leaves numeric refs like &#39; double-escaped into
// visible text. The builder handles apostrophes and quotes on its own.
const escapeXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

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
      "Engineering notes from building a desktop Git client for GitHub, GitLab and Bitbucket.",
    site,
    // Match the site's own URL shape so readers and analytics agree.
    trailingSlash: true,
    // RSS 2.0's <author> (and @astrojs/rss's field) is an EMAIL address, so
    // the byline ships as Dublin Core dc:creator instead.
    xmlns: { dc: "http://purl.org/dc/elements/1.1/" },
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: post.data.pubDate,
      link: postUrl(post),
      customData: `<dc:creator>${escapeXml(post.data.author)}</dc:creator>`,
      categories: post.data.tags,
    })),
    customData: "<language>en-us</language>",
  });
}
