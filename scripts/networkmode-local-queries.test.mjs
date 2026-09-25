// Guard: a react-query options object whose queryFn reads LOCAL state (git IPC,
// app-data stores, the keychain, local files, local process and CLI probes) sets
// `networkMode: "always"`. react-query's default "online" mode parks a fetch while the
// OS reports no connection, and a parked query is neither loading nor errored — the
// surface waits forever with nothing on screen saying why.
//
// Scope: every .ts/.tsx file under src/. The unit is an object literal carrying a
// `queryFn:` key; that same object must set `networkMode: "always"` at its own top
// level. A queryFn counts as local when it names a callee from LOCAL_CALLEE_FAMILIES
// or LOCAL_CALLEES (bare, or qualified as `api.`), or invokes a command from
// LOCAL_COMMANDS; a raw `invoke` of any other command fails until it is classified.
// Blind spots, by design: a local read behind a helper whose name matches no callee
// entry; options spread into the object from somewhere the scan doesn't follow; and
// a `queryFn` spelled as a quoted key or reached through `.bind()`. The `git` family
// also claims the rare networked git IPC inside a queryFn, forcing "always" there —
// failing fast instead of parking, sanctioned only where the queryFn absorbs that
// failure (CreatePrDialog's upstream fetch).
// Known loud false ambiguities (fail-closed, not bugs): a postfix `x++ / y`, a
// `<const T,>` generic arrow, and a function-typed JSX prop's type argument.
//
// Runs in CI's installless `guards` job, so node built-ins ONLY.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/** camelCase name families that read local state in this codebase: `gitX` IPC
 *  wrappers, `listX`/`loadX`/`getX`/`readX` store and file reads, `detectX` probes.
 *  Matched only as a camelCase word (`gitStatus`, never `github…`). */
const LOCAL_CALLEE_FAMILIES = ["git", "list", "load", "get", "read", "detect"];

/** Local reads whose names fit no family. */
const LOCAL_CALLEES = [
  "checkGitInstalled",
  "pathIsDir",
  "dependabotGet",
  "fundingGet",
  "commitOnRemote",
  "conflictSides",
  "repoIdentity",
  "repoIdentityStrict",
  "jiraAccount",
  "forgeBbAccount",
  "forgeGitlabReviewTokenStatus",
  "forgeProviderFeatures",
  "forgeMyWorkSources",
  "customImageStatus",
  "pathLauncherStatus",
  "mcpLauncherPath",
  "mcpGlobalStatus",
  "resolveTaskInterpreter",
];

/** Tauri commands a queryFn may `invoke` directly, classified. An unlisted command
 *  fails the guard: a raw invoke carries no name for the families to match. */
const LOCAL_COMMANDS = ["system_health", "resolve_task_script"];
const NETWORK_COMMANDS = [];

/** Justified misses: the file, the query's key literal as its source spells it (so a
 *  second query in the file is never exempted along with it), and why the object stays
 *  without `networkMode: "always"`. An entry matching no offender fails. */
const EXEMPT = [
  {
    file: "src/lib/automations/useBackgroundPrSync.ts",
    queryKey: '["background-pr-sync"]',
    reason:
      "a forge poller: its store reads only gate the network calls, so parking it offline is the intent",
  },
];

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src");

/** Floors for the scanned corpus (714 files, 261 queryFn keys reached, and 122 local
 *  sites measured when this guard was written). A walk, key match or callee list that
 *  goes inert finds nothing and reports OK, so the counts are asserted rather than
 *  trusted; the site floor sits near the measure so a partly-inert match trips it too. */
