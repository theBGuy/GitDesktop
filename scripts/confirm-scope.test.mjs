// Pins which confirm prompts a repository switch cancels and the notice each
// cancel leaves: repo-scoped by default, compared through the path normalizer so
// another spelling of the same root never cancels, and copy derived from the
// prompt's own title.
//
// The imports reach straight into `src/` under Node's type stripping, so
// `confirm-scope.ts` and `git/path.ts` must stay free of runtime and aliased
// imports. The wiring the pure helpers can't see (the store's subscription and
// the app-scoped call sites) is pinned by source scans at the bottom.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { normPath as norm } from "../src/lib/git/path.ts";
import {
  cancelledConfirmNotice,
  cancelsOnRepoChange,
  confirmStamp,
} from "../src/lib/stores/confirm-scope.ts";

const source = (rel) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n",
  );

const SWITCHED = "you switched repositories while the dialog was open.";

test("a prompt is repo-scoped unless it says otherwise", () => {
  assert.equal(confirmStamp(undefined, "C:/repos/a"), "C:/repos/a");
  assert.equal(confirmStamp("repo", "C:/repos/a"), "C:/repos/a");
  assert.equal(confirmStamp("app", "C:/repos/a"), null);
});

test("a repo-scoped ask with no repository open stays unscoped", () => {
  assert.equal(confirmStamp(undefined, null), null);
  assert.equal(
    cancelsOnRepoChange(confirmStamp(undefined, null), "C:/b", norm),
    false,
  );
});

test("switching to another repository cancels", () => {
  assert.equal(cancelsOnRepoChange("C:/repos/a", "C:/repos/b", norm), true);
});

test("closing the repository cancels", () => {
  assert.equal(cancelsOnRepoChange("C:/repos/a", null, norm), true);
});

test("another spelling of the same root does not cancel", () => {
  assert.equal(cancelsOnRepoChange("C:/Repos/A", "c:\\repos\\a", norm), false);
  assert.equal(cancelsOnRepoChange("C:\\repos\\a", "C:/repos/a", norm), false);
});

test("an app-scoped prompt survives a switch and a close", () => {
  const stamp = confirmStamp("app", "C:/repos/a");
  assert.equal(cancelsOnRepoChange(stamp, "C:/repos/b", norm), false);
  assert.equal(cancelsOnRepoChange(stamp, null, norm), false);
});

test("an unstamped prompt never cancels", () => {
  assert.equal(cancelsOnRepoChange(null, "C:/repos/b", norm), false);
  assert.equal(cancelsOnRepoChange(null, null, norm), false);
});

test("the notice turns the title into a Didn't clause", () => {
  assert.equal(
    cancelledConfirmNotice("Close pull request #12?", " in GitDesktop", false),
    `Didn't close pull request #12 in GitDesktop — ${SWITCHED}`,
  );
  assert.equal(
    cancelledConfirmNotice("Check out commit abc1234?", " in repo", false),
    `Didn't check out commit abc1234 in repo — ${SWITCHED}`,
  );
});

test("a title without a question mark keeps its words", () => {
  assert.equal(
    cancelledConfirmNotice("Delete project", " in repo", false),
    `Didn't delete project in repo — ${SWITCHED}`,
  );
});

test("a close gets its own tail", () => {
  assert.equal(
    cancelledConfirmNotice("Close issue #3?", " in repo", true),
    "Didn't close issue #3 in repo — you closed the repository.",
  );
});

test("a title that isn't plain text falls back to a generic lead", () => {
  const element = { type: "span", props: { children: "Close #12?" } };
  assert.equal(
    cancelledConfirmNotice(element, " in repo", false),
    `Didn't finish that action in repo — ${SWITCHED}`,
  );
  assert.equal(
    cancelledConfirmNotice(element, " in repo", true),
    "Didn't finish that action in repo — you closed the repository.",
  );
  assert.equal(
    cancelledConfirmNotice("?", " in repo", false),
    `Didn't finish that action in repo — ${SWITCHED}`,
  );
});

