// Pins the publish hold over every push route: while a repository publish runs,
// each GUI route that can push to the repository refuses at fire time through
// `refuseWhilePublishing` (PublishPendingBanner.tsx), and the surfaces that
// render push holds render the publish hold too.
//
// Two rosters bound the routes. CALLEES: the api wrappers whose write pushes to
// a remote, each called from exactly one hook, and named-imported by no file
// outside the api package, anywhere in src/. ROUTES: every src file that names
// one of those hooks is a guarded route file or a reasoned exclusion. Each route
// handler is anchored on its function NAME only, never its parameter list; every
// write through a route file's roster binding sits inside a pinned handler, and
// each write needs a refusal after the last await before it.
//
// What it cannot see: a brand-new push IPC command or api wrapper joins CALLEES
// by review, as does a hook reached through a re-export under another name, a
// roster binding destructured or passed to another function, and a dynamic
// `import()` of the api package; a guard is counted, not proven reachable (a
// refusal behind an always-false branch passes). Forge-API writes that create
// remote refs (a linked branch, a release with a new tag, a stack create) stay
// outside the roster by design: they act through the forge's API on a forge
// repository that already exists, and push no local commits. Comments are
// blanked before matching, but .tsx JSX text can hold quote characters, so
// route files are matched with only whole-line and block comments removed.
//
// The checker is a pure function over {path -> text}, so the suite feeds it the
// real tree (must pass) and in-memory mutants (must fail) without touching disk.
// It fails closed: a roster file, hook, anchor or pinned spelling it can't find
// is a failure, never a skip.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { test } from "node:test";

const Q = "lib/git/queries/";

/** Push api callee -> the one hook (and its file, under src/) that calls it. */
const CALLEES = {
  gitPush: { hook: "usePush", file: `${Q}sync.ts` },
  forgePublishRepo: { hook: "usePublishRepo", file: `${Q}remotes.ts` },
  forgePrCreate: { hook: "useCreatePr", file: `${Q}pr-write.ts` },
  gitMergeRemotePr: { hook: "useMergeRemotePr", file: `${Q}pr-resolve.ts` },
  gitFinishRemotePrResolve: {
    hook: "useFinishRemotePrResolve",
    file: `${Q}pr-resolve.ts`,
  },
  gitPushTag: { hook: "usePushTag", file: `${Q}tags-releases.ts` },
  gitDeleteTagOnOrigin: {
    hook: "useDeleteTagOnOrigin",
    file: `${Q}tags-releases.ts`,
  },
  gitDeleteRemoteBranch: {
    hook: "useDeleteRemoteBranch",
    file: `${Q}branches.ts`,
  },
};

const HOOKS = Object.values(CALLEES).map((c) => c.hook);
const HOOK_FILES = new Set(Object.values(CALLEES).map((c) => c.file));

const R = "features/repository/";

/** Route files -> exactly the roster hooks each names. */
const ROUTES = {
  [`${R}BranchSwitcher.tsx`]: ["useDeleteRemoteBranch", "usePush"],
  [`${R}SyncControls.tsx`]: ["usePush"],
  [`${R}ForkPrPublishGuard.tsx`]: ["usePush"],
  "features/pulls/CreatePrDialog.tsx": ["useCreatePr"],
  "features/pulls/PromoteLocalPrDialog.tsx": ["useCreatePr"],
  "features/tags/TagDetailView.tsx": ["useDeleteTagOnOrigin", "usePushTag"],
  "features/history/HistoryPanel.tsx": ["usePushTag"],
  "features/history/HistoryDialogs.tsx": ["useDeleteTagOnOrigin"],
};

/** Files that name a roster hook but carry no publish refusal, with why. */
const EXCLUDED = {
  "features/pulls/RemotePrView.tsx": {
    hooks: ["useMergeRemotePr"],
    reason:
      "merges an existing remote pull request, its background fetch included, and a repository being published has no remote yet",
  },
  "features/pulls/ResolveRemotePrView.tsx": {
    hooks: ["useFinishRemotePrResolve"],
    reason:
      "renders only inside RemotePrView.tsx (pinned below) and finishes a conflict resolve on an existing remote pull request; a repository being published has no remote yet",
  },
  [`${R}PublishDialog.tsx`]: {
    hooks: ["usePublishRepo"],
    reason:
      "it is the publish; its own fire-time twin (isPublishActive) refuses a second one, pinned in HANDLERS",
  },
};

const REFUSE = "refuseWhilePublishing(";

/** Each route handler: its file, a name-prefix anchor, an optional top-level unit
 *  it sits in (for names a file reuses), the refusal count its body needs, and
 *  spellings its whitespace-normalized body must contain. */
