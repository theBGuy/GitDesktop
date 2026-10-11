// Static ratchet for plugin-store read-modify-write locking.
//
// Heuristics: after ts-mask removes comments, strings, regexes, and JSX text,
// store writes are plausible-receiver `set/delete/save/clear/reset` calls plus
// direct `foldIdentityKey` calls; named helper functions are followed through
// direct call sites, and a lock callback is the arrow argument body or expression
// up to withAppStoreLock's closing parenthesis. Reloads are the shared reload
// helper, a plausible-receiver `.reload()`, or a local helper whose body contains
// one. Static scanning deliberately does not reason about dead branches.
//
// This deliberately does not see dynamic store names, cross-module write
// helpers, aliased receivers (`const s = store`), `.bind()` calls, or computed
// members. The alias is a documented static-scan blind spot.
// generic plugin-store loader is scanned as a write-free infrastructure module.
// Exemptions pin these shapes: analytics owns one idempotent `distinct_id` key;
// plan/research/notifications persist zustand whole-state snapshots; review
// notes uses Rust commands except for its COLD_START plugin-store fallback.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  lineOf,
  maskNonCode,
  matchBrace,
  ScanError,
  sourceFiles,
} from "./lib/ts-mask.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const LOCK_HELPER = "src/lib/app-store-lock.ts";
const INFRASTRUCTURE = "src/lib/plugin-store.ts";
const DYNAMIC_MIGRATOR = "src/lib/repo-data-migration.ts";

const ADOPTED = new Set([
  "src/features/sessions/agentNumber.ts",
  "src/lib/ai/own-digest-store.ts",
  "src/lib/automations/dismissals.ts",
  "src/lib/automations/history.ts",
  "src/lib/automations/results.ts",
  "src/lib/automations/store.ts",
  "src/lib/branch-rules/store.ts",
  "src/lib/conversation-filters/store.ts",
  "src/lib/issues/local.ts",
  "src/lib/jira/store.ts",
  "src/lib/notifications/overrides.ts",
  "src/lib/pulls/local.ts",
  "src/lib/pulls/review-drafts.ts",
  "src/lib/pulls/reviews-history.ts",
  "src/lib/repo-lens/store.ts",
  "src/lib/scripts/store.ts",
  "src/lib/settings/api.ts",
]);

const EXEMPT = new Map([
  ["src/lib/analytics/posthog.ts", "single-key analytics"],
  ["src/features/plan/persistence.ts", "zustand whole-state persistence"],
  ["src/features/research/persistence.ts", "zustand whole-state persistence"],
  ["src/lib/stores/notifications.ts", "zustand whole-state persistence"],
  ["src/lib/review-notes/store.ts", "Rust writer with COLD_START fallback"],
]);

// These are measured from the current tree. A deletion or an unlisted opener
// must make the guard red instead of silently shrinking its proof surface.
const MIN_SCANNED = 24;
const MIN_ADOPTED = 17;

