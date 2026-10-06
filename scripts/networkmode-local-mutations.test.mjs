// Guard: a react-query MUTATION whose mutationFn writes LOCAL state (git IPC, app-data
// stores, the keychain, local files) sets `networkMode: "always"`, and one that reaches
// the network does not. Mutations default to "online", which parks a write while the OS
// reports no connection: the button holds its pending state until reconnect, and an
// awaited local write never settles. A forge write keeps "online" on purpose, since the
// Projects board bookkeeping is built around forge writes pausing offline.
//
// Scope: every .ts/.tsx file under src/. The unit is a mutation CONSTRUCTION, found by
// name through WRAPPERS (which argument carries the mutationFn, which the options).
// Each site is classified by what its mutationFn CALLS, never by where it lives:
// every bare or `api.`-qualified callee must be named in the local or the network
// vocabulary (or NEUTRAL_CALLEES), and one network callee makes the whole site network.
// Classification is total: a callee in no vocabulary, a site with no callee, a raw
// `invoke` of an unlisted command, and a shape the scan can't read all FAIL, naming the
// site. A mutationFn passed through a parameter resolves at the enclosing hook's call
// sites in the same file (every one must agree), or is delegated to a WRAPPERS entry;
// `useRepoMutation` must thread `opts.networkMode` per site and never default it.
// A name that is a PARAMETER or a VARIABLE is never classified by its spelling
// (within the blind spots below: a reassigned parameter still resolves from its
// call site). A positional parameter resolves through a named hook (a declaration,
// or the FIRST declarator of a `const`/`let`/`var` whose whole initializer is the
// function, annotated or not: `annotationEnd` walks any type to the initializer's
// `=`, so that declarator is left unnamed only when it has no initializer). A
// parameter of any other function (a callback, a method, a constructor, a `catch`
// binding, a parenthesized or curried initializer, a second declarator), a name
// bound by a destructured or rest parameter, a parameter its function's body
// declares again, and a `const`/`let`/`var` holding a value all fail as
// ambiguities. Only imported names and named functions meet the vocabularies.
// Blind spots, by design: I/O behind a method call on an object other than `api`
// (`store.save()`) is invisible, as are options spread in from elsewhere and a
// function handed off uncalled (through `.bind()`, as an argument such as
// `helper(api.gitPush)`, or as `(0, f)()`). Pass-through resolution assumes the
// parameter is not reassigned before the use (`=`, a compound or `??=` assignment,
// a destructuring-assignment target): a reassigned parameter resolves from the call
// site. A future unprefixed network helper named like a local verb
// (`createRelease`) would classify local: the families trade that hole for
// totality, so a network write must be named in NETWORK_CALLEES on purpose. A
// return type whose object type follows a keyword (`keyof { … }`, `x is { … }`), or a
// template-literal return type (its `${…}` brace), reads as the function's body
// (`bodyAfter`), so the real body's parameters go unseen and could classify by
// spelling.
//
// Deliberately separate from networkmode-local-queries.test.mjs: that scan keys on
// `queryFn:` spelling, and a read's vocabulary (git|list|load|get|read|detect) is not
// a write's. The masker and bracket walkers are copies of that guard's.
//
// Runs in CI's installless `guards` job, so node built-ins ONLY.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/** Mutation constructions: the argument holding the mutationFn (`fnKey` names it
 *  inside an options object), the argument holding the options, and the arity. */
const WRAPPERS = {
  useMutation: { fnArg: 0, fnKey: "mutationFn", optionsArg: 0, arity: [1, 1] },
  useRepoMutation: { fnArg: 1, optionsArg: 2, arity: [2, 3] },
  useOptimisticCacheMutation: { fnArg: 0, optionsArg: null, arity: [4, 5] },
};

/** Where the app's own WRAPPERS live; `useRepoMutation` there must thread
 *  `opts.networkMode` into its useMutation, or every annotation at its sites is inert. */
const WRAPPER_HOME = "src/lib/git/queries/internal.ts";

/** camelCase name families that write local state in this codebase: app-data store
 *  and file writers (`saveX`, `setX`, `addX`, …). Matched only as a camelCase word
 *  (`setTasksEnabled`, never `settings…`). */
const LOCAL_CALLEE_FAMILIES = [
  "save",
  "set",
  "add",
  "create",
  "update",
  "delete",
  "remove",
  "clear",
  "append",
];

/** Families that reach a forge or tracker over the network (`gh` covers the
 *  `ghRelease` writes). They outrank the local families (`ghSecretSet` is a forge
 *  write), never an exact name below. */
const NETWORK_CALLEE_FAMILIES = ["forge", "gh", "jira"];

/** Local writes named individually: every git IPC write (no `git` family, so a new
 *  git command is classified on purpose, not by prefix), plus local writes whose
 *  names fit no family or sit under a network one. */
const LOCAL_CALLEES = [
  // Working tree, index and commits.
  "gitStage",
  "gitUnstage",
  "gitCommit",
  "gitApplyPatch",
  "gitApplyPartial",
  "gitDiscardAll",
  "gitDiscardPaths",
  "gitDiscardUntrackedLines",
  "gitReplaceFileLines",
  "gitForceAdd",
  "gitUntrack",
  "gitUnignoreRules",
  "gitUndoCommit",
  "resolveConflict",
  "checkoutConflictSide",
  // History rewrites, resets and in-progress operations.
  "gitReset",
  "gitRevert",
  "gitCherryPick",
  "gitCherryPickOnto",
  "gitCheckoutCommit",
  "gitRewriteCommits",
  "gitRebaseEdit",
  "gitTag",
  "gitOpAbort",
  "gitOpContinue",
  "gitOplogDismiss",
  // Branches, merges and rebases over refs already on disk.
  "gitCheckoutBranch",
  "gitCheckoutRemoteBranch",
  "gitCreateBranch",
  "gitRenameBranch",
  "gitSetBranchArchived",
  "gitDeleteBranch",
  "gitMerge",
  "gitRebase",
  "gitRebaseOnto",
  "gitUpdateBranchFrom",
  "gitBranchResetToUpstream",
  "gitMergeAutostash",
  "gitRebaseAutostash",
  "gitRebaseOntoAutostash",
  "gitSwitchAutostash",
  "gitPullRebaseDecided",
  "gitPullRebaseDecidedAutostash",
  "gitMergeLocalPr",
  "gitFinishLocalPrMerge",
  "gitAbortLocalPrMerge",
  "gitAbortRemotePrResolve",
  // Stashes.
  "gitStashAll",
  "gitStashPaths",
  "gitStashPop",
  "gitStashApply",
  "gitStashDrop",
  "gitRestoreOrphaned",
  // Config, remotes, submodules, hooks and worktrees.
  "gitSetGlobalIdentity",
  "gitSetGlobalDefaultBranch",
  "gitSetGlobalAutocrlf",
  "gitSetLocalIdentity",
  "gitRemoteSetUrl",
  "gitRemoteAdd",
  "gitRemoteRemove",
  "gitSubmoduleRemove",
  "gitSubmoduleSetUrl",
  "gitSubmoduleSetBranch",
  "gitHookWrite",
  "gitHookSetEnabled",
  "gitHookDelete",
  "gitInstallHookManager",
  "moveUserWorktree",
  "lockWorktree",
  "unlockWorktree",
  "repairWorktrees",
  // Local files and app-data stores.
  "dependabotSet",
  "dependabotDelete",
  "fundingSet",
  "fundingDelete",
  "persistRepoOwners",
  "relocateRecentRepo",
  // Under a network family, but local: `gh auth switch` rewrites gh's own config,
  // and clearing the review-bot token only drops it from the keychain.
  "ghSwitchAccount",
  "forgeGitlabReviewTokenClear",
];

/** Network writes named individually: git commands that fetch, push or run a
 *  networked tool, and anything a local family would otherwise claim. */
const NETWORK_CALLEES = [
  "gitFetch",
  "gitFetchRemote",
  "gitPull",
  "gitPullAutostash",
  "gitPush",
  "gitPushTag",
  "gitDeleteRemoteBranch",
  "gitDeleteTag",
  "gitSubmoduleUpdate",
  "gitSubmoduleAdd",
  "gitMergeRemotePr",
  "gitFinishRemotePrResolve",
  "gitRemoteDefaultBranch",
  // pre-commit `autoupdate` fetches each hook repo's latest tag.
  "gitUpdateHookManager",
];

/** Calls that do no I/O of their own; they neither make nor break a site's class. */
const NEUTRAL_CALLEES = [
  // A local read beside the writes it gates.
  "gitMergePreview",
  "isDirtyTreeRefusal",
  "literalPathspec",
  "invalidateRepoAfterWrite",
  // Projects board-write bookkeeping and pure plan builders around the gh writes.
  "trackBoardWrite",
  "moveWrite",
  "issueWritesFor",
  "hasIssueFieldWrites",
  "partitionFieldWrites",
  "shiftUpdates",
  "findBoardItem",
  "hashKey",
  "holdLens",
  "releaseLens",
  "projectItemsKey",
  "reorderBoardKey",
  "reorderCardKey",
  "routeRepositionPress",
  "nextChaseTarget",
];

/** JS globals whose names fit a local family (`setTimeout` is not a `setX` write):
 *  neutral, and checked before the families. */
const KNOWN_GLOBALS = [
  "setTimeout",
  "setInterval",
  "setImmediate",
  "clearTimeout",
  "clearInterval",
  "clearImmediate",
  "addEventListener",
  "removeEventListener",
];

/** Tauri commands a mutationFn may `invoke` directly, classified. An unlisted command
 *  fails the guard: a raw invoke carries no name for the vocabularies to match. */
const LOCAL_COMMANDS = [];
const NETWORK_COMMANDS = [];

/** Justified exceptions, keyed on the file and the hook that constructs the mutation
 *  (most mutations carry no key to name them by), each with its reason. An entry
 *  matching no failing site fails. */
const EXEMPT = [];

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src");

/** Floors for the scanned corpus (293 mutation constructions and 108 local sites
 *  measured when this guard was written). A walk, name match or vocabulary that goes
 *  inert finds nothing and reports OK, so the counts are asserted rather than
 *  trusted; the floors sit near the measure so a partly-inert match trips them too. */
const FILE_FLOOR = 500;
const SITE_FLOOR = 285;
const LOCAL_SITE_FLOOR = 104;

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

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const familyRe = (families) =>
  new RegExp(`^(?:${families.map(escapeRe).join("|")})(?=[A-Z])`);
