// Every PR and issue detail header renders its title row through DetailTitleRow
// (src/components/detail-title-row.tsx), so the actions sit in one group pinned
// beside a title that keeps its 12.5rem. Pins: the adopter roster per file (a new
// adopter outside src/test/ joins ROSTER), a ban on the old row's and title's
// class sets as one string literal anywhere under src/ (tests included: a test
// needing the old markup joins its classes at runtime), and the component's
// purity, since its layout flip must stay pure CSS and never remount the actions.
// Not covered: headers on the spacer pattern (`flex items-start gap-2` plus a
// `flex-1` spacer span: DiscussionView, TagDetailView's release and tag
// headers), class tokens split across `cn()` arguments, and class strings built
// at runtime.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { maskNonCode, ScanError, sourceFiles } from "./lib/ts-mask.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const COMPONENT = "src/components/detail-title-row.tsx";

const ROSTER = {
  "src/features/pulls/RemotePrView.tsx": 3,
  "src/features/pulls/LocalPrView.tsx": 2,
  "src/features/issues/RemoteIssueView.tsx": 1,
  "src/features/issues/RemoteIssueViewParts.tsx": 1,
  "src/features/issues/LocalIssueView.tsx": 1,
  "src/features/issues/JiraIssueView.tsx": 1,
};

const ROW_ALLOWLIST = {
  "src/features/settings/McpServersSection.tsx":
    "settings section header with a card's actions, not a PR/issue detail header",
};

