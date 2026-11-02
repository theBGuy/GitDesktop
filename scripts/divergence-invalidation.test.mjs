// Guard: useBranchDivergence's staleTime is safe only while every in-app ref move
// made from this checkout invalidates ["repo", repo, "divergence"]. A queries
// `useRepoMutation` whose options name `invalidate` replaces the repo-subtree
// default, so its `invalidate` or `invalidateAfter` must carry that key (the key
// literal, `repoKeys.all(`, or an aftermath helper pinned below to carry it), or
// the hook is ALLOWLISTED with why it moves no local branch ref.
// Blind spots, by design: only src/lib/git/queries/*.ts `useRepoMutation` sites
// are scanned, plus the pinned CleanupBranchesDialog batch; other raw-api ref
// writers outside queries/ are review's job. An allowlisted hook stays allowlisted
// if its mutationFn later starts moving refs. Accepted shapes only: an aftermath
// call as the whole value, or an array holding an aftermath spread,
// `repoKeys.all(x)` or the closed key `["repo", x, "divergence"]`; anything
// else (helpers, variables, wrappers) reads as uncovered. The key's repo slot
// (`x` above) is not checked against the hook's repo argument. The Cleanup pin
// proves only a code-position invalidation inside the function enclosing the last
// delete; its control flow (an `if`, an early return) is review's job. Shapes
// only a parser could split (annotated function heads, quoted or computed option
// keys, accessor, method or shorthand options, generic arguments with
// parentheses, aliases) are refused.
//
// Runs in CI's installless `guards` job, so node built-ins ONLY.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { lineOf, maskNonCode, matchBrace, ScanError } from "./lib/ts-mask.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const QUERIES = "src/lib/git/queries";
const AFTERMATH = `${QUERIES}/workingtree.ts`;
const CLEANUP = "src/features/repository/CleanupBranchesDialog.tsx";

const INDEX_ONLY = "stages or unstages paths: the index only, no ref";
const TREE_ONLY = "rewrites working-tree or index content, no ref";
const BB_SETTINGS = "Bitbucket repository-settings API: no git ref";
const WORKTREE_ADMIN = "worktree admin files only: no refs/heads write";

/** Explicit-invalidate hooks that move no local branch ref, with the reason. */
const ALLOWLIST = {
  useStage: INDEX_ONLY,
  useUnstage: INDEX_ONLY,
  useMarkConflictResolved: INDEX_ONLY,
  useApplyPatch: TREE_ONLY,
  useApplyPartial: TREE_ONLY,
  useDiscardUntrackedLines: TREE_ONLY,
  useResolveConflict: TREE_ONLY,
  useCheckoutConflictSide: TREE_ONLY,
  useApplySuggestion: TREE_ONLY,
  useAppendRepoAiIgnore: "edits .gitdesktop/aiignore, no ref",
  useRemoveRepoAiIgnore: "edits .gitdesktop/aiignore, no ref",
  useDeleteRemoteBranch:
    "deletes a refs/remotes ref; no local branch tip moves",
  useBbAddDefaultReviewer: BB_SETTINGS,
  useBbRemoveDefaultReviewer: BB_SETTINGS,
  useBbCreateBranchRestriction: BB_SETTINGS,
  useBbUpdateBranchRestriction: BB_SETTINGS,
  useBbDeleteBranchRestriction: BB_SETTINGS,
  useBbSetPipelinesEnabled: BB_SETTINGS,
  useBbDeleteVariable: BB_SETTINGS,
  useBbSetScheduleEnabled: BB_SETTINGS,
  useBbDeleteSchedule: BB_SETTINGS,
  useBbCreateHook: BB_SETTINGS,
  useBbUpdateHook: BB_SETTINGS,
  useBbDeleteHook: BB_SETTINGS,
  useMoveUserWorktree: WORKTREE_ADMIN,
  useLockUserWorktree: WORKTREE_ADMIN,
  useUnlockUserWorktree: WORKTREE_ADMIN,
  useRepairWorktrees: WORKTREE_ADMIN,
};

/** A scan that finds fewer explicit-invalidate hooks than this read nothing. */
const HOOK_FLOOR = 25;