const MUTATION_KINDS = new Set(["set", "delete", "clear", "reset", "fold"]);
const STORE_METHOD_PATTERN =
  /(?<![\w$.])store\s*\.\s*(set|delete|save|clear|reset)\s*\(|\(\s*await\s+[A-Za-z_$][\w$]*\s*\(\s*\)\s*\)\s*\.\s*(set|delete|save|clear|reset)\s*\(/g;
const STORE_RELOAD_PATTERN =
  /(?<![\w$.])store\s*\.\s*reload\s*\(|\(\s*await\s+[A-Za-z_$][\w$]*\s*\(\s*\)\s*\)\s*\.\s*reload\s*\(/g;
const FOLD_PATTERN = /\bfoldIdentityKey\s*(?:<[^>]*>)?\s*\(/g;

function hasStoreReload(text) {
  STORE_RELOAD_PATTERN.lastIndex = 0;
  return STORE_RELOAD_PATTERN.test(text);
}

function storeReloadMatches(text) {
  STORE_RELOAD_PATTERN.lastIndex = 0;
  return [...text.matchAll(STORE_RELOAD_PATTERN)];
}

const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const rel = (file) => relative(ROOT, file).split("\\").join("/");

function matchingParen(masked, open) {
  const close = matchBrace(masked, open);
  if (close === -1)
    throw new ScanError(
      `unmatched call parenthesis at line ${lineOf(masked, open)}`,
    );
  return close;
}

function directLoadAliases(source, masked) {
  const aliases = new Set();
  const imports =
    /\bimport\s*\{([\s\S]*?)\}\s*from\s*(["'])@tauri-apps\/plugin-store\2/g;
  for (const match of source.matchAll(imports)) {
    if (masked.slice(match.index, match.index + 6) !== "import") continue;
    for (const item of match[1].split(",")) {
      const parts = item.trim().split(/\s+as\s+/);
      if (parts[0] === "load") aliases.add(parts[1] ?? "load");
    }
  }
  return aliases;
}

function storeOpeners(source, masked) {
  const openers = [];
  const memo = /\bmemoizedStoreLoader\s*\(/g;
  for (const match of masked.matchAll(memo)) {
    const before = masked.slice(Math.max(0, match.index - 40), match.index);
    if (/\bfunction\s*$/.test(before)) continue;
    openers.push(match.index);
  }
  for (const alias of directLoadAliases(source, masked)) {
    const call = new RegExp(`(?<![\\w$.])${escapeRe(alias)}\\s*\\(`, "g");
    for (const match of masked.matchAll(call)) openers.push(match.index);
  }
  return openers.sort((a, b) => a - b);
}

function parseFunctions(masked) {
  const functions = [];
  const patterns = [
    /(?:^|[^\w$])(?:(?:export|default)\s+)*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(?:<[^{}]*>)?\s*\([^{}]*\)\s*(?:\:\s*[^{}=]*)?\{/g,
    /(?:^|[^\w$])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^{}]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/g,
  ];
  for (const pattern of patterns) {
    for (const match of masked.matchAll(pattern)) {
      const name = match[1];
      const nameIndex = match.index + match[0].indexOf(name);
      const open = match.index + match[0].lastIndexOf("{");
      const close = matchBrace(masked, open);
      if (close === -1)
        throw new ScanError(
          `unmatched function body at line ${lineOf(masked, open)}`,
        );
      functions.push({ name, nameIndex, open, close });
    }
  }
  return functions;
}

function constantStrings(source, masked) {
  const bindings = new Map();
  for (const match of masked.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*/g)) {
    const name = match[1];
    const raw = source.slice(match.index + match[0].length);
    const literal = raw.match(/^(["'])([^"']+)\1/);
    if (!literal) continue;
    const values = bindings.get(name) ?? [];
    values.push(literal[2]);
    bindings.set(name, values);
  }
  return bindings;
}

function firstArgument(source, masked, open, close, constants) {
  const raw = source.slice(open + 1, close);
  const literal = raw.match(/^\s*(["'])([^"']+)\1/);
  if (literal) return literal[2];
  const identifier = masked
    .slice(open + 1, close)
    .match(/^\s*([A-Za-z_$][\w$]*)/);
  if (!identifier) return null;
  const values = constants.get(identifier[1]);
  return values?.length === 1 ? values[0] : null;
}

function lockCallbacks(source, masked) {
  const constants = constantStrings(source, masked);
  const callbacks = [];
  for (const match of masked.matchAll(/\bwithAppStoreLock\s*\(/g)) {
    const open = masked.indexOf("(", match.index);
    const close = matchingParen(masked, open);
    const arrow = masked.indexOf("=>", open + 1);
    if (arrow === -1 || arrow > close)
      throw new ScanError(
        `withAppStoreLock has no callback arrow at line ${lineOf(masked, match.index)}`,
      );
    let start = arrow + 2;
    while (/\s/.test(masked[start] ?? "")) start++;
    if (masked[start] === "{") {
      const bodyClose = matchBrace(masked, start);
      if (bodyClose === -1)
        throw new ScanError(
          `unmatched lock callback at line ${lineOf(masked, start)}`,
        );
      callbacks.push({
        start: start + 1,
        end: bodyClose,
        call: match.index,
        file: firstArgument(source, masked, open, close, constants),
      });
    } else {
      callbacks.push({
        start,
        end: close,
        call: match.index,
        file: firstArgument(source, masked, open, close, constants),
      });
    }
  }
  return callbacks;
}

function callsOf(name, masked, functions) {
  const calls = [];
  const pattern = new RegExp(`(?<![\\w$.])${escapeRe(name)}\\s*\\(`, "g");
  for (const match of masked.matchAll(pattern)) {
    if (
      functions.some((fn) => fn.name === name && fn.nameIndex === match.index)
    )
      continue;
    calls.push(match.index);
  }
  return calls;
}

function containingFunction(index, functions) {
  return functions
    .filter((fn) => index > fn.open && index < fn.close)
    .sort((a, b) => a.close - a.open - (b.close - b.open))[0];
}

function inCallback(index, callbacks) {
  return callbacks.some(
    (callback) => index >= callback.start && index < callback.end,
  );
}

function scanSource(source, file = "fixture.ts") {
  const masked = maskNonCode(source, file.endsWith(".tsx"));
  const openers = storeOpeners(source, masked);
  const infrastructure =
    file === INFRASTRUCTURE &&
    /\bfunction\s+memoizedStoreLoader\b/.test(masked);
  if (openers.length === 0 && !infrastructure)
    return {
      file,
      scanned: false,
      classification: null,
      writes: [],
      failures: [],
    };

  const functions = parseFunctions(masked);
  const callbacks = lockCallbacks(source, masked);
  const writes = [
    ...masked.matchAll(STORE_METHOD_PATTERN),
    ...masked.matchAll(FOLD_PATTERN),
  ]
    .map((match) => ({
      index: match.index,
      kind: match[1] ?? match[2] ?? "fold",
      line: lineOf(source, match.index),
    }))
    .sort((a, b) => a.index - b.index);
  const mutationEvents = writes.filter((write) =>
    MUTATION_KINDS.has(write.kind),
  );
  const writeFunctions = functions.filter((fn) =>
    mutationEvents.some(
      (write) => write.index > fn.open && write.index < fn.close,
    ),
  );
  const reloadFunctions = functions.filter(
    (fn) =>
      masked.slice(fn.open, fn.close).includes("reloadToleratingEmptyStore") ||
      hasStoreReload(masked.slice(fn.open, fn.close)),
  );

  const functionProtected = new Map();
  const checking = new Set();
  const isProtected = (fn) => {
    if (!fn) return false;
    if (functionProtected.has(fn)) return functionProtected.get(fn);
    if (checking.has(fn)) return false;
    checking.add(fn);
    const calls = callsOf(fn.name, masked, functions);
    const protectedEverywhere =
      calls.length > 0 &&
      calls.every((call) => {
        const caller = containingFunction(call, functions);
        return inCallback(call, callbacks) || (caller && isProtected(caller));
      });
    checking.delete(fn);
    functionProtected.set(fn, protectedEverywhere);
    return protectedEverywhere;
  };

  const summaryCache = new Map();
  const summarizing = new Set();
  const functionSummary = (fn) => {
    if (!fn) return { mutates: false, forcedSave: false };
    if (summaryCache.has(fn)) return summaryCache.get(fn);
    if (summarizing.has(fn)) return { mutates: true, forcedSave: false };
    summarizing.add(fn);
    const operations = [];
    for (const write of writes) {
      if (
        write.index > fn.open &&
        write.index < fn.close &&
        containingFunction(write.index, functions) === fn
      ) {
        operations.push({ index: write.index, kind: write.kind });
      }
    }
    for (const candidate of writeFunctions) {
      for (const call of callsOf(candidate.name, masked, functions)) {
        if (
          call > fn.open &&
          call < fn.close &&
          containingFunction(call, functions) === fn &&
          candidate !== fn
        ) {
          operations.push({ index: call, helper: candidate });
        }
      }
    }
    operations.sort((a, b) => a.index - b.index);
    let dirty = false;
    let mutates = false;
    for (const operation of operations) {
      if (operation.helper) {
        const child = functionSummary(operation.helper);
        if (!child.mutates) continue;
        mutates = true;
        dirty = !child.forcedSave;
      } else if (MUTATION_KINDS.has(operation.kind)) {
        mutates = true;
        dirty = true;
      } else if (operation.kind === "save") {
        dirty = false;
      }
    }
    const result = { mutates, forcedSave: mutates && !dirty };
    summarizing.delete(fn);
    summaryCache.set(fn, result);
    return result;
  };

  const callbackOperations = (callback) => {
    const operations = [];
    for (const write of writes) {
      if (write.index >= callback.start && write.index < callback.end) {
        operations.push({ index: write.index, kind: write.kind });
      }
    }
    for (const fn of writeFunctions) {
      for (const call of callsOf(fn.name, masked, functions)) {
        if (call >= callback.start && call < callback.end) {
          operations.push({ index: call, helper: fn });
        }
      }
    }
    return operations.sort((a, b) => a.index - b.index);
  };

  const failures = [];
  for (const write of writes) {
    const owner = containingFunction(write.index, functions);
    if (
      MUTATION_KINDS.has(write.kind) &&
      !inCallback(write.index, callbacks) &&
      !isProtected(owner)
    ) {
      failures.push({
        line: write.line,
        message: `${write.kind} write is outside a withAppStoreLock callback`,
      });
    }
  }

  for (const callback of callbacks) {
    const events = callbackOperations(callback).filter(
      (event) => event.helper || MUTATION_KINDS.has(event.kind),
    );
    const reloads = [];
    for (const match of storeReloadMatches(
      masked.slice(callback.start, callback.end),
    )) {
      reloads.push(callback.start + match.index);
    }
    for (const match of masked
      .slice(callback.start, callback.end)
      .matchAll(/\breloadToleratingEmptyStore\s*\(/g)) {
      reloads.push(callback.start + match.index);
    }
    for (const fn of reloadFunctions) {
      for (const call of callsOf(fn.name, masked, functions)) {
        if (call < callback.start || call >= callback.end) continue;
        const body = masked.slice(fn.open, fn.close);
        const firstMutation = mutationEvents
          .filter(
            (write) =>
              write.index > fn.open &&
              write.index < fn.close &&
              MUTATION_KINDS.has(write.kind),
          )
          .sort((a, b) => a.index - b.index)[0];
        if (
          !firstMutation ||
          body
            .slice(0, firstMutation.index - fn.open)
            .includes("reloadToleratingEmptyStore") ||
          hasStoreReload(body.slice(0, firstMutation.index - fn.open))
        ) {
          reloads.push(call);
        }
      }
    }
    const first = events[0];
    if (first && !reloads.some((reload) => reload <= first.index)) {
      failures.push({
        line: lineOf(source, first.index),
        message:
          "reloadToleratingEmptyStore() or .reload() must precede the first locked write",
      });
    }

    let dirty = false;
    for (const operation of callbackOperations(callback)) {
      if (operation.helper) {
        const summary = functionSummary(operation.helper);
        if (summary.mutates) {
          dirty = !summary.forcedSave;
        }
      } else if (MUTATION_KINDS.has(operation.kind)) {
        dirty = true;
      } else if (operation.kind === "save") {
        dirty = false;
      }
    }
    if (dirty) {
      const last = events.at(-1);
      failures.push({
        line: lineOf(source, last.index),
        message:
          "every locked mutation must be followed by store.save() before the lock releases",
      });
    }

    if (openers.length > 0) {
      const constants = constantStrings(source, masked);
      const openerFiles = openers.map((opener) => {
        const open = masked.indexOf("(", opener);
        const close = matchingParen(masked, open);
        return firstArgument(source, masked, open, close, constants);
      });
      const expected =
        openerFiles.length > 0 &&
        openerFiles.every((value) => value !== null && value === openerFiles[0])
          ? openerFiles[0]
          : null;
      if (expected === null || callback.file !== expected) {
        failures.push({
          line: lineOf(source, callback.call),
          message: `withAppStoreLock file must match the opener's file literal (${expected ?? "unresolved"})`,
        });
      }
    }
  }

  const classification = infrastructure
    ? "INFRASTRUCTURE_WRITE_FREE"
    : file === DYNAMIC_MIGRATOR
      ? "DYNAMIC_MIGRATOR"
      : EXEMPT.has(file)
        ? "EXEMPT"
        : ADOPTED.has(file)
          ? "ADOPTED"
          : writes.length === 0
            ? "UNLISTED_WRITE_FREE"
            : "UNLISTED";
  return {
    file,
    scanned: true,
    classification,
    writes,
    failures,
    source,
    masked,
    functions,
  };
}

function firstStoreArgument(source, write) {
  const open = source.indexOf("(", write.index);
  const match = source.slice(open + 1).match(/^\s*(["'])([^"']+)\1/);
  return match?.[2] ?? null;
}

function exemptionFailure(file, result) {
  const source = result.source;
  const masked = result.masked;
  const writes = result.writes;
  const expected = {
    "src/lib/analytics/posthog.ts": {
      count: 2,
      functions: ["getDistinctId", "resetAnalyticsId"],
    },
    "src/features/plan/persistence.ts": {
      count: 1,
      functions: ["savePersistedPlans"],
    },
    "src/features/research/persistence.ts": {
      count: 1,
      functions: ["savePersistedResearch"],
    },
    "src/lib/stores/notifications.ts": { count: 1, functions: ["persist"] },
    "src/lib/review-notes/store.ts": {
      count: 3,
      functions: ["writeBranchToStore"],
    },
  }[file];
  const functions = result.functions ?? [];
  const actualFunctions = writes.map(
    (write) => containingFunction(write.index, functions)?.name ?? null,
  );
  if (
    !expected ||
    writes.length !== expected.count ||
    actualFunctions.some((name) => !expected.functions.includes(name)) ||
    new Set(actualFunctions).size !== expected.functions.length
  ) {
    return `${EXEMPT.get(file)} exemption pins exactly ${expected?.count ?? "the expected"} write events and their containing functions`;
  }
  if (file === "src/lib/analytics/posthog.ts") {
    if (
      writes.length !== 2 ||
      writes.some(
        (write) =>
          write.kind !== "set" ||
          firstStoreArgument(source, write) !== "distinct_id",
      )
    )
      return "analytics exemption pins exactly two store.set writes, both to distinct_id";
    return null;
  }
  if (file === "src/lib/review-notes/store.ts") {
    if (!masked.includes("COLD_START") || masked.includes("withAppStoreLock"))
      return "review-notes exemption pins the COLD_START-only plugin writer and no frontend lock path";
    const calls = [...masked.matchAll(/\bwriteBranchToStore\s*\(/g)];
    if (
      calls.length !== 2 ||
      !/if\s*\(\s*COLD_START\s*\)\s*\{?[\s\S]{0,180}\bwriteBranchToStore\s*\(/.test(
        masked,
      )
    )
      return "review-notes plugin-store writer must remain only under the COLD_START branch";
    if (
      !source.includes('"review_notes_set_branch"') ||
      !source.includes('"review_notes_delete_branch"')
    )
      return "review-notes non-cold path must retain both Rust writer commands";
    return null;
  }
  if (
    writes.some((write) => write.kind !== "set") ||
    masked.includes("withAppStoreLock")
  )
    return `${EXEMPT.get(file)} exemption pins whole-state store.set persistence without a frontend lock`;
  if (
    file === "src/lib/stores/notifications.ts" &&
    !masked.includes("useNotifStore.subscribe")
  )
    return "notifications exemption pins the zustand subscription persistence shape";
  if (
    file.endsWith("plan/persistence.ts") &&
    !masked.includes("savePersistedPlans")
  )
    return "plan exemption pins savePersistedPlans whole-state persistence";
  if (
    file.endsWith("research/persistence.ts") &&
    !masked.includes("savePersistedResearch")
  )
    return "research exemption pins savePersistedResearch whole-state persistence";
  return null;
}

function settingsShapeFailure(result) {
  const masked = result.masked;
  const start = masked.indexOf("function serializedRecentRepoWrite");
  if (start === -1)
    return "settings exemption shape lost serializedRecentRepoWrite";
  const open = masked.indexOf("{", start);
  const close = matchBrace(masked, open);
  if (close === -1)
    return "settings serializedRecentRepoWrite body is unreadable";
  const callbacks = lockCallbacks(result.source, masked).filter(
    (callback) => callback.file === "settings.json",
  );
  const wrapper = callbacks.find((callback) => {
    const body = masked.slice(callback.start, callback.end);
    return (
      callback.start > open &&
      callback.end < close &&
      /\bfn\s*\(/.test(body) &&
      body.includes("reloadToleratingEmptyStore") &&
      result.writes.some(
        (write) =>
          write.kind === "save" &&
          write.index >= callback.start &&
          write.index < callback.end,
      )
    );
  });
  if (!wrapper)
    return "settings chain wrapper must contain reload, fn(), and store.save() inside the settings lock callback";

  const setWrites = result.writes.filter((write) => write.kind === "set");
  if (
    setWrites.length !== 1 ||
    containingFunction(setWrites[0]?.index, result.functions)?.name !==
      "saveSettings"
  )
    return "settings API must contain exactly one store.set(), inside saveSettings";

  const serializedRanges = [];
  for (const call of callsOf(
    "serializedRecentRepoWrite",
    masked,
    result.functions,
  )) {
    const callOpen = masked.indexOf("(", call);
    serializedRanges.push({
      start: callOpen + 1,
      end: matchingParen(masked, callOpen),
    });
  }
  for (const call of callsOf("saveSettings", masked, result.functions)) {
    if (
      !serializedRanges.some((range) => call > range.start && call < range.end)
    )
      return "every saveSettings() call must be inside a serializedRecentRepoWrite() argument";
  }
  return null;
}

function scanTree() {
  const files = [...sourceFiles(SRC)];
  if (files.length === 0)
    throw new ScanError("src/ contains no TypeScript files");
  const scanned = [];
  const failures = [];
  for (const file of files) {
    const path = rel(file);
    const source = readFileSync(file, "utf8");
    let result;
    try {
      result = scanSource(source, path);
    } catch (error) {
      throw new ScanError(`${path}: ${error.message}`);
    }
    if (!result.scanned) continue;
    scanned.push(result);
    if (result.classification === "UNLISTED")
      failures.push(
        `${path}: store opener has writes but is neither adopted nor exempt`,
      );
    if (result.classification === "UNLISTED_WRITE_FREE")
      failures.push(`${path}: store opener is not listed as adopted or exempt`);
    const enforceSites =
      result.classification === "ADOPTED" && path !== "src/lib/settings/api.ts";
    if (enforceSites)
      for (const failure of result.failures)
        failures.push(`${path}:${failure.line}: ${failure.message}`);
    if (result.classification === "EXEMPT") {
      const failure = exemptionFailure(path, result);
      if (failure) failures.push(`${path}: ${failure}`);
    }
    if (path === "src/lib/settings/api.ts") {
      const failure = settingsShapeFailure(result);
      if (failure) failures.push(`${path}: ${failure}`);
    }
  }
  const paths = new Set(scanned.map((result) => result.file));
  for (const path of [...ADOPTED, ...EXEMPT.keys()])
    if (!paths.has(path))
      failures.push(
        `${path}: listed store module is missing from the scanned set`,
      );
  return {
    scanned,
    adopted: scanned.filter((result) => result.classification === "ADOPTED"),
    failures,
  };
}

function assertLockHelper() {
  assert.ok(existsSync(join(ROOT, LOCK_HELPER)), `${LOCK_HELPER} must exist`);
  const source = readFileSync(join(ROOT, LOCK_HELPER), "utf8");
  const masked = maskNonCode(source, false);
  assert.match(masked, /export\s+async\s+function\s+withAppStoreLock\b/);
  assert.equal((source.match(/app_store_lock_acquire/g) ?? []).length, 1);
  assert.equal((source.match(/app_store_lock_release/g) ?? []).length, 1);
  assert.match(
    source,
    /invoke(?:<[^>]+>)?\(\s*["']app_store_lock_acquire["']\s*,/,
  );
  assert.match(source, /invoke\(\s*["']app_store_lock_release["']\s*,/);
}

function assertCleanTreeScan() {
  assertLockHelper();
  const report = scanTree();
  assert.ok(
    report.scanned.length >= MIN_SCANNED,
    `scanned floor fell: ${report.scanned.length} < ${MIN_SCANNED}`,
  );
  assert.ok(
    report.adopted.length >= MIN_ADOPTED,
    `adopted floor fell: ${report.adopted.length} < ${MIN_ADOPTED}`,
  );
  assert.deepEqual(
    [...ADOPTED].filter(
      (path) => !report.adopted.some((result) => result.file === path),
    ),
    [],
    "every spec-listed adopted module must remain ADOPTED",
  );
  assert.deepEqual(report.failures, [], report.failures.join("\n"));
  return report;
}

test("app-store-lock scanner ratchet", () => {
  const report = assertCleanTreeScan();
  assert.ok(report.scanned.length >= MIN_SCANNED);
  assert.ok(report.adopted.length >= MIN_ADOPTED);
});

test("app-store-lock scanner has red fixtures", () => {
  const unlocked = scanSource(
    'const getStore = memoizedStoreLoader("fixture.json");\nasync function save() { const store = await getStore(); await store.set("x", 1); }',
    "src/lib/jira/store.ts",
  );
  assert.ok(
    unlocked.failures.some((failure) =>
      /outside a withAppStoreLock/.test(failure.message),
    ),
  );

  const staleOrder = scanSource(
    'const getStore = memoizedStoreLoader("fixture.json");\nasync function save() { const store = await getStore(); await withAppStoreLock("fixture.json", async () => { await store.set("x", 1); await store.reload(); await store.save(); }); }',
    "src/lib/jira/store.ts",
  );
  assert.ok(
    staleOrder.failures.some((failure) => /must precede/.test(failure.message)),
  );

  const masked = scanSource(
    `const getStore = memoizedStoreLoader("fixture.json");
// store.set("comment", 1); store.save();
const fake = "store.set('string', 1)";`,
    "src/lib/jira/store.ts",
  );
  assert.deepEqual(masked.failures, []);

  const renamed = scanSource(
    'const getStore = memoizedStoreLoader("fixture.json");\nasync function save() { const store = await getStore(); await withAppStoreLockX("fixture.json", async () => { await store.reload(); await store.set("x", 1); await store.save(); }); }',
    "src/lib/jira/store.ts",
  );
  assert.ok(
    renamed.failures.some((failure) =>
      /outside a withAppStoreLock/.test(failure.message),
    ),
  );

  const foldOutside = scanSource(
    'const getStore = memoizedStoreLoader("fixture.json");\nasync function keyFor() { return foldIdentityKey(store, "tag", "repo", "id", merge); }',
    "src/lib/jira/store.ts",
  );
  assert.ok(
    foldOutside.failures.some((failure) =>
      /outside a withAppStoreLock/.test(failure.message),
    ),
  );

  const foldBeforeReload = scanSource(
    'const getStore = memoizedStoreLoader("fixture.json");\nasync function save() { const store = await getStore(); await withAppStoreLock("fixture.json", async () => { await foldIdentityKey(store, "tag", "repo", "id", merge); await store.reload(); await store.save(); }); }',
    "src/lib/jira/store.ts",
  );
  assert.ok(
    foldBeforeReload.failures.some((failure) =>
      /must precede/.test(failure.message),
    ),
  );

  const missingSave = scanSource(
    'const getStore = memoizedStoreLoader("fixture.json");\nasync function save() { const store = await getStore(); await withAppStoreLock("fixture.json", async () => { await store.reload(); await store.set("x", 1); }); }',
    "src/lib/jira/store.ts",
  );
  assert.ok(
    missingSave.failures.some((failure) =>
      /followed by store\.save/.test(failure.message),
    ),
  );

  const parenthesized = scanSource(
    'const getStore = memoizedStoreLoader("fixture.json");\nasync function save() { await (await getStore()).set("x", 1); }',
    "src/lib/jira/store.ts",
  );
  assert.ok(
    parenthesized.failures.some((failure) =>
      /outside a withAppStoreLock/.test(failure.message),
    ),
  );

  const wrongReloadReceiver = scanSource(
    'const getStore = memoizedStoreLoader("fixture.json");\nasync function save() { const store = await getStore(); const other = await getStore(); await withAppStoreLock("fixture.json", async () => { await other.reload(); await store.set("x", 1); await store.save(); }); }',
    "src/lib/jira/store.ts",
  );
  assert.ok(
    wrongReloadReceiver.failures.some((failure) =>
      /must precede/.test(failure.message),
    ),
  );

  const wrongLockFile = scanSource(
    'const STORE_FILE = "fixture.json";\nconst getStore = memoizedStoreLoader(STORE_FILE);\nasync function save() { const store = await getStore(); await withAppStoreLock("other.json", async () => { await store.reload(); await store.set("x", 1); await store.save(); }); }',
    "src/lib/jira/store.ts",
  );
  assert.ok(
    wrongLockFile.failures.some((failure) =>
      /file must match/.test(failure.message),
    ),
  );

  const clearAndReset = scanSource(
    'const getStore = memoizedStoreLoader("fixture.json");\nasync function save() { const store = await getStore(); await store.clear(); await store.reset(); }',
    "src/lib/jira/store.ts",
  );
  assert.equal(
    clearAndReset.writes.filter((write) =>
      ["clear", "reset"].includes(write.kind),
    ).length,
    2,
  );

  const exemptionExtraWrite = scanSource(
    'const getStore = memoizedStoreLoader("analytics.json");\nasync function getDistinctId() { const store = await getStore(); await store.set("distinct_id", "a"); }\nasync function resetAnalyticsId() { const store = await getStore(); await store.set("distinct_id", "b"); }\nasync function unexpected() { const store = await getStore(); await store.set("distinct_id", "c"); }',
    "src/lib/analytics/posthog.ts",
  );
  assert.match(
    exemptionFailure("src/lib/analytics/posthog.ts", exemptionExtraWrite),
    /exactly 2 write events/,
  );

  const commentedExemptionPresence = scanSource(
    'const getStore = memoizedStoreLoader("review-notes.json");\n// COLD_START withAppStoreLock\nasync function writeBranchToStore() { const store = await getStore(); await store.delete("x"); await store.set("x", 1); await store.save(); }',
    "src/lib/review-notes/store.ts",
  );
  assert.match(
    exemptionFailure(
      "src/lib/review-notes/store.ts",
      commentedExemptionPresence,
    ),
    /COLD_START-only/,
  );

  const movedSettingsSave = scanSource(
    'const getStore = memoizedStoreLoader("settings.json");\nasync function saveSettings(value) { const store = await getStore(); await store.set("settings", value); }\nfunction serializedRecentRepoWrite(fn) { return withAppStoreLock("settings.json", async () => { const store = await getStore(); await reloadToleratingEmptyStore(store); await fn(); }); }',
    "src/lib/settings/api.ts",
  );
  assert.match(
    settingsShapeFailure(movedSettingsSave),
    /inside the settings lock callback/,
  );

  const directSettingsWrite = scanSource(
    'const getStore = memoizedStoreLoader("settings.json");\nasync function saveSettings(value) { const store = await getStore(); await store.set("settings", value); }\nfunction serializedRecentRepoWrite(fn) { return withAppStoreLock("settings.json", async () => { const store = await getStore(); await reloadToleratingEmptyStore(store); await fn(); await store.save(); }); }\nasync function direct() { const store = await getStore(); await store.set("other", value); }',
    "src/lib/settings/api.ts",
  );
  assert.match(
    settingsShapeFailure(directSettingsWrite),
    /exactly one store\.set/,
  );

  assert.throws(
    () => scanSource("const broken = 'unterminated", "fixture.ts"),
    ScanError,
  );
});

export { ADOPTED, EXEMPT, MIN_ADOPTED, MIN_SCANNED, scanSource, scanTree };

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const report = assertCleanTreeScan();
  process.stdout.write(
    `app-store-lock: OK (${report.scanned.length} scanned, ${report.adopted.length} adopted)\n`,
  );
}
