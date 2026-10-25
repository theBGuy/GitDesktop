// Pins the push-like run-recheck family: every hook whose write's own default
// trigger starts CI for the code it touches (pushing commits or tags; opening,
// reopening, landing or updating a pull request; publishing a release or
// repository; creating a branch; dispatching a workflow; re-running, playing or
// approving a run) arms `recheckRunsAfterPush` (push-writes.ts), because the run
// can appear, or flip status, after the settle-time read. Workflows keyed on other
// events (labels, comments, reviews, ready-for-review, release deletion, Pages
// builds) are out of scope; deletion pushes and cancel are reasoned exclusions.
// The arms flagged `prChecks` also hand the recheck PR checks reads
// (`prChecksRecheck`) as one of its arguments. Keyed on the CALLEE, not the hook:
// a new unit naming one of these api functions must arm the recheck or join the
// reasoned exclusions.
//
// The checker is a pure function over source text, so the suite feeds it the real
// files (must pass) and in-memory mutants (must fail) without touching disk. It
// fails closed: a roster callee, hook or file it can't find is a failure, never a
// skip, so a rename breaks this test instead of silently retiring the arm.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

/** The api functions of writes whose own default trigger starts CI for the code
 *  they touch (the boundary in the header). */
const ROSTER = [
  "gitPush",
  "gitPushTag",
  "gitMergeRemotePr",
  "gitFinishRemotePrResolve",
  "forgePrMerge",
  "ghPrUpdateBranch",
  "forgePrCreate",
  "forgePrReopen",
  "forgePublishRepo",
  "forgeReleaseCreate",
  "forgeReleaseEdit",
  "ghIssueCreateLinkedBranch",
  "forgeCiDispatch",
  "forgeGlMrAutoMerge",
  "forgeCiRunRerun",
  "forgeCiJobRerun",
  "forgeGlCiPlayJob",
  "forgeCiRunApprove",
];

/** Run writes the rule leaves out on purpose: a unit naming one must be a reasoned
 *  exclusion (or armed). */
const RUN_STATUS_CALLEES = ["forgeCiRunCancel"];

const Q = "lib/git/queries/";
/** Corpus paths, relative to `src/`. */
const CORPUS_FILES = ["lib/github/actions.ts"];

const DRAFT_GATE = "if (!args.draft)";

/** The hooks that must arm the recheck: the condition that must guard every arm
 *  call in it (null = armed on every success), whether its arm calls hand the PR's
 *  checks reads along, and whether they hand them for BOTH lenses (an arm that
 *  names no PR or lens covers origin and upstream). */
const ARMED = {
  usePush: {
    file: `${Q}sync.ts`,
    gate: null,
    prChecks: true,
    bothLenses: true,
  },
  usePushTag: { file: `${Q}tags-releases.ts`, gate: null, prChecks: false },
  useMergeRemotePr: {
    file: `${Q}pr-resolve.ts`,
    gate: 'if (data.status === "pushed")',
    prChecks: true,
  },
  useFinishRemotePrResolve: {
    file: `${Q}pr-resolve.ts`,
    gate: 'if (data.status === "pushed")',
    prChecks: true,
  },
  useMergePr: {
    file: `${Q}pr-actions.ts`,
    gate: 'if (args.lens === "origin" && !data.queued)',
    prChecks: true,
  },
  usePrUpdateBranch: { file: `${Q}pr-actions.ts`, gate: null, prChecks: true },
  useReopenPr: { file: `${Q}pr-actions.ts`, gate: null, prChecks: true },
  useGlArmAutoMerge: { file: `${Q}pr-actions.ts`, gate: null, prChecks: true },
  useCreatePr: { file: `${Q}pr-write.ts`, gate: null, prChecks: true },
  usePublishRepo: { file: `${Q}remotes.ts`, gate: null, prChecks: false },
  useCreateRelease: {
    file: `${Q}tags-releases.ts`,
    gate: DRAFT_GATE,
    prChecks: false,
  },
  useEditRelease: {
    file: `${Q}tags-releases.ts`,
    gate: DRAFT_GATE,
    prChecks: false,
  },
  useCreateLinkedBranch: {
    file: `${Q}issues.ts`,
    gate: 'if (lens === "origin")',
    prChecks: false,
  },
  useRunWorkflow: {
    file: "lib/github/actions.ts",
    gate: null,
    prChecks: false,
  },
  useRerunRun: {
    file: "lib/github/actions.ts",
    gate: null,
    prChecks: true,
    bothLenses: true,
  },
  useRerunJob: {
    file: "lib/github/actions.ts",
    gate: null,
    prChecks: true,
    bothLenses: true,
  },
  usePlayCiJob: {
    file: "lib/github/actions.ts",
    gate: null,
    prChecks: true,
    bothLenses: true,
  },
  useApproveWorkflowRun: {
    file: `${Q}pr-actions.ts`,
    gate: null,
    prChecks: true,
    bothLenses: true,
  },
};

