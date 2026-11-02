// Pins the composer autocomplete's reference wiring, read from source:
// useMentionCandidates.ts reads closed issues and PRs beside the open ones,
// maps each read's rows without a state filter (ranking reads each row's own
// state), and hands refInputRows the open rows first (its dedupe keeps the
// first row). mention-autocomplete.tsx keys the highlight on the candidate
// (`activeKey`), never a position, and its listbox owns only the options. The
// empty and partial-failure line is announced by one sr-only role=status the
// hook renders for the composer's whole life (a live region inserted with its
// text is not announced), with an explicit aria-live so a modal's aria-hiding
// of body children spares it; the popover's visible copy is an aria-hidden
// footer pinned after the scroll region that holds the listbox, so it never
// scrolls out of view.
//
// Not testable here: what a screen reader announces, and the popover's paint.
// Those need the live app. Runs install-free: node built-ins only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { escapeRe, maskNonCode, matchBrace, tagEnd } from "./lib/ts-mask.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CANDIDATES = "src/features/conversations/useMentionCandidates.ts";
const POPOVER = "src/components/mention-autocomplete.tsx";
// LF-normalized, so multi-line control anchors read the same on any checkout.
const read = (file) =>
  readFileSync(join(ROOT, file), "utf8").replace(/\r\n/g, "\n");
// Whitespace and trailing commas removed: formatting never moves a pin.
const flat = (s) => s.replace(/\s+/g, "").replace(/,([)\]}])/g, "$1");

/** Every call of `callee` (masked and raw text, both flattened), each with the
 *  `const` name it is assigned to, if any. */
function calls(raw, masked, callee) {
  const re = new RegExp(`(?<![\\w$.])${escapeRe(callee)}\\(`, "g");
  const out = [];
  for (let m = re.exec(masked); m !== null; m = re.exec(masked)) {
    const close = matchBrace(masked, m.index + m[0].length - 1);
    if (close < 0) throw new Error(`unclosed ${callee}( at ${m.index}`);
    const lead = /const\s+(\w+)\s*=\s*$/.exec(
      masked.slice(Math.max(0, m.index - 60), m.index),
    );
    out.push({
      name: lead?.[1] ?? null,
      code: flat(masked.slice(m.index, close + 1)),
      text: flat(raw.slice(m.index, close + 1)),
    });
  }
  return out;
}

/** The masked statement `const name = …;`, through its depth-0 semicolon. */
function constStatement(masked, name) {
  const at = masked.search(new RegExp(`const\\s+${escapeRe(name)}\\s*=`));
  if (at < 0) return null;
  let depth = 0;
  for (let i = at; i < masked.length; i++) {
    const c = masked[i];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === ";" && depth === 0) return masked.slice(at, i + 1);
  }
  return null;
}

export const PINS = {
  CLOSED_READS: "closed issue and PR reads beside the open ones",
  NO_STATE_FILTER: "issueRows/prRows apply no state filter",
  OPEN_FIRST: "refInputRows takes the open rows first",
  ACTIVE_KEY: "the highlight derives from activeKey via findIndex",
  LISTBOX_OPTIONS: "the listbox owns only role=option buttons",
  ANNOUNCER:
    "one sr-only polite atomic role=status, rendered unconditionally by the hook, reading the status line",
  VISIBLE_LINE:
    "the popover's line is an aria-hidden footer after the scroll region, which alone scrolls and holds the listbox; border-t only over rows; no role=status",
};

// Compared flattened, so the formatter may wrap the call.
const LINE_CLASS =
  'className={cn("shrink-0 px-2.5 py-2 text-[11px] text-muted-foreground", items.length > 0 && "border-t")}';
const SCROLL_CLASS = 'className="min-h-0 flex-1 overflow-y-auto"';
/** The value of a raw opening tag's literal className, or null. */
const classOf = (node) => /\sclassName="([^"]*)"/.exec(node.tag)?.[1] ?? null;

