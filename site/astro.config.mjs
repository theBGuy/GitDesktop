import { existsSync, readdirSync } from "node:fs";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

// Slugs that are real posts, so the pagination filter below can't swallow a
// post that happens to have an all-numeric slug (a "2026.md" year review
// builds /blog/2026/ — indistinguishable from page 2026 of the index by URL
// shape alone). Mirrors the content loader's `[^_]*.md` pattern. existsSync:
// an absent content dir should mean an empty blog, not a config-time crash.
const blogDir = new URL("./src/content/blog", import.meta.url);
const postSlugs = new Set(
  (existsSync(blogDir) ? readdirSync(blogDir) : [])
    .filter((f) => f.endsWith(".md") && !f.startsWith("_"))
    .map((f) => f.replace(/\.md$/, "")),
);

// Wrap each markdown <table> in a scrollable div (.prose .table-wrap). The
// alternative — making the table itself the scroll container with
// display:block — drops implicit table semantics for assistive tech in some
// engines, so the wrapper owns the overflow and a table stays a table.
function rehypeTableWrap() {
  const wrap = (node) => {
    if (!node.children) return;
    node.children = node.children.map((child) => {
      if (child.type === "element" && child.tagName === "table") {
        return {
          type: "element",
          tagName: "div",
          properties: { className: ["table-wrap"] },
          children: [child],
        };
      }
      wrap(child);
      return child;
    });
  };
  return (tree) => wrap(tree);
}

// Served on Cloudflare Pages at the apex domain https://gitdesktop.app/.
// (Previously GitHub Pages at https://thebguy.github.io/GitDesktop/ — if you
// move back, set `site: "https://thebguy.github.io"` and `base: "/GitDesktop/"`.)
// The site pins Vite 7 (Astro 6 requires it; the desktop app runs Vite 8) — see
// site/package.json — which is also why @tailwindcss/vite works here.
export default defineConfig({
  site: "https://gitdesktop.app",
  // import.meta.env.BASE_URL mirrors this, so `${BASE_URL}app-icon.svg`
  // resolves to `/app-icon.svg` at the domain root.
  base: "/",

  // Cloudflare 308-redirects every extension-less path to its slash form, so
  // matching that here is what makes an internal link land in one hop instead
  // of two. Endpoints carrying a file extension (/rss.xml, /sitemap-index.xml)
  // are emitted as real files and must be linked WITHOUT a trailing slash.
  trailingSlash: "always",

  markdown: {
    // Astro ships Shiki. "css-variables" lets the existing @theme tokens drive
    // code color instead of bolting a second theme system onto the brand; the
    // variables are mapped in global.css under `.prose pre`.
    shikiConfig: { theme: "css-variables", wrap: true },
    rehypePlugins: [rehypeTableWrap],
  },

  integrations: [
    sitemap({
      // Paginated indexes are navigation, not destinations — every post they
      // list is already in the sitemap under its own URL. A trailing numeric
      // segment is dropped only when it is NOT a real post slug.
      filter: (page) => {
        const m = page.match(/\/blog\/(?:tags\/[^/]+\/)?(\d+)\/$/);
        return !m || postSlugs.has(m[1]);
      },
    }),
  ],

  vite: {
    plugins: [tailwindcss()],
  },
});
