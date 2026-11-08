// Pins the app toaster's theme: AppToaster in main.tsx reads the app's resolved
// theme through `useIsDark()` and hands it to the single `<Toaster>` as
// `theme={isDark ? "dark" : "light"}`. The vendored wrapper reads next-themes,
// which has no provider here, so without the prop toasts follow the OS scheme
// instead of the app. The scan must pass the real source and go red under every
// mutation listed with it. The toaster's offset props and its ban on the
// wrapper-overriding props stay pinned in settings-discard-confirm.test.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { maskNonCode, matchBrace, tagEnd } from "./lib/ts-mask.mjs";

const source = (rel) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n",
  );

const MAIN = "src/main.tsx";

/** Problems with main.tsx's toaster theme wiring, `[]` when pinned. */
function toasterTheme(text) {
  const masked = maskNonCode(text, true);
  const tags = [...masked.matchAll(/<Toaster\b/g)];
  if (tags.length !== 1)
    return [`expected one <Toaster>, found ${tags.length}`];
  const end = tagEnd(masked, tags[0].index);
  if (end === -1) return ["the <Toaster> tag doesn't close"];
  const problems = [];
  // Located in the masked text so a commented-out prop can't count; the value
  // is read from the real text, since masking blanks its string literals.
  const props = [...masked.slice(tags[0].index, end).matchAll(/\stheme=/g)];
  if (props.length !== 1) {
    problems.push(`expected one theme prop, found ${props.length}`);
  } else {
    const at = tags[0].index + props[0].index;
    if (
      !/^\stheme=\{\s*isDark\s*\?\s*"dark"\s*:\s*"light"\s*\}/.test(
        text.slice(at, end),
      )
    )
      problems.push("theme isn't the isDark ternary");
  }
  const fn = masked.search(/\bfunction AppToaster\s*\(/);
  const open = fn === -1 ? -1 : masked.indexOf("{", fn);
  const close = open === -1 ? -1 : matchBrace(masked, open);
  if (close === -1) problems.push("AppToaster's body wasn't found");
  else if (
    !/\bconst\s+isDark\s*=\s*useIsDark\(\s*\)/.test(masked.slice(open, close))
  )
    problems.push("AppToaster doesn't read useIsDark()");
  else if (fn > tags[0].index || close < tags[0].index)
    problems.push("the <Toaster> isn't AppToaster's");
  return problems;
}

/** Asserts `check` passes the real `text` and fails every `mutate(text)`. */
function pin(check, text, ...mutations) {
  assert.deepEqual(check(text), []);
  for (const mutate of mutations) {
    const mutant = mutate(text);
    assert.notEqual(mutant, text, "the mutation didn't apply");
    assert.ok(check(mutant).length > 0, "the scan passed a mutated source");
  }
}

test("the toaster follows the app's resolved theme", () => {
  pin(
    toasterTheme,
    source(MAIN),
    // (a) the prop deleted: the wrapper's next-themes value tracks the OS.
    (t) => t.replace(/\n\s*theme=\{isDark \? "dark" : "light"\}/, ""),
    // (b) a literal "system" theme.
    (t) => t.replace('theme={isDark ? "dark" : "light"}', 'theme="system"'),
    // (c) the hook replaced by a constant.
    (t) => t.replace("const isDark = useIsDark();", "const isDark = false;"),
  );
});