export function candidatesViolations(raw) {
  const masked = maskNonCode(raw, false);
  const problems = [];
  const need = (ok, what) => {
    if (!ok) problems.push(what);
  };

  // Each read assigned to its own name, the closed twins asking for "closed".
  const reads = [
    ...calls(raw, masked, "useIssueList"),
    ...calls(raw, masked, "usePrList"),
  ];
  const stateOf = (name) =>
    reads
      .filter((r) => r.name === name)
      .map((r) => /"(open|closed)"/.exec(r.text)?.[1] ?? null);
  need(
    JSON.stringify(stateOf("issues")) === '["open"]' &&
      JSON.stringify(stateOf("closedIssues")) === '["closed"]' &&
      JSON.stringify(stateOf("prs")) === '["open"]' &&
      JSON.stringify(stateOf("closedPrs")) === '["closed"]' &&
      flat(masked).includes(
        "constclosedIssueData=closedIssues.isPlaceholderData?undefined:closedIssues.data;",
      ) &&
      flat(masked).includes(
        "constclosedPrData=closedPrs.isPlaceholderData?undefined:closedPrs.data;",
      ),
    PINS.CLOSED_READS,
  );

  for (const name of ["issueRows", "prRows"]) {
    const stmt = constStatement(masked, name);
    need(
      stmt !== null &&
        stmt.includes(".map(") &&
        !/\.filter\(|remoteStateMatches|state\s*[!=]==|refStateTier|isOpen/.test(
          stmt,
        ),
      `${PINS.NO_STATE_FILTER} (${name})`,
    );
  }

  const inputs = calls(raw, masked, "refInputRows")
    .map((c) => c.code)
    .sort();
  need(
    JSON.stringify(inputs) ===
      JSON.stringify([
        "refInputRows(issueRows(issueData),issueRows(closedIssueData))",
        "refInputRows(prRows(prData),prRows(closedPrData))",
      ]),
    PINS.OPEN_FIRST,
  );
  return problems;
}

/** JSX elements between `from` and `to` as a tree: name, raw opening tag,
 *  span, children. Unbalanced markup throws. */
function jsxTree(raw, masked, from, to) {
  const root = { name: "#root", tag: "", start: from, end: to, children: [] };
  const stack = [root];
  const re = /<(\/?)([A-Za-z][\w.]*)?(?=[\s>/])/g;
  re.lastIndex = from;
  for (let m = re.exec(masked); m !== null && m.index < to; ) {
    const name = m[2] ?? "";
    if (m[1] === "/") {
      const top = stack.pop();
      if (!top || top.name !== name)
        throw new Error(`mismatched </${name}> at ${m.index}`);
      top.end = masked.indexOf(">", m.index) + 1;
      re.lastIndex = top.end;
    } else {
      const end = tagEnd(masked, m.index);
      if (end < 0) throw new Error(`unclosed <${name} at ${m.index}`);
      const node = {
        name,
        tag: raw.slice(m.index, end + 1),
        start: m.index,
        end: end + 1,
        children: [],
      };
      stack.at(-1).children.push(node);
      if (masked[end - 1] !== "/") stack.push(node);
      re.lastIndex = end + 1;
    }
    m = re.exec(masked);
  }
  if (stack.length !== 1) throw new Error("unbalanced JSX");
  return root;
}

const walk = (node, out = []) => {
  for (const c of node.children) {
    out.push(c);
    walk(c, out);
  }
  return out;
};
const hasRole = (node, role) => node.tag.includes(`role="${role}"`);
/** Offset just past a node's opening tag (`end` is past its closing tag). */
const openEnd = (node) => node.start + node.tag.length;

export function popoverViolations(raw) {
  const masked = maskNonCode(raw, true);
  const code = flat(masked);
  const problems = [];
  const need = (ok, what) => {
    if (!ok) problems.push(what);
  };

  need(
    code.includes(
      "const[activeKey,setActiveKey]=useState<string|null>(null);",
    ) &&
      code.includes(
        "constactiveIndex=Math.max(items.findIndex((c)=>c.key===activeKey),0);",
      ) &&
      !/setActiveIndex|activeIndex\]=useState/.test(code),
    PINS.ACTIVE_KEY,
  );

  const from = masked.indexOf("return createPortal(");
  const to = masked.indexOf("portalContainer ?? document.body", from);
  if (from < 0 || to < from) {
    problems.push(`${PINS.LISTBOX_OPTIONS} (no portal render)`);
    return problems;
  }
  const tree = jsxTree(raw, masked, from, to);
  const popover = tree.children.length === 1 ? tree.children[0] : null;
  const all = walk(tree);
  const listboxes = all.filter((n) => hasRole(n, "listbox"));
  const listbox = listboxes.length === 1 ? listboxes[0] : null;
  need(
    listbox !== null &&
      listbox !== popover &&
      listbox.tag.includes("id={listId}") &&
      listbox.children.length > 0 &&
      listbox.children.every(
        (n) => n.name === "button" && hasRole(n, "option"),
      ) &&
      walk(listbox).every((n) => n.name !== "p" && !hasRole(n, "status")),
    PINS.LISTBOX_OPTIONS,
  );

  const lines = all.filter((n) => n.name === "p");
  const line = lines.length === 1 ? lines[0] : null;
  const scroll = popover?.children[0] ?? null;
  const outer = popover === null ? null : classOf(popover);
  need(
    popover !== null &&
      listbox !== null &&
      line !== null &&
      scroll !== null &&
      // The box is a non-scrolling column: [scroll region, footer].
      outer !== null &&
      /(^|\s)flex-col(\s|$)/.test(outer) &&
      !/overflow/.test(outer) &&
      popover.children.length === 2 &&
      popover.children[1] === line &&
      scroll.name === "div" &&
      scroll.tag.includes(SCROLL_CLASS) &&
      scroll.children.length === 1 &&
      scroll.children[0] === listbox &&
      line.start > scroll.end &&
      line.tag.includes('aria-hidden="true"') &&
      flat(line.tag).includes(flat(LINE_CLASS)) &&
      flat(masked.slice(openEnd(line), masked.indexOf("</p>", line.start))) ===
        "{status}" &&
      all.every((n) => !hasRole(n, "status")),
    PINS.VISIBLE_LINE,
  );

  // Every role=status in code (comments are blanked in `masked`).
  let regions = 0;
  for (const m of raw.matchAll(/role="status"/g))
    if (masked.startsWith("role=", m.index)) regions++;
  // `const announcer = createPortal(<region>, …)`: a statement of its own, so
  // no `cond &&` or ternary can sit between the hook and the region.
  const portalAt = masked.indexOf("const announcer = createPortal(");
  const portalOpen = portalAt + "const announcer = createPortal".length;
  const portalClose = portalAt < 0 ? -1 : matchBrace(masked, portalOpen);
  const portal =
    portalClose < 0 ? null : jsxTree(raw, masked, portalOpen, portalClose);
  const region = portal?.children.length === 1 ? portal.children[0] : null;
  need(
    regions === 1 &&
      region !== null &&
      hasRole(region, "status") &&
      region.tag.includes('className="sr-only"') &&
      region.tag.includes('aria-live="polite"') &&
      region.tag.includes('aria-atomic="true"') &&
      flat(masked.slice(portalOpen, region.start)) === "(" &&
      flat(
        masked.slice(openEnd(region), masked.indexOf("</div>", region.start)),
      ) === "{status}" &&
      flat(masked.slice(region.end, portalClose + 1)) ===
        ",portalContainer??document.body)" &&
      // Rendered first in the returned fragment, outside the open gate, and
      // referenced nowhere else.
      code.includes(
        "constpopover=(<>{announcer}{open&&token?(<MentionPopover",
      ) &&
      (masked.match(/(?<![\w$])announcer(?![\w$])/g) ?? []).length === 2 &&
      code.includes("return{textareaProps,sync,onKeyDown,popover};") &&
      code.includes(
        "conststatus=result?statusLine(items.length,result.loading,result.isError):null;",
      ) &&
      /<MentionPopover[^>]*\bstatus=\{status\}/.test(code),
    PINS.ANNOUNCER,
  );
  return problems;
}

