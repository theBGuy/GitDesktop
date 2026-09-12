#!/usr/bin/env node
// Astro 7 defaults `compressHTML` to "jsx", which strips whitespace BETWEEN
// inline elements; site/astro.config.mjs pins it to true and a regression there
// still builds clean, so the built output is the only place the pin is
// observable. The footer link row is the assertion target because it is the one
// adjacent-anchor pair every page emits — the header nav renders its row from a
// `.map()` and emits no gap at all.
//
// Unlike the four sibling guards this one needs a BUILT site/dist, so it is
// invoked from .github/workflows/site.yml after the site build and is
// deliberately absent from package.json's `checks` alias and quality.yml's
// installless `guards` job. Its fixtures still run there via
// scripts/checks.test.mjs — the predicate is exported for exactly that reason,
// since a scanner's worst failure is a silent fail-open.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// `<a[\s>]` and not `<a`: the unbounded form also matches <aside>, <article>
// and <abbr>, so a page could satisfy the gate on a block-level boundary while
// every real anchor pair had lost its whitespace.
export const INLINE_GAP = /<\/a>\s+<a[\s>]/;

/**
 * The footer element's markup, or null when the page has no footer. Matched as
 * `<footer(?=\s|>)` and not `<footer`: the bare form also starts inside a custom
 * element like <footer-links>, so a gapped pair there could satisfy the gate
 * while the real footer stayed compressed.
 */
export function footerOf(html) {
  const m = html.match(/<footer(?=\s|>)[\s\S]*?<\/footer\s*>/i);
  return m ? m[0] : null;
}

/**
 * Whether the page's footer still separates adjacent anchors with whitespace;
 * false when the page has no footer (fail-closed).
 */
export function hasInlineGap(html) {
  const footer = footerOf(html);
  return footer === null ? false : INLINE_GAP.test(footer);
}

function main() {
  const pages = process.argv.slice(2);
  if (pages.length === 0) {
    process.stderr.write("usage: check-built-whitespace.mjs <page.html>...\n");
    process.exitCode = 1;
    return;
  }

  let failed = false;
  const annotate = (file, message) => {
    process.stdout.write(`::error file=${file}::${message}\n`);
    failed = true;
  };

  for (const page of pages) {
    let html;
    try {
      html = readFileSync(page, "utf8");
    } catch (err) {
      // The code is carried because EISDIR/EACCES are not stale-page-list bugs
      // and the fix instruction below would send the reader the wrong way.
      annotate(
        ".github/workflows/site.yml",
        `Could not read guard target ${page} (${err.code ?? err.message}) -- if it no longer exists, update the page list in this step.`,
      );
      continue;
    }
    if (footerOf(html) === null) {
      annotate(
        ".github/workflows/site.yml",
        `No <footer> found in ${page} -- point this step at a page that renders SiteLayout's footer, or restore the footer.`,
      );
      continue;
    }
    if (!hasInlineGap(html)) {
      annotate(
        "site/astro.config.mjs",
        `Whitespace between inline elements was stripped from ${page} -- check compressHTML, then whether the footer link row still emits adjacent anchors.`,
      );
    }
  }

  if (!failed) {
    process.stdout.write(`built-whitespace: OK (${pages.length} page(s))\n`);
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
  main();
}
