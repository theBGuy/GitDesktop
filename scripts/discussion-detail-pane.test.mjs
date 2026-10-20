// Pins DiscussionView's adoption of the shared detail-pane ladder: a failed or
// parked refresh keeps the loaded discussion under the degraded notice instead
// of swapping the pane for a placeholder. The scans pin the wiring alone (the
// ladder's five inputs, the notice and its copy, the error arm and its Retry
// rescue, the one focusable host every arm renders in, the arm-change focus
// key); remote-list-state.test.mjs pins the helpers' own transitions.
//
// Every scan runs on `maskNonCode`'s output, so comments and string/JSX text
// can't satisfy a pin; a string literal's value is read from the raw source at
// the masked quotes' offsets. A missing anchor fails, never skips.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { lineOf, maskNonCode, matchBrace, tagEnd } from "./lib/ts-mask.mjs";

const FILE = "src/features/discussions/DiscussionView.tsx";

let loaded;
function load() {
  if (loaded) return loaded;
  const raw = readFileSync(
    new URL(`../${FILE}`, import.meta.url),
    "utf8",
  ).replace(/\r\n/g, "\n");
  loaded = { raw, masked: maskNonCode(raw, true) };
  return loaded;
}

/** The raw string literal whose opening quote sits at `open` in the masked
 *  text (masking keeps the quotes and blanks what lies between them). */
function literalAt(masked, raw, open) {
  const quote = masked[open];
  assert.ok(quote === '"' || quote === "'", `no string literal at ${open}`);
  const close = masked.indexOf(quote, open + 1);
  assert.ok(close > open, `unterminated string literal at ${open}`);
  return raw.slice(open + 1, close);
}