const BOTH_LENSES = [
  /\bprChecksRecheck\(repo, "origin"\)/,
  /\bprChecksRecheck\(repo, "upstream"\)/,
];

/** Writes that deliberately arm nothing, each with its reason. */
const EXCLUDED = {
  useDeleteRemoteBranch: {
    file: `${Q}branches.ts`,
    reason:
      "pushes a deletion, which starts runs only for rare on-delete workflows; it schedules the PR-list re-read instead",
    mustCall: "recheckPrListAfterRemoteDelete(",
  },
  useDeleteTagOnOrigin: {
    file: `${Q}tags-releases.ts`,
    reason:
      "pushes a deletion, which starts runs only for rare on-delete workflows",
    mustCall: null,
  },
  useCancelRun: {
    file: "lib/github/actions.ts",
    reason:
      "stops a run rather than starting one, so it is outside the rule; GitHub keeps the run active until the cancel lands, so the active-run poll sees it end",
    mustCall: null,
  },
};

/** The second update-branch arm, which fires on the observed head move and hands
 *  the PR's checks reads along like the hook's own. */
const SETTLE_ARM = {
  file: "features/pulls/RemotePrView.tsx",
  start: "const settleUpdate = useEffectEvent(",
  call: /recheckRunsAfterPush\(\s*queryClient,\s*repoPath,\s*prChecksRecheck\(repoPath, lens, number\),?\s*\)/,
};

/** The argument text of every `recheckRunsAfterPush(…)` call in `body`, matched by
 *  paren depth. */