const LOCAL_FAMILY_RE = familyRe(LOCAL_CALLEE_FAMILIES);
const NETWORK_FAMILY_RE = familyRe(NETWORK_CALLEE_FAMILIES);

/** "local", "network", "neutral", or null for a name no vocabulary knows. Exact
 *  names outrank families, and network families outrank local ones. */
function classifyCallee(name) {
  if (LOCAL_CALLEES.includes(name)) return "local";
  if (NETWORK_CALLEES.includes(name)) return "network";
  if (NEUTRAL_CALLEES.includes(name) || KNOWN_GLOBALS.includes(name))
    return "neutral";
  if (NETWORK_FAMILY_RE.test(name)) return "network";
  if (LOCAL_FAMILY_RE.test(name)) return "local";
  return null;
}

/** Words that precede a `(` without calling anything. */
const NOT_CALLS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "function",
  "return",
  "typeof",
  "await",
  "async",
  "new",
  "super",
  "import",
  "void",
  "delete",
  "in",
  "of",
  "do",
  "else",
  "case",
  "throw",
  "yield",
]);

// A callee is bare (not a property of some other object) or qualified as `api.`.
const TYPE_ARGS = String.raw`<[^()<>]*(?:<[^()<>]*>[^()<>]*)*>`;
const CALL_RE = new RegExp(
  // `name!(…)` and `name?.(…)` call too: the `!` must touch the name (so `!=` and
  // `return !(…)` stay out) and `?.` must reach a `(` (so a ternary's `?.5` does).
  String.raw`(?:\bapi\.|(?<![\w$.]))([A-Za-z_$][\w$]*)(?=!?\s*(?:\?\.\s*)?(?:${TYPE_ARGS}\s*)?\()`,
  "g",
);
const INVOKE_COMMAND_RE = /^invoke\s*(?:<[^()]*?>)?\s*\(\s*(["'])([\w-]+)\1/;
const CONSTRUCTION_RE = new RegExp(
  String.raw`(?<![\w$.])(${Object.keys(WRAPPERS).join("|")})\b`,
  "g",
);

/** Index just past a type-argument list opening at the `<` at `lt`, when a call's
 *  `(` follows it; -1 otherwise (a comparison, or no call). */
function skipTypeArgs(masked, lt) {
  let angles = 0;
  let parens = 0;
  for (let i = lt; i < masked.length; i++) {
    const c = masked[i];
    if (c === "<") angles++;
    else if (c === ">" && masked[i - 1] !== "=") {
      if (--angles === 0)
        return parens === 0 && /^\s*\(/.test(masked.slice(i + 1)) ? i + 1 : -1;
    } else if (OPEN.has(c)) parens++;
    else if (CLOSE.has(c) && --parens < 0) return -1;
    else if (c === ";" && parens === 0) return -1;
  }
  return -1;
}

/** Index of the `(` opening a call whose callee name ends at `from`, skipping type
 *  arguments; -1 when no call follows. */
function callParen(masked, from) {
  let i = from;
  while (/\s/.test(masked[i] ?? "")) i++;
  if (masked[i] === "<") {
    const past = skipTypeArgs(masked, i);
    if (past === -1) return -1;
    i = past;
    while (/\s/.test(masked[i] ?? "")) i++;
  }
  return masked[i] === "(" ? i : -1;
}

/** The trimmed comma-separated parts between the bracket at `open` and its match at
 *  `close`. A type-argument list before a call is skipped, so its commas stay put;
 *  with `types` (a parameter list) every `<…>` nests. */
function splitTopLevel(masked, open, close, types = false) {
  const parts = [];
  const push = (from, to) => {
    let s = from;
    let e = to;
    while (s < e && /\s/.test(masked[s])) s++;
    while (e > s && /\s/.test(masked[e - 1])) e--;
    if (s < e) parts.push({ start: s, end: e, text: masked.slice(s, e) });
  };
  let start = open + 1;
  let depth = 0;
  for (let i = open + 1; i < close; i++) {
    const c = masked[i];
    if (OPEN.has(c) || (types && c === "<")) depth++;
    else if (CLOSE.has(c) || (types && c === ">" && masked[i - 1] !== "="))
      depth--;
    else if (c === "<" && depth === 0 && /[\w$]$/.test(masked.slice(0, i))) {
      const past = skipTypeArgs(masked, i);
      if (past !== -1) i = past - 1;
    } else if (c === "," && depth === 0) {
      push(start, i);
      start = i + 1;
    }
  }
  push(start, close);
  return parts;
}

/** Whether `part` is exactly one object literal. */
const isObjectLiteral = (masked, part) =>
  masked[part.start] === "{" && matchBrace(masked, part.start) === part.end - 1;

/** Index of the `=>` ending an arrow's parameter list at `paramsClose`, past an
 *  optional return-type annotation; -1 when none follows. */
function arrowAfter(masked, paramsClose) {
  let depth = 0;
  for (let i = paramsClose + 1; i < masked.length; i++) {
    const c = masked[i];
    if (c === "=" && masked[i + 1] === ">") {
      if (depth === 0) return i;
      i++;
    } else if (OPEN.has(c) || c === "<") depth++;
    else if (CLOSE.has(c) || c === ">") {
      if (--depth < 0) return -1;
    } else if (depth === 0 && (c === ";" || c === ",")) return -1;
  }
  return -1;
}

/** Index just past an arrow's expression body starting at `from`: the first `;` or
 *  `,` at its own depth, or the bracket that closes around it. A call's type
 *  arguments are skipped, so their commas don't end the body. */
function expressionEnd(masked, from) {
  let depth = 0;
  for (let i = from; i < masked.length; i++) {
    const c = masked[i];
    if (c === "<" && /[\w$]/.test(masked[i - 1] ?? "")) {
      const past = skipTypeArgs(masked, i);
      if (past !== -1) {
        i = past - 1;
        continue;
      }
    }
    if (OPEN.has(c)) depth++;
    else if (CLOSE.has(c) && --depth < 0) return i;
    else if (depth === 0 && (c === ";" || c === ",")) return i;
  }
  return masked.length;
}

// A constructor's parameter properties (`private saveFn: F`) lead with modifiers;
// the required whitespace after each keeps a parameter NAMED `readonly` itself.
const paramNames = (masked, open, close) =>
  splitTopLevel(masked, open, close, true).map(
    (p) =>
      /^(?:(?:public|private|protected|readonly|override)\s+)*([\w$]+)\s*[?:=]?/.exec(
        p.text,
      )?.[1] ?? null,
  );

const IDENTIFIER_RE = /[A-Za-z_$][\w$]*/g;

/** Names a destructured or rest parameter may bind (the parts `paramNames` leaves
 *  null): every identifier in each such part. Over-collects on purpose, since keys,
 *  defaults and TYPE-annotation names come along: an extra name only ever turns a
 *  site ambiguous, never hides one. */
const patternBound = (masked, open, close) =>
  new Set(
    splitTopLevel(masked, open, close, true)
      .filter((p) => !/^[\w$]/.test(p.text))
      .flatMap((p) => p.text.match(IDENTIFIER_RE) ?? []),
  );

/** Names a `const`/`let`/`var` binds to a VALUE rather than naming a function,
 *  each mapped to the positions of the declarations (their keyword) that bind it:
 *  every declarator of every declaration, walked across its depth-0 commas, except
 *  a first declarator that is a named scope's declaration; a destructuring one
 *  contributes every identifier in its pattern (over-collected, as in
 *  `patternBound`). `as const` is an assertion, not a declaration. */
function variableNames(masked, fns) {
  const named = new Set(fns.filter((f) => f.name).map((f) => f.at));
  const names = new Map();
  const add = (id, at) => names.set(id, [...(names.get(id) ?? []), at]);
  for (const m of masked.matchAll(/(?<!\bas\s+)\b(?:const|let|var)\b\s*/g)) {
    let i = m.index + m[0].length;
    for (let first = true; ; first = false) {
      while (/\s/.test(masked[i] ?? "")) i++;
      if (masked[i] === "{" || masked[i] === "[") {
        const close = matchBrace(masked, i);
        if (close === -1) break;
        for (const id of masked.slice(i, close).match(IDENTIFIER_RE) ?? [])
          add(id, m.index);
        i = close + 1;
      } else {
        const id = /^[A-Za-z_$][\w$]*/.exec(masked.slice(i, i + 200))?.[0];
        if (!id) break;
        if (!(first && named.has(m.index))) add(id, m.index);
        i += id.length;
      }
      // Past any definite-assignment `!`, annotation and initializer to the
      // comma that starts the next declarator; anything else ends the statement.
      while (/\s/.test(masked[i] ?? "")) i++;
      if (masked[i] === "!") i++;
      while (/\s/.test(masked[i] ?? "")) i++;
      if (masked[i] === ":") i = annotationStop(masked, i + 1);
      if (i !== -1 && masked[i] === "=" && masked[i + 1] !== ">")
        i = expressionEnd(masked, i + 1);
      if (i === -1 || masked[i] !== ",") break;
      i++;
    }
  }
  return names;
}

/**
 * Index of the `=` that starts a binding's initializer, walking its type annotation
 * from `from` (just past the `:`); -1 when the binding has no initializer (a `;` or
 * `,` at depth 0, or a bracket closing around the binding). Every bracket counts as
 * depth, `<` and `>` included: in masked annotation text (string and template text
 * blanked, comments gone) they can only be generic brackets, and each `=>` is
 * stepped over as a pair. So a function type's arrow, an object type's `;`, a
 * tuple's `,` and a generic default's `=` all stay inside the annotation.
 */
function annotationEnd(masked, from) {
  const stop = annotationStop(masked, from);
  return masked[stop] === "=" ? stop : -1;
}

/** Where `annotationEnd`'s walk stops: the depth-0 `=`, `;` or `,` ending the
 *  annotation, or -1 when a bracket closes around it first. */
function annotationStop(masked, from) {
  let depth = 0;
  for (let i = from; i < masked.length; i++) {
    const c = masked[i];
    if (c === "=" && masked[i + 1] === ">") i++;
    else if (depth === 0 && (c === "=" || c === ";" || c === ",")) return i;
    else if (OPEN.has(c) || c === "<") depth++;
    else if ((CLOSE.has(c) || c === ">") && --depth < 0) return -1;
  }
  return -1;
}

/** Words that precede a `(` and a `{` without opening a parameter scope. `catch`
 *  binds its parameter and a `constructor` takes parameters, so both are indexed
 *  (anonymous) like any method. */
const NOT_METHODS = new Set([...NOT_CALLS].filter((w) => w !== "catch"));

/**
 * Index of the `{` opening the body after a parameter list closing at
 * `paramsClose`, past any return-type annotation; -1 for a bodiless signature (an
 * overload, an interface or abstract member), whose first depth-0 token after the
 * type is a `;` or `,`. Brackets count as depth, `<`/`>` included (masked type text
 * holds no comparisons), and each `=>` is stepped over as a pair. A depth-0 `{`
 * right after a type-operand token (`:`, `|`, `&`, `?`, `=>`) opens an object TYPE;
 * the first `{` after anything else opens the body. An object type after a keyword
 * (`keyof { … }`, `x is { … }`) and a template-literal type's `${` still read as
 * the body: see the header.
 */
function bodyAfter(masked, paramsClose) {
  let depth = 0;
  let operand = false;
  for (let i = paramsClose + 1; i < masked.length; i++) {
    const c = masked[i];
    if (/\s/.test(c)) continue;
    if (c === "=" && masked[i + 1] === ">") {
      i++;
      if (depth === 0) operand = true;
      continue;
    }
    if (depth === 0) {
      if (c === "{" && !operand) return i;
      if (c === ";" || c === ",") return -1;
    }
    if (OPEN.has(c) || c === "<") depth++;
    else if ((CLOSE.has(c) || c === ">") && --depth < 0) return -1;
    if (depth === 0) operand = ":|&?".includes(c);
  }
  return -1;
}

/**
 * Every function scope: `function` declarations and expressions, arrows (async,
 * generic, parenthesized or single-parameter, braced or expression-bodied) and
 * object/class method shorthand. Each carries its parameter names (null for a
 * destructured or rest one; `bound` holds every name such a part may bind), its
 * body's span and its parameter list's `(` (undefined for a single-parameter
 * arrow). A scope is NAMED when it is a declaration or the whole
 * initializer of the first declarator of a `const`/`let`/`var` (type-annotated or
 * not); every other scope, a second declarator's included, has `name: null`, so a
 * parameter of it can't pose as a vocabulary callee. A bodiless signature (an
 * overload, an interface member) makes no scope.
 * Named scopes also carry `at` (their declaration) and whether they are exported
 * inline.
 */
function functionsIn(masked) {
  const fns = [];
  const exportedAt = (at) =>
    /\bexport\s+(?:default\s+)?(?:async\s+)?$/.test(
      masked.slice(Math.max(0, at - 30), at),
    );
  const bodyFrom = (from) => {
    let s = from;
    while (/\s/.test(masked[s] ?? "")) s++;
    return masked[s] === "{"
      ? [s, matchBrace(masked, s)]
      : [s - 1, expressionEnd(masked, s)];
  };
  // Where each binding's initializer starts (past any `async`), so the function
  // found there takes the binding's name.
  const bindings = new Map();
  for (const m of masked.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*/g)) {
    let i = m.index + m[0].length;
    if (masked[i] === ":") i = annotationEnd(masked, i + 1);
    else if (masked[i] !== "=" || masked[i + 1] === ">") continue;
    if (i === -1) continue;
    i++;
    while (/\s/.test(masked[i] ?? "")) i++;
    const asyncKw = /^async\b\s*/.exec(masked.slice(i, i + 16));
    if (asyncKw) i += asyncKw[0].length;
    bindings.set(i, { name: m[1], at: m.index });
  }
  const push = (start, scope) => {
    const bound = bindings.get(start);
    fns.push({
      ...scope,
      name: bound?.name ?? scope.name ?? null,
      at: bound?.at ?? scope.at ?? start,
      exported: exportedAt(bound?.at ?? scope.at ?? start),
    });
  };
  // A `function`'s own parameter list, so the arrow/method pass below never
  // re-reads it (and never runs past its body to a later arrow).
  const functionParens = new Set();
  for (const m of masked.matchAll(/\bfunction\b\s*\*?\s*([\w$]*)/g)) {
    const paren = callParen(masked, m.index + m[0].length);
    if (paren === -1) continue;
    functionParens.add(paren);
    const paramsClose = matchBrace(masked, paren);
    if (paramsClose === -1) continue;
    const bodyOpen = bodyAfter(masked, paramsClose);
    const bodyClose = bodyOpen === -1 ? -1 : matchBrace(masked, bodyOpen);
    if (bodyClose === -1) continue;
    // A declaration stands at a statement start; a named function EXPRESSION's
    // name is visible only inside itself, so an unbound one stays anonymous.
    const declaration =
      m[1] !== "" &&
      /(?:^|[;{}])\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?$/.test(
        masked.slice(Math.max(0, m.index - 40), m.index),
      );
    push(m.index, {
      name: declaration ? m[1] : null,
      at: declaration ? m.index : undefined,
      paramsOpen: paren,
      params: paramNames(masked, paren, paramsClose),
      bound: patternBound(masked, paren, paramsClose),
      bodyOpen,
      bodyClose,
    });
  }
  for (let p = masked.indexOf("("); p !== -1; p = masked.indexOf("(", p + 1)) {
    if (functionParens.has(p)) continue;
    const close = matchBrace(masked, p);
    if (close === -1) continue;
    let j = close + 1;
    while (/\s/.test(masked[j] ?? "")) j++;
    const params = paramNames(masked, p, close);
    const bound = patternBound(masked, p, close);
    // After a return type, a body `{` before any `=>` means a method: the `=>`
    // arrowAfter would reach lies in or past that body.
    const body = masked[j] === ":" ? bodyAfter(masked, close) : -1;
    const typed = masked[j] === ":" ? arrowAfter(masked, close) : -1;
    const arrow =
      masked[j] === "=" && masked[j + 1] === ">"
        ? j
        : typed !== -1 && (body === -1 || typed < body)
          ? typed
          : -1;
    if (arrow !== -1) {
      // An arrow; with type parameters it starts at their `<` (an `=>` just
      // before the `(` is a curried arrow's, not type parameters). Walking
      // backward, an `=>` inside them (a function-type constraint or default)
      // reads as `>` then `=`: both are stepped over, never counted as depth.
      let start = p;
      let k = p - 1;
      while (/\s/.test(masked[k] ?? "")) k--;
      if (masked[k] === ">" && masked[k - 1] !== "=") {
        for (let depth = 0; k >= 0; k--) {
          if (masked[k] === ">" && masked[k - 1] === "=") k--;
          else if (masked[k] === ">") depth++;
          else if (masked[k] === "<" && --depth === 0) break;
        }
        if (k >= 0) start = k;
      }
      const [bodyOpen, bodyClose] = bodyFrom(arrow + 2);
      if (bodyClose !== -1)
        push(start, { paramsOpen: p, params, bound, bodyOpen, bodyClose });
    } else if (masked[j] === ":" || masked[j] === "{") {
      // A method: its name precedes the `(`.
      const name = /([\w$]+)\s*(?:<[^()]*>)?\s*$/.exec(
        masked.slice(Math.max(0, p - 80), p),
      )?.[1];
      if (!name || NOT_METHODS.has(name)) continue;
      const bodyOpen = masked[j] === "{" ? j : body;
      const bodyClose = bodyOpen === -1 ? -1 : matchBrace(masked, bodyOpen);
      if (bodyClose !== -1)
        fns.push({
          name: null,
          paramsOpen: p,
          params,
          bound,
          bodyOpen,
          bodyClose,
        });
    }
  }
  for (const m of masked.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*=>/g)) {
    if (NOT_CALLS.has(m[1])) continue;
    const [bodyOpen, bodyClose] = bodyFrom(m.index + m[0].length);
    if (bodyClose !== -1)
      push(m.index, { params: [m[1]], bound: new Set(), bodyOpen, bodyClose });
  }
  return fns;
}

/** The innermost NAMED function whose body holds `index`, or null. */
const enclosingFn = (fns, index) =>
  fns
    .filter((f) => f.name && f.bodyOpen < index && index < f.bodyClose)
    .sort((a, b) => b.bodyOpen - a.bodyOpen)[0] ?? null;

/** Whether scope `f` binds `name` as a parameter: a positional one, or a name a
 *  destructured or rest parameter may bind. */
const bindsParam = (f, name) => f.params.includes(name) || f.bound.has(name);

/** The innermost function scope, named or not, that holds `index` and binds
 *  `name` as a parameter; null when `name` is no parameter there. */
const paramOwner = (fns, index, name) =>
  fns
    .filter(
      (f) => f.bodyOpen < index && index < f.bodyClose && bindsParam(f, name),
    )
    .sort((a, b) => b.bodyOpen - a.bodyOpen)[0] ?? null;

/** A mutationFn name owned by a parameter: resolved through its named hook when
 *  positional; refused when the owner is anonymous (its callers can't be found by
 *  name) or the name comes out of a destructured or rest parameter (a caller's
 *  object keys or spread can't be mapped to it). */
function throughParameter(ctx, owner, name, nested) {
  if (!owner.params.includes(name))
    return {
      ambiguity: `mutationFn \`${name}\` is bound by a destructured or rest parameter${owner.name ? ` of \`${owner.name}\`` : ""} — the scan can't map a caller's object keys or spread to it; pass it through a simple parameter, or EXEMPT the hook with a reason`,
    };
  if (owner.name) return passThrough(ctx, owner, name, nested);
  return {
    ambiguity: `mutationFn \`${name}\` is a parameter of an anonymous function (a callback, a parenthesized initializer, a method or constructor, or a \`catch\` clause) — its callers can't be followed; pass it through a named hook, or EXEMPT the hook with a reason`,
  };
}

/** The top-level `networkMode` verdict of the object literal `part`: "always",
 *  "other" (set, but to something else), or "none". */
function networkModeOf(ctx, part) {
  let mode = "none";
  for (const entry of splitTopLevel(ctx.masked, part.start, part.end - 1)) {
    if (!/^networkMode\s*:/.test(entry.text)) continue;
    // The value is read from the SOURCE: the mask blanks string contents.
    if (/^networkMode\s*:\s*(["'])always\1/.test(ctx.source.slice(entry.start)))
      return "always";
    mode = "other";
  }
  return mode;
}

/** Whether `f`'s body declares `name` again (a variable, or a named scope such as
 *  a closure), shadowing its parameter somewhere inside. Block scoping is ignored on
 *  purpose: a declaration anywhere in the body counts, erring toward ambiguity. */
const shadowedIn = (ctx, f, name) =>
  (ctx.variables.get(name) ?? []).some(
    (at) => f.bodyOpen < at && at < f.bodyClose,
  ) ||
  ctx.fns.some(
    (g) => g.name === name && f.bodyOpen < g.at && g.at < f.bodyClose,
  );

const shadowAmbiguity = (name, owner) => ({
  ambiguity: `mutationFn \`${name}\` is a parameter${owner.name ? ` of \`${owner.name}\`` : ""} that its body declares again — the scan can't tell which one the mutationFn reaches; rename one, or EXEMPT the hook with a reason`,
});

/** A name a `const`/`let`/`var` binds to a value: its spelling says nothing about
 *  what it holds, so it is never classified by the vocabularies. */
const aliasAmbiguity = (name) => ({
  ambiguity: `mutationFn \`${name}\` is a variable holding a value, not a named function — call the function it holds directly, or EXEMPT the hook with a reason`,
});

/**
 * Classifies the mutationFn expression `part`: `{ cls }` with cls "local",
 * "network" or "delegated" (a WRAPPERS definition passing its own parameter on), and
 * `callees`; or `{ ambiguity }` naming why it can't be read. `nested` marks a call
 * site reached through a pass-through, which may not pass through again.
 */
function classifyValue(ctx, part, nested = false) {
  const { masked, source } = ctx;
  const ref = /^(api\.)?([A-Za-z_$][\w$]*)$/.exec(part.text);
  if (ref) {
    const name = ref[2];
    const owner = ref[1] ? null : paramOwner(ctx.fns, part.start, name);
    if (owner && shadowedIn(ctx, owner, name))
      return shadowAmbiguity(name, owner);
    if (owner) return throughParameter(ctx, owner, name, nested);
    if (!ref[1] && ctx.variables.has(name)) return aliasAmbiguity(name);
    const cls = classifyCallee(name);
    if (cls === "local" || cls === "network")
      return { cls, callees: [part.text] };
    return {
      ambiguity: `mutationFn \`${part.text}\` is neither a classified callee nor a parameter of its hook — classify it in LOCAL_CALLEES or NETWORK_CALLEES`,
    };
  }
  const callees = [];
  const unknown = [];
  const value = masked.slice(part.start, part.end);
  const closures = new Set(
    ctx.fns
      .filter((f) => f.name && f.at >= part.start && f.at < part.end)
      .map((f) => f.name),
  );
  for (const c of value.matchAll(CALL_RE)) {
    const name = c[1];
    const before = value.slice(0, c.index);
    if (NOT_CALLS.has(name) || /\b(?:function|new)\s*$/.test(before)) continue;
    // Owned at the call itself, so a parameter of an arrow inside the mutationFn
    // counts as much as one of the hook around it.
    const owner = c[0].startsWith("api.")
      ? null
      : paramOwner(ctx.fns, part.start + c.index, name);
    if (owner && shadowedIn(ctx, owner, name))
      return shadowAmbiguity(name, owner);
    if (owner) {
      const v = throughParameter(ctx, owner, name, nested);
      if (v.ambiguity) return v;
      if (v.cls === "delegated") return v;
      callees.push(
        ...v.callees.map((callee) => ({ name: callee, cls: v.cls })),
      );
      continue;
    }
    // A closure the mutationFn declares, where no parameter of that name owns the
    // call, is scanned in place; any other name it declares is a value, caught
    // below as an alias.
    if (closures.has(name) && !c[0].startsWith("api.")) continue;
    if (!c[0].startsWith("api.") && ctx.variables.has(name))
      return aliasAmbiguity(name);
    if (name === "invoke") {
      const command = INVOKE_COMMAND_RE.exec(
        source.slice(part.start + c.index),
      )?.[2];
      if (command && LOCAL_COMMANDS.includes(command))
        callees.push({ name: `invoke:${command}`, cls: "local" });
      else if (command && NETWORK_COMMANDS.includes(command))
        callees.push({ name: `invoke:${command}`, cls: "network" });
      else
        unknown.push(
          command
            ? `invoke("${command}") (classify it in LOCAL_COMMANDS or NETWORK_COMMANDS)`
            : "invoke of a non-literal command",
        );
      continue;
    }
    const cls = classifyCallee(name);
    if (cls === null) unknown.push(`\`${name}\``);
    else if (cls !== "neutral") callees.push({ name: c[0], cls });
  }
  if (unknown.length > 0)
    return {
      ambiguity: `mutationFn calls ${[...new Set(unknown)].join(", ")}, in no vocabulary — classify each as LOCAL, NETWORK or NEUTRAL`,
    };
  if (callees.length === 0)
    return {
      ambiguity: `mutationFn calls nothing the vocabularies know as local or network — classify its callee, or EXEMPT the hook with a reason`,
    };
  return {
    cls: callees.some((c) => c.cls === "network") ? "network" : "local",
    callees: [...new Set(callees.map((c) => c.name))],
  };
}

/** A mutationFn that is the enclosing hook's own parameter: delegated when that hook
 *  is a WRAPPERS definition, else classified at every call of the hook in this file,
 *  all of which must agree. A hook that leaves the file (exported inline, from an
 *  export list, or through an alias) or is referenced without a call has callers this
 *  scan can't see, so it fails rather than resolving from the calls it can. It
 *  assumes the parameter is not reassigned before the use; a reassigned parameter
 *  resolves from the call site. */
function passThrough(ctx, fn, name, nested) {
  if (ctx.file === WRAPPER_HOME && Object.hasOwn(WRAPPERS, fn.name))
    return { cls: "delegated", callees: [] };
  if (nested)
    return {
      ambiguity: `mutationFn \`${name}\` passes through a second hook (\`${fn.name}\`) — this scan follows one level`,
    };
  if (fn.exported)
    return {
      ambiguity: `mutationFn \`${name}\` passes through the exported hook \`${fn.name}\` — its callers outside this file are invisible`,
    };
  const k = fn.params.indexOf(name);
  const verdicts = [];
  const re = new RegExp(String.raw`(?<![\w$.])${escapeRe(fn.name)}\b`, "g");
  for (const m of ctx.masked.matchAll(re)) {
    if (m.index === fn.at + ctx.masked.slice(fn.at).indexOf(fn.name)) continue;
    // An overload signature declares the hook again; it calls nothing.
    if (
      /\bfunction\s*\*?\s*$/.test(
        ctx.masked.slice(Math.max(0, m.index - 20), m.index),
      )
    )
      continue;
    const at = `${ctx.file}:${lineOf(ctx.source, m.index)}`;
    const paren = callParen(ctx.masked, m.index + m[0].length);
    if (paren === -1) {
      verdicts.push({
        ambiguity: `${at}: references \`${fn.name}\` without calling it (an export, an alias, or a value use), so its other callers are invisible`,
      });
      continue;
    }
    const close = matchBrace(ctx.masked, paren);
    const args = close === -1 ? [] : splitTopLevel(ctx.masked, paren, close);
    // First, so a spread that makes the list look short is named as the spread.
    if (args.slice(0, k + 1).some((a) => a.text.startsWith("..."))) {
      verdicts.push({
        ambiguity: `${at}: spreads an argument at or before position ${k + 1}, so which value lands there can't be read`,
      });
      continue;
    }
    if (args.length <= k) {
      verdicts.push({ ambiguity: `${at}: passes no argument ${k + 1}` });
      continue;
    }
    const v = classifyValue(ctx, args[k], true);
    verdicts.push(v.ambiguity ? { ambiguity: `${at}: ${v.ambiguity}` } : v);
  }
  if (verdicts.length === 0)
    return {
      ambiguity: `mutationFn \`${name}\` passes through \`${fn.name}\`, which nothing in this file calls`,
    };
  const bad = verdicts.filter((v) => v.ambiguity).map((v) => v.ambiguity);
  if (bad.length > 0)
    return {
      ambiguity: `mutationFn passes through \`${fn.name}\`, whose calls can't be read: ${bad.join("; ")}`,
    };
  const classes = new Set(verdicts.map((v) => v.cls));
  if (classes.size > 1)
    return {
      ambiguity: `mutationFn passes through \`${fn.name}\`, whose calls mix local and network writes — split the hook`,
    };
  return {
    cls: [...classes][0],
    callees: [...new Set(verdicts.flatMap((v) => v.callees))],
  };
}

/** Whether `useRepoMutation`'s own useMutation (in `source`, the WRAPPER_HOME text)
 *  threads `opts.networkMode` at the top level of its options, with no other
 *  `networkMode` entry there to override the thread. */
function threadsNetworkMode(source) {
  let masked;
  try {
    masked = maskNonCode(source, false);
  } catch (e) {
    if (e instanceof ScanError) return false;
    throw e;
  }
  const def = functionsIn(masked).find((f) => f.name === "useRepoMutation");
  if (!def || def.paramsOpen === undefined) return false;
  // The `opts` parameter must default to an empty object: a default carrying
  // `networkMode` would reach every site that passes no options, forge ones too.
  const optsParam = splitTopLevel(
    masked,
    def.paramsOpen,
    matchBrace(masked, def.paramsOpen),
    true,
  ).find((p) => /^opts\b/.test(p.text));
  if (!optsParam || !/=\s*\{\s*\}$/.test(optsParam.text)) return false;
  const body = masked.slice(def.bodyOpen, def.bodyClose);
  for (const m of body.matchAll(/(?<![\w$.])useMutation\b/g)) {
    const paren = callParen(masked, def.bodyOpen + m.index + m[0].length);
    if (paren === -1) continue;
    const [options] = splitTopLevel(masked, paren, matchBrace(masked, paren));
    if (!options || !isObjectLiteral(masked, options)) continue;
    const isThread = (entry) =>
      /^networkMode\s*:\s*opts\.networkMode$/.test(entry.text) ||
      /^\.\.\.\(\s*opts\.networkMode\s*\?\s*\{\s*networkMode\s*:\s*opts\.networkMode\s*\}\s*:\s*\{\s*\}\s*\)$/.test(
        entry.text,
      );
    const entries = splitTopLevel(masked, options.start, options.end - 1);
    const threads = entries.filter(isThread);
    const others = entries.filter(
      (entry) => !isThread(entry) && /\bnetworkMode\b/.test(entry.text),
    );
    if (threads.length > 0 && others.length === 0) return true;
  }
  return false;
}

/**
 * One file's verdict: `sites` lists every construction with its class and whether
 * it carries `networkMode: "always"`, `offenders` the local sites without it and the
 * network sites with it, and `ambiguities` the shapes the scan can't read.
 */
function scanSource(source, file) {
  const sites = [];
  const offenders = [];
  const ambiguities = [];
  let masked;
  try {
    masked = maskNonCode(source, file.endsWith(".tsx"));
  } catch (e) {
    if (!(e instanceof ScanError)) throw e;
    return {
      sites,
      offenders,
      ambiguities: [{ site: file, file, why: e.message }],
    };
  }
  // A renamed import hides a callee or a construction from the name match: `* as x`
  // of a first-party module or of react-query, `{ gitPush as push }`, or
  // `{ useMutation as useM }` from any module. Read from the SOURCE (the mask blanks
  // the module path), keeping only imports the mask shows as code.
  for (const m of source.matchAll(
    /\bimport\s+(?!type\b)([^;]*?)\s+from\s+["']([^"']+)["']/g,
  )) {
    if (masked.slice(m.index, m.index + 6) !== "import") continue;
    const [, clause, from] = m;
    const site = `${file}:${lineOf(source, m.index)}`;
    const ns = /\*\s*as\s+([\w$]+)/.exec(clause);
    if (ns && ns[1] !== "api" && /^(\.|@\/)/.test(from))
      ambiguities.push({
        site,
        file,
        why: `imports the first-party module "${from}" as namespace \`${ns[1]}\` — its calls are invisible to this scan; import the names, or use \`* as api\``,
      });
    if (ns && from === "@tanstack/react-query")
      ambiguities.push({
        site,
        file,
        why: `imports react-query as namespace \`${ns[1]}\` — \`${ns[1]}.useMutation(\` is invisible to this scan; import the names`,
      });
    for (const r of clause.matchAll(/([\w$]+)\s+as\s+([\w$]+)/g)) {
      if (r[1] !== r[2] && Object.hasOwn(WRAPPERS, r[1]))
        ambiguities.push({
          site,
          file,
          why: `renames the mutation construction \`${r[1]}\` to \`${r[2]}\` — its sites are invisible to this scan; import it under its own name`,
        });
      const cls = classifyCallee(r[1]);
      if (r[1] !== r[2] && (cls === "local" || cls === "network"))
        ambiguities.push({
          site,
          file,
          why: `renames the ${cls} callee \`${r[1]}\` to \`${r[2]}\` — import it under its own name`,
        });
    }
  }
  const fns = functionsIn(masked);
  const ctx = {
    source,
    masked,
    file,
    fns,
    variables: variableNames(masked, fns),
  };
  for (const m of masked.matchAll(CONSTRUCTION_RE)) {
    const wrapper = m[1];
    const spec = WRAPPERS[wrapper];
    // Its own declaration, or a type-level `typeof`.
    if (
      /\b(?:function|typeof)\s*$/.test(
        masked.slice(Math.max(0, m.index - 20), m.index),
      )
    )
      continue;
    const site = `${file}:${lineOf(source, m.index)}`;
    const hook = enclosingFn(ctx.fns, m.index)?.name ?? "(module scope)";
    const ambiguous = (why) => ambiguities.push({ site, file, hook, why });
    const after = m.index + m[0].length;
    const paren = callParen(masked, after);
    if (paren === -1) {
      // An import or export specifier names it without constructing anything.
      if (!/^\s*(?:[,}]|as\b)/.test(masked.slice(after)))
        ambiguous(`${wrapper} is referenced but not readably called`);
      continue;
    }
    const close = matchBrace(masked, paren);
    if (close === -1) {
      ambiguous(`${wrapper}( has no balanced argument list`);
      continue;
    }
    const args = splitTopLevel(masked, paren, close);
    if (args.length < spec.arity[0] || args.length > spec.arity[1]) {
      ambiguous(
        `${wrapper} takes ${spec.arity.join("–")} arguments here, found ${args.length}`,
      );
      continue;
    }
    let options = null;
    if (spec.optionsArg !== null && args[spec.optionsArg]) {
      options = args[spec.optionsArg];
      if (!isObjectLiteral(masked, options)) {
        ambiguous(
          `${wrapper}'s options are not an object literal — its networkMode can't be read`,
        );
        continue;
      }
    }
    let fnPart = args[spec.fnArg];
    if (spec.fnKey) {
      const entries = splitTopLevel(masked, options.start, options.end - 1);
      const key = entries.find((e) => e.text.startsWith(spec.fnKey));
      const shape = key && new RegExp(`^${spec.fnKey}(\\s*:)?`).exec(key.text);
      if (!shape || (!shape[1] && key.text !== spec.fnKey)) {
        ambiguous(
          `${wrapper}'s options carry no readable \`${spec.fnKey}\` key (absent, spread in, or a method) — spell it out`,
        );
        continue;
      }
      fnPart = shape[1]
        ? (() => {
            let s = key.start + shape[0].length;
            while (/\s/.test(masked[s])) s++;
            return { start: s, end: key.end, text: masked.slice(s, key.end) };
          })()
        : key;
    }
    const verdict = classifyValue(ctx, fnPart);
    if (verdict.ambiguity) {
      ambiguous(verdict.ambiguity);
      continue;
    }
    const mode = options ? networkModeOf(ctx, options) : "none";
    const record = {
      site,
      file,
      hook,
      wrapper,
      cls: verdict.cls,
      callees: verdict.callees,
      mode,
    };
    sites.push(record);
    if (verdict.cls === "local" && mode !== "always")
      offenders.push({
        ...record,
        why:
          spec.optionsArg === null
            ? `is a local write, but ${wrapper} can't carry networkMode — construct it with useRepoMutation or useMutation`
            : `is a local write whose options ${mode === "other" ? "set another networkMode" : "set none"} — set \`networkMode: "always"\``,
      });
    else if (verdict.cls === "network" && mode === "always")
      offenders.push({
        ...record,
        why: `reaches the network but sets \`networkMode: "always"\` — a network write keeps the default so it pauses offline`,
      });
    else if (verdict.cls === "delegated" && mode === "always")
      offenders.push({
        ...record,
        why: `defaults every ${hook} site to \`networkMode: "always"\`, forge writes included — take it per site from the caller's options`,
      });
  }
  return { sites, offenders, ambiguities };
}

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(full);
    else if (/\.tsx?$/.test(entry.name)) yield full;
  }
}

