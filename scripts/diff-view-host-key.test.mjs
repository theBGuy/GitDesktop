// Pins the diff panes' library-view and line-anchor wiring, read from source
// (src/ outside src/test/ and src/components/ui/), comment- and string-masked:
//   T1 every `<DiffView` / `<DiffViewWithMultiSelect` open tag's own `key`
//      attribute (never one inside a nested element in another attribute's
//      value) is one of `HOST_KEYS`, a key on the retained build every host
//      names `diffFile`:
//      the library clears its on-screen clone during render when the source
//      changes, so a view React keeps across a discarded render repaints in
//      the light theme;
//   T2 every `useModeLineAnchor(` call binds the result's `mark` and renders
//      that binding as a JSX child (`{mark}` after a tag's `>` or a sibling
//      child, never after a JavaScript block or a type argument list) before
//      the next call in its file, so a
//      switch reads the line in its commit;
//   T3 every file that calls a keeper's `.restore()` renders a `<SnapshotMark`
//      whose own `read` attribute's value calls that keeper's `.read()`;
//   T4 an unreadable file, an open tag with no end, and an empty roster for any
//      of the three each FAIL.
// The grammar is deliberately narrow. Out of its sight: the library components
// imported under another name, a `key` arriving through a spread, a `diffFile`
// that names something other than the retained build, a mark rendered through
// another variable, passed down as a prop or rendered past the next call, a
// call whose result isn't destructured by the `const` right before it, and a
// destructure spread over several statements.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { lineOf, maskNonCode } from "./lib/ts-mask.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKIP = ["src/test/", "src/components/ui/"];

/** Every in-scope source file under src/, as { rel: text }. */
function loadCorpus() {
  const corpus = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = relative(ROOT, abs).split(sep).join("/");
      if (SKIP.some((s) => `${rel}/`.startsWith(s))) continue;
      if (entry.isDirectory()) walk(abs);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts"))
        corpus.set(rel, readFileSync(abs, "utf8"));
    }
  };
  walk(join(ROOT, "src"));
  return corpus;
}

/** The index just past an open tag's closing `>`, or -1: `<…>` type arguments
 *  after the name and `{…}` attribute values may hold a `>` of their own. */
function openTagEnd(masked, from) {
  let braces = 0;
  let angles = 0;
  for (let k = from; k < masked.length; k++) {
    const c = masked[k];
    if (c === "{" || c === "(") braces++;
    else if (c === "}" || c === ")") braces--;
    else if (braces === 0 && c === "<") angles++;
    else if (c === ">" && masked[k - 1] !== "=" && braces === 0) {
      if (angles > 0) angles--;
      else return k + 1;
    }
    if (braces < 0) return -1;
  }
  return -1;
}

/** The open tag's own attributes, from just past its name to `end`: a brace
 *  or paren group at the top level (a spread, an attribute's value) and an
 *  unbraced element value are skipped whole, so an element nested in a value
 *  contributes none. `value` is the raw masked text (`{…}`, a quoted string or
 *  an element), null for a bare name. */
