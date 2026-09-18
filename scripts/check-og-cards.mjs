// Every blog post's ogImage frontmatter must resolve to a committed card in
// site/public/ (plus the .webp sibling the featured slot serves) — a missing
// file ships as a 404 og:image the build cannot see, because astro copies
// public/ verbatim and the schema keeps ogImage a plain string on purpose.
// The predicates are shared with site/scripts/og-blog.mjs (the derive tool),
// so the local run and this gate can never drift; fixtures live in
// scripts/checks.test.mjs. Node stdlib only — the `guards` job has no
// install step.
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The body between the first pair of `---` fences; "" when there is none
// (a frontmatter-less .md fails the astro build first, but the gate must
// not throw before that story is told).
export function frontmatterOf(mdText) {
  return mdText.split(/^---\s*$/m)[1] ?? "";
}

// Quote-agnostic on BOTH sides of the colon: YAML accepts quoted keys,
// quoted or plain scalars, and space before the colon, and any form the
// regex misses skips the reference check entirely — a scanner's worst
// failure is fail-open.
export function cardRefOf(frontmatter) {
  return frontmatter.match(/^['"]?ogImage['"]?\s*:\s*['"]?([^'"\s]+)/m)?.[1];
}

// Absolute-URL cards are exempt from the on-disk check: nothing local backs
// them, and Head.astro passes them through untouched.
export function isAbsoluteRef(ref) {
  return /^https?:/i.test(ref);
}

// public/-relative paths a site-relative ref obligates: the file itself, and
// for .png cards the .webp sibling the blog index serves while the post
// holds the featured slot (every post's turn, one post at a time).
export function servedRelPathsFor(ref) {
  if (isAbsoluteRef(ref)) return [];
  const rel = ref.replace(/^\//, "");
  // Containment: a `.`/`..` segment (either slash kind — this runs on
  // Windows too) would make the existence check read outside public/ while
  // Head.astro serves a different URL entirely.
  if (rel.split(/[\\/]/).some((seg) => seg === "." || seg === "..")) {
    throw new Error(`ogImage must stay under public/: ${ref}`);
  }
  return rel.endsWith(".png") ? [rel, rel.replace(/\.png$/, ".webp")] : [rel];
}

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const site = resolve(here, "../site");
  const blogDir = join(site, "src/content/blog");
  const publicDir = join(site, "public");
  const ogDir = join(publicDir, "og");

  // Same visibility rule as the content collection's `[^_]*.md` glob.
  const slugs = (await readdir(blogDir))
    .filter((f) => f.endsWith(".md") && !f.startsWith("_"))
    .map((f) => f.replace(/\.md$/, ""));

  // Scan-set floor: an empty corpus means the gate is pointed at the wrong
  // directory, and "OK (0 posts)" would be the silent fail-open above.
  if (slugs.length === 0) {
    console.error(`og-cards: no posts found under ${blogDir}`);
    process.exitCode = 1;
    return;
  }

  let failed = false;
  let checked = 0;

  // ::warning:: renders as a checks-tab annotation; plain text locally.
  const note = process.env.GITHUB_ACTIONS ? "::warning::" : "note: ";

  for (const slug of slugs) {
    const md = await readFile(join(blogDir, `${slug}.md`), "utf8");
    const cardRef = cardRefOf(frontmatterOf(md));

    if (!cardRef) {
      // Committed card + forgotten frontmatter = an empty featured slot the
      // build accepts silently; surface it where CI logs are read.
      if (
        existsSync(join(ogDir, `${slug}.png`)) ||
        existsSync(join(ogDir, `${slug}.webp`))
      ) {
        console.warn(
          `${note}${slug} has a card on disk but no ogImage frontmatter`,
        );
      }
      continue;
    }

    // The containment throw joins the same failure channel as a missing
    // file — a stack trace would also skip the orphan and fallback checks.
    let rels;
    try {
      rels = servedRelPathsFor(cardRef);
    } catch (err) {
      console.error(`og-cards: ${slug}: ${err.message}`);
      failed = true;
      continue;
    }
    for (const rel of rels) {
      checked++;
      if (!existsSync(join(publicDir, rel))) {
        console.error(
          `og-cards: ${slug}: ogImage "${cardRef}" needs public/${rel}, which does not exist`,
        );
        failed = true;
      }
    }
  }

  // Renamed or deleted posts leave ~200KB card pairs behind with nothing
  // else pointing at them.
  const slugSet = new Set(slugs);
  if (existsSync(ogDir)) {
    for (const f of await readdir(ogDir)) {
      if (!slugSet.has(basename(f).replace(/\.(png|webp)$/, ""))) {
        console.warn(`${note}public/og/${f} matches no post — orphaned card?`);
      }
    }
  }

  // Every non-post page falls back to this card (Head.astro's default), so
  // its absence is a sitewide 404 no per-post walk would notice.
  checked++;
  if (!existsSync(join(publicDir, "og-default.png"))) {
    console.error(
      "og-cards: public/og-default.png is missing — every page's fallback card 404s",
    );
    failed = true;
  }

  if (!failed) {
    process.stdout.write(
      `og-cards: OK (${slugs.length} post(s), ${checked} card file(s))\n`,
    );
  }
  // Not `process.exit`: it can truncate a pending pipe write, losing the very
  // finding the failure is about on a CI runner.
  process.exitCode = failed ? 1 : 0;
}

// Main-module detection by PATH comparison, not `import.meta.main`: that form
// only exists from node 24.2 and fails SILENTLY on older runtimes (the gate
// reads `if (undefined)` and exits 0 having checked nothing).
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
