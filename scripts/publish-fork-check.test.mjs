// Pins the publish routes' fork-PR check shape: the publish prompt opens once
// the LOCAL reads finish while the check runs alongside, and only Push waits on
// it. Both detection routes (SyncControls' beginPush, BranchSwitcher's
// beginPublishBranch) share one two-phase machine: before the ask a settle only
// records, the decision reads that record after the last await, and once the
// prompt is up a settle swaps it for the fork guard, releases its hold, or is
// dropped. Source pins over whitespace-normalized text, each with an in-memory
// mutant proving it can fail; an unreadable file or a missing anchor is a
// problem, never a pass.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const SYNC = "src/features/repository/SyncControls.tsx";
const SWITCHER = "src/features/repository/BranchSwitcher.tsx";

/** The file's text with LF endings, or null when it can't be read. */
function source(rel) {
  try {
    return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(
      /\r\n/g,
      "\n",
    );
  } catch {
    return null;
  }
}

/** Full-line comments dropped, whitespace collapsed, and the formatter's
 *  wrapping undone (padding inside brackets, trailing commas, chained calls). */
const norm = (text) =>
  text
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s+/g, " ")
    .replace(/([([{]) /g, "$1")
    .replace(/ ([)\]}])/g, "$1")
    .replace(/,([)\]}])/g, "$1")
    .replace(/ \./g, ".");

/** A component-level function's text, from its signature to its closing brace
 *  at the component's indent; null when either is missing. */
function fnBody(src, name) {
  for (const sig of [`async function ${name}(`, `function ${name}(`]) {
    const start = src.indexOf(sig);
    if (start === -1) continue;
    const end = src.indexOf("\n  }\n", start);
    return end === -1 ? null : src.slice(start, end + 4);
  }
  return null;
}

/** The brace-matched block opening at `text[open]`, or null when unclosed. */
function blockAt(text, open) {
  if (text[open] !== "{") return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(open, i + 1);
  }
  return null;
}

/** The body block of the arrow function assigned at `decl` in `body`. */
function arrowBlock(body, decl) {
  const at = body.indexOf(decl);
  if (at === -1) return null;
  const arrow = body.indexOf("=> {", at);
  return arrow === -1 ? null : blockAt(body, arrow + 3);
}

const ROUTES = [
  {
    file: SYNC,
    fn: "beginPush",
    repo: "pushedIn",
    refusal: "refuseWhilePushing()",
    push: "void doPush(",
    waitClosed: false,
  },
  {
    file: SWITCHER,
    fn: "beginPublishBranch",
    repo: "publishIn",
    refusal: "pushAlreadyActive()",
    push: "void runPushBranch(",
    waitClosed: true,
  },
];

const CHECK = "const check = forgeDetectForkPrForBranch(";
const READS = "await Promise.all([";
const DECIDE = "releaseMark(); if (probe.settled && probe.found) {";
const ASK = "const answer = askPublishConfirm(";
const SETTLE =
  "{probe.settled = true; probe.found = m; releaseMark(); if (asked !== null) onPromptSettle(m); return m;}";
const OUTER_GUARD =
  "asked = publishAsk.current; if (!probe.settled) {timer = setTimeout(";
const INNER_GUARD =
  "setTimeout(() => {if (!probe.settled) useConfirm.getState().setRequestHold(asked, {note: PUBLISH_FORK_CHECK_NOTE});}, PUBLISH_FORK_CHECK_BOUND_MS);";
const BOUND_CLEAR = "void answer.finally(() => clearTimeout(timer));";
const DECLS = [
  "let asked: ConfirmRequest | null = null;",
  "let timer: ReturnType<typeof setTimeout> | undefined;",
  "const probe = {settled: false, found: null as ForkPrMatch | null};",
  "const releaseMark = () => {",
  "const onPromptSettle = (m: ForkPrMatch | null) => {",
];