test("the store cancels from its ui subscription, never from a supersede", () => {
  const src = source("src/lib/stores/confirm.ts");
  const sub = src.indexOf("useUiStore.subscribe(");
  assert.ok(sub >= 0, "confirm.ts no longer subscribes to the ui store");
  const listener = src.slice(sub);
  assert.match(listener, /cancelsOnRepoChange\(/);
  assert.match(listener, /request\.resolve\(false, false\)/);
  assert.match(listener, /toast\.info\(/);
  const openStart = src.indexOf("const open = (");
  const openEnd = src.indexOf("return {", openStart);
  assert.ok(openStart >= 0 && openEnd > openStart, "open() not found");
  const open = src.slice(openStart, openEnd);
  assert.match(open, /confirmStamp\(/, "open() no longer stamps the request");
  assert.doesNotMatch(open, /toast/, "a supersede must stay silent");
});

// Prompts that act outside the open repository: a switch must never cancel
// them, the quit/update prompt above all.
const APP_SCOPED = [
  "src/lib/parked-writes.ts",
  "src/features/explore/ExploreDetail.tsx",
  "src/features/repository/useOpenRepoByPath.ts",
  "src/features/scripts/TasksPanel.tsx",
  "src/features/settings/NotificationsSection.tsx",
];

const INLINE_ASK =
  /useConfirm\s*\.getState\(\)\s*\.(?:ask|askChecked)\(\{([\s\S]*?)\n\s*\}\)/g;

for (const file of APP_SCOPED) {
  test(`${file} asks with scope "app"`, () => {
    const asks = [...source(file).matchAll(INLINE_ASK)];
    assert.ok(asks.length > 0, "no inline ask options found");
    for (const [, options] of asks)
      assert.match(options, /\bscope: "app"/, 'an ask lost scope: "app"');
  });
}

// Folders that hold the app-level screens (Settings, Explore, Welcome, My work).
// A prompt there acts outside the open repository, so the repo-scope default is
// a trap: every ask under them must spell its `scope:` out.
const APP_LEVEL_DIRS = [
  "src/features/settings",
  "src/features/explore",
  "src/features/welcome",
  "src/features/mywork",
];

const ASK_CALL = /useConfirm\s*\.getState\(\)\s*\.(?:ask|askChecked)\(/g;

/** Each confirm ask in `text` whose options don't name a `scope:`, by line. An
 *  argument that isn't an inline object literal is flagged too: its scope can't
 *  be read here, so it fails closed. Comment lines are skipped. */
function unscopedAsks(text) {
  const misses = [];
  for (const m of text.matchAll(ASK_CALL)) {
    const lineStart = text.lastIndexOf("\n", m.index) + 1;
    if (/^\s*(\*|\/\/)/.test(text.slice(lineStart, m.index))) continue;
    const open = m.index + m[0].length;
    let depth = 1;
    let end = open;
    for (; end < text.length && depth > 0; end++) {
      if (text[end] === "(") depth++;
      else if (text[end] === ")") depth--;
    }
    const arg = text.slice(open, end - 1).trim();
    if (!arg.startsWith("{") || !/\bscope:/.test(arg))
      misses.push(text.slice(0, m.index).split("\n").length);
  }
  return misses;
}

function sourceFiles(rel) {
  const dir = new URL(`../${rel}/`, import.meta.url);
  return readdirSync(dir, { recursive: true })
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .map((f) => `${rel}/${String(f).replace(/\\/g, "/")}`);
}

test("the app-level scan flags an ask without a scope", () => {
  const fixture = `
    const ok = await useConfirm.getState().ask({
      title: "Clear it?",
      body: "",
      confirmLabel: "Clear",
    });
    const named = await useConfirm.getState().ask(PROMPT);
    // useConfirm.getState().ask({ title }) in a comment is not a call
    const scoped = await useConfirm
      .getState()
      .ask({ title: "Fork?", body: "", confirmLabel: "Fork", scope: "app" });
  `;
  assert.deepEqual(unscopedAsks(fixture), [2, 7]);
});

test("every ask on an app-level screen passes an explicit scope", () => {
  let files = 0;
  let asks = 0;
  for (const dir of APP_LEVEL_DIRS) {
    for (const file of sourceFiles(dir)) {
      files++;
      const text = source(file);
      asks += [...text.matchAll(ASK_CALL)].length;
      assert.deepEqual(
        unscopedAsks(text),
        [],
        `${file}: an ask without scope: (repo-scoped by default)`,
      );
    }
  }
  assert.ok(files > 0, "no app-level source files found");
  assert.ok(asks > 0, "no asks found under the app-level folders");
});
