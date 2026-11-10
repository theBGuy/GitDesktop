// Every popover popup in src/ that maps rows (`.map(` or `.flatMap(` inside a
// `<Popover.Popup>` or the vendored wrapper `<PopoverContent>`) caps its height
// with a `max-h-` class and scrolls with `overflow-y-auto` / `overflow-auto`,
// both on one element that contains every mapped row (or is the popup), so a
// long list scrolls inside the window instead of running past it. Blocks, tags
// and the map call are read on masked source (comments, strings and JSX text
// blanked); the class tokens are read from the raw text of the string literals
// in each tag's `className` value, since masking blanks attribute strings.
// Known uncapped lists sit in ALLOWLIST with a count of their uncapped MAP
// CALLS, not popups, so a cap removed from any list in an allowlisted popup
// raises the count; a count that drifts either way fails.
// Not covered: rows mapped in a child component the popup renders, popups
// built from other wrappers (`ComboboxContent` and `DropdownMenuContent` carry
// their own caps in the vendored classes), rows built outside the popup's JSX
// (a node array mapped before the `return` and rendered as `{rows}`), and a cap
// applied through a class constant (it reads as missing, so it needs an entry).
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  elementRanges,
  escapeRe,
  lineOf,
  literalText,
  loadCorpus,
  maskNonCode,
  openingTags,
  ScanError,
  srcEntries,
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
  "src/features/projects/ProjectsBoardPanel.tsx": {
    count: 3,
    rationale:
      "the view options popup's layout and zoom lists (fixed sets) and group-by fields (a project's few single-select fields); its views list is capped",
  },
  "src/features/sessions/AgentPickers.tsx": {
    count: 1,
    rationale: "the user's own configured MCP servers, a short list",
  },
};

/** Whether one tag's literal class tokens carry both the cap and the scroll. */
function cappedTag(literal) {
  const tokens = literal.split(/\s+/);
  return (
    tokens.some((k) => /^(?:[\w-]+:)*max-h-/.test(k)) &&
    tokens.some((k) => /^(?:[\w-]+:)*overflow-(?:y-)?auto$/.test(k))
  );
}

/** The literal text of the `className` value on the opening tag [s, e), so a
 *  cap spelled in another attribute (a `title`, a data prop) never counts. */
function classNameText(text, masked, s, e) {
  const out = [];
  const re = /\sclassName\s*=\s*/g;
  re.lastIndex = s;
  for (let m = re.exec(masked); m && m.index < e; m = re.exec(masked)) {
    const v = m.index + m[0].length;
    let end;
    if (masked[v] === '"' || masked[v] === "'") {
      end = masked.indexOf(masked[v], v + 1) + 1;
    } else if (masked[v] === "{") {
      let depth = 0;
      for (end = v; end < e; end++) {
        if (masked[end] === "{") depth++;
        else if (masked[end] === "}" && --depth === 0) break;
      }
      end++;
    } else end = -1;
    if (end <= v || end > e) {
      throw new ScanError("a className value runs past its tag");
    }
    out.push(literalText(text, masked, v, end));
  }
  return out.join(" ");
}

/** The end offset of the element whose opening tag is [s, e): past its
 *  matching close tag, or `e` for a self-closing tag. */
function elementEnd(rel, text, masked, s, e) {
  if (masked[e - 2] === "/") return e;
  const name = /^<([A-Za-z][\w.]*)/.exec(masked.slice(s))[1];
  const either = new RegExp(`<(/?)${escapeRe(name)}(?![\\w.$-])`, "g");
  either.lastIndex = e;
  let depth = 1;
  while (depth > 0) {
    const n = either.exec(masked);
    if (!n) {
      throw new ScanError(`${rel}:${lineOf(text, s)}: <${name} has no close`);
    }
    if (n[1]) {
      if (--depth === 0) return masked.indexOf(">", n.index) + 1;
    } else {
      const t = tagEnd(masked, n.index);
      if (t < 0) {
        throw new ScanError(`${rel}:${lineOf(text, n.index)}: tag never ends`);
      }
      if (masked[t - 1] !== "/") depth++;
    }
  }
}