const HANDLERS = [
  { file: `${R}BranchSwitcher.tsx`, name: "doPushBranch", refusals: 1 },
  { file: `${R}BranchSwitcher.tsx`, name: "beginPublishBranch", refusals: 1 },
  { file: `${R}BranchSwitcher.tsx`, name: "runPushBranch", refusals: 1 },
  { file: `${R}BranchSwitcher.tsx`, name: "doDeleteRemoteBranch", refusals: 1 },
  {
    file: `${R}BranchSwitcher.tsx`,
    prop: "onPublishAnyway",
    refusals: 1,
    // Refused before the dialog closes, so it stays open to retry from.
    order: ["refuseWhilePublishing(", "setForkGuard(null)"],
  },
  { file: `${R}SyncControls.tsx`, name: "doPush", refusals: 1 },
  { file: `${R}SyncControls.tsx`, name: "beginPush", refusals: 1 },
  { file: `${R}SyncControls.tsx`, name: "beginBarePush", refusals: 2 },
  { file: `${R}SyncControls.tsx`, name: "pushFromMenu", refusals: 2 },
  {
    file: `${R}SyncControls.tsx`,
    prop: "onPublishAnyway",
    refusals: 1,
    order: ["refuseWhilePublishing(", "closeForkGuard("],
  },
  { file: `${R}ForkPrPublishGuard.tsx`, name: "pushToFork", refusals: 2 },
  {
    file: "features/pulls/CreatePrDialog.tsx",
    member: "onSubmit",
    refusals: 1,
    // Ahead of the lane claim, so a refusal owns nothing.
    order: ["refuseWhilePublishing(", "startPrCreate("],
  },
  {
    file: "features/pulls/PromoteLocalPrDialog.tsx",
    name: "promote",
    refusals: 2,
    order: ["refuseWhilePublishing(", "startPrCreate("],
    needs: [
      "if (refuseWhilePublishing(queryClient, repoPath)) {try {await reopenLocal(closedAt, prior);} catch (e) {toastError(e);} return;}",
    ],
  },
  { file: "features/tags/TagDetailView.tsx", name: "onPushTag", refusals: 1 },
  {
    file: "features/tags/TagDetailView.tsx",
    name: "onDeleteTag",
    refusals: 1,
    needs: ["deleteTagRemote && refuseWhilePublishing("],
  },
  {
    file: "features/history/HistoryPanel.tsx",
    name: "pushTagToOrigin",
    refusals: 1,
  },
  {
    file: "features/history/HistoryDialogs.tsx",
    within: "DeleteTagDialog",
    name: "run",
    refusals: 1,
    needs: ["remote && refuseWhilePublishing("],
  },
  {
    file: `${R}PublishDialog.tsx`,
    member: "onSubmit",
    refusals: 0,
    needs: [
      "if (isPublishActive(queryClient, repoPath, identity.data)) return;",
      "if (identityLoading) return;",
    ],
    order: ["isPublishActive(", ".mutateAsync("],
  },
];

/** Render holds: spellings each file's whitespace-normalized text must hold, and
 *  spellings it must not. */
const RENDER_PINS = {
  [`${R}BranchSwitcher.tsx`]: {
    need: [
      "const publishActive = usePendingPublishes(repoPath).length > 0;",
      // The publish arm comes first, ahead of the push arms.
      "const pushItemSuffix = (() => {switch (true) {case publishActive: return ` (${PUBLISH_HOLD_ITEM_REASON})`; case rowPushing:",
      "const pushItemDisabled = rowPushing || rowUpdating || pushActive || busy || !!offlineHold || publishActive;",
      "disabled={deletionBlocked || pushActive || !!offlineHold || publishActive}",
      // After the protected arm, before the push arm.
      "case deletionBlocked: return `Delete on ${branch.remote}… (protected)`; case publishActive: return `Delete on ${branch.remote}… (${PUBLISH_HOLD_ITEM_REASON})`; case pushActive:",
      // The push arm first, then the publish arm, then offline.
      "heldReason={(() => {switch (true) {case pushActive: return branchPushHoldReason(pushPaused); case publishActive: return PUBLISH_HOLD_REASON; default: return offlineHold;",
    ],
    stale: [],
  },
  [`${R}PublishRepoControl.tsx`]: {
    need: [
      // Held while the identity loads; an identity error is settled, never held.
      "const identityHold = identity.data === undefined && !identity.isError ? publishPendingReason(offlineHold) : undefined;",
      "disabled={!!busyReason || !!identityHold}",
      "disabled={!soleTarget || !!busyReason || !!identityHold}",
      "reason={busyReason ?? (soleTarget ? identityHold : disabledTitle)}",
    ],
    stale: [/(?<!!)identity\.isError\s*[?&|)]/],
  },
  [`${R}PublishDialog.tsx`]: {
    need: [
      "const identityLoading = identity.data === undefined && !identity.isError;",
    ],
    stale: [],
    // The submit's own disable carries the loading arm.
    pattern: [/const submitBlocked = [^;]*\bidentityLoading;/],
  },
  [`${Q}remotes.ts`]: {
    need: [
      "identity: publishRepoKey(repo, identity),",
      // Sibling worktrees by identity; an identity this session never learned,
      // or the raw-path fallback, on either side, counts as a sibling.
      "const siblingRemotes = siblingRemotesOf(repo, identity);",
      'if (root !== "repo" || path === repo || kind !== "remotes") return false;',
      "const own = identity ?? peekRepoIdentity(repo);",
      'if (own === undefined || own === repo || typeof path !== "string") return true;',
      "const theirs = peekRepoIdentity(path);",
      "return theirs === undefined || theirs === path || theirs === own;",
    ],
    stale: [],
    // The sibling worktrees' remotes re-read runs on either outcome of the
    // publish call itself (its own try), never of some other step.
    pattern: [
      /try \{return await api\.forgePublishRepo\([^)]*\);\} finally \{void queryClient\.invalidateQueries\(\{predicate: siblingRemotes\}\);\}/,
    ],
  },
};

