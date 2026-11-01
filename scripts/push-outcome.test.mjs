// Pins what a branch push's success toast may claim. The outcome is decided
// BEFORE the push from last-fetch presence (the push IPC reports no
// created-vs-updated signal), so "Published" needs a create decided from a
// presence that SAID absent; an unread or unreadable presence says "Pushed".
// The wiring pins below read the component sources, with in-memory mutants
// proving each pin can fail.
//
// Out of contract: a stale remote-tracking ref (the remote branch was deleted
// since the last fetch). The toast claims what presence said; nothing here
// asserts beyond the table.
//
// The import reaches straight into `src/` under Node's type stripping, which
// resolves no bundler aliases: `branch-sync-state.ts` must stay import-free.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  pushOutcome,
  pushSuccessCopy,
  pushWouldCreate,
  willCreateOnRemote,
} from "../src/features/repository/branch-sync-state.ts";

const source = (rel) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n",
  );

test("pushOutcome: the truth table", () => {
  const rows = [
    [{ willPublish: false, create: true, presence: false }, "pushed"],
    [{ willPublish: false, create: undefined, presence: undefined }, "pushed"],
    [
      { willPublish: true, create: false, presence: true },
      "updated-and-tracking",
    ],
    [{ willPublish: true, create: true, presence: false }, "created"],
    [{ willPublish: true, create: true, presence: undefined }, "unknown"],
    [{ willPublish: true, create: undefined, presence: undefined }, "unknown"],
    [{ willPublish: true, create: undefined, presence: false }, "unknown"],
  ];
  for (const [input, want] of rows) {
    assert.equal(pushOutcome(input), want, JSON.stringify(input));
  }
});

// Each create route's input shape, decided the way the route decides it.
test("every create route: undefined presence never says created", () => {
  const untracked = { upstream: null, upstreamGone: false };
  const gone = { upstream: "origin/x", upstreamGone: true };
  const tracked = { upstream: "origin/y", upstreamGone: false };
  const routes = {
    // beginPush and beginPublishBranch: willCreateOnRemote over the facts.
    beginPush: (presence) =>
      willCreateOnRemote({ ...untracked, remoteHasSameName: presence }),
    beginPublishBranch: (presence) =>
      willCreateOnRemote({ ...gone, remoteHasSameName: presence }),
    // pushFromMenu: an explicit retrack of a tracked branch.
    pushFromMenu: (presence) =>
      willCreateOnRemote({
        ...tracked,
        setUpstream: true,
        remoteHasSameName: presence,
      }),
    // beginBarePush: only its create arm toasts.
    beginBarePush: (presence) =>
      pushWouldCreate({ pushRemote: "origin", pushBranch: "x", presence }),
  };
  for (const [route, decide] of Object.entries(routes)) {
    const outcome = (presence) =>
      pushOutcome({ willPublish: true, create: decide(presence), presence });
    assert.equal(outcome(false), "created", route);
    assert.equal(outcome(undefined), "unknown", route);
    if (route !== "beginBarePush") {
      assert.equal(outcome(true), "updated-and-tracking", route);
    }
  }
});

for (const away of ["", " in harbor"]) {
  test(`pushSuccessCopy rows verbatim (away ${JSON.stringify(away)})`, () => {
    const base = { branch: "feature", remote: "origin", away };
    assert.deepEqual(
      pushSuccessCopy({ ...base, outcome: "created", tracks: true }),
      { title: `Published feature to origin${away}` },
    );
    assert.deepEqual(
      pushSuccessCopy({
        ...base,
        outcome: "created",
        remoteBranch: "feat-2",
        tracks: false,
      }),
      { title: `Published feature to origin as feat-2${away}` },
    );
    assert.deepEqual(
      pushSuccessCopy({
        ...base,
        outcome: "updated-and-tracking",
        tracks: true,
      }),
      {
        title: `Pushed feature to origin/feature${away}`,
        description: "feature now tracks origin/feature.",
      },
    );
    assert.deepEqual(
      pushSuccessCopy({ ...base, outcome: "unknown", tracks: true }),
      {
        title: `Pushed feature to origin${away}`,
        description: "feature now tracks origin/feature.",
      },
    );
    assert.deepEqual(
      pushSuccessCopy({
        ...base,
        outcome: "unknown",
        remoteBranch: "feat-2",
        tracks: false,
      }),
      { title: `Pushed feature to origin/feat-2${away}` },
    );
    assert.deepEqual(
      pushSuccessCopy({ ...base, outcome: "unknown", tracks: false }),
      { title: `Pushed feature to origin/feature${away}` },
    );
    assert.equal(
      pushSuccessCopy({ ...base, outcome: "pushed", tracks: true }),
      null,
    );
  });
}

