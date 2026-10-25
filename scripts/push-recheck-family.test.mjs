// Pins the push-like run-recheck family: every query hook whose mutation makes the
// forge receive a push of commits arms `recheckRunsAfterPush` (push-writes.ts),
// because the forge creates a push's runs a few seconds after the settle-time
// invalidation already read. Keyed on the CALLEE, not the hook: a new hook calling
// one of these api functions must arm the recheck or join the reasoned exclusions.
//
// The checker is a pure function over source text, so the suite feeds it the real
// files (must pass) and in-memory mutants (must fail) without touching disk. It
// fails closed: a roster callee, hook or file it can't find is a failure, never a
// skip, so a rename breaks this test instead of silently retiring the arm.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

/** The api functions whose backend command pushes commits to the forge. */
const ROSTER = [
  "gitPush",
  "gitPushTag",
  "gitMergeRemotePr",
  "gitFinishRemotePrResolve",
  "forgePrMerge",
  "ghPrUpdateBranch",
  "forgePrCreate",
  "forgePublishRepo",
];

/** The hooks that must arm the recheck, each with the condition that must guard
 *  every arm call in it (null = armed on every success). */
const ARMED = {
  usePush: { file: "sync.ts", gate: null },
  usePushTag: { file: "tags-releases.ts", gate: null },
  useMergeRemotePr: {
    file: "pr-resolve.ts",
    gate: 'if (data.status === "pushed")',
  },
  useFinishRemotePrResolve: {
    file: "pr-resolve.ts",
    gate: 'if (data.status === "pushed")',
  },
  useMergePr: {
    file: "pr-actions.ts",
    gate: 'if (args.lens === "origin" && !data.queued)',
  },
  usePrUpdateBranch: { file: "pr-actions.ts", gate: null },
  useCreatePr: { file: "pr-write.ts", gate: null },
  usePublishRepo: { file: "remotes.ts", gate: null },
};

/** Push-adjacent writes that deliberately arm nothing, each with its reason. */
const EXCLUDED = {
  useDeleteRemoteBranch: {
    file: "branches.ts",
    reason:
      "pushes a deletion, which starts runs only for rare on-delete workflows; it schedules the PR-list re-read instead",
    mustCall: "recheckPrListAfterRemoteDelete(",
  },
  useDeleteTagOnOrigin: {
    file: "tags-releases.ts",
    reason:
      "pushes a deletion, which starts runs only for rare on-delete workflows",
    mustCall: null,
  },
  useCreateLinkedBranch: {
    file: "issues.ts",
    reason:
      "creates a server-side ref at an existing commit: nothing is pushed, no runs start",
    mustCall: null,
  },
};

/** The second update-branch arm, which fires on the observed head move. */
const SETTLE_ARM = {
  file: "features/pulls/RemotePrView.tsx",
  start: "const settleUpdate = useEffectEvent(",
  call: "recheckRunsAfterPush(queryClient, repoPath)",
};

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

/** Problems found in `raw` (queries file name → text, plus SETTLE_ARM.file); empty
 *  means the family holds. Line endings are normalized and comments blanked first:
 *  a Windows checkout is CRLF, and a commented-out arm is no arm. */
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
  const queryFiles = Object.keys(sources).filter((f) => !f.includes("/"));
  if (queryFiles.length === 0)
    return [...problems, "no queries sources to scan"];

  // Keyed by file and name, so a same-named unit elsewhere can't stand in.
  const hooks = new Map();
  for (const file of queryFiles)
    for (const [name, body] of topLevelUnits(sources[file]))
      hooks.set(`${file}#${name}`, { file, name, body });
  const listed = (table, file, name) => table[name]?.file === file;

  const calledCallees = new Set();
  for (const { file, name, body } of hooks.values()) {
    const callees = ROSTER.filter((c) => namesCallee(body, c));
    for (const c of callees) calledCallees.add(c);
    const armed = listed(ARMED, file, name);
    if (callees.length > 0 && !armed && !listed(EXCLUDED, file, name))
      problems.push(
        `${file} ${name}: calls ${callees.join(", ")} but neither arms recheckRunsAfterPush nor is a reasoned exclusion`,
      );
    const isDefinition =
      file === "push-writes.ts" && name === "recheckRunsAfterPush";
    if (armCalls(body) > 0 && !armed && !isDefinition)
      problems.push(
        `${file} ${name}: arms recheckRunsAfterPush outside the family`,
      );
  }
  for (const c of ROSTER)
    if (!calledCallees.has(c)) problems.push(`roster callee ${c} not found`);

  for (const [name, { file, gate }] of Object.entries(ARMED)) {
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
    if (!body.includes(SETTLE_ARM.call) || armCalls(body) === 0)
      problems.push(
        `${SETTLE_ARM.file}: settleUpdate does not arm the recheck`,
      );
  }
  return problems;
}

