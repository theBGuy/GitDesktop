// Guard: a query in src/lib/git/queries/ whose queryFn reads the LOCAL repo or
// filesystem spells `networkMode`. react-query's default "online" mode parks a fetch
// while the OS reports no connection, and a parked query is neither loading nor
// errored — the surface waits forever with nothing on screen saying why.
//
// The unit is an object literal carrying a `queryFn:` key (hook options, queryOptions
// factories, plain option factories); that same object must carry `networkMode:` at
// its own top level. Blind spots, by design: a queryFn delegating to a helper that is
// not an `api.` call (conflictSides, listUserWorktrees), a local `api.` read whose
// name is not on LOCAL_API_PREFIXES (a new non-`git` local command must be added
// there), and local reads living outside this directory.
//
// Runs in CI's installless `guards` job, so node built-ins ONLY.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/** Call prefixes that reach the local repo or filesystem. `api.git` matches only as a
 *  camelCase word (`api.gitStatus`), never `api.github…`. */
const LOCAL_API_PREFIXES = [
  "api.git",
  "api.readTextFile",
  "api.pathIsDir",
  "api.readAgentCommands",
  "api.checkGitInstalled",
  "api.readRepoAiIgnore",
  "api.dependabotGet",
  "api.fundingGet",
];

/** Justified misses: the file, the local call its queryFn makes, and why it stays
 *  without `networkMode`. An entry matching no offender fails as stale. */
const EXEMPT = [
  {
    file: "pr-resolve.ts",
    call: "api.gitFindRemotePrResolve",
    reason:
      "a local `git worktree list` read held out of the class sweep for its own decision",
  },
  {
    file: "sync.ts",
    call: "api.gitSubmodules",
    reason:
      "a local `git submodule status` read in a file the class sweep did not cover",
  },
];

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const QUERIES_DIR = join(REPO_ROOT, "src", "lib", "git", "queries");

/** Floors for the scanned corpus (32 files and 68 local queryFn sites measured when
 *  this guard was written). A walk or a prefix list that goes inert finds nothing and
 *  reports OK, so the counts are asserted rather than trusted. */
const FILE_FLOOR = 25;
const LOCAL_SITE_FLOOR = 50;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const LOCAL_CALL_RE = new RegExp(
  `\\b(?:${LOCAL_API_PREFIXES.map(escapeRe).join("|")})(?=[A-Z]|[^\\w$])[\\w$]*`,
  "g",
);

class ScanError extends Error {}

const lineOf = (src, index) => src.slice(0, index).split("\n").length;

/** Characters after which a `/` opens a regex literal rather than dividing. */
const REGEX_OPENERS = new Set(["", ..."(,=:[!&|?{};+-*%<>~^"]);

/** `src` with comment bodies and string / template / regex text blanked to spaces,
 *  every offset and newline kept, so braces or keys inside text can't steer the
 *  scan. An unterminated construct throws: a scan that can't tell code from text
 *  refuses rather than guesses. */
