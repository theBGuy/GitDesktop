// Derives site/public/og/<slug>.png — the 1200x630 per-post og:image /
// twitter:image card — from each post's designed social cover in design/.
//
//   node scripts/og-blog.mjs        (from site/, sharp is already a devDep)
//
// Sources are authored at 2400x1256 (ratio 1.911) for LinkedIn, at
// design/linkedin/<slug>/cover.png. OG consumers want the served bytes to
// match the declared og:image:width/height, so this resizes to exactly
// 1200x630 with `fit: cover` — a ~4px horizontal crop rather than a 0.3%
// distortion — and palette-encodes, which also cuts the file by ~5x.
//
// /design/ is gitignored, so on a fresh clone sources are absent by design:
// a post whose derived card is already committed is left alone. The run only
// FAILS when a post's frontmatter references an /og/ card that neither exists
// nor can be derived — that card would ship as a 404.
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
  const out = path.join(outDir, `${slug}.png`);
  const frontmatter = (
    await readFile(path.join(blogDir, `${slug}.md`), "utf8")
  ).split(/^---\s*$/m)[1];
  const wantsCard = /^ogImage:/m.test(frontmatter);

  if (existsSync(source)) {
    await sharp(source)
      .resize(WIDTH, HEIGHT, { fit: "cover", position: "centre" })
      .png({ compressionLevel: 9, palette: true })
      .toFile(out);
    derived++;
    if (!wantsCard)
      console.warn(`note: ${slug} has a cover but no ogImage frontmatter`);
  } else if (existsSync(out)) {
    kept++;
  } else if (wantsCard) {
    failures.push(
      `${slug}: frontmatter references /og/${slug}.png but no card exists and no source to derive it`,
    );
  }
}

console.log(`og cards: ${derived} derived, ${kept} kept (source absent)`);
if (failures.length > 0) {
  for (const f of failures) console.error(`error: ${f}`);
  process.exit(1);
}