/** The `{…}` body of `export function DiscussionView(…)`. */
function componentBody(masked) {
  const m = /\bexport\s+function\s+DiscussionView\s*\(/.exec(masked);
  assert.ok(m, `${FILE}: anchor \`export function DiscussionView(\` missing`);
  const paramsOpen = m.index + m[0].length - 1;
  const paramsClose = matchBrace(masked, paramsOpen);
  assert.ok(paramsClose > 0, "DiscussionView's parameter list never closes");
  const open = masked.indexOf("{", paramsClose);
  const close = open < 0 ? -1 : matchBrace(masked, open);
  assert.ok(close > open, "DiscussionView's body never closes");
  return { open, close };
}

/** The argument list `(…)` of every call to `name` between `from` and `to`. */
function callArgs(masked, name, from, to) {
  const re = new RegExp(`(?<![\\w$.])${name}\\s*\\(`, "g");
  re.lastIndex = from;
  const calls = [];
  for (let m = re.exec(masked); m && m.index < to; m = re.exec(masked)) {
    const open = m.index + m[0].length - 1;
    const close = matchBrace(masked, open);
    assert.ok(
      close > open,
      `${name}( never closes at line ${lineOf(masked, open)}`,
    );
    calls.push({ start: m.index, open, close });
  }
  return calls;
}

/** The one call to `name` inside `body`; zero or several fail. */
function soleCall(masked, name, body) {
  const calls = callArgs(masked, name, body.open, body.close);
  assert.equal(
    calls.length,
    1,
    `${FILE}: expected exactly one \`${name}(\` call in DiscussionView, found ${calls.length}`,
  );
  return calls[0];
}

/** The ranges of every `<DegradedListNotice …>` opening tag. */
function noticeTags(masked) {
  const tags = [];
  for (const m of masked.matchAll(/<DegradedListNotice\b/g)) {
    const end = tagEnd(masked, m.index);
    assert.ok(end > m.index, "a <DegradedListNotice tag never closes");
    tags.push(masked.slice(m.index, end + 1));
  }
  return tags;
}

/** End (exclusive) of the statement starting at `from`: its first `;` at
 *  bracket depth zero. */
function statementEnd(masked, from) {
  let depth = 0;
  for (let i = from; i < masked.length; i++) {
    const c = masked[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === ";" && depth === 0) return i + 1;
  }
  return -1;
}

/** Every `if (detailPane === "…" …)` statement in `body`: the literal it
 *  compares, its masked `(…)` condition, and the span of the block or single
 *  statement it guards (the condition excluded). */
function paneArms(masked, raw, body) {
  const arms = [];
  const ifRe = /(?<![\w$])if\s*\(/g;
  ifRe.lastIndex = body.open;
  for (
    let m = ifRe.exec(masked);
    m && m.index < body.close;
    m = ifRe.exec(masked)
  ) {
    const open = m.index + m[0].length - 1;
    const close = matchBrace(masked, open);
    assert.ok(
      close > open,
      `an if ( never closes at line ${lineOf(raw, open)}`,
    );
    const cond = /^\(\s*detailPane\s*===\s*(?=["'])/.exec(
      masked.slice(open, close),
    );
    if (!cond) continue;
    let from = close + 1;
    while (/\s/.test(masked[from])) from++;
    const block = masked[from] === "{";
    const to = block
      ? matchBrace(masked, from) + 1
      : statementEnd(masked, from);
    const line = lineOf(raw, m.index);
    assert.ok(to > from, `the arm at line ${line} never ends`);
    arms.push({
      line,
      literal: literalAt(masked, raw, open + cond[0].length),
      condition: masked.slice(open, close + 1),
      from,
      to,
      blockOrReturn: block || /^return\b/.test(masked.slice(from)),
    });
  }
  return arms;
}

/** The one `if (detailPane === "error" …)` arm; zero or several fail. */
function errorArm(masked, raw, body) {
  const arms = paneArms(masked, raw, body).filter((a) => a.literal === "error");
  assert.equal(
    arms.length,
    1,
    `${FILE}: expected exactly one \`if (detailPane === "error" …\` arm, found ${arms.length}`,
  );
  assert.ok(
    arms[0].blockOrReturn,
    `the error arm at line ${arms[0].line} is neither a block nor a single return`,
  );
  return arms[0];
}

test("the ladder's helpers come from remote-section-state", () => {
  const { raw, masked } = load();
  const wanted = [
    "resolveDetailPane",
    "detailNoticeMessage",
    "refreshFailed",
    "offlinePendingMessage",
  ];
  const imports = [
    ...masked.matchAll(/\bimport\s*\{([^}]*)\}\s*from\s*(["'])/g),
  ].filter((m) => {
    const names = m[1].split(",").map((s) => s.trim());
    return wanted.every((w) => names.includes(w));
  });
  assert.equal(
    imports.length,
    1,
    `${FILE}: no single import brings in ${wanted.join(", ")}`,
  );
  const quoteAt = imports[0].index + imports[0][0].length - 1;
  assert.equal(
    literalAt(masked, raw, quoteAt),
    "@/features/conversations/remote-section-state",
  );
});

test("no raw error swap replaces loaded content", () => {
  const { raw, masked } = load();
  const lines = (re) =>
    [...masked.matchAll(re)].map((m) => `line ${lineOf(raw, m.index)}`);
  assert.deepEqual(
    lines(/\.isError\s*\|\|\s*!d\b/g),
    [],
    `${FILE}: an \`isError || !d\` swap`,
  );
  assert.deepEqual(
    lines(/!\s*details\s*\??\.\s*isError\b/g),
    [],
    `${FILE}: a \`!details.isError\` term`,
  );
});

/** Each `key: value` pair of `pairs` occurs exactly once in `text` (a masked
 *  object literal), and its key nowhere else there. */
function assertPairs(text, call, pairs) {
  for (const [key, value, shown] of pairs) {
    const keys = text.match(new RegExp(`(?<![\\w$.])${key}\\s*:`, "g")) ?? [];
    const exact =
      text.match(
        new RegExp(`(?<![\\w$.])${key}\\s*:\\s*${value}\\s*(?=[,}])`, "g"),
      ) ?? [];
    assert.ok(
      keys.length === 1 && exact.length === 1,
      `${call}( must pass \`${key}: ${shown}\` exactly once`,
    );
  }
}

test("the ladder reads its five inputs from the details read", () => {
  const { masked } = load();
  const body = componentBody(masked);
  const call = soleCall(masked, "resolveDetailPane", body);
  assertPairs(masked.slice(call.open, call.close + 1), "resolveDetailPane", [
    ["pending", "details\\s*\\.\\s*isPending", "details.isPending"],
    ["error", "details\\s*\\.\\s*isError", "details.isError"],
    ["hasData", "d\\s*!==\\s*undefined", "d !== undefined"],
    ["paused", "details\\s*\\.\\s*isPaused", "details.isPaused"],
    ["fetching", "details\\s*\\.\\s*isFetching", "details.isFetching"],
  ]);
});

test("the notice copy reads the failure and the switch window", () => {
  const { raw, masked } = load();
  const body = componentBody(masked);
  const failed = masked
    .slice(body.open, body.close)
    .match(
      /\bconst\s+detailFailed\s*=\s*refreshFailed\s*\(\s*details\s*\)\s*;/g,
    );
  assert.equal(
    failed?.length ?? 0,
    1,
    `${FILE}: expected one \`const detailFailed = refreshFailed(details);\``,
  );
  const call = soleCall(masked, "detailNoticeMessage", body);
  const args = masked.slice(call.open, call.close + 1);
  assertPairs(args, "detailNoticeMessage", [
    ["isError", "detailFailed", "detailFailed"],
    ["stale", "detailsStale", "detailsStale"],
  ]);
  const nouns = [...args.matchAll(/(?<![\w$.])noun\s*:\s*(?=["'])/g)];
  assert.equal(nouns.length, 1, "detailNoticeMessage( must pass one `noun:`");
  assert.equal(
    literalAt(masked, raw, call.open + nouns[0].index + nouns[0][0].length),
    "discussion",
  );
});

test("every arm draws inside the one focusable host", () => {
  const { raw, masked } = load();
  const body = componentBody(masked);
  const def =
    /\bconst\s+shell\s*=\s*\(\s*content\s*(?::\s*ReactNode\s*)?\)\s*=>\s*\(/.exec(
      masked,
    );
  assert.ok(def, `${FILE}: anchor \`const shell = (content) => (\` missing`);
  const open = def.index + def[0].length - 1;
  const close = matchBrace(masked, open);
  assert.ok(close > open, "the shell helper never closes");
  const shellText = masked.slice(open, close + 1);
  const div = /^\(\s*<div\b/.exec(shellText);
  assert.ok(div, "shell( must render a <div host");
  const tagStart = open + div[0].length - 4;
  const tag = masked.slice(tagStart, tagEnd(masked, tagStart) + 1);
  assert.match(tag, /\btabIndex=\{\s*-1\s*\}/, "the host needs tabIndex={-1}");
  const ref = /\bref=\{\s*\(\s*(\w+)\s*\)\s*=>\s*\{/.exec(tag);
  assert.ok(ref, "the host's ref must be a `(node) => { … }` callback");
  const refOpen = tagStart + ref.index + ref[0].length - 1;
  const refBody = masked.slice(refOpen, matchBrace(masked, refOpen) + 1);
  const node = ref[1];
  assert.match(
    refBody,
    new RegExp(`\\bhostRef\\s*\\(\\s*${node}\\s*\\)`),
    `the host's ref must call hostRef(${node})`,
  );
  assert.match(
    refBody,
    new RegExp(`\\bfocusHost\\s*\\.\\s*current\\s*=\\s*${node}\\b`),
    `the host's ref must set focusHost.current = ${node}`,
  );
  assert.match(shellText, /\{\s*content\s*\}/, "the host must render content");

  // The three arms and the content return all go through it.
  const arms = paneArms(masked, raw, body);
  assert.deepEqual(
    arms.map((a) => a.literal).sort(),
    ["error", "offline", "skeleton"],
    `${FILE}: expected one skeleton, one offline and one error arm`,
  );
  const unshelled = [];
  const viaShell = (at) => /^return\s+shell\s*\(/.test(masked.slice(at));
  for (const a of arms) {
    const returns = [...masked.slice(a.from, a.to).matchAll(/\breturn\b/g)];
    if (
      returns.length === 0 ||
      !returns.every((r) => viaShell(a.from + r.index))
    )
      unshelled.push(`line ${a.line}`);
  }
  let depth = 0;
  let topReturns = 0;
  for (let i = body.open + 1; i < body.close; i++) {
    const c = masked[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (
      depth === 0 &&
      /^return\b/.test(masked.slice(i, i + 7)) &&
      !/[\w$.]/.test(masked[i - 1])
    ) {
      topReturns++;
      if (!viaShell(i)) unshelled.push(`line ${lineOf(raw, i)}`);
    }
  }
  assert.ok(topReturns > 0, `${FILE}: DiscussionView has no content return`);
  assert.deepEqual(unshelled, [], `${FILE}: a return bypasses shell(`);
});

test("Retry's focus rescue wraps the error arm's own button", () => {
  const { raw, masked } = load();
  const body = componentBody(masked);
  const rescue = soleCall(masked, "useRetryFocusRescue", body);
  const arg =
    /^\(\s*detailPane\s*===\s*("[^"]*")\s*&&\s*details\s*\.\s*isError\s*,?\s*\)$/d.exec(
      masked.slice(rescue.open, rescue.close + 1),
    );
  assert.ok(
    arg,
    'useRetryFocusRescue( must take exactly `detailPane === "error" && details.isError`',
  );
  assert.equal(
    literalAt(masked, raw, rescue.open + arg.indices[1][0]),
    "error",
  );

  const arm = errorArm(masked, raw, body);
  const buttons = [];
  for (const m of masked.slice(arm.from, arm.to).matchAll(/<Button\b/g)) {
    const start = arm.from + m.index;
    buttons.push(masked.slice(start, tagEnd(masked, start) + 1));
  }
  assert.ok(
    buttons.some(
      (t) =>
        /\bref=\{\s*retryRef\s*\}/.test(t) &&
        /\bonClick=\{\s*\(\s*\)\s*=>\s*details\s*\.\s*refetch\s*\(\s*\)\s*\}/.test(
          t,
        ),
    ),
    "the error arm's Retry <Button must take ref={retryRef} and onClick={() => details.refetch()}",
  );
});

test("the notice is degraded exactly on content-degraded", () => {
  const { raw, masked } = load();
  const m = /<DegradedListNotice\b/.exec(masked);
  assert.ok(m, `${FILE}: no <DegradedListNotice mount`);
  // Mounted in every content render: its live region announces only text that
  // arrives after it is in the DOM.
  assert.match(
    masked.slice(0, m.index),
    /\breturn\s+shell\s*\(\s*<>\s*$/,
    "<DegradedListNotice must be the content fragment's direct first child",
  );
  const end = tagEnd(masked, m.index);
  assert.ok(end > m.index, "the <DegradedListNotice tag never closes");
  const tag = masked.slice(m.index, end + 1);
  const deg = /\bdegraded=\{\s*detailPane\s*===\s*(?=["'])/.exec(tag);
  assert.ok(deg, "<DegradedListNotice must take degraded={detailPane === …}");
  assert.equal(
    literalAt(masked, raw, m.index + deg.index + deg[0].length),
    "content-degraded",
  );
});

test("a never-loaded read parked offline says so", () => {
  const { raw, masked } = load();
  const calls = [
    ...masked.matchAll(/(?<![\w$.])offlinePendingMessage\s*\(\s*/g),
  ];
  assert.ok(calls.length > 0, `${FILE}: no offlinePendingMessage( call`);
  for (const m of calls)
    assert.equal(
      literalAt(masked, raw, m.index + m[0].length),
      "this discussion",
    );
});

test("isError is read only by the ladder, the rescue and the error arm", () => {
  const { raw, masked } = load();
  const body = componentBody(masked);
  const ladder = soleCall(masked, "resolveDetailPane", body);
  const rescue = soleCall(masked, "useRetryFocusRescue", body);
  const notice = soleCall(masked, "detailNoticeMessage", body);
  const arm = errorArm(masked, raw, body);
  // The ladder's only read is its `error:` value, nothing else in the call.
  const errorKeys = [
    ...masked
      .slice(ladder.open, ladder.close + 1)
      .matchAll(/\berror\s*:\s*details\s*\.\s*(isError)\b\s*(?=[,}])/dg),
  ];
  assert.equal(
    errorKeys.length,
    1,
    "resolveDetailPane( must pass exactly `error: details.isError`",
  );
  const ladderRead = ladder.open + errorKeys[0].indices[1][0];

  const allowed = [
    { from: ladderRead, to: ladderRead + 1 },
    { from: rescue.open, to: rescue.close + 1 },
    { from: arm.from, to: arm.to },
  ];
  const inside = (i, r) => i >= r.from && i < r.to;
  const strays = [];
  for (const m of masked.slice(0, body.close).matchAll(/\bisError\b/g)) {
    if (m.index < body.open) continue;
    let before = m.index - 1;
    while (/\s/.test(masked[before])) before--;
    const member = masked[before] === ".";
    if (member) {
      if (!allowed.some((r) => inside(m.index, r)))
        strays.push(`line ${lineOf(raw, m.index)}: .isError read`);
      continue;
    }
    const isKey =
      /^isError\s*:/.test(masked.slice(m.index)) &&
      inside(m.index, { from: notice.open, to: notice.close + 1 });
    if (!isKey)
      strays.push(
        `line ${lineOf(raw, m.index)}: isError outside a member read`,
      );
  }
  assert.deepEqual(strays, [], `${FILE}: stray isError uses`);
});

test("the error arm's condition is exactly the precedent's", () => {
  const { raw, masked } = load();
  const arm = errorArm(masked, raw, componentBody(masked));
  assert.match(
    arm.condition,
    /^\(\s*detailPane\s*===\s*"\s*"\s*\|\|\s*!d\s*\)$/,
    `the error arm at line ${arm.line} must read \`(detailPane === "error" || !d)\``,
  );
});

test("no other arm can claim loaded content", () => {
  const { raw, masked } = load();
  const body = componentBody(masked);
  const arms = paneArms(masked, raw, body);
  const offArms = arms
    .filter((a) => !["skeleton", "offline", "error"].includes(a.literal))
    .map((a) => `line ${a.line}: "${a.literal}"`);
  assert.deepEqual(offArms, [], `${FILE}: an arm compares another pane state`);

  // In code, not a comment: masking keeps a code literal's quotes.
  const degraded = [...raw.matchAll(/(["'])content-degraded\1/g)].filter(
    (m) => masked[m.index] === m[1],
  );
  assert.equal(
    degraded.length,
    2,
    `${FILE}: "content-degraded" belongs to the focus-key collapse and the notice alone`,
  );

  const arm = errorArm(masked, raw, body);
  const strays = [];
  for (const m of masked
    .slice(0, body.close)
    .matchAll(/\bdetails\s*\??\.\s*(?:error|status)\b/g)) {
    if (m.index < body.open) continue;
    if (m.index < arm.from || m.index >= arm.to)
      strays.push(`line ${lineOf(raw, m.index)}`);
  }
  assert.deepEqual(
    strays,
    [],
    `${FILE}: details.error / details.status read outside the error arm`,
  );
});

test("the thread's hotkeys don't gate on the error flag", () => {
  const { masked } = load();
  const m = /\bconst\s+threadActive\s*=/.exec(masked);
  assert.ok(m, `${FILE}: anchor \`const threadActive =\` missing`);
  const end = statementEnd(masked, m.index);
  assert.ok(end > m.index, "the threadActive statement never ends");
  assert.doesNotMatch(masked.slice(m.index, end), /\bisError\b/);
});

test("the notice carries its message and a Retry only on a failure", () => {
  const { masked } = load();
  const tags = noticeTags(masked);
  assert.ok(tags.length > 0, `${FILE}: no <DegradedListNotice mount`);
  assert.ok(
    tags.some(
      (t) =>
        /\bonRetry=\{\s*detailFailed\s*\?\s*\(\s*\)\s*=>\s*details\s*\.\s*refetch\s*\(\s*\)\s*:\s*undefined\s*\}/.test(
          t,
        ) && /\bmessage=\{\s*detailNotice\s*\}/.test(t),
    ),
    "<DegradedListNotice must take message={detailNotice} and onRetry={detailFailed ? () => details.refetch() : undefined}",
  );
});

test("an arm swap lands focus on the host, and only an arm swap", () => {
  const { raw, masked } = load();
  // (a) Degraded content collapses into the content arm for the focus key.
  const collapse =
    /\bconst\s+(\w+)\s*=\s*detailPane\s*===\s*("[^"]*")\s*\?\s*("[^"]*")\s*:\s*detailPane\b/d.exec(
      masked,
    );
  assert.ok(
    collapse,
    `${FILE}: no \`= detailPane === … ? … : detailPane\` collapse`,
  );
  assert.equal(
    literalAt(masked, raw, collapse.indices[2][0]),
    "content-degraded",
  );
  assert.equal(literalAt(masked, raw, collapse.indices[3][0]), "content");
  const arm = collapse[1];

  // (b) The frame keys on the collapsed arm and the discussion.
  const frame = new RegExp(
    `\\bconst\\s+(\\w+)\\s*=\\s*\`\\$\\{\\s*${arm}\\s*\\}[^\`$]*\\$\\{\\s*discussionIdentity\\s*\\}\\s*\``,
  ).exec(masked);
  assert.ok(
    frame,
    `${FILE}: no frame template over \${${arm}} and \${discussionIdentity}`,
  );
  const name = frame[1];

  // (c) A change-only layout effect over that frame.
  const effects = callArgs(masked, "useLayoutEffect", 0, masked.length);
  assert.ok(effects.length > 0, `${FILE}: no useLayoutEffect( call`);
  const guard = new RegExp(
    `\\bif\\s*\\(\\s*\\w+\\s*\\.\\s*current\\s*===\\s*${name}\\s*\\)\\s*return\\b`,
  );
  const deps = new RegExp(`^\\s*,\\s*\\[\\s*${name}\\s*\\]\\s*,?\\s*$`);
  const ok = effects.some(({ open, close }) => {
    const arrow = masked.indexOf("=>", open);
    const bodyOpen = arrow < 0 ? -1 : masked.indexOf("{", arrow);
    if (bodyOpen < 0 || bodyOpen > close) return false;
    const bodyClose = matchBrace(masked, bodyOpen);
    if (bodyClose < 0 || bodyClose > close) return false;
    const fnBody = masked.slice(bodyOpen, bodyClose + 1);
    const g = guard.exec(fnBody);
    const focus =
      /\.\s*focus\s*\(\s*\{\s*preventScroll\s*:\s*true\s*\}\s*\)/.exec(fnBody);
    return (
      g !== null &&
      focus !== null &&
      g.index < focus.index &&
      /\bdocument\s*\.\s*activeElement\s*===\s*document\s*\.\s*body\b/.test(
        fnBody,
      ) &&
      deps.test(masked.slice(bodyClose + 1, close))
    );
  });
  assert.ok(
    ok,
    `no useLayoutEffect returns early on an unchanged ${name}, refocuses only from <body>, and depends on [${name}] alone`,
  );
});
