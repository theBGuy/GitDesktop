import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

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
  },

  integrations: [
    sitemap({
      // Paginated indexes are navigation, not destinations — every post they
      // list is already in the sitemap under its own URL.
      filter: (page) => !/\/blog\/(tags\/[^/]+\/)?\d+\/$/.test(page),
    }),
  ],

  vite: {
    plugins: [tailwindcss()],
  },
});
