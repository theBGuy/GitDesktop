// Pins the click-time open claim of the three clicks that await before calling a
// ui-store navigator: My work's `openItem` (MyWorkScreen.tsx), the Activity
// dock's `navigate` (ActivityDock.tsx) and the Projects board's `openInClone`
// (use-card-open.ts), whose file holds no other claim. Each declares
// `const claimed = claimRepoOpen();` once, as a top-level statement of its body,
// ahead of its first `await`, `throw` and navigator call, and after its early
// returns (the arms that never open a repo, which must not retire an open made
// elsewhere); its `superseded` holds `!claimed()` as a whole operand of its
// top-level `||`, and nothing else reads the claim (never the navigator's
// `stillValid`, which runs after the navigator's own claim and would retire it);
// and before EVERY navigator call, an `if (superseded()) return;` runs after the
// last await preceding that call, as a statement of its own, in a block still
// open at that call; and EVERY navigator call, a store-qualified or optional
// (`openIssue?.(`) one included, passes, as the shorthand property named once
// with no spread after it, the one `stillValid`, which is exactly the click's
// generation and the navigator's own epoch and declared once (a nested
// `const stillValid` fails).
// An older jump still held on its repo-shell warm-up checks the open claims, so
// a click that claimed late, or never read its claim, lets an older target land
// over a newer one, or lets a newer open be retired by an older click. A narrow
// pin on these three functions, not a src-wide scanner; each check must go red on
// the in-memory mutants below, so a scan that can't fail on those edits fails
// here instead.
//
// CONTRACT. It reads masked source text and runs nothing, so it cannot see that
// a navigator call inside a callback created after the check runs later than
// that check (it reads the call as checked); a navigator reached through an
// alias or a computed key (`const { openPr: go } = getState(); go(`,
// `getState()["openPr"](`), which it never reads as a navigator call; a shadow
// of `superseded` in any declaration form, or of `stillValid` by `let`, `function`,
// a parameter or a destructured binding (a nested `const stillValid` is a second
// declaration, which the predicate's count sees, and a shadow of `claimed` names
// it once more, which the count of its reads sees); a spread ahead of the
// shorthand (it cannot override it); a top-level ternary that swallows the `||`
// chain, so `!claimed()` is never read on the current generation; the shorthand
// nested inside another value of the same call; or a computed-key override after
// it (`["stillValid"]: undefined`). An equivalent rewrite (a parenthesised
// `superseded`, a block body, `stillValid: stillValid`, a check wrapped in a bare
// block, a harmless spread after) turns it red by design: re-point the pin.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { CLOSE, maskNonCode, matchBrace, OPEN } from "./lib/ts-mask.mjs";

const read = (rel) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n",
  );

