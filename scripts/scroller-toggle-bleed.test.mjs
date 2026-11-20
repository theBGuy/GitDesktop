// The vendored toggles (Checkbox, Radio, Switch) draw an enlarged hit area, an
// `after:-inset-y-2` pseudo that overhangs their box by 8px. A scroller whose
// last content is a toggle with less than 8px of bottom slack overflows by that
// overhang and shows a scrollbar with nothing to scroll. Scope contract:
// G1  dialog-scroll.ts exports DIALOG_SCROLL and DIALOG_SCROLL_X_HIDDEN, each a
//     single string literal carrying `pb-N` and `-mb-N` (one N >= 2) and no other
//     p-/py-/pb-/m-/my-/mb- token of either sign.
// G2  every other reference to either name in src/ is a direct argument of a
//     `cn(` call (or the whole `className={…}` expression), and that call's
//     literal tokens carry no p-/py-/pb- token and no m-/my-/mb- token of either
//     sign but exactly `mb-0` (the opt-out for a stretched flex-row scroller);
//     the logical-block `pbe-` / `mbe-` spellings count as the same override.
// G3  every other .tsx scroller (an opening tag whose literal tokens include
//     overflow-auto / overflow-y-auto / overflow-scroll / overflow-y-scroll) is
//     flagged when a toggle (Checkbox, Radio, Switch, HeldSwitch, CheckboxField;
//     a dotted name matches on its last segment) sits in a POSSIBLY-LAST child
//     and outside a nested scroller, unless its own unprefixed numeric
//     p-N/py-N/pb-N tokens have a minimum N >= 2. Possibly-last: walking the
//     top-level children from the end, fragments flatten, a comment-only `{}`
//     is skipped, an expression child may render nothing so the walk passes it,
//     and the walk stops after the first element child.
// G4  the vendored files holding `after:-inset-y-` are exactly checkbox, radio-
//     group and switch; HeldSwitch and CheckboxField still import their
//     primitive; an aliased or namespace import of a toggle or a constant fails.
// G5  flagged scrollers a reviewed file keeps sit in ALLOWLIST with a count; a
//     count that drifts either way, or an entry with no flag, fails. A new
//     reviewed row also raises the allowlist's exact-size assertion below.
// G6  a ScanError anywhere fails, and so do zero files, zero literal scrollers
//     or zero constant call sites.
// Out of sight: a toggle rendered by a child component outside the toggle set;
// scroll or padding classes applied through another constant, a prop or a
// non-literal expression; a conditional `cn()` arm inside `className` (e.g.
// `cond && "pb-2"`), which counts as padding, so such a scroller is missed
// rather than flagged; padding a component adds by default (DialogContent's
// p-4, vendored wrappers) and row padding inside the last child (both can make
// a flagged site safe: allowlist it); Base UI ScrollArea / ConversationScrollArea
// viewports (census at the time of writing: 0 of 38 render a toggle in their own
// JSX; the three hosts whose child components render toggles pad their content:
// SettingsScreen `p-6`, TagDetailView and PrReviewPanel `p-4`); the right-edge
// overhang (no site: right-aligned Switches sit in X_HIDDEN scrollers); whether
// the toggle really sits at the bottom of its child (the guard over-flags); and
// layout neutrality beyond G2's margin rule. The toggle set's bound: `git grep
// "after:-inset" -- src/components/ui` hits exactly checkbox, radio-group and
// switch (tabs.tsx's underline is `after:inset-x-0`, no hit area). The toggle
// importers outside ui/ number 57 files; the four under src/components are the
// two wrappers plus user-picker-body.tsx (its scroller pads itself `py-2`) and
// confirm-dialog-host.tsx, which render the primitive directly and whose
// scrollers G3 reads like any other.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CLOSE,
  escapeRe,
  lineOf,
  literalText,
  loadCorpus,
  maskNonCode,
  matchBrace,
  OPEN,
  ScanError,
  srcEntries,
  tagEnd,
} from "./lib/ts-mask.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEF = "src/components/dialog-scroll.ts";
const VENDORED = "src/components/ui/";
const NAMES = ["DIALOG_SCROLL", "DIALOG_SCROLL_X_HIDDEN"];
const NAME_RE = /\bDIALOG_SCROLL(?:_X_HIDDEN)?\b/g;
const TOGGLES = new Set([
  "Checkbox",
  "Radio",
  "Switch",
  "HeldSwitch",
  "CheckboxField",
]);
const TOGGLE_UI = [
  "src/components/ui/checkbox.tsx",
  "src/components/ui/radio-group.tsx",
  "src/components/ui/switch.tsx",
];
const TOGGLE_MODULES =
  /^@\/components\/(?:ui\/(?:checkbox|radio-group|switch)|held-switch)$/;