/** The one host ResolveRemotePrView's exclusion rests on. */
const RESOLVE_HOST = {
  tag: "<ResolveRemotePrView",
  file: "features/pulls/RemotePrView.tsx",
};

/** `text` with every comment blanked (newlines kept, so line anchors hold). Strings
 *  and template literals are skipped whole, and a backslash outside them (a regex
 *  literal's escape) takes its next character along, so `\//` opens no comment. */
function stripComments(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "\\") {
      out += text.slice(i, i + 2);
      i += 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** The .tsx-safe blanking: whole-line `//` comments and block comments (JSX's
 *  `{/* … *\/}` included) only, since JSX text can hold unpaired quotes. */
function stripLineComments(text) {
  return text
    .replace(/(^[ \t]*|\{)(\/\*[\s\S]*?\*\/)/gm, (_, lead, c) =>
      lead.concat(c.replace(/[^\n]/g, " ")),
    )
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

const blank = (path, text) =>
  path.endsWith(".tsx") ? stripLineComments(text) : stripComments(text);

/** Whitespace collapsed and dropped inside bracket edges, so a biome rewrap of a
 *  guard chain or a ternary reads as one line. */
const norm = (text) =>
  text
    .replace(/\s+/g, " ")
    .replace(/([([{]) /g, "$1")
    .replace(/ ([)\]}])/g, "$1");

const DECLARATION =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?\s+(\w+)|(?:const|let|var)\s+(\w+))/;

/** Every top-level function and const/let binding of `text`, name -> its text. A
 *  unit runs from its column-0 declaration line to the next column-0 line that
 *  starts any other statement; closing brackets stay with the unit they close. */
function topLevelUnits(text) {
  const units = new Map();
  let current = null;
  const flush = () => {
    if (current) units.set(current.name, current.lines.join("\n"));
  };
  for (const line of text.split("\n")) {
    const startsStatement = /^[^\s)\]}]/.test(line);
    if (startsStatement) {
      flush();
      const m = DECLARATION.exec(line);
      current = m ? { name: m[1] ?? m[2], lines: [line] } : null;
    } else if (current) current.lines.push(line);
  }
  flush();
  return units;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The anchor regex of a handler: its function name (plain or `async`), or a
 *  JSX prop / object member that opens a callback. Never its parameters. */
function anchorOf(h) {
  if (h.name)
    return new RegExp(
      `^([ \\t]*)(?:async\\s+)?function\\s+${escapeRe(h.name)}\\(`,
      "gm",
    );
  if (h.member) return new RegExp(`^([ \\t]*)${escapeRe(h.member)}:`, "gm");
  return new RegExp(`^([ \\t]*)${escapeRe(h.prop)}=\\{`, "gm");
}

const label = (h) =>
  `${h.file} ${h.within ? `${h.within} > ` : ""}${h.name ?? h.prop ?? h.member}`;

/** The handler's body: from its unique anchor to the first later line, at or
 *  left of the anchor's indent, that holds only closing brackets. Returns an
 *  error string instead when the anchor is missing, repeated or unclosed. */
function handlerBody(text, h) {
  let scope = text;
  if (h.within) {
    scope = topLevelUnits(text).get(h.within);
    if (scope === undefined) return `${label(h)}: unit ${h.within} not found`;
  }
  const hits = [...scope.matchAll(anchorOf(h))];
  if (hits.length !== 1)
    return `${label(h)}: anchor found ${hits.length} times (needs exactly 1)`;
  const indent = hits[0][1].length;
  const lines = scope.slice(hits[0].index).split("\n");
  for (let i = 1; i < lines.length; i++) {
    const m = /^([ \t]*)[)\]}]+[;,]?\s*$/.exec(lines[i]);
    if (m && m[1].length <= indent) return lines.slice(0, i + 1).join("\n");
  }
  return `${label(h)}: body never closes`;
}

