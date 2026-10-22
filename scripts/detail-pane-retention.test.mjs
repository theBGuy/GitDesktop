// Pins the detail panes that keep loaded content through a failed refresh on
// the shared ladder (resolveDetailPane + DegradedListNotice + Retry + focus
// rescue), per surface: the ladder's five inputs from the surface's own read,
// the notice in every content render with detailNoticeMessage copy, no raw
// `isError` swap, an error arm with the failure reason and a rescue-wired
// Retry, and the arm-or-record focus key (or its absence where a site opts
// out with `frameEffect: false`). It also pins the transcript diff's poll
// stopping while its read is errored, which keeps that pane's notice steady.
// remote-list-state.test.mjs pins the helpers' own transitions, and
// detail-pane-retry.test.mjs keeps every rescue-wired Retry free of a disabled
// state.
//
// Every scan runs on `maskNonCode`'s output, so comments and string/JSX text
// can't satisfy a pin; expected values are compared against the raw source at
// the masked offsets. A missing anchor fails, never skips.
//
// SITES is a closed roster: a new detail pane over a read joins it in the same
// change, or nothing here pins its retention.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { lineOf, maskNonCode, matchBrace, tagEnd } from "./lib/ts-mask.mjs";

/** Whitespace-free form, so formatting can't steer an exact comparison. */
const squash = (s) => s.replace(/\s+/g, "");

const SITES = [
  {
    file: "src/features/history/CommitDetailView.tsx",
    component: "CommitDetailView",
    inputs: {
      pending: "details.isPending || files.isPending",
      error: "details.isError || files.isError",
      hasData: "details.data !== undefined && files.data !== undefined",
      paused: "details.isPaused || files.isPaused",
      fetching: "details.isFetching || files.isFetching",
    },
    failed: {
      name: "failed",
      init: "(details.isError || files.isError) && !details.isFetching && !files.isFetching && !details.isPaused && !files.isPaused",
    },
    rescue: 'pane === "error" && (details.isError || files.isError)',
    retry: {
      name: "retryErrored",
      body: "{ if (details.isError) void details.refetch(); if (files.isError) void files.refetch(); }",
    },
    noun: "commit",
    noticeNoun: "this commit",
    stale: "stale",
    identity: ["hash"],
    shell: "content",
    isErrorDecls: ["failed", "retryErrored"],
  },
  {
    file: "src/features/repository/StashesDialog.tsx",
    component: "StashFiles",
    read: "files",
    noun: "stash",
    noticeNoun: "this stash",
    stale: "files.isPlaceholderData",
    identity: ["source.kind", "base"],
    shell: "notice",
  },
  {
    file: "src/features/history/BlameDialog.tsx",
    component: "BlameDialog",
    read: "blame",
    noun: "file's blame",
    noticeNoun: "this file's blame",
    stale: "blame.isPlaceholderData",
    identity: ["path", 'rev ?? ""'],
    shell: "notice",
  },
  {
    file: "src/features/repository/insights/InsightsPanel.tsx",
    component: "InsightsPanel",
    read: "stats",
    hasData: "data !== undefined",
    noun: "overview",
    noticeNoun: "the overview",
    stale: "stats.isPlaceholderData",
    identity: ["repoPath"],
    shell: "notice",
  },
  {
    file: "src/features/compare/BranchDiffView.tsx",
    component: "BranchDiffView",
    read: "files",
    noun: "comparison",
    noticeNoun: "this comparison",
    stale: "files.isPlaceholderData",
    identity: ["cmpKey"],
    shell: "content",
  },
  {
    file: "src/features/diff/MarkdownPreview.tsx",
    component: "MarkdownDocPreview",
    read: "activeQ",
    noun: "preview",
    noticeNoun: "this preview",
    stale: "activeQ.isPlaceholderData",
    identity: ["filePath", 'revs.newRev ?? ""', 'revs.oldRev ?? ""'],
    shell: "notice",
  },
  {
    file: "src/features/sessions/AgentTranscript.tsx",
    component: "InlineDiff",
    read: "diff",
    noun: "diff",
    noticeNoun: "this diff",
    stale: "diff.isPlaceholderData",
    shell: "notice",
    // No arm-swap refocus: several steps' diffs can be open at once, so one
    // landing while focus sits on <body> would take focus it never held.
    frameEffect: false,
  },
  {
    file: "src/features/issues/JiraIssueView.tsx",
    component: "JiraIssueView",
    read: "details",
    failedName: "detailFailed",
    noun: "Jira issue",
    noticeNoun: "this Jira issue",
    stale: "detailsStale",
    identity: ["issueIdentity"],
    shell: "content",
    // The unlinked teaching screen sits outside the ladder: no read backs it.
    exemptIf: ["!link.isPending && !link.data"],
  },
  {
    file: "src/features/pulls/PrCommitDetail.tsx",
    component: "PrCommitDetail",
    read: "diff",
    noun: "commit's changes",
    noticeNoun: "this commit's changes",
    stale: "false",
    identity: ["commit.oid"],
    shell: null,
  },
  {
    file: "src/features/code-todos/CodeTodoDetailView.tsx",
    component: "CodeTodoDetailView",
    read: "blame",
    noun: "excerpt",
    noticeNoun: "this excerpt",
    stale: "blame.isPlaceholderData",
    identity: ["path", "line"],
    shell: "notice",
    // Blame failing with nothing loaded is an untracked file's designed
    // disk-read fallback; the error arm is both sources failing.
    errorIf: "previewUnavailable",
    rescue: "previewUnavailable",
    retry: {
      name: "retryErrored",
      body: "{ if (blame.isError) void blame.refetch(); if (fileText.isError) void fileText.refetch(); }",
    },
    isErrorDecls: ["untracked", "previewUnavailable", "retryErrored"],
    // The notice follows the source on screen: the disk read for an untracked
    // file, blame otherwise.
    notice: {
      failed: "noticeFailed",
      retry: "noticeRetry",
      degraded: 'pane === "content-degraded" || noticeFailed',
      decls: {
        noticeFailed:
          "untracked ? fileText.data !== undefined && refreshFailed(fileText) : failed",
        noticeRetry:
          "untracked ? () => void fileText.refetch() : () => void blame.refetch()",
      },
    },
  },
];