function armCallArgs(body) {
  const out = [];
  const opener = /\brecheckRunsAfterPush\(/g;
  for (const m of body.matchAll(opener)) {
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    while (i < body.length && depth > 0) {
      if (body[i] === "(") depth++;
      else if (body[i] === ")") depth--;
      i++;
    }
    out.push(depth === 0 ? body.slice(start, i - 1) : body.slice(start));
  }
  return out;
}

const PR_CHECKS = /\bprChecksRecheck\(/;

const RECHECK_CALL = /\brecheckRunsAfterPush\(/g;
const armCalls = (body) => body.match(RECHECK_CALL)?.length ?? 0;

/** A roster callee named anywhere in a body, called or passed by reference. */
const namesCallee = (body, callee) => new RegExp(`\\b${callee}\\b`).test(body);

/** `text` with every comment blanked (newlines kept, so line anchors hold). Strings
 *  and template literals are skipped whole, and a backslash outside them (a regex
 *  literal's escape) takes its next character along, so `\//` opens no comment. */
function stripComments(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "\\") {
      out += text.slice(i, i + 2);
      i += 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const DECLARATION =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?\s+(\w+)|(?:const|let|var)\s+(\w+))/;

/** Every top-level function and const/let binding of `text`, name → its text. A
 *  unit runs from its column-0 declaration line to the next column-0 line that
 *  starts any other statement; closing brackets stay with the unit they close. */
function topLevelUnits(text) {
  const units = new Map();
  let current = null;
  const flush = () => {
    if (current) units.set(current.name, current.lines.join("\n"));
  };
  for (const line of text.split("\n")) {
    const startsStatement = /^[^\s)\]}]/.test(line);
    if (startsStatement) {
      flush();
      const m = DECLARATION.exec(line);
      current = m ? { name: m[1] ?? m[2], lines: [line] } : null;
    } else if (current) current.lines.push(line);
  }
  flush();
  return units;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** How many arm calls sit directly under `gate` (`if (…) call` or `if (…) { call`). */
function guardedArmCalls(body, gate) {
  const guarded = new RegExp(
    `${escapeRe(gate)}\\s*(?:\\{\\s*)?recheckRunsAfterPush\\(`,
    "g",
  );
  return body.match(guarded)?.length ?? 0;
}

/** Problems found in `raw` (src-relative path → text: the queries package, the
 *  CORPUS_FILES, and SETTLE_ARM.file); empty means the family holds. Line endings
 *  are normalized and comments blanked first: a Windows checkout is CRLF, and a
 *  commented-out arm is no arm. */
function checkPushRecheckFamily(raw) {
  const problems = [];
  const sources = {};
  for (const [file, text] of Object.entries(raw)) {
    if (typeof text !== "string") problems.push(`${file}: unreadable source`);
    else sources[file] = text.replace(/\r\n/g, "\n");
  }
  // The view is stripped only within settleUpdate below: its JSX text carries
  // apostrophes this string-skipping scan would read as quotes.
  for (const file of Object.keys(sources))
    if (file !== SETTLE_ARM.file) sources[file] = stripComments(sources[file]);
  const queryFiles = Object.keys(sources).filter((f) => f !== SETTLE_ARM.file);
  if (!queryFiles.some((f) => f.startsWith(Q)))
    return [...problems, "no queries sources to scan"];
  for (const f of CORPUS_FILES)
    if (!(f in sources)) problems.push(`${f}: missing from the corpus`);

  // Keyed by file and name, so a same-named unit elsewhere can't stand in.
  const hooks = new Map();
  for (const file of queryFiles)
    for (const [name, body] of topLevelUnits(sources[file]))
      hooks.set(`${file}#${name}`, { file, name, body });
  const listed = (table, file, name) => table[name]?.file === file;

  const calledCallees = new Set();
  for (const { file, name, body } of hooks.values()) {
    // A callee's own definition (`export const forgeCiDispatch = …`) names it.
    const callees = [...ROSTER, ...RUN_STATUS_CALLEES].filter(
      (c) => c !== name && namesCallee(body, c),
    );
    for (const c of callees) calledCallees.add(c);
    const armed = listed(ARMED, file, name);
    if (callees.length > 0 && !armed && !listed(EXCLUDED, file, name))
      problems.push(
        `${file} ${name}: calls ${callees.join(", ")} but neither arms recheckRunsAfterPush nor is a reasoned exclusion`,
      );
    const isDefinition =
      file === `${Q}push-writes.ts` && name === "recheckRunsAfterPush";
    if (armCalls(body) > 0 && !armed && !isDefinition)
      problems.push(
        `${file} ${name}: arms recheckRunsAfterPush outside the family`,
      );
  }
  for (const c of [...ROSTER, ...RUN_STATUS_CALLEES])
    if (!calledCallees.has(c)) problems.push(`roster callee ${c} not found`);

  for (const [name, { file, gate, prChecks, bothLenses }] of Object.entries(
    ARMED,
  )) {
    const hook = hooks.get(`${file}#${name}`);
    if (!hook) {
      problems.push(`${file} ${name}: hook not found`);
      continue;
    }
    if (!ROSTER.some((c) => namesCallee(hook.body, c)))
      problems.push(`${file} ${name}: calls no roster callee`);
    const arms = armCalls(hook.body);
    if (arms === 0)
      problems.push(`${file} ${name}: does not arm recheckRunsAfterPush`);
    else if (gate !== null && guardedArmCalls(hook.body, gate) !== arms)
      problems.push(
        `${file} ${name}: an arm call is not guarded by \`${gate}\``,
      );
    // Positional: the builder must be an argument of the arm call itself, not a
    // value computed beside it.
    const args = armCallArgs(hook.body);
    if (
      bothLenses &&
      !args.every((a) => BOTH_LENSES.every((lens) => lens.test(a)))
    )
      problems.push(
        `${file} ${name}: an arm call does not hand both lenses' PR checks reads`,
      );
    const handing = args.map((a) => PR_CHECKS.test(a));
    if (prChecks && (handing.length === 0 || handing.includes(false)))
      problems.push(
        `${file} ${name}: an arm call does not hand the recheck the PR's checks reads`,
      );
    if (!prChecks && PR_CHECKS.test(hook.body))
      problems.push(`${file} ${name}: hands the recheck the PR's checks reads`);
  }

  for (const [name, { file, reason, mustCall }] of Object.entries(EXCLUDED)) {
    const hook = hooks.get(`${file}#${name}`);
    if (!hook) {
      problems.push(`${file} ${name}: excluded hook not found`);
      continue;
    }
    if (!reason) problems.push(`${file} ${name}: exclusion has no reason`);
    if (mustCall && !hook.body.includes(mustCall))
      problems.push(`${file} ${name}: does not call ${mustCall.slice(0, -1)}`);
  }

  const view = sources[SETTLE_ARM.file];
  const at = typeof view === "string" ? view.indexOf(SETTLE_ARM.start) : -1;
  if (at < 0) problems.push(`${SETTLE_ARM.file}: settleUpdate not found`);
  else {
    const end = view.indexOf("\n  });", at);
    const body = stripComments(view.slice(at, end < 0 ? undefined : end));
    if (!SETTLE_ARM.call.test(body) || armCalls(body) === 0)
      problems.push(
        `${SETTLE_ARM.file}: settleUpdate does not arm the recheck`,
      );
  }
  return problems;
}

const SRC = new URL("../src/", import.meta.url);

/** LF-normalized, so the mutants below match the same lines the checker reads. */
function realSources() {
  const read = (path) =>
    readFileSync(new URL(path, SRC), "utf8").replace(/\r\n/g, "\n");
  const sources = {};
  for (const file of readdirSync(new URL(Q, SRC)).filter((f) =>
    f.endsWith(".ts"),
  ))
    sources[`${Q}${file}`] = read(`${Q}${file}`);
  for (const path of [...CORPUS_FILES, SETTLE_ARM.file])
    sources[path] = read(path);
  return sources;
}

/** `sources` with `file`'s text passed through `edit`, asserting it changed. */
function mutate(sources, file, edit) {
  const next = edit(sources[file]);
  assert.notEqual(next, sources[file], `mutant of ${file} changed nothing`);
  return { ...sources, [file]: next };
}

/** Disarms the recheck inside one hook's body only. */
function disarmHook(sources, file, name) {
  return mutate(sources, file, (text) => {
    const body = topLevelUnits(text).get(name);
    assert.ok(body, `${name} not found in ${file}`);
    return text.replace(
      body,
      body.replaceAll("recheckRunsAfterPush(", "noRecheck("),
    );
  });
}

test("the real sources hold the push-like recheck family", () => {
  assert.deepEqual(checkPushRecheckFamily(realSources()), []);
});

test("removing any one armed hook's recheck fails the check", () => {
  const sources = realSources();
  for (const [name, { file }] of Object.entries(ARMED)) {
    const problems = checkPushRecheckFamily(disarmHook(sources, file, name));
    assert.ok(
      problems.some((p) => p.includes(name)),
      `${name}: expected a failure, got ${JSON.stringify(problems)}`,
    );
  }
});

test("removing the settleUpdate arm fails the check", () => {
  const sources = mutate(realSources(), SETTLE_ARM.file, (text) =>
    text.replace(SETTLE_ARM.call, "noRecheck(queryClient, repoPath)"),
  );
  assert.ok(
    checkPushRecheckFamily(sources).some((p) => p.includes("settleUpdate")),
  );
});

test("dropping a gate fails the check", () => {
  const sources = mutate(realSources(), `${Q}pr-actions.ts`, (text) =>
    text.replace(" && !data.queued", ""),
  );
  assert.ok(
    checkPushRecheckFamily(sources).some((p) => p.includes("useMergePr")),
  );
});

test("a flipped release gate or a dropped origin gate fails the check", () => {
  for (const [file, from, to, name] of [
    [
      `${Q}tags-releases.ts`,
      "if (!args.draft) recheckRunsAfterPush(",
      "if (args.draft) recheckRunsAfterPush(",
      "useCreateRelease",
    ],
    [
      `${Q}issues.ts`,
      'if (lens === "origin") recheckRunsAfterPush(',
      "recheckRunsAfterPush(",
      "useCreateLinkedBranch",
    ],
  ]) {
    const sources = mutate(realSources(), file, (text) =>
      text.replace(from, to),
    );
    assert.ok(
      checkPushRecheckFamily(sources).some(
        (p) => p.includes(name) && p.includes("not guarded"),
      ),
      name,
    );
  }
});

test("a both-lens arm that drops a lens fails the check", () => {
  for (const [file, name] of [
    [`${Q}sync.ts`, "usePush"],
    [`${Q}pr-actions.ts`, "useApproveWorkflowRun"],
    ["lib/github/actions.ts", "useRerunRun"],
  ]) {
    const sources = mutate(realSources(), file, (text) => {
      const body = topLevelUnits(text).get(name);
      assert.ok(body, `${name} not found in ${file}`);
      return text.replace(
        body,
        body.replace('...prChecksRecheck(repo, "upstream"),', ""),
      );
    });
    assert.ok(
      checkPushRecheckFamily(sources).some(
        (p) => p.includes(name) && p.includes("both lenses"),
      ),
      name,
    );
  }
});

test("an arm that stops handing the PR's checks reads fails the check", () => {
  const sources = realSources();
  const handing = Object.entries(ARMED).filter(([, a]) => a.prChecks);
  assert.ok(handing.length > 0);
  for (const [name, { file }] of handing) {
    const mutant = mutate(sources, file, (text) => {
      const body = topLevelUnits(text).get(name);
      assert.ok(body, `${name} not found in ${file}`);
      return text.replace(
        body,
        body.replace(/prChecksRecheck\([^)]*\)/g, "[]"),
      );
    });
    assert.ok(
      checkPushRecheckFamily(mutant).some(
        (p) => p.includes(name) && p.includes("does not hand"),
      ),
      name,
    );
  }
  const view = mutate(sources, SETTLE_ARM.file, (text) =>
    text.replace("prChecksRecheck(repoPath, lens, number)", "[]"),
  );
  assert.ok(
    checkPushRecheckFamily(view).some((p) => p.includes("settleUpdate")),
  );
});