/** Splits `offenders` and `ambiguities` into what EXEMPT (`exempt`) covers and the
 *  failures left over, plus the entries that covered nothing. */
function applyExemptions(offenders, ambiguities, exempt) {
  const covers = (e, f) => e.file === f.file && e.hook === f.hook;
  const all = [...offenders, ...ambiguities];
  return {
    failures: all.filter((f) => !exempt.some((e) => covers(e, f))),
    stale: exempt.filter((e) => !all.some((f) => covers(e, f))),
  };
}

const scan = (src, file = "src/fixture.ts") => scanSource(src, file);
const verdictOf = (src, file) => {
  const r = scan(src, file);
  return {
    ...r,
    classes: r.sites.map((s) => s.cls),
    flagged: r.offenders.length,
  };
};

test("every local-family callee makes a local site, flagged until annotated", () => {
  for (const family of LOCAL_CALLEE_FAMILIES) {
    const bare = verdictOf(
      `useMutation({ mutationFn: () => ${family}Thing(r) });`,
    );
    assert.deepEqual(bare.ambiguities, [], `${family}X: ambiguous`);
    assert.deepEqual(
      bare.classes,
      ["local"],
      `the ${family}X family went inert`,
    );
    assert.equal(bare.flagged, 1, `a bare ${family}X write passed`);
    const annotated = verdictOf(
      `useMutation({ mutationFn: () => ${family}Thing(r), networkMode: "always" });`,
    );
    assert.equal(annotated.flagged, 0, `an annotated ${family}X write failed`);
  }
  for (const callee of LOCAL_CALLEES) {
    const r = verdictOf(`useMutation({ mutationFn: () => api.${callee}(r) });`);
    assert.deepEqual(
      r.classes,
      ["local"],
      `${callee} no longer counts as local`,
    );
    assert.equal(r.flagged, 1, `a bare ${callee} write passed`);
  }
  for (const command of LOCAL_COMMANDS) {
    const r = verdictOf(
      `useMutation({ mutationFn: () => invoke<X>("${command}", {}) });`,
    );
    assert.equal(r.flagged, 1, `"${command}" no longer counts as local`);
  }
});

