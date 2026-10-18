// Pins the conflict editor's disk poll and its flicker-free busy hold. The open
// conflict file re-reads every CONFLICT_FILE_POLL_MS while its panel shows and
// the window is visible, except while the read sits in `invalidArgument` (binary
// or oversized: it can't heal, and each tick re-reads the whole file). The
// three conflict mutations await only the conflict-file re-read before their
// isPending drops, with the working tree refreshing behind it, so the view's
// `busy` needs no fetch state, and a poll tick never toggles the buttons. A
// mount or panel show holds `busy` until a read joined or started then lands,
// since a cached entry can be as old as the time off-screen. Only an `io` read
// failure retries, once, so a transient io failure never flashes the
// read-error pane. Each write handler holds a synchronous in-flight ref, since
// a second click before the disabling render would write from stale segments,
// and re-reads the file when its write fails. Mark resolved asks its marker
// question from a read taken at the click, and the no-longer-conflicted status
// nudge restarts a status read already in flight.
//
// A source scan over MASKED code (comments and string text blanked), not an
// import test: the hook's options only exist inside a React render, and CI's
// installless guards job has no @tanstack/react-query to load. Every lookup that
// finds nothing fails, so a renamed hook or a reshaped object can't pass inert.
//
// Runs in CI's installless `guards` job, so node built-ins ONLY.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CLOSE, maskNonCode, matchBrace, OPEN } from "./lib/ts-mask.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKINGTREE = "src/lib/git/queries/workingtree.ts";
const VIEW = "src/features/repository/ConflictFileView.tsx";
const CONFLICT_HOOKS = [
  "useResolveConflict",
  "useCheckoutConflictSide",
  "useMarkConflictResolved",
];

function load(file) {
  const source = readFileSync(join(REPO_ROOT, file), "utf8");
  return { source, masked: maskNonCode(source, file.endsWith(".tsx")) };
}