const SRC = new URL("../src/", import.meta.url);
const QUERIES = new URL("lib/git/queries/", SRC);

/** LF-normalized, so the mutants below match the same lines the checker reads. */
function realSources() {
  const read = (url) => readFileSync(url, "utf8").replace(/\r\n/g, "\n");
  const sources = {};
  for (const file of readdirSync(QUERIES).filter((f) => f.endsWith(".ts")))
    sources[file] = read(new URL(file, QUERIES));
  sources[SETTLE_ARM.file] = read(new URL(SETTLE_ARM.file, SRC));
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
  const sources = mutate(realSources(), "pr-actions.ts", (text) =>
    text.replace(" && !data.queued", ""),
  );
  assert.ok(
    checkPushRecheckFamily(sources).some((p) => p.includes("useMergePr")),
  );
});

test("a new hook calling a roster callee without arming fails the check", () => {
  const sources = mutate(
    realSources(),
    "sync.ts",
    (text) =>
      `${text}\nexport function useSneakyPush(repo: string) {\n  return useRepoMutation(repo, () => api.gitPush(repo, false, false));\n}\n`,
  );
  assert.ok(
    checkPushRecheckFamily(sources).some((p) => p.includes("useSneakyPush")),
  );
});

test("an exclusion that arms the recheck, or a renamed hook, fails the check", () => {
  const armed = mutate(realSources(), "tags-releases.ts", (text) =>
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
  const renamed = mutate(realSources(), "remotes.ts", (text) =>
    text.replace(
      "export function usePublishRepo(",
      "export function usePublish(",
    ),
  );
  assert.ok(
    checkPushRecheckFamily(renamed).some((p) => p.includes("usePublishRepo")),
  );
});

test("the remote-branch delete must schedule the PR-list re-read", () => {
  const sources = mutate(realSources(), "branches.ts", (text) =>
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
      mutate(realSources(), "tags-releases.ts", edit),
    );
    assert.ok(
      problems.some((p) => p.includes("usePushTag")),
      JSON.stringify(problems),
    );
  }
  const view = mutate(realSources(), SETTLE_ARM.file, (text) =>
    text.replace(`${SETTLE_ARM.call};`, `// ${SETTLE_ARM.call};`),
  );
  assert.ok(
    checkPushRecheckFamily(view).some((p) => p.includes("settleUpdate")),
  );
});

test("a roster callee passed by reference counts as a call", () => {
  const sources = mutate(
    realSources(),
    "sync.ts",
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
    const sources = mutate(realSources(), "remotes.ts", (text) => text + code);
    assert.ok(
      checkPushRecheckFamily(sources).some((p) => p.includes(name)),
      name,
    );
  }
});

test("a gate that is present but does not guard the arm fails the check", () => {
  const sources = mutate(realSources(), "pr-actions.ts", (text) =>
    text.replace(
      /if \(args\.lens === "origin" && !data\.queued\)\s*recheckRunsAfterPush\(queryClient, repo\);/,
      'if (args.lens === "origin" && !data.queued) void 0;\n        recheckRunsAfterPush(queryClient, repo);',
    ),
  );
  const problems = checkPushRecheckFamily(sources);
  assert.ok(
    problems.some((p) => p.includes("useMergePr") && p.includes("guarded")),
    JSON.stringify(problems),
  );
});

test("an empty corpus or a missing view fails closed", () => {
  assert.notDeepEqual(checkPushRecheckFamily({}), []);
  const { [SETTLE_ARM.file]: _view, ...noView } = realSources();
  assert.ok(
    checkPushRecheckFamily(noView).some((p) => p.includes("settleUpdate")),
  );
});