function tagAttrs(masked, from, end) {
  const attrs = [];
  const group = (i) => {
    let depth = 0;
    for (; i < end; i++) {
      const c = masked[i];
      if (c === "{" || c === "(") depth++;
      else if ((c === "}" || c === ")") && --depth === 0) return i + 1;
    }
    return end;
  };
  // Past the element whose `<` is at `i`, its children and closing tag
  // included; `end` when it never closes inside the host's tag.
  const element = (i) => {
    let depth = 0;
    while (i < end) {
      if (masked[i] === "{") {
        i = group(i);
        continue;
      }
      if (masked[i] !== "<") {
        i++;
        continue;
      }
      const closing = masked[i + 1] === "/";
      const tagEnd = openTagEnd(masked, i + 1);
      if (tagEnd === -1 || tagEnd > end) return end;
      if (closing) depth--;
      else if (masked[tagEnd - 2] !== "/") depth++;
      i = tagEnd;
      if (depth <= 0) return i;
    }
    return end;
  };
  let angles = 0;
  let k = from;
  while (k < end) {
    const c = masked[k];
    if (c === "{" || c === "(") {
      k = group(k);
      continue;
    }
    if (c === "<") angles++;
    else if (c === ">" && masked[k - 1] !== "=" && angles > 0) angles--;
    else if (angles === 0 && /[A-Za-z_$]/.test(c) && /\s/.test(masked[k - 1])) {
      const name = /^[\w$:-]+/.exec(masked.slice(k, end))[0];
      let j = k + name.length;
      while (j < end && /\s/.test(masked[j])) j++;
      if (masked[j] !== "=") {
        attrs.push({ name, value: null });
        k += name.length;
        continue;
      }
      j++;
      while (j < end && /\s/.test(masked[j])) j++;
      const q = masked[j];
      let vEnd = j;
      if (q === "{") vEnd = group(j);
      else if (q === "<") vEnd = element(j);
      else if (q === '"' || q === "'") vEnd = masked.indexOf(q, j + 1) + 1;
      attrs.push({ name, value: masked.slice(j, vEnd) });
      k = Math.max(vEnd, j + 1);
      continue;
    }
    k++;
  }
  return attrs;
}

/** Whether the `{` at `at` opens a JSX child: right after a tag's `>` (never
 *  an arrow's `=>` or a type argument list's), or after a sibling `{…}` that
 *  itself opens one, so a JavaScript block's `}` never counts. */
function opensJsxChild(masked, at) {
  let k = at - 1;
  while (k >= 0 && /\s/.test(masked[k])) k--;
  if (masked[k] === ">")
    return masked[k - 1] !== "=" && closesJsxTag(masked, k);
  if (masked[k] !== "}") return false;
  for (let depth = 0; k >= 0; k--) {
    if (masked[k] === "}") depth++;
    else if (masked[k] === "{" && --depth === 0)
      return opensJsxChild(masked, k);
  }
  return false;
}

/** Whether the `>` at `at` ends a JSX tag: its `<` (back past `{…}` attribute
 *  values) starts a tag name, a `/` or a fragment, and follows no identifier
 *  but a keyword, since `Name<…>` is a type argument list. */
function closesJsxTag(masked, at) {
  let depth = 0;
  for (let k = at - 1; k >= 0; k--) {
    const c = masked[k];
    if (c === "}") depth++;
    else if (c === "{") depth--;
    else if (depth === 0 && c === "<") {
      if (!/[A-Za-z/>]/.test(masked[k + 1] ?? "")) return false;
      let j = k - 1;
      while (j >= 0 && /\s/.test(masked[j])) j--;
      if (!/[\w$]/.test(masked[j] ?? "")) return true;
      const word = /[\w$]+$/.exec(masked.slice(0, j + 1))?.[0] ?? "";
      return /^(return|yield|await|case|default|in|of)$/.test(word);
    }
  }
  return false;
}

