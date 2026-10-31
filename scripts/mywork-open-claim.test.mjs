// Pins the click-time open claim of the two clicks that await before calling a
// ui-store navigator: My work's `openItem` (MyWorkScreen.tsx) and the Activity
// dock's `navigate` (ActivityDock.tsx). Each declares
// `const claimed = claimRepoOpen();` once, as a top-level statement of its body,
// ahead of its first `await`, `throw` and navigator call, and after its early
// returns (the arms that never open a repo, which must not retire an open made
// elsewhere); its `superseded` reads `!claimed()`, and nothing else does (never
// the navigator's `stillValid`, which runs after the navigator's own claim and
// would retire it); and before EVERY navigator call, an `if (superseded()) return;`
// runs after the last await preceding that call, at a depth no deeper than it;
// and EVERY navigator call passes the one `stillValid`, which is exactly the
// click's generation and the navigator's own epoch.
// An older jump still held on its repo-shell warm-up checks the open claims, so
// a click that claimed late, or never read its claim, lets an older target land
// over a newer one, or lets a newer open be retired by an older click. A narrow
// pin on these two functions, not a src-wide scanner; each check must go red on
// the in-memory mutants below, so a scan that can't fail on those edits fails
// here instead.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { CLOSE, maskNonCode, matchBrace, OPEN } from "./lib/ts-mask.mjs";

const read = (rel) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n",
  );