test("no unknown or updated row ever says Published", () => {
  for (const outcome of ["updated-and-tracking", "unknown"]) {
    for (const tracks of [true, false]) {
      const copy = pushSuccessCopy({
        outcome,
        branch: "b",
        remote: "r",
        tracks,
        away: "",
      });
      assert.doesNotMatch(copy.title, /Published/);
    }
  }
});

/** The body of a two-space-indented function inside the component. */
function functionBody(src, signature) {
  const start = src.indexOf(signature);
  if (start === -1) return null;
  const end = src.indexOf("\n  }\n", start);
  if (end === -1) return null;
  return src.slice(start, end);
}

const SYNC_CONTROLS = "src/features/repository/SyncControls.tsx";
const BRANCH_SWITCHER = "src/features/repository/BranchSwitcher.tsx";

function syncProblems(text) {
  const problems = [];
  const doPush = functionBody(text, "async function doPush(");
  if (doPush === null) problems.push("doPush not found");
  else {
    if (!doPush.includes("pushSuccessCopy(")) {
      problems.push("doPush: no pushSuccessCopy");
    }
    if (
      !/if \(force\)\s*toast\.success\(`Force pushed\$\{away\}`[\s\S]*?\}\);\s*else if \(outcome !== undefined/.test(
        doPush,
      )
    ) {
      problems.push("doPush: force toast without away, or outcome not !force");
    }
  }
  const bare = functionBody(text, "async function beginBarePush(");
  if (bare === null) problems.push("beginBarePush not found");
  else {
    if (!bare.includes("pushSuccessCopy(")) {
      problems.push("beginBarePush: no pushSuccessCopy");
    }
    if (bare.includes("toast.success(`Pushed ${branch} to ${pushRemote}/")) {
      problems.push("beginBarePush: unconditional Pushed literal");
    }
  }
  const menu = functionBody(text, "async function pushFromMenu(");
  if (menu === null) problems.push("pushFromMenu not found");
  else {
    if (menu.includes("`Published ${branch} to ${remote} —")) {
      problems.push("pushFromMenu: unconditional Published literal");
    }
    if (!/outcome === "created"\s*\?/.test(menu)) {
      problems.push("pushFromMenu: created tail not gated on the outcome");
    }
    if (!menu.includes("`Pushed ${branch} to ${remote}/${remoteBranch}${")) {
      problems.push("pushFromMenu: tracked toast without away");
    }
  }
  return problems;
}

function switcherProblems(text) {
  const problems = [];
  const run = functionBody(text, "async function runPushBranch(");
  if (run === null) return ["runPushBranch not found"];
  if (!run.includes("pushSuccessCopy(")) {
    problems.push("runPushBranch: no pushSuccessCopy");
  }
  if (/willPublish\(branch\)/.test(run) || /publishing\s*\?/.test(run)) {
    problems.push("runPushBranch: labels from willPublish");
  }
  if (!run.includes("`Pushed ${branch.name} to ${branch.upstream}${away}`")) {
    problems.push("runPushBranch: tracked toast without away");
  }
  return problems;
}

test("the live sources toast through pushSuccessCopy", () => {
  assert.deepEqual(syncProblems(source(SYNC_CONTROLS)), []);
  assert.deepEqual(switcherProblems(source(BRANCH_SWITCHER)), []);
});

test("mutants restoring the old labels are caught", () => {
  const sync = source(SYNC_CONTROLS);
  const switcher = source(BRANCH_SWITCHER);
  const run = functionBody(switcher, "async function runPushBranch(");
  const switcherMutants = [
    switcher.replace(
      run,
      `${run}\n    const publishing = willPublish(branch);\n    toast.success(publishing ? "a" : "b");`,
    ),
    switcher.replace(
      "`Pushed ${branch.name} to ${branch.upstream}${away}`",
      "`Pushed ${branch.name} to ${branch.upstream}`",
    ),
  ];
  for (const mutant of switcherMutants) {
    assert.notEqual(mutant, switcher);
    assert.notDeepEqual(switcherProblems(mutant), []);
  }
  const syncMutants = [
    sync.replace("`Force pushed${away}`", '"Force pushed"'),
    sync.replace("else if (outcome !== undefined", "if (outcome !== undefined"),
    sync.replace('outcome === "created"', "true"),
    sync.replace(
      "`Published ${branch} to ${remote}${away} — ",
      "`Published ${branch} to ${remote} — ",
    ),
    sync.replace(
      "`Pushed ${branch} to ${remote}/${remoteBranch}${landedIn(capture.repo).away}`",
      "`Pushed ${branch} to ${remote}/${remoteBranch}`",
    ),
  ];
  for (const mutant of syncMutants) {
    assert.notEqual(mutant, sync);
    assert.notDeepEqual(syncProblems(mutant), []);
  }
});

