// Pins App.tsx's Back/Forward wiring, which no component test mounts: App calls
// `useNavHistoryActions(dialogOpen)` and `useSideButtonNavigation()` in its own
// body ahead of its first early return (hooks after one would run conditionally),
// and keeps an effect that calls `setNavHiddenTabs` keyed on the Hide AI setting.
// Not covered: what the hooks do (src/test/go-back-forward.test.tsx and
// src/test/nav-history.test.ts), an early return spelled other than as an `if`
// statement in App's own body, and one in an `else` branch ahead of the hooks.
// The pin fails closed on harmless reshapes of App.tsx too (a destructured
// `hideAi`, the setter bound through a selector, a differently spelled component
// head), and each costs one edit here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { maskNonCode, matchBrace } from "./lib/ts-mask.mjs";

const APP = new URL("../src/App.tsx", import.meta.url);

/** App's body in masked text: the offsets just inside its braces. */
function appBody(masked) {
  const head = /\bfunction App\s*\(\s*\)\s*\{/.exec(masked);
  if (head === null) return null;
  const open = head.index + head[0].length - 1;
  const close = matchBrace(masked, open);
  return close < 0 ? null : { from: open + 1, to: close };
}

/** Offsets of each match of `re` that sits directly in App's body, at no nesting. */
function topLevel(masked, body, re) {
  const found = [];
  let depth = 0;
  for (let i = body.from; i < body.to; i++) {
    const c = masked[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth === 0) {
      re.lastIndex = i;
      const m = re.exec(masked);
      if (m !== null && m.index === i) found.push(i);
    }
  }
  return found;
}

/** Offset of App's first top-level `if` whose statement holds a `return`. */
function firstEarlyReturn(masked, body) {
  for (const at of topLevel(masked, body, /\bif\s*\(/y)) {
    const condOpen = masked.indexOf("(", at);
    const condClose = matchBrace(masked, condOpen);
    let i = condClose + 1;
    while (/\s/.test(masked[i])) i++;
    const end =
      masked[i] === "{" ? matchBrace(masked, i) : masked.indexOf(";", i);
    if (/\breturn\b/.test(masked.slice(i, end))) return at;
  }
  return body.to;
}

function wiringProblems(text) {
  const raw = text.replace(/\r\n/g, "\n");
  const masked = maskNonCode(raw, true);
  const body = appBody(masked);
  if (body === null) return ["App.tsx: no readable `function App() { … }`"];
  const problems = [];
  const early = firstEarlyReturn(masked, body);
  for (const [name, re] of [
    [
      "useNavHistoryActions(dialogOpen)",
      /useNavHistoryActions\(\s*dialogOpen\s*\)/y,
    ],
    ["useSideButtonNavigation()", /useSideButtonNavigation\(\s*\)/y],
  ]) {
    const calls = topLevel(masked, body, re);
    if (calls.length !== 1)
      problems.push(
        `App.tsx: App's body calls ${name} ${calls.length} times, not once`,
      );
    else if (calls[0] > early)
      problems.push(`App.tsx: ${name} comes after App's first early return`);
  }
  const effects = topLevel(masked, body, /useEffect\(/y).filter((at) => {
    const close = matchBrace(masked, masked.indexOf("(", at));
    const call = masked.slice(at, close + 1);
    const deps = /\[([^[\]]*)\]\s*,?\s*\)$/.exec(call);
    return (
      /\.setNavHiddenTabs\(/.test(call) &&
      deps !== null &&
      /\bhideAi\b/.test(deps[1])
    );
  });
  if (effects.length !== 1)
    problems.push(
      "App.tsx: no single effect calls setNavHiddenTabs with `hideAi` in its dependencies",
    );
  if (!/\bconst hideAi = settings\.data\?\.hideAi;/.test(masked))
    problems.push("App.tsx: `hideAi` is not read from the Hide AI setting");
  return problems;
}

const real = readFileSync(APP, "utf8").replace(/\r\n/g, "\n");

test("App wires Back/Forward ahead of its first early return", () => {
  assert.deepEqual(wiringProblems(real), []);
});

// NEGATIVE CONTROLS, each a mutation of the real file's text in memory.
const mutate = (from, to) => {
  assert.equal(real.split(from).length - 1, 1, from);
  return real.split(from).join(to);
};
const NAV = "  useNavHistoryActions(dialogOpen);\n";
const SIDE = "  useSideButtonNavigation();\n";
const withoutHiddenTabsEffect = () => {
  const start = real.indexOf(
    "  useEffect(() => {\n    useUiStore\n      .getState()\n      .setNavHiddenTabs(",
  );
  const close = "  }, [hideAi]);\n";
  const end = real.indexOf(close, start);
  assert.ok(start >= 0 && end > start, "hidden-tabs effect present once");
  return real.slice(0, start) + real.slice(end + close.length);
};

test("each wiring loss fails the pin", () => {
  for (const [name, mutant, expected] of [
    [
      "the actions hook removed",
      mutate(NAV, ""),
      /calls useNavHistoryActions\(dialogOpen\) 0 times/,
    ],
    [
      "the actions hook commented out",
      mutate(NAV, `  // ${NAV.trimStart()}`),
      /calls useNavHistoryActions\(dialogOpen\) 0 times/,
    ],
    [
      "the dialog flag not passed",
      mutate(NAV, "  useNavHistoryActions(false);\n"),
      /calls useNavHistoryActions\(dialogOpen\) 0 times/,
    ],
    [
      "the side-button hook removed",
      mutate(SIDE, ""),
      /calls useSideButtonNavigation\(\) 0 times/,
    ],
    [
      "the side-button hook under a condition",
      mutate(
        SIDE,
        "  if (dialogOpen) {\n    useSideButtonNavigation();\n  }\n",
      ),
      /calls useSideButtonNavigation\(\) 0 times/,
    ],
    [
      "an early return ahead of both hooks",
      mutate(NAV, `  if (gitInstalled.isPending) return null;\n${NAV}`),
      /useNavHistoryActions\(dialogOpen\) comes after App's first early return/,
    ],
    [
      "the effect keyed on nothing",
      mutate("  }, [hideAi]);\n", "  }, []);\n"),
      /no single effect calls setNavHiddenTabs/,
    ],
    [
      "hideAi read from elsewhere",
      mutate(
        "const hideAi = settings.data?.hideAi;",
        "const hideAi = settings.data?.aiDisabled;",
      ),
      /`hideAi` is not read from the Hide AI setting/,
    ],
    [
      "the hidden-tabs effect removed",
      withoutHiddenTabsEffect(),
      /no single effect calls setNavHiddenTabs/,
    ],
  ]) {
    const problems = wiringProblems(mutant);
    assert.ok(
      problems.some((p) => expected.test(p)),
      `${name}: ${JSON.stringify(problems)}`,
    );
  }
  assert.deepEqual(wiringProblems("export const x = 1;\n"), [
    "App.tsx: no readable `function App() { … }`",
  ]);
});