const WRAPPERS = {
  "src/components/held-switch.tsx": "@/components/ui/switch",
  "src/components/form/fields.tsx": "@/components/ui/checkbox",
};

const ALLOWLIST = {
  "src/features/settings/mcp/McpServerDialog.tsx": {
    count: 1,
    rationale:
      "the last child is the Enabled label row (border px-3 py-2 items-center): ~36px of text beside an 18.4px Switch leaves ~17.8px under the switch box, so the 8px overhang stays ~10px inside the row",
  },
  "src/features/settings/mcp/ImportMcpDialog.tsx": {
    count: 1,
    rationale:
      "each mapped candidate row's wrapper is overflow-hidden rounded-md border, which clips the Checkbox's ::after before it reaches the scroller",
  },
};

const SPACING = /^-?(?:p|py|pb|pbe|m|my|mb|mbe)-/;
const SCROLL = /^overflow-(?:y-)?(?:auto|scroll)$/;
const TAG = /<[A-Za-z][\w.]*/g;

/** A class token without its variant prefixes and an important `!`. */
const bare = (tok) => tok.slice(tok.lastIndexOf(":") + 1).replace(/^!|!$/g, "");
const tokensOf = (literal) => literal.split(/\s+/).filter(Boolean);
const mask = (rel, text) => maskNonCode(text, rel.endsWith(".tsx"));

function prevNonSpace(masked, i) {
  while (i >= 0 && /\s/.test(masked[i])) i--;
  return i;
}
function nextNonSpace(masked, i) {
  while (i < masked.length && /\s/.test(masked[i])) i++;
  return i;
}

/** Whether a `<Name` at `i` sits where JSX can start, so `a<b` and a generic's
 *  `<T>` are not read as tags. */
function jsxPosition(masked, i) {
  const p = prevNonSpace(masked, i - 1);
  if (p < 0) return true;
  if ("({}>?:&|=,[".includes(masked[p])) return true;
  return /\breturn$/.test(masked.slice(Math.max(0, p - 6), p + 1));
}

/** Every JSX opening tag in [from, to) as `{ s, e, name }`, e just past `>`. */
function tagsIn(rel, text, masked, from, to) {
  const out = [];
  const re = new RegExp(TAG.source, "g");
  re.lastIndex = from;
  for (let m = re.exec(masked); m && m.index < to; m = re.exec(masked)) {
    if (!jsxPosition(masked, m.index)) continue;
    const end = tagEnd(masked, m.index);
    if (end < 0 || end >= to) {
      throw new ScanError(`${rel}:${lineOf(text, m.index)}: tag never ends`);
    }
    out.push({ s: m.index, e: end + 1, name: m[0].slice(1) });
  }
  return out;
}

/** The element whose opening tag is [s, e): `close` is where its closing tag
 *  starts (e for a self-closing tag), `end` is just past it. */