test("the shipped sources satisfy every pin", () => {
  assert.deepEqual(candidatesViolations(read(CANDIDATES)), []);
  assert.deepEqual(popoverViolations(read(POPOVER)), []);
});

test("each candidates pin fails when its wiring is undone (in memory)", () => {
  const raw = read(CANDIDATES);
  const mutate = (from, to, pin) => {
    assert.equal(raw.split(from).length, 2, `one anchor: ${from}`);
    const got = candidatesViolations(raw.replace(from, () => to));
    assert.ok(
      got.some((p) => p.startsWith(pin)),
      `expected ${pin} for ${from}: ${JSON.stringify(got)}`,
    );
  };
  mutate(
    'useIssueList(repoPath, wantsIssues, "closed"',
    'useIssueList(repoPath, wantsIssues, "open"',
    PINS.CLOSED_READS,
  );
  mutate(
    'usePrList(repoPath, wantsPrs, "closed"',
    'usePrList(repoPath, wantsPrs, "open"',
    PINS.CLOSED_READS,
  );
  mutate(
    "  const closedPrData = closedPrs.isPlaceholderData ? undefined : closedPrs.data;",
    "  const closedPrData = undefined;",
    PINS.CLOSED_READS,
  );
  mutate(
    "(list ?? []).map((i) => ({",
    '(list ?? []).filter((i) => remoteStateMatches(i.state, "open")).map((i) => ({',
    PINS.NO_STATE_FILTER,
  );
  mutate(
    "(list ?? []).map((p) => ({",
    '(list ?? []).filter((p) => p.state === "OPEN").map((p) => ({',
    PINS.NO_STATE_FILTER,
  );
  mutate(
    "refInputRows(prRows(prData), prRows(closedPrData))",
    "refInputRows(prRows(closedPrData), prRows(prData))",
    PINS.OPEN_FIRST,
  );
  mutate(
    "issueRows(issueData),\n      issueRows(closedIssueData),",
    "issueRows(closedIssueData),\n      issueRows(issueData),",
    PINS.OPEN_FIRST,
  );
});

