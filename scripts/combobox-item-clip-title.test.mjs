// Every Base UI `ComboboxItem` row in src/ whose text truncates shows the full
// text on hover through `clipTitle` / `clipTitleFromText`
// (src/lib/clip-title.ts), the only-when-clipped tooltip, bound as
// `onMouseEnter` on the same element that carries `truncate`. Blocks and tags
// are located on masked source (comments, strings and JSX text blanked) and
// the `truncate` class token is read from the raw text of each tag's string
// literals, since masking blanks attribute strings. Files with a known clipped
// row and no handler sit in ALLOWLIST with a count; a count that drifts either
// way fails.
// Not covered: a truncating child component rendered inside the item, a row
// built outside the `<ComboboxItem>` literal (a helper returning the row's
// children), text clipped by a class other than `truncate` (`line-clamp-*`,
// a hand-written overflow rule), a `truncate` reaching the tag through a class
// constant or a non-literal `cn()` argument, and a named handler that measures
// another element than the one it sits on.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  escapeRe,
  lineOf,
  maskNonCode,
  ScanError,
  sourceFiles,
  tagEnd,
} from "./lib/ts-mask.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const VENDORED = "src/components/ui/";
const TAG = "ComboboxItem";
// The two bindings the real sites use; any other attribute naming the helper
// (another event, a data prop) installs no hover tooltip.
const HOVER_BINDING =
  /(?:^|\s)onMouseEnter=\{\s*(?:clipTitleFromText\s*\}|clipTitle\s*\()/;

const ALLOWLIST = {
  "src/features/sessions/AgentPickers.tsx": {
    count: 1,
    rationale: "model ids are short identifiers that rarely clip",
  },
  "src/features/settings/AiProviderSection.tsx": {
    count: 1,
    rationale: "model ids are short identifiers that rarely clip",
  },
};

/** Every .tsx under src/ outside the vendored primitives, keyed by
 *  repo-relative forward-slash path, LF-normalized. */
function loadCorpus() {
  const files = new Map();
  for (const full of sourceFiles(`${ROOT}src`)) {
    const rel = relative(ROOT, full).split("\\").join("/");
    if (!rel.endsWith(".tsx") || rel.startsWith(VENDORED)) continue;
    const text = readFileSync(full, "utf8");
    if (text.includes("\0") || text.includes("\uFFFD")) {
      throw new ScanError(`${rel}: unreadable bytes`);
    }
    files.set(rel, text.replace(/\r\n/g, "\n"));
  }
  return files;
}

/** The [start, end) offset range of every `<name …>…</name>` (or
 *  self-closing `<name … />`) element in `masked`. Offsets are UTF-16 code
 *  units, shared by the raw text the mask came from. */
function elementRanges(rel, text, masked, name) {
  const tail = "(?![\\w.$-])";
  const open = new RegExp(`<${escapeRe(name)}${tail}`, "g");
  const either = new RegExp(`<(/?)${escapeRe(name)}${tail}`, "g");
  const ranges = [];
  for (const m of masked.matchAll(open)) {
    const end = tagEnd(masked, m.index);
    if (end < 0) {
      throw new ScanError(
        `${rel}:${lineOf(text, m.index)}: <${name} tag never ends`,
      );
    }
    if (masked[end - 1] === "/") {
      ranges.push([m.index, end + 1]);
      continue;
    }
    let depth = 1;
    either.lastIndex = end + 1;
    let close = -1;
    while (depth > 0) {
      const n = either.exec(masked);
      if (!n) {
        throw new ScanError(
          `${rel}:${lineOf(text, m.index)}: <${name} has no </${name}>`,
        );
      }
      if (n[1]) {
        depth--;
        close = n.index;
      } else {
        const e = tagEnd(masked, n.index);
        if (e < 0) {
          throw new ScanError(
            `${rel}:${lineOf(text, n.index)}: nested <${name} tag never ends`,
          );
        }
        if (masked[e - 1] !== "/") depth++;
      }
    }
    const closeEnd = masked.indexOf(">", close);
    if (closeEnd < 0) {
      throw new ScanError(
        `${rel}:${lineOf(text, close)}: </${name} never ends`,
      );
    }
    ranges.push([m.index, closeEnd + 1]);
  }
  return ranges;
}

/** The text of every string literal and template-literal text segment in
 *  `masked`'s [from, to) range, read from the raw `text`: masking keeps quote
 *  delimiters and blanks comments whole, so a comment's words never count. */
function literalText(text, masked, from, to) {
  const out = [];
  const braces = [];
  const template = (start) => {
    let k = start;
    while (
      k < to &&
      masked[k] !== "`" &&
      !(masked[k] === "$" && masked[k + 1] === "{")
    )
      k++;
    if (k >= to) throw new ScanError("a template literal runs past its tag");
    out.push(text.slice(start, k));
    if (masked[k] === "`") return k + 1;
    braces.push(0);
    return k + 2;
  };
  let i = from;
  while (i < to) {
    const c = masked[i];
    if (c === '"' || c === "'") {
      const j = masked.indexOf(c, i + 1);
      if (j < 0 || j >= to) throw new ScanError("a string runs past its tag");
      out.push(text.slice(i + 1, j));
      i = j + 1;
    } else if (c === "`") {
      i = template(i + 1);
    } else if (braces.length > 0 && c === "{") {
      braces[braces.length - 1]++;
      i++;
    } else if (braces.length > 0 && c === "}") {
      if (braces[braces.length - 1] === 0) {
        braces.pop();
        i = template(i + 1);
      } else {
        braces[braces.length - 1]--;
        i++;
      }
    } else i++;
  }
  return out.join(" ");
}

/** Every JSX opening tag in masked's [from, to) range, as [start, end) with
 *  end just past its `>`. A tag that never ends throws. */
function openingTags(rel, text, masked, from, to) {
  const tags = [];
  const re = /<[A-Za-z][\w.]*/g;
  re.lastIndex = from;
  for (let m = re.exec(masked); m && m.index < to; m = re.exec(masked)) {
    const end = tagEnd(masked, m.index);
    if (end < 0 || end >= to) {
      throw new ScanError(`${rel}:${lineOf(text, m.index)}: tag never ends`);
    }
    tags.push([m.index, end + 1]);
  }
  return tags;
}

/** Per file, the lines of `ComboboxItem` blocks with a `truncate` class and no
 *  clip handler, plus the number of blocks seen. */
function scan(files) {
  const flagged = new Map();
  let blocks = 0;
  for (const [rel, text] of files) {
    const masked = maskNonCode(text, true);
    for (const [from, to] of elementRanges(rel, text, masked, TAG)) {
      blocks++;
      // The handler belongs on the element whose own classes truncate: one on
      // a sibling or on the item box never measures the clipped text.
      const bare = openingTags(rel, text, masked, from, to).some(
        ([s, e]) =>
          /(?:^|\s)truncate(?:\s|$)/.test(literalText(text, masked, s, e)) &&
          !HOVER_BINDING.test(masked.slice(s, e)),
      );
      if (bare) {
        const lines = flagged.get(rel) ?? [];
        lines.push(lineOf(text, from));
        flagged.set(rel, lines);
      }
    }
  }
  return { flagged, blocks };
}

function problems(files, allowlist = ALLOWLIST) {
  if (files.size === 0) return ["the walk read zero files"];
  const { flagged, blocks } = scan(files);
  if (blocks === 0) return [`no <${TAG}> blocks found`];
  const out = [];
  for (const [rel, lines] of flagged) {
    const want = allowlist[rel]?.count ?? 0;
    if (lines.length !== want) {
      out.push(
        `${rel}:${lines.join(",")}: ${lines.length} truncating <${TAG}> row(s) without clipTitleFromText, allowlist says ${want}`,
      );
    }
  }
  for (const [rel, { count }] of Object.entries(allowlist)) {
    if (!flagged.has(rel)) {
      out.push(
        `${rel}: stale allowlist entry (0 hits, allowlist says ${count})`,
      );
    }
  }
  return out;
}

const CORPUS = loadCorpus();

test("every truncating ComboboxItem row takes the clip tooltip", () => {
  assert.deepEqual(problems(CORPUS), []);
});

test("every allowlist entry carries a rationale", () => {
  for (const [rel, entry] of Object.entries(ALLOWLIST)) {
    assert.ok(entry.rationale.length > 0, rel);
  }
});

const block = (inner) =>
  [
    "export function Row() {",
    "  return (",
    `    <${TAG} value={1}>`,
    `      ${inner}`,
    `    </${TAG}>`,
    "  );",
    "}",
    "",
  ].join("\n");

test("mutation: the IssuePicker row without its handler is flagged", () => {
  const rel = "src/features/issues/IssueRelations.tsx";
  const real = CORPUS.get(rel);
  assert.ok(real, `${rel} missing`);
  const handler = " onMouseEnter={clipTitleFromText}";
  const from = real.indexOf(`<${TAG}`);
  const to = real.indexOf(`</${TAG}>`, from);
  assert.ok(from >= 0 && to > from && real.slice(from, to).includes(handler));
  const mutated =
    real.slice(0, from) +
    real.slice(from, to).replace(handler, "") +
    real.slice(to);
  const got = problems(new Map([...CORPUS, [rel, mutated]]));
  assert.equal(got.length, 1);
  assert.match(got[0], /IssueRelations\.tsx:\d+: 1 truncating/);
});

test("mutation: a synthetic truncate row is flagged until it clips", () => {
  const rel = "src/features/zz/Synthetic.tsx";
  const bare = block('<span className="truncate">{x}</span>');
  const clipped = block(
    '<span className="truncate" onMouseEnter={clipTitle(x)}>{x}</span>',
  );
  const notClass = block('<span className="truncated">{x}</span>');
  assert.equal(problems(new Map([...CORPUS, [rel, bare]])).length, 1);
  assert.deepEqual(problems(new Map([...CORPUS, [rel, clipped]])), []);
  assert.deepEqual(problems(new Map([...CORPUS, [rel, notClass]])), []);
});

test("mutation: a handler named only in a comment or string does not count", () => {
  const rel = "src/features/zz/Synthetic.tsx";
  const commented = block(
    '{/* clipTitleFromText */}<span className="truncate" title="clipTitle">{x}</span>',
  );
  assert.equal(problems(new Map([...CORPUS, [rel, commented]])).length, 1);
});

test("mutation: the helper bound to another event or prop does not count", () => {
  const rel = "src/features/zz/Synthetic.tsx";
  const leave = block(
    '<span className="truncate" onMouseLeave={clipTitleFromText}>{x}</span>',
  );
  const unused = block(
    '<span className="truncate" data-unused={clipTitleFromText}>{x}</span>',
  );
  const leaveCall = block(
    '<span className="truncate" onMouseLeave={clipTitle(x)}>{x}</span>',
  );
  for (const src of [leave, unused, leaveCall]) {
    assert.equal(problems(new Map([...CORPUS, [rel, src]])).length, 1, src);
  }
  const enter = block(
    '<span className="truncate" onMouseEnter={clipTitleFromText}>{x}</span>',
  );
  assert.deepEqual(problems(new Map([...CORPUS, [rel, enter]])), []);
});

test("mutation: a handler on a sibling or on the item box does not count", () => {
  const rel = "src/features/zz/Synthetic.tsx";
  const sibling = block(
    '<span className="shrink-0" onMouseEnter={clipTitleFromText}>#1</span><span className="truncate">{x}</span>',
  );
  assert.equal(problems(new Map([...CORPUS, [rel, sibling]])).length, 1);
  const onItem = [
    "export function Row() {",
    `  return <${TAG} value={1} onMouseEnter={clipTitleFromText}><span className="truncate">{x}</span></${TAG}>;`,
    "}",
    "",
  ].join("\n");
  assert.equal(problems(new Map([...CORPUS, [rel, onItem]])).length, 1);
  const inCn = block(
    '<span className={cn("min-w-0", "truncate")} onMouseEnter={clipTitleFromText}>{x}</span>',
  );
  assert.deepEqual(problems(new Map([...CORPUS, [rel, inCn]])), []);
});

test("fails closed: a nested item or a close tag that never ends throws", () => {
  const rel = "src/features/zz/Synthetic.tsx";
  const nested = "<ComboboxItem><ComboboxItem {</ComboboxItem>";
  const unclosedClose = "<ComboboxItem></ComboboxItem";
  assert.throws(() => elementRanges(rel, nested, nested, TAG), ScanError);
  assert.throws(
    () => elementRanges(rel, unclosedClose, unclosedClose, TAG),
    ScanError,
  );
});

test("fails closed: an unclosed ComboboxItem throws", () => {
  const rel = "src/features/zz/Synthetic.tsx";
  const src = [
    "export function Row() {",
    `  return <div><${TAG} value={1}><span className="truncate" /></div>;`,
    "}",
    "",
  ].join("\n");
  assert.throws(() => problems(new Map([[rel, src]])), ScanError);
});

test("fails closed: stale or drifted allowlist counts fail", () => {
  const rel = "src/features/sessions/AgentPickers.tsx";
  const drifted = { ...ALLOWLIST, [rel]: { ...ALLOWLIST[rel], count: 2 } };
  const got = problems(CORPUS, drifted);
  assert.equal(got.length, 1);
  assert.match(
    got[0],
    /AgentPickers\.tsx:\d+: 1 truncating .* allowlist says 2/,
  );
  const stale = {
    ...ALLOWLIST,
    "src/features/zz/Gone.tsx": { count: 1, rationale: "x" },
  };
  assert.match(problems(CORPUS, stale).join("\n"), /Gone\.tsx: stale/);
});

test("fails closed: zero files or zero blocks fail", () => {
  assert.deepEqual(problems(new Map()), ["the walk read zero files"]);
  const none = new Map([["src/features/zz/A.tsx", "export const a = 1;\n"]]);
  assert.deepEqual(problems(none, {}), [`no <${TAG}> blocks found`]);
});