// A qualified call (`useUiStore.getState().openPr(`) and an optional call
// (`openPr?.(`) are navigator calls too.
const NAVIGATOR =
  /(?<![\w$])(openPr|openIssue|openRun|openAgentTab|openRepoView)(?:\?\.)?\(/g;

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
  openInClone: {
    file: "src/features/projects/use-card-open.ts",
    head: /\basync function openInClone\s*\(/g,
    params: true,
    generation: "boardOpenGen",
    // The board's browser arms and its fork hop open no repository, so the
    // clone arm's claim is the file's only one.
    soleClaim: true,
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

/** Whether no bracket opened before `from` closes before `to`: the block holding
 *  `from` is still open at `to`. */
function stillOpen(body, from, to) {
  for (let i = from, depth = 0; i < to; i++) {
    if (OPEN.has(body[i])) depth++;
    else if (CLOSE.has(body[i]) && --depth < 0) return false;
  }
  return true;
}

/** `expr` split at its depth-0 `||`. */
function topLevelOr(expr) {
  const operands = [];
  let start = 0;
  for (let i = 0, depth = 0; i < expr.length; i++) {
    if (OPEN.has(expr[i])) depth++;
    else if (CLOSE.has(expr[i])) depth--;
    else if (depth === 0 && expr.startsWith("||", i)) {
      operands.push(expr.slice(start, i));
      start = i + 2;
      i++;
    }
  }
  return [...operands, expr.slice(start)];
}

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
  if (site.soleClaim) {
    const inFile = [...masked.matchAll(/(?<![\w$.])claimRepoOpen\s*\(/g)];
    if (inFile.length !== 1)
      problems.push(
        `${site.file} holds ${inFile.length} claimRepoOpen calls, not only ${name}'s`,
      );
    // The other claim routes, and an alias the count above can't see.
    for (const m of masked.matchAll(
      /(?<![\w$.])(reserveRepoOpen|claimRepoOpenOrder|claimWarmRepoShell)\s*\(/g,
    ))
      problems.push(`${site.file} takes another claim through ${m[1]}`);
    if (/(?<![\w$.])claimRepoOpen\s+as(?![\w$])/.test(masked))
      problems.push(`${site.file} imports claimRepoOpen under an alias`);
  }
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
  else {
    if (reads.length !== 2)
      problems.push(
        `${name}'s claim isn't read by its superseded, and only there`,
      );
    if (
      !topLevelOr(body.slice(sup.index + sup[0].length, supEnd)).some(
        (operand) => operand.trim() === "!claimed()",
      )
    )
      problems.push(
        `${name}'s superseded doesn't hold !claimed() as a whole operand of its top-level ||`,
      );
  }
  for (const nav of navs) {
    const call = nav[1];
    const awaits = [...body.slice(0, nav.index).matchAll(wordAt("await"))];
    const lastAwait = awaits.at(-1)?.index ?? 0;
    // A check counts only in a block still open at the call, so it runs on every
    // path that reaches the call.
    const checks = [
      ...body
        .slice(lastAwait, nav.index)
        .matchAll(/(?<![\w$.])if \(superseded\(\)\) return;/g),
    ]
      .map((m) => lastAwait + m.index)
      .filter((at) => stillOpen(body, at, nav.index));
    if (checks.length === 0)
      problems.push(
        `${name}'s ${call} call isn't preceded by a superseded() check after its last await, in a block still open at the call`,
      );
    else if (!checks.some((at) => /[;{}]$/.test(body.slice(0, at).trimEnd())))
      problems.push(
        `${name}'s ${call} call's superseded() check isn't a statement of its own`,
      );
    const argsOpen = nav.index + nav[0].length - 1;
    const argsClose = matchBrace(body, argsOpen);
    const args = argsClose === -1 ? "" : body.slice(argsOpen, argsClose);
    const shorthand = /(?<=[{,]\s*)stillValid\s*,/.exec(args);
    if (shorthand === null)
      problems.push(
        `${name}'s ${call} call doesn't pass its stillValid as the shorthand property`,
      );
    const named = [...args.matchAll(wordAt("stillValid"))].length;
    if (named !== 1)
      problems.push(
        `${name}'s ${call} call names stillValid ${named} times, want once`,
      );
    if (shorthand !== null && args.includes("...", shorthand.index))
      problems.push(
        `${name}'s ${call} call spreads after its stillValid, which can override it`,
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

/** `anchor`'s `stillValid,` line passed through a ternary that can drop it. */
const ternary = (anchor, cond) =>
  once(
    anchor,
    anchor.replace(
      "stillValid,",
      () => `stillValid: ${cond} ? undefined : stillValid,`,
    ),
  );

/** `anchor` with `line` added after it. */
const below = (anchor, line) => once(anchor, `${anchor}${line}`);

/** A store-qualified openRepoView call without stillValid, added just before
 *  `anchor` (a navigator call in a branch below every await and check). */
const qualified = (anchor, indent) =>
  once(
    anchor,
    `${indent}useUiStore.getState().openRepoView({ repoPath: "", repoName: "" });\n${anchor}`,
  );
const QUALIFIED = "a store-qualified openRepoView call without stillValid";
const OPTIONAL = "an optional openIssue?.( call without stillValid";

/** The check after the resolve, then the two landing arms (openItem, openInClone). */
const RESOLVED =
  '    if (superseded()) return;\n    if (landing.kind === "superseded") return;\n    if (landing.kind === "browser") {\n';

const ITEM_PR =
  "        beforeSelect: applyLens,\n        stillValid,\n      });\n    } else {";
const ITEM_ISSUE =
  "        number: item.number,\n        beforeSelect: applyLens,\n        stillValid,\n";
const CLONE_PR =
  "ref: String(target.number),\n        section: null,\n        carryHistory: true,\n        beforeSelect,\n        stillValid,\n";
const CLONE_ISSUE =
  "number: target.number,\n        carryHistory: true,\n        beforeSelect,\n        stillValid,\n";
/** The navigator calls inside a branch (openItem's and openInClone's else, the
 *  dock's repo arm), each below the site's last await and its check. */
const ITEM_ISSUE_CALL = "      openIssue({\n        repoPath: targetPath,\n";
const NAV_REPO_CALL = "        openRepoView({\n          ...target,\n";

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
      "    }\n    if (superseded()) return;\n",
      "    }\n",
    ),
    "a return between the claim and the first await": once(
      CLAIM,
      `${CLAIM}    if (gen < 0) return;\n`,
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
    "the openPr arm's stillValid behind a ternary": ternary(ITEM_PR, "gen > 0"),
    "the openIssue arm's stillValid behind a ternary": ternary(
      ITEM_ISSUE,
      "gen > 0",
    ),
    "the openIssue arm's stillValid under another key": once(
      ITEM_ISSUE,
      ITEM_ISSUE.replace("stillValid,", () => "valid: stillValid,"),
    ),
    "a spread after the openIssue arm's stillValid": below(
      ITEM_ISSUE,
      "        ...(opts ?? {}),\n",
    ),
    "the superseded check moved into the browser arm": once(
      RESOLVED,
      '    if (gen !== openGen || useUiStore.getState().view !== "mywork") return;\n    if (landing.kind === "superseded") return;\n    if (landing.kind === "browser") {\n      if (superseded()) return;\n',
    ),
    "the superseded check under a braceless condition": once(
      RESOLVED,
      '    if (opts?.preferWorktree) if (superseded()) return;\n    if (landing.kind === "superseded") return;\n    if (landing.kind === "browser") {\n',
    ),
    "superseded reads the claim only on a stale generation": once(
      "gen !== openGen || !claimed() || ",
      "gen !== openGen || (gen !== openGen && !claimed()) || ",
    ),
    "superseded reads the claim only while the wait is shown": once(
      "gen !== openGen || !claimed() || ",
      "gen !== openGen || (pendingGenRef.current === gen && !claimed()) || ",
    ),
    "a nested const shadow of stillValid": once(
      ITEM_ISSUE_CALL,
      `      const stillValid = () => true;\n${ITEM_ISSUE_CALL}`,
    ),
    [QUALIFIED]: qualified(ITEM_ISSUE_CALL, "      "),
    [OPTIONAL]: once(
      ITEM_ISSUE_CALL,
      `      useUiStore.getState().openIssue?.({ repoPath: "", repoName: "", number: 1 });\n${ITEM_ISSUE_CALL}`,
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
    "the openRun call's stillValid behind a ternary": ternary(
      "runId: t.runId,\n          carryHistory: true,\n          stillValid,\n",
      "gen > 0",
    ),
    "the openAgentTab call's stillValid behind a ternary": ternary(
      "openAgentTab({\n          ...target,\n          carryHistory: true,\n          stillValid,\n",
      "gen > 0",
    ),
    "the openRepoView call's stillValid behind a ternary": ternary(
      "tab: isRepoTab(t.tab) ? t.tab : undefined,\n          carryHistory: true,\n          stillValid,\n",
      "gen > 0",
    ),
    "the openPr call's stillValid behind a ternary": ternary(
      "        stillValid,\n        onApplied: () => markNotificationRead(n.id),\n      });\n    })()",
      "gen > 0",
    ),
    "the openRun call's target spread after its stillValid": once(
      "openRun({\n          ...target,\n          runId: t.runId,\n          carryHistory: true,\n          stillValid,\n",
      "openRun({\n          runId: t.runId,\n          carryHistory: true,\n          stillValid,\n          ...target,\n",
    ),
    "superseded reads the claim only on a stale generation": once(
      "      useUiStore.getState().interactionEpoch !== startEpoch ||\n      !claimed();\n",
      "      useUiStore.getState().interactionEpoch !== startEpoch ||\n      (gen !== clickGen && !claimed());\n",
    ),
    "a nested const shadow of stillValid": once(
      NAV_REPO_CALL,
      `        const stillValid = () => true;\n${NAV_REPO_CALL}`,
    ),
    [QUALIFIED]: qualified(NAV_REPO_CALL, "        "),
  },
  openInClone: {
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
    "a return between the claim and the first await": once(
      CLAIM,
      `${CLAIM}    if (gen < 0) return;\n`,
    ),
    "superseded no longer reads the claim": once("!claimed() || ", ""),
    "the superseded check after the resolve removed": once(
      "    });\n    if (superseded()) return;\n",
      "    });\n",
    ),
    "an await just before openIssue without a re-check": once(
      "      openIssue({\n        repoPath: targetPath,\n",
      "      await null;\n      openIssue({\n        repoPath: targetPath,\n",
    ),
    "the openPr arm drops stillValid": once(
      "        beforeSelect,\n        stillValid,\n      });\n    } else {",
      "        beforeSelect,\n      });\n    } else {",
    ),
    "the openIssue arm drops stillValid": once(
      "        number: target.number,\n        carryHistory: true,\n        beforeSelect,\n        stillValid,\n",
      "        number: target.number,\n        carryHistory: true,\n        beforeSelect,\n",
    ),
    "the claim read inside stillValid": once(
      "      gen === boardOpenGen &&\n",
      "      gen === boardOpenGen &&\n      claimed() &&\n",
    ),
    "superseded read inside stillValid": once(
      "      gen === boardOpenGen &&\n",
      "      gen === boardOpenGen &&\n      !superseded() &&\n",
    ),
    "stillValid without the generation": once(
      "      gen === boardOpenGen &&\n",
      "",
    ),
    "stillValid without the epoch": once(
      "      gen === boardOpenGen &&\n      useUiStore.getState().interactionEpoch === epochAtRequest;\n",
      "      gen === boardOpenGen;\n",
    ),
    "a second claim in the file, in openItem": once(
      "    const gen = bumpBoardOpenGen();\n",
      "    const gen = bumpBoardOpenGen();\n    claimRepoOpen();\n",
    ),
    "a second claim in the file, through reserveRepoOpen": once(
      "    const gen = bumpBoardOpenGen();\n",
      "    const gen = bumpBoardOpenGen();\n    reserveRepoOpen();\n",
    ),
    "a second claim in the file, through claimRepoOpenOrder": once(
      "    const gen = bumpBoardOpenGen();\n",
      "    const gen = bumpBoardOpenGen();\n    claimRepoOpenOrder();\n",
    ),
    "a second claim in the file, through claimWarmRepoShell": once(
      "    const gen = bumpBoardOpenGen();\n",
      '    const gen = bumpBoardOpenGen();\n    void claimWarmRepoShell("");\n',
    ),
    "a second claim in the file, through an aliased import": (s) =>
      once(
        "    const gen = bumpBoardOpenGen();\n",
        "    const gen = bumpBoardOpenGen();\n    claimOpen();\n",
      )(
        once(
          "import { claimRepoOpen } from",
          "import { claimRepoOpen, claimRepoOpen as claimOpen } from",
        )(s),
      ),
    "openInClone renamed": once(
      "async function openInClone(",
      "async function openClone(",
    ),
    "the openPr arm's stillValid behind a ternary": ternary(CLONE_PR, "here"),
    "the openIssue arm's stillValid behind a ternary": ternary(
      CLONE_ISSUE,
      "here",
    ),
    "an inline spread after the openPr arm's stillValid": below(
      CLONE_PR,
      "        ...(here ? { stillValid: undefined } : {}),\n",
    ),
    "a named spread after the openIssue arm's stillValid": below(
      CLONE_ISSUE,
      "        ...overrides,\n",
    ),
    "a getter after the openIssue arm's stillValid": below(
      CLONE_ISSUE,
      "        get stillValid() { return undefined; },\n",
    ),
    "the superseded check moved into the browser arm": once(
      RESOLVED,
      '    if (gen !== boardOpenGen || !boardShowing(repoPath)) return;\n    if (landing.kind === "superseded") return;\n    if (landing.kind === "browser") {\n      if (superseded()) return;\n',
    ),
    "the superseded check under an else": once(
      RESOLVED,
      '    if (landing.kind === "superseded") return;\n    else if (activeIsUpstream) if (superseded()) return;\n    if (landing.kind === "browser") {\n',
    ),
    "superseded reads the claim only on a stale generation": once(
      "gen !== boardOpenGen || !claimed() || ",
      "gen !== boardOpenGen || (gen !== boardOpenGen && !claimed()) || ",
    ),
    "a nested const shadow of stillValid": once(
      ITEM_ISSUE_CALL,
      `      const stillValid = () => true;\n${ITEM_ISSUE_CALL}`,
    ),
    [QUALIFIED]: qualified(ITEM_ISSUE_CALL, "      "),
  },
};

/** Mutants only one rule sees: every problem the pin reports names that rule. */
const SOLE = [
  ["openItem", "the openIssue arm's stillValid under another key", "shorthand"],
  [
    "openInClone",
    "a getter after the openIssue arm's stillValid",
    "names stillValid",
  ],
  [
    "openInClone",
    "a named spread after the openIssue arm's stillValid",
    "spreads after",
  ],
  [
    "openItem",
    "the superseded check under a braceless condition",
    "statement of its own",
  ],
  ["openInClone", "the superseded check under an else", "statement of its own"],
  ["openItem", OPTIONAL, "openIssue call"],
  ...Object.keys(SITES).flatMap((name) => [
    [name, QUALIFIED, "openRepoView call"],
    [
      name,
      "a nested const shadow of stillValid",
      "isn't exactly its generation",
    ],
  ]),
];

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

test("each mutant that only one rule sees fails on that rule alone", () => {
  for (const [name, label, rule] of SOLE) {
    const problems = claimProblems(
      name,
      MUTANTS[name][label](read(SITES[name].file)),
    );
    assert.ok(
      problems.length > 0 && problems.every((p) => p.includes(rule)),
      `${name} "${label}": ${problems}`,
    );
  }
});
