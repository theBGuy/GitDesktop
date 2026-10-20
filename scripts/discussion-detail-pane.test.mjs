// Pins DiscussionView's adoption of the shared detail-pane ladder: a failed or
// parked refresh keeps the loaded discussion under the degraded notice instead
// of swapping the pane for a placeholder. The helper's own transitions are
// pinned by remote-list-state.test.mjs; these scans pin only the wiring.
//
// Every scan runs on `maskNonCode`'s output, so comments and string/JSX text
// can't satisfy a pin; a string literal's value is read from the raw source at
// the masked quotes' offsets. A missing anchor fails, never skips.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { lineOf, maskNonCode, matchBrace } from "./lib/ts-mask.mjs";

const FILE = "src/features/discussions/DiscussionView.tsx";

let loaded;
function load() {
  if (loaded) return loaded;
  const raw = readFileSync(
    new URL("../src/features/discussions/DiscussionView.tsx", import.meta.url),
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

/** Where a JSX opening tag starting at `start` ends (its closing `>`). */
function tagEnd(masked, start) {
  let depth = 0;
  for (let i = start + 1; i < masked.length; i++) {
    const c = masked[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return i;
  }
  return -1;
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

test("the ladder reads the fetch in flight", () => {
  const { masked } = load();
  const body = componentBody(masked);
  const call = soleCall(masked, "resolveDetailPane", body);
  assert.match(
    masked.slice(call.open, call.close + 1),
    /\bfetching\s*:\s*details\s*\.\s*isFetching\b/,
    "resolveDetailPane( must pass `fetching: details.isFetching`",
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
