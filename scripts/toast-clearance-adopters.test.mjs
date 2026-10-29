// Pins, by source shape, how docked comment boxes and bars publish their toast
// clearance:
// - every `<CommentComposer` mount in src/ is listed in MOUNTS, and the docked
//   ones pass `toastClearance`, so the composer measures its OWN root. A
//   call-site wrapper would make the composer an only child and break its
//   scroll-pin lookup, so no host aims useToastClearance at a composer ref;
// - a bar standing in for the composer (STAND_IN_BARS) publishes under its
//   full mount condition;
// - the composer's scroll-pin lookup walks its preceding siblings nearest-first
//   (a docked strip can sit between it and the conversation);
// - useToastClearance re-measures when a sibling after the bar resizes, the
//   parent's children change, or the bar moves in the viewport (a re-armed
//   IntersectionObserver), and drops a bar that has no box.
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

import { escapeRe, maskNonCode, sourceFiles, tagEnd } from "./lib/ts-mask.mjs";

/** Each file's `<CommentComposer` mounts in source order: whether it passes
 *  `toastClearance`. */
const MOUNTS = {
  "features/discussions/DiscussionView.tsx": [true],
  "features/issues/JiraIssueView.tsx": [true],
  "features/issues/LocalIssueView.tsx": [true],
  "features/issues/RemoteIssueView.tsx": [true],
  "features/pulls/CommitComments.tsx": [true],
  "features/pulls/LocalPrView.tsx": [true],
  // The loading frame's disabled placeholder box, then the conversation's.
  "features/pulls/RemotePrView.tsx": [false, true],
};

const COMPOSER = "features/conversations/CommentComposer.tsx";
const HOOK = "lib/use-toast-clearance.ts";

/** Bottom bars that stand in for a docked composer: the bar element carries
 *  `ref`, and the hook's `active` is the bar's full mount condition (compared
 *  with whitespace collapsed). */
const STAND_IN_BARS = [
  {
    file: "features/issues/RemoteIssueView.tsx",
    ref: "stateBarRef",
    active: 'arm === "content" && !canComment && canChangeState',
  },
];

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
// The move watch: a stopper that clears the clipped-retry timer and
// disconnects the observer; a measure that runs it FIRST and arms the watch
// only after a boxed publish; a watch derived from moveWatchOptions and
// observing the bar; the callback's rect-drift re-measure and its
// first-delivery arms (timer at ratio 0, re-arm at a partial ratio).
const MOVE_STOP =
  /const (\w+) = \(\) => \{\s*clearTimeout\((\w+)\);\s*(\w+)\?\.disconnect\(\);\s*\3 = null;\s*\};/;