// Whitespace (and a masked comment) may sit between the name and its paren.
const MAP_CALL = /\.\s*(?:map|flatMap)\s*\(/g;

/** Per file, the line of every map call outside every capped element of its
 *  popup (the popup itself counts), plus the number of popup blocks seen. */
function scan(files) {
  const flagged = new Map();
  let blocks = 0;
  for (const [rel, text] of files) {
    const masked = maskNonCode(text, true);
    for (const tag of TAGS) {
      for (const [from, to] of elementRanges(rel, text, masked, tag)) {
        blocks++;
        const calls = [...masked.slice(from, to).matchAll(MAP_CALL)].map(
          (m) => from + m.index,
        );
        const caps = openingTags(rel, text, masked, from, to)
          .filter(([s, e]) => cappedTag(classNameText(text, masked, s, e)))
          .map(([s, e]) => [s, elementEnd(rel, text, masked, s, e)]);
        const uncapped = calls.filter(
          (at) => !caps.some(([s, end]) => s < at && at < end),
        );
        if (uncapped.length > 0) {
          const lines = flagged.get(rel) ?? [];
          lines.push(...uncapped.map((at) => lineOf(text, at)));
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
        `${rel}:${lines.join(",")}: ${lines.length} map call(s) in a popover popup outside a max-h- cap with overflow scroll, allowlist says ${want}`,
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

// Every .tsx under src/ outside the vendored primitives.
const CORPUS = loadCorpus(
  srcEntries(ROOT, (rel) => rel.endsWith(".tsx") && !rel.startsWith(VENDORED)),
);

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
  assert.match(got[0], /Synthetic\.tsx:6: 1 map call/);
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

test("mutation: a cap on an element beside the rows is flagged", () => {
  const beside = popup("space-y-0.5").replace(
    "      <div",
    '      <div className="max-h-64 overflow-y-auto" />\n      <div',
  );
  assert.equal(problems(withFile(beside)).length, 1);
});

test("mutation: a cap spelled outside className is flagged", () => {
  const titled = popup("space-y-0.5").replace(
    'className="space-y-0.5"',
    'className="space-y-0.5" title="max-h-64 overflow-y-auto"',
  );
  assert.equal(problems(withFile(titled)).length, 1);
});

test("mutation: a map call with space before its paren is scanned", () => {
  const spaced = popup("space-y-0.5").replace("users.map(", "users.map (");
  assert.equal(problems(withFile(spaced)).length, 1);
  const commented = popup("space-y-0.5").replace(
    "users.map(",
    "users.map /* rows */ (",
  );
  assert.equal(problems(withFile(commented)).length, 1);
  const capped = popup("max-h-64 overflow-y-auto").replace(
    "users.map(",
    "users.map (",
  );
  assert.deepEqual(problems(withFile(capped)), []);
});

test("mutation: a capped popup covers rows in any child", () => {
  const text = popup("space-y-0.5").replace(
    'className="w-60 rounded-none bg-popover p-2"',
    'className={cn("w-60 p-2", "max-h-64 overflow-y-auto")}',
  );
  assert.deepEqual(problems(withFile(text)), []);
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

test("mutation: removing the views list's cap in an allowlisted popup fails", () => {
  const rel = "src/features/projects/ProjectsBoardPanel.tsx";
  const real = CORPUS.get(rel);
  assert.ok(real, rel);
  const cap = 'className="max-h-56 gap-0 overflow-y-auto"';
  assert.equal(real.split(cap).length, 2, "the views list's cap, once");
  const uncapped = new Map([
    ...CORPUS,
    [rel, real.replace(cap, 'className="gap-0"')],
  ]);
  const got = problems(uncapped);
  assert.equal(got.length, 1);
  assert.match(
    got[0],
    /ProjectsBoardPanel\.tsx:[\d,]+: 4 map call\(s\).* allowlist says 3/,
  );
});

test("fails closed: stale or drifted allowlist counts fail", () => {
  const rel = "src/features/commit/CoAuthorPicker.tsx";
  const drifted = { ...ALLOWLIST, [rel]: { ...ALLOWLIST[rel], count: 2 } };
  const got = problems(CORPUS, drifted);
  assert.equal(got.length, 1);
  assert.match(
    got[0],
    /CoAuthorPicker\.tsx:\d+: 1 map call\(s\).* allowlist says 2/,
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
  assert.deepEqual(problems(none, {}), ["no popover popup blocks found"]);
});