test("a plain arm that hands PR checks reads fails the check", () => {
  const sources = mutate(realSources(), `${Q}tags-releases.ts`, (text) =>
    text.replace(
      "onSuccess: () => recheckRunsAfterPush(queryClient, repo),",
      'onSuccess: () => recheckRunsAfterPush(queryClient, repo, prChecksRecheck(repo, "origin")),',
    ),
  );
  assert.ok(
    checkPushRecheckFamily(sources).some(
      (p) => p.includes("usePushTag") && p.includes("hands"),
    ),
  );
});

test("a new hook calling a roster callee without arming fails the check", () => {
  for (const [file, name, call] of [
    [`${Q}sync.ts`, "useSneakyPush", "api.gitPush(repo, false, false)"],
    [
      "lib/github/actions.ts",
      "useSneakyDispatch",
      'forgeCiDispatch(repo, "ci.yml", "main", {})',
    ],
    [`${Q}pr-actions.ts`, "useSneakyArm", "api.forgeGlMrAutoMerge(repo, 1)"],
  ]) {
    const sources = mutate(
      realSources(),
      file,
      (text) =>
        `${text}\nexport function ${name}(repo: string) {\n  return useRepoMutation(repo, () => ${call});\n}\n`,
    );
    assert.ok(
      checkPushRecheckFamily(sources).some((p) => p.includes(name)),
      name,
    );
  }
});

