// Pins, by source shape, how docked comment boxes and bars publish their toast
// clearance:
// - every `<CommentComposer` mount in src/ is listed in MOUNTS, and the docked
//   ones pass `toastClearance`, so the composer measures its OWN root. A
//   call-site wrapper would make the composer an only child and break its
//   scroll-pin lookup, so no host aims useToastClearance at a composer ref;
// - the composer's scroll-pin lookup walks its preceding siblings nearest-first
//   (a docked strip can sit between it and the conversation);
// - useToastClearance re-measures when a sibling after the bar resizes or the
//   parent's children change, and drops a bar that has no box.
//
// Not testable here: the live layout (where toasts land, whether the latest
// comment stays in view). The shape pins cover the wiring's text only. The
// checker is a pure function over source text, fed the real files (must pass)
// and in-memory mutants (must fail). It fails closed: a file or symbol it can't
// find is a problem, never a skip.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { maskNonCode, sourceFiles, tagEnd } from "./lib/ts-mask.mjs";

/** Each file's `<CommentComposer` mounts in source order: whether it passes
 *  `toastClearance`. */
const MOUNTS = {
  "features/discussions/DiscussionView.tsx": [true],
  "features/issues/JiraIssueView.tsx": [true],
  "features/issues/LocalIssueView.tsx": [true],
  // Deferred: the remote issue view's bottom bar is tracked separately.
  "features/issues/RemoteIssueView.tsx": [false],
  "features/pulls/CommitComments.tsx": [true],
  "features/pulls/LocalPrView.tsx": [true],
  // The loading frame's disabled placeholder box, then the conversation's.
  "features/pulls/RemotePrView.tsx": [false, true],
};

const COMPOSER = "features/conversations/CommentComposer.tsx";
const HOOK = "lib/use-toast-clearance.ts";

const SELF_CLEARANCE =
  /\buseToastClearance\(\s*rootRef,\s*toastClearance === true\s*\)/;
const SIBLING_WALK =
  /for\s*\(\s*let (\w+) = rootRef\.current\?\.previousElementSibling \?\? null;[^;]*;\s*\1 = \1\.previousElementSibling\s*\)\s*region = findScrollRegion\(\1\)/;
const NEXT_SIBLINGS =
  /for\s*\(\s*let (\w+) = bar\.nextElementSibling;\s*\1;\s*\1 = \1\.nextElementSibling\s*\)\s*(\w+)\.observe\(\1\)/;
