// Derives site/public/og-default.png — the 1200x630 card every page falls back
// to for og:image / twitter:image — from the designed social cover in design/.
//
//   node scripts/og-image.mjs        (from site/, sharp is already a devDep)
//
// The source is authored at 2400x1256 (ratio 1.911) for LinkedIn. OG consumers
// want the served bytes to match the declared og:image:width/height, so this
// resizes to exactly 1200x630 with `fit: cover` — a ~4px horizontal crop rather
// than a 0.3% distortion — and re-encodes, which also cuts the file by ~5x.
//
// NOTE: /design/ is gitignored (see .gitignore), so the source cover is NOT in
// the repo — only the derived public/og-default.png is committed. On a fresh
// clone this script exits with "missing source" until you restore the cover
// locally. That's intended: the brand source of truth lives outside version
// control, same as /docs/. Re-run after re-exporting the cover.
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));
const site = path.resolve(here, "..");

const WIDTH = 1200;
const HEIGHT = 630;

const source = path.resolve(site, "../design/gitdesktop-social-cover.png");
const out = path.join(site, "public/og-default.png");

if (!existsSync(source)) {
  console.error(`missing source: ${source}`);
  process.exit(1);
}

await sharp(source)
  .resize(WIDTH, HEIGHT, { fit: "cover", position: "centre" })
  .png({ compressionLevel: 9, palette: true })
  .toFile(out);

// metadata() doesn't carry byte size when reading back from disk — stat does.
const { width, height } = await sharp(out).metadata();
const { size } = await stat(out);
console.log(
  `wrote ${path.relative(site, out)} — ${width}x${height}, ${Math.round(size / 1024)}kB`,
);