function routeProblems(route, src) {
  const p = (m) => `${route.fn}: ${m}`;
  if (src === null) return [p("source unreadable")];
  const raw = fnBody(src, route.fn);
  if (raw === null) return [p("not found")];
  const body = norm(raw);
  const out = [];
  const at = (needle, from = 0) => body.indexOf(needle, from);

  // (1) The check starts, un-awaited, before the local reads.
  const check = at(CHECK);
  const reads = at(READS);
  if (check === -1) out.push(p("no un-awaited check"));
  if (reads === -1) out.push(p("no local-reads block"));
  if (body.includes("await forgeDetectForkPrForBranch("))
    out.push(p("the check is awaited"));
  if (check !== -1 && reads !== -1) {
    if (check > reads) out.push(p("the check starts after the local reads"));
    else if (body.slice(check, reads).includes("await "))
      out.push(p("an await precedes the local reads"));
  }

  // (3d) Route state sits at function scope, declared before the check.
  for (const decl of DECLS) {
    const i = at(decl);
    if (i === -1 || (check !== -1 && i > check))
      out.push(p(`not declared before the check: ${decl}`));
  }

  // (3a) The settle records, fires the latch, and dispatches phase 2 only.
  const thenAt = check === -1 ? -1 : at(".then((m) => {", check);
  const settle =
    thenAt === -1 ? null : blockAt(body, thenAt + ".then((m) => ".length);
  if (settle !== SETTLE) out.push(p(`settle is not record-only: ${settle}`));

  // (3b) The decision: after the last await, nothing awaited before the ask.
  const decide = at(DECIDE);
  const ask = at(ASK);
  if (decide === -1) out.push(p("no decision point"));
  if (ask === -1) out.push(p("no held ask"));
  if (decide !== -1 && ask !== -1) {
    if (decide > ask) out.push(p("the decision follows the ask"));
    else if (body.slice(decide, ask).includes("await "))
      out.push(p("an await sits between the decision and the ask"));
  }
  if (decide !== -1 && reads !== -1 && decide < reads)
    out.push(p("the decision precedes the local reads"));
  if (
    route.waitClosed &&
    !body.includes(
      `await listClose.waitClosed(); if (switchedAway()) {releaseMark(); return;} ${DECIDE}`,
    )
  )
    out.push(p("the decision is not after waitClosed and switchedAway"));
  const askArgs =
    ask === -1 ? "" : body.slice(ask, body.indexOf("publishAsk);", ask));
  if (
    !askArgs.includes(
      "heldReason: probe.settled ? undefined : PUBLISH_FORK_CHECK_REASON",
    )
  )
    out.push(p("the ask's hold is not decided from the record"));

  // (2)/(3c) The bound: armed only while unsettled, self-guarding, and cleared
  // through the answer's promise chain.
  if (!body.includes(OUTER_GUARD))
    out.push(p("the bound is armed without a !probe.settled guard"));
  if (!body.includes(INNER_GUARD))
    out.push(p("the bound's callback does not re-check !probe.settled"));
  if (!body.includes(BOUND_CLEAR))
    out.push(p("the bound is not cleared by the answer's .finally"));
  if (body.split("setTimeout(").length !== 2) out.push(p("not one bound"));
  if (body.includes("finally {"))
    out.push(p("a try/finally statement (a compiler bailout)"));

  // D9: every create-arm exit between the reads and the ask releases first.
  if (reads !== -1 && ask !== -1) {
    const seg = body.slice(reads, ask);
    let prev = -1;
    for (
      let i = seg.indexOf("return;");
      i !== -1;
      i = seg.indexOf("return;", i + 1)
    ) {
      if (seg.lastIndexOf("releaseMark();", i) <= prev)
        out.push(p(`create-arm exit without releaseMark at ${i}`));
      prev = i;
    }
  }

  // (4) The swap gate: the ask's own request, still showing, in its repo;
  // anything else drops silently (never refuseIfSwitched, which toasts).
  const onSettle = arrowBlock(body, "const onPromptSettle = (");
  if (onSettle === null) out.push(p("no settle handler"));
  else if (onSettle.includes("refuseIfSwitched"))
    out.push(p("the settle handler toasts through refuseIfSwitched"));
  else if (
    onSettle !==
    `{clearTimeout(timer); if (m === null) {useConfirm.getState().setRequestHold(asked, {}); return;} if (asked !== null && useConfirm.getState().request === asked && landedIn(${route.repo}).live) {withdrawPublishConfirm(publishAsk); openGuard(m);}}`
  )
    out.push(p(`the settle handler drifted: ${onSettle}`));

  // (5) Promptless arm: the full await, then every refusal, then guard or push.
  const order = [
    "const match = await check; releaseMark();",
    `landedIn(${route.repo});`,
    "if (!live) {",
    `if (${route.refusal} || refuseWhilePublishing(queryClient, repoPath)) return;`,
    "if (match) {withdrawPublishConfirm(publishAsk); openGuard(match); return;}",
    route.push,
  ];
  let from = 0;
  for (const step of order) {
    const i = at(step, from);
    if (i === -1) {
      out.push(p(`promptless arm out of order at: ${step}`));
      break;
    }
    from = i + step.length;
  }

  // (8) One spelling of the copy and the bound, imported from publish-confirm.
  // The REASON and NOTE sentences are matched file-wide; the generic fragments
  // (`hasn't finished`, `10_000`) only in the route, where they can't collide.
  if (
    /Checking for a pull request from a fork|The check for a fork pull request/.test(
      src,
    ) ||
    /hasn't finished|10_000/.test(body)
  )
    out.push(p("re-spells a PUBLISH_FORK_CHECK_* value"));
  const imp = src.match(/import \{([^}]*)\} from "\.\/publish-confirm";/);
  for (const name of [
    "PUBLISH_FORK_CHECK_BOUND_MS",
    "PUBLISH_FORK_CHECK_NOTE",
    "PUBLISH_FORK_CHECK_REASON",
  ])
    if (!imp || !imp[1].split(",").some((s) => s.trim() === name))
      out.push(p(`${name} not imported from publish-confirm`));
  return out;
}

