// Pins the PR list's horizon note and the struct-page carriage under it. A
// GitLab unfiltered closed read stops at its horizon, so the panel reads
// `forge_pr_list_page` through `usePrListPage` and swaps Load more for a static
// note while the settled page reports `capped`. That page is a `PrListPage`
// struct under the `pr-list` prefix, beside `usePrList`'s bare arrays, so the
// raw readers of the prefix extract rows through `listPageRows`. Pinned here:
// cachedRefKind, RemotePrView's cachedPrRow and useLocalRemoteFilter's
// option-source loop. pr-create-handoff's page reads are pinned behaviourally
// by pr-create-lane.test.mjs. Source pins over masked TypeScript (no component
// runner exists); each carries one in-memory mutation control that must make
// it fail.
// Not covered: any other raw reader of the prefix, existing or added later.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { maskNonCode, matchBrace } from "./lib/ts-mask.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LIST_PANEL = "src/features/conversations/ConversationListPanel.tsx";
const LOAD_MORE = "src/features/conversations/LoadMoreRow.tsx";
const REF_CARD = "src/components/markdown/markdown-ref-card.tsx";
const PR_PANEL = "src/features/pulls/PullRequestsPanel.tsx";
const PR_QUERIES = "src/lib/git/queries/prs.ts";
const PR_ACTIONS = "src/lib/git/queries/pr-actions.ts";
const PR_VIEW = "src/features/pulls/RemotePrView.tsx";
const LOCAL_FILTER = "src/features/conversations/useLocalRemoteFilter.ts";

const read = (rel) =>
  readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

/** Whitespace and trailing commas dropped, so formatting can't move a pin. */
const squash = (s) => s.replace(/\s+/g, "").replace(/,(?=[\])}])/g, "");

/** The raw and masked text of function `name`, signature through body. */
function fnSlice(rel, raw, name) {
  const masked = maskNonCode(raw, rel.endsWith(".tsx"));
  const head = new RegExp(String.raw`\bfunction ${name}\s*\(`).exec(masked);
  if (!head) return null;
  const params = head.index + head[0].length - 1;
  const paramsEnd = matchBrace(masked, params);
  const open = masked.indexOf("{", paramsEnd + 1);
  const close = paramsEnd < 0 || open < 0 ? -1 : matchBrace(masked, open);
  if (close < 0) return null;
  return {
    start: head.index,
    raw: raw.slice(head.index, close + 1),
    masked: masked.slice(head.index, close + 1),
  };
}

const count = (s, needle) => s.split(needle).length - 1;

/** (i) Under `remoteCapped` the note renders INSTEAD of Load more, never both. */
function listPanelProblems(raw) {
  const problems = [];
  const code = squash(maskNonCode(raw, true));
  if (
    !code.includes(
      "{remoteCapped?(<ListCapNotecount={remoteCount??0}noun={remoteNoun}/>):(hasMore&&onLoadMore&&(<LoadMoreRow",
    )
  )
    problems.push(
      "the note and Load more are not one either/or branch on remoteCapped",
    );
  if (count(code, "<ListCapNote") !== 1 || count(code, "<LoadMoreRow") !== 1)
    problems.push("expected exactly one ListCapNote and one LoadMoreRow");
  return problems;
}