const CALL_RE = /(?<![\w$.])useRepoMutation\s*(?:<[^()]*?>)?\s*\(/g;
const HOOK_RE = /export\s+function\s+(\w+)\s*(?:<[^()]*?>)?\s*\(/g;
/** The exact covering shapes, matched against a whole trimmed value or element.
 *  The aftermath helpers return a LIST of keys: whole as the value, spread as
 *  elements (bare as an element, the list would be one key that matches
 *  nothing). `repoKeys.all(` is one prefix key, so it covers as an element. */
const AFTERMATH_CALL =
  /^(?:headMoveAftermathKeys|commitAftermathKeys)\s*\(\s*[A-Za-z_$][\w$]*\s*\)$/;
const AFTERMATH_SPREAD =
  /^\.\.\.\s*(?:headMoveAftermathKeys|commitAftermathKeys)\s*\(\s*[A-Za-z_$][\w$]*\s*\)$/;
const REPO_ALL = /^repoKeys\.all\s*\(\s*[A-Za-z_$][\w$]*\s*\)$/;
/** The closed divergence key, every base: `["repo", <identifier>, "divergence"]`. */
const KEY_LITERAL =
  /^\[\s*"repo"\s*,\s*[A-Za-z_$][\w$]*\s*,\s*"divergence"\s*,?\s*\]$/;
const CLEANUP_KEY_RE =
  /invalidateQueries\(\s*\{\s*queryKey:\s*\[\s*"repo"\s*,\s*repoPath\s*,\s*"divergence"\s*,?\s*\]/g;

const queryFiles = () =>
  readdirSync(join(REPO_ROOT, QUERIES))
    .filter((n) => n.endsWith(".ts"))
    .sort()
    .map((n) => `${QUERIES}/${n}`);

/** The file's text with LF endings, or null when it can't be read. */
function source(rel) {
  try {
    return readFileSync(join(REPO_ROOT, rel), "utf8").replace(/\r\n/g, "\n");
  } catch {
    return null;
  }
}

/** `src` masked by maskNonCode, or a problem string when it can't be scanned. */
function masking(rel, src) {
  try {
    return { masked: maskNonCode(src, rel.endsWith(".tsx")) };
  } catch (err) {
    if (err instanceof ScanError)
      return { problem: `${rel}: could not scan: ${err.message}` };
    throw err;
  }
}

/** Whether `re` matches `src[a, b)` at a CODE position (comment and string
 *  text is blanked in `masked`, so its first character differs there). */
function codeMatch(src, masked, a, b, re) {
  for (const m of src.slice(a, b).matchAll(re))
    if (masked[a + m.index] === m[0][0]) return true;
  return false;
}

/** [start, end) ranges of the depth-0 comma-separated parts between the
 *  bracket at `open` and its match `close`, blanks dropped. */
function parts(masked, open, close) {
  const out = [];
  let depth = 0;
  let from = open + 1;
  for (let i = open + 1; i < close; i++) {
    const c = masked[i];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 0) {
      out.push([from, i]);
      from = i + 1;
    }
  }
  out.push([from, close]);
  return out.filter(([a, b]) => masked.slice(a, b).trim() !== "");
}

/** `[a, b)` narrowed to its code: leading and trailing blanks in `masked`
 *  (whitespace and blanked comments) dropped. */
function codeSpan(masked, a, b) {
  let s = a;
  let e = b;
  while (s < e && /\s/.test(masked[s])) s++;
  while (e > s && /\s/.test(masked[e - 1])) e--;
  return [s, e];
}

/** Whether the array literal `[open, close]` has an element that is exactly
 *  the closed key literal. */
function hasKeyElement(src, masked, open, close) {
  return parts(masked, open, close).some(([a, b]) => {
    const [s, e] = codeSpan(masked, a, b);
    return KEY_LITERAL.test(src.slice(s, e));
  });
}

/** Whether the value `src[a, b)` covers the divergence key: exactly an
 *  aftermath call, or an array literal holding the closed key literal, an
 *  aftermath spread or `repoKeys.all(<ident>)`. */
function covers(src, masked, a, b) {
  const [s, e] = codeSpan(masked, a, b);
  const value = masked.slice(s, e);
  if (value[0] !== "[" || matchBrace(masked, s) !== e - 1)
    return AFTERMATH_CALL.test(value);
  if (hasKeyElement(src, masked, s, e - 1)) return true;
  return parts(masked, s, e - 1).some(([pa, pb]) => {
    const el = masked.slice(...codeSpan(masked, pa, pb));
    return AFTERMATH_SPREAD.test(el) || REPO_ALL.test(el);
  });
}

/** Every exported function's name and body range in `masked`. */
function hooksIn(masked) {
  const out = [];
  for (const m of masked.matchAll(HOOK_RE)) {
    const paramsOpen = m.index + m[0].length - 1;
    const paramsClose = matchBrace(masked, paramsOpen);
    const bodyOpen = paramsClose === -1 ? -1 : masked.indexOf("{", paramsClose);
    const bodyClose = bodyOpen === -1 ? -1 : matchBrace(masked, bodyOpen);
    out.push({ name: m[1], from: bodyOpen, to: bodyClose });
  }
  return out;
}

const TOKEN_RE = /(?<![\w$])useRepoMutation(?![\w$])/g;

/** Every code-position `useRepoMutation` token must be a call CALL_RE reads,
 *  the definition, or a plain import specifier; anything else is refused. */
function referenceProblems(rel, src, masked) {
  const calls = new Set([...masked.matchAll(CALL_RE)].map((m) => m.index));
  const out = [];
  for (const m of masked.matchAll(TOKEN_RE)) {
    const before = masked.slice(0, m.index);
    if (calls.has(m.index) || /function\s*$/.test(before)) continue;
    const imp = before.lastIndexOf("import");
    if (
      imp !== -1 &&
      /^import\s*(?:type\s+)?\{[^;}]*$/.test(before.slice(imp))
    ) {
      if (/^useRepoMutation\s+as\b/.test(masked.slice(m.index)))
        out.push(
          `${rel}: imports useRepoMutation under an alias the scan can't follow`,
        );
      continue;
    }
    out.push(
      `${rel}:${lineOf(src, m.index)}: a useRepoMutation reference the scan can't read (generic arguments with parentheses, an alias, or a non-call use)`,
    );
  }
  return out;
}

/** One file's explicit-invalidate sites as {hook, covered}, plus problems. */
function scanFile(rel, src) {
  if (src === null) return { sites: [], problems: [`${rel}: unreadable`] };
  const { masked, problem } = masking(rel, src);
  if (problem) return { sites: [], problems: [problem] };
  const hooks = hooksIn(masked);
  const sites = [];
  const problems = referenceProblems(rel, src, masked);
  for (const m of masked.matchAll(CALL_RE)) {
    if (/function\s*$/.test(masked.slice(0, m.index))) continue;
    const at = `${rel}:${lineOf(src, m.index)}`;
    const open = m.index + m[0].length - 1;
    const close = matchBrace(masked, open);
    if (close === -1) {
      problems.push(`${at}: useRepoMutation call never closes`);
      continue;
    }
    const args = parts(masked, open, close);
    if (args.length < 3) continue;
    const [oa, ob] = args[2];
    const optsOpen = oa + masked.slice(oa, ob).search(/\S/);
    const optsClose = matchBrace(masked, optsOpen);
    if (
      masked[optsOpen] !== "{" ||
      optsClose >= ob ||
      masked.slice(optsClose + 1, ob).trim() !== ""
    ) {
      problems.push(`${at}: options are not an object literal the scan reads`);
      continue;
    }
    const entries = {};
    for (const [a, b] of parts(masked, optsOpen, optsClose)) {
      const text = masked.slice(a, b).trim();
      if (text.startsWith("..."))
        problems.push(`${at}: a spread in the options the scan can't read`);
      else if (/^["'`[]/.test(text))
        problems.push(
          `${at}: a quoted or computed option key the scan can't read`,
        );
      else if (!/^[A-Za-z_$][\w$]*\s*:/.test(text))
        problems.push(
          `${at}: an accessor, method or shorthand option the scan can't read (write \`invalidate: [...]\`)`,
        );
      const key = text.match(/^(invalidate|invalidateAfter|localOnly)\s*:/);
      if (!key) continue;
      entries[key[1]] = [a + masked.slice(a, b).indexOf(":") + 1, b];
    }
    if (!entries.invalidate) continue;
    if (entries.localOnly)
      problems.push(`${at}: localOnly beside an explicit invalidate`);
    const hook = hooks.find((h) => h.from < m.index && m.index < h.to);
    if (!hook) {
      problems.push(`${at}: explicit invalidate outside an exported function`);
      continue;
    }
    const covered = ["invalidate", "invalidateAfter"].some(
      (k) => entries[k] && covers(src, masked, ...entries[k]),
    );
    sites.push({ rel, hook: hook.name, covered });
  }
  return { sites, problems };
}

/** The [start, end) range of the array a `const <name> = (repo: string) =>`
 *  arrow returns, read at code positions; null when either is missing. */
function constList(masked, name) {
  const decl = masked.search(
    new RegExp(`const ${name} = \\(repo: string\\) =>`),
  );
  const open = decl === -1 ? -1 : masked.indexOf("[", decl);
  const close = open === -1 ? -1 : matchBrace(masked, open);
  return close === -1 ? null : [open, close + 1];
}

function aftermathProblems(src) {
  if (src === null)
    return [`${AFTERMATH}: unreadable, so the aftermath helpers go unpinned`];
  const { masked, problem } = masking(AFTERMATH, src);
  if (problem) return [problem];
  const out = [];
  const head = constList(masked, "headMoveAftermathKeys");
  if (head === null || !hasKeyElement(src, masked, head[0], head[1] - 1))
    out.push(
      `${AFTERMATH}: headMoveAftermathKeys no longer carries divergence`,
    );
  const commit = constList(masked, "commitAftermathKeys");
  if (
    commit === null ||
    !/\.\.\.\s*headMoveAftermathKeys\s*\(\s*repo\s*\)/.test(
      masked.slice(...commit),
    )
  )
    out.push(
      `${AFTERMATH}: commitAftermathKeys no longer spreads headMoveAftermathKeys`,
    );
  return out;
}

const CONTROL_KEYWORDS = new Set(["if", "for", "while", "switch", "catch"]);
const BLOCK_KEYWORD_RE = /(?<![\w$])(?:else|try|finally|do)$/;

/** The index of the `(` matching the `)` at `close` in masked text, or -1. */
function openParen(masked, close) {
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    if (masked[i] === ")") depth++;
    else if (masked[i] === "(" && --depth === 0) return i;
  }
  return -1;
}

/** The [open, close] braces of the innermost function body around `at`: a
 *  `{` after `=>`, or after a parameter list not led by a control keyword.
 *  Each enclosing `{` on the way must be that or a control block; any other
 *  head (a return-type annotation, an object literal) returns null. */
function enclosingFunction(masked, at) {
  for (let open = masked.lastIndexOf("{", at); open !== -1; ) {
    const close = matchBrace(masked, open);
    if (close > at) {
      const head = masked.slice(0, open).trimEnd();
      if (head.endsWith("=>")) return [open, close];
      if (head.endsWith(")")) {
        const paren = openParen(masked, head.length - 1);
        const word = masked.slice(0, paren).match(/([\w$]+)\s*$/)?.[1];
        if (paren === -1) return null;
        if (!CONTROL_KEYWORDS.has(word)) return [open, close];
      } else if (!BLOCK_KEYWORD_RE.test(head)) return null;
    }
    open = open === 0 ? -1 : masked.lastIndexOf("{", open - 1);
  }
  return null;
}

/** CleanupBranchesDialog deletes through the raw api, outside useRepoMutation,
 *  so its batch function must name the key itself after the deletes. */
function cleanupProblems(src) {
  if (src === null) return [`${CLEANUP}: unreadable`];
  const { masked, problem } = masking(CLEANUP, src);
  if (problem) return [problem];
  const del = masked.lastIndexOf("api.gitDeleteBranch(");
  if (del === -1) return [`${CLEANUP}: no api.gitDeleteBranch( batch found`];
  const fn = enclosingFunction(masked, del);
  if (fn === null)
    return [
      `${CLEANUP}: could not resolve the batch function around api.gitDeleteBranch( (write it as an unannotated \`function f() {\` or an arrow)`,
    ];
  if (codeMatch(src, masked, del, fn[1], CLEANUP_KEY_RE)) return [];
  return [
    `${CLEANUP}: the batch does not invalidate ["repo", repoPath, "divergence"] after its deletes`,
  ];
}

/** Problems over `sources` (rel -> text | null) for the given allowlist, and
 *  the scan's explicit-invalidate hooks (`byHook`). */
function check(sources, allowlist = ALLOWLIST) {
  const problems = [];
  const byHook = new Map();
  for (const rel of Object.keys(sources).filter((r) => r.startsWith(QUERIES))) {
    const scan = scanFile(rel, sources[rel]);
    problems.push(...scan.problems);
    for (const s of scan.sites) {
      const prev = byHook.get(s.hook);
      if (prev && prev.rel !== s.rel)
        problems.push(`${s.hook}: defined in both ${prev.rel} and ${s.rel}`);
      byHook.set(s.hook, {
        rel: s.rel,
        covered: (prev?.covered ?? true) && s.covered,
      });
    }
  }
  for (const [hook, { rel, covered }] of byHook) {
    if (covered && hook in allowlist)
      problems.push(
        `ALLOWLIST: ${hook} already covers divergence (stale entry)`,
      );
    else if (!covered && !(hook in allowlist))
      problems.push(
        `${rel}: ${hook} passes an explicit invalidate without ["repo", repo, "divergence"]; name the key as an element \`["repo", repo, "divergence"]\`, spread an aftermath helper (\`...headMoveAftermathKeys(repo)\`), or allowlist the hook with why it moves no local branch ref`,
      );
  }
  for (const hook of Object.keys(allowlist))
    if (!byHook.has(hook))
      problems.push(
        `ALLOWLIST: ${hook} matches no explicit-invalidate hook (stale entry)`,
      );
  if (byHook.size < HOOK_FLOOR)
    problems.push(
      `scan found ${byHook.size} explicit-invalidate hooks, under the floor of ${HOOK_FLOOR}`,
    );
  problems.push(...aftermathProblems(sources[AFTERMATH] ?? null));
  problems.push(...cleanupProblems(sources[CLEANUP] ?? null));
  return { problems, byHook };
}

const realSources = () =>
  Object.fromEntries(
    [...queryFiles(), CLEANUP].map((rel) => [rel, source(rel)]),
  );

/** `sources` with `from` replaced by `to` in `rel`; throws when the fixture no
 *  longer applies, so a stale mutant can't pass by doing nothing. */
function mutate(sources, rel, from, to) {
  const text = sources[rel];
  const next = text.replace(from, () => to);
  assert.notEqual(next, text, `fixture didn't apply in ${rel}: ${from}`);
  return { ...sources, [rel]: next };
}

function failsWith(sources, needle, allowlist) {
  const { problems } = check(sources, allowlist);
  assert.ok(
    problems.some((m) => m.includes(needle)),
    `expected "${needle}" in ${JSON.stringify(problems)}`,
  );
}

const WORKTREES = `${QUERIES}/worktrees.ts`;
const ADD_KEY = '["repo", repo, "divergence"],';
const NAMES_ADD = `${WORKTREES}: useAddUserWorktree passes an explicit invalidate without`;
const HEAD_KEY = '\n    ["repo", repo, "divergence"],';
const COMMIT_SPREAD = "\n    ...headMoveAftermathKeys(repo),";
const CLEANUP_INVALIDATE =
  '\n    await queryClient.invalidateQueries({\n      queryKey: ["repo", repoPath, "divergence"],\n    });';

/** `sources` with `text` appended to worktrees.ts. */
const appended = (sources, text) => ({
  ...sources,
  [WORKTREES]: `${sources[WORKTREES]}\n${text}\n`,
});

test("every explicit-invalidate hook covers divergence or is allowlisted", () => {
  const { problems, byHook } = check(realSources());
  assert.deepEqual(problems, []);
  const allowlisted = [...byHook].filter(([h]) => h in ALLOWLIST).length;
  assert.equal(allowlisted, Object.keys(ALLOWLIST).length);
});

const RUN_BATCH = "async function runBatch() {";
const ANNOTATED_RUN_BATCH = "async function runBatch(): Promise<void> {";
const ADD_INVALIDATE =
  'invalidate: [\n        worktreeKey(repo),\n        repoKeys.branches(repo),\n        ["repo", repo, "divergence"],\n      ],';

/** useAddUserWorktree rewritten to each accepted covering shape. */
const ACCEPTED = {
  "a spread headMoveAftermathKeys element": [
    ADD_KEY,
    "...headMoveAftermathKeys(repo),",
  ],
  "a spread commitAftermathKeys element": [
    ADD_KEY,
    "...commitAftermathKeys(repo),",
  ],
  "an aftermath helper as the whole value": [
    ADD_INVALIDATE,
    "invalidate: headMoveAftermathKeys(repo),",
  ],
  "repoKeys.all as an element": [ADD_KEY, "repoKeys.all(repo),"],
  "the key literal over another identifier": [
    ADD_KEY,
    '["repo", repoPath, "divergence"],',
  ],
};

for (const [name, [from, to]] of Object.entries(ACCEPTED))
  test(`covers with ${name}`, () =>
    assert.deepEqual(
      check(mutate(realSources(), WORKTREES, from, to)).problems,
      [],
    ));

const UNREADABLE_ENTRY =
  "an accessor, method or shorthand option the scan can't read";

/** Mutants of the real tree, each with the one problem it must raise. */
const MUTANTS = {
  "useAddUserWorktree without the key": [
    (s) => mutate(s, WORKTREES, ADD_KEY, ""),
    NAMES_ADD,
  ],
  "the key only in a comment": [
    (s) => mutate(s, WORKTREES, ADD_KEY, '// ["repo", repo, "divergence"],'),
    NAMES_ADD,
  ],
  "a divergence token in another key's shape": [
    (s) =>
      mutate(s, WORKTREES, ADD_KEY, '["repo", repo, "prs", "divergence"],'),
    NAMES_ADD,
  ],
  "a spread of repoKeys.all": [
    (s) => mutate(s, WORKTREES, ADD_KEY, "...repoKeys.all(repo),"),
    NAMES_ADD,
  ],
  "a bare aftermath helper as an element": [
    (s) => mutate(s, WORKTREES, ADD_KEY, "headMoveAftermathKeys(repo),"),
    NAMES_ADD,
  ],
  "the key narrowed by a trailing element": [
    (s) =>
      mutate(s, WORKTREES, ADD_KEY, '["repo", repo, "divergence", "main"],'),
    NAMES_ADD,
  ],
  "a wrapped aftermath helper": [
    (s) => mutate(s, WORKTREES, ADD_KEY, "wrap(headMoveAftermathKeys(repo)),"),
    NAMES_ADD,
  ],
  "a wrapped key literal": [
    (s) => mutate(s, WORKTREES, ADD_KEY, 'fn(["repo", repo, "divergence"]),'),
    NAMES_ADD,
  ],
  "a new explicit-invalidate hook off the allowlist": [
    (s) =>
      appended(
        s,
        "export function useNewBranchWrite(repo: string) {\n  return useRepoMutation(repo, (n: string) => api.gitNewBranch(repo, n), {\n    invalidate: [repoKeys.branches(repo)],\n  });\n}",
      ),
    `${WORKTREES}: useNewBranchWrite passes an explicit invalidate without`,
  ],
  "a quoted option key": [
    (s) => mutate(s, WORKTREES, "invalidate: [", '"invalidate": ['),
    "a quoted or computed option key the scan can't read",
  ],
  "a computed option key": [
    (s) => mutate(s, WORKTREES, "invalidate: [", "[INVALIDATE]: ["),
    "a quoted or computed option key the scan can't read",
  ],
  "a getter option": [
    (s) =>
      mutate(
        s,
        WORKTREES,
        ADD_INVALIDATE,
        "get invalidate() {\n        return [];\n      },",
      ),
    UNREADABLE_ENTRY,
  ],
  "a setter beside the list": [
    (s) =>
      mutate(
        s,
        WORKTREES,
        ADD_INVALIDATE,
        `set invalidate(v) {},\n      ${ADD_INVALIDATE}`,
      ),
    UNREADABLE_ENTRY,
  ],
  "a method option": [
    (s) =>
      mutate(
        s,
        WORKTREES,
        ADD_INVALIDATE,
        "invalidate() {\n        return [];\n      },",
      ),
    UNREADABLE_ENTRY,
  ],
  "a shorthand option": [
    (s) =>
      appended(
        mutate(s, WORKTREES, ADD_INVALIDATE, "invalidate,"),
        'const invalidate = [repoKeys.branches("")];',
      ),
    UNREADABLE_ENTRY,
  ],
  "generic arguments with parentheses": [
    (s) =>
      appended(
        s,
        "export function useTyped(repo: string) {\n  return useRepoMutation<string, (x: string) => void>(repo, (n: string) => n, {\n    invalidate: [repoKeys.branches(repo)],\n  });\n}",
      ),
    "a useRepoMutation reference the scan can't read",
  ],
  "an aliased import": [
    (s) =>
      appended(
        s,
        'import { useRepoMutation as urm } from "./internal";\nexport function useAliased(repo: string) {\n  return urm(repo, (n: string) => n, { invalidate: [repoKeys.branches(repo)] });\n}',
      ),
    "imports useRepoMutation under an alias the scan can't follow",
  ],
  "a spread in the options": [
    (s) =>
      appended(
        s,
        "export function useSpread(repo: string) {\n  return useRepoMutation(repo, (n: string) => n, { ...shared, invalidate: [] });\n}",
      ),
    "a spread in the options the scan can't read",
  ],
  "options passed by name": [
    (s) =>
      appended(
        s,
        "export function useNamed(repo: string) {\n  return useRepoMutation(repo, (n: string) => n, opts);\n}",
      ),
    "options are not an object literal the scan reads",
  ],
  "options `as const`": [
    (s) =>
      appended(
        s,
        "export function useAsConst(repo: string) {\n  return useRepoMutation(repo, (n: string) => n, { invalidate: [] } as const);\n}",
      ),
    "options are not an object literal the scan reads",
  ],
  "options `satisfies`": [
    (s) =>
      appended(
        s,
        "export function useSatisfies(repo: string) {\n  return useRepoMutation(repo, (n: string) => n, { invalidate: [] } satisfies Opts);\n}",
      ),
    "options are not an object literal the scan reads",
  ],
  "localOnly beside an explicit invalidate": [
    (s) =>
      appended(
        s,
        "export function useBoth(repo: string) {\n  return useRepoMutation(repo, (n: string) => n, { localOnly: true, invalidate: [] });\n}",
      ),
    "localOnly beside an explicit invalidate",
  ],
  "a non-exported helper": [
    (s) =>
      appended(
        s,
        "function useHelper(repo: string) {\n  return useRepoMutation(repo, (n: string) => n, { invalidate: [] });\n}",
      ),
    "explicit invalidate outside an exported function",
  ],
  // The scan reads only `export function` hooks, so an exported arrow fails too.
  "an exported arrow const": [
    (s) =>
      appended(
        s,
        "export const useArrow = (repo: string) =>\n  useRepoMutation(repo, (n: string) => n, { invalidate: [] });",
      ),
    "explicit invalidate outside an exported function",
  ],
  "a call that never closes": [
    (s) =>
      appended(
        s,
        "export function useOpen(repo: string) {\n  return useRepoMutation(repo, (n: string) => n, {",
      ),
    "useRepoMutation call never closes",
  ],
  "a hook defined in two files": [
    (s) =>
      appended(
        s,
        "export function useStage(repo: string) {\n  return useRepoMutation(repo, (n: string) => n, { invalidate: [] });\n}",
      ),
    "useStage: defined in both",
  ],
  "an unreadable queries file": [
    (s) => ({ ...s, [WORKTREES]: null }),
    `${WORKTREES}: unreadable`,
  ],
  "an unscannable queries file": [
    (s) => appended(s, 'const s = "open'),
    `${WORKTREES}: could not scan`,
  ],
  "no queries files": [
    (s) => ({ [AFTERMATH]: null, [CLEANUP]: s[CLEANUP] }),
    "under the floor",
  ],
  "headMoveAftermathKeys without the key": [
    (s) => mutate(s, AFTERMATH, HEAD_KEY, ""),
    `${AFTERMATH}: headMoveAftermathKeys no longer carries divergence`,
  ],
  "headMoveAftermathKeys with the key commented out": [
    (s) => mutate(s, AFTERMATH, HEAD_KEY, `\n    //${HEAD_KEY.trim()}`),
    `${AFTERMATH}: headMoveAftermathKeys no longer carries divergence`,
  ],
  "headMoveAftermathKeys with the key narrowed": [
    (s) =>
      mutate(
        s,
        AFTERMATH,
        HEAD_KEY,
        '\n    ["repo", repo, "divergence", "x"],',
      ),
    `${AFTERMATH}: headMoveAftermathKeys no longer carries divergence`,
  ],
  "commitAftermathKeys without the spread": [
    (s) => mutate(s, AFTERMATH, COMMIT_SPREAD, ""),
    `${AFTERMATH}: commitAftermathKeys no longer spreads headMoveAftermathKeys`,
  ],
  "commitAftermathKeys with the spread commented out": [
    (s) =>
      mutate(s, AFTERMATH, COMMIT_SPREAD, `\n    //${COMMIT_SPREAD.trim()}`),
    `${AFTERMATH}: commitAftermathKeys no longer spreads headMoveAftermathKeys`,
  ],
  "an unreadable aftermath file": [
    (s) => ({ ...s, [AFTERMATH]: null }),
    `${AFTERMATH}: unreadable, so the aftermath helpers go unpinned`,
  ],
  "Cleanup's batch without the key": [
    (s) => mutate(s, CLEANUP, CLEANUP_INVALIDATE, ""),
    `${CLEANUP}: the batch does not invalidate`,
  ],
  // A block comment keeps the call's text intact, so only masking can reject it.
  "Cleanup's batch with the key commented out": [
    (s) =>
      mutate(
        s,
        CLEANUP,
        CLEANUP_INVALIDATE,
        `\n    /*${CLEANUP_INVALIDATE.trim()}*/`,
      ),
    `${CLEANUP}: the batch does not invalidate`,
  ],
  "Cleanup's key moved to another function": [
    (s) => {
      const out = mutate(s, CLEANUP, CLEANUP_INVALIDATE, "");
      return {
        ...out,
        [CLEANUP]: `${out[CLEANUP]}\nasync function elsewhere() {${CLEANUP_INVALIDATE}\n}\n`,
      };
    },
    `${CLEANUP}: the batch does not invalidate`,
  ],
  "Cleanup's delete call renamed": [
    (s) =>
      mutate(
        s,
        CLEANUP,
        "api.gitDeleteBranch(repoPath,",
        "api.gitDeleteBranchX(repoPath,",
      ),
    `${CLEANUP}: no api.gitDeleteBranch( batch found`,
  ],
  "an annotated batch function": [
    (s) => mutate(s, CLEANUP, RUN_BATCH, ANNOTATED_RUN_BATCH),
    `${CLEANUP}: could not resolve the batch function`,
  ],
  "an annotated batch function with the key in a later sibling": [
    (s) => {
      const out = mutate(
        mutate(s, CLEANUP, RUN_BATCH, ANNOTATED_RUN_BATCH),
        CLEANUP,
        CLEANUP_INVALIDATE,
        "",
      );
      return {
        ...out,
        [CLEANUP]: `${out[CLEANUP]}\nasync function elsewhere() {${CLEANUP_INVALIDATE}\n}\n`,
      };
    },
    `${CLEANUP}: could not resolve the batch function`,
  ],
  "an unreadable Cleanup": [
    (s) => ({ ...s, [CLEANUP]: null }),
    `${CLEANUP}: unreadable`,
  ],
  "an unscannable Cleanup": [
    (s) => ({ ...s, [CLEANUP]: `${s[CLEANUP]}\nconst s = "open` }),
    `${CLEANUP}: could not scan`,
  ],
};

for (const [name, [make, needle]] of Object.entries(MUTANTS))
  test(`fails on ${name}`, () => failsWith(make(realSources()), needle));

test("stale allowlist entries fail", () => {
  failsWith(
    realSources(),
    "ALLOWLIST: useNoSuchHook matches no explicit-invalidate hook (stale entry)",
    { ...ALLOWLIST, useNoSuchHook: "fixture" },
  );
  failsWith(
    realSources(),
    "ALLOWLIST: useCommit already covers divergence (stale entry)",
    { ...ALLOWLIST, useCommit: "fixture" },
  );
});