/** The api package (src-relative); its own files define the callees. */
const API_DIR = "lib/git/api/";

/** Every static import or re-export of `text` whose specifier resolves into the
 *  api package: the namespace or default alias it binds, the names it imports,
 *  and whether it re-exports the package wholesale. */
function apiImports(path, text) {
  const found = [];
  const re =
    /\b(?:import\s+(?:type\s+)?([^;"'`]*?)|export\s+((?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})))\s+from\s+["']([^"']+)["']/g;
  for (const [, importClause, exportClause, spec] of text.matchAll(re)) {
    let rel;
    if (spec.startsWith("@/")) rel = spec.slice(2);
    else if (spec.startsWith(".")) rel = posix.join(posix.dirname(path), spec);
    else continue;
    rel = rel.replace(/\.tsx?$/, "");
    if (rel !== API_DIR.slice(0, -1) && !rel.startsWith(API_DIR)) continue;
    const clause = (importClause ?? exportClause).trim();
    const braces = /\{([^}]*)\}/.exec(clause);
    const named = braces
      ? braces[1]
          .split(",")
          .map(
            (s) =>
              s
                .trim()
                .replace(/^type\s+/, "")
                .split(/\s+as\s+/)[0],
          )
          .filter(Boolean)
      : [];
    const head = clause
      .replace(/\{[^}]*\}/, "")
      .replace(/,\s*$/, "")
      .trim();
    const ns = /^\*\s+as\s+(\w+)$/.exec(head);
    found.push({
      alias:
        importClause && ns
          ? ns[1]
          : importClause && /^\w+$/.test(head)
            ? head
            : null,
      named,
      star: exportClause !== undefined && head.startsWith("*"),
    });
  }
  return found;
}

/** The index of the bracket closing the one at `at`, or -1. */
function matchBracket(text, at) {
  const close = { "(": ")", "{": "}", "[": "]" }[text[at]];
  let depth = 0;
  for (let i = at; i < text.length; i++) {
    if (text[i] === text[at]) depth++;
    else if (text[i] === close && --depth === 0) return i;
  }
  return -1;
}

/** `body` with the block of every `if (… refuseWhilePublishing( …) {` blanked:
 *  that path returns, so an await inside it precedes no write. */
