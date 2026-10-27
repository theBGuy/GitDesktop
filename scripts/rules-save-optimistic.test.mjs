// Pins the rules editors' save paths by source scans: every automations and
// branch-rules save hook patches its cache at mutate time with an
// `optimistic` value READ BACK after the write (structural sharing stores a
// merged copy, so a guard comparing against the passed config never fires),
// rolls back only while that copy is still cached, and keeps its settle
// invalidation, which only the last in-flight save of its key runs; the
// repo-override patch folds the way the store's write does; the Automations
// panel's save joins a write of the same draft and toasts one
// failure per write, worded by whether the draft is still on screen; both
// dialogs title their failures; and BranchRules reseeds a scope switch during
// render. Each scan must pass the real source and go red under every mutation
// listed with it, so a scan that can't fail on those edits fails here instead.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { CLOSE, maskNonCode, matchBrace, OPEN } from "./lib/ts-mask.mjs";

const source = (rel) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n",
  );

const AUTO_QUERIES = "src/lib/automations/queries.ts";
const RULES_QUERIES = "src/lib/branch-rules/queries.ts";
const AUTO_STORE = "src/lib/automations/store.ts";
const SECTION = "src/features/automations/AutomationsSection.tsx";
const REPO_DIALOG = "src/features/automations/RepoAutomationsDialog.tsx";
const RULES_DIALOG = "src/features/branch-rules/BranchRulesDialog.tsx";

const STILL_HERE = "Your changes are still here. Save again to retry.";
const NOT_SAVED = "Your changes weren't saved.";

/** `{key, start, end}` for each depth-0 `key: value` member of the object
 *  literal spanning `open`..`close` in `masked` (value is start..end). */
function objectMembers(masked, open, close) {
  const members = [];
  let depth = 0;
  let expectKey = true;
  let current = null;
  for (let i = open + 1; i < close; i++) {
    const c = masked[i];
    if (OPEN.has(c)) depth++;
    else if (CLOSE.has(c)) depth--;
    else if (depth === 0 && c === ",") {
      if (current) members.push({ ...current, end: i });
      current = null;
      expectKey = true;
    } else if (depth === 0 && expectKey && /[\w$]/.test(c)) {
      const word = /^[\w$]+/.exec(masked.slice(i))[0];
      let after = i + word.length;
      while (/\s/.test(masked[after])) after++;
      if (masked[after] === ":") {
        current = { key: word, start: after + 1 };
        i = after;
      } else i += word.length - 1;
      expectKey = false;
    } else if (!/\s/.test(c)) expectKey = false;
  }
  if (current) members.push({ ...current, end: close });
  return members;
}

/** `[open, close]` of the `{…}` body of `function <name>(…)` in `masked`. */
function functionBody(masked, name) {
  const m = new RegExp(`function ${name}\\s*\\(`).exec(masked);
  if (!m) return null;
  let open = masked.indexOf("(", m.index);
  open = masked.indexOf("{", matchBrace(masked, open));
  const close = open === -1 ? -1 : matchBrace(masked, open);
  return close === -1 ? null : [open, close];
}

/** The code a callback member runs: its block body, its concise expression,
 *  or, when that expression only calls a same-file function, that function's
 *  body. */