function elementBounds(rel, text, masked, s, e, name) {
  if (masked[e - 2] === "/") return { close: e, end: e };
  const either = new RegExp(`<(/?)${escapeRe(name)}(?![\\w.$-])`, "g");
  either.lastIndex = e;
  let depth = 1;
  for (;;) {
    const n = either.exec(masked);
    if (!n) {
      throw new ScanError(`${rel}:${lineOf(text, s)}: <${name} has no close`);
    }
    if (n[1]) {
      if (--depth === 0) {
        const end = masked.indexOf(">", n.index);
        if (end < 0) throw new ScanError(`${rel}: </${name} never ends`);
        return { close: n.index, end: end + 1 };
      }
    } else {
      const t = tagEnd(masked, n.index);
      if (t < 0) {
        throw new ScanError(`${rel}:${lineOf(text, n.index)}: tag never ends`);
      }
      if (masked[t - 1] !== "/") depth++;
    }
  }
}

function fragmentEnd(rel, text, masked, start, to) {
  let depth = 0;
  for (let k = start; k < to; k++) {
    if (masked.startsWith("<>", k)) {
      depth++;
      k++;
    } else if (masked.startsWith("</>", k)) {
      if (--depth === 0) return k;
      k += 2;
    }
  }
  throw new ScanError(`${rel}:${lineOf(text, start)}: <> has no </>`);
}

/** The top-level children in [from, to), fragments flattened, each
 *  `{ kind: "element" | "expr" | "comment", from, to }`. */
function children(rel, text, masked, from, to) {
  const items = [];
  let i = from;
  while (i < to) {
    const c = masked[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === "{") {
      const j = matchBrace(masked, i);
      if (j < 0 || j >= to) {
        throw new ScanError(
          `${rel}:${lineOf(text, i)}: {…} child never closes`,
        );
      }
      const blank = masked.slice(i + 1, j).trim() === "";
      items.push({ kind: blank ? "comment" : "expr", from: i, to: j + 1 });
      i = j + 1;
    } else if (masked.startsWith("<>", i)) {
      const end = fragmentEnd(rel, text, masked, i, to);
      items.push(...children(rel, text, masked, i + 2, end));
      i = end + 3;
    } else if (c === "<" && /[A-Za-z]/.test(masked[i + 1] ?? "")) {
      const t = tagEnd(masked, i);
      if (t < 0 || t >= to) {
        throw new ScanError(`${rel}:${lineOf(text, i)}: tag never ends`);
      }
      const name = /^<([A-Za-z][\w.]*)/.exec(masked.slice(i, t))[1];
      const { end } = elementBounds(rel, text, masked, i, t + 1, name);
      items.push({ kind: "element", from: i, to: end });
      i = end;
    } else {
      throw new ScanError(`${rel}:${lineOf(text, i)}: unreadable JSX child`);
    }
  }
  return items;
}

/** The children that may render last: from the end, past every expression,
 *  stopping after the first element. */
function possiblyLast(items) {
  const out = [];
  for (let k = items.length - 1; k >= 0; k--) {
    if (items[k].kind === "comment") continue;
    out.push(items[k]);
    if (items[k].kind === "element") break;
  }
  return out;
}

function padded(tokens) {
  const ns = [];
  for (const t of tokens) {
    const m = /^(?:p|py|pb)-(\d+(?:\.\d+)?)$/.exec(t);
    if (m) ns.push(Number(m[1]));
  }
  return ns.length > 0 && Math.min(...ns) >= 2;
}

/** The literal text of the `className` value on the opening tag [s, e), so a
 *  class spelled in another attribute (a `title`, a data prop) never counts. */
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

/** G1: the two constants' own bottom pair. */
export function constantProblems(files) {
  const text = files.get(DEF);
  if (text === undefined) return [`${DEF}: G1 the definition file is missing`];
  const masked = maskNonCode(text, false);
  const out = [];
  for (const name of NAMES) {
    const m = new RegExp(`\\bexport const ${name}\\s*=\\s*`).exec(masked);
    if (!m) {
      out.push(`${DEF}: G1 ${name} is not an exported const`);
      continue;
    }
    const line = lineOf(text, m.index);
    const q = m.index + m[0].length;
    const quote = masked[q];
    const close =
      quote === '"' || quote === "'" ? masked.indexOf(quote, q + 1) : -1;
    if (close < 0 || !/^\s*;/.test(masked.slice(close + 1))) {
      out.push(`${DEF}:${line}: G1 ${name} is not a single string literal`);
      continue;
    }
    const tokens = tokensOf(text.slice(q + 1, close));
    const spacing = tokens.filter((t) => SPACING.test(bare(t)));
    const n = /^pb-(\d+(?:\.\d+)?)$/.exec(
      tokens.find((t) => t.startsWith("pb-")) ?? "",
    )?.[1];
    const ok =
      n !== undefined &&
      Number(n) >= 2 &&
      spacing.length === 2 &&
      tokens.includes(`pb-${n}`) &&
      tokens.includes(`-mb-${n}`);
    if (!ok) {
      out.push(
        `${DEF}:${line}: G1 ${name} must carry pb-N and -mb-N (one N >= 2) and no other p-/py-/pb-/m-/my-/mb- token`,
      );
    }
  }
  return out;
}

