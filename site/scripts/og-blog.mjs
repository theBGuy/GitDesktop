// Derives site/public/og/<slug>.png — the 1200x630 per-post og:image /
// twitter:image card — plus a .webp sibling the blog index's featured slot
// serves inline, from each post's designed social cover in design/.
//
//   node scripts/og-blog.mjs        (from site/; sharp is already a devDep.
//   The script is cwd-independent — every path anchors on import.meta.url.)
//
// Sources are authored at 2400x1256 (ratio 1.911) for LinkedIn, at
// design/linkedin/<slug>/cover.png. OG consumers want the served bytes to
// match the declared og:image:width/height, so this resizes to exactly
// 1200x630 with `fit: cover` — a ~4px horizontal crop rather than a 0.3%
// distortion — and palette-encodes the PNG (~2x smaller than non-palette,
// measured on this cover set in PR #371). Scrapers cache the PNG by URL;
// the page serves the smaller webp.
//
// /design/ is gitignored, so on a fresh clone sources are absent by design:
// derived cards already committed are left alone. The run FAILS only when a
// post's frontmatter references a site-relative card that is not on disk
// after deriving — that reference would ship as a 404. Absolute-URL ogImage
// values are exempt: nothing local backs them.
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));
const site = path.resolve(here, "..");

const WIDTH = 1200;
const HEIGHT = 630;

const blogDir = path.join(site, "src/content/blog");
const designDir = path.resolve(site, "../design/linkedin");
const outDir = path.join(site, "public/og");

await mkdir(outDir, { recursive: true });

// Same visibility rule as the content collection's `[^_]*.md` glob.
const slugs = (await readdir(blogDir))
  .filter((f) => f.endsWith(".md") && !f.startsWith("_"))
  .map((f) => f.replace(/\.md$/, ""));

let derived = 0;
let kept = 0;
const failures = [];

for (const slug of slugs) {
  const source = path.join(designDir, slug, "cover.png");
  const outPng = path.join(outDir, `${slug}.png`);
  const frontmatter =
    (await readFile(path.join(blogDir, `${slug}.md`), "utf8")).split(
      /^---\s*$/m,
    )[1] ?? "";
  // Quote-agnostic on purpose: a plain or single-quoted YAML scalar must not
  // slip past the reference check (a scanner's worst failure is fail-open).
  const cardRef = frontmatter.match(/^ogImage:\s*['"]?([^'"\s]+)/m)?.[1];

  if (existsSync(source)) {
    const resized = sharp(source).resize(WIDTH, HEIGHT, {
      fit: "cover",
      position: "centre",
    });
    await resized
      .clone()
      .png({ compressionLevel: 9, palette: true })
      .toFile(outPng);
    await resized
      .clone()
      .webp({ quality: 82 })
      .toFile(path.join(outDir, `${slug}.webp`));
    derived++;
    if (!cardRef)
      console.warn(`note: ${slug} has a cover but no ogImage frontmatter`);
  } else if (existsSync(outPng)) {
    kept++;
  }

  // The reference check runs on the frontmatter VALUE, not the slug: a
  // typo'd path 404s even when <slug>.png derived fine.
  if (cardRef && !/^https?:/i.test(cardRef)) {
    const served = path.join(site, "public", cardRef.replace(/^\//, ""));
    if (!existsSync(served)) {
      failures.push(`${slug}: ogImage "${cardRef}" has no file under public/`);
    } else if (
      served.endsWith(".png") &&
      !existsSync(served.replace(/\.png$/, ".webp"))
    ) {
      failures.push(
        `${slug}: "${cardRef}" is missing the .webp sibling the featured slot serves`,
      );
    }
  }
}

console.log(
  `og cards: ${derived} derived (png+webp), ${kept} kept (source absent)`,
);
if (failures.length > 0) {
  for (const f of failures) console.error(`error: ${f}`);
  process.exit(1);
}