function callbackCode(masked, value) {
  const arrow = /^\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>\s*/.exec(value);
  if (!arrow) return null;
  const rest = value.slice(arrow[0].length).trim();
  const helper = /^([\w$]+)\(/.exec(rest);
  if (helper && !/^queryClient$/.test(helper[1])) {
    const body = functionBody(masked, helper[1]);
    if (body) return masked.slice(body[0], body[1] + 1);
  }
  return rest;
}

/** Problems with every save hook in `files` (path to text), `[]` when pinned. */
function saveHookProblems(files) {
  const problems = [];
  let hooks = 0;
  for (const [rel, text] of files) {
    const masked = maskNonCode(text, false);
    for (const m of masked.matchAll(/\buseMutation\(\{/g)) {
      hooks++;
      const open = m.index + m[0].length - 1;
      const close = matchBrace(masked, open);
      const members = Object.fromEntries(
        objectMembers(masked, open, close).map((x) => [
          x.key,
          {
            masked: masked.slice(x.start, x.end),
            raw: text.slice(x.start, x.end),
          },
        ]),
      );
      const where = `${rel} hook ${hooks}`;
      if (members.networkMode?.raw.trim() !== '"always"')
        problems.push(`${where} lost networkMode "always"`);
      const mutate =
        members.onMutate && callbackCode(masked, members.onMutate.masked);
      const rollback =
        members.onError && callbackCode(masked, members.onError.masked);
      const settle =
        members.onSettled && callbackCode(masked, members.onSettled.masked);
      if (!mutate) {
        problems.push(`${where} has no onMutate patch`);
        continue;
      }
      if (!/\.cancelQueries\(/.test(mutate))
        problems.push(`${where}'s patch doesn't cancel the read first`);
      const set = mutate.lastIndexOf(".setQueryData");
      const snap = mutate.search(
        /const snapshot\s*=\s*queryClient\s*\.getQueryData\b/,
      );
      if (set === -1)
        problems.push(`${where}'s onMutate never patches the cache`);
      if (snap === -1 || snap > set)
        problems.push(`${where} doesn't snapshot before patching`);
      const reads = [...mutate.matchAll(/\boptimistic\s*:\s*([^,}]*)/g)];
      const readBack = reads.filter(
        (r) =>
          /^queryClient\s*\.getQueryData\b/.test(r[1].trim()) && r.index > set,
      );
      if (readBack.length !== 1)
        problems.push(
          `${where}'s optimistic value isn't read back after the patch`,
        );
      for (const r of reads)
        if (!readBack.includes(r) && r[1].trim() !== "undefined")
          problems.push(
            `${where} stores an optimistic value it didn't read back`,
          );
      if (
        !rollback ||
        !/\bgetQueryData\(([\w$.]+)\)\s*===\s*ctx\.optimistic\s*\)\s*queryClient\.setQueryData\(\1,\s*ctx\.snapshot\)/.test(
          rollback,
        )
      )
        problems.push(`${where}'s rollback isn't guarded on its own patch`);
      else if (!/\bgetQueryData\((?:ctx\.key|automationsKey)\)/.test(rollback))
        problems.push(`${where}'s rollback keys from render scope`);
      if (!settle || !/\.invalidateQueries\(/.test(settle))
        problems.push(`${where} lost its settle invalidation`);
      // The settle skips its refetch while another save of the same key is in
      // flight, counted under the hook's own mutation key.
      const own = members.mutationKey?.masked.trim();
      const counted = settle && queuedKey(masked, settle);
      if (!own) problems.push(`${where} has no mutation key`);
      if (!counted)
        problems.push(`${where}'s settle refetches under a queued save`);
      else if (counted === "saveKey(key)") {
        const patched =
          /patchRules\(\s*queryClient,\s*([^,]+?),\s*config,?\s*\)/.exec(
            members.onMutate.masked,
          );
        if (
          !/\bsaveQueued\(queryClient, ctx\.key\)/.test(settle) ||
          !patched ||
          own !== `saveKey(${patched[1].trim()})`
        )
          problems.push(`${where} counts saves under another key`);
      } else if (counted !== own)
        problems.push(`${where} counts saves under another key`);
    }
  }
  if (hooks !== 4) problems.push(`expected 4 save hooks, found ${hooks}`);
  return problems;
}

/** The mutation key a settle counts in-flight saves under (`isMutating(…) > 1`),
 *  read in its code or in a same-file function it calls; null when none. */
function queuedKey(masked, code) {
  const count = /\bisMutating\(\{\s*mutationKey:\s*([^{}]+?)\s*\}\)\s*>\s*1\b/;
  const direct = count.exec(code);
  if (direct) return direct[1];
  for (const call of code.matchAll(/(?<![\w$.])([\w$]+)\(/g)) {
    const body = functionBody(masked, call[1]);
    const via = body && count.exec(masked.slice(body[0], body[1]));
    if (via) return via[1];
  }
  return null;
}

/** Problems with the repo-override patch's fold, `[]` when pinned: it drops
 *  the raw-path twin, keeps the override only when it holds a cell, and keys it
 *  by the identity the cache resolved (else the raw path), as the store does. */
function foldProblems(queries, store) {
  const problems = [];
  const masked = maskNonCode(queries, false);
  const fold = functionBody(masked, "withRepoOverride");
  if (!fold) return ["withRepoOverride not found"];
  const body = masked.slice(fold[0], fold[1]);
  if (!/if \(identity !== repoPath\) delete repos\[repoPath\];/.test(body))
    problems.push("the patch keeps the raw-path twin");
  if (
    !/const hasCells = Object\.values\(repo\.lifecycles\)\.some\(\s*\(actions\) => actions && Object\.keys\(actions\)\.length > 0,?\s*\);/.test(
      body,
    )
  )
    problems.push("the patch's has-cells test drifted from the store's");
  if (
    !/if \(hasCells\) repos\[identity\] = repo;\s*else delete repos\[identity\];/.test(
      body,
    )
  )
    problems.push("the patch doesn't delete an override with no cells");
  if (
    !/const identity =\s*queryClient\.getQueryData<string>\(\s*repoIdentityQueryOptions\(repoPath\)\.queryKey,?\s*\) \?\? repoPath;[\s\S]*withRepoOverride\(snapshot, identity, repoPath, repo\)/.test(
      masked,
    )
  )
    problems.push("the patch doesn't key by the cached identity");
  const s = maskNonCode(store, false);
  if (!/if \(id !== repoPath\) delete repos\[repoPath\];/.test(s))
    problems.push("the store's raw-path drop moved: re-check the patch");
  if (
    !/if \(repoHasCells\(repo\)\) \{\s*repos\[id\] = repo;\s*\} else \{\s*delete repos\[id\];/.test(
      s,
    )
  )
    problems.push(
      "the store's empty-override delete moved: re-check the patch",
    );
  const has = functionBody(s, "repoHasCells");
  if (
    !has ||
    !/Object\.keys\(actions\)\.length > 0/.test(s.slice(has[0], has[1]))
  )
    problems.push("the store's has-cells test moved: re-check the patch");
  return problems;
}

/** Problems with the Automations panel's save, `[]` when pinned: one entry
 *  that joins a write of the same sanitized draft, starts one write otherwise
 *  with its one failure toast in that write's rejection handler (described by
 *  whether the draft is still on screen when it settles: the panel mounted and
 *  no Discard reconcile pending), and clears the latch compare-and-clear. */
function joinProblems(text) {
  const masked = maskNonCode(text, true);
  const save = functionBody(masked, "doSave");
  if (!save) return ["doSave not found"];
  const body = masked.slice(save[0], save[1]);
  const raw = text.slice(save[0], save[1]);
  const problems = [];
  const join =
    /const lifecycles = sanitizeLifecycles\(draft\);\s*const json = sortedJson\(lifecycles\);\s*const pending = pendingSave\.current;\s*if \(pending\?\.json === json\) return pending\.promise;/.exec(
      body,
    );
  const write = body.indexOf(".mutateAsync(");
  if (!join || write === -1 || join.index > write)
    problems.push(
      "a save of the same draft no longer joins the write in flight",
    );
  if (!/pendingSave\.current = entry;/.test(body))
    problems.push("the write in flight isn't latched");
  if (
    !/if \(pendingSave\.current === entry\) \{\s*pendingSave\.current = null;/.test(
      body,
    )
  )
    problems.push("the latch isn't cleared compare-and-clear");
  if ((masked.match(/\btoastComposedError\(/g) ?? []).length !== 1)
    problems.push("expected one failure toast in the panel");
  if (/\btoastError\b|\.catch\(/.test(body))
    problems.push("the save attaches a second failure handler");
  const handler =
    /\.then\(\s*\(\) => true,\s*\(e: unknown\) => \{([\s\S]*?)return false;\s*\},?\s*\)/.exec(
      body,
    );
  if (!handler || !handler[1].includes("toastComposedError("))
    problems.push("the failure toast isn't in the write's rejection handler");
  const description = new RegExp(
    `description:\\s*mounted\\.current && pendingDiscard\\.current === null\\s*\\?\\s*"${STILL_HERE.replace(/\./g, "\\.")}"\\s*:\\s*"${NOT_SAVED.replace(/\./g, "\\.")}"`,
  );
  if (!description.test(raw))
    problems.push(
      "the failure isn't described by the panel still being mounted",
    );
  if (
    !raw.includes(
      "title: `Couldn't save automations: ${presentError(e).summary}`",
    )
  )
    problems.push("the failure toast lost its title");
  if (
    !/if \(ok && !opts\?\.quiet\) toast\.success\("Automations saved"\);/.test(
      raw,
    )
  )
    problems.push("the success toast lost its copy or its quiet gate");
  return problems;
}

/** Problems with a dialog's failed-save toast, `[]` when pinned: doSave's
 *  catch shows one titled toast described by the submitting session still
 *  being open, and nothing bare. */
function dialogToastProblems(text, title) {
  const masked = maskNonCode(text, true);
  const save = functionBody(masked, "doSave");
  if (!save) return ["doSave not found"];
  const body = masked.slice(save[0], save[1]);
  const raw = text.slice(save[0], save[1]);
  const problems = [];
  if (/\btoastError\(/.test(body)) problems.push("a bare toastError is back");
  if ((body.match(/\btoastComposedError\(/g) ?? []).length !== 1)
    problems.push("expected one titled failure toast");
  if (!raw.includes(title)) problems.push("the failure toast lost its title");
  const description = new RegExp(
    `description:\\s*submitted !== null && session\\.current === submitted\\s*\\?\\s*"${STILL_HERE.replace(/\./g, "\\.")}"\\s*:\\s*"${NOT_SAVED.replace(/\./g, "\\.")}"`,
  );
  if (!description.test(raw))
    problems.push("the failure isn't described by the submitting session");
  return problems;
}

/** Problems with BranchRules' scope reseed, `[]` when pinned: it runs during
 *  render, directly in the component body, latched by a scope held in state,
 *  and is the only place the draft takes the active scope's data. */
function reseedProblems(text) {
  const masked = maskNonCode(text, true);
  const component = functionBody(masked, "BranchRulesDialog");
  if (!component) return ["BranchRulesDialog not found"];
  const problems = [];
  const reseed =
    /if \(open && active\.data && seededScope !== scope\) \{\s*setSeededScope\(scope\);\s*setDraft\(active\.data\);\s*\}/.exec(
      masked,
    );
  if (!reseed) return ["the scope reseed lost its shape"];
  let depth = 0;
  for (let i = component[0] + 1; i < reseed.index; i++) {
    if (OPEN.has(masked[i])) depth++;
    else if (CLOSE.has(masked[i])) depth--;
  }
  if (depth !== 0)
    problems.push("the scope reseed no longer runs during render");
  if (
    !/const \[seededScope, setSeededScope\] = useState<typeof scope \| null>\(null\);/.test(
      masked,
    )
  )
    problems.push("the reseed's scope latch isn't held in state");
  if ((masked.match(/\bsetDraft\(active\.data\)/g) ?? []).length !== 1)
    problems.push("the draft takes the scope's data somewhere else too");
  return problems;
}

/** Asserts `check` passes the real `text` and fails every `mutate(text)`. */
function pin(check, text, ...mutations) {
  assert.deepEqual(check(text), []);
  for (const mutate of mutations) {
    const mutant = mutate(text);
    assert.notEqual(mutant, text, "the mutation didn't apply");
    assert.ok(check(mutant).length > 0, "the scan passed a mutated source");
  }
}

/** `s` with `from` replaced exactly once. */
const once = (from, to) => (s) => s.replace(from, () => to);

test("every rules save hook patches at mutate time and rolls back only its own patch", () => {
  const files = new Map([
    [AUTO_QUERIES, source(AUTO_QUERIES)],
    [RULES_QUERIES, source(RULES_QUERIES)],
  ]);
  const check = (f) => saveHookProblems(f);
  assert.deepEqual(check(files), []);
  const mutated = (rel, mutate) => {
    const next = new Map(files);
    const mutant = mutate(next.get(rel));
    assert.notEqual(mutant, next.get(rel), "the mutation didn't apply");
    next.set(rel, mutant);
    return next;
  };
  for (const [rel, mutate] of [
    // The dead-code guard: ctx holding the passed config, not the read-back.
    [
      RULES_QUERIES,
      once(
        "    optimistic: queryClient.getQueryData<BranchRulesConfig>(key),",
        "    optimistic: config,",
      ),
    ],
    [
      AUTO_QUERIES,
      once(
        "        optimistic:\n          queryClient.getQueryData<AutomationsConfigV2>(automationsKey),\n      };\n    },\n    onError: (_e, _config, ctx)",
        "        optimistic: config,\n      };\n    },\n    onError: (_e, _config, ctx)",
      ),
    ],
    // Read before the patch lands.
    [
      RULES_QUERIES,
      once(
        "  queryClient.setQueryData<BranchRulesConfig>(key, config);\n  return {\n    key,\n    snapshot,\n    optimistic: queryClient.getQueryData<BranchRulesConfig>(key),\n  };",
        "  const optimistic = queryClient.getQueryData<BranchRulesConfig>(key);\n  queryClient.setQueryData<BranchRulesConfig>(key, config);\n  return { key, snapshot, optimistic };",
      ),
    ],
    // An unguarded rollback.
    [
      RULES_QUERIES,
      once(
        "  if (ctx && queryClient.getQueryData(ctx.key) === ctx.optimistic)\n",
        "  if (ctx)\n",
      ),
    ],
    [
      AUTO_QUERIES,
      once(
        "      if (ctx && queryClient.getQueryData(automationsKey) === ctx.optimistic)\n",
        "      if (ctx)\n",
      ),
    ],
    // No patch at all (the pre-fix shape).
    [
      AUTO_QUERIES,
      once(
        "      queryClient.setQueryData<AutomationsConfigV2>(\n        automationsKey,\n        withRepoOverride(snapshot, identity, repoPath, repo),\n      );\n",
        "",
      ),
    ],
    // The settle invalidation dropped.
    [
      RULES_QUERIES,
      once(
        "        : queryClient.invalidateQueries({ queryKey: BRANCH_RULES_FAMILY }),",
        "        : undefined,",
      ),
    ],
    // A queued save's settle refetching over the next save's patch.
    [
      RULES_QUERIES,
      once(
        "      ctx && saveQueued(queryClient, ctx.key)\n        ? undefined\n        : queryClient.invalidateQueries",
        "      queryClient.invalidateQueries",
      ),
    ],
    [RULES_QUERIES, once("      !saveQueued(queryClient, ctx.key) &&\n", "")],
    [
      AUTO_QUERIES,
      once(
        "  if (queryClient.isMutating({ mutationKey: saveAutomationsKey }) > 1) return;\n",
        "",
      ),
    ],
    // Counting saves under a key the hook doesn't carry, or no key at all.
    [
      RULES_QUERIES,
      once(
        "    mutationKey: saveKey(sharedBranchRulesKey(repo)),",
        "    mutationKey: saveKey(branchRulesKey(repo)),",
      ),
    ],
    [AUTO_QUERIES, once("    mutationKey: saveAutomationsKey,\n", "")],
    // A cancel without its refetch partner, or the refetch without the cancel.
    [
      RULES_QUERIES,
      once("  await queryClient.cancelQueries({ queryKey: key });\n", ""),
    ],
  ])
    assert.ok(
      check(mutated(rel, mutate)).length > 0,
      `the scan passed a mutated ${rel}`,
    );
});

test("the repo-override patch folds the way the store's write does", () => {
  const store = source(AUTO_STORE);
  pin(
    (q) => foldProblems(q, store),
    source(AUTO_QUERIES),
    once("  if (identity !== repoPath) delete repos[repoPath];\n", ""),
    once(
      "  if (hasCells) repos[identity] = repo;",
      "  if (!hasCells) repos[identity] = repo;",
    ),
    once("        ) ?? repoPath;", "        ) ?? identityFallback;"),
  );
  assert.ok(
    foldProblems(
      source(AUTO_QUERIES),
      store.replace("    if (id !== repoPath) delete repos[repoPath];\n", ""),
    ).length > 0,
    "the scan passed a store whose fold moved",
  );
});

test("the Automations save joins a write of the same draft and toasts once per write", () => {
  pin(
    joinProblems,
    source(SECTION),
    once("      if (pending?.json === json) return pending.promise;\n", ""),
    once("return pending.promise;", "return Promise.resolve(true);"),
    once(
      "                mounted.current && pendingDiscard.current === null\n",
      "                true && pendingDiscard.current === null\n",
    ),
    // A Discard made during the save is about to put the stored rules back.
    once(
      "                mounted.current && pendingDiscard.current === null\n",
      "                mounted.current\n",
    ),
    once(
      "        );\n      const entry = { json, promise };",
      "        );\n      void promise.catch(toastError);\n      const entry = { json, promise };",
    ),
    once(
      "        if (pendingSave.current === entry) {",
      "        if (pendingSave.current !== null) {",
    ),
    once("if (ok && !opts?.quiet) toast.success", "if (ok) toast.success"),
  );
});

test("both rules dialogs title their failed saves by what survived", () => {
  pin(
    (t) =>
      dialogToastProblems(
        t,
        "title: `Couldn't save repository automations: ${presentError(e).summary}`",
      ),
    source(REPO_DIALOG),
    once(
      "      toastComposedError({\n        title: `Couldn't save repository automations",
      "      toastError(e);\n      toastComposedError({\n        title: `Couldn't save repository automations",
    ),
    once(
      '          submitted !== null && session.current === submitted\n            ? "Your changes are still here',
      '          true\n            ? "Your changes are still here',
    ),
  );
  pin(
    (t) =>
      dialogToastProblems(
        t,
        'title: `Couldn\'t save ${savedShared ? "shared branch rules" : "branch rules"}: ${presentError(e).summary}`',
      ),
    source(RULES_DIALOG),
    once(
      'savedShared ? "shared branch rules" : "branch rules"',
      '"branch rules"',
    ),
    once(
      '          submitted !== null && session.current === submitted\n            ? "Your changes are still here',
      '          mounted\n            ? "Your changes are still here',
    ),
  );
});

test("BranchRules reseeds a scope switch during render", () => {
  pin(
    reseedProblems,
    source(RULES_DIALOG),
    // The effect-driven seed (one frame of the other scope's draft).
    once(
      "  if (open && active.data && seededScope !== scope) {\n    setSeededScope(scope);\n    setDraft(active.data);\n  }\n",
      "  useLayoutEffect(() => {\n  if (open && active.data && seededScope !== scope) {\n    setSeededScope(scope);\n    setDraft(active.data);\n  }\n  }, [open, active.data, seededScope, scope]);\n",
    ),
    once(
      "  const [seededScope, setSeededScope] = useState<typeof scope | null>(null);",
      "  const seededScopeRef = useRef<typeof scope | null>(null);\n  const seededScope = seededScopeRef.current;\n  const setSeededScope = (s: typeof scope) => { seededScopeRef.current = s; };",
    ),
    once(
      "      sessionScope.current = seededScope;\n",
      "      sessionScope.current = seededScope;\n      if (active.data) setDraft(active.data);\n",
    ),
  );
});