/** Import and re-export statements with a module specifier, as
 *  `{ from, to, specifiers, namespace, module }`. */
function importsOf(text, masked) {
  const re =
    /\b(?:import|export)\s+(?:type\s+)?(\*\s*as\s+[\w$]+|\*|\{[^}]*\}|[\w$]+(?:\s*,\s*(?:\{[^}]*\}|\*\s*as\s+[\w$]+))?)\s*from\s*(["'])/g;
  const out = [];
  for (const m of masked.matchAll(re)) {
    const q = m.index + m[0].length - 1;
    const end = masked.indexOf(m[2], q + 1);
    const braces = /\{([^}]*)\}/.exec(m[1]);
    out.push({
      from: m.index,
      to: end + 1,
      specifiers: braces ? braces[1] : "",
      namespace: m[1].includes("*"),
      module: text.slice(q + 1, end),
    });
  }
  return out;
}

/** G2 and G4's import arms over one file; returns the constant call sites. */
function referenceProblems(rel, text, masked, out) {
  const imports = importsOf(text, masked);
  for (const imp of imports) {
    for (const raw of imp.specifiers.split(",")) {
      const spec = raw.trim().replace(/^type\s+/, "");
      const alias = /^([\w$]+)\s+as\s+[\w$]+$/.exec(spec);
      if (alias && NAMES.includes(alias[1])) {
        out.push(
          `${rel}:${lineOf(text, imp.from)}: G2 aliased import of ${alias[1]}`,
        );
      }
      // A vendored file aliasing Base UI's own export is not an app toggle.
      const app = imp.module.startsWith("@/") || imp.module.startsWith(".");
      if (app && alias && TOGGLES.has(alias[1])) {
        out.push(
          `${rel}:${lineOf(text, imp.from)}: G4 aliased import of ${alias[1]}`,
        );
      }
    }
    if (imp.namespace && /dialog-scroll$/.test(imp.module)) {
      out.push(
        `${rel}:${lineOf(text, imp.from)}: G2 namespace import of ${imp.module}`,
      );
    }
    if (imp.namespace && TOGGLE_MODULES.test(imp.module)) {
      out.push(
        `${rel}:${lineOf(text, imp.from)}: G4 namespace import of ${imp.module}`,
      );
    }
  }
  if (rel === DEF) return 0;
  let sites = 0;
  for (const m of masked.matchAll(NAME_RE)) {
    const i = m.index;
    if (imports.some((imp) => i >= imp.from && i < imp.to)) continue;
    const line = lineOf(text, i);
    const prev = prevNonSpace(masked, i - 1);
    const next = nextNonSpace(masked, i + m[0].length);
    if (
      masked[prev] === "{" &&
      masked[next] === "}" &&
      /className\s*=\s*$/.test(masked.slice(Math.max(0, prev - 20), prev))
    ) {
      sites++;
      continue;
    }
    let open = -1;
    if ("(,".includes(masked[prev]) && ",)".includes(masked[next])) {
      let depth = 0;
      for (let k = i - 1; k >= 0; k--) {
        if (CLOSE.has(masked[k])) depth++;
        else if (OPEN.has(masked[k])) {
          if (depth === 0) {
            if (masked[k] === "(") open = k;
            break;
          }
          depth--;
        }
      }
    }
    if (
      open < 0 ||
      !/(?:^|[^\w$.])cn\s*$/.test(masked.slice(Math.max(0, open - 8), open))
    ) {
      out.push(
        `${rel}:${line}: G2 ${m[0]} is used outside a direct cn( argument`,
      );
      continue;
    }
    const close = matchBrace(masked, open);
    if (close < 0) throw new ScanError(`${rel}:${line}: cn( never closes`);
    const bad = tokensOf(literalText(text, masked, open, close + 1)).filter(
      (t) => t !== "mb-0" && SPACING.test(bare(t)),
    );
    if (bad.length > 0) {
      out.push(
        `${rel}:${line}: G2 ${m[0]} call site overrides its bottom pair (${bad.join(" ")})`,
      );
    }
    sites++;
  }
  return sites;
}