/** (6) BranchSwitcher's own-mark exemption, in its one sanctioned form, and
 *  the mark cleared only by the release latch. */
function switcherProblems(src) {
  if (src === null) return ["BranchSwitcher: source unreadable"];
  const out = [];
  const active = fnBody(src, "pushAlreadyActive");
  if (active === null) out.push("pushAlreadyActive: not found");
  else if (
    !norm(active).includes(
      "{if (publishDetectRef.current === mine) return refuseWhilePushRuns(queryClient, repoPath); if (publishDetectRef.current?.repo === repoPath) {",
    )
  )
    out.push(
      "pushAlreadyActive: no publishDetectRef.current === mine exemption",
    );
  // Keep local: the listed route re-checks the row its fresh read returned.
  // Each route's refusal before that read is pinned by the Vitest rows in
  // src/test/branch-switcher-keep-local.test.tsx.
  const listed = fnBody(src, "pushListedBranchToOrigin");
  if (listed === null) out.push("pushListedBranchToOrigin: not found");
  else {
    const flat = norm(listed);
    if (
      !flat.includes(
        "if (refuseKeptLocalPush(freshRow)) return; pushBranchToOrigin(row, true);",
      )
    )
      out.push("pushListedBranchToOrigin: the fresh row is not re-checked");
  }
  const raw = fnBody(src, "beginPublishBranch");
  if (raw === null) return [...out, "beginPublishBranch: not found"];
  const body = norm(raw);
  if (
    !body.includes(
      "if (pushAlreadyActive(mine) || refuseWhilePublishing(queryClient, repoPath)) {releaseMark(); return;}",
    )
  )
    out.push(
      "beginPublishBranch: the pre-ask refusal doesn't exempt its own mark",
    );
  const release = arrowBlock(body, "const releaseMark = () => {");
  if (
    release !==
    "{if (!marked) return; marked = false; if (publishDetectRef.current === mine) publishDetectRef.current = null; setPublishDetect((cur) => (cur === mine ? null : cur));}"
  )
    out.push(`beginPublishBranch: the release latch drifted: ${release}`);
  if (body.split("publishDetectRef.current = null").length !== 2)
    out.push("beginPublishBranch: the mark clears outside the release latch");
  return out;
}

