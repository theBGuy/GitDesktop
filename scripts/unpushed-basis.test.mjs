// Pins the History panel's handling of the no-upstream count's basis
// (src/features/history/editable-set.ts): the row arrows drop on a no-remote
// repo's default branch while squash and Edit history keep the full count, the
// tooltip names the local default branch when the count was taken against it,
// and a served snapshot's count always pairs with its own basis, never the
// live read's. Snapshots built before the basis fields existed stay tolerated.
//
// The squash hold names the local default branch as its limit only on that
// basis. HistoryPanel's wiring of the helpers is pinned by source shape (code
// only, comments and strings masked, each pin proven by an in-memory mutated
// copy). Not testable here: the Rust side's choice of basis (pinned by
// branches.rs's unpushed tests).
//
// The import reaches straight into `src/` under Node's type stripping, so the
// module must stay free of runtime imports.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  advanceSnapshot,
  arrowCount,
  arrowUpstream,
  deriveEditRange,
  notAdjacentSquashHint,
  resolveUnpushedView,
} from "../src/features/history/editable-set.ts";
import { maskNonCode } from "./lib/ts-mask.mjs";

const commit = (hash) => ({ hash, isMerge: false });
const REPO = "C:/repos/app";
const BRANCH = "feature";
const BASES = ["remotes", "default-branch", "on-default-branch", "unresolved"];

const C2 = commit("c2");
const C1 = commit("c1");
const C0 = commit("c0");
const LOG = [C2, C1, C0];

const live = (over = {}) => ({
  agreed: true,
  repo: REPO,
  branch: BRANCH,
  statusOid: "c2",
  liveAhead: 0,
  noUpstream: true,
  commits: LOG,
  count: 2,
  basis: "default-branch",
  defaultBranch: "master",
  hasNextPage: false,
  snapshot: null,
  ...over,
});

test("arrowCount zeroes only on the default branch itself", () => {
  for (const basis of BASES) {
    assert.equal(arrowCount(3, basis), basis === "on-default-branch" ? 0 : 3);
  }
  assert.equal(arrowCount(3, null), 3);
  assert.equal(arrowCount(3, undefined), 3);
});

test("arrowUpstream names the local default only for the default-branch basis", () => {
  for (const basis of BASES) {
    assert.equal(
      arrowUpstream(null, basis, "master"),
      basis === "default-branch" ? "master" : null,
    );
    assert.equal(
      arrowUpstream("origin/x", basis, "master"),
      basis === "default-branch" ? "master" : "origin/x",
    );
  }
  assert.equal(arrowUpstream("origin/x", null, null), "origin/x");
  assert.equal(arrowUpstream("origin/x", undefined, undefined), "origin/x");
  assert.equal(arrowUpstream(null, "default-branch", undefined), null);
});

test("on the default branch the gates keep the full count while arrows drop", () => {
  const view = resolveUnpushedView(
    live({ count: 2, basis: "on-default-branch" }),
  );
  assert.equal(view.count, 2);
  assert.equal(view.basis, "on-default-branch");
  assert.equal(arrowCount(view.count, view.basis), 0);
  assert.equal(deriveEditRange(view.commits, view.count, false).editLen, 2);
});

test("the agreed arm returns the live pair", () => {
  const view = resolveUnpushedView(live());
  assert.equal(view.count, 2);
  assert.equal(view.basis, "default-branch");
  assert.equal(view.defaultBranch, "master");
});

test("a served snapshot pairs its count with its own basis, not the live read's", () => {
  const snapshot = {
    repo: REPO,
    branch: BRANCH,
    commits: LOG,
    count: 2,
    basis: "default-branch",
    defaultBranch: "master",
    hasNextPage: false,
  };
  const view = resolveUnpushedView(
    live({
      agreed: false,
      count: 3,
      basis: "on-default-branch",
      defaultBranch: "feature",
      snapshot,
    }),
  );
  assert.equal(view.commits, LOG);
  assert.equal(view.count, 2);
  assert.equal(view.basis, "default-branch");
  assert.equal(view.defaultBranch, "master");
  assert.equal(arrowCount(view.count, view.basis), 2);
});

test("an old-shape snapshot without basis fields serves a null pair", () => {
  const snapshot = {
    repo: REPO,
    branch: BRANCH,
    commits: LOG,
    count: 2,
    hasNextPage: false,
  };
  const view = resolveUnpushedView(
    live({ agreed: false, basis: "on-default-branch", snapshot }),
  );
  assert.equal(view.count, 2);
  assert.equal(view.basis, null);
  assert.equal(view.defaultBranch, null);
  assert.equal(arrowCount(view.count, view.basis), 2);
  assert.equal(arrowUpstream(null, view.basis, view.defaultBranch), null);
});

test("the zero arm carries the live pair under a count of 0", () => {
  const view = resolveUnpushedView(
    live({ agreed: false, commits: [commit("n"), ...LOG], snapshot: null }),
  );
  assert.equal(view.count, 0);
  assert.equal(view.basis, "default-branch");
  assert.equal(arrowCount(view.count, view.basis), 0);
});

test("advanceSnapshot advances on a basis or default-branch change alone", () => {
  const prev = {
    repo: REPO,
    branch: BRANCH,
    commits: LOG,
    count: 2,
    basis: "default-branch",
    defaultBranch: "master",
    hasNextPage: false,
  };
  assert.equal(advanceSnapshot(prev, { ...prev }, true), prev);
  const rebased = { ...prev, basis: "unresolved", defaultBranch: null };
  assert.equal(advanceSnapshot(prev, rebased, true), rebased);
  const renamed = { ...prev, defaultBranch: "main" };
  assert.equal(advanceSnapshot(prev, renamed, true), renamed);
});