/** G3 over one .tsx file: the line of each flagged literal scroller, plus the
 *  count of literal scrollers read. */
function scrollerFlags(rel, text, masked) {
  const scrollers = [];
  for (const tag of tagsIn(rel, text, masked, 0, masked.length)) {
    const own = masked.slice(tag.s, tag.e);
    const constant = new RegExp(NAME_RE.source).test(own);
    const tokens = tokensOf(classNameText(text, masked, tag.s, tag.e));
    const literal = !constant && tokens.some((t) => SCROLL.test(bare(t)));
    if (!constant && !literal) continue;
    const { close, end } = elementBounds(
      rel,
      text,
      masked,
      tag.s,
      tag.e,
      tag.name,
    );
    scrollers.push({ ...tag, close, end, tokens, literal });
  }
  const flagged = [];
  let literals = 0;
  for (const sc of scrollers) {
    if (!sc.literal) continue;
    literals++;
    if (padded(sc.tokens)) continue;
    const nested = scrollers.filter(
      (o) => o !== sc && o.s >= sc.e && o.end <= sc.close,
    );
    const items = possiblyLast(children(rel, text, masked, sc.e, sc.close));
    const hit = items.some((it) =>
      tagsIn(rel, text, masked, it.from, it.to).some(
        (t) =>
          TOGGLES.has(t.name.split(".").pop()) &&
          !nested.some((o) => t.s >= o.s && t.s < o.end),
      ),
    );
    if (hit) flagged.push(lineOf(text, sc.s));
  }
  return { flagged, literals };
}

/** G4's roster pins. */
function rosterProblems(files) {
  const out = [];
  const holders = [...files.keys()]
    .filter((rel) => rel.startsWith(VENDORED) && rel.endsWith(".tsx"))
    .filter((rel) => files.get(rel).includes("after:-inset-y-"))
    .sort();
  if (JSON.stringify(holders) !== JSON.stringify(TOGGLE_UI)) {
    out.push(
      `G4 vendored toggles with after:-inset-y- are ${holders.join(", ")}`,
    );
  }
  for (const [rel, module] of Object.entries(WRAPPERS)) {
    const text = files.get(rel);
    if (text === undefined || !text.includes(`from "${module}"`)) {
      out.push(`${rel}: G4 no longer imports ${module}`);
    }
  }
  return out;
}

export function problems(files, allowlist = ALLOWLIST) {
  if (files.size === 0) return ["the walk read zero files"];
  const out = [...constantProblems(files), ...rosterProblems(files)];
  let sites = 0;
  let literals = 0;
  const flags = new Map();
  for (const [rel, text] of files) {
    const masked = mask(rel, text);
    sites += referenceProblems(rel, text, masked, out);
    if (!rel.endsWith(".tsx") || rel.startsWith(VENDORED)) continue;
    const got = scrollerFlags(rel, text, masked);
    literals += got.literals;
    if (got.flagged.length > 0) flags.set(rel, got.flagged);
  }
  if (sites === 0) out.push("G6 no DIALOG_SCROLL call sites found");
  if (literals === 0) out.push("G6 no literal scrollers found");
  for (const [rel, lines] of flags) {
    const entry = allowlist[rel];
    if (entry === undefined) {
      for (const line of lines) {
        out.push(
          `${rel}:${line}: G3 a toggle may render last in a scroller with < 8px bottom padding`,
        );
      }
    } else if (entry.count !== lines.length) {
      out.push(
        `${rel}:${lines.join(",")}: G3 ${lines.length} flagged scroller(s), allowlist says ${entry.count}`,
      );
    }
  }
  for (const rel of Object.keys(allowlist)) {
    if (!flags.has(rel)) out.push(`${rel}: G5 stale allowlist entry`);
  }
  return out;
}

