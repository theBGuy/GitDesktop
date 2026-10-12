// Pins the palette-style pickers to the top-anchored dialog: both call sites
// take the one shared class constant, and that constant, merged over the
// vendored DialogContent base the way `cn` merges it, drops the centring
// (`top-1/2`, `-translate-y-1/2`) while keeping the horizontal centring. A
// centred palette moves its input by half of every height change as results
// filter.
//
// The import reaches straight into `src/` under Node's type stripping, so
// `palette-dialog.ts` must stay free of runtime and aliased imports.
// tailwind-merge is imported dynamically so the installless guards job still
// runs the other tests and skips only the merge test; frontend.yml's installed
// step sets GD_EXPECT_DEPS, which turns a missing package there into a failure.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { PALETTE_DIALOG_CLASS } from "../src/features/shortcuts/palette-dialog.ts";

let twMerge = null;
let skip = false;
try {
  ({ twMerge } = await import("tailwind-merge"));
} catch (err) {
  if (process.env.GD_EXPECT_DEPS || err?.code !== "ERR_MODULE_NOT_FOUND")
    throw err;
  skip =
    "needs node_modules — frontend.yml's installed step is the enforced run";
}

const read = (rel) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

const CALL_SITES = [
  "src/features/shortcuts/CommandPalette.tsx",
  "src/features/scripts/RunTaskPicker.tsx",
];

const tokens = (cls) => cls.split(/\s+/).filter(Boolean);

test("the constant carries the pinning classes", () => {
  const t = tokens(PALETTE_DIALOG_CLASS);
  for (const need of ["translate-y-0", "origin-top", "flex", "flex-col"]) {
    assert.ok(t.includes(need), `missing ${need}`);
  }
  assert.ok(
    t.some((c) => /^top-\[/.test(c)),
    "missing a fixed top inset (top-[…])",
  );
  assert.ok(
    t.some((c) => /^max-h-\[calc\(100dvh-/.test(c)),
    "missing the viewport cap (max-h-[calc(100dvh-…)])",
  );
});

test("merged over the vendored base, the centring on y is gone", {
  skip,
}, () => {
  // The base is the first string literal inside DialogContent's `cn(` call.
  const dialog = read("src/components/ui/dialog.tsx");
  const m = dialog.match(
    /data-slot="dialog-content"[\s\S]*?className=\{cn\(\s*"([^"]+)"/,
  );
  assert.ok(m, "could not find DialogContent's base classes in dialog.tsx");
  const base = m[1];
  assert.ok(
    tokens(base).includes("top-1/2"),
    "base no longer centres; re-check",
  );
  const merged = tokens(twMerge(base, PALETTE_DIALOG_CLASS));
  assert.ok(!merged.includes("top-1/2"), "top-1/2 survived the merge");
  assert.ok(
    !merged.includes("-translate-y-1/2"),
    "-translate-y-1/2 survived the merge",
  );
  assert.ok(merged.includes("-translate-x-1/2"), "lost horizontal centring");
  assert.ok(!merged.includes("grid"), "the grid display survived the merge");
});

for (const file of CALL_SITES) {
  test(`${file} uses the shared constant with a shrinking list`, () => {
    const src = read(file);
    const contents = src.match(/<DialogContent\b[^>]*>/g) ?? [];
    assert.equal(contents.length, 1, "expected exactly one DialogContent");
    assert.match(
      contents[0],
      /className=\{PALETTE_DIALOG_CLASS\}/,
      "DialogContent must take PALETTE_DIALOG_CLASS",
    );
    assert.match(
      src,
      /import \{ PALETTE_DIALOG_CLASS \} from "[^"]*palette-dialog"/,
    );
    const list = src.match(/<ul\b[^>]*className="([^"]*)"/);
    assert.ok(list, "result list not found");
    assert.ok(
      tokens(list[1]).includes("min-h-0"),
      "the result list must be the member that shrinks (min-h-0)",
    );
  });
}