const ROW_TOKENS = ["flex", "flex-wrap", "items-start"];
const TITLE_TOKENS = ["flex-auto", "break-words"];
// Any hook call (`use(` included) or a `key` on an element: either could make the
// layout flip remount or re-branch the actions.
const IMPURE = [
  ["a hook call", /\buse(?:[A-Z]\w*)?\s*\(/],
  ["ResizeObserver", /\bResizeObserver\b/],
  ["matchMedia", /\bmatchMedia\b/],
  ["a key attribute", /\bkey\s*=/],
];

const NUL = String.fromCharCode(0);
const REPLACEMENT = String.fromCharCode(0xfffd);

/** A file's text with CRLF folded, or a ScanError when it holds a NUL or a
 *  decoding replacement character: the scan can't read it, so it fails closed. */
function readable(rel, text) {
  if (text.includes(NUL) || text.includes(REPLACEMENT)) {
    throw new ScanError(`${rel}: unreadable bytes`);
  }
  return text.replace(/\r\n/g, "\n");
}

/** Every .ts/.tsx under src/ as `[path, text]`, the path repo-relative with
 *  forward slashes. */
function* srcFiles() {
  for (const full of sourceFiles(`${ROOT}src`)) {
    const rel = relative(ROOT, full).split("\\").join("/");
    yield [rel, readFileSync(full, "utf8")];
  }
}

/** The scanned corpus; `entries` replaces the src/ walk for the controls. */
function loadCorpus(entries = srcFiles()) {
  const files = new Map();
  for (const [rel, text] of entries) files.set(rel, readable(rel, text));
  return files;
}

const mask = (rel, text) => maskNonCode(text, rel.endsWith(".tsx"));

/** The text of every string literal and template-literal text segment in
 *  `text`, read through the masked source so comments and JSX text never
 *  count. Offsets are UTF-16 code units throughout. */
function stringLiterals(rel, text) {
  const masked = mask(rel, text);
  const out = [];
  const braces = [];
  const template = (from) => {
    let k = from;
    while (
      k < masked.length &&
      masked[k] !== "`" &&
      !(masked[k] === "$" && masked[k + 1] === "{")
    )
      k++;
    if (k >= masked.length) throw new Error(`${rel}: unclosed template`);
    out.push(text.slice(from, k));
    if (masked[k] === "`") return k + 1;
    braces.push(0);
    return k + 2;
  };
  let i = 0;
  while (i < masked.length) {
    const c = masked[i];
    if (c === '"' || c === "'") {
      const j = masked.indexOf(c, i + 1);
      if (j < 0) throw new Error(`${rel}: unclosed string at ${i}`);
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
  return out;
}

const hasAll = (literal, tokens) => {
  const set = new Set(literal.split(/\s+/));
  return tokens.every((t) => set.has(t));
};

const adopterCount = (rel, text) =>
  (mask(rel, text).match(/<DetailTitleRow\b/g) ?? []).length;

function rosterProblems(files) {
  const problems = [];
  for (const [rel, want] of Object.entries(ROSTER)) {
    const text = files.get(rel);
    if (text === undefined) {
      problems.push(`${rel}: roster file missing`);
      continue;
    }
    const got = adopterCount(rel, text);
    if (got !== want) {
      problems.push(`${rel}: ${got} DetailTitleRow, want ${want}`);
    }
  }
  for (const [rel, text] of files) {
    const exempt =
      rel in ROSTER || rel === COMPONENT || rel.startsWith("src/test/");
    if (exempt) continue;
    if (adopterCount(rel, text) > 0) {
      problems.push(`${rel}: a new DetailTitleRow adopter joins ROSTER`);
    }
  }
  return problems;
}

function banProblems(files, tokens, allowlist, what) {
  if (files.size === 0) return ["the walk read zero files"];
  const problems = [];
  const hit = new Set();
  for (const [rel, text] of files) {
    if (rel === COMPONENT) continue;
    if (!stringLiterals(rel, text).some((l) => hasAll(l, tokens))) continue;
    hit.add(rel);
    if (!(rel in allowlist)) {
      problems.push(
        `${rel}: ${what}; a PR or issue detail header renders through DetailTitleRow, anything else takes an allowlist entry with a rationale`,
      );
    }
  }
  for (const rel of Object.keys(allowlist)) {
    if (!hit.has(rel)) problems.push(`${rel}: stale allowlist entry`);
  }
  return problems;
}

const rowBanProblems = (files, allowlist = ROW_ALLOWLIST) =>
  banProblems(files, ROW_TOKENS, allowlist, "old title-row classes");
const titleBanProblems = (files) =>
  banProblems(files, TITLE_TOKENS, {}, "old title classes");

function purityProblems(text) {
  const masked = mask(COMPONENT, text);
  return IMPURE.filter(([, re]) => re.test(masked)).map(
    ([what]) => `${COMPONENT} uses ${what}`,
  );
}

const CORPUS = loadCorpus();

test("each roster file renders its expected DetailTitleRow count", () => {
  assert.deepEqual(rosterProblems(CORPUS), []);
});

test("no src string literal spells the old title-row classes", () => {
  assert.deepEqual(rowBanProblems(CORPUS), []);
});

test("no src string literal spells the old title classes", () => {
  assert.deepEqual(titleBanProblems(CORPUS), []);
});

test("DetailTitleRow stays stateless", () => {
  assert.ok(CORPUS.has(COMPONENT), `${COMPONENT} missing`);
  assert.deepEqual(purityProblems(CORPUS.get(COMPONENT)), []);
});

test("mutation controls go red", () => {
  const OLD_ROW = ["flex", "flex-wrap", "items-start", "gap-2"].join(" ");
  const OLD_TITLE = [
    "min-w-0",
    "flex-auto",
    "text-sm",
    "font-medium",
    "break-words",
  ].join(" ");
  const withFile = (rel, text) => new Map([...CORPUS, [rel, text]]);
  const REMOTE = "src/features/pulls/RemotePrView.tsx";

  const reverted = withFile(
    REMOTE,
    CORPUS.get(REMOTE)
      .replace("<DetailTitleRow", `<div className="${OLD_ROW}"`)
      .replace("</DetailTitleRow>", "</div>"),
  );
  assert.notDeepEqual(rosterProblems(reverted), [], "reverted roster site");
  assert.notDeepEqual(rowBanProblems(reverted), [], "reverted row classes");

  const stray = withFile(
    "src/features/fake/FakeView.tsx",
    'export const F = () => <DetailTitleRow heading="x" />;\n',
  );
  assert.notDeepEqual(rosterProblems(stray), [], "non-roster adopter");

  const oldRow = withFile(
    "src/features/fake/OldRow.tsx",
    `export const R = () => <div className="${OLD_ROW}" />;\n`,
  );
  assert.notDeepEqual(rowBanProblems(oldRow), [], "old row literal");

  const oldTitle = withFile(
    "src/features/fake/OldTitle.tsx",
    `export const T = () => <h2 className="${OLD_TITLE}">t</h2>;\n`,
  );
  assert.notDeepEqual(titleBanProblems(oldTitle), [], "old title literal");

  const impure = CORPUS.get(COMPONENT).replace(
    "return (",
    "useState(0);\n  return (",
  );
  assert.notDeepEqual(purityProblems(impure), [], "useState in the component");

  const component = CORPUS.get(COMPONENT);
  for (const [label, from, to] of [
    ["useContext", "return (", "useContext(PaneWidth);\n  return ("],
    ["use(", "return (", "use(PaneWidth);\n  return ("],
    ["useId", "return (", "useId();\n  return ("],
    [
      "keyed group",
      'data-slot="detail-title-actions"',
      'key={w} data-slot="detail-title-actions"',
    ],
  ]) {
    assert.ok(component.includes(from), `${label}: anchor ${from} missing`);
    assert.notDeepEqual(
      purityProblems(component.replace(from, to)),
      [],
      `${label} in the component`,
    );
  }

  assert.notDeepEqual(
    rowBanProblems(CORPUS, {
      ...ROW_ALLOWLIST,
      "src/features/fake/Clean.tsx": "never hits",
    }),
    [],
    "stale allowlist entry",
  );

  assert.notDeepEqual(rowBanProblems(new Map()), [], "empty walk");
  assert.notDeepEqual(titleBanProblems(new Map()), [], "empty walk");

  const FAKE = "src/features/fake/Bytes.tsx";
  assert.equal(readable(FAKE, "a\r\nb"), "a\nb", "a readable file passes");
  for (const [label, bad] of [
    ["NUL", NUL],
    ["U+FFFD", REPLACEMENT],
  ]) {
    assert.throws(
      () => readable(FAKE, `export const x = "a${bad}b";\n`),
      ScanError,
      `${label} in a scanned file`,
    );
  }
  // The corpus load itself refuses an unreadable file, not just `readable`.
  assert.throws(
    () =>
      loadCorpus([
        ["src/features/fake/Clean.tsx", "export const c = 1;\n"],
        [FAKE, `export const x = "a${NUL}b";\n`],
      ]),
    ScanError,
    "a NUL file in the loaded corpus",
  );
  assert.equal(
    loadCorpus([[FAKE, "a\r\nb"]]).get(FAKE),
    "a\nb",
    "a readable corpus loads",
  );
});