const CORPUS = loadCorpus(srcEntries(ROOT));

test("the real tree passes G1-G6", () => {
  assert.deepEqual(problems(CORPUS), []);
});

test("the allowlist holds exactly its two reviewed entries", () => {
  assert.equal(Object.keys(ALLOWLIST).length, 2);
  for (const entry of Object.values(ALLOWLIST)) {
    assert.equal(entry.count, 1);
    assert.ok(entry.rationale.length > 0);
  }
});

const defWith = (a, b = a) =>
  new Map([
    [
      DEF,
      `export const DIALOG_SCROLL = "${a}";\nexport const DIALOG_SCROLL_X_HIDDEN =\n  "${b}";\n`,
    ],
  ]);

test("G1: the bottom pair must be present, matched and at least 2", () => {
  const good = "-mx-1 -mb-2 overflow-y-auto px-1 pb-2";
  assert.deepEqual(constantProblems(defWith(good)), []);
  for (const bad of [
    "-mx-1 overflow-y-auto px-1 pb-2",
    "-mx-1 -mb-2 overflow-y-auto px-1",
    "-mx-1 -mb-3 overflow-y-auto px-1 pb-2",
    "-mx-1 -mb-1 overflow-y-auto px-1 pb-1",
    "-mx-1 -mb-2 overflow-y-auto px-1 pb-2 py-1",
  ]) {
    assert.match(
      constantProblems(defWith(bad)).join("\n"),
      /G1 DIALOG_SCROLL /,
    );
  }
  const computed = new Map([
    [
      DEF,
      'export const DIALOG_SCROLL = `${"a"}`;\nexport const DIALOG_SCROLL_X_HIDDEN = "b";\n',
    ],
  ]);
  assert.match(constantProblems(computed).join("\n"), /not a single string/);
  assert.match(
    constantProblems(new Map([[DEF, "export const X = 1;\n"]])).join("\n"),
    /DIALOG_SCROLL is not an exported const/,
  );
});

const REL = "src/features/zz/Fixture.tsx";
const g2 = (body) => {
  const text = `import { cn } from "@/lib/utils";\nimport { DIALOG_SCROLL } from "@/components/dialog-scroll";\nexport const A = () => ${body};\n`;
  const out = [];
  const sites = referenceProblems(REL, text, mask(REL, text), out);
  return { out, sites };
};

test("G2: call-site bottom overrides fail; mb-0 passes", () => {
  for (const cls of [
    "py-1",
    "sm:pb-0",
    "-my-1",
    "p-4",
    "!pb-0",
    "pbe-0",
    "-mbe-2",
  ]) {
    const { out } = g2(
      `<div className={cn(DIALOG_SCROLL, "flex-1 ${cls}")} />`,
    );
    assert.match(out.join("\n"), /G2 DIALOG_SCROLL call site overrides/, cls);
  }
  for (const cls of ["mb-0 flex-1", "-mt-1 pt-1 min-h-0"]) {
    assert.deepEqual(
      g2(`<div className={cn(DIALOG_SCROLL, "${cls}")} />`),
      { out: [], sites: 1 },
      cls,
    );
  }
  assert.deepEqual(g2("<div className={DIALOG_SCROLL} />"), {
    out: [],
    sites: 1,
  });
});