/** (ii) The note's copy, noun, box classes, and its static-text negatives. */
function capNoteProblems(raw) {
  const problems = [];
  const fn = fnSlice(LOAD_MORE, raw, "ListCapNote");
  if (!fn) return ["ListCapNote not found"];
  // Copy reads the RAW source: masking blanks JSX text.
  const text = fn.raw.replace(/\s+/g, " ");
  if (!text.includes("Showing the newest {count.toLocaleString()}"))
    problems.push('line 1 is not "Showing the newest {count}"');
  if (!/Use Filters to reach older \{noun\}\s*</.test(text))
    problems.push('line 2 is not "Use Filters to reach older {noun}"');
  const classes = [...fn.raw.matchAll(/className="([^"]*)"/g)].map((m) =>
    m[1].split(/\s+/).filter(Boolean),
  );
  const has = (want) => (c) => want.every((t) => c.includes(t));
  const BOXES = [
    ["outer box", ["border-t", "p-2"]],
    [
      "inner column",
      ["flex", "flex-col", "items-center", "gap-0.5", "px-3", "py-2"],
    ],
    ["line 1", ["text-xs", "font-medium", "tabular-nums"]],
    ["line 2", ["text-[11px]", "text-muted-foreground"]],
  ];
  for (const [label, want] of BOXES)
    if (!classes.some(has(want)))
      problems.push(`${label} lacks ${want.join(" ")}`);
  if (
    classes.flat().some((t) => /animate|transition|warning|destructive/.test(t))
  )
    problems.push("the note carries motion or a status color");
  // Structure reads the masked source.
  if (
    /\btabIndex\b|aria-live|\brole\s*=|<\w*Icon\b|<button\b|\bonClick\b/.test(
      fn.masked,
    )
  )
    problems.push("the note is focusable, live, interactive or iconed");
  return problems;
}

/** (iii) `#N` classification reads either page shape through listPageRows. */
function refCardProblems(raw) {
  const fn = fnSlice(REF_CARD, raw, "cachedRefKind");
  if (!fn) return ["cachedRefKind not found"];
  return squash(fn.masked).includes(
    ".some(([,page])=>listPageRows(page)?.some((row)=>row.number===number))",
  )
    ? []
    : ["cachedRefKind does not read pages through listPageRows"];
}

/** (iii-b) cachedPrRow reads either page shape through listPageRows before
 *  its lens/rows guard. */
function cachedPrRowProblems(raw) {
  const fn = fnSlice(PR_VIEW, raw, "cachedPrRow");
  if (!fn) return ["cachedPrRow not found"];
  const code = squash(fn.masked);
  const problems = [];
  if (!code.includes("getQueriesData<PrInfo[]|PrListPage>("))
    problems.push("cachedPrRow's read is not typed PrInfo[] | PrListPage");
  if (
    !code.includes(
      "constrows=listPageRows(page);if(key[3]!==lens||!rows)continue;",
    )
  )
    problems.push("cachedPrRow does not guard on listPageRows(page)");
  return problems;
}