test("old-shape snapshots without basis fields still compare equal", () => {
  const prev = {
    repo: REPO,
    branch: BRANCH,
    commits: LOG,
    count: 2,
    hasNextPage: false,
  };
  assert.equal(advanceSnapshot(prev, { ...prev }, true), prev);
});

test("the not-adjacent squash hint names the default branch only on its basis", () => {
  const UNPUSHED = " (must be adjacent and unpushed)";
  for (const basis of BASES) {
    assert.equal(
      notAdjacentSquashHint(basis, "master"),
      basis === "default-branch"
        ? " (must be adjacent and ahead of master)"
        : UNPUSHED,
    );
  }
  assert.equal(notAdjacentSquashHint(null, null), UNPUSHED);
  assert.equal(notAdjacentSquashHint(undefined, undefined), UNPUSHED);
  assert.equal(notAdjacentSquashHint("default-branch", null), UNPUSHED);
});

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PANEL = "src/features/history/HistoryPanel.tsx";
const panelSource = () =>
  readFileSync(join(REPO_ROOT, PANEL), "utf8").replace(/\r\n/g, "\n");

/** Whitespace-free text with trailing commas dropped, so formatting can't
 *  move a pin. */
const squeeze = (text) => text.replace(/\s+/g, "").replace(/,\)/g, ")");

/** Each pin: `code` must appear exactly once in the masked source (strings
 *  blanked, so a commented-out or quoted copy can't satisfy it); `text`, when
 *  set, must appear in the unmasked source to read a string key. */
const WIRING = [
  {
    tag: "arrow-count",
    code: "constmarkCount=arrowCount(view.count,view.basis);",
  },
  {
    tag: "arrow-upstream",
    code: "constmarkUpstream=arrowUpstream(head?.upstreamGone?null:(head?.upstream??null),view.basis,view.defaultBranch);",
  },
  {
    tag: "list-props",
    code: "unpushedCount={markCount}upstream={markUpstream}",
  },
  {
    tag: "squash-hint",
    code: '"":notAdjacentSquashHint(view.basis,view.defaultBranch)',
    text: '"not-adjacent-unpushed":notAdjacentSquashHint(view.basis,view.defaultBranch)',
  },
  {
    tag: "squash-lookup",
    code: 'constsquashDisabledHint=squashHold?squashHints[squashHold]:"";',
  },
];

/** Problems with the panel's basis wiring; empty = pinned. Each entry starts
 *  with the tag of the pin that raised it. */
function checkWiring(src) {
  const code = squeeze(maskNonCode(src, true));
  const text = squeeze(src);
  const problems = [];
  for (const pin of WIRING) {
    const found = code.split(pin.code).length - 1;
    if (found !== 1)
      problems.push(
        `${pin.tag}: ${PANEL}: expected one \`${pin.code}\`, found ${found}`,
      );
    else if (pin.text && !text.includes(pin.text))
      problems.push(`${pin.tag}: ${PANEL}: missing \`${pin.text}\``);
  }
  return problems;
}

/** `src` with exactly one `from` replaced, asserted present. */
function mutate(src, from, to) {
  assert.equal(src.split(from).length - 1, 1, `control premise: one ${from}`);
  return src.replace(from, () => to);
}

function assertFailsOn(problems, tag, label) {
  assert.ok(problems.length > 0, `control: ${label} must fail`);
  assert.ok(
    problems.every((p) => p.startsWith(`${tag}:`)),
    `control: ${label} must fail on the ${tag} pin, got ${JSON.stringify(problems)}`,
  );
}

test("HistoryPanel derives the arrows and the squash hint from the resolved view", () => {
  const src = panelSource();
  assert.deepEqual(checkWiring(src), []);

  assertFailsOn(
    checkWiring(
      mutate(src, "arrowCount(view.count, view.basis)", "view.count"),
    ),
    "arrow-count",
    "arrows read the raw count",
  );
  assertFailsOn(
    checkWiring(
      mutate(
        src,
        "    view.basis,\n    view.defaultBranch,\n  );\n  const commitList",
        "    null,\n    null,\n  );\n  const commitList",
      ),
    ),
    "arrow-upstream",
    "tooltip ignores the basis",
  );
  assertFailsOn(
    checkWiring(
      mutate(src, "unpushedCount={markCount}", "unpushedCount={view.count}"),
    ),
    "list-props",
    "CommitList reads the raw count",
  );
  assertFailsOn(
    checkWiring(
      mutate(
        src,
        "notAdjacentSquashHint(\n      view.basis,",
        "notAdjacentSquashHint(\n      unpushedBasis,",
      ),
    ),
    "squash-hint",
    "hint reads the live basis",
  );
  assertFailsOn(
    checkWiring(
      mutate(
        src,
        '"not-adjacent-unpushed": notAdjacentSquashHint(',
        '"filter-hides-range": notAdjacentSquashHint(',
      ),
    ),
    "squash-hint",
    "hint lands on another hold",
  );
  assertFailsOn(
    checkWiring(
      mutate(
        src,
        "squashHold ? squashHints[squashHold]",
        "squashHold ? SQUASH_HOLD_HINT.op",
      ),
    ),
    "squash-lookup",
    "hold text bypasses the lookup",
  );
  assertFailsOn(
    checkWiring(
      mutate(
        src,
        "  const markCount = arrowCount(view.count, view.basis);",
        "  // const markCount = arrowCount(view.count, view.basis);\n  const markCount = view.count;",
      ),
    ),
    "arrow-count",
    "a commented-out copy",
  );
});