const HOST_TAG = /<(DiffViewWithMultiSelect|DiffView)\b/g;
// The accepted host keys, exactly; a key that extends the build's id adds its
// own entry here, scoped to the file whose host draws it (`file` absent = any).
// RenderedDiff's two arms key on the build and the record its rows are for.
const HOST_KEYS = [
  { re: /^\{\s*diffFile\.getId\(\)\s*\}$/ },
  {
    re: /^\{\s*viewKey\(viewGen, diffFile\)\s*\}$/,
    file: "src/features/diff/DiffSurface.tsx",
  },
];
const ANCHOR_CALL = /\buseModeLineAnchor\(/g;
const ANCHOR_DEF = /\bfunction\s+$/;
const MARK_BIND = /\bconst\s*\{([^}]*)\}\s*=\s*$/;
const KEEPER_RESTORE = /\blineKeeper\??\.current\??\.restore\(/g;
const KEEPER_READ = /\blineKeeper\??\.current\??\.read\(\)/;

/** Violations over a corpus; also returns the roster counts T4 reads. */
export function scan(corpus) {
  const out = [];
  let tags = 0;
  let callers = 0;
  let restores = 0;
  if (corpus.size === 0) out.push("T4 no source files read");
  for (const [rel, text] of corpus) {
    if (typeof text !== "string" || text.includes("\0")) {
      out.push(`T4 ${rel}: unreadable`);
      continue;
    }
    let masked;
    try {
      masked = maskNonCode(text, rel.endsWith(".tsx"));
    } catch (e) {
      out.push(`T4 ${rel}: ${e.message}`);
      continue;
    }
    for (const m of masked.matchAll(HOST_TAG)) {
      tags++;
      const end = openTagEnd(masked, m.index + m[0].length);
      const at = `${rel}:${lineOf(text, m.index)} <${m[1]}>`;
      if (end === -1) out.push(`T4 ${at}: no end to the open tag`);
      else if (
        !tagAttrs(masked, m.index + m[0].length, end).some(
          (a) =>
            a.name === "key" &&
            a.value !== null &&
            HOST_KEYS.some(
              (k) =>
                (k.file === undefined || k.file === rel) && k.re.test(a.value),
            ),
        )
      )
        out.push(`T1 ${at}: no key on the retained build (HOST_KEYS)`);
    }
    const calls = [...masked.matchAll(ANCHOR_CALL)].map((m) => m.index);
    calls.forEach((at, i) => {
      const before = masked.slice(Math.max(0, at - 300), at);
      if (ANCHOR_DEF.test(before)) return;
      callers++;
      const bind = MARK_BIND.exec(before);
      const mark = bind && /\bmark\b(?:\s*:\s*([\w$]+))?/.exec(bind[1]);
      const name = mark && (mark[1] ?? "mark");
      const scope = masked.slice(at, calls[i + 1] ?? masked.length);
      // A JSX child, before a tag or another child (see `opensJsxChild`).
      const rendered =
        name !== null &&
        [
          ...scope.matchAll(
            new RegExp(`\\{\\s*${name}\\s*\\}(?=\\s*[<{])`, "g"),
          ),
        ].some((m) => opensJsxChild(masked, at + m.index));
      if (!rendered)
        out.push(
          `T2 ${rel}:${lineOf(text, at)}: useModeLineAnchor's mark is not rendered`,
        );
    });
    const restoreSites = [...masked.matchAll(KEEPER_RESTORE)].length;
    if (restoreSites > 0) {
      restores += restoreSites;
      const marks = [...masked.matchAll(/<SnapshotMark\b/g)].some((m) => {
        const end = openTagEnd(masked, m.index + m[0].length);
        return (
          end !== -1 &&
          tagAttrs(masked, m.index + m[0].length, end).some(
            (a) =>
              a.name === "read" &&
              a.value !== null &&
              KEEPER_READ.test(a.value),
          )
        );
      });
      if (!marks)
        out.push(`T3 ${rel}: no <SnapshotMark> reads the keeper it restores`);
    }
  }
  if (tags === 0) out.push("T4 no library view tags found");
  if (callers === 0) out.push("T4 no useModeLineAnchor callers found");
  if (restores === 0) out.push("T4 no keeper restore sites found");
  return out;
}

const REAL = loadCorpus();
const SURFACE = "src/features/diff/DiffSurface.tsx";
const VIEWER = "src/features/diff/DiffViewer.tsx";
const IMAGE = "src/features/diff/ImageDiff.tsx";
const KEY = "key={diffFile.getId()}";
const RECORD_KEY = "key={viewKey(viewGen, diffFile)}";

/** The corpus with the `nth` occurrence of `from` in `file` replaced. */
function mutate(file, from, to, nth = 0) {
  const text = REAL.get(file);
  assert.ok(text !== undefined, `${file} is in the corpus`);
  let at = -1;
  for (let i = 0; i <= nth; i++) {
    at = text.indexOf(from, at + 1);
    assert.notEqual(at, -1, `occurrence ${nth} of ${from} in ${file}`);
  }
  const next = new Map(REAL);
  next.set(file, text.slice(0, at) + to + text.slice(at + from.length));
  return { corpus: next, line: lineOf(text, at) };
}

test("diff view hosts: the shipped source passes", () => {
  assert.deepEqual(scan(REAL), []);
});

const HOSTS = [
  [VIEWER, 0, "DiffView", KEY],
  [SURFACE, 0, "DiffViewWithMultiSelect", RECORD_KEY],
  [SURFACE, 1, "DiffView", RECORD_KEY],
];

test("T1: unkeying each host names that host", () => {
  for (const [file, nth, tag, key] of HOSTS) {
    const { corpus, line } = mutate(file, key, "", nth);
    const out = scan(corpus);
    assert.equal(out.length, 1, out.join("\n"));
    assert.match(out[0], new RegExp(`^T1 ${file}:\\d+ <${tag}>`));
    const at = Number(/:(\d+) /.exec(out[0])[1]);
    assert.ok(Math.abs(at - line) < 3, `${out[0]} names line ~${line}`);
  }
});

test("T1: a key on another build's id names that host", () => {
  for (const [file, nth, tag, key] of HOSTS) {
    const { corpus } = mutate(file, key, "key={builtDiffFile.getId()}", nth);
    const out = scan(corpus);
    assert.equal(out.length, 1, out.join("\n"));
    assert.match(out[0], new RegExp(`^T1 ${file}:\\d+ <${tag}>`));
  }
  const { corpus } = mutate(
    SURFACE,
    RECORD_KEY,
    "key={viewKey(viewGen, builtDiffFile)}",
  );
  assert.equal(scan(corpus).filter((v) => v.startsWith("T1")).length, 1);
});

test("T1: the record key counts only on RenderedDiff's arms", () => {
  const { corpus } = mutate(VIEWER, KEY, RECORD_KEY);
  const out = scan(corpus);
  assert.equal(out.length, 1, out.join("\n"));
  assert.match(out[0], new RegExp(`^T1 ${VIEWER}:\\d+ <DiffView>`));
});

test("T1 decoys: a key on a neighbour or in a comment doesn't count", () => {
  const unkeyed = mutate(SURFACE, RECORD_KEY, "", 1).corpus;
  const text = unkeyed.get(SURFACE);
  const neighbour = new Map(unkeyed);
  neighbour.set(
    SURFACE,
    text.replace("<DiffCapFooter", () => `<DiffCapFooter ${RECORD_KEY}`),
  );
  assert.equal(scan(neighbour).filter((v) => v.startsWith("T1")).length, 1);
  const comment = new Map(unkeyed);
  comment.set(
    SURFACE,
    text.replace(
      /<DiffView<AnchorRowData>\r?\n/,
      (m) => `${m}          // ${RECORD_KEY}\n`,
    ),
  );
  assert.notEqual(comment.get(SURFACE), text);
  assert.equal(scan(comment).filter((v) => v.startsWith("T1")).length, 1);
});

test("T1/T3 decoys: a data- attribute spelled like the key or read fails", () => {
  for (const [file, nth, tag, key] of HOSTS) {
    const { corpus } = mutate(file, key, `data-${key}`, nth);
    const out = scan(corpus);
    assert.equal(out.length, 1, out.join("\n"));
    assert.match(out[0], new RegExp(`^T1 ${file}:\\d+ <${tag}>`));
  }
  const from = "read={() => lineKeeper.current?.read()}";
  const { corpus } = mutate(SURFACE, from, `data-${from}`);
  assert.deepEqual(
    scan(corpus).filter((v) => v.startsWith("T3")),
    [`T3 ${SURFACE}: no <SnapshotMark> reads the keeper it restores`],
  );
});

test("T1/T3 decoys: a nested element's key or a later prop's read fails", () => {
  for (const [file, nth, tag, key] of HOSTS) {
    const { corpus } = mutate(
      file,
      key,
      `renderWidgetLine={() => <div ${key} />}`,
      nth,
    );
    const out = scan(corpus);
    assert.equal(out.length, 1, out.join("\n"));
    assert.match(out[0], new RegExp(`^T1 ${file}:\\d+ <${tag}>`));
  }
  const from = "read={() => lineKeeper.current?.read()}";
  const { corpus } = mutate(
    SURFACE,
    from,
    "read={() => undefined} onSnap={() => lineKeeper.current?.read()}",
  );
  assert.deepEqual(
    scan(corpus).filter((v) => v.startsWith("T3")),
    [`T3 ${SURFACE}: no <SnapshotMark> reads the keeper it restores`],
  );
});

test("T1 decoy: an unbraced element value's key doesn't count", () => {
  for (const [file, nth, tag, key] of HOSTS) {
    for (const value of [`<Other ${key} />`, `<Other ${key}>text</Other>`]) {
      const { corpus } = mutate(file, key, `renderer=${value}`, nth);
      const out = scan(corpus);
      assert.equal(out.length, 1, `${value}\n${out.join("\n")}`);
      assert.match(out[0], new RegExp(`^T1 ${file}:\\d+ <${tag}>`));
    }
  }
  // The element value is skipped, so the host's own key after it still counts.
  const { corpus } = mutate(VIEWER, KEY, `renderer=<Other /> ${KEY}`);
  assert.deepEqual(scan(corpus), []);
});

test("T2: dropping each caller's mark names it", () => {
  for (const file of [SURFACE, VIEWER]) {
    const { corpus } = mutate(file, "{mark}", "{null}");
    const out = scan(corpus).filter((v) => v.startsWith("T2"));
    assert.equal(out.length, 1, out.join("\n"));
    assert.match(
      out[0],
      new RegExp(`^T2 ${file}:\\d+: useModeLineAnchor's mark is not rendered$`),
    );
  }
});

test("T2 decoy: a mark bound and never rendered fails", () => {
  const { corpus } = mutate(VIEWER, "{mark}", "");
  assert.equal(scan(corpus).filter((v) => v.startsWith("T2")).length, 1);
});

test("T2 decoys: a mark named outside a JSX child fails", () => {
  const call = "const { mark } = useModeLineAnchor(";
  for (const use of [
    "void ({ mark });",
    "useEffect(() => { mark });",
    "const kept = { mark };",
    "if (flag) {} {mark} {paint()}",
    "function finish(): ReturnType<() => void> {mark} {paint()}",
  ]) {
    const unrendered = mutate(VIEWER, "{mark}", "");
    const text = unrendered.corpus.get(VIEWER);
    const at = text.indexOf(call);
    assert.notEqual(at, -1, "DiffViewer's useModeLineAnchor call");
    const stmt = text.indexOf(";", at) + 1;
    unrendered.corpus.set(
      VIEWER,
      `${text.slice(0, stmt)}\n  ${use}${text.slice(stmt)}`,
    );
    assert.equal(
      scan(unrendered.corpus).filter((v) => v.startsWith("T2")).length,
      1,
      use,
    );
  }
});

// T10: the placement types the diff holds across a hold carry data only, so
// nothing callable is retained. A member typed `(…) => …`, written as a
// method, or typed by a literal with a call or construct signature fails, as
// does such a signature on the interface itself; its type on the next line
// counts (a member ending in `:`, `=>`, `|` or `&` runs on). A name in a
// member's type resolves one level against the file's own `type` and
// `interface` declarations and fails when that declaration is callable by the
// same rules; an imported name is out of reach. A missing interface fails
// closed.
const HELD_TYPES = ["DiffLineAnchor", "ArmPaint"];
const CALL_SIG = /^\s*(?:new\s*)?[(<]/;
const RUNS_ON = /(?::|=>|\||&)\s*$/;
/** Whether a type literal anywhere in `type` opens a member with a call or
 *  construct signature (a newline separates members unless the line runs on). */
function hasCallSignature(type) {
  const open = [];
  for (let k = 0; k < type.length; k++) {
    const c = type[k];
    if ("{([".includes(c)) open.push(c);
    else if ("})]".includes(c)) open.pop();
    if (open.at(-1) !== "{" || !"{;,\n".includes(c)) continue;
    if (c === "\n" && RUNS_ON.test(type.slice(0, k))) continue;
    if (CALL_SIG.test(type.slice(k + 1))) return true;
  }
  return false;
}
/** The text from `open` (a `{`) through its matching close, or null. */
function braced(masked, open) {
  let depth = 0;
  for (let k = open; k < masked.length; k++) {
    if ("{([".includes(masked[k])) depth++;
    else if ("})]".includes(masked[k]) && --depth === 0)
      return masked.slice(open, k + 1);
  }
  return null;
}
/** The index just past the generic parameter list that opens at `open` (a
 *  `<`), or -1 when it never closes. Angle brackets count only outside
 *  `{([`, and an `=>` or a parameter default's `=` closes nothing. */
function genericEnd(masked, open) {
  let angle = 0;
  let depth = 0;
  for (let k = open; k < masked.length; k++) {
    const c = masked[k];
    if (c === "=" && masked[k + 1] === ">") k++;
    else if ("{([".includes(c)) depth++;
    else if ("})]".includes(c)) depth--;
    else if (depth === 0 && c === "<") angle++;
    else if (depth === 0 && c === ">" && --angle === 0) return k + 1;
  }
  return -1;
}
/** Whether `name` is declared in this file as a function type, or as a type
 *  literal or interface with a call or construct signature. */
function callableDeclaration(masked, word) {
  const name = word.replace(/\$/g, "\\$");
  const head = new RegExp(`\\btype ${name}(?![\\w$])\\s*`).exec(masked);
  let from = head === null ? -1 : head.index + head[0].length;
  // An unterminated parameter list reads as callable: the scan fails closed.
  if (from >= 0 && masked[from] === "<") {
    from = genericEnd(masked, from);
    if (from < 0) return true;
  }
  const assign = /\s*=/y;
  if (from >= 0) assign.lastIndex = from;
  if (from >= 0 && assign.exec(masked) !== null) {
    from = assign.lastIndex;
    let depth = 0;
    let end = masked.length;
    for (let k = from; k < masked.length; k++) {
      if ("{([".includes(masked[k])) depth++;
      else if ("})]".includes(masked[k])) depth--;
      else if (masked[k] === ";" && depth === 0) {
        end = k;
        break;
      }
    }
    const body = masked.slice(from, end);
    if (body.includes("=>") || hasCallSignature(body)) return true;
  }
  const iface = new RegExp(`\\binterface ${name}(?![\\w$])[^{]*\\{`).exec(
    masked,
  );
  if (iface === null) return false;
  const body = braced(masked, iface.index + iface[0].length - 1);
  return body === null || hasCallSignature(body);
}
function functionMembers(text) {
  const masked = maskNonCode(text.replace(/\r\n/g, "\n"), true);
  const out = [];
  const namesCallable = (type) =>
    (type.match(/[A-Za-z_$][\w$]*/g) ?? []).some((n) =>
      callableDeclaration(masked, n),
    );
  for (const name of HELD_TYPES) {
    const head = new RegExp(`\\binterface ${name}\\s*\\{`).exec(masked);
    if (head === null) throw new Error(`T10: interface ${name} not found`);
    const open = head.index + head[0].length - 1;
    let depth = 0;
    let end = -1;
    for (let k = open; k < masked.length; k++) {
      if ("{([".includes(masked[k])) depth++;
      else if ("})]".includes(masked[k]) && --depth === 0) {
        end = k;
        break;
      }
    }
    if (end < 0) throw new Error(`T10: interface ${name} has no end`);
    let member = "";
    depth = 0;
    const flush = () => {
      const m = /^\s*(?:readonly\s+)?([\w$]+)\s*\??\s*([:(<])([\s\S]*)$/.exec(
        member,
      );
      if (CALL_SIG.test(member)) out.push(`${name}.(call)`);
      else if (
        m !== null &&
        (m[2] !== ":" ||
          m[3].includes("=>") ||
          hasCallSignature(m[3]) ||
          namesCallable(m[3]))
      )
        out.push(`${name}.${m[1]}`);
      member = "";
    };
    const runsOn = () => RUNS_ON.test(member);
    for (const c of masked.slice(open + 1, end)) {
      if ("{([".includes(c)) depth++;
      else if ("})]".includes(c)) depth--;
      const ends = depth === 0 && (c === ";" || (c === "\n" && !runsOn()));
      if (ends && member.trim() !== "") flush();
      else if (!ends) member += c;
    }
    if (member.trim() !== "") flush();
  }
  return out;
}
const SURFACE_FILE = fileURLToPath(
  new URL("../src/features/diff/DiffSurface.tsx", import.meta.url),
);

test("T10: DiffLineAnchor and ArmPaint declare no function member", () => {
  const text = readFileSync(SURFACE_FILE, "utf8");
  assert.deepEqual(functionMembers(text), []);
  const put = (anchor, member) => {
    assert.equal(text.split(anchor).length, 2, anchor);
    return text.replace(anchor, () => `${anchor}\n  ${member}`);
  };
  assert.deepEqual(
    functionMembers(
      put("export interface DiffLineAnchor {", "render: () => ReactNode;"),
    ),
    ["DiffLineAnchor.render"],
  );
  assert.deepEqual(
    functionMembers(put("interface ArmPaint {", "draw(): void;")),
    ["ArmPaint.draw"],
  );
  // A member whose type starts on the next line.
  assert.deepEqual(
    functionMembers(put("interface ArmPaint {", "render:\n    () => void;")),
    ["ArmPaint.render"],
  );
  assert.deepEqual(
    functionMembers(
      put(
        "export interface DiffLineAnchor {",
        "render?:\n    | (() => void)\n    | null;",
      ),
    ),
    ["DiffLineAnchor.render"],
  );
  // A type literal with a call or construct signature, and the interface's own.
  for (const member of [
    "render: { (): ReactNode };",
    "render: {\n    (value: string): string;\n  };",
    "make: { new (): object };",
    "nested: { inner: { (): void } };",
  ])
    assert.deepEqual(
      functionMembers(put("interface ArmPaint {", member)),
      [`ArmPaint.${member.slice(0, member.indexOf(":"))}`],
      member,
    );
  assert.deepEqual(functionMembers(put("interface ArmPaint {", "(): void;")), [
    "ArmPaint.(call)",
  ]);
  // Data-only literals pass, a parenthesized type on a run-on line included.
  for (const member of [
    "meta: { a: string; b: (number | string)[] };",
    "meta: {\n    a:\n      (string | number);\n  };",
  ])
    assert.deepEqual(
      functionMembers(put("interface ArmPaint {", member)),
      [],
      member,
    );
  // A member typed by a name this file declares: callable declarations fail,
  // the union member included; data declarations pass.
  const named = (decl, member) =>
    functionMembers(`${put("interface ArmPaint {", member)}\n${decl}\n`);
  for (const [decl, member] of [
    [
      "type AnchorRenderer = (row: string) => ReactNode;",
      "render?: AnchorRenderer;",
    ],
    [
      "type AnchorRenderer = (row: string) => ReactNode;",
      "render: AnchorRenderer | null;",
    ],
    ["type Renderer<T> = (value: T) => void;", "render: Renderer<string>;"],
    // A parameter default's `=` (a function-typed default included) neither
    // ends the parameter list nor hides the alias behind it.
    ["type Renderer<T = string> = (value: T) => void;", "render?: Renderer;"],
    ["type R<T = () => void> = (v: T) => void;", "render?: R;"],
    ["type AnchorRenderer = { new (): object };", "render: AnchorRenderer;"],
    [
      "interface AnchorRenderer {\n  (row: string): ReactNode;\n}",
      "render: AnchorRenderer;",
    ],
  ])
    assert.deepEqual(named(decl, member), ["ArmPaint.render"], decl);
  for (const [decl, member] of [
    [
      "type AnchorMeta = { a: string; b: (number | string)[] };",
      "meta?: AnchorMeta;",
    ],
    ["interface AnchorMeta {\n  a: string;\n}", "meta: AnchorMeta | null;"],
    ["type Box<T = string> = { value: T };", "box?: Box;"],
  ])
    assert.deepEqual(named(decl, member), [], decl);
  assert.throws(() =>
    functionMembers(text.replace("interface ArmPaint {", "type ArmPaint = {")),
  );
});

test("T2: a second caller is judged on its own mark", () => {
  const withCaller = (body) => {
    const corpus = new Map(REAL);
    const text = REAL.get(VIEWER);
    const next = `${text}\nexport function SecondCaller() {\n${body}\n}\n`;
    corpus.set(VIEWER, next);
    return { corpus, line: lineOf(next, next.indexOf(call, text.length)) };
  };
  const call = 'useModeLineAnchor(undefined, "split", "a.ts", null)';
  // The first caller's rendered mark sits before this one: it doesn't count.
  const unrendered = withCaller(
    `  const { mark } = ${call};\n  return <div />;`,
  );
  assert.deepEqual(
    scan(unrendered.corpus).filter((v) => v.startsWith("T2")),
    [
      `T2 ${VIEWER}:${unrendered.line}: useModeLineAnchor's mark is not rendered`,
    ],
  );
  const unbound = withCaller(`  const { keepLine } = ${call};\n  return null;`);
  assert.equal(
    scan(unbound.corpus).filter((v) => v.startsWith("T2")).length,
    1,
  );
  const rendered = withCaller(
    `  const { mark } = ${call};\n  return <div>{mark}</div>;`,
  );
  assert.deepEqual(scan(rendered.corpus), []);
});

test("T3: dropping each keeper site's SnapshotMark fails", () => {
  for (const [file, from] of [
    [SURFACE, "read={() => lineKeeper.current?.read()}"],
    [IMAGE, "read={() => lineKeeper?.current?.read()}"],
  ]) {
    const { corpus } = mutate(file, from, "read={() => undefined}");
    assert.deepEqual(
      scan(corpus).filter((v) => v.startsWith("T3")),
      [`T3 ${file}: no <SnapshotMark> reads the keeper it restores`],
    );
  }
});

test("T4: empty rosters, unreadable files and open tags fail closed", () => {
  assert.ok(scan(new Map()).includes("T4 no source files read"));
  const none = new Map([["src/a.ts", "export const a = 1;\n"]]);
  assert.deepEqual(scan(none), [
    "T4 no library view tags found",
    "T4 no useModeLineAnchor callers found",
    "T4 no keeper restore sites found",
  ]);
  const binary = new Map(REAL);
  binary.set("src/b.ts", "a\0b");
  assert.ok(scan(binary).includes("T4 src/b.ts: unreadable"));
  const open = new Map(REAL);
  open.set("src/c.tsx", "export const c = <DiffView diffFile={x}");
  // The masker refuses the unterminated tag before the tag scan reads it.
  assert.ok(scan(open).some((v) => v.startsWith("T4 src/c.tsx")));
});