test("G2: a reference outside a direct cn( argument fails closed", () => {
  for (const body of [
    "<div className={`${DIALOG_SCROLL} py-1`} />",
    '<div className={DIALOG_SCROLL + " py-1"} />',
    '<div className={clsx(DIALOG_SCROLL, "py-1")} />',
    '<div className={cn(x ? DIALOG_SCROLL : "", "py-1")} />',
  ]) {
    assert.match(g2(body).out.join("\n"), /used outside a direct cn\(/, body);
  }
  const aliased = `import { DIALOG_SCROLL as S } from "@/components/dialog-scroll";\n`;
  const out = [];
  referenceProblems(REL, aliased, mask(REL, aliased), out);
  assert.match(out.join("\n"), /G2 aliased import of DIALOG_SCROLL/);
});

const g3 = (inner, cls = "max-h-56 overflow-y-auto") => {
  const text = `export const A = () => (\n  <div className="${cls}">\n${inner}\n  </div>\n);\n`;
  return scrollerFlags(REL, text, mask(REL, text)).flagged;
};

test("G3: possibly-last toggles flag an unpadded scroller", () => {
  const flags = [
    "<p>a</p>\n<label><Checkbox checked /></label>",
    "<label><Checkbox /></label>\n{open && <label><Checkbox /></label>}",
    "<p>a</p>\n{rows.map((r) => <Radio key={r} value={r} />)}",
    '<p>a</p>\n<field.CheckboxField label="x" />',
    "<p>a</p>\n<>\n<p>b</p>\n<Switch />\n</>",
    "<p>a</p>\n<Switch />\n{/* trailing note */}",
  ];
  for (const inner of flags) assert.deepEqual(g3(inner), [2], inner);
  assert.deepEqual(g3("<p>a</p>\n<Switch />", "overflow-y-auto sm:pb-2"), [2]);
  assert.deepEqual(g3("<p>a</p>\n<Switch />", "overflow-y-auto pb-[8px]"), [2]);
  // Padding spelled in another attribute is not the scroller's class.
  const titled = g3("<p>a</p>\n<Switch />", 'overflow-y-auto" title="pb-2');
  assert.deepEqual(titled, [2]);
});

test("G3: a non-last toggle, a padded scroller or a nested scroller passes", () => {
  assert.deepEqual(g3("<Checkbox />\n<p>after</p>"), []);
  assert.deepEqual(g3("<>\n<Checkbox />\n</>\n<p>after</p>"), []);
  assert.deepEqual(g3("<p>a</p>\n<Switch />", "overflow-y-auto pb-2"), []);
  assert.deepEqual(g3("<p>a</p>\n<Switch />", "overflow-y-auto p-3"), []);
  assert.deepEqual(
    g3('<div className="max-h-40 overflow-y-auto pb-2">\n<Checkbox />\n</div>'),
    [],
  );
  assert.deepEqual(g3("<p>a</p>\n<Switch />", "overflow-hidden"), []);
});

test("G4: an aliased toggle import fails closed", () => {
  const text = `import { Checkbox as Box } from "@/components/ui/checkbox";\n`;
  const out = [];
  referenceProblems(REL, text, mask(REL, text), out);
  assert.match(out.join("\n"), /G4 aliased import of Checkbox/);
  const ns = `import * as T from "@/components/ui/switch";\n`;
  const nsOut = [];
  referenceProblems(REL, ns, mask(REL, ns), nsOut);
  assert.match(nsOut.join("\n"), /G4 namespace import/);
});

test("G4: the vendored roster and the wrappers' imports are pinned", () => {
  const rel = "src/components/ui/tabs.tsx";
  const more = new Map([...CORPUS, [rel, `const c = "after:-inset-y-1";\n`]]);
  assert.match(problems(more).join("\n"), /G4 vendored toggles/);
  const held = "src/components/held-switch.tsx";
  const moved = new Map([...CORPUS, [held, "export const HeldSwitch = 1;\n"]]);
  assert.match(problems(moved).join("\n"), /held-switch\.tsx: G4 no longer/);
});

test("G5: stale or drifted allowlist counts fail", () => {
  const rel = "src/features/settings/mcp/ImportMcpDialog.tsx";
  const drifted = { ...ALLOWLIST, [rel]: { ...ALLOWLIST[rel], count: 2 } };
  const got = problems(CORPUS, drifted);
  assert.equal(got.length, 1);
  assert.match(
    got[0],
    new RegExp(
      `^${escapeRe(rel)}:\\d+: G3 1 flagged scroller\\(s\\), allowlist says 2$`,
    ),
  );
  const stale = { ...ALLOWLIST, "src/features/zz/Gone.tsx": { count: 1 } };
  assert.deepEqual(problems(CORPUS, stale), [
    "src/features/zz/Gone.tsx: G5 stale allowlist entry",
  ]);
});

test("G6: an empty corpus, or one with no scrollers or call sites, fails", () => {
  assert.deepEqual(problems(new Map()), ["the walk read zero files"]);
  const none = problems(new Map([[REL, "export const a = 1;\n"]]), {});
  assert.ok(none.includes("G6 no DIALOG_SCROLL call sites found"));
  assert.ok(none.includes("G6 no literal scrollers found"));
  const broken = new Map([[REL, "export const A = () => <div>{</div>;\n"]]);
  assert.throws(() => problems(broken), ScanError);
});

/** The real corpus with one file's text replaced once (the literal must occur
 *  exactly once). */
function mutated(rel, from, to) {
  const real = CORPUS.get(rel);
  assert.ok(real, rel);
  assert.equal(real.split(from).length, 2, `${rel}: ${from} once`);
  return new Map([...CORPUS, [rel, real.replace(from, () => to)]]);
}

test("NC1: DIALOG_SCROLL without pb-2 fails G1", () => {
  const got = problems(
    mutated(
      DEF,
      '"-mx-1 -mb-2 overflow-y-auto px-1 pb-2"',
      '"-mx-1 -mb-2 overflow-y-auto px-1"',
    ),
  );
  assert.equal(got.length, 1);
  assert.match(got[0], /dialog-scroll\.ts:\d+: G1 DIALOG_SCROLL must carry/);
});

test("NC2: MergePrDialog's old -my-1/py-1 override fails G2", () => {
  const got = problems(
    mutated(
      "src/features/pulls/MergePrDialog.tsx",
      '"-mt-1 min-h-0 min-w-0 flex-1 space-y-4 pt-1"',
      '"-my-1 min-h-0 min-w-0 flex-1 space-y-4 py-1"',
    ),
  );
  assert.equal(got.length, 1);
  assert.match(
    got[0],
    /MergePrDialog\.tsx:\d+: G2 DIALOG_SCROLL call site overrides its bottom pair \(-my-1 py-1\)/,
  );
});

for (const [nc, rel, from] of [
  [
    "NC3",
    "src/features/projects/ProjectsBoardPanel.tsx",
    'className="max-h-56 gap-0 overflow-y-auto pb-2"',
  ],
  [
    "NC4",
    "src/features/issues/JiraIssueView.tsx",
    'className="mt-1 max-h-56 overflow-y-auto pb-2"',
  ],
  [
    "NC5",
    "src/features/repository/RepositoryFilesDialog.tsx",
    'className="h-full overflow-y-auto pb-2"',
  ],
]) {
  test(`${nc}: ${rel} without its pb-2 fails G3`, () => {
    const got = problems(mutated(rel, from, from.replace(" pb-2", "")));
    assert.equal(got.length, 1);
    assert.match(
      got[0],
      new RegExp(`^${escapeRe(rel)}:\\d+: G3 a toggle may render last`),
    );
  });
}

test("NC6: the allowlist without McpServerDialog fails G3", () => {
  const rel = "src/features/settings/mcp/McpServerDialog.tsx";
  const { [rel]: _dropped, ...rest } = ALLOWLIST;
  const got = problems(CORPUS, rest);
  assert.equal(got.length, 1);
  assert.match(
    got[0],
    new RegExp(
      `^${escapeRe(rel)}:\\d+: G3 a toggle may render last in a scroller with < 8px bottom padding$`,
    ),
  );
});
