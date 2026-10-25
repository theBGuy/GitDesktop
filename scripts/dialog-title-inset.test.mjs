// A Dialog/Sheet title under an open content without a literal
// `showCloseButton={false}` is at risk with a JSX-expression child, a `truncate`
// class, or 40+ static characters (the 448px sm:max-w-md floor leaves ~396px
// beside the 28px close, ~47 JetBrains Mono 14px characters). It carries `pr-8`
// (32px, clear of the Dialog and the Sheet close), not overridden by a later
// padding token, on itself or on a tag between its content opening and it.
//
// Blind spots: a title built outside JSX reads as dynamic (flagged, the safe
// direction), as do `{/* */}` comments and `{" "}` spacers in its children; a
// wrapper that re-exports DialogTitle under another name is unscanned; a sibling carrying
// `pr-8` between the content opening and the title false-passes the container
// arm; a SHORT static title sharing a flex row with right-side siblings is not
// flagged; the threshold assumes content at least 448px wide (minWidth 640 keeps
// `sm:` active); a SheetTitle outside SheetHeader's p-4 still overlaps with pr-8.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  lineOf,
  maskNonCode,
  matchBrace,
  ScanError,
  sourceFiles,
  tagEnd,
} from "./lib/ts-mask.mjs";

export const STATIC_TITLE_LIMIT = 40;

/** Deferred sites, each `{ file, line, rationale }`: an entry exempts the one
 *  finding it names and fails once that finding is gone. */
export const DEFERRED = [];

const CONTENT_RE = /<(DialogContent|SheetContent)\b/g;
const TITLE_RE = /<(DialogTitle|SheetTitle)\b/g;
const OPENING_RE = /<([A-Za-z][\w$.:-]*)/g;
const CONTENT_CLOSE_RE = /<\/\s*(?:DialogContent|SheetContent)\s*>/g;
const PADDING_RE = /^(?:p|px|pr|pe)-/;

/** Index of the value of attribute `name` at brace depth 0 of the masked opening
 *  tag `[start, end)`, or -1. */
