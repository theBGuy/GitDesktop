// Pins how `budgetDiff` splits a diff into sections: only a real LF opens a
// section, so a lockfile whose content smuggles a CR-preceded `diff --git` decoy
// is still omitted whole instead of leaking its tail as a separate file.
//
// `truncate.ts` imports `@/lib/git/diff-split` through the `@/` alias, which
// Node's type stripping cannot resolve, so the shared src hooks go in first and
// the import is dynamic (a static one links before the hooks exist).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { installSrcHooks } from "./lib/src-import-hooks.mjs";

const hooks = installSrcHooks();
after(() => hooks.deregister());

const { budgetDiff } = await import("@/lib/ai/truncate");

test("a lockfile section with a CR decoy header is omitted whole", () => {
  const lockfile =
    "diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml\n" +
    "--- a/pnpm-lock.yaml\n" +
    "+++ b/pnpm-lock.yaml\n" +
    "@@ -1 +1,2 @@\n-a\n" +
    "+b\rdiff --git a/decoy.txt b/decoy.txt\n+lock-tail\n";
  const ordinary =
    "diff --git a/src/ordinary.txt b/src/ordinary.txt\n" +
    "--- a/src/ordinary.txt\n" +
    "+++ b/src/ordinary.txt\n" +
    "@@ -1 +1 @@\n-old\n+new\n";
  const diff = lockfile + ordinary;
  const result = budgetDiff(diff, diff.length - 1);
  assert.equal(result.text, ordinary);
  assert.deepEqual(result.omittedFiles, ["pnpm-lock.yaml"]);
});