/** Fills the single-read defaults: the ladder, the failure flag and the rescue
 *  all read `read`, and Retry is `() => void read.refetch()`. */
function expected(site) {
  if (site.inputs) return site;
  const r = site.read;
  const inline = `() => void ${r}.refetch()`;
  return {
    ...site,
    inputs: {
      pending: `${r}.isPending`,
      error: `${r}.isError`,
      hasData: site.hasData ?? `${r}.data !== undefined`,
      paused: `${r}.isPaused`,
      fetching: `${r}.isFetching`,
    },
    failed: {
      name: site.failedName ?? "failed",
      init: `refreshFailed(${r})`,
    },
    rescue: site.rescue ?? `pane === "error" && ${r}.isError`,
    retry: site.retry ?? { inline },
    noticeRetry: site.noticeRetry ?? inline,
  };
}

const cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file);
  const raw = readFileSync(
    new URL(`../${file}`, import.meta.url),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const entry = { raw, masked: maskNonCode(raw, file.endsWith(".tsx")) };
  cache.set(file, entry);
  return entry;
}

/** End (exclusive) of the statement starting at `from`: its first `;` at
 *  bracket depth zero, or the bracket closing the enclosing block. */
function statementEnd(masked, from) {
  let depth = 0;
  for (let i = from; i < masked.length; i++) {
    const c = masked[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return i;
      depth--;
    } else if (c === ";" && depth === 0) return i + 1;
  }
  return -1;
}

/** The `{…}` span of `function <name>(…)`. */
function componentBody(file, masked, name) {
  const m = new RegExp(`\\bfunction\\s+${name}\\s*\\(`).exec(masked);
  assert.ok(m, `${file}: anchor \`function ${name}(\` missing`);
  const paramsOpen = m.index + m[0].length - 1;
  const paramsClose = matchBrace(masked, paramsOpen);
  assert.ok(paramsClose > 0, `${file}: ${name}'s parameter list never closes`);
  const open = masked.indexOf("{", paramsClose);
  const close = open < 0 ? -1 : matchBrace(masked, open);
  assert.ok(close > open, `${file}: ${name}'s body never closes`);
  return { open, close };
}

/** Every call to `name` inside `span`, as its `(…)` offsets. */
function calls(masked, name, span) {
  const re = new RegExp(`(?<![\\w$.])${name}\\s*\\(`, "g");
  re.lastIndex = span.open;
  const out = [];
  for (
    let m = re.exec(masked);
    m && m.index < span.close;
    m = re.exec(masked)
  ) {
    const open = m.index + m[0].length - 1;
    const close = matchBrace(masked, open);
    assert.ok(
      close > open,
      `${name}( never closes at line ${lineOf(masked, open)}`,
    );
    out.push({ start: m.index, open, close });
  }
  return out;
}

function soleCall(site, masked, name, span) {
  const found = calls(masked, name, span);
  assert.equal(
    found.length,
    1,
    `${site.file}: expected exactly one \`${name}(\` call in ${site.component}, found ${found.length}`,
  );
  return found[0];
}

/** The `key: value` pairs of the object literal whose `{` sits at `open`, as
 *  raw value text (a shorthand `key` reads as `key: key`); a spread fails. */
function objectPairs(file, masked, raw, open) {
  assert.equal(
    masked[open],
    "{",
    `${file}: no object literal at line ${lineOf(raw, open)}`,
  );
  const close = matchBrace(masked, open);
  assert.ok(close > open, `${file}: an object literal never closes`);
  const pairs = new Map();
  let start = open + 1;
  let depth = 0;
  const flush = (end) => {
    const text = masked.slice(start, end);
    if (text.trim() === "") return;
    const short = /^\s*([\w$]+)\s*$/.exec(text);
    if (short) {
      assert.ok(!pairs.has(short[1]), `${file}: duplicate key \`${short[1]}\``);
      pairs.set(short[1], short[1]);
      return;
    }
    const key = /^\s*([\w$]+)\s*:/.exec(text);
    assert.ok(key, `${file}: unreadable pair at line ${lineOf(raw, start)}`);
    assert.ok(!pairs.has(key[1]), `${file}: duplicate key \`${key[1]}\``);
    pairs.set(key[1], raw.slice(start + key[0].length, end).trim());
  };
  for (let i = open + 1; i < close; i++) {
    const c = masked[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      flush(i);
      start = i + 1;
    }
  }
  flush(close);
  return pairs;
}

/** The attributes of the opening tag starting at `start`, as raw value text
 *  (a `{…}` value keeps its braces' inside, a quoted one its quotes'). */
