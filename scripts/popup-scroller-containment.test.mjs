// A visually hidden copy (`sr-only`, `position: absolute`) takes the nearest
// POSITIONED ancestor as its containing block, so a scroller that is neither
// positioned nor clipped at a positioned box doesn't contain it. Inside a
// body-portaled, absolutely positioned popup the escaped copies keep their
// layout positions down the whole list and grow the document: a window
// scrollbar over empty space below the app. Two arms, read on masked source,
// class tokens taken from the string literals of each tag's `className`:
// - ScrollArea: every `<ScrollArea>` in src/ (src/test/ included, the vendored
//   src/components/ui/ left out) carries an unprefixed `overflow-hidden` or
//   `overflow-clip`; the vendored Root is `relative` but clips nothing. A tag
//   with a spread counts as unclipped (the spread can override the class).
//   RepoList's one ScrollArea is pinned to its exact tokens: the clip margin
//   keeps the viewport's outset focus ring visible under the clip.
// - Popup: every opening tag inside a popup element's range (ROSTER, plus
//   `<Alias>.Popup` for a raw Base UI part imported under another name), the
//   popup tag included, whose tokens scroll (`overflow-auto`, `overflow-y-auto`,
//   `overflow-scroll`, `overflow-y-scroll`, bare or variant-prefixed) carries an
//   unprefixed `relative`. A `<ScrollArea>` in range is the first arm's.
// SelectContent and ComboboxContent are out of the roster: their vendored
// popups are `relative` and clip or scroll themselves, which VENDOR_PINS
// asserts, so a re-vendor that drops it fails here. The roster was bounded by
// a one-off sweep; this guard's own run is the effective bound for the set.
// The viewport's `focus-visible:ring-[3px]` is pinned too: RepoList's 3px clip
// margin mirrors that width, so a wider ring would be clipped again.
// Known exceptions sit in ALLOWLIST as per-file, per-arm counts; a count that
// drifts either way, or an arm with no finding, fails. An aliased import of
// ScrollArea or a vendored roster wrapper, a namespace import of a Base UI or
// vendored ui module, a missing file, zero tags or zero popups all fail.
// Out of sight: scrollers rendered by a component defined outside the popup's
// range; popups built through a wrapper under another name or re-exported
// under an alias; classes arriving through a constant, a prop or another
// non-literal expression; whether an allowlisted scroller holds absolute
// content; a popup whose own box is taller than the window; dialogs (`fixed`)
// and in-app panels (under the app root's clip), by design.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  elementRanges,
  hasSpread,
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
const REPO_LIST = "src/features/repository/RepoList.tsx";
const REPO_LIST_TOKENS = ["[overflow-clip-margin:3px]", "overflow-clip"];

const ROSTER = [
  "PopoverContent",
  "Popover.Popup",
  "PopoverPrimitive.Popup",
  "HoverCardContent",
  "PreviewCard.Popup",
  "DropdownMenuContent",
  "DropdownMenuSubContent",
  "ContextMenuContent",
  "ContextMenuSubContent",
  "Menu.Popup",
  "ContextMenu.Popup",
  "Select.Popup",
  "Combobox.Popup",
];
/** Raw Base UI parts whose `.Popup` joins the roster under an import alias. */
const RAW_ROOTS = new Set([
  "Popover",
  "PreviewCard",
  "Menu",
  "ContextMenu",
  "Select",
  "Combobox",
]);
/** Names the scan reads by spelling, so an alias would hide them. */
const UNALIASABLE = new Set([
  "ScrollArea",
  "PopoverContent",
  "HoverCardContent",
  "DropdownMenuContent",
  "DropdownMenuSubContent",
  "ContextMenuContent",
  "ContextMenuSubContent",
]);

/** Vendored tags and the class token each must keep. */
const VENDOR_PINS = [
  ["src/components/ui/select.tsx", "SelectPrimitive.Popup", "relative"],
  ["src/components/ui/combobox.tsx", "ComboboxPrimitive.Popup", "relative"],
  ["src/components/ui/scroll-area.tsx", "ScrollAreaPrimitive.Root", "relative"],
  [
    "src/components/ui/scroll-area.tsx",
    "ScrollAreaPrimitive.Viewport",
    "focus-visible:ring-[3px]",
  ],
];