/** The masked text of the `const optionRows` IIFE's body, or null. */
function optionRowsBody(raw) {
  const masked = maskNonCode(raw, false);
  const head = /\bconst optionRows = \(\(\): R\[\] => \{/.exec(masked);
  if (!head) return null;
  const open = head.index + head[0].length - 1;
  const close = matchBrace(masked, open);
  return close < 0 ? null : masked.slice(open, close + 1);
}

/** (iii-c) The option-source loop merges listPageRows of each cached page. */
function optionSourceProblems(raw) {
  const body = optionRowsBody(raw);
  if (body === null) return ["the optionRows expression not found"];
  const code = squash(body);
  const problems = [];
  if (!code.includes("getQueriesData<R[]|{rows:R[];capped:boolean}>("))
    problems.push("the option-source read is not typed for both page shapes");
  if (
    !code.includes(
      "constpageRows=listPageRows(page);if(pageRows&&pageRows!==remotes)rows=mergeRows(rows,filterRemoteRows(pageRows,stateFilter,false));",
    )
  )
    problems.push("the option-source loop does not merge listPageRows(page)");
  if (code.includes("filterRemoteRows(page,"))
    problems.push("a cached page reaches filterRemoteRows raw");
  return problems;
}

/** (iv) The panel extracts rows once and gates the cap on a settled page. */
function prPanelProblems(raw) {
  const problems = [];
  const code = squash(maskNonCode(raw, true));
  if (!code.includes("constprRows=listPageRows(prList.data);"))
    problems.push("prRows is not derived through listPageRows");
  if (
    !code.includes(
      "constcapped=prList.data?.capped===true&&!prList.isPlaceholderData;",
    )
  )
    problems.push("capped is not gated on !prList.isPlaceholderData");
  if (!code.includes("remoteCapped={capped}"))
    problems.push("remoteCapped is not passed the gated flag");
  // `prList.dataUpdatedAt` is a flag read, not a row read.
  if ((code.match(/prList\.data(?![\w$])/g) ?? []).length !== 2)
    problems.push("a row read bypasses prRows");
  return problems;
}

/** (v) usePrListPage: after usePrList, `usePrList`'s key plus the marker,
 *  the same-state placeholder filing over `.rows`, an inline retry. */
function pageHookProblems(raw) {
  const problems = [];
  const fn = fnSlice(PR_QUERIES, raw, "usePrListPage");
  const base = fnSlice(PR_QUERIES, raw, "usePrList");
  if (!fn || !base) return ["usePrList or usePrListPage not found"];
  if (fn.start < base.start) problems.push("usePrListPage precedes usePrList");
  const code = squash(fn.raw);
  if (
    !code.includes(
      'queryKey:[...repoKeys.prList(repo),lens,state,limit??null,remoteListFilterKey(filter),"page"]asconst',
    )
  )
    problems.push('the key is not state at index 4 and "page" at index 7');
  if (
    !code.includes(
      "keepPreviousDataForKeyAxes(repo,[[3,lens]])(prev,prevQuery)",
    )
  )
    problems.push("the placeholder does not pin the lens axis");
  if (
    !code.includes(
      "filterPlaceholderRows(page.rows,state,prevQuery?.queryKey[4])",
    )
  )
    problems.push(
      "the placeholder does not file .rows by the previous key's queryKey[4]",
    );
  if (
    !/retry:\(failureCount,err\)=>[^:]*shouldRetryQuery\(failureCount,err\)/.test(
      code,
    )
  )
    problems.push("retry is not an inline arrow over shouldRetryQuery");
  return problems;
}

/** (vi) patchPrListState re-files struct pages in a second, page-scoped write
 *  after the array write. */
function patchProblems(raw) {
  const fn = fnSlice(PR_ACTIONS, raw, "patchPrListState");
  if (!fn) return ["patchPrListState not found"];
  const code = squash(fn.raw);
  const writes = code.split("queryClient.setQueriesData<").slice(1);
  if (writes.length !== 2 || !writes[0].startsWith("PrInfo[]>"))
    return ["expected the array write, then one struct write"];
  const second = writes[1];
  const problems = [];
  if (!second.startsWith("PrListPage>"))
    problems.push("the second write is not typed PrListPage");
  if (
    !second.includes(
      'predicate:(q)=>q.queryKey[3]===lens&&q.queryKey[7]==="page"',
    )
  )
    problems.push(
      'the second write is not scoped to lens and the "page" marker',
    );
  if (!second.includes("patchRowState(page.rows,number,state)"))
    problems.push("the second write does not patch .rows");
  if (!second.includes("rows===page.rows?undefined:"))
    problems.push("the second write lacks the untouched-page bail");
  return problems;
}

/** A replacement that must change the text; a no-op control is a test bug. */
function mutate(raw, from, to) {
  const next = raw.replace(from, () => to);
  assert.notEqual(next, raw, `control did not apply: ${from}`);
  return next;
}

const PINS = [
  {
    name: "(i) the note replaces Load more under remoteCapped",
    file: LIST_PANEL,
    check: listPanelProblems,
    control: (raw) => mutate(raw, "{remoteCapped ? (", "{remoteCapped && ("),
  },
  {
    name: "(ii) the note's copy, noun and classes",
    file: LOAD_MORE,
    check: capNoteProblems,
    control: (raw) => mutate(raw, "Showing the newest", "Showing first"),
  },
  {
    name: "(ii) the note stays static, unfocusable text",
    file: LOAD_MORE,
    check: capNoteProblems,
    control: (raw) => {
      const at = raw.indexOf("export function ListCapNote(");
      assert.ok(at >= 0, "ListCapNote present");
      return (
        raw.slice(0, at) +
        mutate(
          raw.slice(at),
          '<div className="border-t p-2">',
          '<div className="border-t p-2" tabIndex={0}>',
        )
      );
    },
  },
  {
    name: "(iii) cachedRefKind reads pages through listPageRows",
    file: REF_CARD,
    check: refCardProblems,
    control: (raw) => mutate(raw, "listPageRows(page)?.some(", "page?.some("),
  },
  {
    name: "(iii-b) cachedPrRow reads pages through listPageRows",
    file: PR_VIEW,
    check: cachedPrRowProblems,
    // The base shape: a bare-array generic and an Array.isArray guard.
    control: (raw) => {
      const at = raw.indexOf("function cachedPrRow(");
      assert.ok(at >= 0, "cachedPrRow present");
      return (
        raw.slice(0, at) +
        mutate(
          raw.slice(at),
          /const pages = queryClient\.getQueriesData<PrInfo\[\] \| PrListPage>\(\{\s*queryKey: repoKeys\.prList\(repo\),\s*\}\);\s*for \(const \[key, page\] of pages\) \{\s*const rows = listPageRows\(page\);\s*if \(key\[3\] !== lens \|\| !rows\) continue;/,
          "for (const [key, rows] of queryClient.getQueriesData<PrInfo[]>({\n    queryKey: repoKeys.prList(repo),\n  })) {\n    if (key[3] !== lens || !Array.isArray(rows)) continue;",
        )
      );
    },
  },
  {
    name: "(iii-c) the option-source loop merges listPageRows of each page",
    file: LOCAL_FILTER,
    check: optionSourceProblems,
    // The base shape: a bare-array generic and the page passed straight on.
    control: (raw) =>
      mutate(
        mutate(
          raw,
          /getQueriesData<\s*R\[\] \| \{ rows: R\[\]; capped: boolean \}\s*>\(/,
          "getQueriesData<R[]>(",
        ),
        /const pageRows = listPageRows\(page\);\s*if \(pageRows && pageRows !== remotes\)\s*rows = mergeRows\(rows, filterRemoteRows\(pageRows, stateFilter, false\)\);/,
        "if (page && page !== remotes)\n        rows = mergeRows(rows, filterRemoteRows(page, stateFilter, false));",
      ),
  },
  {
    name: "(iv) the panel derives prRows and gates the cap on a settled page",
    file: PR_PANEL,
    check: prPanelProblems,
    control: (raw) =>
      mutate(
        raw,
        /prList\.data\?\.capped === true && !prList\.isPlaceholderData/,
        "prList.data?.capped === true",
      ),
  },
  {
    name: "(v) usePrListPage's key and placeholder filing",
    file: PR_QUERIES,
    check: pageHookProblems,
    control: (raw) => {
      const at = raw.indexOf("export function usePrListPage(");
      assert.ok(at >= 0, "usePrListPage present");
      return (
        raw.slice(0, at) +
        mutate(
          raw.slice(at),
          "prevQuery?.queryKey[4]",
          "prevQuery?.queryKey[3]",
        )
      );
    },
  },
  {
    name: "(vi) patchPrListState's struct-scoped second write",
    file: PR_ACTIONS,
    check: patchProblems,
    control: (raw) => {
      const fn = fnSlice(PR_ACTIONS, raw, "patchPrListState");
      assert.ok(fn, "patchPrListState present");
      const second = fn.raw.indexOf("queryClient.setQueriesData<PrListPage>");
      assert.ok(second >= 0, "the second write present");
      const end = fn.raw.lastIndexOf("}");
      return raw.replace(
        fn.raw,
        () => `${fn.raw.slice(0, second)}\n${fn.raw.slice(end)}`,
      );
    },
  },
];

for (const pin of PINS) {
  test(pin.name, (t) => {
    const raw = read(pin.file);
    assert.deepEqual(pin.check(raw), [], pin.file);
    const mutated = pin.control(raw);
    assert.notEqual(mutated, raw, "the control changed the source");
    const tripped = pin.check(mutated);
    assert.notDeepEqual(tripped, [], "the mutation control must trip the pin");
    t.diagnostic(`control trips: ${tripped.join("; ")}`);
    // CRLF is free.
    assert.deepEqual(pin.check(raw.replace(/\n/g, "\r\n")), [], "CRLF");
  });
}