test("every network callee makes a network site, flagged when annotated", () => {
  for (const family of NETWORK_CALLEE_FAMILIES) {
    const r = verdictOf(
      `useMutation({ mutationFn: () => ${family}Thing(r), networkMode: "always" });`,
    );
    assert.deepEqual(
      r.classes,
      ["network"],
      `the ${family}X family went inert`,
    );
    assert.equal(r.flagged, 1, `an annotated ${family}X write passed`);
    const bare = verdictOf(
      `useMutation({ mutationFn: () => ${family}Thing(r) });`,
    );
    assert.equal(bare.flagged, 0, `a bare ${family}X write failed`);
    // A network family outranks a local one sharing the word.
    const shadow = verdictOf(
      `useMutation({ mutationFn: () => ${family}SetThing(r) });`,
    );
    assert.deepEqual(
      shadow.classes,
      ["network"],
      `${family}SetX read as local`,
    );
  }
  for (const callee of NETWORK_CALLEES) {
    const r = verdictOf(
      `useRepoMutation(repo, () => api.${callee}(repo), { networkMode: "always" });`,
    );
    assert.deepEqual(
      r.classes,
      ["network"],
      `${callee} no longer counts as network`,
    );
    assert.equal(r.flagged, 1, `an annotated ${callee} write passed`);
  }
  for (const command of NETWORK_COMMANDS) {
    const r = verdictOf(
      `useMutation({ mutationFn: () => invoke("${command}"), networkMode: "always" });`,
    );
    assert.equal(r.flagged, 1, `"${command}" no longer counts as network`);
  }
  const release = verdictOf(
    'useMutation({ mutationFn: () => api.ghReleaseCreate(r), networkMode: "always" });',
  );
  assert.deepEqual(release.classes, ["network"], "ghReleaseX read as local");
  const mixed = verdictOf(
    'useMutation({ mutationFn: async () => { await saveThing(r); await api.gitPush(r); }, networkMode: "always" });',
  );
  assert.deepEqual(
    mixed.classes,
    ["network"],
    "one network callee left a site local",
  );
  assert.equal(mixed.flagged, 1, "a mixed site carrying always passed");
  // A non-null-asserted call is a call.
  const asserted = verdictOf(
    'useMutation({ mutationFn: async () => { saveThing(r); api.gitPush!(r); }, networkMode: "always" });',
  );
  assert.deepEqual(asserted.classes, ["network"], "`api.gitPush!(…)` unseen");
  assert.equal(
    asserted.flagged,
    1,
    "an asserted network call carrying always passed",
  );
});

