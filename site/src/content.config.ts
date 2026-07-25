import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
// NOT `import { z } from "astro:content"` — that re-export is gone. Verified
// against the installed astro@6.4.7, whose package exports map "./zod".
import { z } from "astro/zod";

const PILLARS = [
  "multi-forge", // GitHub + GitLab + Bitbucket + Jira, each on its own identity
  "ai-you-own", // BYO model, local Ollama, keyless CLI agents, or none at all
  "review-loop", // the whole PR / review / CI loop without a browser
  "git-safety", // merge preview, recovery, force-with-lease — the trust surface
  "built-open", // Tauri 2 + React 19 + Rust, in public
] as const;

const blog = defineCollection({
  // `[^_]*.md` keeps `_drafts/` and `_scratch.md` out of the build entirely —
  // the underscore convention costs nothing and beats a runtime filter.
  loader: glob({ base: "./src/content/blog", pattern: "[^_]*.md" }),

  // Function form is REQUIRED to get `image()` from the schema context.
  schema: ({ image }) =>
    z
      .object({
        // Bounded so a post can't silently ship a title that SERPs truncate.
        title: z.string().max(70),
        // Doubles as <meta description> and the RSS item description.
        description: z.string().min(50).max(160),
        pubDate: z.coerce.date(),
        updatedDate: z.coerce.date().optional(),
        author: z.string().default("theBGuy"),
        // Required on purpose: a post that fits no pillar is a post that
        // shouldn't ship. The build refuses it.
        pillar: z.enum(PILLARS),
        tags: z.array(z.string()).default([]),
        heroImage: image().optional(),
        heroAlt: z.string().optional(),
        // Site-relative path to a 1200x630 card, e.g. "/og/my-post.png".
        // A plain string, not image(): OG scrapers cache by URL and gain
        // nothing from a content-hashed, format-optimized asset.
        ogImage: z.string().optional(),
        draft: z.boolean().default(false),
        // Gates the post's CARD in the index under "Just Git" — never its body.
        ai: z.boolean().default(false),
        // Syndicated reposts only (dev.to etc. point home; this points away).
        canonical: z.string().url().optional(),
      })
      // image().refine() isn't supported, so the alt-text pairing is enforced
      // at the object level instead.
      .refine((d) => !d.heroImage || !!d.heroAlt, {
        message: "heroImage requires heroAlt (WCAG AA)",
        path: ["heroAlt"],
      }),
});

export const collections = { blog };
