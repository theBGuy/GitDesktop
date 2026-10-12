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
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { normPath as norm } from "../src/lib/git/path.ts";
import {
  cancelledConfirmNotice,
  cancelsOnRepoChange,
  confirmStamp,
} from "../src/lib/stores/confirm-scope.ts";
import {
  CLOSE,
  lineOf,
  maskNonCode,
  matchBrace,
  OPEN,
  ScanError,
  sourceFiles,
} from "./lib/ts-mask.mjs";

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

const ASK_CALL = /useConfirm\s*\.getState\(\)\s*\.(?:ask|askChecked)\(/g;

/** Every confirm ask in `text`, by line, with the raw text of its options'
 *  TOP-LEVEL `scope` value (the key itself for the `{ scope }` shorthand), or
 *  `null` when there is none. The scan runs on `maskNonCode`'s output, so comments
 *  and string/template/regex/JSX text can neither supply a key nor end the
 *  argument; it throws `ScanError` on input it can't read. An argument that isn't
 *  an inline object literal reads as `null`: its scope can't be seen here. */
function askScopes(text, jsx) {
  const masked = maskNonCode(text, jsx);
  const asks = [];
  for (const m of masked.matchAll(ASK_CALL)) {
    const line = lineOf(text, m.index);
    let open = m.index + m[0].length;
    while (/\s/.test(masked[open])) open++;
    const close = masked[open] === "{" ? matchBrace(masked, open) : -1;
    if (close === -1) {
      asks.push({ line, scope: null });
      continue;
    }
    asks.push({
      line,
      scope: topLevelValue(masked, text, open, close, "scope"),
    });
  }
  return asks;
}

/** The raw text of property `key`'s value in the object literal spanning
 *  `open`..`close` of `masked`, at that object's own depth only. */
function topLevelValue(masked, text, open, close, key) {
  let depth = 0;
  let expectKey = true;
  for (let i = open + 1; i < close; i++) {
    const c = masked[i];
    if (OPEN.has(c)) depth++;
    else if (CLOSE.has(c)) depth--;
    else if (depth === 0 && c === ",") expectKey = true;
    else if (depth === 0 && expectKey && /[\w$]/.test(c)) {
      const word = /^[\w$]+/.exec(masked.slice(i))[0];
      let after = i + word.length;
      while (/\s/.test(masked[after])) after++;
      if (word === key && masked[after] === ":") {
        let end = after + 1;
        for (let d = 0; end < close; end++) {
          if (OPEN.has(masked[end])) d++;
          else if (CLOSE.has(masked[end])) d--;
          else if (d === 0 && masked[end] === ",") break;
        }
        return text.slice(after + 1, end).trim();
      }
      if (word === key && (masked[after] === "," || after === close))
        return key;
      expectKey = false;
      i += word.length - 1;
    } else if (!/\s/.test(c)) expectKey = false;
  }
  return null;
}

const unscopedAsks = (text, jsx = false) =>
  askScopes(text, jsx)
    .filter((a) => a.scope === null)
    .map((a) => a.line);

for (const file of APP_SCOPED) {
  test(`${file} asks with scope "app"`, () => {
    const asks = askScopes(source(file), file.endsWith(".tsx"));
    assert.ok(asks.length > 0, "no asks found");
    for (const { scope } of asks)
      assert.equal(scope, '"app"', 'an ask lost scope: "app"');
  });
}

// Folders that hold the app-level screens (Settings, Explore, Welcome, My work).
// A prompt there acts outside the open repository, so the repo-scope default is
// a trap: every ask under them must spell its `scope` out.
const APP_LEVEL_DIRS = [
  "src/features/settings",
  "src/features/explore",
  "src/features/welcome",
  "src/features/mywork",
];

/** Lines where `text` reaches the confirm store through a selector hook
 *  (`useConfirm((s) => s.ask)`): the scope ratchet reads only
 *  `useConfirm.getState().ask(…)` calls, so an ask behind a selector would pass
 *  unchecked. Scanned on masked text, like the asks. */
function selectorReaches(text, jsx = false) {
  const masked = maskNonCode(text, jsx);
  return [...masked.matchAll(/\buseConfirm\s*\(/g)].map((m) =>
    lineOf(text, m.index),
  );
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

const ask = (options) => `useConfirm.getState().ask(${options});\n`;

test("a scope key inside a comment doesn't count", () => {
  assert.deepEqual(
    unscopedAsks(ask('{ title: "X?", /* scope: "app" */ }')),
    [1],
  );
});

test("a scope key inside a string doesn't count", () => {
  assert.deepEqual(
    unscopedAsks(ask('{ title: "X?", body: "scope: global" }')),
    [1],
  );
});

test("a parenthesis inside a string doesn't end the options", () => {
  assert.deepEqual(
    unscopedAsks(ask('{ title: "Clear :)", scope: "app" }')),
    [],
  );
});

test("a nested scope key isn't the prompt's scope", () => {
  assert.deepEqual(unscopedAsks(ask('{ meta: { scope: "app" } }')), [1]);
});

test("the shorthand scope key counts", () => {
  assert.deepEqual(askScopes(ask("{ title, scope }"), false), [
    { line: 1, scope: "scope" },
  ]);
});

test("a scope key spelled inside a template literal doesn't count", () => {
  assert.deepEqual(unscopedAsks(ask('{ title: `${"scope:"}` }')), [1]);
});

test("unreadable input fails the scan instead of passing", () => {
  assert.throws(() => unscopedAsks(ask('{ title: "unterminated }')), ScanError);
});

test("the app-level scan flags a selector reach into the confirm store", () => {
  const fixture = `
    const ask = useConfirm((s) => s.ask);
    const ok = await useConfirm.getState().ask({ title, scope: "app" });
    // useConfirm((s) => s.ask) in a comment is not a reach
  `;
  assert.deepEqual(selectorReaches(fixture), [2]);
  assert.deepEqual(selectorReaches(ask('{ title, scope: "app" }')), []);
});

test("every ask on an app-level screen passes an explicit scope", () => {
  let files = 0;
  let asks = 0;
  for (const dir of APP_LEVEL_DIRS) {
    const root = fileURLToPath(new URL(`../${dir}/`, import.meta.url));
    for (const abs of sourceFiles(root)) {
      files++;
      const file = path.relative(
        fileURLToPath(new URL("../", import.meta.url)),
        abs,
      );
      const text = readFileSync(abs, "utf8").replace(/\r\n/g, "\n");
      const jsx = abs.endsWith(".tsx");
      assert.deepEqual(
        selectorReaches(text, jsx),
        [],
        `${file}: reach the store via useConfirm.getState() so the scope ratchet can see it`,
      );
      asks += askScopes(text, jsx).length;
      assert.deepEqual(
        unscopedAsks(text, jsx),
        [],
        `${file}: an ask without scope: (repo-scoped by default)`,
      );
    }
  }
  assert.ok(files > 0, "no app-level source files found");
  assert.ok(asks > 0, "no asks found under the app-level folders");
});