test("neutral callees neither make nor break a site", () => {
  // Globals first: `setTimeout` fits the `set` family but writes nothing.
  for (const callee of [...KNOWN_GLOBALS, ...NEUTRAL_CALLEES]) {
    const alone = verdictOf(`useMutation({ mutationFn: () => ${callee}(r) });`);
    assert.notDeepEqual(
      alone.ambiguities,
      [],
      `${callee} alone read as a write`,
    );
    const withLocal = verdictOf(
      `useMutation({ mutationFn: () => ${callee}(r, () => saveThing(r)) });`,
    );
    assert.deepEqual(
      withLocal.classes,
      ["local"],
      `${callee} changed a site's class`,
    );
  }
});

test("each wrapper form finds its mutationFn and options", () => {
  const cases = {
    "options key": [
      "useMutation({ mutationFn: (a) => api.gitStage(r, a) });",
      'useMutation({ mutationFn: (a) => api.gitStage(r, a), networkMode: "always" });',
    ],
    positional: [
      "useRepoMutation(repo, (p: string[]) => api.gitStage(repo, p));",
      'useRepoMutation(repo, (p: string[]) => api.gitStage(repo, p), {\n  invalidate: k,\n  // Local git write — never park it offline.\n  networkMode: "always",\n});',
    ],
    "positional, generic": [
      "useRepoMutation<void, Outcome<A, B>>(repo, async () => api.gitCommit(repo));",
      'useRepoMutation<void, Outcome<A, B>>(repo, async () => api.gitCommit(repo), { networkMode: "always" });',
    ],
    shorthand: [
      "function useW<A>(repo: string, mutationFn: (a: A) => Promise<void>) {\n  return useMutation({ mutationFn });\n}\nexport function useX(r) { return useW(r, (a) => saveThing(a)); }",
      'function useW<A>(repo: string, mutationFn: (a: A) => Promise<void>) {\n  return useMutation({ mutationFn, networkMode: "always" });\n}\nexport function useX(r) { return useW(r, (a) => saveThing(a)); }',
    ],
    "passed through by name": [
      'function useW<A>(repo: string, op: Extract<Op, "a" | "b">, fn: (a: A) => Promise<void>) {\n  return useMutation({ mutationKey: [op], mutationFn: fn });\n}\nexport const useX = () => useW(r, "a", createLocalThing);\nexport const useY = () => useW(r, "b", api.deleteLocalThing);',
      'function useW<A>(repo: string, op: Extract<Op, "a" | "b">, fn: (a: A) => Promise<void>) {\n  return useMutation({ mutationKey: [op], mutationFn: fn, networkMode: "always" });\n}\nexport const useX = () => useW(r, "a", createLocalThing);\nexport const useY = () => useW(r, "b", api.deleteLocalThing);',
    ],
    "passed through as a call": [
      "function useW<A>(repo: string, mutationFn: (a: A) => Promise<void>) {\n  return useRepoMutation(repo, (a: A) => mutationFn(a));\n}\nexport function useX(r) { return useW(r, (a) => api.gitStage(r, a)); }",
      'function useW<A>(repo: string, mutationFn: (a: A) => Promise<void>) {\n  return useRepoMutation(repo, (a: A) => mutationFn(a), { networkMode: "always" });\n}\nexport function useX(r) { return useW(r, (a) => api.gitStage(r, a)); }',
    ],
  };
  for (const [name, [bare, annotated]] of Object.entries(cases)) {
    const b = verdictOf(bare);
    assert.deepEqual(
      b.ambiguities,
      [],
      `${name}: the bare form was unreadable`,
    );
    assert.deepEqual(
      b.classes,
      ["local"],
      `${name}: the site was not found as local`,
    );
    assert.equal(b.flagged, 1, `${name}: a bare local write passed`);
    const a = verdictOf(annotated);
    assert.deepEqual(
      a.ambiguities,
      [],
      `${name}: the annotated form was unreadable`,
    );
    assert.equal(a.flagged, 0, `${name}: an annotated local write failed`);
  }
  // The optimistic wrapper has no options to carry networkMode, so a local write
  // through it can only fail; a forge one passes.
  const optimisticLocal = verdictOf(
    "useOptimisticCacheMutation((a) => saveThing(a), keyFor, patch, reconcile);",
  );
  assert.equal(optimisticLocal.flagged, 1, "a local optimistic write passed");
  const optimisticForge = verdictOf(
    "useOptimisticCacheMutation<A, B, C>(\n  (a) => api.forgeThing(a),\n  keyFor,\n  patch,\n  reconcile,\n);",
  );
  assert.deepEqual(optimisticForge.classes, ["network"]);
  assert.equal(optimisticForge.flagged, 0, "a forge optimistic write failed");
  // A WRAPPERS definition passing its own parameter on is delegated to its callers.
  const home = verdictOf(
    "export function useRepoMutation<A, D>(repo: string, mutationFn: (a: A) => Promise<D>, opts: O = {}) {\n  return useMutation({\n    mutationFn,\n    ...(opts.networkMode ? { networkMode: opts.networkMode } : {}),\n  });\n}",
    "src/lib/git/queries/internal.ts",
  );
  assert.deepEqual(home.ambiguities, []);
  assert.deepEqual(
    home.classes,
    ["delegated"],
    "the wrapper's own useMutation was classified",
  );
  assert.equal(home.flagged, 0, "a threading wrapper was flagged");
  // ...but may not default its sites to "always": forge writes ride it too.
  const defaulted = verdictOf(
    'export function useRepoMutation<A, D>(repo: string, mutationFn: (a: A) => Promise<D>, opts: O = {}) {\n  return useMutation({\n    mutationFn,\n    networkMode: "always",\n  });\n}',
    "src/lib/git/queries/internal.ts",
  );
  assert.equal(defaulted.flagged, 1, "a wrapper-wide always default passed");
});