function maskNonCode(src) {
  const out = src.split("");
  const blank = (from, to) => {
    for (let k = from; k < to; k++)
      if (out[k] !== "\n" && out[k] !== "\r") out[k] = " ";
  };
  const fail = (what, at) => {
    throw new ScanError(`${what} at line ${lineOf(src, at)}`);
  };
  let lastSig = "";

  const quoted = (start) => {
    const q = src[start];
    for (let j = start + 1; j < src.length; j++) {
      if (src[j] === "\\") {
        j++;
        continue;
      }
      if (src[j] === q) {
        blank(start + 1, j);
        return j + 1;
      }
      if (src[j] === "\n") break;
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

  /** Walks code from `i`; inside a template `${…}` it returns the index of the `}`
   *  that closes the expression. */
  function code(i, inTemplateExpr) {
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
        i = quoted(i);
        lastSig = c;
        continue;
      }
      if (c === "`") {
        i = template(i);
        lastSig = c;
        continue;
      }
      if (c === "/" && REGEX_OPENERS.has(lastSig)) {
        i = regex(i);
        lastSig = "/";
        continue;
      }
      if (inTemplateExpr) {
        if (c === "{") depth++;
        else if (c === "}") {
          if (depth === 0) return i;
          depth--;
        }
      }
      if (!/\s/.test(c)) lastSig = c;
      i++;
    }
    if (inTemplateExpr) fail("unterminated template expression", opened);
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
 * One file's verdict: `sites` counts queryFns calling a local prefix, `offenders`
 * are those whose object lacks a top-level `networkMode`, and `ambiguities` are
 * shapes the scan can't read (each fails the guard).
 */
function scanSource(source, file) {
  const offenders = [];
  const ambiguities = [];
  let sites = 0;
  let masked;
  try {
    masked = maskNonCode(source);
  } catch (e) {
    if (!(e instanceof ScanError)) throw e;
    return { sites, offenders, ambiguities: [`${file}: ${e.message}`] };
  }
  // A named or differently-aliased import from the api module would hide every call
  // it makes from the `api.` prefixes below. Read from the SOURCE (the mask blanks
  // the module path), keeping only imports the mask shows as code.
  for (const m of source.matchAll(
    /\bimport\s+([^;]*?)\s+from\s+["']\.\.\/api["'/]/g,
  )) {
    if (masked.slice(m.index, m.index + 6) !== "import") continue;
    const clause = m[1].trim();
    if (clause !== "* as api" && !clause.startsWith("type "))
      ambiguities.push(
        `${file}:${lineOf(source, m.index)}: imports the api module as \`${clause}\` — only \`* as api\` is visible to this scan`,
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
    const valueStart = at + "queryFn".length + colon[0].length;
    let valueEnd = close;
    for (let i = valueStart, depth = 0; i < close; i++) {
      if (OPEN.has(masked[i])) depth++;
      else if (CLOSE.has(masked[i])) depth--;
      else if (masked[i] === "," && depth === 0) {
        valueEnd = i;
        break;
      }
    }
    const calls = [
      ...masked.slice(valueStart, valueEnd).matchAll(LOCAL_CALL_RE),
    ].map((c) => c[0]);
    if (calls.length === 0) continue;
    sites++;
    const hasMode = [
      ...masked.slice(open + 1, close).matchAll(/\bnetworkMode\s*:/g),
    ].some((k) => atTopLevel(masked, open + 1, open + 1 + k.index));
    if (!hasMode) offenders.push({ site, file, calls: [...new Set(calls)] });
  }
  return { sites, offenders, ambiguities };
}

test("the scan flags a local queryFn without networkMode (negative control)", () => {
  const bare = scanSource(
    "const q = useQuery({\n  queryKey: k,\n  queryFn: () => api.gitStatus(repo),\n});\n",
    "fixture.ts",
  );
  assert.equal(bare.sites, 1, "the local-prefix match went inert");
  assert.equal(bare.offenders.length, 1, "a bare local queryFn passed");
  assert.deepEqual(bare.offenders[0].calls, ["api.gitStatus"]);

  for (const prefix of LOCAL_API_PREFIXES) {
    const call = prefix === "api.git" ? "api.gitLog" : prefix;
    const r = scanSource(`useQuery({ queryFn: () => ${call}(repo) });`, "f.ts");
    assert.equal(r.offenders.length, 1, `${prefix} no longer counts as local`);
  }

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

test("the scan passes what it should", () => {
  const cases = {
    "carries networkMode":
      'useQuery({ queryFn: () => api.gitStatus(repo), networkMode: "always" });',
    "forge call": "useQuery({ queryFn: () => api.forgePrList(repo) });",
    "github is not git": "useQuery({ queryFn: () => api.githubThing(repo) });",
    "local call only in a comment":
      "useQuery({ queryFn: () => /* api.gitLog */ api.forgeView(repo) });",
    "local call in a sibling key":
      "useQuery({ queryFn: () => api.forgeView(repo), select: () => api.gitLog });",
    "property read":
      "const f = opts.queryFn;\nuseQuery({ queryFn: f, networkMode: 'always' });",
    "type import": 'import type { Foo } from "../api";',
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
    "named api import": 'import { gitStatus } from "../api";',
    "other api alias": 'import * as git from "../api";',
  };
  for (const [name, src] of Object.entries(cases)) {
    const r = scanSource(src, "fixture.ts");
    assert.notDeepEqual(r.ambiguities, [], `${name}: read as unambiguous`);
  }
});

test("every local query in src/lib/git/queries/ carries networkMode", () => {
  const files = readdirSync(QUERIES_DIR).filter((f) => f.endsWith(".ts"));
  assert.ok(
    files.length >= FILE_FLOOR,
    `SCOPE PIN FAILED — found ${files.length} .ts files in ${relative(REPO_ROOT, QUERIES_DIR)}, below the floor ${FILE_FLOOR}; the directory moved or the filter went inert`,
  );
  assert.ok(
    files.includes("projects.ts"),
    "projects.ts is no longer in the scanned set",
  );
  let sites = 0;
  const offenders = [];
  const ambiguities = [];
  for (const file of files) {
    const source = readFileSync(join(QUERIES_DIR, file), "utf8");
    const r = scanSource(source, file);
    sites += r.sites;
    offenders.push(...r.offenders);
    ambiguities.push(...r.ambiguities);
  }
  assert.ok(
    sites >= LOCAL_SITE_FLOOR,
    `SCOPE PIN FAILED — ${sites} local queryFn sites, below the floor ${LOCAL_SITE_FLOOR}; the prefix match went inert (renamed api module? changed prefixes?)`,
  );
  assert.deepEqual(
    ambiguities,
    [],
    `Shapes this guard can't read:\n${ambiguities.join("\n")}`,
  );
  const exempted = (o) =>
    EXEMPT.find((e) => e.file === o.file && o.calls.includes(e.call));
  const stale = EXEMPT.filter(
    (e) => !offenders.some((o) => exempted(o) === e),
  ).map((e) => `${e.file}: ${e.call}`);
  assert.deepEqual(
    stale,
    [],
    `Stale EXEMPT entries (they match no bare local query — drop them):\n${stale.join("\n")}`,
  );
  const bare = offenders
    .filter((o) => !exempted(o))
    .map(
      (o) =>
        `${o.site}: queryFn calls ${o.calls.join(", ")} but its options have no networkMode — add \`networkMode: "always"\``,
    );
  assert.deepEqual(
    bare,
    [],
    `Local reads park offline without networkMode:\n${bare.join("\n")}`,
  );
});