const IN_DIALOG = "inside a fixed Dialog, which bounds the page";
const ALLOWLIST = {
  "src/features/automations/AutomationResultDialog.tsx": {
    scrollArea: 1,
    rationale: IN_DIALOG,
  },
  "src/features/history/FileHistoryDialog.tsx": {
    scrollArea: 1,
    rationale: IN_DIALOG,
  },
  "src/features/hooks/HooksDialog.tsx": {
    scrollArea: 1,
    rationale: IN_DIALOG,
  },
  "src/features/repository/OperationHistoryDialog.tsx": {
    scrollArea: 1,
    rationale: IN_DIALOG,
  },
  "src/features/repository/StashesDialog.tsx": {
    scrollArea: 3,
    rationale: `${IN_DIALOG} (the stash list, the lost-stashes pane and the stash files rail)`,
  },
  "src/features/scripts/TasksPanel.tsx": {
    scrollArea: 1,
    rationale: "a sidebar tab panel under the app root's overflow clip",
  },
  "src/features/repository/BranchSwitcher.tsx": {
    popupScroller: 1,
    rationale:
      "its only absolute content, a failed row's Retry reason, sits in the first row inside the visible cap; virtualized rows wrap in `relative`",
  },
  "src/features/diff/LanguagePicker.tsx": {
    popupScroller: 1,
    rationale: "no absolutely positioned content in the list",
  },
  "src/features/issues/JiraIssueView.tsx": {
    popupScroller: 1,
    rationale: "no absolutely positioned content in the list",
  },
  "src/features/projects/BoardCard.tsx": {
    popupScroller: 2,
    rationale:
      "no absolutely positioned content reachable (the markdown body's `absolute` hits are comments and a string)",
  },
  "src/features/projects/TableCell.tsx": {
    popupScroller: 2,
    rationale:
      "no absolutely positioned content reachable (the markdown body's `absolute` hits are comments and a string)",
  },
  "src/features/projects/ProjectsBoardPanel.tsx": {
    popupScroller: 1,
    rationale:
      "the views list; the DisabledReasonButtons' sr-only reasons sit after the scroller closes",
  },
  "src/features/tags/CreateReleaseDialog.tsx": {
    popupScroller: 1,
    rationale: "no absolutely positioned content in the list",
  },
};

const SCROLL_AREA_OPEN = /<ScrollArea(?![\w.$-])/g;
const SCROLLER = /^(?:\S*:)?overflow-(?:y-)?(?:auto|scroll)$/;
const CLIPS = new Set(["overflow-hidden", "overflow-clip"]);

/** The literal text of the `className` value on the opening tag [s, e), so a
 *  token spelled in another attribute (a `title`, a data prop) never counts. */
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

const classTokens = (text, masked, s, e) =>
  classNameText(text, masked, s, e).split(/\s+/).filter(Boolean);