test("an arrow-bound wrapper resolves at its callers, never by its parameter's name", () => {
  // `saveFn` fits the `save` family; only its callers say what it writes.
  const forms = {
    "expression-bodied arrow":
      "const useW = (repo, saveFn) => useMutation({ mutationFn: saveFn });\nexport const useP = () => useW(r, api.gitPush);",
    "async, generic, typed, braced arrow":
      "const useW = async <A,>(repo: string, saveFn: (a: A) => Promise<void>): Promise<X> => {\n  return useMutation({ mutationFn: saveFn });\n};\nuseW(r, api.gitPush);",
    "function expression":
      "const useW = function (repo, saveFn) { return useMutation({ mutationFn: saveFn }); };\nuseW(r, api.gitPush);",
    "single-parameter arrow":
      "let useW = saveFn => useMutation({ mutationFn: saveFn });\nuseW(api.gitPush);",
    "call form inside an arrow":
      "const useW = (repo, saveFn) => useRepoMutation(repo, (a) => saveFn(a));\nuseW(r, api.gitPush);",
    "type arguments in an expression body":
      'const useW = (repo, saveFn) => useMutation<void, Error, string>({ mutationFn: saveFn, networkMode: "always" });\nuseW(r, api.gitPush);',
    "wrapper type arguments in an expression body":
      'const useW = (repo, saveFn) => useRepoMutation<A, B>(repo, saveFn, { networkMode: "always" });\nuseW(r, api.gitPush);',
    "function-typed binding":
      'const useW: (repo: string, saveFn: () => Promise<void>) => unknown = (repo, saveFn) => useMutation({ mutationFn: saveFn, networkMode: "always" });\nuseW(r, api.gitPush);',
    "object-typed parameter in a function-typed binding":
      "const useW: (repo: string, saveFn: (a: { x: string; y: number }) => Promise<void>) => unknown = (repo, saveFn) => useMutation({ mutationFn: saveFn });\nuseW(r, api.gitPush);",
    "generic default in a function-typed binding":
      "const useW: <T = string>(repo: string, saveFn: (a: T) => Promise<void>) => unknown = (repo, saveFn) => useMutation({ mutationFn: saveFn });\nuseW(r, api.gitPush);",
    "a function-type constraint in the arrow's type parameters":
      "const useW = <T extends () => void>(repo, saveFn) => useMutation({ mutationFn: saveFn });\nuseW(r, api.gitPush);",
    "a function-type default in the arrow's type parameters":
      "const useW = <T = () => void>(repo, saveFn) => useMutation({ mutationFn: saveFn });\nuseW(r, api.gitPush);",
    // The body is the first `{` after the return type, not the type's own braces.
    "an object-type return annotation":
      'function useW(repo: string, saveFn: () => Promise<void>): { mutate: () => void } { return useMutation({ mutationFn: saveFn, networkMode: "always" }); }\nuseW(r, api.gitPush);',
    "an object type inside a generic return annotation":
      'function useW(repo: string, saveFn: () => Promise<void>): Promise<{ ok: boolean }> { return useMutation({ mutationFn: saveFn, networkMode: "always" }); }\nuseW(r, api.gitPush);',
    "an overload signature before the hook":
      "function useW(repo: string, saveFn: F): R;\nfunction useW(repo, saveFn) { return useMutation({ mutationFn: saveFn }); }\nuseW(r, api.gitPush);",
    "an interface member signature before the hook":
      "interface X { save(saveFn: string): void; }\nfunction useW(repo, saveFn) { return useMutation({ mutationFn: saveFn }); }\nuseW(r, api.gitPush);",
    "a typed declaration before an arrow wrapper":
      "function useA(fn: X): Y { return fn; }\nconst useW = (repo, fn) => useMutation({ mutationFn: fn });\nuseW(r, api.gitPush);",
    "an optional call of the parameter":
      "function useW(repo, saveFn) { return useMutation({ mutationFn: async () => { await saveFn?.(r); } }); }\nuseW(r, api.gitPush);",
  };
  // Every annotation shape must walk to its initializer's `=`.
  for (const type of [
    "((repo: string, saveFn: () => void) => unknown) | null",
    "Hook<Map<string, Set<number>>>",
    "[repo: string, saveFn: () => void] extends never ? A : Hook",
    "`use-${string}` | Hook",
    "'a=b' | \"c;d\" | Hook",
    "{ run?: () => void; [k: string]: unknown } & Hook",
    "readonly Hook[] | typeof api.gitPush | keyof typeof table",
  ])
    forms[`annotated \`${type}\``] =
      `const useW: ${type} = (repo, saveFn) => useMutation({ mutationFn: saveFn });\nuseW(r, api.gitPush);`;
  for (const [name, src] of Object.entries(forms)) {
    const r = verdictOf(src);
    assert.deepEqual(r.ambiguities, [], `${name}: ambiguous`);
    assert.deepEqual(
      r.classes,
      ["network"],
      `${name}: classified by the parameter's name`,
    );
    assert.deepEqual(
      r.sites[0].callees,
      ["api.gitPush"],
      `${name}: its callers were not read`,
    );
  }
});