function topLevelAttr(masked, start, end, name) {
  let depth = 0;
  for (let i = start + 1; i < end; i++) {
    const c = masked[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (
      depth === 0 &&
      masked.startsWith(name, i) &&
      /\s/.test(masked[i - 1]) &&
      !/[\w$-]/.test(masked[i + name.length])
    ) {
      let j = i + name.length;
      while (/\s/.test(masked[j])) j++;
      if (masked[j] !== "=") continue;
      j++;
      while (/\s/.test(masked[j])) j++;
      return j;
    }
  }
  return -1;
}

/** The className string of the opening tag `[start, end)`: `""` when it has none,
 *  `null` when its value is not a plain string literal. Read from RAW source, since
 *  the mask blanks string bodies. */
function classNameOf(src, masked, start, end) {
  const at = topLevelAttr(masked, start, end, "className");
  if (at === -1) return "";
  const literal = (from) => {
    const q = src[from];
    if (q !== '"' && q !== "'" && q !== "`") return null;
    const close = src.indexOf(q, from + 1);
    if (close === -1) return null;
    const body = src.slice(from + 1, close);
    if (q === "`" && body.includes("${")) return null;
    return { body, close };
  };
  if (src[at] === "{") {
    const close = matchBrace(masked, at);
    if (close === -1) return null;
    let i = at + 1;
    while (/\s/.test(src[i])) i++;
    const lit = literal(i);
    if (!lit) return null;
    return src.slice(lit.close + 1, close).trim() === "" ? lit.body : null;
  }
  return literal(at)?.body ?? null;
}

const hasToken = (className, token) => className.split(/\s+/).includes(token);

/** A standalone `pr-8` that no later padding token overrides (tailwind-merge
 *  keeps the last of a conflicting group). */
const hasInset = (className) => {
  const tokens = className.split(/\s+/);
  const at = tokens.lastIndexOf("pr-8");
  return at !== -1 && !tokens.slice(at + 1).some((t) => PADDING_RE.test(t));
};

/** Classifies every Dialog/Sheet title in one `.tsx` source: `titles` counts what
 *  it read, `findings` lists each title missing its inset or unreadable to it. */
export function classifyDialogTitles(source, file) {
  const src = source.replace(/\r\n/g, "\n");
  // A file naming no title is skipped before masking, so an unrelated construct
  // the mask can't read never fails this suite.
  if (!/(Dialog|Sheet)Title/.test(src)) return { titles: 0, findings: [] };
  const found = (at, kind, detail) => ({
    file,
    line: lineOf(src, at),
    kind,
    detail,
  });
  let masked;
  try {
    masked = maskNonCode(src, true);
  } catch (e) {
    if (!(e instanceof ScanError)) throw e;
    return {
      titles: 0,
      findings: [found(0, "unclassifiable", `ScanError: ${e.message}`)],
    };
  }
  const contents = [...masked.matchAll(CONTENT_RE)].map((m) => m.index);
  const findings = [];
  let titles = 0;
  for (const m of masked.matchAll(TITLE_RE)) {
    titles++;
    const start = m.index;
    const name = m[1];
    const content = contents.filter((c) => c < start).at(-1);
    if (content === undefined) {
      findings.push(found(start, "unclassifiable", "no preceding content"));
      continue;
    }
    const contentEnd = tagEnd(masked, content);
    const end = tagEnd(masked, start);
    if (contentEnd === -1 || contentEnd > start || end === -1) {
      findings.push(found(start, "unclassifiable", "unreadable opening tag"));
      continue;
    }
    if (masked[end - 1] === "/") {
      findings.push(found(start, "unclassifiable", "self-closing title"));
      continue;
    }
    if (/\{\s*\.\.\./.test(masked.slice(start, end))) {
      findings.push(found(start, "unclassifiable", "spread props"));
      continue;
    }
    const className = classNameOf(src, masked, start, end);
    if (className === null) {
      findings.push(found(start, "unclassifiable", "non-literal className"));
      continue;
    }
    const closeRe = new RegExp(`</\\s*${name}\\s*>`, "g");
    closeRe.lastIndex = end;
    const close = closeRe.exec(masked);
    if (!close || masked.slice(end, close.index).includes(`<${name}`)) {
      findings.push(found(start, "unclassifiable", "unreadable children"));
      continue;
    }
    // A content that closed before the title governs nothing: neither its
    // exemption nor the tags inside it apply.
    let from = contentEnd;
    for (const c of masked.slice(contentEnd, start).matchAll(CONTENT_CLOSE_RE))
      from = contentEnd + c.index + c[0].length - 1;
    const closeAt = topLevelAttr(
      masked,
      content,
      contentEnd,
      "showCloseButton",
    );
    const exempt =
      from === contentEnd &&
      closeAt !== -1 &&
      masked.startsWith("{false}", closeAt);
    if (exempt) continue;
    const dynamic = masked.slice(end + 1, close.index).includes("{");
    const text = src
      .slice(end + 1, close.index)
      .replace(/<[^>]*>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    const reasons = [];
    if (dynamic) reasons.push("JSX-expression child");
    if (hasToken(className, "truncate")) reasons.push("truncate");
    if (!dynamic && text.length >= STATIC_TITLE_LIMIT)
      reasons.push(`${text.length}-char static`);
    if (reasons.length === 0 || hasInset(className)) continue;
    let inset = false;
    for (const o of masked.slice(0, start).matchAll(OPENING_RE)) {
      if (o.index <= from) continue;
      const oEnd = tagEnd(masked, o.index);
      if (oEnd === -1 || oEnd > start) continue;
      const cls = classNameOf(src, masked, o.index, oEnd);
      if (cls && hasInset(cls)) inset = true;
    }
    if (!inset)
      findings.push(
        found(start, "missing-inset", `${name}: ${reasons.join(", ")}`),
      );
  }
  return { titles, findings };
}

/** Classifies a corpus of `{ file, read }` entries; an unreadable file or a
 *  corpus with no titles at all is a finding. */
export function scanCorpus(entries) {
  const findings = [];
  let titles = 0;
  for (const { file, read } of entries) {
    let source;
    try {
      source = read();
    } catch (e) {
      findings.push({ file, line: 0, kind: "unreadable", detail: e.message });
      continue;
    }
    if (typeof source !== "string") {
      findings.push({ file, line: 0, kind: "unreadable", detail: "not text" });
      continue;
    }
    const r = classifyDialogTitles(source, file);
    titles += r.titles;
    findings.push(...r.findings);
  }
  if (titles === 0)
    findings.push({
      file: "(corpus)",
      line: 0,
      kind: "empty-corpus",
      detail: "no Dialog/Sheet titles found",
    });
  return { titles, findings };
}

/** Findings left after `deferred`, plus any entry that is malformed or stale. */
export function applyDeferrals(findings, deferred) {
  const out = [];
  const used = new Set();
  for (const f of findings) {
    const hit = deferred.findIndex(
      (d) => d.file === f.file && d.line === f.line,
    );
    if (hit === -1) out.push(f);
    else used.add(hit);
  }
  deferred.forEach((d, i) => {
    if (typeof d.rationale !== "string" || d.rationale.trim() === "")
      out.push({ ...d, kind: "deferral", detail: "entry without a rationale" });
    else if (!used.has(i))
      out.push({ ...d, kind: "deferral", detail: "stale entry" });
  });
  return out;
}

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const rel = (full) => path.relative(ROOT, full).split(path.sep).join("/");
const readRepo = (file) => readFileSync(path.join(ROOT, file), "utf8");

const corpus = () =>
  [...sourceFiles(path.join(ROOT, "src"))]
    .filter((f) => f.endsWith(".tsx"))
    .map((full) => ({
      file: rel(full),
      read: () => readFileSync(full, "utf8"),
    }));

const lines = (findings) =>
  findings.map((f) => `${f.file}:${f.line} ${f.kind} (${f.detail})`);

test("every at-risk Dialog/Sheet title in src keeps clear of the close button", () => {
  const { titles, findings } = scanCorpus(corpus());
  assert.ok(titles > 0, "the corpus held no titles");
  assert.deepEqual(
    lines(applyDeferrals(findings, DEFERRED)),
    [],
    "add pr-8 to each title (or its first-row container); see this file's header",
  );
});

const wrap = (content, title) =>
  `export const X = () => (\n  <Dialog>\n    ${content}\n      <DialogHeader>\n        ${title}\n      </DialogHeader>\n    </DialogContent>\n  </Dialog>\n);\n`;
const kinds = (src) =>
  classifyDialogTitles(src, "fixture.tsx").findings.map((f) => f.kind);
const STATIC_40 = "a".repeat(40);
const STATIC_39 = "a".repeat(39);

test("a dynamic title without the inset is flagged", () => {
  assert.deepEqual(
    kinds(wrap("<DialogContent>", "<DialogTitle>{name}</DialogTitle>")),
    ["missing-inset"],
  );
  assert.deepEqual(
    kinds(
      wrap(
        "<DialogContent>",
        '<DialogTitle className="pr-8">{name}</DialogTitle>',
      ),
    ),
    [],
  );
});

test("only a standalone pr-8 token counts", () => {
  for (const cls of ["pr-80", "sm:pr-8", "hover:pr-8", "xpr-8"])
    assert.deepEqual(
      kinds(
        wrap(
          "<DialogContent>",
          `<DialogTitle className="${cls}">{name}</DialogTitle>`,
        ),
      ),
      ["missing-inset"],
      cls,
    );
});

test("the first-row container carries the inset for a title sharing its row", () => {
  const row = (cls) =>
    wrap(
      "<DialogContent>",
      `<div className="${cls}">\n          <DialogTitle className="min-w-0">{summary}</DialogTitle>\n          {label && <Badge className="shrink-0">{label}</Badge>}\n        </div>`,
    );
  assert.deepEqual(kinds(row("flex items-center gap-2 pr-8")), []);
  assert.deepEqual(kinds(row("flex items-center gap-2")), ["missing-inset"]);
});

test("a truncating title is flagged", () => {
  assert.deepEqual(
    kinds(
      wrap(
        "<DialogContent>",
        '<DialogTitle className="truncate">Short</DialogTitle>',
      ),
    ),
    ["missing-inset"],
  );
});

test("a static title flags at 40 characters and passes at 39", () => {
  assert.deepEqual(
    kinds(wrap("<DialogContent>", `<DialogTitle>${STATIC_40}</DialogTitle>`)),
    ["missing-inset"],
  );
  assert.deepEqual(
    kinds(wrap("<DialogContent>", `<DialogTitle>${STATIC_39}</DialogTitle>`)),
    [],
  );
  assert.deepEqual(
    kinds(
      wrap(
        "<DialogContent>",
        `<SheetTitle>\n          ${STATIC_39.slice(0, 19)}\n          ${STATIC_39.slice(20)}\n        </SheetTitle>`,
      ),
    ),
    [],
  );
});

test("a literal showCloseButton={false} exempts; a dynamic one does not", () => {
  assert.deepEqual(
    kinds(
      wrap(
        "<DialogContent showCloseButton={false}>",
        '<DialogTitle className="truncate">{name}</DialogTitle>',
      ),
    ),
    [],
  );
  assert.deepEqual(
    kinds(
      wrap(
        "<DialogContent showCloseButton={busy}>",
        "<DialogTitle>{name}</DialogTitle>",
      ),
    ),
    ["missing-inset"],
  );
});

test("a SheetTitle is held to the same rule", () => {
  assert.deepEqual(
    kinds(
      "const S = () => (\n  <SheetContent>\n    <SheetHeader>\n      <SheetTitle>{name}</SheetTitle>\n    </SheetHeader>\n  </SheetContent>\n);\n",
    ),
    ["missing-inset"],
  );
});

test("titles the scanner cannot read fail closed", () => {
  for (const title of [
    "<DialogTitle />",
    "<DialogTitle {...props}>Hi</DialogTitle>",
    "<DialogTitle className={cls}>Hi</DialogTitle>",
    "<DialogTitle className={`a ${b}`}>Hi</DialogTitle>",
  ])
    assert.deepEqual(
      kinds(wrap("<DialogContent>", title)),
      ["unclassifiable"],
      title,
    );
  assert.deepEqual(
    kinds("const X = () => <DialogTitle>{name}</DialogTitle>;\n"),
    ["unclassifiable"],
  );
  assert.deepEqual(
    kinds(
      'const s = "unterminated;\nconst T = <DialogTitle>Hi</DialogTitle>;\n',
    ),
    ["unclassifiable"],
  );
  assert.deepEqual(
    kinds(
      wrap(
        "<DialogContent>",
        "<DialogTitle>Outer<DialogTitle>Inner</DialogTitle></DialogTitle>",
      ),
    ),
    ["unclassifiable"],
  );
  assert.deepEqual(
    kinds(
      wrap(
        "<DialogContent render={<DialogTitle>{name}</DialogTitle>}>",
        "<DialogTitle>Ok</DialogTitle>",
      ),
    ),
    ["unclassifiable"],
  );
});

test("a title-free file the mask cannot read is skipped", () => {
  assert.deepEqual(
    classifyDialogTitles('const s = "unterminated;\n', "a.tsx"),
    {
      titles: 0,
      findings: [],
    },
  );
});

test("a content that closed before the title governs nothing", () => {
  const closed = (aBody) =>
    `const A = () => (<DialogContent showCloseButton={false}>${aBody}</DialogContent>);\nconst B = () => (<><DialogHeader><DialogTitle>{name}</DialogTitle></DialogHeader></>);\n`;
  assert.deepEqual(kinds(closed("<DialogTitle>Pick</DialogTitle>")), [
    "missing-inset",
  ]);
  assert.deepEqual(
    kinds(
      closed('<div className="pr-8"><DialogTitle>Pick</DialogTitle></div>'),
    ),
    ["missing-inset"],
  );
});

test("a later padding token cancels the inset", () => {
  for (const cls of ["pr-8 px-0", "pr-8 p-2", "pr-8 pr-2", "pr-8 pe-0"])
    assert.deepEqual(
      kinds(
        wrap(
          "<DialogContent>",
          `<DialogTitle className="${cls}">{name}</DialogTitle>`,
        ),
      ),
      ["missing-inset"],
      cls,
    );
  assert.deepEqual(
    kinds(
      wrap(
        "<DialogContent>",
        '<DialogTitle className="px-0 pr-8">{name}</DialogTitle>',
      ),
    ),
    [],
  );
  assert.deepEqual(
    kinds(
      wrap(
        "<DialogContent>",
        '<div className="pr-8 px-0"><DialogTitle>{name}</DialogTitle></div>',
      ),
    ),
    ["missing-inset"],
  );
});

test("only the content's own showCloseButton attribute exempts", () => {
  assert.deepEqual(
    kinds(
      wrap(
        "<DialogContent render={<Foo showCloseButton={false} />}>",
        "<DialogTitle>{name}</DialogTitle>",
      ),
    ),
    ["missing-inset"],
  );
});

test("a file without titles passes; a corpus without titles fails", () => {
  const none = "export const A = () => <div>{x}</div>;\n";
  assert.deepEqual(classifyDialogTitles(none, "a.tsx"), {
    titles: 0,
    findings: [],
  });
  assert.deepEqual(
    scanCorpus([{ file: "a.tsx", read: () => none }]).findings.map(
      (f) => f.kind,
    ),
    ["empty-corpus"],
  );
  assert.deepEqual(
    scanCorpus([]).findings.map((f) => f.kind),
    ["empty-corpus"],
  );
});

test("an unreadable file fails closed", () => {
  const kindsOf = scanCorpus([
    {
      file: "gone.tsx",
      read: () => {
        throw new Error("ENOENT");
      },
    },
    {
      file: "ok.tsx",
      read: () => wrap("<DialogContent>", "<DialogTitle>Ok</DialogTitle>"),
    },
  ]).findings.map((f) => f.kind);
  assert.deepEqual(kindsOf, ["unreadable"]);
  assert.deepEqual(
    scanCorpus([
      { file: "buf.tsx", read: () => Buffer.from("<DialogTitle />") },
    ]).findings.map((f) => f.detail),
    ["not text", "no Dialog/Sheet titles found"],
  );
});

test("deferrals need a rationale and go stale with their finding", () => {
  const f = { file: "a.tsx", line: 3, kind: "missing-inset", detail: "" };
  assert.deepEqual(
    applyDeferrals([f], [{ file: "a.tsx", line: 3, rationale: "why" }]),
    [],
  );
  assert.deepEqual(
    applyDeferrals([f], [{ file: "a.tsx", line: 3, rationale: " " }]).map(
      (x) => x.kind,
    ),
    ["deferral"],
  );
  assert.deepEqual(
    applyDeferrals([], [{ file: "a.tsx", line: 3, rationale: "why" }]).map(
      (x) => x.detail,
    ),
    ["stale entry"],
  );
});

test("stripping pr-8 from a fixed site is caught", () => {
  for (const file of [
    "src/features/errors/ErrorDialog.tsx",
    "src/features/history/BlameDialog.tsx",
    "src/components/confirm-dialog.tsx",
  ]) {
    const source = readRepo(file);
    assert.deepEqual(classifyDialogTitles(source, file).findings, [], file);
    const stripped = source.replace(/(["\s])pr-8(?=["\s])/g, "$1");
    assert.notEqual(stripped, source, `${file} carries no pr-8`);
    assert.ok(
      classifyDialogTitles(stripped, file).findings.some(
        (f) => f.kind === "missing-inset",
      ),
      file,
    );
  }
});