test("an exclusion that arms the recheck, or a renamed hook, fails the check", () => {
  const armed = mutate(realSources(), `${Q}tags-releases.ts`, (text) =>
    text.replace(
      '{ identity: releaseWriteKey("delete-origin-tag", repo) }',
      '{ identity: releaseWriteKey("delete-origin-tag", repo), onSuccess: () => recheckRunsAfterPush(queryClient, repo) }',
    ),
  );
  assert.ok(
    checkPushRecheckFamily(armed).some((p) =>
      p.includes("useDeleteTagOnOrigin"),
    ),
  );
  for (const [file, from, to, name] of [
    [
      `${Q}remotes.ts`,
      "export function usePublishRepo(",
      "export function usePublish(",
      "usePublishRepo",
    ],
    [
      "lib/github/actions.ts",
      "export function useRunWorkflow(",
      "export function useDispatch(",
      "useRunWorkflow",
    ],
  ]) {
    const renamed = mutate(realSources(), file, (text) =>
      text.replace(from, to),
    );
    assert.ok(
      checkPushRecheckFamily(renamed).some((p) => p.includes(name)),
      name,
    );
  }
});

test("the remote-branch delete must schedule the PR-list re-read", () => {
  const sources = mutate(realSources(), `${Q}branches.ts`, (text) =>
    text.replace(
      "recheckPrListAfterRemoteDelete(queryClient",
      "noop(queryClient",
    ),
  );
  assert.ok(
    checkPushRecheckFamily(sources).some((p) =>
      p.includes("useDeleteRemoteBranch"),
    ),
  );
});

test("a commented-out arm is no arm", () => {
  const line = "    onSuccess: () => recheckRunsAfterPush(queryClient, repo),";
  for (const edit of [
    (text) => text.replace(line, `    // ${line.trim()}`),
    (text) => text.replace(line, `    /* ${line.trim()} */`),
  ]) {
    const problems = checkPushRecheckFamily(
      mutate(realSources(), `${Q}tags-releases.ts`, edit),
    );
    assert.ok(
      problems.some((p) => p.includes("usePushTag")),
      JSON.stringify(problems),
    );
  }
  const view = mutate(realSources(), SETTLE_ARM.file, (text) =>
    text.replace(SETTLE_ARM.call, (call) => `/* ${call} */`),
  );
  assert.ok(
    checkPushRecheckFamily(view).some((p) => p.includes("settleUpdate")),
  );
});