test('a networkMode counts only as a literal "always" at the options\' top level', () => {
  const cases = {
    "another value":
      'useMutation({ mutationFn: () => saveThing(r), networkMode: "online" });',
    "a variable":
      "useMutation({ mutationFn: () => saveThing(r), networkMode: mode });",
    "inside the mutationFn":
      'useMutation({ mutationFn: async () => { c.fetchQuery({ queryKey: k, queryFn: f, networkMode: "always" }); await saveThing(r); } });',
    "inside another option":
      'useRepoMutation(repo, () => api.gitStage(repo), { meta: { networkMode: "always" } });',
    "only in a comment":
      'useMutation({ mutationFn: () => saveThing(r), /* networkMode: "always" */ });',
    "only in a string":
      "useMutation({ mutationFn: () => saveThing(r), meta: 'networkMode: \"always\"' });",
  };
  for (const [name, src] of Object.entries(cases)) {
    const r = verdictOf(src);
    assert.deepEqual(r.ambiguities, [], `${name}: ambiguous`);
    assert.equal(r.flagged, 1, `${name}: satisfied the guard`);
  }
  const passes = {
    "as const":
      'useMutation({ mutationFn: () => saveThing(r), networkMode: "always" as const });',
    "single quotes":
      "useMutation({ mutationFn: () => saveThing(r), networkMode: 'always' });",
  };
  for (const [name, src] of Object.entries(passes))
    assert.equal(verdictOf(src).flagged, 0, `${name}: flagged`);
});

test("useRepoMutation must thread opts.networkMode into its useMutation", () => {
  const wrapper = (options, init = "{}") =>
    `export function useRepoMutation<A, D>(repo: string, mutationFn: (a: A) => Promise<D>, opts: { networkMode?: "always" } = ${init}) {\n  const queryClient = useQueryClient();\n  return useMutation({\n    mutationFn,\n${options}\n  });\n}\n`;
  assert.equal(
    threadsNetworkMode(
      wrapper(
        "    ...(opts.networkMode ? { networkMode: opts.networkMode } : {}),",
      ),
    ),
    true,
    "the conditional spread wasn't recognized",
  );
  assert.equal(
    threadsNetworkMode(wrapper("    networkMode: opts.networkMode,")),
    true,
    "the plain key wasn't recognized",
  );
  const misses = {
    "no threading": wrapper("    onSettled: () => {},"),
    "a constant instead": wrapper('    networkMode: "always",'),
    "nested, not top level": wrapper(
      "    meta: { networkMode: opts.networkMode },",
    ),
    "only in a comment": wrapper("    // networkMode: opts.networkMode,"),
    "threaded, then overridden": wrapper(
      '    ...(opts.networkMode ? { networkMode: opts.networkMode } : {}),\n    networkMode: "online",',
    ),
    "defaulted through the parameter": wrapper(
      "    ...(opts.networkMode ? { networkMode: opts.networkMode } : {}),",
      '{ networkMode: "always" }',
    ),
    "a parameter with no default": wrapper(
      "    ...(opts.networkMode ? { networkMode: opts.networkMode } : {}),",
    ).replace(" = {}) {", ") {"),
    "no wrapper at all":
      "export function useOtherMutation(opts) { return useMutation({ networkMode: opts.networkMode }); }",
  };
  for (const [name, src] of Object.entries(misses))
    assert.equal(threadsNetworkMode(src), false, `${name}: read as threading`);
});

test("shapes the scan can't read fail closed", () => {
  const cases = {
    "a callee in no vocabulary":
      "useMutation({ mutationFn: () => frobnicate(r) });",
    "an unknown callee beside a known one":
      'useMutation({ mutationFn: () => frobnicate(saveThing(r)), networkMode: "always" });',
    "no callee at all": "useMutation({ mutationFn: async () => {} });",
    "neutral callees only":
      "useMutation({ mutationFn: () => literalPathspec(p) });",
    "an unclassified invoke":
      'useMutation({ mutationFn: () => invoke("brand_new_cmd") });',
    "a non-literal invoke": "useMutation({ mutationFn: () => invoke(cmd) });",
    "an unclassified invoke beside a known callee":
      'useMutation({ mutationFn: async () => { await invoke("brand_new_cmd"); await saveThing(r); }, networkMode: "always" });',
    "options not a literal": "useMutation(options);",
    "wrapper options not a literal":
      "useRepoMutation(repo, () => api.gitStage(repo), opts);",
    "too many arguments":
      "useRepoMutation(repo, () => api.gitStage(repo), {}, extra);",
    "no mutationFn key": "useMutation({ ...shared, onSettled });",
    "mutationFn as a method":
      "useMutation({ mutationFn(a) { return saveThing(a); } });",
    "shorthand of a non-parameter":
      "const mutationFn = () => saveThing(r);\nuseMutation({ mutationFn });",
    "a bare reference in no vocabulary":
      "useMutation({ mutationFn: frobnicate });",
    "a pass-through nobody calls":
      "function useW(repo, fn) { return useMutation({ mutationFn: fn }); }",
    "a pass-through through an exported hook":
      "export function useW(repo, fn) { return useMutation({ mutationFn: fn }); }\nuseW(r, saveThing);",
    "a pass-through mixing local and network callers":
      "function useW(repo, fn) { return useMutation({ mutationFn: fn }); }\nuseW(r, saveThing);\nuseW(r, api.gitPush);",
    "a pass-through twice over":
      "function useW(repo, fn) { return useMutation({ mutationFn: fn }); }\nfunction useV(repo, g) { return useW(repo, g); }\nuseV(r, saveThing);",
    "a pass-through hook exported from an export list":
      "function useW(repo, fn) { return useMutation({ mutationFn: fn }); }\nuseW(r, saveThing);\nexport { useW };",
    "a pass-through hook re-exported through an alias":
      "function useW(repo, fn) { return useMutation({ mutationFn: fn }); }\nuseW(r, saveThing);\nexport const useX = useW;",
    "a pass-through hook referenced without a call":
      "function useW(repo, fn) { return useMutation({ mutationFn: fn }); }\nuseW(r, saveThing);\nregistry.push(useW);",
    "an arrow pass-through mixing local and network callers":
      "const useW = (repo, saveFn) => useMutation({ mutationFn: saveFn });\nuseW(r, saveThing);\nuseW(r, api.gitPush);",
    "an exported arrow pass-through":
      "export const useW = (repo, saveFn) => useMutation({ mutationFn: saveFn });\nuseW(r, saveThing);",
    // A parameter of a function no binding names: its callers can't be found, and
    // its name (`saveFn`) must not pose as a vocabulary callee.
    "a parenthesized initializer with satisfies":
      "const useW = ((repo, saveFn) => useMutation({ mutationFn: saveFn })) satisfies Hook;\nuseW(r, api.gitPush);",
    "a callback argument":
      "const useW = useCallback((repo, saveFn) => useMutation({ mutationFn: saveFn }), []);\nuseW(r, api.gitPush);",
    "an object-property arrow":
      "const hooks = { useW: (repo, saveFn) => useMutation({ mutationFn: saveFn }) };\nhooks.useW(r, api.gitPush);",
    "a method shorthand":
      "const hooks = { useW(repo, saveFn) { return useMutation({ mutationFn: saveFn }); } };\nhooks.useW(r, api.gitPush);",
    "a class-field arrow":
      "class K { useW = (repo, saveFn) => useMutation({ mutationFn: saveFn }); }",
    "a curried arrow":
      "const useW = (repo) => (saveFn) => useMutation({ mutationFn: saveFn });\nuseW(r)(api.gitPush);",
    "a second declarator":
      "const a = 1, useW = (repo, saveFn) => useMutation({ mutationFn: saveFn });\nuseW(r, api.gitPush);",
    "a parameter of an arrow inside the mutationFn":
      "useMutation({ mutationFn: (saveFn) => saveFn() });",
    // A name bound by a destructured or rest parameter, or by a variable, says
    // nothing about the function it holds: never classified by its spelling.
    "a destructured parameter":
      'function useW({ saveFn }) { return useMutation({ mutationFn: saveFn, networkMode: "always" }); }\nuseW({ saveFn: api.gitPush });',
    "a rest parameter":
      'function useW(...saveFn) { return useMutation({ mutationFn: saveFn, networkMode: "always" }); }\nuseW(api.gitPush);',
    "a default-valued, typed destructure":
      'function useW({ saveFn }: { saveFn: () => Promise<void> } = x) { return useMutation({ mutationFn: saveFn, networkMode: "always" }); }\nuseW({ saveFn: api.gitPush });',
    "a nested, renamed pattern":
      'function useW({ a: { fn: saveFn } }) { return useMutation({ mutationFn: saveFn, networkMode: "always" }); }\nuseW({ a: { fn: api.gitPush } });',
    "an array pattern behind a rest":
      'function useW(...[saveFn]) { return useMutation({ mutationFn: saveFn, networkMode: "always" }); }\nuseW(api.gitPush);',
    "a destructured arrow wrapper, called":
      'const useW = ({ saveFn } = {}) => useMutation({ mutationFn: (a) => saveFn(a), networkMode: "always" });\nuseW({ saveFn: api.gitPush });',
    "a destructured parameter after a positional one":
      'const useW = (repo, { saveFn }) => useMutation({ mutationFn: saveFn, networkMode: "always" });\nuseW(r, { saveFn: api.gitPush });',
    "a destructured parameter after a positional one, called":
      'const useW = (repo, { saveFn }) => useMutation({ mutationFn: (a) => saveFn(a), networkMode: "always" });\nuseW(r, { saveFn: api.gitPush });',
    "a rest array pattern after a positional one":
      'const useW = (repo, ...[saveFn]) => useMutation({ mutationFn: saveFn, networkMode: "always" });\nuseW(r, api.gitPush);',
    "a method with an object-type return annotation":
      'const hooks = { useW(repo: string, saveFn: () => Promise<void>): { mutate: () => void } { return useMutation({ mutationFn: saveFn, networkMode: "always" }); } };\nhooks.useW(r, api.gitPush);',
    "a value the mutationFn declares, called":
      'useMutation({ mutationFn: async () => { const push = api.gitPush; await push(r); await saveThing(r); }, networkMode: "always" });',
    "a value in a later declarator":
      'const a = 1, saveFn = api.gitPush;\nuseMutation({ mutationFn: saveFn, networkMode: "always" });',
    "a destructured later declarator":
      'let a: number = 1, { saveFn } = opts;\nuseMutation({ mutationFn: () => saveFn(), networkMode: "always" });',
    // A parameter its own body declares again: the caller's argument may not be
    // what the mutationFn reaches (here the body pushes, the caller writes locally).
    "a parameter redeclared by a later declarator":
      'function useW(repo, saveFn) { return useMutation({ mutationFn: async () => { const a = 1, saveFn = api.gitPush; await saveFn(); }, networkMode: "always" }); }\nuseW(r, saveThing);',
    "a parameter redeclared by destructuring":
      'function useW(repo, saveFn) { return useMutation({ mutationFn: async () => { const { saveFn } = { saveFn: api.gitPush }; await saveFn(); }, networkMode: "always" }); }\nuseW(r, saveThing);',
    "a parameter redeclared by a loop variable":
      'function useW(repo, saveFn) { return useMutation({ mutationFn: async () => { for (const saveFn of [api.gitPush]) await saveFn(); }, networkMode: "always" }); }\nuseW(r, saveThing);',
    "a parameter redeclared bare and assigned later":
      'function useW(repo, saveFn) { return useMutation({ mutationFn: async () => { let saveFn; saveFn = api.gitPush; await saveFn(); }, networkMode: "always" }); }\nuseW(r, saveThing);',
    "a parameter redeclared in the hook body, referenced bare":
      'function useW(repo, saveFn) { if (repo) { const saveFn = api.gitPush; return useMutation({ mutationFn: saveFn, networkMode: "always" }); } }\nuseW(r, saveThing);',
    "a parameter redeclared as a named closure in the hook body":
      'function useW(repo, saveFn) { if (repo) { const saveFn = () => api.gitPush(); return useMutation({ mutationFn: saveFn, networkMode: "always" }); } }\nuseW(r, saveThing);',
    // A mutationFn closure never hides a parameter of the same name.
    "an inner arrow's parameter named like a mutationFn closure":
      'function useW(repo, x) { return useMutation({ mutationFn: async () => { const saveFn = () => saveThing(r); await saveFn(); await [api.gitPush].forEach((saveFn) => saveFn(r)); }, networkMode: "always" }); }\nuseW(r, 1);',
    "a parameter redeclared as a block closure in the mutationFn":
      'function useW(repo, saveFn) { return useMutation({ mutationFn: async () => { await saveFn(); if (repo) { const saveFn = () => saveThing(r); await saveFn(); } }, networkMode: "always" }); }\nuseW(r, api.gitPush);',
    "a spread at or before the pass-through's position":
      "function useW(repo, saveFn) { return useMutation({ mutationFn: saveFn }); }\nuseW(...a, saveThing);",
    // `catch` and `constructor` bind parameters like any function.
    "a catch binding":
      'useMutation({ mutationFn: async () => { try { await saveThing(r); } catch (saveFn) { await saveFn(); } }, networkMode: "always" });',
    "a constructor parameter":
      'class K { constructor(saveFn) { this.m = useMutation({ mutationFn: saveFn, networkMode: "always" }); } }\nnew K(api.gitPush);',
    "a constructor parameter property":
      'class K { constructor(private readonly saveFn: F) { this.m = useMutation({ mutationFn: saveFn, networkMode: "always" }); } }\nnew K(api.gitPush);',
    // An in-body value shadowing a hook parameter must not resolve through the
    // hook's callers (here: a local write).
    "an in-body value shadowing a parameter":
      'function useW(repo, saveFn) { return useMutation({ mutationFn: async () => { const saveFn = api.gitPush; await saveFn(); }, networkMode: "always" }); }\nuseW(r, saveThing);',
    "a local alias":
      'function useW() { const saveFn = api.gitPush; return useMutation({ mutationFn: saveFn, networkMode: "always" }); }',
    "a destructured local alias":
      'function useW(opts) { const { saveFn } = opts; return useMutation({ mutationFn: () => saveFn(), networkMode: "always" }); }',
    "a loop variable":
      'function useW(fns) { for (const saveFn of fns) useMutation({ mutationFn: saveFn, networkMode: "always" }); }',
    "an anonymous function-expression argument":
      "register(function (repo, saveFn) { return useMutation({ mutationFn: saveFn }); });",
    "a renamed construction":
      'import { useMutation as useM } from "@tanstack/react-query";',
    "a renamed wrapper from another module":
      'import { useRepoMutation as useRM } from "./internal";',
    "a react-query namespace": 'import * as RQ from "@tanstack/react-query";',
    "a renamed callee": 'import { gitStage as stage } from "@/lib/git/api";',
    "a renamed network callee":
      'import { gitPush as push } from "@/lib/git/api";',
    "a first-party namespace": 'import * as store from "@/lib/pulls/local";',
    "a construction not called": "const make = useMutation;",
    "an unterminated string":
      'useMutation({ mutationFn: () => saveThing("r) });',
  };
  for (const [name, src] of Object.entries(cases)) {
    const r = scan(src);
    assert.notDeepEqual(r.ambiguities, [], `${name}: read as unambiguous`);
  }
  // A spread that leaves the list short is named as the spread, not a gap.
  const shortSpread = scan(
    "function useW(repo, saveFn) { return useMutation({ mutationFn: saveFn }); }\nuseW(...args);",
  );
  assert.match(
    shortSpread.ambiguities.map((a) => a.why).join("\n"),
    /spreads an argument at or before position 2/,
    "a short spread was reported as a missing argument",
  );
});

