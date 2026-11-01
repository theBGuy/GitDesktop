// Pins that every (element, attribute) pair the markdown sanitize hook strips
// relative URLs from (RELATIVE_URL_ATTRS in src/components/markdown/
// markdown-images.ts) survives DOMPurify's DEFAULT allowlists, read from the
// installed dompurify build's frozen tag and attribute lists. A pair outside them
// would mean the table names something DOMPurify already removes, or that a
// DOMPurify bump renamed a list this pin reads.
//
// Static imports are stdlib plus the import-free markdown-images.ts, so the
// installless `guards` job can load this file: dompurify is resolved at load and
// the suite skips only when that PACKAGE is unresolved; GD_EXPECT_DEPS turns
// that skip into a failure on frontend.yml's installed, enforced run.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { RELATIVE_URL_ATTRS } from "../src/components/markdown/markdown-images.ts";

const DEP_PACKAGES = /Cannot find package '(dompurify)'/;

let purifySource;
let skip = false;
try {
  purifySource = readFileSync(
    new URL(import.meta.resolve("dompurify")),
    "utf8",
  );
} catch (reason) {
  if (
    process.env.GD_EXPECT_DEPS ||
    reason?.code !== "ERR_MODULE_NOT_FOUND" ||
    !DEP_PACKAGES.test(String(reason?.message))
  )
    throw reason;
  skip =
    "dompurify is not installed — the guards job runs with no install " +
    "step; frontend.yml's installed run enforces this";
}

/** DOMPurify's default allowlists, read from its build: the frozen lists its
 *  DEFAULT_ALLOWED_TAGS and DEFAULT_ALLOWED_ATTR spread. */
function purifyDefaults(src) {
  const lists = new Map();
  for (const m of src.matchAll(/const (\w+\$?\d*) = freeze\(\[([^\]]*)\]\);/g))
    lists.set(
      m[1],
      [...m[2].matchAll(/"([^"]+)"/g)].map((x) => x[1].toLowerCase()),
    );
  const union = (names) =>
    new Set(
      names.flatMap((n) => {
        assert.ok(lists.has(n), `DOMPurify list ${n}`);
        return lists.get(n);
      }),
    );
  return {
    tags: union(["html$1", "svg$1", "svgFilters", "mathMl$1"]),
    attrs: union(["html", "svg", "mathMl", "xml"]),
  };
}

test("every neutralized pair survives DOMPurify's default allowlists", {
  skip,
}, () => {
  const { tags, attrs } = purifyDefaults(purifySource);
  for (const [tag, names] of RELATIVE_URL_ATTRS) {
    if (tag !== "*") assert.ok(tags.has(tag), tag);
    for (const attr of names) assert.ok(attrs.has(attr), `${tag} ${attr}`);
  }
  // Negative control: a disallowed SVG element isn't in the union.
  assert.equal(tags.has("use"), false);
});