function tagAttrs(masked, raw, start) {
  const end = tagEnd(masked, start);
  assert.ok(end > start, `a tag never closes at line ${lineOf(raw, start)}`);
  const attrs = new Map();
  const re = /(?<![\w$.-])([\w$-]+)=(?=[{"'])/g;
  re.lastIndex = start;
  for (let m = re.exec(masked); m && m.index < end; m = re.exec(masked)) {
    const at = m.index + m[0].length;
    if (masked[at] === "{") {
      const close = matchBrace(masked, at);
      attrs.set(m[1], raw.slice(at + 1, close));
      re.lastIndex = close + 1;
    } else {
      const close = masked.indexOf(masked[at], at + 1);
      attrs.set(m[1], raw.slice(at + 1, close));
      re.lastIndex = close + 1;
    }
  }
  return { end, attrs };
}

/** Spans of the functions nested inside `span` (arrow block bodies and
 *  `function` declarations): a `return` there isn't the component's. */
function nestedFunctions(masked, span) {
  const out = [];
  for (const m of masked
    .slice(span.open + 1, span.close)
    .matchAll(/=>\s*\{/g)) {
    const open = span.open + 1 + m.index + m[0].length - 1;
    out.push({ from: open, to: matchBrace(masked, open) });
  }
  for (const m of masked
    .slice(span.open + 1, span.close)
    .matchAll(/(?<![\w$.])function\b[^(]*\(/g)) {
    const paren = span.open + 1 + m.index + m[0].length - 1;
    const open = masked.indexOf("{", matchBrace(masked, paren));
    out.push({ from: open, to: matchBrace(masked, open) });
  }
  return out;
}

/** Every `if (…)` in `span` outside nested functions: its raw condition (the
 *  parens' inside) and the span of the block or statement it guards. */
function ifs(masked, raw, span, nested) {
  const out = [];
  const re = /(?<![\w$])if\s*\(/g;
  re.lastIndex = span.open;
  for (
    let m = re.exec(masked);
    m && m.index < span.close;
    m = re.exec(masked)
  ) {
    if (nested.some((n) => m.index > n.from && m.index < n.to)) continue;
    const open = m.index + m[0].length - 1;
    const close = matchBrace(masked, open);
    let from = close + 1;
    while (/\s/.test(masked[from])) from++;
    const to =
      masked[from] === "{"
        ? matchBrace(masked, from) + 1
        : statementEnd(masked, from);
    assert.ok(to > from, `the if at line ${lineOf(raw, m.index)} never ends`);
    out.push({
      line: lineOf(raw, m.index),
      cond: raw.slice(open + 1, close),
      maskedCond: masked.slice(open + 1, close),
      from,
      to,
    });
  }
  return out;
}

/** The pane literals a condition compares (`pane === "…"`). */
function paneLiterals(cond) {
  return [...cond.matchAll(/(?<![\w$.])pane\s*===\s*"([^"]*)"/g)].map(
    (m) => m[1],
  );
}

/** The arms of the ladder: `if (pane === "skeleton" | "offline" | "error" …)`
 *  statements, or `case "…":` labels inside a switch over the pane. */
function arms(site, masked, raw, body, nested) {
  const out = [];
  for (const s of ifs(masked, raw, body, nested)) {
    const lits = paneLiterals(s.cond);
    if (lits.length === 0) continue;
    // A literal in the masked condition keeps only its quotes; one that moved
    // into a comment drops out of the masked text.
    assert.equal(
      [...s.maskedCond.matchAll(/(?<![\w$.])pane\s*===\s*"/g)].length,
      lits.length,
      `${site.file}:${s.line}: a pane comparison is not code`,
    );
    out.push({ ...s, lits });
  }
  // A pane whose ladder "error" is a designed fallback names its true error
  // arm by condition instead.
  if (site.errorIf) {
    const hits = ifs(masked, raw, body, nested).filter(
      (s) => squash(s.cond) === squash(site.errorIf),
    );
    assert.equal(
      hits.length,
      1,
      `${site.file}: expected one \`if (${site.errorIf})\` error arm`,
    );
    out.push({ ...hits[0], lits: ["error"] });
  }
  const sw = /(?<![\w$])switch\s*\(\s*pane\s*\)\s*\{/.exec(masked);
  if (sw) {
    const open = sw.index + sw[0].length - 1;
    const close = matchBrace(masked, open);
    const labels = [
      ...masked.slice(open, close).matchAll(/(?<![\w$])case\s+"/g),
    ];
    for (const [k, m] of labels.entries()) {
      const at = open + m.index + m[0].length - 1;
      const lit = raw.slice(at + 1, masked.indexOf('"', at + 1));
      const next = labels[k + 1] ? open + labels[k + 1].index : close;
      out.push({
        line: lineOf(raw, at),
        cond: `case ${lit}`,
        lits: [lit],
        from: at,
        to: next,
      });
    }
  }
  return out;
}

/** The returns of the component itself (not of nested functions), each with
 *  the span of its returned expression. */
function componentReturns(masked, body, nested) {
  const out = [];
  for (const m of masked
    .slice(body.open + 1, body.close)
    .matchAll(/(?<![\w$.])return\b/g)) {
    const at = body.open + 1 + m.index;
    if (nested.some((n) => at > n.from && at < n.to)) continue;
    out.push({ at, to: statementEnd(masked, at) });
  }
  return out;
}

const inside = (i, s) => i >= s.from && i < s.to;

/** The arms that may draw without the notice: every pane state they compare is
 *  a loading or error state, never content. */
const NON_CONTENT = new Set(["skeleton", "offline", "error"]);
const nonContentArm = (a) => a.lits.every((l) => NON_CONTENT.has(l));

function scan(site) {
  const { raw, masked } = load(site.file);
  const body = componentBody(site.file, masked, site.component);
  const nested = nestedFunctions(masked, body);
  return {
    raw,
    masked,
    body,
    nested,
    arms: arms(site, masked, raw, body, nested),
  };
}

/** The one `const shell = (content…) => (…)` helper, as its `(…)` span. */
function shellSpan(site, masked, body) {
  const re =
    /\bconst\s+shell\s*=\s*\(\s*content\s*(?::\s*ReactNode\s*)?\)\s*=>\s*\(/g;
  re.lastIndex = body.open;
  const found = [];
  for (
    let m = re.exec(masked);
    m && m.index < body.close;
    m = re.exec(masked)
  ) {
    const open = m.index + m[0].length - 1;
    found.push({ from: open, to: matchBrace(masked, open) + 1 });
  }
  assert.equal(
    found.length,
    1,
    `${site.file}: expected one \`const shell = (content) => (\` in ${site.component}`,
  );
  return found[0];
}

/** Every `<DegradedListNotice` opening tag inside `span`. */
function noticeTags(masked, span) {
  const out = [];
  const re = /<DegradedListNotice\b/g;
  re.lastIndex = span.from;
  for (let m = re.exec(masked); m && m.index < span.to; m = re.exec(masked))
    out.push(m.index);
  return out;
}

for (const raw of SITES) {
  const site = expected(raw);
  const label = `${site.file} (${site.component})`;

  test(`${label}: the ladder's helpers come from their shared modules`, () => {
    const { raw: src, masked } = load(site.file);
    const from = (names, module) => {
      const hit = [
        ...masked.matchAll(/\bimport\s*\{([^}]*)\}\s*from\s*"/g),
      ].some((m) => {
        const got = m[1]
          .split(",")
          .map((s) => s.trim().replace(/^type\s+/, ""));
        const at = m.index + m[0].length - 1;
        const mod = src.slice(at + 1, masked.indexOf('"', at + 1));
        return mod === module && names.every((n) => got.includes(n));
      });
      assert.ok(
        hit,
        `${site.file}: no import brings ${names.join(", ")} from ${module}`,
      );
    };
    from(
      ["resolveDetailPane", "detailNoticeMessage"],
      "@/features/conversations/remote-section-state",
    );
    from(
      ["DegradedListNotice", "useRetryFocusRescue"],
      "@/features/conversations/ConversationListPanel",
    );
    from(["presentError"], "@/lib/error-summary");
  });

  test(`${label}: the ladder reads its five inputs from the surface's read`, () => {
    const { raw: src, masked, body } = scan(site);
    const call = soleCall(site, masked, "resolveDetailPane", body);
    const bound = /\bconst\s+pane\s*=\s*$/.test(
      masked.slice(body.open, call.start),
    );
    assert.ok(
      bound,
      `${site.file}: the ladder's result must bind \`const pane =\``,
    );
    let objOpen = call.open + 1;
    while (/\s/.test(masked[objOpen])) objOpen++;
    const pairs = objectPairs(site.file, masked, src, objOpen);
    assert.deepEqual(
      [...pairs.keys()].sort(),
      ["error", "fetching", "hasData", "paused", "pending"],
      `${site.file}: resolveDetailPane( must pass exactly the five inputs`,
    );
    for (const [key, want] of Object.entries(site.inputs))
      assert.equal(
        squash(pairs.get(key)),
        squash(want),
        `${site.file}: resolveDetailPane( must pass \`${key}: ${want}\``,
      );
    const failed = new RegExp(`\\bconst\\s+${site.failed.name}\\s*=\\s*`).exec(
      masked.slice(body.open, body.close),
    );
    assert.ok(failed, `${site.file}: no \`const ${site.failed.name} =\``);
    const at = body.open + failed.index + failed[0].length;
    assert.equal(
      squash(src.slice(at, statementEnd(masked, at) - 1)),
      squash(site.failed.init),
      `${site.file}: \`${site.failed.name}\` must be \`${site.failed.init}\``,
    );
  });

  test(`${label}: the notice mounts in every content render with the shared copy`, () => {
    const { raw: src, masked, body, nested, arms: paneArms } = scan(site);
    const noticeFailed = site.notice?.failed ?? site.failed.name;
    const degraded = site.notice?.degraded ?? 'pane === "content-degraded"';
    const tags = noticeTags(masked, { from: body.open, to: body.close });
    assert.ok(
      tags.length > 0,
      `${site.file}: no <DegradedListNotice in ${site.component}`,
    );
    assert.equal(
      tags.length,
      1,
      `${site.file}: expected one <DegradedListNotice tag`,
    );
    const { attrs } = tagAttrs(masked, src, tags[0]);
    assert.equal(
      attrs.get("noun"),
      site.noticeNoun,
      `${site.file}: notice noun`,
    );
    assert.equal(
      squash(attrs.get("degraded") ?? ""),
      squash(degraded),
      `${site.file}: the notice must take degraded={${degraded}}`,
    );
    for (const [name, init] of Object.entries(site.notice?.decls ?? {})) {
      const d = new RegExp(`\\bconst\\s+${name}\\s*=\\s*`).exec(
        masked.slice(body.open, body.close),
      );
      assert.ok(d, `${site.file}: no \`const ${name} =\``);
      const at = body.open + d.index + d[0].length;
      assert.equal(
        squash(src.slice(at, statementEnd(masked, at) - 1)),
        squash(init),
        `${site.file}: \`${name}\` must be \`${init}\``,
      );
    }
    // The copy: inline, or a const holding the one detailNoticeMessage( call.
    const msgCall = soleCall(site, masked, "detailNoticeMessage", body);
    const message = squash(attrs.get("message") ?? "");
    if (!message.startsWith("detailNoticeMessage(")) {
      const bind = new RegExp(`\\bconst\\s+${message}\\s*=\\s*$`);
      assert.ok(
        /^[\w$]+$/.test(message) &&
          bind.test(masked.slice(body.open, msgCall.start)),
        `${site.file}: the notice's message must be detailNoticeMessage( or a const holding it`,
      );
    } else {
      assert.ok(
        tags[0] < msgCall.start && msgCall.start < tagEnd(masked, tags[0]),
        `${site.file}: the inline detailNoticeMessage( must feed this notice`,
      );
    }
    let objOpen = msgCall.open + 1;
    while (/\s/.test(masked[objOpen])) objOpen++;
    const pairs = objectPairs(site.file, masked, src, objOpen);
    assert.equal(
      pairs.get("noun"),
      JSON.stringify(site.noun),
      `${site.file}: copy noun`,
    );
    assert.equal(
      squash(pairs.get("isError") ?? ""),
      noticeFailed,
      `${site.file}: the copy's isError must read \`${noticeFailed}\``,
    );
    assert.equal(
      squash(pairs.get("stale") ?? ""),
      squash(site.stale),
      `${site.file}: the copy's stale must read \`${site.stale}\``,
    );
    const retry =
      site.notice?.retry ??
      site.noticeRetry ??
      site.retry.name ??
      site.retry.inline;
    assert.equal(
      squash(attrs.get("onRetry") ?? ""),
      squash(`${noticeFailed} ? ${retry} : undefined`),
      `${site.file}: the notice must take onRetry={${noticeFailed} ? ${retry} : undefined}`,
    );

    // Every render that isn't a skeleton/offline/error arm draws the notice:
    // through a shell that holds it, or the tag (or a const of it) inline.
    const shell = site.shell ? shellSpan(site, masked, body) : null;
    const noticeInShell =
      shell !== null && tags[0] > shell.from && tags[0] < shell.to;
    assert.equal(
      noticeInShell,
      site.shell === "notice",
      `${site.file}: the notice ${site.shell === "notice" ? "must" : "must not"} sit in the shell`,
    );
    const noticeConst = (() => {
      const m = /\bconst\s+([\w$]+)\s*=\s*\(\s*$/.exec(
        masked.slice(body.open, tags[0]),
      );
      return m ? m[1] : null;
    })();
    const exempt = ifs(masked, src, body, nested).filter((s) =>
      (site.exemptIf ?? []).some((c) => squash(c) === squash(s.cond)),
    );
    assert.equal(
      exempt.length,
      (site.exemptIf ?? []).length,
      `${site.file}: an exempt condition's anchor is missing`,
    );
    const missing = [];
    const returns = componentReturns(masked, body, nested);
    assert.ok(
      returns.length > 0,
      `${site.file}: ${site.component} has no return`,
    );
    for (const r of returns) {
      if (paneArms.some((a) => nonContentArm(a) && inside(r.at, a))) continue;
      if (exempt.some((e) => inside(r.at, e))) continue;
      const expr = masked.slice(r.at, r.to);
      const viaShell = /^return\s+shell\s*\(/.test(expr);
      const ok =
        (viaShell && noticeInShell) ||
        /<DegradedListNotice\b/.test(expr) ||
        (noticeConst !== null &&
          new RegExp(`\\{\\s*${noticeConst}\\s*\\}`).test(expr));
      if (!ok) missing.push(`line ${lineOf(src, r.at)}`);
    }
    assert.deepEqual(
      missing,
      [],
      `${site.file}: a content render without the notice`,
    );
    // A switch over the pane draws content under its "content-degraded" label.
    if (paneArms.some((a) => a.cond.startsWith("case "))) {
      const content = paneArms.find(
        (a) =>
          a.cond.startsWith("case ") && a.lits.includes("content-degraded"),
      );
      assert.ok(
        content && inside(tags[0], content),
        `${site.file}: the notice must render under case "content-degraded"`,
      );
    }
  });

  test(`${label}: every arm and content render draws inside the one host`, () => {
    const { raw: src, masked, body, nested, arms: paneArms } = scan(site);
    // The host: the one element whose ref hands its node to hostRef and
    // focusHost, carrying tabIndex={-1}.
    const hosts = [];
    for (const m of masked
      .slice(body.open, body.close)
      .matchAll(/(?<![\w$.-])ref=\{/g)) {
      const at = body.open + m.index + m[0].length - 1;
      const value = masked.slice(at + 1, matchBrace(masked, at)).trim();
      let fn = value;
      // A host with no refocus effect passes hostRef itself.
      if (value === "hostRef") fn = "hostRef(node)";
      else if (/^[\w$]+$/.test(value)) {
        const def = new RegExp(
          `\\bconst\\s+${value}\\s*=\\s*useCallback\\s*\\(`,
        ).exec(masked.slice(body.open, body.close));
        if (!def) continue;
        const open = body.open + def.index + def[0].length - 1;
        fn = masked.slice(open, matchBrace(masked, open) + 1);
      }
      if (!/\bhostRef\s*\(/.test(fn)) continue;
      let start = at;
      while (
        start > body.open &&
        !(masked[start] === "<" && /[A-Za-z]/.test(masked[start + 1]))
      )
        start--;
      hosts.push({ start, fn });
    }
    assert.equal(
      hosts.length,
      1,
      `${site.file}: expected one element whose ref calls hostRef(`,
    );
    const [host] = hosts;
    const node = /\bhostRef\s*\(\s*([\w$]+)\s*\)/.exec(host.fn);
    assert.ok(node, `${site.file}: the host's ref must call hostRef(node)`);
    if (site.frameEffect !== false)
      assert.match(
        host.fn,
        new RegExp(`\\bfocusHost\\s*\\.\\s*current\\s*=\\s*${node[1]}\\b`),
        `${site.file}: the host's ref must set focusHost.current = ${node[1]}`,
      );
    const { attrs } = tagAttrs(masked, src, host.start);
    assert.equal(
      squash(attrs.get("tabIndex") ?? ""),
      "-1",
      `${site.file}: the host needs tabIndex={-1}`,
    );
    // Never the scroller: a tabIndex there takes the keyboard tab stop
    // Chromium gives a scroller with no focusable content.
    assert.doesNotMatch(
      attrs.get("className") ?? "",
      /(?<![\w-])overflow-/,
      `${site.file}: the host must not be a scroll container`,
    );

    if (!site.shell) {
      // A persistent root: the host must be the component's only top-level
      // return's root element.
      const returns = componentReturns(masked, body, nested);
      assert.equal(
        returns.length,
        1,
        `${site.file}: expected one top-level return`,
      );
      const root = /^return\s*\(\s*</.exec(masked.slice(returns[0].at));
      assert.ok(
        root && returns[0].at + root[0].length - 1 === host.start,
        `${site.file}: the host must be the persistent root element`,
      );
      return;
    }
    const shell = shellSpan(site, masked, body);
    assert.ok(
      host.start > shell.from && host.start < shell.to,
      `${site.file}: the host must render inside shell(`,
    );
    assert.match(
      masked.slice(shell.from, shell.to),
      /\{\s*content\s*\}/,
      "shell( must render content",
    );
    const exempt = ifs(masked, src, body, nested).filter((s) =>
      (site.exemptIf ?? []).some((c) => squash(c) === squash(s.cond)),
    );
    const unshelled = [];
    for (const r of componentReturns(masked, body, nested)) {
      if (exempt.some((e) => inside(r.at, e))) continue;
      if (!/^return\s+shell\s*\(/.test(masked.slice(r.at)))
        unshelled.push(`line ${lineOf(src, r.at)}`);
    }
    assert.deepEqual(unshelled, [], `${site.file}: a return bypasses shell(`);
    assert.ok(paneArms.length > 0, `${site.file}: no pane arm`);
  });

  test(`${label}: the error arm shows the reason and a rescue-wired Retry`, () => {
    const { raw: src, masked, body, arms: paneArms } = scan(site);
    const errorArms = paneArms.filter((a) => a.lits.includes("error"));
    assert.equal(errorArms.length, 1, `${site.file}: expected one error arm`);
    const [arm] = errorArms;
    const own = masked.slice(arm.from, arm.to);
    assert.match(
      own,
      /(?<![\w$.])presentError\s*\(/,
      `${site.file}: the error arm must read presentError(`,
    );
    const retries = [...own.matchAll(/(?<![\w$.-])ref=\{\s*retryRef\s*\}/g)];
    assert.equal(
      retries.length,
      1,
      `${site.file}: the error arm needs one ref={retryRef}`,
    );
    let start = arm.from + retries[0].index;
    while (!(masked[start] === "<" && /[A-Za-z]/.test(masked[start + 1])))
      start--;
    const { attrs } = tagAttrs(masked, src, start);
    const onClick = squash(attrs.get("onClick") ?? "");
    const want = site.retry.name ?? site.retry.inline;
    assert.equal(
      onClick,
      squash(want),
      `${site.file}: the Retry must take onClick={${want}}`,
    );
    assert.ok(
      !attrs.has("disabled"),
      `${site.file}: the error-arm Retry carries no disabled state`,
    );
    if (site.retry.name) {
      const def = new RegExp(
        `\\bconst\\s+${site.retry.name}\\s*=\\s*\\(\\s*\\)\\s*=>\\s*`,
      ).exec(masked.slice(body.open, body.close));
      assert.ok(def, `${site.file}: no \`const ${site.retry.name} = () =>\``);
      const open = body.open + def.index + def[0].length;
      assert.equal(
        masked[open],
        "{",
        `${site.file}: ${site.retry.name} needs a block body`,
      );
      assert.equal(
        squash(src.slice(open, matchBrace(masked, open) + 1)),
        squash(site.retry.body),
        `${site.file}: ${site.retry.name} must refetch exactly the errored read(s)`,
      );
    }
    const rescue = soleCall(site, masked, "useRetryFocusRescue", body);
    assert.equal(
      squash(src.slice(rescue.open + 1, rescue.close)).replace(/,$/, ""),
      squash(site.rescue),
      `${site.file}: useRetryFocusRescue( must take exactly \`${site.rescue}\``,
    );
  });

  // Scope: from the ladder call to the end of the component's last return, the
  // span where the pane decides what to draw, so error reads elsewhere in a
  // large body (hook inputs above the ladder) can't red it. Swap shapes: any
  // `.isError`, `.error` or `.status` member read there (a method call such as
  // `toast.error(` is not a read) outside the ladder, the rescue, the error arm
  // and the declarations named in `isErrorDecls`.
  test(`${label}: no raw error swap replaces loaded content`, () => {
    const { raw: src, masked, body, nested, arms: paneArms } = scan(site);
    const ladder = soleCall(site, masked, "resolveDetailPane", body);
    const rescue = soleCall(site, masked, "useRetryFocusRescue", body);
    const returns = componentReturns(masked, body, nested);
    assert.ok(
      returns.length > 0,
      `${site.file}: ${site.component} has no return`,
    );
    const region = { from: ladder.start, to: returns[returns.length - 1].to };
    assert.ok(
      region.to > region.from,
      `${site.file}: no return follows the ladder`,
    );
    const allowed = [
      { from: ladder.open, to: ladder.close + 1 },
      { from: rescue.open, to: rescue.close + 1 },
      ...paneArms.filter((a) => a.lits.includes("error")),
    ];
    for (const name of [site.failed.name, ...(site.isErrorDecls ?? [])]) {
      const m = new RegExp(`\\bconst\\s+${name}\\s*=`).exec(
        masked.slice(body.open, body.close),
      );
      if (!m) continue;
      const at = body.open + m.index;
      allowed.push({ from: at, to: statementEnd(masked, at) });
    }
    const strays = [];
    for (const m of masked
      .slice(region.from, region.to)
      .matchAll(/\.\s*(isError|error|status)\b(?![\w$]|\s*\()/g)) {
      const at = region.from + m.index;
      if (!allowed.some((r) => inside(at, r)))
        strays.push(`line ${lineOf(src, at)}: .${m[1]}`);
    }
    assert.deepEqual(
      strays,
      [],
      `${site.file}: an error read outside the ladder, rescue and error arm`,
    );
  });

  if (site.frameEffect === false) {
    test(`${label}: no arm-swap effect refocuses the host from <body>`, () => {
      const { masked, body } = scan(site);
      assert.doesNotMatch(
        masked.slice(body.open, body.close),
        /\bdocument\s*\.\s*activeElement\s*===\s*document\s*\.\s*body\b/,
        `${site.file}: ${site.component} must not move focus from <body> on its own`,
      );
    });
    continue;
  }

  test(`${label}: an arm or record change refocuses the host, from <body> only`, () => {
    const { raw: src, masked, body } = scan(site);
    const text = masked.slice(body.open, body.close);
    const collapse =
      /\bconst\s+arm\s*=\s*pane\s*===\s*"\s*"\s*\?\s*"\s*"\s*:\s*pane\b/.exec(
        text,
      );
    assert.ok(
      collapse,
      `${site.file}: no \`const arm = pane === … ? … : pane\` collapse`,
    );
    assert.equal(
      squash(
        src.slice(
          body.open + collapse.index,
          body.open + collapse.index + collapse[0].length,
        ),
      ),
      squash('const arm = pane === "content-degraded" ? "content" : pane'),
    );
    const frame = /\bconst\s+viewFrame\s*=\s*`/.exec(text);
    assert.ok(frame, `${site.file}: no \`const viewFrame = \`…\`\``);
    const tplOpen = body.open + frame.index + frame[0].length - 1;
    const tplClose = masked.indexOf("`", tplOpen + 1);
    const exprs = [
      ...src.slice(tplOpen, tplClose + 1).matchAll(/\$\{([^}]*)\}/g),
    ].map((m) => squash(m[1]));
    assert.deepEqual(
      exprs,
      ["arm", ...site.identity.map(squash)],
      `${site.file}: the frame must key \${arm} then ${site.identity.join(", ")}`,
    );
    const effects = calls(masked, "useLayoutEffect", body);
    const ok = effects.some(({ open, close }) => {
      const arrow = masked.indexOf("=>", open);
      const bodyOpen = arrow < 0 ? -1 : masked.indexOf("{", arrow);
      if (bodyOpen < 0 || bodyOpen > close) return false;
      const bodyClose = matchBrace(masked, bodyOpen);
      const fn = masked.slice(bodyOpen, bodyClose + 1);
      const guard =
        /\bif\s*\(\s*([\w$]+)\s*\.\s*current\s*===\s*viewFrame\s*\)\s*return\b/.exec(
          fn,
        );
      if (!guard) return false;
      // The guard's ref is seeded from the frame and advanced to it, so only
      // a changed frame passes the guard.
      const ref = guard[1];
      const advance = new RegExp(
        `\\b${ref}\\s*\\.\\s*current\\s*=\\s*viewFrame\\s*;`,
      ).exec(fn);
      const seeded = new RegExp(
        `\\bconst\\s+${ref}\\s*=\\s*useRef\\s*\\(\\s*viewFrame\\s*\\)`,
      ).test(text);
      const focus =
        /\bfocusHost\s*\.\s*current\s*\?\.\s*focus\s*\(\s*\{\s*preventScroll\s*:\s*true\s*\}\s*\)/.exec(
          fn,
        );
      return (
        seeded &&
        advance !== null &&
        guard.index < advance.index &&
        focus !== null &&
        advance.index < focus.index &&
        /\bdocument\s*\.\s*activeElement\s*===\s*document\s*\.\s*body\b/.test(
          fn,
        ) &&
        /^\s*,\s*\[\s*viewFrame\s*\]\s*,?\s*$/.test(
          masked.slice(bodyClose + 1, close),
        )
      );
    });
    assert.ok(
      ok,
      `${site.file}: no useLayoutEffect returns early on an unchanged viewFrame (its ref seeded with useRef(viewFrame) and advanced to it), refocuses focusHost only from <body>, and depends on [viewFrame] alone`,
    );
  });
}

test("Blame keeps list semantics through a degraded refresh, the notice outside the list", () => {
  const file = "src/features/history/BlameDialog.tsx";
  const { raw, masked } = load(file);
  const m = /(?<![\w$.-])role=\{/.exec(masked);
  assert.ok(m, `${file}: no role={…} on the scroll container`);
  const open = m.index + m[0].length - 1;
  assert.equal(
    squash(raw.slice(open + 1, matchBrace(masked, open))),
    squash(
      '(pane === "content" || pane === "content-degraded") && lines.length > 0 ? "list" : undefined',
    ),
    `${file}: role must key on the resolved content arms and rendered rows`,
  );
  let start = open;
  while (!(masked[start] === "<" && /[A-Za-z]/.test(masked[start + 1])))
    start--;
  const notice = masked.indexOf("<DegradedListNotice");
  assert.ok(
    notice > 0 && notice < start,
    `${file}: the notice must precede the list container`,
  );
  const { attrs } = tagAttrs(masked, raw, start);
  assert.equal(
    squash(attrs.get("ref") ?? ""),
    "setScrollEl",
    `${file}: the list container's ref is setScrollEl alone`,
  );
  assert.ok(
    !attrs.has("tabIndex"),
    `${file}: the list container takes no tabIndex`,
  );
});

test("the transcript diff's notice sits above its scroller, which the host wraps", () => {
  const file = "src/features/sessions/AgentTranscript.tsx";
  const { raw, masked } = load(file);
  const body = componentBody(file, masked, "InlineDiff");
  const m = /(?<![\w$.-])ref=\{\s*paneRef\s*\}/.exec(
    masked.slice(body.open, body.close),
  );
  assert.ok(m, `${file}: no element takes ref={paneRef}`);
  let start = body.open + m.index;
  while (!(masked[start] === "<" && /[A-Za-z]/.test(masked[start + 1])))
    start--;
  const { attrs } = tagAttrs(masked, raw, start);
  assert.match(
    attrs.get("className") ?? "",
    /(?<![\w-])max-h-96(?![\w-]).*(?<![\w-])overflow-auto(?![\w-])/,
    `${file}: the paneRef element is the max-h-96 scroller`,
  );
  assert.ok(!attrs.has("tabIndex"), `${file}: the scroller takes no tabIndex`);
  const shell = shellSpan({ file, component: "InlineDiff" }, masked, body);
  const notice = masked.indexOf("<DegradedListNotice", shell.from);
  assert.ok(
    notice > shell.from && notice < start && start < shell.to,
    `${file}: the notice must precede the scroller inside the shell`,
  );
});

test("a TODO's untracked fallback opens only on a blame with nothing loaded", () => {
  const file = "src/features/code-todos/CodeTodoDetailView.tsx";
  const { raw, masked } = load(file);
  const m = /\bconst\s+untracked\s*=\s*/.exec(masked);
  assert.ok(m, `${file}: anchor \`const untracked =\` missing`);
  const at = m.index + m[0].length;
  assert.equal(
    squash(raw.slice(at, statementEnd(masked, at) - 1)),
    squash("blame.isError && blame.data === undefined"),
    `${file}: untracked must be \`blame.isError && blame.data === undefined\``,
  );
  const read = /(?<![\w$.])useFileText\s*\(/.exec(masked);
  assert.ok(read, `${file}: no useFileText( call`);
  const open = read.index + read[0].length - 1;
  const args = squash(raw.slice(open + 1, matchBrace(masked, open))).split(",");
  assert.equal(
    args[2],
    "untracked",
    `${file}: the disk read must be enabled on \`untracked\` alone`,
  );
  const excerpt =
    /\bconst\s+excerptLines\s*:[^=]*=\s*untracked\s*\?/.test(masked) &&
    /\{\s*untracked\s*&&\s*\(/.test(masked);
  assert.ok(
    excerpt,
    `${file}: the excerpt source and the untracked note must gate on \`untracked\``,
  );
});

test("a deleted file's retained answer keeps the old side through a failed refresh", () => {
  const file = "src/features/diff/MarkdownPreview.tsx";
  const { raw, masked } = load(file);
  const m = /\bconst\s+newAbsent\s*=\s*/.exec(masked);
  assert.ok(m, `${file}: anchor \`const newAbsent =\` missing`);
  const at = m.index + m[0].length;
  const init = squash(raw.slice(at, statementEnd(masked, at) - 1));
  assert.match(
    init,
    /newQ\.data===null/,
    `${file}: newAbsent must read newQ.data === null`,
  );
  assert.doesNotMatch(
    init,
    /\.(?:isError|error|status)\b/,
    `${file}: newAbsent must not read newQ's failure, or a failed refresh flips the preview back to the new side`,
  );
});

test("Markdown preview reports its settle before every return", () => {
  const file = "src/features/diff/MarkdownPreview.tsx";
  const { raw, masked } = load(file);
  const body = componentBody(file, masked, "MarkdownDocPreview");
  const nested = nestedFunctions(masked, body);
  const report = calls(masked, "useReportPaneSettled", body);
  assert.equal(
    report.length,
    1,
    `${file}: expected one useReportPaneSettled( call`,
  );
  const first = componentReturns(masked, body, nested)[0];
  assert.ok(first, `${file}: MarkdownDocPreview has no return`);
  assert.ok(
    report[0].start < first.at,
    `${file}: line ${lineOf(raw, first.at)} returns before the settle report`,
  );
});

test("Branch compare holds the skeleton over an empty placeholder list", () => {
  const file = "src/features/compare/BranchDiffView.tsx";
  const { raw, masked } = load(file);
  const body = componentBody(file, masked, "BranchDiffView");
  const nested = nestedFunctions(masked, body);
  const skel = ifs(masked, raw, body, nested).filter((s) =>
    paneLiterals(s.cond).includes("skeleton"),
  );
  assert.equal(skel.length, 1, `${file}: expected one skeleton arm`);
  assert.match(
    squash(skel[0].maskedCond),
    /\|\|\(files\.isPlaceholderData&&files\.data\?\.length===0\)$/,
    `${file}: the skeleton arm must hold over an empty placeholder list`,
  );
});

test("the transcript diff's live poll stops while its read is errored", () => {
  const file = "src/lib/git/queries/workingtree.ts";
  const { raw, masked } = load(file);
  const m = /\bexport\s+function\s+useSessionFileDiff\s*\(/.exec(masked);
  assert.ok(
    m,
    `${file}: anchor \`export function useSessionFileDiff(\` missing`,
  );
  const paramsClose = matchBrace(masked, m.index + m[0].length - 1);
  const open = masked.indexOf("{", paramsClose);
  const close = matchBrace(masked, open);
  assert.ok(close > open, `${file}: useSessionFileDiff's body never closes`);
  const keys = [
    ...masked.slice(open, close).matchAll(/(?<![\w$.])refetchInterval\s*:/g),
  ];
  assert.equal(
    keys.length,
    1,
    `${file}: expected one refetchInterval in useSessionFileDiff`,
  );
  const at = open + keys[0].index + keys[0][0].length;
  let end = at;
  for (let depth = 0; end < close; end++) {
    const c = masked[end];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) break;
      depth--;
    } else if (c === "," && depth === 0) break;
  }
  const value = squash(raw.slice(at, end));
  const fn =
    /^\(([\w$]+)\)=>\(?enabled&&live&&([\w$]+)\.state\.status!=="error"\?1500:false\)?$/.exec(
      value,
    );
  assert.ok(
    fn && fn[1] === fn[2],
    `${file}: refetchInterval must be \`(query) => enabled && live && query.state.status !== "error" ? 1500 : false\`, got \`${value}\``,
  );
});