test("each popover pin fails when its structure is undone (in memory)", () => {
  const raw = read(POPOVER);
  const caught = (src, pin, what) => {
    const got = popoverViolations(src);
    assert.ok(
      got.some((p) => p.startsWith(pin)),
      `expected ${pin} for ${what}: ${JSON.stringify(got)}`,
    );
  };
  const mutate = (from, to, pin) => {
    assert.equal(raw.split(from).length, 2, `one anchor: ${from}`);
    caught(
      raw.replace(from, () => to),
      pin,
      from,
    );
  };
  // A positional highlight instead of the keyed one.
  mutate(
    "items.findIndex((c) => c.key === activeKey),",
    "activeKey === null ? 0 : 1,",
    PINS.ACTIVE_KEY,
  );
  mutate(
    "const [activeKey, setActiveKey] = useState<string | null>(null);",
    "const [activeKey, setActiveKey] = useState(0);",
    PINS.ACTIVE_KEY,
  );

  const LIST_OPEN =
    '        <div id={listId} role="listbox" aria-label="Mention suggestions">\n';
  const LIST_CLOSE = "          ))}\n        </div>\n";
  const SCROLL_CLOSE = "        </div>\n      </div>\n";
  const REGION =
    '    <div\n      role="status"\n      aria-live="polite"\n      aria-atomic="true"\n      className="sr-only"\n    >\n      {status}\n    </div>';
  const LINE =
    '      {status !== null && (\n        <p\n          aria-hidden="true"\n          className={cn(\n            "shrink-0 px-2.5 py-2 text-[11px] text-muted-foreground",\n            items.length > 0 && "border-t",\n          )}\n        >\n          {status}\n        </p>\n      )}\n';
  for (const anchor of [
    LIST_OPEN,
    LIST_CLOSE,
    SCROLL_CLOSE,
    `${REGION},\n`,
    LINE,
  ])
    assert.equal(raw.split(anchor).length, 2, `one anchor: ${anchor}`);
  const moved = (block, from, to) =>
    raw.replace(block, () => "").replace(from, () => to);

  // A message line back inside the listbox.
  mutate(
    LIST_CLOSE,
    '          ))}\n          <p className="px-2.5">x</p>\n        </div>\n',
    PINS.LISTBOX_OPTIONS,
  );
  // The announcer moved inside the listbox.
  caught(
    moved(
      `${REGION},\n`,
      LIST_CLOSE,
      `          ))}\n${REGION}\n        </div>\n`,
    ),
    PINS.LISTBOX_OPTIONS,
    "announcer inside the listbox",
  );
  // The old shape: role and id back on the scroll container.
  mutate(LIST_OPEN, "        <div>\n", PINS.LISTBOX_OPTIONS);

  // The announcer mounted only with text, at either end of the portal.
  mutate(
    `${REGION},\n`,
    `    status !== null && (\n${REGION}\n    ),\n`,
    PINS.ANNOUNCER,
  );
  mutate(
    "const announcer = createPortal(",
    "const announcer = status !== null && createPortal(",
    PINS.ANNOUNCER,
  );
  // The announcer gated with the popover, behind a ternary, or rendered twice.
  mutate(
    "const popover = (\n    <>",
    "const popover = open && (\n    <>",
    PINS.ANNOUNCER,
  );
  mutate(
    "      {announcer}\n",
    "      {open ? announcer : null}\n",
    PINS.ANNOUNCER,
  );
  mutate(
    "      {announcer}\n",
    "      {announcer}\n      {announcer}\n",
    PINS.ANNOUNCER,
  );
  // The announcer moved back into the popover, after the listbox.
  caught(
    moved(`${REGION},\n`, LINE, `${REGION}\n${LINE}`),
    PINS.ANNOUNCER,
    "announcer inside the popover",
  );
  // A second region beside the popover's line.
  mutate(LINE, `${REGION}\n${LINE}`, PINS.ANNOUNCER);
  // The announcer visible, or no longer a live region.
  mutate('      className="sr-only"\n    >', "    >", PINS.ANNOUNCER);
  mutate(
    '      role="status"\n      aria-live',
    "      aria-live",
    PINS.ANNOUNCER,
  );
  // The announcer without its explicit politeness (a modal aria-hides it), or
  // interrupting the reader instead.
  mutate('      aria-live="polite"\n', "", PINS.ANNOUNCER);
  mutate('aria-live="polite"', 'aria-live="assertive"', PINS.ANNOUNCER);
  mutate('      aria-atomic="true"\n', "", PINS.ANNOUNCER);
  // The announcer reading something other than the shared status line.
  mutate(
    "      {status}\n    </div>,\n",
    '      {items.length === 0 ? "No matches" : null}\n    </div>,\n',
    PINS.ANNOUNCER,
  );
  mutate(
    "          status={status}\n",
    "          status={null}\n",
    PINS.ANNOUNCER,
  );

  // The visible line exposed to a reader, or a live region itself.
  mutate('<p\n          aria-hidden="true"\n', "<p\n", PINS.VISIBLE_LINE);
  mutate(
    '<p\n          aria-hidden="true"\n',
    '<p\n          role="status"\n          aria-hidden="true"\n',
    PINS.VISIBLE_LINE,
  );
  // The visible line moved into the listbox, ahead of it, or back inside the
  // scroll region, where eight rows push it below the fold.
  caught(
    moved(LINE, LIST_CLOSE, `          ))}\n  ${LINE}        </div>\n`),
    PINS.VISIBLE_LINE,
    "visible line inside the listbox",
  );
  caught(
    moved(LINE, LIST_OPEN, `${LINE}${LIST_OPEN}`),
    PINS.VISIBLE_LINE,
    "visible line ahead of the listbox",
  );
  caught(
    moved(LINE, SCROLL_CLOSE, `        </div>\n${LINE}      </div>\n`),
    PINS.VISIBLE_LINE,
    "visible line inside the scroll region",
  );
  // The outer box scrolling again, which would carry the footer with the rows.
  mutate(
    'className="z-50 flex w-72 flex-col ',
    'className="z-50 flex w-72 flex-col overflow-y-auto ',
    PINS.VISIBLE_LINE,
  );
  // The visible line restyled, bordered with no rows above it, or showing
  // something else.
  mutate('"shrink-0 px-2.5 py-2 ', '"shrink-0 px-2.5 py-1 ', PINS.VISIBLE_LINE);
  mutate('items.length > 0 && "border-t"', '"border-t"', PINS.VISIBLE_LINE);
  mutate(
    "          {status}\n        </p>\n",
    '          {"No matches"}\n        </p>\n',
    PINS.VISIBLE_LINE,
  );
});