// Per-route argument pins: each route hands pushOutcome the exact facts its
// create decision read, and each toasting route reads landedIn only after its
// push settles. Out of reach: a route that reaches pushOutcome through another
// helper, and a presence value the reads themselves compute wrongly.

/** Whitespace collapsed, dropped inside bracket edges, trailing commas gone. */
const norm = (text) =>
  text
    .replace(/\s+/g, " ")
    .replace(/([([{]) /g, "$1")
    .replace(/ ([)\]}])/g, "$1")
    .replace(/,([)\]}])/g, "$1");

/** The body of a component-level function (plain or async) by name. */
const fnBody = (src, name) =>
  functionBody(src, `async function ${name}(`) ??
  functionBody(src, `function ${name}(`);

/** The brace-matched block opening at `src[open]`, or null when unclosed. */
function blockAt(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  return null;
}

/** The callback body of every `onPublishAnyway={() => {` prop (null when its
 *  braces never close). */
const PUBLISH_ANYWAY = "onPublishAnyway={() => {";
const publishAnywayBodies = (src) => {
  const bodies = [];
  for (let at = src.indexOf(PUBLISH_ANYWAY); at >= 0; ) {
    const open = at + PUBLISH_ANYWAY.length - 1;
    bodies.push(blockAt(src, open));
    at = src.indexOf(PUBLISH_ANYWAY, open);
  }
  return bodies;
};

/** Every pushOutcome argument list in `body`, normalized. */
const outcomeArgs = (body) =>
  [...norm(body).matchAll(/pushOutcome\(\{([^}]*)\}\)/g)].map((m) => m[1]);

const DECIDED = "willPublish: true, create, presence";
const UNKNOWN = "willPublish: true, create: undefined, presence: undefined";

/** A route whose outcome is decided: one presence read, one create decision
 *  over that presence, and every pushOutcome call passing exactly both. */
function decidedProblems(route, body, decision) {
  const problems = [];
  if (body === null) return [`${route} not found`];
  const flat = norm(body);
  if (flat.split("const presence = presenceUnderUrls(").length !== 2)
    problems.push(`${route}: not one presence read`);
  if (!flat.includes(decision))
    problems.push(`${route}: create not decided from that presence`);
  const args = outcomeArgs(body);
  if (args.length === 0 || args.some((a) => a !== DECIDED))
    problems.push(`${route}: pushOutcome args ${JSON.stringify(args)}`);
  return problems;
}

/** Each landedIn( read follows its own push await: the i-th read sits between
 *  the i-th and the (i+1)-th `await push.mutateAsync(`. */
function landedProblems(route, body) {
  if (body === null) return [`${route} not found`];
  const at = (needle) => {
    const out = [];
    for (let i = body.indexOf(needle); i >= 0; i = body.indexOf(needle, i + 1))
      out.push(i);
    return out;
  };
  const pushes = at("await push.mutateAsync(");
  const reads = at("landedIn(");
  if (pushes.length === 0 || reads.length !== pushes.length)
    return [
      `${route}: ${reads.length} landedIn reads, ${pushes.length} pushes`,
    ];
  return reads.some(
    (r, i) => !(pushes[i] < r && (i + 1 >= pushes.length || r < pushes[i + 1])),
  )
    ? [`${route}: landedIn read before its push settles`]
    : [];
}