test("a roster callee passed by reference counts as a call", () => {
  const sources = mutate(
    realSources(),
    `${Q}sync.ts`,
    (text) =>
      `${text}\nexport function useRefPush(repo: string) {\n  return useRepoMutation(repo, api.gitPush);\n}\n`,
  );
  assert.ok(
    checkPushRecheckFamily(sources).some((p) => p.includes("useRefPush")),
  );
});

test("a non-exported helper or const arrow calling a roster callee must arm", () => {
  const helpers = [
    [
      "pushHelper",
      `\nfunction pushHelper(repo: string) {\n  return api.gitPushTag(repo, "v1");\n}\n`,
    ],
    [
      "pushArrow",
      `\nconst pushArrow = (repo: string) =>\n  api.forgePrCreate(repo, "main", "head");\n`,
    ],
  ];
  for (const [name, code] of helpers) {
    const sources = mutate(
      realSources(),
      `${Q}remotes.ts`,
      (text) => text + code,
    );
    assert.ok(
      checkPushRecheckFamily(sources).some((p) => p.includes(name)),
      name,
    );
  }
});

test("a gate that is present but does not guard the arm fails the check", () => {
  const gate = 'if (args.lens === "origin" && !data.queued)';
  const sources = mutate(realSources(), `${Q}pr-actions.ts`, (text) =>
    text.replace(gate, `${gate} void 0;`),
  );
  const problems = checkPushRecheckFamily(sources);
  assert.ok(
    problems.some((p) => p.includes("useMergePr") && p.includes("guarded")),
    JSON.stringify(problems),
  );
});

test("an empty corpus, a missing corpus file or a missing view fails closed", () => {
  assert.notDeepEqual(checkPushRecheckFamily({}), []);
  const { [SETTLE_ARM.file]: _view, ...noView } = realSources();
  assert.ok(
    checkPushRecheckFamily(noView).some((p) => p.includes("settleUpdate")),
  );
  const { "lib/github/actions.ts": _actions, ...noActions } = realSources();
  assert.ok(
    checkPushRecheckFamily(noActions).some((p) =>
      p.includes("lib/github/actions.ts: missing from the corpus"),
    ),
  );
});

test("PR checks reads computed beside the arm call, not passed to it, fail the check", () => {
  const sources = mutate(realSources(), `${Q}pr-write.ts`, (text) => {
    const body = topLevelUnits(text).get("useCreatePr");
    assert.ok(body, "useCreatePr not found");
    const moved = body
      .replace(/prChecksRecheck\([^)]*\),/, "[],")
      .replace(
        "const queryClient = useQueryClient();",
        'const queryClient = useQueryClient();\n  void prChecksRecheck(repo, "origin");',
      );
    return text.replace(body, moved);
  });
  const problems = checkPushRecheckFamily(sources);
  assert.ok(
    problems.some(
      (p) => p.includes("useCreatePr") && p.includes("does not hand"),
    ),
    JSON.stringify(problems),
  );
});

test("a run write must arm or be a reasoned exclusion", () => {
  for (const [name, call] of [
    ["useSneakyRerun", "forgeCiRunRerun(repo, id, false)"],
    ["useSneakyCancel", "forgeCiRunCancel(repo, id)"],
  ]) {
    const sources = mutate(
      realSources(),
      "lib/github/actions.ts",
      (text) =>
        `${text}\nexport function ${name}(repo: string) {\n  return useActionsMutation(repo, (id: number) => ${call}, "rerun-run");\n}\n`,
    );
    assert.ok(
      checkPushRecheckFamily(sources).some((p) => p.includes(name)),
      name,
    );
  }
  for (const [from, to, name] of [
    [
      "export function usePlayCiJob(",
      "export function usePlay(",
      "usePlayCiJob",
    ],
    [
      "export function useCancelRun(",
      "export function useStop(",
      "useCancelRun",
    ],
  ]) {
    const renamed = mutate(realSources(), "lib/github/actions.ts", (text) =>
      text.replace(from, to),
    );
    assert.ok(
      checkPushRecheckFamily(renamed).some((p) => p.includes(name)),
      name,
    );
  }
});