const NAVIGATOR =
  /(?<![\w$.])(?:openPr|openIssue|openRun|openAgentTab|openRepoView)\(/g;

const SITES = {
  openItem: {
    file: "src/features/mywork/MyWorkScreen.tsx",
    // The parameter list is matched as a group, then the body must follow it.
    head: /\basync function openItem\s*\(/g,
    params: true,
    generation: "openGen",
  },
  navigate: {
    file: "src/features/activity/ActivityDock.tsx",
    head: /\bconst navigate = \(n: AppNotification\) => \{/g,
    params: false,
    generation: "clickGen",
  },
};

/** `[open, close]` of the site's function body in `masked`, or a problem. */
function siteBody(masked, name, site) {
  const heads = [...masked.matchAll(site.head)];
  if (heads.length !== 1)
    return `expected one ${name} definition, found ${heads.length}`;
  let open = heads[0].index + heads[0][0].length - 1;
  if (site.params) {
    const paramsClose = matchBrace(masked, open);
    if (paramsClose === -1) return `${name}'s parameter list was not found`;
    const brace = /^\s*\{/.exec(masked.slice(paramsClose + 1));
    if (!brace) return `${name} has no block body`;
    open = paramsClose + brace[0].length;
  }
  const close = matchBrace(masked, open);
  return close === -1 ? `${name}'s body was not closed` : [open, close];
}

/** Bracket depth at `at` inside `body`, whose index 0 is the body's `{`. */
function depthAt(body, at) {
  let depth = 0;
  for (let i = 1; i < at; i++) {
    if (OPEN.has(body[i])) depth++;
    else if (CLOSE.has(body[i])) depth--;
  }
  return depth;
}

const wordAt = (word) => new RegExp(`(?<![\\w$.])${word}(?![\\w$])`, "g");

/** Problems with `name`'s claim in `text`, `[]` when pinned. Fails closed when
 *  the function, its body, its claim, its `superseded`, an await or a
 *  navigator call can't be found, so a rename or reshape never passes
 *  vacuously. Nested callbacks count: an await, throw or navigator call
 *  anywhere ahead of the claim fails, as does a return between the claim and
 *  the first await. */
function claimProblems(name, text) {
  const site = SITES[name];
  const masked = maskNonCode(text, true);
  const span = siteBody(masked, name, site);
  if (typeof span === "string") return [span];
  const body = masked.slice(span[0], span[1] + 1);
  const problems = [];
  const calls = [...body.matchAll(/(?<![\w$.])claimRepoOpen\s*\(/g)];
  const decl = /(?<![\w$.])const claimed = claimRepoOpen\(\);/.exec(body);
  if (calls.length !== 1 || !decl) {
    problems.push(
      `expected one \`const claimed = claimRepoOpen();\` in ${name}, found ${calls.length} claim call(s)`,
    );
    return problems;
  }
  const before = body.slice(0, decl.index).trimEnd();
  if (depthAt(body, decl.index) !== 0 || !/[;{}]$/.test(before))
    problems.push(`${name}'s claim isn't a top-level statement of its body`);
  const navs = [...body.matchAll(NAVIGATOR)];
  const firstAwait = wordAt("await").exec(body)?.index ?? -1;
  const firstThrow = wordAt("throw").exec(body)?.index ?? -1;
  if (firstAwait === -1)
    problems.push(`${name} has no await to order the claim against`);
  if (navs.length === 0) {
    problems.push(`${name} calls no ui-store navigator`);
    return problems;
  }
  if (firstAwait !== -1 && firstAwait < decl.index)
    problems.push(`${name} can await before it claims the open`);
  if (firstThrow !== -1 && firstThrow < decl.index)
    problems.push(`${name} can throw before it claims the open`);
  if (navs[0].index < decl.index)
    problems.push(`${name} can navigate before it claims the open`);
  // A return between the claim and the first await is an arm that claimed
  // without a chance to open anything, retiring a pending open for nothing.
  if (
    firstAwait > decl.index &&
    [...body.slice(decl.index, firstAwait).matchAll(wordAt("return"))].length >
      0
  )
    problems.push(`${name} can return after it claims, before its first await`);
  const reads = [...body.matchAll(/(?<![\w$.])claimed(?![\w$])/g)];
  const sup = /(?<![\w$.])const superseded = \(\) =>/.exec(body);
  let supEnd = -1;
  if (sup) {
    for (let i = sup.index, depth = 0; i < body.length; i++) {
      if (OPEN.has(body[i])) depth++;
      else if (CLOSE.has(body[i])) depth--;
      else if (depth === 0 && body[i] === ";") {
        supEnd = i;
        break;
      }
    }
  }
  if (supEnd === -1) problems.push(`${name}'s superseded was not found`);
  else if (
    reads.length !== 2 ||
    !/(?<![\w$.])!claimed\(\)/.test(body.slice(sup.index, supEnd))
  )
    problems.push(
      `${name}'s claim isn't read by its superseded, and only there`,
    );
  for (const nav of navs) {
    const awaits = [...body.slice(0, nav.index).matchAll(wordAt("await"))];
    const lastAwait = awaits.at(-1)?.index ?? 0;
    const navDepth = depthAt(body, nav.index);
    const checked = [
      ...body
        .slice(lastAwait, nav.index)
        .matchAll(/(?<![\w$.])if \(superseded\(\)\) return;/g),
    ].some((m) => depthAt(body, lastAwait + m.index) <= navDepth);
    if (!checked)
      problems.push(
        `${name}'s ${nav[0].slice(0, -1)} call isn't preceded by a superseded() check after its last await`,
      );
    const argsOpen = nav.index + nav[0].length - 1;
    const argsClose = matchBrace(body, argsOpen);
    if (
      argsClose === -1 ||
      !/(?<![\w$.])stillValid\s*,/.test(body.slice(argsOpen, argsClose))
    )
      problems.push(
        `${name}'s ${nav[0].slice(0, -1)} call doesn't pass its stillValid`,
      );
  }
  const predicate = new RegExp(
    `(?<![\\w$.])const stillValid = \\(epochAtRequest: number\\) =>\\s*gen === ${site.generation} &&\\s*useUiStore\\.getState\\(\\)\\.interactionEpoch === epochAtRequest;`,
  );
  if (
    !predicate.test(body) ||
    [...body.matchAll(/(?<![\w$.])const stillValid(?![\w$])/g)].length !== 1
  )
    problems.push(
      `${name}'s stillValid isn't exactly its generation and the navigator's epoch`,
    );
  return problems;
}

/** `s` with `from` replaced exactly once (the mutation fails closed if absent). */
const once = (from, to) => (s) => s.replace(from, () => to);

const CLAIM = "    const claimed = claimRepoOpen();\n";

/** Each mutant breaks one clause of the contract. */
const MUTANTS = {
  openItem: {
    "the claim removed": once(CLAIM, ""),
    "the claim inside a block": once(CLAIM, `    {\n  ${CLAIM}    }\n`),
    "the claim inside a conditional": once(
      CLAIM,
      `    if (gen > 0) {\n  ${CLAIM}    }\n`,
    ),
    "the claim inside a callback": once(
      CLAIM,
      `    queueMicrotask(() => {\n  ${CLAIM}    });\n`,
    ),
    "the claim after the first await": once(CLAIM, `    await null;\n${CLAIM}`),
    "a throw ahead of the claim": once(
      CLAIM,
      `    if (!item) throw new Error("no item");\n${CLAIM}`,
    ),
    "a navigator call ahead of the claim": once(
      CLAIM,
      `    openIssue({ repoPath: "", repoName: "", number: 0 });\n${CLAIM}`,
    ),
    "the claim above the browser-only arm": (s) =>
      once(
        "    const candidates = openableMatches(item, recents);\n",
        `${CLAIM}    const candidates = openableMatches(item, recents);\n`,
      )(once(CLAIM, "")(s)),
    "superseded no longer reads the claim": once("!claimed() || ", ""),
    "the last superseded check before the navigators removed": once(
      "      if (superseded()) return;\n    }\n",
      "    }\n",
    ),
    "an await just before openIssue without a re-check": once(
      "      openIssue({\n",
      "      await null;\n      openIssue({\n",
    ),
    "the openPr arm drops stillValid": once(
      "        beforeSelect: applyLens,\n        stillValid,\n      });\n    } else {",
      "        beforeSelect: applyLens,\n      });\n    } else {",
    ),
    "the openIssue arm drops stillValid": once(
      "        number: item.number,\n        beforeSelect: applyLens,\n        stillValid,\n",
      "        number: item.number,\n        beforeSelect: applyLens,\n",
    ),
    "the claim read inside stillValid": once(
      "      gen === openGen &&\n",
      "      gen === openGen &&\n      claimed() &&\n",
    ),
    "superseded read inside stillValid": once(
      "      gen === openGen &&\n",
      "      gen === openGen &&\n      !superseded() &&\n",
    ),
    "stillValid without the generation": once("      gen === openGen &&\n", ""),
    "stillValid without the epoch": once(
      "      gen === openGen &&\n      useUiStore.getState().interactionEpoch === epochAtRequest;\n",
      "      gen === openGen;\n",
    ),
    "openItem renamed": once(
      "async function openItem(",
      "async function openRow(",
    ),
  },
  navigate: {
    "the claim removed": once(CLAIM, ""),
    "the claim inside a conditional": once(
      CLAIM,
      `    if (gen > 0) {\n  ${CLAIM}    }\n`,
    ),
    "the claim after the first await": once(CLAIM, `    await null;\n${CLAIM}`),
    "a throw ahead of the claim": once(
      CLAIM,
      `    if (!n) throw new Error("no row");\n${CLAIM}`,
    ),
    "a navigator call ahead of the claim": once(
      CLAIM,
      `    openRepoView({ repoPath: "", repoName: "" });\n${CLAIM}`,
    ),
    "the claim above the arms that never open a repo": (s) =>
      once(
        '    onClose();\n    if (t?.type === "automation-result") {\n',
        `${CLAIM}    onClose();\n    if (t?.type === "automation-result") {\n`,
      )(once(CLAIM, "")(s)),
    "superseded no longer reads the claim": once(
      "      useUiStore.getState().interactionEpoch !== startEpoch ||\n      !claimed();\n",
      "      useUiStore.getState().interactionEpoch !== startEpoch;\n",
    ),
    "the claim read inside stillValid": once(
      "        gen === clickGen &&\n",
      "        gen === clickGen &&\n        claimed() &&\n",
    ),
    "no superseded check after the resolve": once(
      "      const target = await resolveLiveTarget(n, superseded);\n      if (superseded()) return;\n",
      "      const target = await resolveLiveTarget(n, superseded);\n",
    ),
    "an await just before openPr without a re-check": once(
      "      openPr({\n",
      "      await null;\n      openPr({\n",
    ),
    "the openPr call drops stillValid": once(
      "        stillValid,\n        onApplied: () => markNotificationRead(n.id),\n      });\n    })()",
      "        onApplied: () => markNotificationRead(n.id),\n      });\n    })()",
    ),
    "stillValid without the generation": once(
      "        gen === clickGen &&\n",
      "",
    ),
    "navigate renamed": once(
      "const navigate = (n: AppNotification) => {",
      "const go = (n: AppNotification) => {",
    ),
  },
};

for (const name of Object.keys(SITES)) {
  test(`${name} claims the open at the click and reads it before navigating`, () => {
    assert.deepEqual(claimProblems(name, read(SITES[name].file)), []);
  });

  test(`negative control: every mutant of ${name}'s claim fails the pin`, () => {
    const source = read(SITES[name].file);
    for (const [label, mutate] of Object.entries(MUTANTS[name])) {
      const mutant = mutate(source);
      assert.notEqual(mutant, source, `mutant "${label}" didn't apply`);
      assert.ok(
        claimProblems(name, mutant).length > 0,
        `the pin passed mutant "${label}"`,
      );
    }
  });
}
