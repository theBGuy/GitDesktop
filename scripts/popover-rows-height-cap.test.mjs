// Every popover popup in src/ that maps rows (`.map(` or `.flatMap(` inside a
// `<Popover.Popup>` or the vendored wrapper `<PopoverContent>`) caps its height
// with a `max-h-` class and scrolls with `overflow-y-auto` / `overflow-auto`,
// both on one element, so a long list scrolls inside the window instead of
// running past it. Blocks, tags and the map call are read on masked source
// (comments, strings and JSX text blanked); the class tokens are read from the
// raw text of each tag's string literals, since masking blanks attribute
// strings. Known uncapped lists sit in ALLOWLIST with a count; a count that
// drifts either way fails.
// Not covered: rows mapped in a child component the popup renders, popups
// built from other wrappers (`ComboboxContent` and `DropdownMenuContent` carry
// their own caps in the vendored classes), rows built outside the popup's JSX
// (a node array mapped before the `return` and rendered as `{rows}`), and a cap
// applied through a class constant (it reads as missing, so it needs an entry).
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
const TAGS = ["Popover.Popup", "PopoverContent"];

const ALLOWLIST = {
  "src/features/conversations/LabelsPopover.tsx": {
    count: 1,
    rationale: "a repo's label list, short in practice",
  },
  "src/features/pulls/CreatePrDialog.tsx": {
    count: 1,
    rationale: "a repo's label list, short in practice",
  },
  "src/features/issues/CreateIssueDialog.tsx": {
    count: 1,
    rationale: "a repo's label list, short in practice",
  },
  "src/features/commit/CoAuthorPicker.tsx": {
    count: 1,
    rationale: "bounded: suggestions are sliced to 6",
  },
  "src/features/conversations/ReactionBar.tsx": {
    count: 1,
    rationale: "bounded: the fixed reaction set",
  },
  "src/features/repo-settings/BitbucketDefaultReviewersSection.tsx": {
    count: 1,
    rationale: "bounded: suggestions are sliced to 8",
  },
  "src/features/repository/ChangesPanel.tsx": {
    count: 1,
    rationale: "bounded: the fixed filter kinds",
  },
  "src/features/sessions/AgentPickers.tsx": {
    count: 1,
    rationale: "the user's own configured MCP servers, a short list",
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

/** Whether one tag's literal class tokens carry both the cap and the scroll. */
function cappedTag(literal) {
  const tokens = literal.split(/\s+/);
  return (
    tokens.some((k) => /^(?:[\w-]+:)*max-h-/.test(k)) &&
    tokens.some((k) => /^(?:[\w-]+:)*overflow-(?:y-)?auto$/.test(k))
  );
}

/** Per file, the lines of popups that map rows without a cap, plus the number
 *  of popup blocks seen. */
function scan(files) {
  const flagged = new Map();
  let blocks = 0;
  for (const [rel, text] of files) {
    const masked = maskNonCode(text, true);
    for (const tag of TAGS) {
      for (const [from, to] of elementRanges(rel, text, masked, tag)) {
        blocks++;
        const maps = /\.(?:map|flatMap)\(/.test(masked.slice(from, to));
        const capped = openingTags(rel, text, masked, from, to).some(([s, e]) =>
          cappedTag(literalText(text, masked, s, e)),
        );
        if (maps && !capped) {
          const lines = flagged.get(rel) ?? [];
          lines.push(lineOf(text, from));
          flagged.set(rel, lines);
        }
      }
    }
  }
  return { flagged, blocks };
}

function problems(files, allowlist = ALLOWLIST) {
  if (files.size === 0) return ["the walk read zero files"];
  const { flagged, blocks } = scan(files);
  if (blocks === 0) return ["no popover popup blocks found"];
  const out = [];
  for (const [rel, lines] of flagged) {
    const want = allowlist[rel]?.count ?? 0;
    if (lines.length !== want) {
      out.push(
        `${rel}:${lines.join(",")}: ${lines.length} popup(s) mapping rows without a max-h- cap and overflow scroll, allowlist says ${want}`,
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

test("every popover popup that maps rows caps its height and scrolls", () => {
  assert.deepEqual(problems(CORPUS), []);
});

test("every allowlist entry carries a rationale", () => {
  for (const [rel, entry] of Object.entries(ALLOWLIST)) {
    assert.ok(entry.rationale.length > 0, rel);
  }
});

const REL = "src/features/zz/Synthetic.tsx";
const popup = (railClass) =>
  [
    "export function Picker({ users }: { users: string[] }) {",
    "  return (",
    '    <Popover.Popup className="w-60 rounded-none bg-popover p-2">',
    '      <Popover.Title render={<p />} className="px-1 text-xs">Assignees</Popover.Title>',
    `      <div className="${railClass}">`,
    "        {users.map((u) => (",
    '          <label key={u} className="flex items-center gap-2 px-1 py-1.5">',
    '            <span className="truncate">{u}</span>',
    "          </label>",
    "        ))}",
    "      </div>",
    "    </Popover.Popup>",
    "  );",
    "}",
    "",
  ].join("\n");
const withFile = (text) => new Map([...CORPUS, [REL, text]]);

test("mutation: the pre-change AssigneesPopover shape is flagged", () => {
  const got = problems(withFile(popup("space-y-0.5")));
  assert.equal(got.length, 1);
  assert.match(got[0], /Synthetic\.tsx:3: 1 popup/);
});

test("mutation: a capped, scrolling rail passes", () => {
  assert.deepEqual(problems(withFile(popup("max-h-64 overflow-y-auto"))), []);
  assert.deepEqual(problems(withFile(popup("max-h-64 overflow-auto"))), []);
});

test("mutation: max-h- without an overflow class is flagged", () => {
  assert.equal(problems(withFile(popup("max-h-64"))).length, 1);
  assert.equal(problems(withFile(popup("overflow-y-auto"))).length, 1);
});

test("mutation: the PopoverContent wrapper is scanned too", () => {
  const text = popup("space-y-0.5").replaceAll(
    "Popover.Popup",
    "PopoverContent",
  );
  assert.equal(problems(withFile(text)).length, 1);
});

test("mutation: a .map( named only in a comment does not count", () => {
  const text = [
    "export function Picker() {",
    "  return (",
    '    <Popover.Popup className="w-60">',
    "      {/* users.map( */}",
    "      <p>One row</p>",
    "    </Popover.Popup>",
    "  );",
    "}",
    "",
  ].join("\n");
  assert.deepEqual(problems(withFile(text)), []);
});

test("mutation: a cap named in a comment or split across elements is flagged", () => {
  const commented = popup("space-y-0.5").replace(
    "      <div",
    "      {/* max-h-64 overflow-auto */}\n      <div",
  );
  assert.equal(problems(withFile(commented)).length, 1);
  const split = popup("overflow-auto").replace(
    'className="px-1 text-xs"',
    'className="px-1 text-xs [&_svg]:max-h-4"',
  );
  assert.equal(problems(withFile(split)).length, 1);
});

test("mutation: rows mapped with .flatMap( are scanned", () => {
  const text = popup("space-y-0.5").replace("users.map(", "users.flatMap(");
  assert.equal(problems(withFile(text)).length, 1);
});

test("fails closed: a nested popup or a close tag that never ends throws", () => {
  const nested = "<PopoverContent><PopoverContent {</PopoverContent>";
  const unclosedClose = "<PopoverContent></PopoverContent";
  assert.throws(
    () => elementRanges(REL, nested, nested, "PopoverContent"),
    ScanError,
  );
  assert.throws(
    () => elementRanges(REL, unclosedClose, unclosedClose, "PopoverContent"),
    ScanError,
  );
});

test("fails closed: an unclosed popup throws", () => {
  const text = [
    "export function Picker() {",
    "  return <div><Popover.Popup>{[1].map((n) => <p key={n} />)}</div>;",
    "}",
    "",
  ].join("\n");
  assert.throws(() => problems(new Map([[REL, text]])), ScanError);
});

test("fails closed: stale or drifted allowlist counts fail", () => {
  const rel = "src/features/commit/CoAuthorPicker.tsx";
  const drifted = { ...ALLOWLIST, [rel]: { ...ALLOWLIST[rel], count: 2 } };
  const got = problems(CORPUS, drifted);
  assert.equal(got.length, 1);
  assert.match(got[0], /CoAuthorPicker\.tsx:\d+: 1 popup.* allowlist says 2/);
  const stale = {
    ...ALLOWLIST,
    "src/features/zz/Gone.tsx": { count: 1, rationale: "x" },
  };
  assert.match(problems(CORPUS, stale).join("\n"), /Gone\.tsx: stale/);
});

test("fails closed: zero files or zero blocks fail", () => {
  assert.deepEqual(problems(new Map()), ["the walk read zero files"]);
  const none = new Map([["src/features/zz/A.tsx", "export const a = 1;\n"]]);
  assert.deepEqual(problems(none, {}), ["no popover popup blocks found"]);
});