test("the scan passes what it should", () => {
  const cases = {
    "an import list":
      'import { useMutation, useQuery } from "@tanstack/react-query";',
    "an api namespace": 'import * as api from "../api";',
    "a type reference": "type M = ReturnType<typeof useRepoMutation>;",
    "a forge write":
      "useMutation({ mutationFn: (a) => api.forgePrMerge(r, a) });",
    "a closure the mutationFn declares":
      "useMutation({ mutationFn: async () => { const retry = () => api.ghThing(r); return retry(); } });",
    "a method on another object":
      "useMutation({ mutationFn: () => api.forgeThing(r).then((x) => store.save(x)) });",
    "a construction in a comment": "// useMutation(options)\nconst x = 1;",
    "type arguments with a comma":
      'useMutation({ mutationFn: () => trackBoardWrite<A, B>(r, () => saveThing(r)), networkMode: "always" });',
    // A typed method's parameters must not reach a later arrow's body.
    "a typed class method before an arrow field":
      'import { saveThing } from "./x";\nclass K {\n  m(repo: string, saveThing: F): R { return saveThing; }\n  run = () => useMutation({ mutationFn: saveThing, networkMode: "always" });\n}',
  };
  for (const [name, src] of Object.entries(cases)) {
    const r = scan(src);
    assert.deepEqual(r.ambiguities, [], `${name}: ambiguous`);
    assert.deepEqual(r.offenders, [], `${name}: flagged`);
  }
});

test("EXEMPT covers its hook's failures only, and a stale entry fails", () => {
  const r = scan(
    "export function useA() { return useMutation({ mutationFn: () => saveThing(r) }); }\nexport function useB() { return useMutation({ mutationFn: () => saveOther(r) }); }",
  );
  const exempt = [
    { file: "src/fixture.ts", hook: "useA", reason: "fixture" },
    { file: "src/fixture.ts", hook: "useGone", reason: "fixture" },
  ];
  const { failures, stale } = applyExemptions(
    r.offenders,
    r.ambiguities,
    exempt,
  );
  assert.deepEqual(
    failures.map((f) => f.hook),
    ["useB"],
    "an exemption leaked past its hook, or covered nothing",
  );
  assert.deepEqual(
    stale.map((e) => e.hook),
    ["useGone"],
    "a stale exemption went unreported",
  );
  // The hook name an exemption keys on: `functionalUpdate` is no `function` keyword.
  const method = scan(
    "const o = { functionalUpdate(a) { return useMutation({ mutationFn: () => saveThing(a) }); } };",
  );
  assert.deepEqual(
    method.sites.map((s) => s.hook),
    ["(module scope)"],
    "a word starting with `function` was indexed as a declaration",
  );
});

test('every local mutation in src/ sets networkMode: "always", and no network one does', () => {
  const files = [...sourceFiles(SRC)];
  assert.ok(
    files.length >= FILE_FLOOR,
    `SCOPE PIN FAILED — found ${files.length} .ts/.tsx files under src/, below the floor ${FILE_FLOOR}; the walk went inert`,
  );
  const sites = [];
  const offenders = [];
  const ambiguities = [];
  for (const full of files) {
    const file = relative(REPO_ROOT, full).split(/[\\/]/).join("/");
    const r = scanSource(readFileSync(full, "utf8"), file);
    sites.push(...r.sites);
    offenders.push(...r.offenders);
    ambiguities.push(...r.ambiguities);
  }
  const total = sites.length + ambiguities.filter((a) => a.hook).length;
  assert.ok(
    total >= SITE_FLOOR,
    `SCOPE PIN FAILED — ${total} mutation constructions, below the floor ${SITE_FLOOR}; the construction match went inert`,
  );
  const local = sites.filter((s) => s.cls === "local");
  assert.ok(
    local.length >= LOCAL_SITE_FLOOR,
    `SCOPE PIN FAILED — ${local.length} local sites, below the floor ${LOCAL_SITE_FLOOR}; the local vocabulary went inert`,
  );
  assert.ok(
    threadsNetworkMode(readFileSync(join(REPO_ROOT, WRAPPER_HOME), "utf8")),
    `${WRAPPER_HOME}: useRepoMutation no longer threads opts.networkMode into its useMutation — every annotation at its sites is inert`,
  );
  // Look local, reach the network: review-bot validation, and the upstream fetch.
  for (const hook of ["useSetGitlabReviewToken", "useUpdateFromUpstream"]) {
    const found = sites.filter((s) => s.hook === hook);
    assert.deepEqual(
      found.map((s) => s.cls),
      ["network"],
      `${hook} is no longer classified network`,
    );
  }
  const { failures, stale } = applyExemptions(offenders, ambiguities, EXEMPT);
  assert.deepEqual(
    stale.map((e) => `${e.file}: ${e.hook}`),
    [],
    "Stale EXEMPT entries (they match no failing site — drop them)",
  );
  assert.deepEqual(
    failures.map((f) =>
      f.cls
        ? `${f.site} (${f.hook}): ${f.callees.join(", ")} ${f.why}`
        : `${f.site}: ${f.why}`,
    ),
    [],
    "Mutations whose networkMode contradicts what they write",
  );
});