function routeProblems(sync, switcher) {
  const problems = [
    ...decidedProblems(
      "beginPush",
      fnBody(sync, "beginPush"),
      "const create = willCreateOnRemote({...facts, remoteHasSameName: presence});",
    ),
    ...decidedProblems(
      "beginBarePush",
      fnBody(sync, "beginBarePush"),
      "const create = pushWouldCreate({pushRemote, pushBranch, presence});",
    ),
    ...decidedProblems(
      "pushFromMenu",
      fnBody(sync, "pushFromMenu"),
      "remoteHasSameName: presence});",
    ),
    ...decidedProblems(
      "beginPublishBranch",
      fnBody(switcher, "beginPublishBranch"),
      "upstreamGone: branch.upstreamGone, remoteHasSameName: presence});",
    ),
  ];
  for (const [file, src] of [
    ["SyncControls", sync],
    ["BranchSwitcher", switcher],
  ]) {
    const bodies = publishAnywayBodies(src);
    if (bodies.length !== 1)
      problems.push(`${file}: ${bodies.length} onPublishAnyway handlers`);
    for (const body of bodies) {
      if (body === null) {
        problems.push(`${file} onPublishAnyway: unclosed handler`);
        continue;
      }
      const args = outcomeArgs(body);
      if (args.length !== 1 || args[0] !== UNKNOWN)
        problems.push(`${file} onPublishAnyway: args ${JSON.stringify(args)}`);
    }
  }
  const doPushBranch = fnBody(switcher, "doPushBranch");
  if (
    doPushBranch === null ||
    outcomeArgs(doPushBranch).join() !==
      "willPublish: false, create: undefined, presence: undefined"
  )
    problems.push("doPushBranch: not the plain pushed outcome");
  const run = fnBody(switcher, "runPushBranch");
  if (
    run === null ||
    !norm(run).includes("const pushedIn = repoPath; try {") ||
    !norm(run).includes("const {away} = landedIn(pushedIn);")
  )
    problems.push("runPushBranch: away not read from landedIn(pushedIn)");
  for (const [route, src] of [
    ["doPush", sync],
    ["beginBarePush", sync],
    ["pushFromMenu", sync],
  ])
    problems.push(...landedProblems(route, fnBody(src, route)));
  problems.push(...landedProblems("runPushBranch", run));
  return problems;
}

test("each route passes pushOutcome its own decision, and reads landedIn late", () => {
  assert.deepEqual(
    routeProblems(source(SYNC_CONTROLS), source(BRANCH_SWITCHER)),
    [],
  );
});

test("mutants over-claiming the outcome or reading landedIn early are caught", () => {
  const sync = source(SYNC_CONTROLS);
  const switcher = source(BRANCH_SWITCHER);
  /** `src` with `from` replaced by `to` inside the named function only. */
  const inFn = (src, name, from, to) => {
    const body = fnBody(src, name);
    assert.ok(body?.includes(from), `${name}: ${from}`);
    return src.replace(body, body.replace(from, to));
  };
  const decided = "pushOutcome({ willPublish: true, create, presence })";
  const syncMutants = [
    inFn(sync, "beginPush", decided, decided.replace("true", "false")),
    inFn(
      sync,
      "beginBarePush",
      decided,
      decided.replace("presence }", "presence: false }"),
    ),
    inFn(
      sync,
      "pushFromMenu",
      decided,
      decided.replace("presence }", "presence: false }"),
    ),
    inFn(
      sync,
      "beginPush",
      "remoteHasSameName: presence,",
      "remoteHasSameName: true,",
    ),
    sync.replace(
      "                create: undefined,",
      "                create: true,",
    ),
    inFn(
      sync,
      "beginBarePush",
      "        away: landedIn(pushedIn).away,",
      "        away,",
    ).replace(
      "    try {\n      // Sets no upstream",
      "    const { away } = landedIn(pushedIn);\n    try {\n      // Sets no upstream",
    ),
  ];
  const switcherMutants = [
    inFn(
      switcher,
      "beginPublishBranch",
      decided,
      decided.replace("true", "false"),
    ),
    inFn(
      switcher,
      "beginPublishBranch",
      decided,
      decided.replace("presence }", "presence: false }"),
    ),
    inFn(switcher, "doPushBranch", "willPublish: false,", "willPublish: true,"),
    switcher.replace(
      "                presence: undefined,",
      "                presence: false,",
    ),
    inFn(
      switcher,
      "runPushBranch",
      "      const { away } = landedIn(pushedIn);\n",
      "",
    ).replace(
      "    const pushedIn = repoPath;\n    try {",
      "    const pushedIn = repoPath;\n    const { away } = landedIn(pushedIn);\n    try {",
    ),
  ];
  // A second, over-claiming call after an inner `}}` the old first-`}}` cut
  // stopped at.
  const pastInnerBlock = (src) => {
    const [body] = publishAnywayBodies(src);
    assert.ok(body);
    const tail =
      "void { a: { b: 1 }};\npushOutcome({ willPublish: true, create: true, presence: undefined });\n}";
    return src.replace(body, () => body.slice(0, -1).concat(tail));
  };
  syncMutants.push(pastInnerBlock(sync));
  switcherMutants.push(pastInnerBlock(switcher));
  for (const mutant of syncMutants) {
    assert.notEqual(mutant, sync);
    assert.notDeepEqual(routeProblems(mutant, switcher), []);
  }
  for (const mutant of switcherMutants) {
    assert.notEqual(mutant, switcher);
    assert.notDeepEqual(routeProblems(sync, mutant), []);
  }
});