const IMPORT =
  /\bimport\s+(type\s+)?([\w$\s,{}*]*?)\s*from\s*(["'])([^"']+)\3/g;

/** Per file, the roster names its imports add (`<Alias>.Popup`) and the
 *  import forms the scan can't follow. */
function importsOf(rel, text, masked) {
  const roster = new Set();
  const hard = [];
  for (const m of text.matchAll(IMPORT)) {
    if (!masked.startsWith("import", m.index) || m[1]) continue;
    const [, , clause, , from] = m;
    const line = lineOf(text, m.index);
    const shared = /^@base-ui\/react(?:\/|$)|^@\/components\/ui\//.test(from);
    if (/\*\s*as\s/.test(clause) && shared) {
      hard.push(`${rel}:${line}: namespace import of ${from}`);
    }
    const braced = /\{([^}]*)\}/.exec(clause);
    for (const spec of braced ? braced[1].split(",") : []) {
      const a = /^\s*(type\s+)?([\w$]+)\s+as\s+([\w$]+)\s*$/.exec(spec);
      if (!a || a[1]) continue;
      if (UNALIASABLE.has(a[2])) {
        hard.push(`${rel}:${line}: ${a[2]} imported as ${a[3]}`);
      } else if (RAW_ROOTS.has(a[2]) && from.startsWith("@base-ui/react")) {
        roster.add(`${a[3]}.Popup`);
      }
    }
  }
  return { roster, hard };
}

/** RepoList's one ScrollArea: `cn(LIST_VIEWPORT_CLASS, …)` with exactly the
 *  pinned literal tokens. */
function repoListPin(files) {
  const text = files.get(REPO_LIST);
  if (text === undefined) return [`${REPO_LIST}: not in the corpus`];
  const masked = maskNonCode(text, true);
  const opens = [...masked.matchAll(SCROLL_AREA_OPEN)];
  if (opens.length !== 1) {
    return [`${REPO_LIST}: ${opens.length} <ScrollArea> tags, pin expects 1`];
  }
  const s = opens[0].index;
  const e = tagEnd(masked, s) + 1;
  const at = `${REPO_LIST}:${lineOf(text, s)}`;
  const tag = masked.slice(s, e);
  if (!/\sclassName\s*=\s*\{\s*cn\(\s*LIST_VIEWPORT_CLASS\s*,/.test(tag)) {
    return [`${at}: className is not cn(LIST_VIEWPORT_CLASS, …)`];
  }
  if (hasSpread(masked, s, e)) return [`${at}: the ScrollArea takes a spread`];
  const got = classTokens(text, masked, s, e).sort();
  if (got.join(" ") !== REPO_LIST_TOKENS.join(" ")) {
    return [
      `${at}: ScrollArea tokens are [${got.join(" ")}], pin expects [${REPO_LIST_TOKENS.join(" ")}]`,
    ];
  }
  return [];
}

/** Each vendored pin's tag keeps its pinned class token. */
function vendorPins(vendor) {
  const out = [];
  for (const [rel, name, token] of VENDOR_PINS) {
    const text = vendor.get(rel);
    if (text === undefined) {
      out.push(`${rel}: not readable`);
      continue;
    }
    const masked = maskNonCode(text, true);
    const opens = elementRanges(rel, text, masked, name);
    if (opens.length !== 1) {
      out.push(`${rel}: ${opens.length} <${name}> tags, pin expects 1`);
      continue;
    }
    const [s] = opens[0];
    const e = tagEnd(masked, s) + 1;
    if (!classTokens(text, masked, s, e).includes(token)) {
      out.push(`${rel}:${lineOf(text, s)}: <${name}> lost its \`${token}\``);
    }
  }
  return out;
}

/** Per file, the line of every finding in each arm, the hard (never
 *  allowlistable) findings, and the corpus counts. */
function scan(files) {
  const flagged = new Map();
  const hard = [];
  let scrollAreas = 0;
  let popups = 0;
  const flag = (rel, arm, line) => {
    const entry = flagged.get(rel) ?? { scrollArea: [], popupScroller: [] };
    entry[arm].push(line);
    flagged.set(rel, entry);
  };
  for (const [rel, text] of files) {
    const masked = maskNonCode(text, true);
    const imports = importsOf(rel, text, masked);
    hard.push(...imports.hard);
    for (const m of masked.matchAll(SCROLL_AREA_OPEN)) {
      scrollAreas++;
      const e = tagEnd(masked, m.index) + 1;
      if (e === 0) throw new ScanError(`${rel}: a <ScrollArea> never ends`);
      const clipped =
        !hasSpread(masked, m.index, e) &&
        classTokens(text, masked, m.index, e).some((k) => CLIPS.has(k));
      if (!clipped) flag(rel, "scrollArea", lineOf(text, m.index));
    }
    const seen = new Set();
    for (const name of new Set([...ROSTER, ...imports.roster])) {
      for (const [from, to] of elementRanges(rel, text, masked, name)) {
        popups++;
        for (const [s, e] of openingTags(rel, text, masked, from, to)) {
          if (seen.has(s) || /^<ScrollArea(?![\w.$-])/.test(masked.slice(s))) {
            continue;
          }
          seen.add(s);
          const tokens = classTokens(text, masked, s, e);
          if (
            tokens.some((k) => SCROLLER.test(k)) &&
            !tokens.includes("relative")
          ) {
            flag(rel, "popupScroller", lineOf(text, s));
          }
        }
      }
    }
  }
  return { flagged, hard, scrollAreas, popups };
}

function problems(files, allowlist = ALLOWLIST, vendor = VENDOR) {
  if (files.size === 0) return ["the walk read zero files"];
  const { flagged, hard, scrollAreas, popups } = scan(files);
  const out = [...hard, ...repoListPin(files), ...vendorPins(vendor)];
  if (scrollAreas === 0) out.push("no <ScrollArea> tags found");
  if (popups === 0) out.push("no popup ranges found");
  for (const arm of ["scrollArea", "popupScroller"]) {
    for (const [rel, entry] of flagged) {
      const lines = entry[arm];
      const want = allowlist[rel]?.[arm] ?? 0;
      if (lines.length > 0 && lines.length !== want) {
        out.push(
          `${rel}:${lines.join(",")}: ${lines.length} uncontained ${arm} finding(s), allowlist says ${want}`,
        );
      }
    }
    for (const [rel, entry] of Object.entries(allowlist)) {
      if (entry[arm] !== undefined && !flagged.get(rel)?.[arm].length) {
        out.push(
          `${rel}: stale ${arm} allowlist entry (0 hits, allowlist says ${entry[arm]})`,
        );
      }
    }
  }
  return out;
}

// Every .tsx under src/ outside the vendored primitives.
const CORPUS = loadCorpus(
  srcEntries(ROOT, (rel) => rel.endsWith(".tsx") && !rel.startsWith(VENDORED)),
);
const VENDOR = loadCorpus(
  VENDOR_PINS.map(([rel]) => [rel, readFileSync(join(ROOT, rel), "utf8")]),
);

test("every ScrollArea clips and every popup scroller is positioned", () => {
  assert.deepEqual(problems(CORPUS), []);
});

test("every allowlist entry carries a rationale and a count", () => {
  for (const [rel, entry] of Object.entries(ALLOWLIST)) {
    assert.ok(entry.rationale.length > 0, rel);
    assert.ok(
      entry.scrollArea !== undefined || entry.popupScroller !== undefined,
      rel,
    );
  }
});

const REL = "src/features/zz/Synthetic.tsx";
const withFile = (text, rel = REL) => new Map([...CORPUS, [rel, text]]);
const component = (body) =>
  ["export function Picker() {", "  return (", ...body, "  );", "}", ""].join(
    "\n",
  );
const popup = (popupClass, railClass, tag = "Popover.Popup") =>
  component([
    `    <${tag} className="${popupClass}">`,
    `      <div className="${railClass}">`,
    '        <span className="sr-only">held</span>',
    "      </div>",
    `    </${tag}>`,
  ]);
const area = (attrs) =>
  component([
    `    <ScrollArea ${attrs}>`,
    "      <p>x</p>",
    "    </ScrollArea>",
  ]);

/** The single problem a fixture raises, asserted to match `re`. */
function onlyProblem(files, re, allowlist) {
  const got = problems(files, allowlist);
  assert.equal(got.length, 1, got.join("\n"));
  assert.match(got[0], re);
}

const repoListWith = (from, to) => {
  const real = CORPUS.get(REPO_LIST);
  assert.ok(real?.includes(from), `RepoList holds ${from}`);
  return real.replace(from, to);
};

test("G1: RepoList without its clip, its margin, or its cn( fails", () => {
  const noMargin = repoListWith(
    '"overflow-clip [overflow-clip-margin:3px]"',
    '"overflow-clip"',
  );
  onlyProblem(
    withFile(noMargin, REPO_LIST),
    /RepoList\.tsx:\d+: ScrollArea tokens/,
  );
  const noClip = repoListWith(
    '"overflow-clip [overflow-clip-margin:3px]"',
    '"[overflow-clip-margin:3px]"',
  );
  const got = problems(withFile(noClip, REPO_LIST));
  assert.equal(got.length, 2, got.join("\n"));
  assert.match(got.join("\n"), /RepoList\.tsx:\d+: ScrollArea tokens/);
  assert.match(got.join("\n"), /RepoList\.tsx:\d+: 1 uncontained scrollArea/);
  const bare = CORPUS.get(REPO_LIST).replace(
    /className=\{cn\(\s*LIST_VIEWPORT_CLASS,(?:\s*\/\/[^\n]*)*\s*"[^"]*",?\s*\)\}/,
    "className={LIST_VIEWPORT_CLASS}",
  );
  assert.notEqual(bare, CORPUS.get(REPO_LIST));
  const gotBare = problems(withFile(bare, REPO_LIST)).join("\n");
  assert.match(gotBare, /RepoList\.tsx:\d+: className is not cn\(/);
  assert.match(gotBare, /RepoList\.tsx:\d+: 1 uncontained scrollArea/);
});

test("G2: an unclipped, variant-only or spread ScrollArea flags", () => {
  onlyProblem(
    withFile(area('className="h-40"')),
    /Synthetic\.tsx:3: 1 uncontained scrollArea/,
  );
  onlyProblem(
    withFile(area('className="h-40 md:overflow-hidden"')),
    /Synthetic\.tsx:3: 1 uncontained scrollArea/,
  );
  onlyProblem(
    withFile(area('className="h-40 overflow-hidden" {...rest}')),
    /Synthetic\.tsx:3: 1 uncontained scrollArea/,
  );
  onlyProblem(
    withFile(area('className="h-40" title="overflow-hidden"')),
    /Synthetic\.tsx:3: 1 uncontained scrollArea/,
  );
  assert.deepEqual(
    problems(withFile(area('className="h-40 overflow-hidden"'))),
    [],
  );
  assert.deepEqual(
    problems(withFile(area('className="h-40 overflow-clip"'))),
    [],
  );
});

test("G3: an unpositioned scroller in a popup flags; a relative one passes", () => {
  const hit = /Synthetic\.tsx:4: 1 uncontained popupScroller/;
  onlyProblem(withFile(popup("w-60", "max-h-64 overflow-y-auto")), hit);
  onlyProblem(
    withFile(popup("w-60", "max-h-64 sm:relative overflow-y-auto")),
    hit,
  );
  onlyProblem(withFile(popup("w-60", "max-h-64 md:overflow-auto")), hit);
  assert.deepEqual(
    problems(withFile(popup("w-60", "relative max-h-64 overflow-y-auto"))),
    [],
  );
  onlyProblem(
    withFile(popup("w-60 max-h-64 overflow-y-auto", "py-2")),
    /Synthetic\.tsx:3: 1 uncontained popupScroller/,
  );
  onlyProblem(
    withFile(popup("w-60", "max-h-64 overflow-y-auto", "DropdownMenuContent")),
    hit,
  );
});

test("G3: scrollers outside a popup and SelectContent ranges are ignored", () => {
  const after = component([
    "    <>",
    '      <Popover.Popup className="w-60">x</Popover.Popup>',
    '      <div className="max-h-64 overflow-y-auto" />',
    "    </>",
  ]);
  assert.deepEqual(problems(withFile(after)), []);
  assert.deepEqual(
    problems(
      withFile(popup("w-60", "max-h-64 overflow-y-auto", "SelectContent")),
    ),
    [],
  );
});

test("G3: a raw part imported under an alias joins the roster", () => {
  const text = `import { Popover as P } from "@base-ui/react/popover";\n${popup(
    "w-60",
    "max-h-64 overflow-y-auto",
    "P.Popup",
  )}`;
  onlyProblem(withFile(text), /Synthetic\.tsx:5: 1 uncontained popupScroller/);
});

test("G4: an aliased ScrollArea or roster wrapper, or a namespace import, fails", () => {
  onlyProblem(
    withFile(
      'import { ScrollArea as SA } from "@/components/ui/scroll-area";\n',
    ),
    /Synthetic\.tsx:1: ScrollArea imported as SA/,
  );
  onlyProblem(
    withFile(
      'import {\n  DropdownMenuContent as Menu,\n} from "@/components/ui/dropdown-menu";\n',
    ),
    /Synthetic\.tsx:1: DropdownMenuContent imported as Menu/,
  );
  onlyProblem(
    withFile('import * as PopoverNs from "@base-ui/react/popover";\n'),
    /Synthetic\.tsx:1: namespace import/,
  );
  assert.deepEqual(
    problems(
      withFile(
        'import type { ScrollArea as SA } from "@/components/ui/scroll-area";\n',
      ),
    ),
    [],
  );
});

test("G4: a vendored popup or Root without `relative` fails", () => {
  const rel = "src/components/ui/combobox.tsx";
  const real = VENDOR.get(rel);
  const cut = '"group/combobox-content relative ';
  assert.equal(real.split(cut).length, 2, "the combobox Popup class, once");
  const vendor = new Map([
    ...VENDOR,
    [rel, real.replace(cut, '"group/combobox-content ')],
  ]);
  const got = problems(CORPUS, ALLOWLIST, vendor);
  assert.equal(got.length, 1, got.join("\n"));
  assert.match(got[0], /combobox\.tsx:\d+: <ComboboxPrimitive\.Popup> lost/);
});

test("G4: a viewport focus ring wider than the clip margin fails", () => {
  const rel = "src/components/ui/scroll-area.tsx";
  const real = VENDOR.get(rel);
  const cut = "focus-visible:ring-[3px]";
  assert.equal(real.split(cut).length, 2, "the viewport ring width, once");
  const vendor = new Map([
    ...VENDOR,
    [rel, real.replace(cut, "focus-visible:ring-[4px]")],
  ]);
  const got = problems(CORPUS, ALLOWLIST, vendor);
  assert.equal(got.length, 1, got.join("\n"));
  assert.match(
    got[0],
    /scroll-area\.tsx:\d+: <ScrollAreaPrimitive\.Viewport> lost its `focus-visible:ring-\[3px\]`/,
  );
});

test("G5: stale or drifted allowlist counts fail", () => {
  const stale = {
    ...ALLOWLIST,
    "src/features/zz/Gone.tsx": { popupScroller: 1, rationale: "x" },
  };
  onlyProblem(CORPUS, /Gone\.tsx: stale popupScroller/, stale);
  const drifted = withFile(area('className="h-40"'));
  onlyProblem(
    drifted,
    /Synthetic\.tsx:3: 1 uncontained scrollArea finding\(s\), allowlist says 2/,
    { ...ALLOWLIST, [REL]: { scrollArea: 2, rationale: "x" } },
  );
});

test("G6: zero files, zero tags or an unclosed popup fail closed", () => {
  assert.deepEqual(problems(new Map()), ["the walk read zero files"]);
  const none = new Map([["src/features/zz/A.tsx", "export const a = 1;\n"]]);
  const got = problems(none, {});
  assert.ok(got.includes("no <ScrollArea> tags found"), got.join("\n"));
  assert.ok(got.includes("no popup ranges found"), got.join("\n"));
  const unclosed = component([
    '    <div><Popover.Popup className="w-60"></div>',
  ]);
  assert.throws(() => problems(withFile(unclosed)), ScanError);
});

test("NC3: ProjectsPopover's rows scroller without `relative` fails", () => {
  const rel = "src/features/conversations/ProjectsPopover.tsx";
  const real = CORPUS.get(rel);
  const cut = 'className="relative max-h-64 overflow-y-auto py-2"';
  assert.equal(real.split(cut).length, 2, "the rows scroller, once");
  const files = withFile(
    real.replace(cut, 'className="max-h-64 overflow-y-auto py-2"'),
    rel,
  );
  onlyProblem(files, /ProjectsPopover\.tsx:\d+: 1 uncontained popupScroller/);
});