const CHILD_LIST =
  /const (\w+) = new MutationObserver\([\s\S]*?\1\.observe\(parent, \{ childList: true \}\)/;
const NO_BOX =
  /getClientRects\(\)\.length === 0\)\s*\{\s*clearToastClearance\(id\);\s*return;/;

/** The `<CommentComposer` opening tags in masked `.tsx` text, each with its
 *  depth-0 attribute text (brace-held values blanked). */
function composerTags(masked) {
  const tags = [];
  for (const m of masked.matchAll(/<CommentComposer\b/g)) {
    const end = tagEnd(masked, m.index);
    if (end < 0) {
      tags.push(null);
      continue;
    }
    let depth = 0;
    let attrs = "";
    for (const c of masked.slice(m.index, end)) {
      if (c === "{") depth++;
      attrs += depth === 0 ? c : " ";
      if (c === "}") depth--;
    }
    tags.push(attrs);
  }
  return tags;
}

/** Problems found in `sources` (src-relative path → text: every .ts/.tsx file
 *  under src/); empty means the wiring holds. */
function checkToastClearanceAdopters(sources) {
  const problems = [];
  const masked = {};
  for (const [file, text] of Object.entries(sources)) {
    if (typeof text !== "string") {
      problems.push(`${file}: unreadable source`);
      continue;
    }
    try {
      masked[file] = maskNonCode(
        text.replace(/\r\n/g, "\n"),
        file.endsWith("x"),
      );
    } catch (err) {
      problems.push(`${file}: could not scan (${err.message})`);
    }
  }
  for (const file of [...Object.keys(MOUNTS), COMPOSER, HOOK])
    if (!(file in masked)) problems.push(`${file}: missing from the corpus`);

  for (const [file, code] of Object.entries(masked)) {
    if (file === COMPOSER) continue;
    const tags = composerTags(code);
    if (tags.length === 0) continue;
    const expected = MOUNTS[file];
    if (!expected) {
      problems.push(`${file}: mounts CommentComposer but is not in MOUNTS`);
      continue;
    }
    if (tags.length !== expected.length) {
      problems.push(
        `${file}: ${tags.length} CommentComposer mounts, MOUNTS lists ${expected.length}`,
      );
      continue;
    }
    tags.forEach((attrs, i) => {
      if (attrs === null) {
        problems.push(`${file}: CommentComposer mount ${i + 1} has no tag end`);
        return;
      }
      const passes = /\stoastClearance(?=[\s=/>]|$)/.test(attrs);
      if (passes !== expected[i])
        problems.push(
          `${file}: CommentComposer mount ${i + 1} ${expected[i] ? "does not pass" : "passes"} toastClearance`,
        );
    });
    for (const m of code.matchAll(/\buseToastClearance\(\s*(\w+)/g))
      if (/composer/i.test(m[1]))
        problems.push(
          `${file}: useToastClearance targets ${m[1]}; pass toastClearance to the composer instead`,
        );
  }
  for (const file of Object.keys(MOUNTS))
    if (file in masked && composerTags(masked[file]).length === 0)
      problems.push(`${file}: no CommentComposer mount found`);

  const composer = masked[COMPOSER];
  if (composer !== undefined) {
    if (!SELF_CLEARANCE.test(composer))
      problems.push(`${COMPOSER}: does not publish its own root's clearance`);
    const at = composer.indexOf("function measurePinRegion(");
    const end = at < 0 ? -1 : composer.indexOf("\n  }\n", at);
    if (at < 0 || end < 0)
      problems.push(`${COMPOSER}: measurePinRegion not found`);
    else if (!SIBLING_WALK.test(composer.slice(at, end)))
      problems.push(
        `${COMPOSER}: measurePinRegion does not walk the preceding siblings`,
      );
  }

  const hook = masked[HOOK];
  if (hook !== undefined) {
    if (!NEXT_SIBLINGS.test(hook))
      problems.push(`${HOOK}: does not observe the siblings after the bar`);
    const children = CHILD_LIST.exec(hook);
    if (!children)
      problems.push(`${HOOK}: does not watch the parent's child list`);
    else if (!hook.includes(`${children[1]}.disconnect()`))
      problems.push(`${HOOK}: never disconnects the child-list observer`);
    if (/subtree/.test(hook))
      problems.push(`${HOOK}: watches a subtree, not just the child list`);
    if (!NO_BOX.test(hook))
      problems.push(`${HOOK}: does not drop a bar that has no box`);
  }
  return problems;
}

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

function realSources() {
  const sources = {};
  for (const full of sourceFiles(SRC))
    sources[relative(SRC, full).replaceAll("\\", "/")] = readFileSync(
      full,
      "utf8",
    ).replace(/\r\n/g, "\n");
  return sources;
}

/** `sources` with `file`'s text passed through `edit`, asserting it changed. */
function mutate(sources, file, edit) {
  const next = edit(sources[file]);
  assert.notEqual(next, sources[file], `mutant of ${file} changed nothing`);
  return { ...sources, [file]: next };
}

const fails = (sources, ...parts) => {
  const problems = checkToastClearanceAdopters(sources);
  assert.ok(
    problems.some((p) => parts.every((part) => p.includes(part))),
    JSON.stringify(problems),
  );
};

test("the real sources hold the clearance wiring", () => {
  assert.deepEqual(checkToastClearanceAdopters(realSources()), []);
});

test("a docked mount that drops toastClearance fails the check", () => {
  for (const [file, flags] of Object.entries(MOUNTS)) {
    if (!flags.includes(true)) continue;
    fails(
      mutate(realSources(), file, (text) =>
        text.replace(/(<CommentComposer\s+)toastClearance\s+/, "$1"),
      ),
      file,
      "does not pass",
    );
  }
});

test("an exempt mount that passes toastClearance fails the check", () => {
  fails(
    mutate(realSources(), "features/pulls/RemotePrView.tsx", (text) =>
      text.replace("<CommentComposer\n", "<CommentComposer\n toastClearance\n"),
    ),
    "RemotePrView.tsx",
    "mount 1 passes",
  );
});

test("a new unlisted mount fails the check", () => {
  fails(
    mutate(
      realSources(),
      "features/pulls/PrCommitDetail.tsx",
      (text) =>
        `${text}\nexport const X = () => <CommentComposer value="" onChange={() => {}} onSubmit={() => {}} submitLabel="" ariaLabel="" placeholder="" />;\n`,
    ),
    "PrCommitDetail.tsx",
    "not in MOUNTS",
  );
});

test("a host aiming useToastClearance at a composer wrapper fails the check", () => {
  fails(
    mutate(realSources(), "features/issues/LocalIssueView.tsx", (text) =>
      text.replace(
        "useToastClearance(actionBarRef, issue !== undefined);",
        "useToastClearance(actionBarRef, issue !== undefined);\n  useToastClearance(composerBarRef, true);",
      ),
    ),
    "LocalIssueView.tsx",
    "composerBarRef",
  );
});

test("the composer must publish its own root's clearance", () => {
  fails(
    mutate(realSources(), COMPOSER, (text) =>
      text.replace(
        "useToastClearance(rootRef, toastClearance === true)",
        "useToastClearance(rootRef, false)",
      ),
    ),
    "own root",
  );
});

test("a pin lookup reading only the previous sibling fails the check", () => {
  fails(
    mutate(realSources(), COMPOSER, (text) =>
      text.replace(
        /let region: HTMLElement \| null = null;\n\s*for \([\s\S]*?region = findScrollRegion\(sibling\);/,
        "const region = findScrollRegion(\n      rootRef.current?.previousElementSibling ?? null,\n    );",
      ),
    ),
    "preceding siblings",
  );
});

test("the hook must observe the siblings after the bar", () => {
  fails(
    mutate(realSources(), HOOK, (text) =>
      text.replace(
        /\n\s*for \(let el = bar\.nextElementSibling;[^\n]*\n[^\n]*resizes\.observe\(el\);/,
        "",
      ),
    ),
    "siblings after the bar",
  );
});

test("the hook must watch the parent's child list, and disconnect it", () => {
  fails(
    mutate(realSources(), HOOK, (text) =>
      text.replace(
        "children.observe(parent, { childList: true });",
        "void children;",
      ),
    ),
    "child list",
  );
  fails(
    mutate(realSources(), HOOK, (text) =>
      text.replace("children.disconnect();", ""),
    ),
    "never disconnects",
  );
  fails(
    mutate(realSources(), HOOK, (text) =>
      text.replace("{ childList: true }", "{ childList: true, subtree: true }"),
    ),
    "subtree",
  );
});

test("the hook must drop a bar that has no box", () => {
  fails(
    mutate(realSources(), HOOK, (text) =>
      text.replace(
        "getClientRects().length === 0",
        "getClientRects().length < 0",
      ),
    ),
    "no box",
  );
});

test("an empty corpus or a missing composer fails closed", () => {
  assert.notDeepEqual(checkToastClearanceAdopters({}), []);
  const { [COMPOSER]: _c, ...noComposer } = realSources();
  assert.ok(
    checkToastClearanceAdopters(noComposer).some((p) =>
      p.includes(`${COMPOSER}: missing`),
    ),
  );
});