const MOVE_IMPORT = /import \{[^}]*\bmoveWatchOptions\b[^}]*\} from/;
const MOVE_ARM =
  /const (\w+) = \((\w+): DOMRect, (\w+): number\) => \{\s*const (\w+) = moveWatchOptions\(\{[\s\S]*?\b\3,?\s*\}\);\s*if \(!\4\) return;\s*let (\w+) = true;\s*const (\w+) = new IntersectionObserver\(\((\w+)\) => \{([\s\S]*?)\}, \4\);\s*(\w+) = \6;/;
const RECT_DRIFT =
  /const (\w+) = bar\.getBoundingClientRect\(\);\s*if \(\s*\1\.x !== (\w+)\.x \|\|\s*\1\.y !== \2\.y \|\|\s*\1\.width !== \2\.width \|\|\s*\1\.height !== \2\.height\s*\)\s*return (\w+)\(\);/;

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

const maskCache = new Map();

/** `maskNonCode` memoized per path AND exact text, so a mutant re-masks only
 *  the file it changed and never reads another text's mask. A throw is not
 *  cached: it re-throws on every call. */
function maskOnce(file, text) {
  let byText = maskCache.get(file);
  if (!byText) {
    byText = new Map();
    maskCache.set(file, byText);
  }
  let masked = byText.get(text);
  if (masked === undefined) {
    masked = maskNonCode(text, file.endsWith("x"));
    byText.set(text, masked);
  }
  return masked;
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
      masked[file] = maskOnce(file, text.replace(/\r\n/g, "\n"));
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

  for (const { file, ref, active } of STAND_IN_BARS) {
    if (!(file in masked)) continue;
    const call = new RegExp(
      `\\buseToastClearance\\(\\s*${ref},\\s*${escapeRe(active)},?\\s*\\)`,
    );
    if (!call.test(sources[file].replace(/\s+/g, " ")))
      problems.push(
        `${file}: ${ref}'s clearance is not gated on \`${active}\``,
      );
    if (!masked[file].includes(`ref={${ref}}`))
      problems.push(`${file}: no element carries ${ref}`);
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
    problems.push(...checkMoveWatch(hook));
  }
  return problems;
}

/** Problems with the hook's move watch, in masked hook text. */
function checkMoveWatch(hook) {
  const stop = MOVE_STOP.exec(hook);
  if (!stop)
    return [
      `${HOOK}: no move-watch stopper that clears its timer and disconnects its observer`,
    ];
  const [, stopFn, timer, observer] = stop;
  const problems = [];
  if (!MOVE_IMPORT.test(hook))
    problems.push(`${HOOK}: does not import moveWatchOptions`);
  const arm = MOVE_ARM.exec(hook);
  if (!arm)
    return [
      ...problems,
      `${HOOK}: does not arm a move observer derived from moveWatchOptions`,
    ];
  const [, armFn, , , options, first, io, entries, body, assigned] = arm;
  if (assigned !== observer)
    problems.push(
      `${HOOK}: the move observer is not the one the stopper disconnects`,
    );
  if (
    !new RegExp(`${assigned} = ${io};\\s*${io}\\.observe\\(bar\\);`).test(hook)
  )
    problems.push(`${HOOK}: the move observer never observes the bar`);
  if (!new RegExp(`^\\s*if \\(${observer} !== ${io}\\) return;`).test(body))
    problems.push(
      `${HOOK}: the move observer does not ignore a callback after it was replaced`,
    );
  const measureAt = new RegExp(
    `const (\\w+) = \\((\\w+): number\\) => \\{[\\s\\S]*?publishToastClearance\\([\\s\\S]*?\\);\\s*${armFn}\\(\\w+, \\2\\);\\s*\\};`,
  ).exec(hook);
  if (!measureAt) {
    problems.push(
      `${HOOK}: a measure does not re-arm the move watch after a boxed publish`,
    );
    return problems;
  }
  const measureFn = measureAt[1];
  if (
    !new RegExp(
      `const ${measureFn} = \\(\\w+: number\\) => \\{\\s*${stopFn}\\(\\);\\s*if \\(bar\\.getClientRects\\(\\)\\.length === 0\\)`,
    ).test(hook)
  )
    problems.push(
      `${HOOK}: a measure does not tear the move watch down before anything else`,
    );
  if (!new RegExp(`const measure = \\(\\) => ${measureFn}\\(1\\);`).test(hook))
    problems.push(`${HOOK}: measure does not arm the move watch at full ratio`);
  if (!new RegExp(`return \\(\\) => \\{\\s*${stopFn}\\(\\);`).test(hook))
    problems.push(`${HOOK}: the effect cleanup does not stop the move watch`);
  const drift = RECT_DRIFT.exec(body);
  if (!drift || drift[2] !== arm[2] || drift[3] !== "measure")
    problems.push(
      `${HOOK}: the move observer does not re-measure a bar that moved since its entry`,
    );
  const newest = new RegExp(
    `const (\\w+) = ${entries}\\[${entries}\\.length - 1\\]\\.intersectionRatio;`,
  ).exec(body);
  if (!newest) {
    problems.push(
      `${HOOK}: the move observer does not read its newest entry's ratio`,
    );
    return problems;
  }
  const ratio = newest[1];
  if (
    !new RegExp(
      `if \\(${ratio} !== ${options}\\.threshold\\) \\{\\s*if \\(!${first}\\) return measure\\(\\);`,
    ).test(body)
  )
    problems.push(
      `${HOOK}: the move observer does not re-measure when a later delivery's ratio changes`,
    );
  if (
    !new RegExp(
      `if \\(${ratio} === 0\\)\\s*${timer} = setTimeout\\(\\(\\) => ${measureFn}\\(1e-7\\), 1000\\);\\s*else ${measureFn}\\(${ratio}\\);\\s*\\}\\s*${first} = false;`,
    ).test(body)
  )
    problems.push(
      `${HOOK}: the move observer's first delivery does not retry a clipped bar or re-arm at a partial ratio`,
    );
  return problems;
}

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

let cachedSources;

/** The src/ tree, read once per process; each call gets its own shallow copy,
 *  so a mutant can't leak into another test. */
function realSources() {
  if (!cachedSources) {
    const sources = {};
    for (const full of sourceFiles(SRC))
      sources[relative(SRC, full).replaceAll("\\", "/")] = readFileSync(
        full,
        "utf8",
      ).replace(/\r\n/g, "\n");
    cachedSources = sources;
  }
  return { ...cachedSources };
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

test("a stand-in bar with a narrowed gate or no ref fails the check", () => {
  const file = "features/issues/RemoteIssueView.tsx";
  for (const [from, to] of [
    ['arm === "content" && !canComment && canChangeState', "canChangeState"],
    ['arm === "content" && !canComment && canChangeState', "true"],
    ["!canComment && canChangeState,", "canChangeState,"],
  ])
    fails(
      mutate(realSources(), file, (text) => text.replace(from, to)),
      file,
      "not gated",
    );
  fails(
    mutate(realSources(), file, (text) =>
      text.replace("<div ref={stateBarRef} ", "<div "),
    ),
    file,
    "no element carries",
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

test("the hook must arm a move observer from moveWatchOptions", () => {
  for (const [line, problem] of [
    [
      "      watchMoves(rect, threshold);\n",
      "re-arm the move watch after a boxed publish",
    ],
    ["      io.observe(bar);\n", "never observes the bar"],
  ])
    fails(
      mutate(realSources(), HOOK, (text) => text.replace(line, "")),
      problem,
    );
  // A derivation the hook never calls leaves its unit tests vacuous.
  fails(
    mutate(realSources(), HOOK, (text) =>
      text.replace("moveWatchOptions({", "watchOptions({"),
    ),
    "derived from moveWatchOptions",
  );
  fails(
    mutate(realSources(), HOOK, (text) =>
      text.replace("  moveWatchOptions,\n", ""),
    ),
    "does not import moveWatchOptions",
  );
});

test("the hook must stop the move watch in cleanup", () => {
  fails(
    mutate(realSources(), HOOK, (text) =>
      text.replace(
        "stopWatchingMoves();\n      resizes.disconnect();",
        "resizes.disconnect();",
      ),
    ),
    "cleanup does not stop",
  );
  for (const line of [
    "      clearTimeout(clippedRetry);\n",
    "      moves?.disconnect();\n",
  ])
    fails(
      mutate(realSources(), HOOK, (text) => text.replace(line, "")),
      "no move-watch stopper",
    );
});

test("each measure must tear the move watch down before anything else", () => {
  fails(
    mutate(realSources(), HOOK, (text) =>
      text.replace(
        /(const measureAt = \(threshold: number\) => \{\n)\s*stopWatchingMoves\(\);\n/,
        "$1",
      ),
    ),
    "tear the move watch down before anything else",
  );
});

test("the move observer must ignore a callback after it was replaced", () => {
  fails(
    mutate(realSources(), HOOK, (text) =>
      text.replace("        if (moves !== io) return;\n", ""),
    ),
    "ignore a callback after it was replaced",
  );
});

test("the move observer must re-measure a bar that moved since its entry", () => {
  fails(
    mutate(realSources(), HOOK, (text) =>
      text.replace("now.y !== rect.y ||", ""),
    ),
    "moved since its entry",
  );
});

test("the move observer must read its newest entry", () => {
  fails(
    mutate(realSources(), HOOK, (text) =>
      text.replace("entries[entries.length - 1]", "entries[0]"),
    ),
    "newest entry",
  );
});

test("a later delivery with a changed ratio must re-measure", () => {
  fails(
    mutate(realSources(), HOOK, (text) =>
      text.replace("          if (!first) return measure();\n", ""),
    ),
    "later delivery's ratio changes",
  );
});

test("the first delivery must re-arm a partly visible bar at its ratio", () => {
  for (const to of ["", "else measure();", "else first = false;"])
    fails(
      mutate(realSources(), HOOK, (text) =>
        text.replace("else measureAt(ratio);", to),
      ),
      "partial ratio",
    );
  fails(
    mutate(realSources(), HOOK, (text) =>
      text.replace("measureAt(1e-7), 1000", "measureAt(1e-7), 0"),
    ),
    "retry a clipped bar",
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