/** The `{` opening the object literal that encloses `index`, or -1. */
function enclosingObject(masked, index) {
  for (let i = index - 1, depth = 0; i >= 0; i--) {
    if (masked[i] === "}") depth++;
    else if (masked[i] === "{") {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

/** The object's top-level `name: value` entries, each value running to the next
 *  top-level comma (or the closing brace), as masked code and as source. */
function topLevelValues(src, open, name) {
  const close = matchBrace(src.masked, open);
  assert.notEqual(close, -1, `no balanced object at offset ${open}`);
  const values = [];
  for (let i = open + 1, depth = 0; i < close; i++) {
    const ch = src.masked[i];
    if (OPEN.has(ch)) depth++;
    else if (CLOSE.has(ch)) depth--;
    else if (depth === 0) {
      const key = new RegExp(String.raw`^${name}\s*:`).exec(
        src.masked.slice(i, close),
      );
      if (!key || /[\w$]/.test(src.masked[i - 1])) continue;
      const start = i + key[0].length;
      let end = close;
      for (let j = start, d = 0; j < close; j++) {
        if (OPEN.has(src.masked[j])) d++;
        else if (CLOSE.has(src.masked[j])) d--;
        else if (src.masked[j] === "," && d === 0) {
          end = j;
          break;
        }
      }
      values.push({
        masked: src.masked.slice(start, end).trim(),
        source: src.source.slice(start, end).trim(),
        start,
      });
      i = end - 1;
    }
  }
  return values;
}

/** The one top-level `name:` value of the object at `open`; fails on none or
 *  several. */
function onlyValue(src, open, name) {
  const values = topLevelValues(src, open, name);
  assert.equal(values.length, 1, `expected one top-level \`${name}:\``);
  return values[0];
}

/** Whether `literal` appears as a code-level string in the value (the mask keeps
 *  quotes and blanks their contents, so a comment's text can't match). */
function hasStringLiteral(src, value, literal) {
  const quoted = JSON.stringify(literal);
  for (let at = 0; ; at++) {
    at = value.source.indexOf(quoted, at);
    if (at === -1) return false;
    const offset = src.source.indexOf(value.source, value.start) + at;
    if (src.masked[offset] === '"') return true;
  }
}

/** The body span of `function name(…) {…}`; fails when the hook is gone. */
function functionBody(src, name) {
  const m = new RegExp(String.raw`\bfunction\s+${name}\s*\(`).exec(src.masked);
  assert.ok(m, `function ${name} not found in masked code`);
  let i = m.index + m[0].length - 1;
  for (let depth = 0; i < src.masked.length; i++) {
    if (src.masked[i] === "(") depth++;
    else if (src.masked[i] === ")" && --depth === 0) break;
  }
  const open = src.masked.indexOf("{", i);
  const close = matchBrace(src.masked, open);
  assert.ok(open !== -1 && close !== -1, `${name}: no readable body`);
  return { open, close };
}

/** The `function` declaration whose body holds `index`, by name. */
function hookAt(src, index) {
  for (const name of [...src.masked.matchAll(/\bfunction\s+([\w$]+)/g)].map(
    (m) => m[1],
  )) {
    const { open, close } = functionBody(src, name);
    if (open < index && index < close) return name;
  }
  return null;
}

test("the conflict file polls on an interval gated on the panel and the error kind", () => {
  const src = load(WORKINGTREE);
  const decl = /\bconst\s+CONFLICT_FILE_POLL_MS\s*=\s*([\d_]+)\s*;/.exec(
    src.masked,
  );
  assert.ok(decl, "CONFLICT_FILE_POLL_MS is not declared as a number literal");
  assert.ok(
    Number(decl[1].replaceAll("_", "")) > 0,
    "CONFLICT_FILE_POLL_MS must be positive",
  );

  const objects = [...src.masked.matchAll(/(?<![\w$.])queryFn\s*:/g)]
    .map((m) => enclosingObject(src.masked, m.index))
    .filter((open) => {
      assert.notEqual(open, -1, "a queryFn with no enclosing object");
      const keys = topLevelValues(src, open, "queryKey");
      return keys.some((k) => hasStringLiteral(src, k, "conflict-file"));
    });
  assert.equal(
    objects.length,
    1,
    `expected exactly one conflict-file query options object, found ${objects.length}`,
  );
  const [open] = objects;
  const body = functionBody(src, "useConflictFile");
  assert.ok(
    body.open < open && open < body.close,
    "the conflict-file options object is not inside useConflictFile",
  );
  assert.match(
    src.masked.slice(body.open, body.close),
    /(?<![\w$.])usePanelActive\s*\(\s*\)/,
    "useConflictFile no longer reads usePanelActive(): a hidden panel would keep polling",
  );

  assert.equal(
    onlyValue(src, open, "refetchIntervalInBackground").masked,
    "false",
    "refetchIntervalInBackground must be false: a hidden window must not poll",
  );
  const interval = onlyValue(src, open, "refetchInterval");
  assert.match(
    interval.masked,
    /(?<![\w$.])CONFLICT_FILE_POLL_MS(?![\w$])/,
    "refetchInterval does not poll at CONFLICT_FILE_POLL_MS",
  );
  assert.ok(
    hasStringLiteral(src, interval, "invalidArgument"),
    'refetchInterval lost its "invalidArgument" arm: a binary or oversized read would re-read every tick',
  );
  assert.match(
    interval.masked,
    /(?<![\w$.])panelActive(?![\w$])/,
    "refetchInterval does not read the panel gate",
  );
  const retry = onlyValue(src, open, "retry");
  assert.match(
    retry.masked,
    /^\(\s*failureCount\s*,\s*error\s*\)\s*=>\s*failureCount\s*<\s*1\s*&&\s*isAppError\s*\(\s*error\s*\)\s*&&\s*error\.kind\s*===\s*"\s*"$/,
    "retry must be exactly one retry, for a single AppError kind",
  );
  assert.ok(
    hasStringLiteral(src, retry, "io") &&
      !hasStringLiteral(src, retry, "invalidArgument"),
    'retry must cover only "io" failures: invalidArgument can never heal',
  );
  assert.equal(
    onlyValue(src, open, "retryDelay").masked,
    "CONFLICT_FILE_RETRY_MS",
    "retryDelay must be CONFLICT_FILE_RETRY_MS",
  );
  const delay = /\bconst\s+CONFLICT_FILE_RETRY_MS\s*=\s*([\d_]+)\s*;/.exec(
    src.masked,
  );
  assert.ok(
    delay,
    "CONFLICT_FILE_RETRY_MS is not declared as a number literal",
  );
  const delayMs = Number(delay[1].replaceAll("_", ""));
  assert.ok(
    delayMs > 0 && delayMs < Number(decl[1].replaceAll("_", "")),
    "CONFLICT_FILE_RETRY_MS must be positive and shorter than the poll interval",
  );
  assert.ok(
    hasStringLiteral(src, onlyValue(src, open, "networkMode"), "always"),
    'the conflict-file query must keep networkMode: "always"',
  );
});

test("each conflict mutation awaits only the conflict-file re-read, the working tree after", () => {
  const src = load(WORKINGTREE);
  const sites = [
    ...src.masked.matchAll(
      /(?<![\w$.])invalidate\s*:\s*\[\s*conflictFileKey\s*\(/g,
    ),
  ];
  assert.equal(
    sites.length,
    CONFLICT_HOOKS.length,
    `expected ${CONFLICT_HOOKS.length} \`invalidate: [conflictFileKey(…)]\` sites, found ${sites.length}`,
  );
  const hooks = sites.map((m) => {
    const open = enclosingObject(src.masked, m.index);
    assert.notEqual(open, -1, "an invalidate site with no enclosing object");
    const hook = hookAt(src, m.index);
    assert.equal(
      onlyValue(src, open, "refetchBeforeSuccess").masked,
      "true",
      `${hook}: refetchBeforeSuccess must be true, or the busy hold drops before fresh segments land`,
    );
    assert.match(
      onlyValue(src, open, "invalidateAfter").masked,
      /^workingTreeKeys\s*\(\s*repo\s*\)$/,
      `${hook}: invalidateAfter must be workingTreeKeys(repo), so status and diffs refresh unawaited`,
    );
    return hook;
  });
  assert.deepEqual(
    [...hooks].sort(),
    [...CONFLICT_HOOKS].sort(),
    "the conflict-file invalidate sites are not exactly the three conflict mutations",
  );
});

/** The masked index just past the block statement opening at `open`, plus any
 *  `catch (…) { … }` that follows it. */
function pastTryAndCatch(masked, open) {
  let end = matchBrace(masked, open) + 1;
  const katch = /^\s*catch\s*(?:\([^()]*\)\s*)?\{/.exec(masked.slice(end));
  if (katch) end = matchBrace(masked, end + katch[0].length - 1) + 1;
  return end;
}

test("every conflict write handler holds a synchronous in-flight guard", () => {
  const src = load(VIEW);
  assert.match(
    src.masked,
    /\bconst\s+inFlightRef\s*=\s*useRef\s*\(\s*false\s*\)\s*;/,
    "ConflictFileView's `const inFlightRef = useRef(false)` is gone",
  );
  for (const name of ["acceptRegion", "acceptAll", "markResolved"]) {
    const { open, close } = functionBody(src, name);
    const body = src.masked.slice(open + 1, close);
    assert.match(
      body,
      /^\s*if\s*\(\s*inFlightRef\.current(?![\w$])[^;{}]*\)\s*return\s*;/,
      `${name}: its first statement must return while inFlightRef is set`,
    );
    const set = /inFlightRef\.current\s*=\s*true\s*;\s*try\s*\{/.exec(body);
    assert.ok(set, `${name}: inFlightRef must be set right before a try`);
    assert.doesNotMatch(
      body.slice(0, set.index),
      /(?<![\w$])await(?![\w$])/,
      `${name}: an await before the guard is set lets a second call through`,
    );
    const tryOpen = open + 1 + set.index + set[0].length - 1;
    const rest = src.masked.slice(pastTryAndCatch(src.masked, tryOpen), close);
    assert.match(
      rest,
      /^\s*finally\s*\{\s*inFlightRef\.current\s*=\s*false\s*;\s*\}\s*$/,
      `${name}: inFlightRef must clear in a finally that ends the handler, after the write and re-read`,
    );
  }
});

test("every conflict write handler re-reads the file when its write fails", () => {
  const src = load(VIEW);
  for (const name of ["acceptRegion", "acceptAll", "markResolved"]) {
    const { open, close } = functionBody(src, name);
    const catches = [
      ...src.masked.slice(open, close).matchAll(/\bcatch\s*\(\s*e\s*\)\s*\{/g),
    ];
    assert.equal(
      catches.length,
      1,
      `${name}: expected one \`catch (e) {\` block, found ${catches.length}`,
    );
    const catchOpen = open + catches[0].index + catches[0][0].length - 1;
    assert.match(
      src.masked.slice(catchOpen + 1, matchBrace(src.masked, catchOpen)),
      /(?<![\w$.])await\s+refreshAfterError\s*\(\s*\)/,
      `${name}: its catch must await refreshAfterError(), or a failed write leaves live buttons over stale segments`,
    );
  }
});

test("Mark resolved decides its marker confirm from a read taken at the click", () => {
  const src = load(VIEW);
  const { open, close } = functionBody(src, "markResolved");
  const body = src.masked.slice(open + 1, close);
  const read =
    /(?<![\w$.])([\w$]+)\s*=\s*await\s+conflictSides\s*\(\s*repoPath\s*,\s*path\s*,\s*\[\s*\]\s*\)/.exec(
      body,
    );
  assert.ok(
    read,
    "markResolved must assign a fresh `await conflictSides(repoPath, path, [])` read",
  );
  const checks = [
    ...body.matchAll(/(?<![\w$.])markNeedsConfirm\s*\(([^()]*)\)/g),
  ];
  assert.equal(
    checks.length,
    1,
    `markResolved: expected one markNeedsConfirm(…) call, found ${checks.length}`,
  );
  assert.ok(
    read.index < checks[0].index,
    "markResolved must re-read before it decides the marker confirm",
  );
  assert.equal(
    checks[0][1].trim(),
    read[1],
    `markNeedsConfirm must take the fresh read (\`${read[1]}\`), not the view's last read`,
  );
});

test("the no-longer-conflicted nudge restarts the status read", () => {
  const src = load(VIEW);
  const effects = [...src.masked.matchAll(/\buseEffect\s*\(\s*\(\)\s*=>\s*\{/g)]
    .map((m) => {
      const open = m.index + m[0].length - 1;
      return src.masked.slice(open + 1, matchBrace(src.masked, open));
    })
    .filter((body) =>
      /^\s*if\s*\(\s*!notConflicted\s*\)\s*return\s*;/.test(body),
    );
  assert.equal(
    effects.length,
    1,
    `expected one effect gated on \`if (!notConflicted) return;\`, found ${effects.length}`,
  );
  const [body] = effects;
  assert.match(
    body,
    /^\s*if\s*\(\s*!notConflicted\s*\)\s*return\s*;\s*void\s+queryClient\.invalidateQueries\s*\(\s*\{\s*queryKey\s*:\s*repoKeys\.status\s*\(/,
    "the nudge must invalidate repoKeys.status(…) right after its gate",
  );
  assert.doesNotMatch(
    body,
    /(?<![\w$])cancelRefetch(?![\w$])/,
    "the nudge must restart an in-flight status read: one begun before an outside `git add` still lists the path as unmerged",
  );
});

test("the conflict view's busy hold reads no fetch state", () => {
  const src = load(VIEW);
  assert.doesNotMatch(
    src.masked,
    /(?<![\w$])isFetching(?![\w$])/,
    "ConflictFileView reads isFetching: poll ticks would flicker its buttons",
  );
  const busy = /\bconst\s+busy\s*=([^;]*);/.exec(src.masked);
  assert.ok(busy, "ConflictFileView's `const busy =` is gone");
  assert.match(
    busy[1],
    /(?<![\w$.])recovering(?![\w$])/,
    "busy no longer holds through the error-path re-read (`recovering`)",
  );
  assert.match(
    busy[1],
    /(?<![\w$.])awaitingRead(?![\w$])/,
    "busy no longer holds through the first read after a mount or show (`awaitingRead`)",
  );
  assert.match(
    busy[1],
    /(?<![\w$.])checking(?![\w$])/,
    "busy no longer holds through Mark resolved's click-time read (`checking`)",
  );
});

test("Mark resolved holds the buttons through its click-time read", () => {
  const src = load(VIEW);
  assert.match(
    src.masked,
    /\bconst\s+\[\s*checking\s*,\s*setChecking\s*\]\s*=\s*useState\s*\(\s*false\s*\)\s*;/,
    "ConflictFileView's `const [checking, setChecking] = useState(false)` is gone",
  );
  const { open, close } = functionBody(src, "markResolved");
  const body = src.masked.slice(open + 1, close);
  const hold =
    /(?<![\w$.])setChecking\s*\(\s*true\s*\)\s*;\s*try\s*\{[^{}]*?=\s*await\s+conflictSides\s*\(/.exec(
      body,
    );
  assert.ok(
    hold,
    "markResolved must set checking right before the try holding its conflictSides read",
  );
  const tryOpen = open + 1 + body.indexOf("{", hold.index);
  const rest = src.masked.slice(pastTryAndCatch(src.masked, tryOpen));
  assert.match(
    rest,
    /^\s*finally\s*\{\s*setChecking\s*\(\s*false\s*\)\s*;\s*\}/,
    "the click-time read's try must clear checking in a finally, so its failure arm releases the hold too",
  );
});

test("a mount or show holds the buttons until a read requested then lands", () => {
  const src = load(VIEW);
  assert.match(
    src.masked,
    /\bconst\s+refetchFile\s*=\s*file\.refetch\s*;/,
    "the hold no longer re-reads through the conflict file's own observer",
  );
  const effects = [...src.masked.matchAll(/\buseEffect\s*\(\s*\(\)\s*=>\s*\{/g)]
    .map((m) => {
      const open = m.index + m[0].length - 1;
      return src.masked.slice(open + 1, matchBrace(src.masked, open));
    })
    .filter((body) => /(?<![\w$.])refetchFile\s*\(/.test(body));
  assert.equal(
    effects.length,
    1,
    `expected one effect re-reading through refetchFile, found ${effects.length}`,
  );
  const [body] = effects;
  assert.match(
    body,
    /^\s*if\s*\(\s*!panelActive\s*\)\s*return\s*;/,
    "the read effect must start only while the panel shows",
  );
  assert.match(
    body,
    /refetchFile\s*\(\s*\{\s*cancelRefetch\s*:\s*false\s*\}\s*\)/,
    "the read must join one in flight (cancelRefetch: false), not restart it",
  );
  assert.match(
    body,
    /setFreshFor\s*\(\s*\{\s*repoPath\s*,\s*path\s*\}\s*\)/,
    "a landed read must release the hold for this view's file",
  );
  assert.match(
    body,
    /return\s*\(\)\s*=>\s*\{[^{}]*setFreshFor\s*\(\s*null\s*\)/,
    "the effect's cleanup must re-arm the hold on every hide and unmount",
  );
  const awaiting = /\bconst\s+awaitingRead\s*=([^;]*);/.exec(src.masked);
  assert.ok(awaiting, "ConflictFileView's `const awaitingRead =` is gone");
  for (const name of ["freshFor", "repoPath", "path"]) {
    assert.match(
      awaiting[1],
      new RegExp(String.raw`(?<![\w$])${name}(?![\w$])`),
      `awaitingRead no longer compares ${name}`,
    );
  }
});

test("a read with no index stages never reaches the region view", () => {
  const src = load(VIEW);
  const memo = /\bconst\s+segments\s*=\s*useMemo\s*\(([^;]*)\)\s*;/.exec(
    src.masked,
  );
  assert.ok(memo, "ConflictFileView's `const segments = useMemo(` is gone");
  assert.match(
    memo[1],
    /(?<![\w$.])noLongerConflicted\s*\(/,
    "segments must stay null for a read with no index stages",
  );
});

test("the header's whole-file actions hold, with a reason, on a path no longer conflicted", () => {
  const src = load(VIEW);
  assert.match(
    src.masked,
    /\bconst\s+notConflicted\s*=\s*arm\s*===\s*"\s*"\s*;/,
    "ConflictFileView's `const notConflicted = arm === …` is gone",
  );
  assert.match(
    src.source,
    /\bconst\s+notConflicted\s*=\s*arm\s*===\s*"notConflicted"\s*;/,
    'notConflicted must test the "notConflicted" arm',
  );
  for (const label of [
    "Accept all current",
    "Accept all incoming",
    "Resolve with AI",
  ]) {
    // JSX text is blanked in the mask, so the label is found in the source and
    // only a masked-blank offset counts (a comment or string can't pose as it);
    // of those, the header action is the one whose nearest opening tag (past
    // the AI button's icon) is a DisabledReasonButton.
    const buttons = [
      ...src.source.matchAll(new RegExp(String.raw`>\s*${label}\s*<`, "g")),
    ]
      .map((m) => m.index + m[0].indexOf(label))
      .filter((at) => src.masked.slice(at, at + label.length).trim() === "")
      .map((at) => {
        const last = [
          ...src.masked
            .slice(0, at)
            .matchAll(/<(?!SparkleIcon\b)([A-Za-z]\w*)/g),
        ].at(-1);
        return last?.[1] === "DisabledReasonButton"
          ? { tag: last.index, at }
          : null;
      })
      .filter(Boolean);
    assert.equal(
      buttons.length,
      1,
      `expected one DisabledReasonButton labeled "${label}", found ${buttons.length}`,
    );
    const [{ tag, at }] = buttons;
    const opening = src.masked.slice(tag, at);
    const prop = (name) => {
      const m = new RegExp(String.raw`(?<![\w$-])${name}\s*=\s*\{`).exec(
        opening,
      );
      assert.ok(m, `"${label}": no ${name}={…} prop`);
      const open = tag + m.index + m[0].length - 1;
      return src.masked.slice(open + 1, matchBrace(src.masked, open));
    };
    assert.match(
      prop("disabled"),
      /(?<![\w$.])notConflicted(?![\w$])/,
      `"${label}" must be disabled while the arm is notConflicted`,
    );
    if (label === "Resolve with AI") {
      assert.match(
        prop("disabled"),
        /(?<![\w$.])workingUndecodable(?![\w$])/,
        `"${label}" must be disabled while the working file isn't UTF-8 text`,
      );
    }
    // The AI button holds for a second cause too (a non-UTF-8 working file), so
    // its reason comes from `aiHeldReason`, pinned below.
    assert.match(
      prop("reason"),
      label === "Resolve with AI"
        ? /^\s*aiHeldReason\s*$/
        : /^\s*notConflicted\s*\?\s*NOT_CONFLICTED_COPY\s*:\s*null\s*$/,
      `"${label}" must explain its notConflicted hold`,
    );
  }
  // The AI reason's first case is the no-longer-conflicted one, so that reason
  // wins and stays the shared copy; the non-UTF-8 hold has its own arm.
  const held =
    /\bconst\s+aiHeldReason\s*=\s*\(\s*\(\s*\)\s*=>\s*\{\s*switch\s*\(\s*true\s*\)\s*\{([^]*?)\}\s*\}\s*\)\s*\(\s*\)\s*;/.exec(
      src.masked,
    );
  assert.ok(
    held,
    "ConflictFileView's `const aiHeldReason = (() => { switch (true) {` is gone",
  );
  assert.match(
    held[1],
    /^\s*case\s+notConflicted\s*:\s*return\s+NOT_CONFLICTED_COPY\s*;/,
    "aiHeldReason's first case must be notConflicted -> NOT_CONFLICTED_COPY",
  );
  assert.match(
    held[1],
    /\bcase\s+workingUndecodable\s*:\s*return\s+AI_UNDECODABLE_REASON\s*;/,
    "aiHeldReason must hold a non-UTF-8 working file with AI_UNDECODABLE_REASON",
  );
  assert.match(
    src.source,
    /\bconst\s+NOT_CONFLICTED_COPY\s*=\s*"This file is no longer conflicted\."\s*;/,
    "NOT_CONFLICTED_COPY must keep the reason copy",
  );
});