const FILE_FLOOR = 500;
const QUERYFN_KEY_FLOOR = 230;
const LOCAL_SITE_FLOOR = 115;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const CALLEE_NAME = String.raw`(?:(?:${LOCAL_CALLEE_FAMILIES.join("|")})(?=[A-Z])[\w$]*|(?:${LOCAL_CALLEES.map(escapeRe).join("|")})(?![\w$]))`;
// A callee is bare (not a property of some other object) or qualified as `api.`,
// and is called or IS the value's tail (`queryFn: loadSettings`, `… : api.gitX`) —
// never a mere argument such as a `gitRef` variable.
const LOCAL_CALL_RE = new RegExp(
  String.raw`(?:\bapi\.|(?<![\w$.]))${CALLEE_NAME}(?=\s*(?:[(<]|$))`,
  "g",
);
const NAMED_LOCAL_RE = new RegExp(`^${CALLEE_NAME}$`);
const INVOKE_RE = /(?<![\w$.])invoke\s*(?:<[^()]*?>)?\s*\(/g;
const INVOKE_COMMAND_RE = /^invoke\s*(?:<[^()]*?>)?\s*\(\s*(["'])([\w-]+)\1/;

class ScanError extends Error {}

const lineOf = (src, index) => src.slice(0, index).split("\n").length;

/** Punctuation after which an expression starts, so a `/` opens a regex literal
 *  and, in .tsx, a `<` opens a JSX element. */
const EXPR_OPENERS = new Set([..."(,=:[!&|?{};+-*%<>~^"]);
/** Keywords after which an expression starts. */
const EXPR_KEYWORDS = new Set([
  "return",
  "throw",
  "case",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "yield",
  "await",
  "else",
  "do",
]);

/** `src` with comment bodies, string / template / regex text, and JSX text blanked
 *  to spaces, every offset and newline kept, so braces or keys inside text can't steer
 *  the scan. JSX (`jsx`, for .tsx) is walked as markup with its `{…}` expressions
 *  lexed as code. An unreadable construct throws: a scan that can't tell code from
 *  text refuses rather than guesses. */
function maskNonCode(src, jsx) {
  const out = src.split("");
  const blank = (from, to) => {
    for (let k = from; k < to; k++)
      if (out[k] !== "\n" && out[k] !== "\r") out[k] = " ";
  };
  const fail = (what, at) => {
    throw new ScanError(`${what} at line ${lineOf(src, at)}`);
  };
  // Reads the already-masked text backwards, so comments and string bodies
  // before `i` can't pose as the previous token.
  const exprStartAt = (i) => {
    let k = i - 1;
    while (k >= 0 && /\s/.test(out[k])) k--;
    if (k < 0) return true;
    if (/[\w$]/.test(out[k])) {
      let s = k;
      while (s > 0 && /[\w$]/.test(out[s - 1])) s--;
      return EXPR_KEYWORDS.has(out.slice(s, k + 1).join(""));
    }
    return EXPR_OPENERS.has(out[k]);
  };

  const quoted = (start, multiline) => {
    const q = src[start];
    for (let j = start + 1; j < src.length; j++) {
      if (src[j] === "\\" && !multiline) {
        j++;
        continue;
      }
      if (src[j] === q) {
        blank(start + 1, j);
        return j + 1;
      }
      if (src[j] === "\n" && !multiline) break;
    }
    return fail("unterminated string", start);
  };

  const regex = (start) => {
    let inClass = false;
    for (let j = start + 1; j < src.length; j++) {
      const c = src[j];
      if (c === "\\") {
        j++;
        continue;
      }
      if (c === "\n") break;
      if (c === "[") inClass = true;
      else if (c === "]") inClass = false;
      else if (c === "/" && !inClass) {
        blank(start + 1, j);
        let k = j + 1;
        while (k < src.length && /[a-z]/i.test(src[k])) k++;
        return k;
      }
    }
    return fail("unterminated regex literal", start);
  };

  const template = (start) => {
    let i = start + 1;
    while (i < src.length) {
      const c = src[i];
      if (c === "\\") {
        blank(i, i + 2);
        i += 2;
      } else if (c === "`") {
        return i + 1;
      } else if (c === "$" && src[i + 1] === "{") {
        i = code(i + 2, true) + 1;
      } else {
        blank(i, i + 1);
        i++;
      }
    }
    return fail("unterminated template literal", start);
  };

  const skipWs = (i) => {
    while (i < src.length && /\s/.test(src[i])) i++;
    return i;
  };

  /** Skips whitespace and comments between JSX attributes. */
  const skipGap = (i) => {
    for (;;) {
      i = skipWs(i);
      if (src[i] === "/" && src[i + 1] === "/") {
        const end = src.indexOf("\n", i);
        blank(i, end === -1 ? src.length : end);
        i = end === -1 ? src.length : end;
      } else if (src[i] === "/" && src[i + 1] === "*") {
        const end = src.indexOf("*/", i + 2);
        if (end === -1) return fail("unterminated block comment", i);
        blank(i, end + 2);
        i = end + 2;
      } else return i;
    }
  };

  /** A JSX element or fragment opening at `start` (a `<`); returns the index past
   *  it. A TS generic arrow's type parameters (`<T,>` / `<T extends X>`) are not
   *  JSX: those return `start + 1` so the caller reads them on as code. */
  const element = (start) => {
    let i = skipWs(start + 1);
    const name = /^[\w$.:-]*/.exec(src.slice(i))[0];
    i += name.length;
    if (name && /^\s*(,|extends\b)/.test(src.slice(i))) return start + 1;
    // Type arguments on the tag (`<Select<Item, true>`); an arrow's `=>` inside
    // them is not a closing angle.
    if (name && src[i] === "<") {
      let depth = 0;
      for (; i < src.length; i++) {
        if (src[i] === "<") depth++;
        else if (src[i] === ">" && src[i - 1] !== "=" && --depth === 0) break;
      }
      if (depth !== 0) return fail("unreadable JSX type arguments", start);
      i++;
    }
    // Attributes, then `/>` or `>`; a fragment has no name and no attributes.
    for (;;) {
      i = skipGap(i);
      const c = src[i];
      if (c === "/" && src[i + 1] === ">") return i + 2;
      if (c === ">") break;
      if (!name || i >= src.length) return fail("unreadable JSX tag", start);
      if (c === "{") {
        i = code(i + 1, true) + 1;
        continue;
      }
      const attr = /^[\w$:-]+/.exec(src.slice(i));
      if (!attr) return fail("unreadable JSX attribute", i);
      i = skipWs(i + attr[0].length);
      if (src[i] !== "=") continue;
      i = skipWs(i + 1);
      if (src[i] === '"' || src[i] === "'") i = quoted(i, true);
      else if (src[i] === "{") i = code(i + 1, true) + 1;
      else if (src[i] === "<") i = element(i);
      else return fail("unreadable JSX attribute value", i);
    }
    // Children: text is blanked, `{…}` is code, `<` opens a child or the close tag.
    i++;
    while (i < src.length) {
      const c = src[i];
      if (c === "{") {
        i = code(i + 1, true) + 1;
      } else if (c === "<") {
        const next = skipWs(i + 1);
        if (src[next] === "/") {
          const end = src.indexOf(">", next);
          if (end === -1) return fail("unterminated JSX closing tag", i);
          return end + 1;
        }
        i = element(i);
      } else {
        blank(i, i + 1);
        i++;
      }
    }
    return fail("unterminated JSX element", start);
  };

  /** Walks code from `i`; with `inExpr` (a template `${…}` or JSX `{…}`) it returns
   *  the index of the `}` that closes the expression. */
  function code(i, inExpr) {
    const opened = i;
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      const n = src[i + 1];
      if (c === "/" && n === "/") {
        const end = src.indexOf("\n", i);
        const stop = end === -1 ? src.length : end;
        blank(i, stop);
        i = stop;
        continue;
      }
      if (c === "/" && n === "*") {
        const end = src.indexOf("*/", i + 2);
        if (end === -1) fail("unterminated block comment", i);
        blank(i, end + 2);
        i = end + 2;
        continue;
      }
      if (c === '"' || c === "'") {
        i = quoted(i, false);
        continue;
      }
      if (c === "`") {
        i = template(i);
        continue;
      }
      if (c === "/" && exprStartAt(i)) {
        i = regex(i);
        continue;
      }
      if (jsx && c === "<" && exprStartAt(i)) {
        i = element(i);
        continue;
      }
      if (inExpr) {
        if (c === "{") depth++;
        else if (c === "}") {
          if (depth === 0) return i;
          depth--;
        }
      }
      i++;
    }
    if (inExpr) fail("unterminated `{…}` expression", opened);
    return i;
  }

  code(0, false);
  return out.join("");
}

const OPEN = new Set(["(", "[", "{"]);
const CLOSE = new Set([")", "]", "}"]);

/** Index of the `}` matching the `{` at `open`, or -1. */
function matchBrace(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (OPEN.has(masked[i])) depth++;
    else if (CLOSE.has(masked[i]) && --depth === 0) return i;
  }
  return -1;
}

/** Whether `index` sits at nesting depth zero between `from` and itself. */
function atTopLevel(masked, from, index) {
  let depth = 0;
  for (let i = from; i < index; i++) {
    if (OPEN.has(masked[i])) depth++;
    else if (CLOSE.has(masked[i])) depth--;
  }
  return depth === 0;
}

/**
 * One file's verdict: `sites` counts queryFns making a local read, `offenders` are
 * those whose object lacks a top-level `networkMode: "always"`, and `ambiguities` are
 * shapes the scan can't read (each fails the guard).
 */
function scanSource(source, file) {
  const offenders = [];
  const ambiguities = [];
  let sites = 0;
  let keys = 0;
  let masked;
  try {
    masked = maskNonCode(source, file.endsWith(".tsx"));
  } catch (e) {
    if (!(e instanceof ScanError)) throw e;
    return { keys, sites, offenders, ambiguities: [`${file}: ${e.message}`] };
  }
  // A renamed import hides a local callee from the name match: `* as x` of a
  // first-party module, or `{ gitStatus as s }`. Read from the SOURCE (the mask blanks
  // the module path), keeping only imports the mask shows as code.
  for (const m of source.matchAll(
    /\bimport\s+(?!type\b)([^;]*?)\s+from\s+["']([^"']+)["']/g,
  )) {
    if (masked.slice(m.index, m.index + 6) !== "import") continue;
    const [, clause, from] = m;
    const at = `${file}:${lineOf(source, m.index)}`;
    const ns = /\*\s*as\s+([\w$]+)/.exec(clause);
    if (ns && ns[1] !== "api" && /^(\.|@\/)/.test(from))
      ambiguities.push(
        `${at}: imports the first-party module "${from}" as namespace \`${ns[1]}\` — its calls are invisible to this scan; import the names, or use \`* as api\``,
      );
    for (const r of clause.matchAll(/([\w$]+)\s+as\s+([\w$]+)/g))
      if (r[1] !== r[2] && NAMED_LOCAL_RE.test(r[1]))
        ambiguities.push(
          `${at}: renames the local callee \`${r[1]}\` to \`${r[2]}\` — import it under its own name`,
        );
  }
  for (const m of masked.matchAll(/\bqueryFn\b/g)) {
    const at = m.index;
    const site = `${file}:${lineOf(source, at)}`;
    // A property READ (`options.queryFn`) is not an options object.
    if (/\.\s*$/.test(masked.slice(Math.max(0, at - 4), at))) continue;
    const colon = /^\s*:/.exec(masked.slice(at + "queryFn".length));
    if (!colon) {
      ambiguities.push(
        `${site}: \`queryFn\` is not a \`queryFn: …\` key (shorthand or destructure) — spell the key out`,
      );
      continue;
    }
    let open = -1;
    for (let i = at - 1, depth = 0; i >= 0; i--) {
      if (masked[i] === "}") depth++;
      else if (masked[i] === "{") {
        if (depth === 0) {
          open = i;
          break;
        }
        depth--;
      }
    }
    const close = open === -1 ? -1 : matchBrace(masked, open);
    if (close === -1) {
      ambiguities.push(`${site}: no balanced object encloses this queryFn`);
      continue;
    }
    keys++;
    const valueStart = at + "queryFn".length + colon[0].length;
    // A top-level comma ends the value only when the next property follows: a
    // comma inside type arguments (`invoke<Record<string, X>>(`) sits at the same
    // bracket depth. Anything else runs on, over-reading rather than cutting short.
    let valueEnd = close;
    for (let i = valueStart, depth = 0; i < close; i++) {
      if (OPEN.has(masked[i])) depth++;
      else if (CLOSE.has(masked[i])) depth--;
      else if (
        masked[i] === "," &&
        depth === 0 &&
        /^,\s*(?:[\w$]+\s*:|\.\.\.|$)/.test(masked.slice(i, close))
      ) {
        valueEnd = i;
        break;
      }
    }
    const value = masked.slice(valueStart, valueEnd);
    const calls = [...value.matchAll(LOCAL_CALL_RE)].map((c) => c[0]);
    for (const inv of value.matchAll(INVOKE_RE)) {
      const command = INVOKE_COMMAND_RE.exec(
        source.slice(valueStart + inv.index),
      )?.[2];
      if (command && LOCAL_COMMANDS.includes(command))
        calls.push(`invoke:${command}`);
      else if (!command || !NETWORK_COMMANDS.includes(command))
        ambiguities.push(
          `${site}: queryFn invokes ${command ? `"${command}"` : "a non-literal command"} — classify it in LOCAL_COMMANDS or NETWORK_COMMANDS`,
        );
    }
    if (calls.length === 0) continue;
    sites++;
    const modes = [
      ...masked.slice(open + 1, close).matchAll(/\bnetworkMode\s*:/g),
    ].filter((k) => atTopLevel(masked, open + 1, open + 1 + k.index));
    // The value is read from the SOURCE: the mask blanks string contents.
    const always = modes.some((k) =>
      /^networkMode\s*:\s*(["'])always\1/.test(
        source.slice(open + 1 + k.index),
      ),
    );
    if (!always)
      offenders.push({
        site,
        file,
        calls: [...new Set(calls)],
        why: modes.length > 0 ? "sets another networkMode" : "sets none",
        object: source.slice(open, close + 1),
      });
  }
  return { keys, sites, offenders, ambiguities };
}

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(full);
    else if (/\.tsx?$/.test(entry.name)) yield full;
  }
}

test("the scan flags a local queryFn without networkMode (negative control)", () => {
  const bare = scanSource(
    "const q = useQuery({\n  queryKey: k,\n  queryFn: () => api.gitStatus(repo),\n});\n",
    "fixture.ts",
  );
  assert.equal(bare.sites, 1, "the local-callee match went inert");
  assert.equal(bare.offenders.length, 1, "a bare local queryFn passed");
  assert.deepEqual(bare.offenders[0].calls, ["api.gitStatus"]);

  for (const family of LOCAL_CALLEE_FAMILIES) {
    const r = scanSource(
      `useQuery({ queryFn: () => ${family}Thing(repo) });`,
      "f.ts",
    );
    assert.equal(r.offenders.length, 1, `the ${family}X family went inert`);
  }
  for (const callee of LOCAL_CALLEES) {
    const r = scanSource(`useQuery({ queryFn: () => ${callee}(r) });`, "f.ts");
    assert.equal(r.offenders.length, 1, `${callee} no longer counts as local`);
  }
  for (const command of LOCAL_COMMANDS) {
    const r = scanSource(
      `useQuery({ queryFn: () => invoke<X>("${command}", {}) });`,
      "f.ts",
    );
    assert.equal(r.offenders.length, 1, `"${command}" no longer counts`);
  }

  const typeArgs = scanSource(
    "useQuery({ queryFn: () => wrap<A, B>(gitStatus(r)), enabled });",
    "fixture.ts",
  );
  assert.equal(
    typeArgs.offenders.length,
    1,
    "a comma inside type arguments ended the queryFn value early",
  );

  const online = scanSource(
    'useQuery({ queryFn: () => gitStatus(repo), networkMode: "online" });',
    "fixture.ts",
  );
  assert.equal(
    online.offenders.length,
    1,
    'a networkMode other than "always" satisfied the guard',
  );

  const nested = scanSource(
    'useQuery({\n  queryFn: async () => {\n    await c.fetchQuery({ queryKey: k, queryFn: f, networkMode: "always" });\n    return api.gitLog(repo);\n  },\n});\n',
    "fixture.ts",
  );
  assert.equal(
    nested.offenders.length,
    1,
    "a networkMode nested inside the queryFn body satisfied the OUTER object",
  );

  const lateKey = scanSource(
    'queryOptions({ queryKey: ["}"], queryFn: () => api.gitBlame(repo, `${a}/${b}`) });',
    "fixture.ts",
  );
  assert.equal(
    lateKey.offenders.length,
    1,
    "braces inside a string or template threw the enclosing-object walk off",
  );
});

test("a regex after a keyword is masked, so its text can't pose as code", () => {
  for (const keyword of ["return", "throw", "typeof", "case", "in"]) {
    const r = scanSource(
      `function f(s) {\n  ${keyword} /queryFn: { x/.test(s);\n}\nuseQuery({ queryFn: () => gitLog(r) });\n`,
      "fixture.ts",
    );
    assert.deepEqual(r.ambiguities, [], `${keyword} /re/: read as code`);
    assert.equal(r.sites, 1, `${keyword} /re/: its body was scanned as a site`);
    assert.equal(r.offenders.length, 1, `${keyword} /re/: the real site lost`);
  }
});

test("JSX is read as markup, its expressions as code", () => {
  const r = scanSource(
    [
      "export function V() {",
      "  const q = useQuery({ queryFn: () => gitStatus(p) });",
      "  return (",
      '    <div className="a{b}" title={x ? "}" : `{`}>',
      "      Couldn't load {n} // not a comment",
      "      {/* queryFn: { */}",
      "      <Row data={{ a: 1 }} onClick={() => go()} />",
      '      <button type="b" // a gap comment',
      "        /* another */ disabled>x</button>",
      "      {ok && <><b>it's</b></>}",
      "      <List<{ render: () => Node }, true> items={xs} />",
      "    </div>",
      "  );",
      "}",
    ].join("\n"),
    "fixture.tsx",
  );
  assert.deepEqual(r.ambiguities, [], "a JSX construct went unread");
  assert.equal(r.sites, 1, "JSX text or attributes posed as a site");
  assert.equal(r.offenders.length, 1, "the component's local query was lost");
  const generic = scanSource(
    "const s = useState<Set<string>>(new Set());\nconst t = a < b;\nconst u = <K extends keyof D>(k: K) => k;\nconst v = <T,>(x: T) => x;\n",
    "fixture.tsx",
  );
  assert.deepEqual(generic.ambiguities, [], "a type argument opened JSX");
});

test("the scan passes what it should", () => {
  const cases = {
    "carries networkMode":
      'useQuery({ queryFn: () => api.gitStatus(repo), networkMode: "always" });',
    "as const": `const o = { queryFn: () => gitLog(r), networkMode: "always" as const };`,
    "single quotes":
      "useQuery({ queryFn: () => gitLog(r), networkMode: 'always' });",
    "forge call": "useQuery({ queryFn: () => api.forgePrList(repo) });",
    "github is not git": "useQuery({ queryFn: () => api.githubThing(repo) });",
    "another object's getter":
      "useQuery({ queryFn: () => client.getQueryData(k) ?? fetchX() });",
    "a local-looking argument":
      "useQuery({ queryFn: () => ghDispatch(repo, gitRef), enabled });",
    "local call only in a comment":
      "useQuery({ queryFn: () => /* api.gitLog */ api.forgeView(repo) });",
    "local call in a sibling key":
      "useQuery({ queryFn: () => api.forgeView(repo), select: () => api.gitLog });",
    "property read":
      "const f = opts.queryFn;\nuseQuery({ queryFn: f, networkMode: 'always' });",
    "type import": 'import type { Foo } from "../api";',
    "plain named import": 'import { gitStatus } from "@/lib/git/api";',
  };
  for (const [name, src] of Object.entries(cases)) {
    const r = scanSource(src, "fixture.ts");
    assert.deepEqual(r.offenders, [], `${name}: flagged`);
    assert.deepEqual(r.ambiguities, [], `${name}: ambiguous`);
  }
});

test("shapes the scan can't read fail closed", () => {
  const cases = {
    "shorthand key": "useQuery({ queryKey, queryFn });",
    "unterminated block comment":
      "useQuery({ queryFn: () => api.gitLog(repo) /* never closed });",
    "unterminated string": 'useQuery({ queryFn: () => api.gitLog("repo) });',
    "unbalanced object": "queryFn: () => api.gitLog(repo) });",
    "unclassified invoke":
      'useQuery({ queryFn: () => invoke("brand_new_command") });',
    "non-literal invoke": "useQuery({ queryFn: () => invoke(cmd) });",
    "unclassified invoke behind comma'd type arguments":
      'useQuery({ queryFn: () => invoke<Record<string, X>>("brand_new_cmd"), enabled });',
    "renamed local callee": 'import { gitStatus as s } from "@/lib/git/api";',
    "other api alias": 'import * as git from "../api";',
    "first-party namespace":
      'import * as store from "@/lib/pulls/local";\nuseQuery({ queryFn: () => store.listLocalPrs(repo) });',
  };
  for (const [name, src] of Object.entries(cases)) {
    const r = scanSource(src, "fixture.ts");
    assert.notDeepEqual(r.ambiguities, [], `${name}: read as unambiguous`);
  }
  const jsx = scanSource("const v = <div>never closed;\n", "fixture.tsx");
  assert.notDeepEqual(jsx.ambiguities, [], "unterminated JSX read cleanly");
});

test('every local query in src/ sets networkMode: "always"', () => {
  const files = [...sourceFiles(SRC)];
  assert.ok(
    files.length >= FILE_FLOOR,
    `SCOPE PIN FAILED — found ${files.length} .ts/.tsx files under src/, below the floor ${FILE_FLOOR}; the walk went inert`,
  );
  let keys = 0;
  let sites = 0;
  const offenders = [];
  const ambiguities = [];
  for (const full of files) {
    const file = relative(REPO_ROOT, full).split(/[\\/]/).join("/");
    const r = scanSource(readFileSync(full, "utf8"), file);
    keys += r.keys;
    sites += r.sites;
    offenders.push(...r.offenders);
    ambiguities.push(...r.ambiguities);
  }
  assert.ok(
    keys >= QUERYFN_KEY_FLOOR,
    `SCOPE PIN FAILED — reached ${keys} queryFn keys, below the floor ${QUERYFN_KEY_FLOOR}; the key match went inert`,
  );
  assert.ok(
    sites >= LOCAL_SITE_FLOOR,
    `SCOPE PIN FAILED — ${sites} local queryFn sites, below the floor ${LOCAL_SITE_FLOOR}; the callee match went inert`,
  );
  assert.deepEqual(
    ambiguities,
    [],
    `Shapes this guard can't read:\n${ambiguities.join("\n")}`,
  );
  const exempted = (o) =>
    EXEMPT.find((e) => e.file === o.file && o.object.includes(e.queryKey));
  const stale = EXEMPT.filter(
    (e) => !offenders.some((o) => exempted(o) === e),
  ).map((e) => `${e.file}: ${e.queryKey}`);
  assert.deepEqual(
    stale,
    [],
    `Stale EXEMPT entries (they match no bare local query — drop them):\n${stale.join("\n")}`,
  );
  const bare = offenders
    .filter((o) => !exempted(o))
    .map(
      (o) =>
        `${o.site}: queryFn calls ${o.calls.join(", ")} but its options ${o.why} — set \`networkMode: "always"\`, or EXEMPT it with a reason if the read is genuinely remote`,
    );
  assert.deepEqual(
    bare,
    [],
    `Local reads park offline without networkMode "always":\n${bare.join("\n")}`,
  );
});