/** (7) SyncControls' busy narrowing: only Push waits on the check. */
function syncProblems(src) {
  if (src === null) return ["SyncControls: source unreadable"];
  const out = [];
  const busyAt = src.indexOf("const ownBusy =");
  const ownBusy =
    busyAt === -1 ? null : src.slice(busyAt, src.indexOf(";", busyAt));
  if (ownBusy === null) out.push("SyncControls: no ownBusy");
  else if (/\bdetecting\b/.test(ownBusy))
    out.push("SyncControls: detecting holds the whole bar (in ownBusy)");
  const flat = norm(src);
  if (
    !flat.includes(
      "const pushHold = detecting && !sync.push.disabled ? {disabled: true, reason: PUBLISH_FORK_CHECK_REASON} : sync.push;",
    )
  )
    out.push("SyncControls: no Push-hold overlay under derive's own holds");
  const sites = (s) => flat.split(s).length - 1;
  if (
    sites("disabled={pushHold.disabled}") !== 2 ||
    sites("reason={pushHold.reason}") !== 2
  )
    out.push("SyncControls: the overlay is not at both Push render sites");
  if (sites("disabled={sync.push.disabled}") !== 0)
    out.push("SyncControls: a Push render site skips the overlay");
  if (!flat.includes("hotkeys.push && !publishPending && !detecting)"))
    out.push("SyncControls: the push hotkey ignores the check");
  if (
    !flat.includes(
      'useHotkeyAction("push", () => {if (sync.pushKeptLocalReason) {toast.info(sync.pushKeptLocalReason); return;} if (!refuseWhilePushing()) pressPush();}, hotkeys.push && !publishPending && !detecting);',
    )
  )
    out.push("SyncControls: the push hotkey skips the Keep local refusal");
  // The force confirm's Keep local hold: the shared helper decides it, and the
  // confirm button's disabled and reason both read it first.
  if (
    !flat.includes(
      "const forceKeptBranch = forceConfirmKeptBranch(forceConfirm?.branch ?? null, keptHead);",
    )
  )
    out.push("SyncControls: the force confirm's hold skips its helper");
  if (!flat.includes("disabled={forceKeptBranch !== null ||"))
    out.push("SyncControls: the force confirm's button isn't held first");
  if (
    !flat.includes(
      'reason={(() => {switch (true) {case forceKeptBranch !== null: return keptLocalReason(forceKeptBranch, "push");',
    )
  )
    out.push("SyncControls: the force confirm's reason isn't Keep local first");
  // The ref mirror: read only in handlers, written only by the shift helper.
  const shift = arrowBlock(flat, "const shiftDetections = (");
  const begin = fnBody(src, "beginPush");
  if (shift === null || begin === null)
    out.push("SyncControls: no shiftDetections or beginPush");
  else if (
    flat
      .replace(shift, "")
      .replace(norm(begin), "")
      .includes("detectionsRef.current")
  )
    out.push("SyncControls: detectionsRef read outside its handlers");
  if (
    begin !== null &&
    !norm(begin).includes(
      "if (refuseWhileOffline()) return; if ((detectionsRef.current[repoPath] ?? 0) > 0) return;",
    )
  )
    out.push("SyncControls: beginPush has no fire-time re-entry guard");
  if (/const \{\s*\[/.test(src))
    out.push("SyncControls: a computed-key destructure (a compiler bailout)");
  return out;
}

function problems(sources) {
  return [
    ...ROUTES.flatMap((r) => routeProblems(r, sources[r.file])),
    ...switcherProblems(sources[SWITCHER]),
    ...syncProblems(sources[SYNC]),
  ];
}

const realSources = () => ({
  [SYNC]: source(SYNC),
  [SWITCHER]: source(SWITCHER),
});

/** `sources` with `from` replaced by `to` in `file`; throws when the fixture
 *  no longer applies, so a stale mutant can't pass by doing nothing. */
function mutate(sources, file, from, to) {
  const text = sources[file];
  const next =
    typeof from === "string"
      ? text.replace(from, () => to)
      : text.replace(from, (...m) => to(...m));
  assert.notEqual(next, text, `fixture didn't apply in ${file}: ${from}`);
  return { ...sources, [file]: next };
}

function failsWith(sources, needle) {
  const found = problems(sources);
  assert.ok(
    found.some((m) => m.includes(needle)),
    `expected "${needle}" in ${JSON.stringify(found)}`,
  );
}

test("both publish routes keep the two-phase fork check, and only Push waits", () => {
  assert.deepEqual(problems(realSources()), []);
});

test("unreadable sources and missing routes fail closed", () => {
  const real = realSources();
  failsWith({ ...real, [SYNC]: null }, "beginPush: source unreadable");
  failsWith({ ...real, [SWITCHER]: null }, "BranchSwitcher: source unreadable");
  failsWith(
    mutate(
      real,
      SYNC,
      "async function beginPush(",
      "async function beginPushX(",
    ),
    "beginPush: not found",
  );
  failsWith(
    mutate(
      real,
      SWITCHER,
      "function pushAlreadyActive(",
      "function pushIsActive(",
    ),
    "pushAlreadyActive: not found",
  );
});

const TIMER_DECL = "let timer: ReturnType<typeof setTimeout> | undefined;";

for (const route of ROUTES) {
  const { file, fn } = route;
  test(`${fn}: each pin catches its mutant`, () => {
    const real = realSources();
    // (1) the check awaited before the local reads
    failsWith(
      mutate(
        real,
        file,
        "    const check = forgeDetectForkPrForBranch(",
        "    const check = await forgeDetectForkPrForBranch(",
      ),
      `${fn}: the check is awaited`,
    );
    failsWith(
      mutate(
        real,
        file,
        /(\n {4}const \[list, fetchUrl, pushUrl\] = await Promise\.all)/,
        (_m, g) => `\n    await check;${g}`,
      ),
      `${fn}: an await precedes the local reads`,
    );
    // (3d) state declared only after the check starts
    failsWith(
      mutate(
        mutate(real, file, `\n    ${TIMER_DECL}`, ""),
        file,
        /(\n {4}\/\/ (?:A named publish|The HEAD arm publishes))/,
        (_m, g) => `\n    ${TIMER_DECL}${g}`,
      ),
      `${fn}: not declared before the check: let timer`,
    );
    // (3a) a pre-ask settle that opens the guard
    failsWith(
      mutate(
        real,
        file,
        "        if (asked !== null) onPromptSettle(m);",
        "        if (m) openGuard(m);",
      ),
      `${fn}: settle is not record-only`,
    );
    // (3b) an await between the decision and the ask
    failsWith(
      mutate(
        real,
        file,
        `      const answer = askPublishConfirm(`,
        `      await Promise.resolve();\n      const answer = askPublishConfirm(`,
      ),
      `${fn}: an await sits between the decision and the ask`,
    );
    failsWith(
      mutate(
        real,
        file,
        "heldReason: probe.settled ? undefined : PUBLISH_FORK_CHECK_REASON",
        "heldReason: PUBLISH_FORK_CHECK_REASON",
      ),
      `${fn}: the ask's hold is not decided from the record`,
    );
    // (2) each !probe.settled guard on the bound
    failsWith(
      mutate(
        real,
        file,
        /if \(!probe\.settled\) \{(\s*timer = setTimeout)/,
        (_m, g) => `{${g}`,
      ),
      `${fn}: the bound is armed without a !probe.settled guard`,
    );
    failsWith(
      mutate(real, file, /if \(!probe\.settled\)(\s*useConfirm)/, (_m, g) => g),
      `${fn}: the bound's callback does not re-check !probe.settled`,
    );
    failsWith(
      mutate(
        real,
        file,
        "void answer.finally(() => clearTimeout(timer));",
        "void answer;",
      ),
      `${fn}: the bound is not cleared by the answer's .finally`,
    );
    failsWith(
      mutate(
        real,
        file,
        "      const ok = await answer;",
        "      try {} finally {}\n      const ok = await answer;",
      ),
      `${fn}: a try/finally statement`,
    );
    // D9: a create-arm exit that keeps the mark
    failsWith(
      mutate(
        real,
        file,
        /\{\s*releaseMark\(\);\s*return;\s*\}/,
        () => "return;",
      ),
      `${fn}: create-arm exit without releaseMark`,
    );
    // (4) the swap gate: a toasting switch check, and a dropped identity term
    failsWith(
      mutate(
        real,
        file,
        /landedIn\((pushedIn|publishIn)\)\.live\s*\) \{/,
        (_m, r) => `!refuseIfSwitched(${r}, "nothing was published")) {`,
      ),
      `${fn}: the settle handler toasts through refuseIfSwitched`,
    );
    failsWith(
      mutate(
        real,
        file,
        /asked !== null &&\s*useConfirm\.getState\(\)\.request === asked &&/,
        () => "asked !== null &&",
      ),
      `${fn}: the settle handler drifted`,
    );
    // (5) the promptless arm's refusals after the await
    failsWith(
      mutate(
        real,
        file,
        /\n {6}if \((refuseWhilePushing|pushAlreadyActive)\(\) \|\| refuseWhilePublishing\(queryClient, repoPath\)\)\n {8}return;/,
        () => "",
      ),
      `${fn}: promptless arm out of order at: if (`,
    );
    // (8) a re-spelled constant
    failsWith(
      mutate(
        real,
        file,
        "heldReason: probe.settled ? undefined : PUBLISH_FORK_CHECK_REASON",
        'heldReason: probe.settled ? undefined : "Checking for a pull request from a fork"',
      ),
      `${fn}: re-spells a PUBLISH_FORK_CHECK_* value`,
    );
    failsWith(
      mutate(real, file, "}, PUBLISH_FORK_CHECK_BOUND_MS);", "}, 10_000);"),
      `${fn}: re-spells a PUBLISH_FORK_CHECK_* value`,
    );
    failsWith(
      mutate(
        real,
        file,
        "note: PUBLISH_FORK_CHECK_NOTE",
        `note: "The check for a fork pull request hasn't finished."`,
      ),
      `${fn}: re-spells a PUBLISH_FORK_CHECK_* value`,
    );
    // (8) is scoped to the route: the same spelling elsewhere in the file passes
    const outside = {
      ...real,
      [file]: `${real[file]}\nconst other = 10_000;\n`,
    };
    assert.deepEqual(problems(outside), []);
    // ...but the REASON and NOTE sentences are caught anywhere in the file
    failsWith(
      {
        ...real,
        [file]: `${real[file]}\nconst other = "Checking for a pull request from a fork";\n`,
      },
      `${fn}: re-spells a PUBLISH_FORK_CHECK_* value`,
    );
    failsWith(
      {
        ...real,
        [file]: `${real[file]}\nconst other = "The check for a fork pull request hasn't finished.";\n`,
      },
      `${fn}: re-spells a PUBLISH_FORK_CHECK_* value`,
    );
    failsWith(
      mutate(real, file, "  PUBLISH_FORK_CHECK_NOTE,\n", ""),
      `${fn}: PUBLISH_FORK_CHECK_NOTE not imported from publish-confirm`,
    );
    // (1) the check started after the local reads
    failsWith(
      mutate(
        real,
        file,
        "    const check = forgeDetectForkPrForBranch(",
        "    await Promise.all([]);\n    const check = forgeDetectForkPrForBranch(",
      ),
      `${fn}: the check starts after the local reads`,
    );
    // (3b) the ask made before the decision, and a decision before the reads
    const beforeReads = (text) =>
      mutate(
        real,
        file,
        /(\n {4}const \[list, fetchUrl, pushUrl\] = await Promise\.all)/,
        (_m, g) => `\n${text}${g}`,
      );
    failsWith(
      beforeReads("    { const answer = askPublishConfirm(); void answer; }"),
      `${fn}: the decision follows the ask`,
    );
    failsWith(
      beforeReads(
        "    releaseMark();\n    if (probe.settled && probe.found) {\n    }",
      ),
      `${fn}: the decision precedes the local reads`,
    );
    if (route.waitClosed)
      failsWith(
        mutate(real, file, "      await listClose.waitClosed();\n", ""),
        `${fn}: the decision is not after waitClosed and switchedAway`,
      );
    // (2) a second timer in the route
    failsWith(
      beforeReads("    setTimeout(() => {}, 0);"),
      `${fn}: not one bound`,
    );
    // (4) a settle handler that is no longer an arrow
    failsWith(
      mutate(
        real,
        file,
        "const onPromptSettle = (m: ForkPrMatch | null) => {",
        "const onPromptSettle = function (m: ForkPrMatch | null) {",
      ),
      `${fn}: no settle handler`,
    );
  });
}

test("BranchSwitcher: the own-mark exemption's mutants are caught", () => {
  const real = realSources();
  failsWith(
    mutate(
      real,
      SWITCHER,
      "    if (publishDetectRef.current === mine)\n      return refuseWhilePushRuns(queryClient, repoPath);\n",
      "",
    ),
    "pushAlreadyActive: no publishDetectRef.current === mine exemption",
  );
  failsWith(
    mutate(
      real,
      SWITCHER,
      "pushAlreadyActive(mine) ||",
      "pushAlreadyActive() ||",
    ),
    "the pre-ask refusal doesn't exempt its own mark",
  );
  // Clearing the ref early instead of exempting it blinds the other routes.
  failsWith(
    mutate(
      real,
      SWITCHER,
      "    const check = forgeDetectForkPrForBranch(publishIn",
      "    publishDetectRef.current = null;\n    const check = forgeDetectForkPrForBranch(publishIn",
    ),
    "the mark clears outside the release latch",
  );
  failsWith(
    mutate(
      real,
      SWITCHER,
      "      if (!marked) return;\n      marked = false;\n      if (publishDetectRef",
      "      if (publishDetectRef",
    ),
    "the release latch drifted",
  );
});

test("SyncControls: the busy-narrowing mutants are caught", () => {
  const real = realSources();
  failsWith(
    mutate(
      real,
      SYNC,
      "    hardReset.isPending ||\n    recovery.pending ||",
      "    hardReset.isPending ||\n    detecting ||\n    recovery.pending ||",
    ),
    "detecting holds the whole bar",
  );
  failsWith(
    mutate(
      real,
      SYNC,
      /disabled=\{pushHold\.disabled\}\s*reason=\{pushHold\.reason\}/,
      () =>
        "disabled={sync.push.disabled}\n            reason={sync.push.reason}",
    ),
    "the overlay is not at both Push render sites",
  );
  failsWith(
    mutate(real, SYNC, "detecting && !sync.push.disabled", "detecting"),
    "no Push-hold overlay",
  );
  failsWith(
    mutate(
      real,
      SYNC,
      "hotkeys.push && !publishPending && !detecting,",
      "hotkeys.push && !publishPending,",
    ),
    "the push hotkey ignores the check",
  );
  failsWith(
    mutate(
      real,
      SYNC,
      "const detecting = (detections[repoPath] ?? 0) > 0;",
      "const detecting = (detectionsRef.current[repoPath] ?? 0) > 0;",
    ),
    "detectionsRef read outside its handlers",
  );
  failsWith(
    mutate(
      real,
      SYNC,
      "    if ((detectionsRef.current[repoPath] ?? 0) > 0) return;\n",
      "",
    ),
    "beginPush has no fire-time re-entry guard",
  );
  failsWith(
    mutate(
      real,
      SYNC,
      "    const n = (detectionsRef.current[repo] ?? 0) + by;",
      "    const { [repo]: n0 = 0 } = detectionsRef.current;\n    const n = n0 + by;",
    ),
    "a computed-key destructure",
  );
});

test("the sync push hotkey refuses a kept-local branch and the listed route re-checks its fresh row", () => {
  const real = realSources();
  failsWith(
    mutate(real, SYNC, "if (sync.pushKeptLocalReason) {", "if (false) {"),
    "SyncControls: the push hotkey skips the Keep local refusal",
  );
  failsWith(
    mutate(
      real,
      SWITCHER,
      "    if (refuseKeptLocalPush(freshRow)) return;\n",
      "",
    ),
    "pushListedBranchToOrigin: the fresh row is not re-checked",
  );
  failsWith(
    mutate(
      real,
      SWITCHER,
      "async function pushListedBranchToOrigin(",
      "async function renamedRoute(",
    ),
    "pushListedBranchToOrigin: not found",
  );
});

test("the force confirm holds a kept-local branch through the shared helper", () => {
  const real = realSources();
  failsWith(
    mutate(
      real,
      SYNC,
      "const forceKeptBranch = forceConfirmKeptBranch(",
      "const forceKeptBranch = ((_b, h) => h)(",
    ),
    "SyncControls: the force confirm's hold skips its helper",
  );
  failsWith(
    mutate(
      real,
      SYNC,
      /disabled=\{\s*forceKeptBranch !== null \|\|/,
      () => "disabled={",
    ),
    "SyncControls: the force confirm's button isn't held first",
  );
  failsWith(
    mutate(
      real,
      SYNC,
      /case forceKeptBranch !== null:\s*return keptLocalReason\(forceKeptBranch, "push"\);/,
      () => "",
    ),
    "SyncControls: the force confirm's reason isn't Keep local first",
  );
});