function blankRefusalBlocks(body) {
  let out = body;
  for (const m of body.matchAll(/\bif\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const close = matchBracket(body, open);
    if (close < 0 || !body.slice(open, close).includes(REFUSE)) continue;
    const brace = /^\s*\{/.exec(body.slice(close + 1));
    if (!brace) continue;
    const start = close + brace[0].length;
    const end = matchBracket(body, start);
    if (end < 0) continue;
    out =
      out.slice(0, start + 1) +
      out.slice(start + 1, end).replace(/[^\n]/g, " ") +
      out.slice(end);
  }
  return out;
}

/** Each `.mutateAsync(` of a refusing handler needs a refusal after the last
 *  await before it (any refusal before it, when no await precedes). */
function writeOrderProblems(body) {
  const scan = blankRefusalBlocks(body);
  const problems = [];
  let k = 0;
  for (const w of scan.matchAll(/\.mutateAsync\(/g)) {
    k++;
    const before = scan.slice(0, w.index);
    // The write's own `await <receiver>` precedes nothing, a parenthesized
    // receiver choice included.
    const own = /\bawait\s+(?:[\w.]*|\([^()]*\))$/.exec(before);
    const head = own ? before.slice(0, own.index) : before;
    const awaits = [...head.matchAll(/\bawait\b/g)];
    const lastAwait = awaits.length ? awaits[awaits.length - 1].index : -1;
    if (head.lastIndexOf(REFUSE) <= lastAwait)
      problems.push(
        `write ${k} (.mutateAsync() has no ${REFUSE} after the await before it`,
      );
  }
  return problems;
}

/** Every problem the sources show; empty = the hold covers every route. */
export function checkPublishHoldRoutes(sources) {
  const problems = [];
  const paths = Object.keys(sources);
  if (paths.length === 0) return ["no sources to scan"];
  const text = (path) => {
    const t = sources[path];
    if (typeof t !== "string") {
      problems.push(`${path}: missing or unreadable`);
      return null;
    }
    return t;
  };

  // Layer 1: each push callee is called from its roster hook and nowhere else in
  // src/, through `api.` or a namespace alias of the api package; outside the
  // package, a named import or re-export of a callee fails outright.
  for (const file of HOOK_FILES) text(file);
  for (const path of paths) {
    const t = sources[path];
    if (typeof t !== "string") continue;
    const blanked = blank(path, t);
    const aliases = new Set(["api"]);
    if (!path.startsWith(API_DIR))
      for (const imp of apiImports(path, blanked)) {
        if (imp.alias) aliases.add(imp.alias);
        if (imp.star)
          problems.push(`${path}: re-exports the api package wholesale`);
        for (const name of imp.named)
          if (Object.hasOwn(CALLEES, name))
            problems.push(
              `${path}: imports ${name} from the api package — only ${CALLEES[name].hook} may call it, as api.${name}(`,
            );
      }
    const calleeRe = new RegExp(
      `\\b(?:${[...aliases].map(escapeRe).join("|")})\\.(${Object.keys(CALLEES).join("|")})\\(`,
      "g",
    );
    const total = [...blanked.matchAll(calleeRe)].length;
    if (total === 0) continue;
    let seen = 0;
    for (const [unit, body] of topLevelUnits(blanked)) {
      for (const [, callee] of body.matchAll(calleeRe)) {
        seen++;
        const want = CALLEES[callee];
        if (want.hook !== unit || want.file !== path)
          problems.push(
            `${path}: ${unit} calls api.${callee}( but only ${want.hook} (${want.file}) may — guard its routes and add it to the roster`,
          );
      }
    }
    if (seen !== total)
      problems.push(
        `${path}: ${total - seen} push callee call(s) outside any top-level unit`,
      );
  }
  for (const [callee, { hook, file }] of Object.entries(CALLEES)) {
    const t = sources[file];
    if (typeof t !== "string") continue;
    const body = topLevelUnits(blank(file, t)).get(hook);
    if (body === undefined)
      problems.push(`${file}: roster hook ${hook} not found`);
    else if (!new RegExp(`\\bapi\\.${callee}\\(`).test(body))
      problems.push(`${file}: ${hook} no longer calls api.${callee}(`);
  }

  // Layer 2: every file naming a roster hook is a listed route or exclusion,
  // naming exactly the hooks it is listed with.
  const hookRe = new RegExp(`\\b(${HOOKS.join("|")})\\b`, "g");
  const listed = {
    ...ROUTES,
    ...Object.fromEntries(
      Object.entries(EXCLUDED).map(([f, e]) => [f, e.hooks]),
    ),
  };
  for (const path of paths) {
    const t = sources[path];
    if (typeof t !== "string") continue;
    let blanked = blank(path, t);
    if (HOOK_FILES.has(path))
      blanked = blanked.replace(
        new RegExp(`function\\s+(${HOOKS.join("|")})\\(`, "g"),
        "function (",
      );
    const named = [...new Set([...blanked.matchAll(hookRe)].map((m) => m[1]))];
    if (named.length === 0) {
      if (listed[path])
        problems.push(`${path}: listed but names no roster hook (stale entry)`);
      continue;
    }
    const want = listed[path];
    if (!want) {
      problems.push(
        `${path}: names ${named.join(", ")} but is neither a guarded route nor a reasoned exclusion`,
      );
      continue;
    }
    const got = named.sort().join(",");
    if (got !== [...want].sort().join(","))
      problems.push(`${path}: names [${got}], listed with [${want.join(",")}]`);
  }
  for (const path of Object.keys(listed))
    if (!(path in sources)) problems.push(`${path}: listed file missing`);
  for (const path of Object.keys(ROUTES))
    if (!HANDLERS.some((h) => h.file === path))
      problems.push(`${path}: route file with no pinned handler`);

  // Every write through a route file's roster binding sits in a pinned handler.
  for (const [file, hooks] of Object.entries(ROUTES)) {
    const t = sources[file];
    if (typeof t !== "string") continue;
    const blanked = blank(file, t);
    const alt = hooks.map(escapeRe).join("|");
    const vars = [
      ...blanked.matchAll(
        new RegExp(`\\bconst\\s+(\\w+)\\s*=\\s*(?:${alt})\\(`, "g"),
      ),
    ].map((m) => m[1]);
    const calls = [...blanked.matchAll(new RegExp(`\\b(?:${alt})\\(`, "g"))];
    if (calls.length !== vars.length)
      problems.push(
        `${file}: ${calls.length - vars.length} roster hook call(s) without a plain \`const x = hook(\` binding`,
      );
    const ranges = [];
    for (const h of HANDLERS.filter((x) => x.file === file)) {
      const body = handlerBody(blanked, h);
      const at = body.includes("\n") ? blanked.indexOf(body) : -1;
      if (at >= 0) ranges.push([at, at + body.length]);
    }
    // A plain receiver, or one a parenthesized expression picks (`(a ? b : c)`).
    for (const v of vars)
      for (const m of blanked.matchAll(
        new RegExp(
          `(?:\\b${escapeRe(v)}|\\([^()]*\\b${escapeRe(v)}\\b[^()]*\\))\\.(mutateAsync|mutate)\\(`,
          "g",
        ),
      ))
        if (!ranges.some(([a, b]) => m.index >= a && m.index < b))
          problems.push(
            `${file}: ${v}.${m[1]}( outside every pinned handler — pin it in HANDLERS`,
          );
  }

  // The handlers: each refuses, and after every await that precedes a write.
  for (const h of HANDLERS) {
    const t = sources[h.file];
    if (typeof t !== "string") continue;
    const body = handlerBody(blank(h.file, t), h);
    if (!body.includes("\n")) {
      problems.push(body);
      continue;
    }
    const refusals = body.split(REFUSE).length - 1;
    if (refusals < h.refusals)
      problems.push(
        `${label(h)}: ${refusals} ${REFUSE} call(s), needs ${h.refusals}`,
      );
    if (h.refusals > 0)
      for (const problem of writeOrderProblems(body))
        problems.push(`${label(h)}: ${problem}`);
    const flat = norm(body);
    for (const need of h.needs ?? [])
      if (!flat.includes(need))
        problems.push(`${label(h)}: missing \`${need}\``);
    if (h.order) {
      const [first, then] = h.order;
      const a = body.indexOf(first);
      const b = body.indexOf(then);
      if (a < 0 || b < 0 || a > b)
        problems.push(`${label(h)}: \`${first}\` must precede \`${then}\``);
    }
  }

  // Render holds.
  for (const [file, pin] of Object.entries(RENDER_PINS)) {
    const t = text(file);
    if (t === null) continue;
    const flat = norm(blank(file, t));
    for (const need of pin.need)
      if (!flat.includes(need)) problems.push(`${file}: missing \`${need}\``);
    for (const stale of pin.stale)
      if (stale.test(flat)) problems.push(`${file}: holds on ${stale}`);
    for (const re of pin.pattern ?? [])
      if (!re.test(flat)) problems.push(`${file}: missing ${re}`);
  }

  // ResolveRemotePrView's exclusion: RemotePrView.tsx is its only host.
  const hosts = paths.filter(
    (p) =>
      typeof sources[p] === "string" && sources[p].includes(RESOLVE_HOST.tag),
  );
  if (hosts.join() !== RESOLVE_HOST.file)
    problems.push(
      `${RESOLVE_HOST.tag} hosts [${hosts.join(", ")}], expected only ${RESOLVE_HOST.file}`,
    );
  return problems;
}

const SRC = new URL("../src/", import.meta.url);

/** Every .ts/.tsx under src/, keyed relative to it, LF-normalized so the mutants
 *  below match the same lines the checker reads. */
function realSources() {
  const sources = {};
  const walk = (dir) => {
    for (const entry of readdirSync(new URL(dir, SRC), {
      withFileTypes: true,
    })) {
      const rel = `${dir}${entry.name}`;
      if (entry.isDirectory()) walk(`${rel}/`);
      else if (/\.tsx?$/.test(entry.name))
        sources[rel] = readFileSync(new URL(rel, SRC), "utf8").replace(
          /\r\n/g,
          "\n",
        );
    }
  };
  walk("");
  assert.ok(Object.keys(sources).length > 100, "src/ corpus looks empty");
  return sources;
}

/** `sources` with `file`'s text passed through `edit`, asserting it changed. */
function mutate(sources, file, edit) {
  const next = edit(sources[file]);
  assert.notEqual(next, sources[file], `mutant of ${file} changed nothing`);
  return { ...sources, [file]: next };
}

const failsWith = (sources, fragment) => {
  const problems = checkPublishHoldRoutes(sources);
  assert.ok(
    problems.some((p) => p.includes(fragment)),
    `expected a failure naming ${fragment}, got ${JSON.stringify(problems)}`,
  );
};

test("the real tree holds every push route behind the publish", () => {
  assert.deepEqual(checkPublishHoldRoutes(realSources()), []);
});

test("an unlisted file calling a push hook fails the check", () => {
  const sources = {
    ...realSources(),
    "features/fake/Unlisted.tsx":
      "export function Unlisted({ repoPath }) {\n  const push = usePush(repoPath);\n  return null;\n}\n",
  };
  failsWith(sources, "features/fake/Unlisted.tsx: names usePush");
});

test("stripping runPushBranch's publish refusal fails the check", () => {
  const file = `${R}BranchSwitcher.tsx`;
  const sources = mutate(realSources(), file, (text) => {
    const h = HANDLERS.find(
      (x) => x.file === file && x.name === "runPushBranch",
    );
    const body = handlerBody(text, h);
    assert.ok(body.includes("\n"), body);
    return text.replace(
      body,
      body.replace(/\s*\|\|\s*refuseWhilePublishing\([^)]*\)/, ""),
    );
  });
  failsWith(sources, "runPushBranch: 0 refuseWhilePublishing( call(s)");
});

test("disarming any one handler's refusals fails the check", () => {
  const sources = realSources();
  for (const h of HANDLERS.filter((x) => x.refusals > 0)) {
    const mutant = mutate(sources, h.file, (text) => {
      const body = handlerBody(text, h);
      assert.ok(body.includes("\n"), body);
      return text.replace(body, body.replaceAll(REFUSE, "noRefusal("));
    });
    failsWith(mutant, `${label(h)}: 0 ${REFUSE} call(s)`);
  }
});

test("dropping PublishDialog's identity-loading return fails the check", () => {
  const sources = mutate(realSources(), `${R}PublishDialog.tsx`, (text) =>
    text.replace("if (identityLoading) return;", ""),
  );
  failsWith(sources, "PublishDialog.tsx onSubmit: missing");
});

test("a new hook calling a push api wrapper fails the check", () => {
  const sources = mutate(realSources(), `${Q}tags-releases.ts`, (text) =>
    text.concat(
      "\nexport function useSneakyPush(repo: string) {\n  return useRepoMutation(repo, (n: string) => api.gitPushTag(repo, n));\n}\n",
    ),
  );
  failsWith(sources, "useSneakyPush calls api.gitPushTag(");
});

test("renaming a roster hook fails closed", () => {
  const sources = mutate(realSources(), `${Q}tags-releases.ts`, (text) =>
    text.replace("function usePushTag(", "function usePushTagX("),
  );
  failsWith(sources, "roster hook usePushTag not found");
});

test("dropping a render hold fails the check", () => {
  const sources = mutate(realSources(), `${R}BranchSwitcher.tsx`, (text) =>
    text.replace(
      /(const pushItemDisabled =[^;]*?)\s*\|\|\s*publishActive;/,
      "$1;",
    ),
  );
  failsWith(sources, "const pushItemDisabled");
});

test("a remote delete's held reason without its publish arm, or out of order, fails the check", () => {
  const file = `${R}BranchSwitcher.tsx`;
  const push =
    "            case pushActive:\n              return branchPushHoldReason(pushPaused);\n";
  const publish =
    "            case publishActive:\n              return PUBLISH_HOLD_REASON;\n";
  for (const edit of [
    (text) => text.replace(publish, ""),
    (text) => text.replace(`${push}${publish}`, `${publish}${push}`),
  ])
    failsWith(mutate(realSources(), file, edit), "heldReason={(() => {");
});

test("a missing roster file fails closed", () => {
  const sources = realSources();
  delete sources[`${Q}sync.ts`];
  failsWith(sources, `${Q}sync.ts: missing or unreadable`);
});

test("a roster write outside every pinned handler fails the check", () => {
  const file = `${R}BranchSwitcher.tsx`;
  const plain = mutate(realSources(), file, (text) =>
    text.concat(
      "\nasync function quickPush() {\n  await push.mutateAsync({ setUpstream: false });\n}\n",
    ),
  );
  failsWith(plain, "push.mutateAsync( outside every pinned handler");
  const picked = mutate(realSources(), file, (text) =>
    text.concat(
      "\nasync function quickDelete() {\n  await (true ? deleteRemoteBranch : other).mutateAsync({});\n}\n",
    ),
  );
  failsWith(
    picked,
    "deleteRemoteBranch.mutateAsync( outside every pinned handler",
  );
});

test("a refusal moved below the write it guards fails the check", () => {
  const file = `${R}SyncControls.tsx`;
  const block =
    "        if (\n          refuseWhileOffline() ||\n          refuseWhilePushing() ||\n          refuseWhilePublishing(queryClient, repoPath)\n        )\n          return;\n";
  const write = '          source: "header",\n        });\n';
  const sources = mutate(realSources(), file, (text) => {
    const h = HANDLERS.find(
      (x) => x.file === file && x.name === "pushFromMenu",
    );
    const body = handlerBody(text, h);
    assert.ok(body.includes(block) && body.includes(write), "spellings moved");
    return text.replace(
      body,
      body.replace(block, "").replace(write, `${write}${block}`),
    );
  });
  failsWith(sources, "pushFromMenu: write 2 (.mutateAsync() has no");
});

test("a push api wrapper reached from outside its hook fails the check", () => {
  const file = "features/pulls/CreatePrDialog.tsx";
  failsWith(
    mutate(realSources(), file, (text) =>
      text.concat(
        "\nexport function sneaky(r: string) {\n  return api.gitPush(r, false);\n}\n",
      ),
    ),
    `${file}: sneaky calls api.gitPush(`,
  );
  failsWith(
    mutate(realSources(), file, (text) =>
      text.concat("\napi.gitPush(r, false);\n"),
    ),
    `${file}: 1 push callee call(s) outside any top-level unit`,
  );
  failsWith(
    mutate(realSources(), file, (text) =>
      'import { type Foo, gitPush as push2 } from "@/lib/git/api";\n'.concat(
        text,
      ),
    ),
    `${file}: imports gitPush from the api package`,
  );
  failsWith(
    mutate(realSources(), file, (text) =>
      'import * as git from "@/lib/git/api/sync";\n'.concat(
        text,
        "\nexport function sneaky(r: string) {\n  return git.gitPush(r, false);\n}\n",
      ),
    ),
    `${file}: sneaky calls api.gitPush(`,
  );
  failsWith(
    mutate(realSources(), file, (text) =>
      'export * from "@/lib/git/api";\n'.concat(text),
    ),
    `${file}: re-exports the api package wholesale`,
  );
  failsWith(
    mutate(realSources(), `${Q}branches.ts`, (text) =>
      'import { gitPushTag } from "../api/tags-releases";\n'.concat(text),
    ),
    `${Q}branches.ts: imports gitPushTag from the api package`,
  );
});

test("a publish whose remotes re-read skips an outcome fails the check", () => {
  const file = `${Q}remotes.ts`;
  const wrapped =
    /try \{\n\s*return await (api\.forgePublishRepo\([\s\S]*?\);)\n\s*\} finally \{([\s\S]*?)\n {6}\}\n/;
  // Success only: the call unwrapped, the re-read moved into onSuccess.
  const successOnly = mutate(realSources(), file, (text) => {
    assert.match(text, wrapped);
    let reread = "";
    const unwrapped = text.replace(wrapped, (_, call, body) => {
      reread = body;
      return `return ${call}\n`;
    });
    const onSuccess =
      "onSuccess: () => recheckRunsAfterPush(queryClient, repo),";
    assert.ok(unwrapped.includes(onSuccess));
    return unwrapped.replace(
      onSuccess,
      () =>
        `onSuccess: () => {${reread}\n        recheckRunsAfterPush(queryClient, repo);\n      },`,
    );
  });
  failsWith(successOnly, `${file}: missing /`);
  // Failure only.
  const failureOnly = mutate(realSources(), file, (text) =>
    text.replace("} finally {", "} catch (e) {"),
  );
  failsWith(failureOnly, `${file}: missing /`);
  // A finally around some other step: the publish awaited before the try.
  const detached = mutate(realSources(), file, (text) =>
    text.replace(
      wrapped,
      (_, call, body) =>
        `const published = await ${call}\n      try {\n        return published;\n      } finally {${body}\n      }\n`,
    ),
  );
  failsWith(detached, `${file}: missing /`);
  // The publishing repo's own remotes back in the sibling pass.
  const ownRepo = mutate(realSources(), file, (text) =>
    text.replace(" || path === repo", ""),
  );
  failsWith(ownRepo, `${file}: missing \`if (root`);
  // Every other cached repo again: the identity arm dropped.
  const anyRepo = mutate(realSources(), file, (text) =>
    text.replace(
      "return theirs === undefined || theirs === path || theirs === own;",
      "return true;",
    ),
  );
  failsWith(anyRepo, `${file}: missing \`return theirs`);
  // A sibling predicate built but never handed to the re-read.
  const unwired = mutate(realSources(), file, (text) =>
    text.replace("{ predicate: siblingRemotes }", "{ predicate: () => true }"),
  );
  failsWith(unwired, `${file}: missing /`);
  // An unknown identity read as no sibling.
  const unknownSkips = mutate(realSources(), file, (text) =>
    text.replace(
      "return theirs === undefined || theirs === path || theirs === own;",
      "return theirs === path || theirs === own;",
    ),
  );
  failsWith(unknownSkips, `${file}: missing \`return theirs`);
  // The sibling's identity peeked under the publisher's path: every learned
  // checkout then compares the publisher with itself.
  const peeksOwn = mutate(realSources(), file, (text) =>
    text.replace(
      "const theirs = peekRepoIdentity(path);",
      "const theirs = peekRepoIdentity(repo);",
    ),
  );
  failsWith(peeksOwn, `${file}: missing \`const theirs`);
  // The publisher's raw-path fallback read as a learned identity.
  const ownRawLearned = mutate(realSources(), file, (text) =>
    text.replace(
      "own === undefined || own === repo ||",
      "own === undefined ||",
    ),
  );
  failsWith(ownRawLearned, `${file}: missing \`if (own`);
  // A sibling's raw-path fallback read as a learned identity.
  const theirRawLearned = mutate(realSources(), file, (text) =>
    text.replace(
      "theirs === undefined || theirs === path ||",
      "theirs === undefined ||",
    ),
  );
  failsWith(theirRawLearned, `${file}: missing \`return theirs`);
});
