// Static ratchet for plugin-store read-modify-write locking.
//
// Heuristics: after ts-mask removes comments, strings, regexes, and JSX text,
// store writes are tracked `store`-receiver `set/delete/save/clear/reset` calls
// plus direct `foldIdentityKey` calls; named helper functions are followed through
// direct call sites, and a lock callback is the arrow argument body or expression
// up to withAppStoreLock's closing parenthesis. Static scanning deliberately does
// not reason about dead branches or positional conditional saves/reloads.
//
// The scanner deliberately does not resolve cross-module write helpers, method
// references (`keys.forEach(store.delete)`), `.bind()` calls, or computed members.
// It rejects tracked-store
// aliases and writes in statically ranged `setTimeout`, `queueMicrotask`, `.then`,
// `.on`, and returned-function callback shapes. Conditional saves, early returns
// before save, and conditional reloads remain positional blind spots. The dynamic
// migrator is exempt only from the literal lock-file comparison: it pins the same
// identifier expression at load and lock.
// The generic plugin-store loader is scanned as a write-free infrastructure module.
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
const MIN_SCANNED = 25;
const MIN_ADOPTED = 17;

const MUTATION_KINDS = new Set(["set", "delete", "clear", "reset", "fold"]);
const STORE_METHODS = "set|delete|save|clear|reset";
const STORE_METHOD_PATTERN = new RegExp(
  `(?<![\\w$.])store(?:\\s+as\\s+[^;,)]+)?\\s*\\)*\\s*(?:\\?\\.|!\\.|\\.)\\s*(${STORE_METHODS})\\s*\\(`,
  "g",
);
const STORE_RELOAD_PATTERN = new RegExp(
  `(?<![\\w$.])store(?:\\s+as\\s+[^;,)]+)?\\s*\\)*\\s*(?:\\?\\.|!\\.|\\.)\\s*reload\\s*\\(`,
  "g",
);
const FOLD_PATTERN = /\bfoldIdentityKey\s*(?:<[^>]*>)?\s*\(/g;
const LOCKED_CALLBACK_SHAPES =
  /\b(?:setTimeout|queueMicrotask)\s*\(|\.\s*(?:then|on)\s*\(/g;
const LOADER_IMPORT_SOURCES = [
  "@tauri-apps/plugin-store",
  "@/lib/plugin-store",
];

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

function loaderImports(source, masked) {
  const info = {
    scanned: false,
    load: new Set(),
    memo: new Set(),
    failures: [],
  };
  const imports =
    /\bimport\s+([\s\S]*?)\s+from\s*(["'])(@tauri-apps\/plugin-store|@\/lib\/plugin-store)\2/g;
  for (const match of source.matchAll(imports)) {
    if (masked.slice(match.index, match.index + 6) !== "import") continue;
    info.scanned = true;
    const clause = match[1].trim();
    const named = clause.match(/\{([\s\S]*)\}/)?.[1] ?? "";
    for (const item of named.split(",")) {
      const trimmed = item.trim();
      if (!trimmed || /^type\b/.test(trimmed)) continue;
      const parts = trimmed.split(/\s+as\s+/);
      const imported = parts[0].replace(/^type\s+/, "").trim();
      const local = parts[1]?.trim() ?? imported;
      if (imported === "load") {
        if (local !== imported)
          info.failures.push("aliased import of load is unsupported");
        else info.load.add(local);
      }
      if (imported === "memoizedStoreLoader") {
        if (local !== imported)
          info.failures.push(
            "aliased import of memoizedStoreLoader is unsupported",
          );
        else info.memo.add(local);
      }
    }
    if (/\*\s+as\s+[A-Za-z_$][\w$]*/.test(clause))
      info.failures.push("namespace import of a store loader is unsupported");
    if (!named && !/^\*\s+as\s+/.test(clause) && !/^type\b/.test(clause))
      info.failures.push("default import of a store loader is unsupported");
  }
  for (const match of source.matchAll(
    /\bimport\s*\(\s*["'](?:@tauri-apps\/plugin-store|@\/lib\/plugin-store)["']\s*\)/g,
  )) {
    if (masked.slice(match.index, match.index + 6).includes("import")) {
      info.scanned = true;
      info.failures.push("dynamic import of a store loader is unsupported");
    }
  }
  if (
    !info.scanned &&
    /\bexport\s+(?:\*|\{[\s\S]*\})\s+from\s*["'](?:@tauri-apps\/plugin-store|@\/lib\/plugin-store)["']/.test(
      source,
    )
  )
    info.scanned = true;
  return info;
}

function storeOpeners(source, masked, imports, functions) {
  const openers = [];
  const memoNames =
    imports.memo.size > 0 || !/\bmemoizedStoreLoader\b/.test(masked)
      ? imports.memo
      : new Set(["memoizedStoreLoader"]);
  const memo = new RegExp(
    `(?<![\\w$.])(?:${[...memoNames].map(escapeRe).join("|") || "(?!x)x"})\\s*\\(`,
    "g",
  );
  for (const match of masked.matchAll(memo)) {
    const before = masked.slice(Math.max(0, match.index - 40), match.index);
    if (/\bfunction\s*$/.test(before)) continue;
    openers.push(match.index);
  }
  const openerNames = new Set(imports.load);
  for (const fn of functions) {
    const body = masked.slice(fn.open, fn.close);
    if (
      [...imports.load].some((name) =>
        new RegExp(`\\b${escapeRe(name)}\\s*\\(`).test(body),
      )
    )
      openerNames.add(fn.name);
  }
  for (const name of openerNames) {
    const call = new RegExp(`(?<![\\w$.])${escapeRe(name)}\\s*\\(`, "g");
    for (const match of masked.matchAll(call)) {
      if (
        functions.some((fn) => fn.name === name && fn.nameIndex === match.index)
      )
        continue;
      openers.push(match.index);
    }
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
  const declarations = new Map();
  for (const match of masked.matchAll(
    /\b(?:const|let)\s+([A-Za-z_$][\w$]*)(?:\s*=\s*)?/g,
  )) {
    const hasInitializer = /=\s*$/.test(match[0]);
    const raw = source.slice(match.index + match[0].length);
    const literal = hasInitializer
      ? raw.match(/^(["'])([^"']+)\1(?=\s*(?:;|\r?\n|$))/)
      : null;
    const values = declarations.get(match[1]) ?? [];
    values.push(literal?.[2] ?? null);
    declarations.set(match[1], values);
  }
  const bindings = new Map();
  for (const [name, values] of declarations) {
    if (values.length === 1 && values[0] !== null)
      bindings.set(name, values[0]);
  }
  return bindings;
}

function firstArgumentText(source, masked, open, close) {
  let depth = 0;
  const args = masked.slice(open + 1, close);
  for (let i = 0; i < args.length; i++) {
    if ("([{<".includes(args[i])) depth++;
    else if (")]}>".includes(args[i])) depth--;
    else if (args[i] === "," && depth === 0)
      return source.slice(open + 1, open + 1 + i).trim();
  }
  return source.slice(open + 1, close).trim();
}

function firstArgument(source, masked, open, close, constants) {
  const raw = firstArgumentText(source, masked, open, close);
  const literal = raw.match(/^(["'])([^"']+)\1$/);
  if (literal) return literal[2];
  const identifier = raw.match(/^[A-Za-z_$][\w$]*$/);
  return identifier ? (constants.get(identifier[0]) ?? null) : null;
}

function lockCallbacks(source, masked) {
  const constants = constantStrings(source, masked);
  const callbacks = [];
  for (const match of masked.matchAll(/\bwithAppStoreLock\s*\(/g)) {
    const before = masked.slice(Math.max(0, match.index - 48), match.index);
    if (/\bfunction\s*$/.test(before) || /(?:const|let|var)\s*$/.test(before))
      continue;
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

function lockIdentity(source, masked, file) {
  const failures = [];
  if (file === LOCK_HELPER) return { valid: true, failures };
  let imported = false;
  for (const match of source.matchAll(
    /\bimport\s+([\s\S]*?)\s+from\s*(["'])([^"']+)\2/g,
  )) {
    if (masked.slice(match.index, match.index + 6) !== "import") continue;
    const named = match[1].match(/\{([\s\S]*)\}/)?.[1] ?? "";
    for (const item of named.split(",")) {
      const parts = item.trim().split(/\s+as\s+/);
      if (parts[0]?.trim() !== "withAppStoreLock") continue;
      if (parts[1] || match[3] !== "@/lib/app-store-lock")
        failures.push(
          "withAppStoreLock must be imported unaliased from @/lib/app-store-lock",
        );
      else imported = true;
    }
  }
  if (/\b(?:function|const|let|var)\s+withAppStoreLock\b/.test(masked))
    failures.push("withAppStoreLock must not be locally declared");
  if (
    /\bwithAppStoreLock\s*\(/.test(masked) &&
    !imported &&
    file !== LOCK_HELPER
  )
    failures.push(
      "withAppStoreLock must be imported from @/lib/app-store-lock",
    );
  return { valid: failures.length === 0 && imported, failures };
}

function openerBindings(source, masked, imports, functions) {
  const names = new Set(imports.load);
  const memoNames =
    imports.memo.size > 0 || !/\bmemoizedStoreLoader\b/.test(masked)
      ? imports.memo
      : new Set(["memoizedStoreLoader"]);
  const directLoads = [...imports.load];
  for (const fn of functions) {
    const body = masked.slice(fn.open, fn.close);
    if (
      directLoads.some((name) =>
        new RegExp(`\\b${escapeRe(name)}\\s*\\(`).test(body),
      )
    )
      names.add(fn.name);
  }
  for (const match of masked.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:[A-Za-z_$][\w$]*\s*)\(/g,
  )) {
    if (memoNames.has(match[0].match(/=\s*([A-Za-z_$][\w$]*)/)?.[1]))
      names.add(match[1]);
  }
  return names;
}

function awaitedBefore(masked, index, kind) {
  const prefix = masked.slice(Math.max(0, index - 40), index);
  return (
    /\bawait\s*$/.test(prefix) ||
    (kind === "fold" && /\breturn\s*$/.test(prefix))
  );
}

function callBodyRange(masked, index) {
  const open = masked.indexOf("(", index);
  return open === -1 ? null : { open, close: matchingParen(masked, open) };
}

function scanSource(source, file = "fixture.ts") {
  const masked = maskNonCode(source, file.endsWith(".tsx"));
  const imports = loaderImports(source, masked);
  const functions = parseFunctions(masked);
  const openers = storeOpeners(source, masked, imports, functions);
  const infrastructure =
    file === INFRASTRUCTURE &&
    /\bfunction\s+memoizedStoreLoader\b/.test(masked);
  const unsupportedOpenerShape =
    /\bnew\s+LazyStore\s*\(|\bStore\.load\s*\(/.test(masked);
  const scannedByImport = imports.scanned;
  if (
    openers.length === 0 &&
    !infrastructure &&
    !scannedByImport &&
    !unsupportedOpenerShape
  )
    return {
      file,
      scanned: false,
      classification: null,
      writes: [],
      failures: [],
    };

  const callbacks = lockCallbacks(source, masked);
  const identity = lockIdentity(source, masked, file);
  const bindings = openerBindings(source, masked, imports, functions);
  const foldMatches = [...masked.matchAll(FOLD_PATTERN)].filter(
    (match) =>
      !functions.some(
        (fn) =>
          fn.name === "foldIdentityKey" &&
          match.index >= fn.nameIndex &&
          match.index < fn.open,
      ),
  );
  const writes = [...masked.matchAll(STORE_METHOD_PATTERN), ...foldMatches]
    .map((match) => ({
      index: match.index,
      kind: match[1] ?? match[2] ?? "fold",
      line: lineOf(source, match.index),
    }))
    .sort((a, b) => a.index - b.index);
  const reloadEvents = [
    ...masked.matchAll(STORE_RELOAD_PATTERN),
    ...[...masked.matchAll(/\breloadToleratingEmptyStore\s*\(/g)].filter(
      (match) =>
        !/\bfunction\s*$/.test(
          masked.slice(Math.max(0, match.index - 32), match.index),
        ),
    ),
  ].map((match) => ({
    index: match.index,
    kind: "reload",
    helper: /reloadTolerating/.test(match[0]),
    line: lineOf(source, match.index),
  }));
  const structuralFailures = [...imports.failures];
  const wrongReceivers = new Set();
  const openerNamePattern = [...bindings].map(escapeRe).join("|");
  if (openerNamePattern) {
    for (const match of masked.matchAll(
      new RegExp(
        `\\b(const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*await\\s+(?:${openerNamePattern})\\s*\\(`,
        "g",
      ),
    )) {
      if (match[2] !== "store" || match[1] !== "const") {
        wrongReceivers.add(match[2]);
        structuralFailures.push(
          `opener result must be bound as const store (found ${match[2]})`,
        );
      }
    }
    const unbound = new RegExp(
      `\\(\\s*await\\s+(?:${openerNamePattern})\\s*\\([^)]*\\)\\s*\\)\\s*(?:\\?\\.|!\\.|\\.)\\s*(${STORE_METHODS}|reload)\\s*\\(`,
      "g",
    );
    for (const match of masked.matchAll(unbound)) {
      structuralFailures.push(
        "opener result must be bound as const store before member access",
      );
      writes.push({
        index: match.index,
        kind: match[1],
        line: lineOf(source, match.index),
      });
    }
  }
  for (const receiver of wrongReceivers) {
    const pattern = new RegExp(
      `(?<![\\w$.])${escapeRe(receiver)}\\s*(?:\\?\\.|!\\.|\\.)\\s*(${STORE_METHODS}|reload)\\s*\\(`,
      "g",
    );
    for (const match of masked.matchAll(pattern)) {
      structuralFailures.push(
        `untracked opener receiver ${receiver} is fail-closed`,
      );
      writes.push({
        index: match.index,
        kind: match[1],
        line: lineOf(source, match.index),
      });
    }
  }
  for (const match of masked.matchAll(
    /\bthis\s*\.\s*store\s*(?:\?\.|!\.|\.)\s*(set|delete|save|clear|reset|reload)\s*\(/g,
  )) {
    structuralFailures.push("this.store member access is fail-closed");
    writes.push({
      index: match.index,
      kind: match[1],
      line: lineOf(source, match.index),
    });
  }
  if (/\bstore\s*\[/.test(masked))
    structuralFailures.push("computed store members are fail-closed");
  for (const reload of reloadEvents.filter((event) => event.helper)) {
    const open = masked.indexOf("(", reload.index);
    const close = matchingParen(masked, open);
    const arg = firstArgumentText(source, masked, open, close);
    const valid =
      arg === "store" ||
      (openerNamePattern &&
        new RegExp(`^await\\s+(?:${openerNamePattern})\\s*\\([^)]*\\)$`).test(
          arg,
        ));
    if (!valid)
      structuralFailures.push(
        "reloadToleratingEmptyStore() must receive the tracked store binding",
      );
  }
  if (/\bnew\s+LazyStore\s*\(|\bStore\.load\s*\(/.test(masked))
    structuralFailures.push(
      "new LazyStore and Store.load openers are unsupported",
    );
  if (
    /\bexport\s+(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:memoizedStoreLoader|load)\s*\(/.test(
      masked,
    )
  )
    structuralFailures.push("exported loader call results are unsupported");
  if (
    /\bimport\s*\{[\s\S]*\bfoldIdentityKey\s+as\s+[A-Za-z_$][\w$]*/.test(masked)
  )
    structuralFailures.push("aliased import of foldIdentityKey is unsupported");
  if (identity.failures.length) structuralFailures.push(...identity.failures);
  writes.sort((a, b) => a.index - b.index);
  let unawaited;
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

  for (const fn of writeFunctions) {
    if (!isProtected(fn)) continue;
    const declarationPrefix = masked.slice(
      Math.max(0, fn.nameIndex - 24),
      fn.nameIndex,
    );
    if (/\bexport\s*$/.test(declarationPrefix))
      structuralFailures.push(
        `protected helper ${fn.name} must not be exported`,
      );
    for (const match of masked.matchAll(
      new RegExp(`\\b${escapeRe(fn.name)}\\b`, "g"),
    )) {
      if (match.index === fn.nameIndex) continue;
      const after = masked.slice(match.index + fn.name.length);
      const before = masked.slice(Math.max(0, match.index - 16), match.index);
      if (/^\s*\(/.test(after) || /\bfunction\s*$/.test(before)) continue;
      structuralFailures.push(
        `protected helper ${fn.name} has a non-call reference`,
      );
      break;
    }
  }

  unawaited = (
    infrastructure ? [...writes] : [...writes, ...reloadEvents]
  ).filter((event) => {
    if (awaitedBefore(masked, event.index, event.kind)) return false;
    if (event.kind !== "reload") return true;
    const owner = containingFunction(event.index, functions);
    return (
      inCallback(event.index, callbacks) ||
      (owner && reloadFunctions.includes(owner) && isProtected(owner))
    );
  });

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

  const mutationCallback = callbacks.some((callback) =>
    callbackOperations(callback).some(
      (event) =>
        MUTATION_KINDS.has(event.kind) ||
        (event.helper && functionSummary(event.helper).mutates),
    ),
  );
  const adoptionReady =
    ADOPTED.has(file) &&
    identity.valid &&
    callbacks.length > 0 &&
    (mutationCallback ||
      (file === "src/lib/settings/api.ts" &&
        mutationEvents.some(
          (event) =>
            containingFunction(event.index, functions)?.name === "saveSettings",
        )));
  if (ADOPTED.has(file) && !adoptionReady)
    structuralFailures.push(
      "adopted module must contain an unaliased lock callback with a mutation event",
    );

  const failures = structuralFailures.map((message) => ({
    line: lineOf(source, 0),
    message,
  }));
  for (const event of unawaited) {
    failures.push({
      line: event.line,
      message: `${event.kind} must be awaited`,
    });
  }
  for (const write of writes) {
    const owner = containingFunction(write.index, functions);
    if (
      (MUTATION_KINDS.has(write.kind) || write.kind === "save") &&
      !inCallback(write.index, callbacks) &&
      !isProtected(owner)
    ) {
      failures.push({
        line: write.line,
        message: `${write.kind} write is outside a withAppStoreLock callback`,
      });
    }
  }
  for (const match of masked.matchAll(LOCKED_CALLBACK_SHAPES)) {
    const range = callBodyRange(masked, match.index);
    if (!range) continue;
    for (const event of writes) {
      if (event.index < range.open || event.index >= range.close) continue;
      const lock = callbacks.find(
        (callback) =>
          event.index >= callback.start && event.index < callback.end,
      );
      if (!lock || lock.start <= match.index)
        failures.push({
          line: event.line,
          message: `${event.kind} inside ${match[0].trim()} callback is fail-closed`,
        });
    }
  }
  for (const callback of callbacks) {
    const body = masked.slice(callback.start, callback.end);
    for (const match of body.matchAll(
      /\breturn\s+(?:async\s+)?(?:\([^{}]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/g,
    )) {
      const open = callback.start + match.index + match[0].lastIndexOf("{");
      const close = matchBrace(masked, open);
      if (close === -1) continue;
      for (const event of writes) {
        if (event.index > open && event.index < close)
          failures.push({
            line: event.line,
            message: `${event.kind} inside a function returned from a locked callback is fail-closed`,
          });
      }
    }
  }
  for (const event of writes) {
    const owner = containingFunction(event.index, functions);
    const lock = callbacks.find(
      (callback) => event.index >= callback.start && event.index < callback.end,
    );
    if (owner && lock && owner.open > lock.start) {
      const prefix = masked.slice(
        Math.max(lock.start, owner.open - 96),
        owner.open,
      );
      const returnedName = new RegExp(
        `\\breturn\\s+${escapeRe(owner.name)}\\b`,
      ).test(masked.slice(lock.start, lock.end));
      if (/\breturn\s*$/.test(prefix) || returnedName)
        failures.push({
          line: event.line,
          message: `${event.kind} inside a function returned from a locked callback is fail-closed`,
        });
    }
  }

  for (const callback of callbacks) {
    const events = callbackOperations(callback).filter(
      (event) => event.helper || MUTATION_KINDS.has(event.kind),
    );
    const reloads = reloadEvents
      .filter(
        (reload) =>
          reload.index >= callback.start &&
          reload.index < callback.end &&
          (!reload.helper ||
            (() => {
              const open = masked.indexOf("(", reload.index);
              const close = matchingParen(masked, open);
              const arg = firstArgumentText(source, masked, open, close);
              return (
                arg === "store" ||
                (openerNamePattern &&
                  new RegExp(
                    `^await\\s+(?:${openerNamePattern})\\s*\\([^)]*\\)$`,
                  ).test(arg))
              );
            })()),
      )
      .map((reload) => reload.index);
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

  if (infrastructure && writes.length !== 0)
    failures.push({
      line: lineOf(source, writes[0].index),
      message: "infrastructure module must contain zero store writes",
    });
  if (file === DYNAMIC_MIGRATOR) {
    for (const callback of callbacks) {
      const before = masked.slice(0, callback.call);
      const matches = [
        ...before.matchAll(/\bconst\s+store\s*=\s*await\s+loadStore\s*\(/g),
      ];
      const opener = matches.at(-1);
      if (!opener) {
        failures.push({
          line: lineOf(source, callback.call),
          message:
            "migrator lock must follow const store = await loadStore(...)",
        });
        continue;
      }
      const openerOpen = masked.indexOf("(", opener.index);
      const openerClose = matchingParen(masked, openerOpen);
      const lockOpen = masked.indexOf("(", callback.call);
      const lockClose = matchingParen(masked, lockOpen);
      const loadArg = firstArgumentText(
        source,
        masked,
        openerOpen,
        openerClose,
      );
      const lockArg = firstArgumentText(source, masked, lockOpen, lockClose);
      if (loadArg !== lockArg)
        failures.push({
          line: lineOf(source, callback.call),
          message:
            "migrator lock and loadStore arguments must be the same identifier",
        });
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
          : openers.length === 0
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
    identityValid: identity.valid,
    adoptionReady,
  };
}

function firstStoreArgument(source, write) {
  const masked = maskNonCode(source, false);
  const open = masked.indexOf("(", write.index);
  if (open === -1) return null;
  const close = matchingParen(masked, open);
  return firstArgument(
    source,
    masked,
    open,
    close,
    constantStrings(source, masked),
  );
}

function exemptionFailure(file, result) {
  const source = result.source;
  const masked = result.masked;
  const writes = result.writes;
  const functions = result.functions ?? [];
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
    const calls = callsOf("writeBranchToStore", masked, functions);
    const cold = masked.match(/if\s*\(\s*COLD_START\s*\)\s*\{/);
    const coldClose = cold
      ? matchBrace(masked, masked.indexOf("{", cold.index))
      : -1;
    if (
      calls.length !== 1 ||
      coldClose === -1 ||
      calls[0] < masked.indexOf("{", cold?.index ?? -1) ||
      calls[0] >= coldClose
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
    [
      "src/features/plan/persistence.ts",
      "src/features/research/persistence.ts",
      "src/lib/stores/notifications.ts",
    ].includes(file)
  ) {
    const pinned = expected.functions[0];
    const fn = functions.find((candidate) => candidate.name === pinned);
    if (!fn || /\bstore\s*\.\s*get\s*\(/.test(masked.slice(fn.open, fn.close)))
      return `${EXEMPT.get(file)} writer must contain zero store.get() reads`;
  }
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
    const reload = body.search(/\breloadToleratingEmptyStore\s*\(/);
    const fnCall = body.search(/\bfn\s*\(/);
    const save = body.search(/\bstore\s*\.\s*save\s*\(/);
    return (
      callback.start > open &&
      callback.end < close &&
      reload !== -1 &&
      fnCall !== -1 &&
      save !== -1 &&
      reload < fnCall &&
      fnCall < save
    );
  });
  if (!wrapper)
    return "settings chain wrapper must contain reload, fn(), and store.save() inside the settings lock callback";

  const setWrites = result.writes.filter((write) => write.kind === "set");
  if (
    setWrites.length !== 1 ||
    result.writes.some((write) => !["set", "save"].includes(write.kind)) ||
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
  for (const match of masked.matchAll(/\bsaveSettings\b/g)) {
    const after = masked.slice(match.index + "saveSettings".length);
    const declaration = result.functions.some(
      (fn) => fn.name === "saveSettings" && fn.nameIndex === match.index,
    );
    if (!declaration && !/^\s*\(/.test(after))
      return "saveSettings must not be referenced except as a call";
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
    const globalIdentity = lockIdentity(
      source,
      result.masked ?? maskNonCode(source, path.endsWith(".tsx")),
      path,
    );
    if (globalIdentity.failures.length && !result.scanned)
      for (const failure of globalIdentity.failures)
        failures.push(`${path}: ${failure}`);
    if (!result.scanned) continue;
    scanned.push(result);
    if (result.classification === "UNLISTED")
      failures.push(
        `${path}: store opener has writes but is neither adopted nor exempt`,
      );
    const enforceSites =
      result.classification === "ADOPTED" ||
      result.classification === "INFRASTRUCTURE_WRITE_FREE" ||
      result.classification === "DYNAMIC_MIGRATOR";
    if (enforceSites)
      for (const failure of result.failures) {
        if (
          result.classification === "DYNAMIC_MIGRATOR" &&
          /file must match the opener's file literal/.test(failure.message)
        )
          continue;
        if (
          result.classification === "ADOPTED" &&
          path === "src/lib/settings/api.ts" &&
          /outside a withAppStoreLock callback/.test(failure.message) &&
          (() => {
            const fn = result.functions.find(
              (candidate) => candidate.name === "saveSettings",
            );
            return (
              fn &&
              failure.line >= lineOf(result.source, fn.open) &&
              failure.line <= lineOf(result.source, fn.close)
            );
          })()
        )
          continue;
        failures.push(`${path}:${failure.line}: ${failure.message}`);
      }
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
    adopted: scanned.filter(
      (result) => result.classification === "ADOPTED" && result.adoptionReady,
    ),
    failures,
  };
}

function helperShapeFailure(source) {
  const masked = maskNonCode(source, false);
  const calls = [...masked.matchAll(/\binvoke(?:<[^>]+>)?\s*\(/g)];
  const methods = calls.map((match) => {
    const open = masked.indexOf("(", match.index);
    const close = matchingParen(masked, open);
    return firstArgumentText(source, masked, open, close);
  });
  if (!masked.match(/export\s+async\s+function\s+withAppStoreLock\b/))
    return "lock helper must export withAppStoreLock";
  if (
    methods.filter(
      (method) =>
        method === '"app_store_lock_acquire"' ||
        method === "'app_store_lock_acquire'",
    ).length !== 1
  )
    return "lock helper must contain one code acquire invoke";
  if (
    methods.filter(
      (method) =>
        method === '"app_store_lock_release"' ||
        method === "'app_store_lock_release'",
    ).length !== 1
  )
    return "lock helper must contain one code release invoke";
  const fn = masked.match(
    /export\s+async\s+function\s+withAppStoreLock\b[^\{]*\{/,
  );
  const open = fn ? masked.indexOf("{", fn.index) : -1;
  const close = open === -1 ? -1 : matchBrace(masked, open);
  if (open === -1 || close === -1) return "lock helper body is unreadable";
  const body = masked.slice(open, close);
  const early =
    body.match(/if\s*\(\s*COLD_START\s*\)\s*return\s+fn\s*\(\s*\)\s*;/g) ?? [];
  if (early.length !== 1)
    return "COLD_START must have exactly one early return fn()";
  const tryIndex = body.indexOf("try");
  if (
    tryIndex === -1 ||
    (body.slice(0, tryIndex).match(/\breturn\b/g) ?? []).length !== 1
  )
    return "COLD_START return must be the only early helper return";
  const finallyIndex = body.indexOf("finally");
  if (finallyIndex === -1) return "lock release must be inside finally";
  const finallyOpen = masked.indexOf("{", open + finallyIndex);
  const finallyClose =
    finallyOpen === -1 ? -1 : matchBrace(masked, finallyOpen);
  const release = methods.findIndex(
    (method) =>
      method === '"app_store_lock_release"' ||
      method === "'app_store_lock_release'",
  );
  const releaseIndex = calls[release]?.index ?? -1;
  if (
    finallyClose === -1 ||
    releaseIndex < finallyOpen ||
    releaseIndex >= finallyClose
  )
    return "app_store_lock_release must stay inside finally";
  return null;
}

function assertLockHelper() {
  assert.ok(existsSync(join(ROOT, LOCK_HELPER)), `${LOCK_HELPER} must exist`);
  const source = readFileSync(join(ROOT, LOCK_HELPER), "utf8");
  assert.equal(helperShapeFailure(source), null, helperShapeFailure(source));
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
    "fixture.ts",
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

  const receiverAlias = scanSource(
    'import { memoizedStoreLoader } from "@/lib/plugin-store"; import { withAppStoreLock } from "@/lib/app-store-lock"; const getStore = memoizedStoreLoader("jira.json"); async function save() { const s = await getStore(); await withAppStoreLock("jira.json", async () => { await s.clear(); await s.save(); }); }',
    "src/lib/jira/store.ts",
  );
  assert.match(
    receiverAlias.failures.map((failure) => failure.message).join("\n"),
    /bound as const store|untracked opener receiver/,
  );

  const adoptedNoLocks = scanSource(
    'import { memoizedStoreLoader } from "@/lib/plugin-store"; const getStore = memoizedStoreLoader("fixture.json"); async function save() { const store = await getStore(); }',
    "src/lib/jira/store.ts",
  );
  assert.match(
    adoptedNoLocks.failures[0]?.message ?? "",
    /adopted module must contain/,
  );

  const infrastructureWrite = scanSource(
    'import { load } from "@tauri-apps/plugin-store"; export function memoizedStoreLoader(file) { const store = load(file); return async () => { await store.set("x", 1); return store; }; }',
    "src/lib/plugin-store.ts",
  );
  assert.match(
    infrastructureWrite.failures.map((failure) => failure.message).join("\n"),
    /infrastructure module must contain zero store writes/,
  );

  const migratorUnlocked = scanSource(
    'import { load } from "@tauri-apps/plugin-store"; import { withAppStoreLock } from "@/lib/app-store-lock"; function loadStore(file) { return load(file); } async function migrate(file) { const store = await loadStore(file); await store.delete("x"); }',
    DYNAMIC_MIGRATOR,
  );
  assert.match(
    migratorUnlocked.failures.map((failure) => failure.message).join("\n"),
    /outside a withAppStoreLock/,
  );

  const settingsDelete = scanSource(
    'import { memoizedStoreLoader } from "@/lib/plugin-store"; import { withAppStoreLock } from "@/lib/app-store-lock"; const getStore = memoizedStoreLoader("settings.json"); async function saveSettings(value) { const store = await getStore(); await store.delete("settings"); } function serializedRecentRepoWrite(fn) { return withAppStoreLock("settings.json", async () => { const store = await getStore(); await reloadToleratingEmptyStore(store); await fn(); await store.save(); }); }',
    "src/lib/settings/api.ts",
  );
  assert.match(settingsShapeFailure(settingsDelete), /exactly one store\.set/);

  const settingsOrder = scanSource(
    'import { memoizedStoreLoader } from "@/lib/plugin-store"; import { withAppStoreLock } from "@/lib/app-store-lock"; const getStore = memoizedStoreLoader("settings.json"); async function saveSettings(value) { const store = await getStore(); await store.set("settings", value); } function serializedRecentRepoWrite(fn) { return withAppStoreLock("settings.json", async () => { const store = await getStore(); await store.save(); await fn(); await reloadToleratingEmptyStore(store); }); }',
    "src/lib/settings/api.ts",
  );
  assert.match(settingsShapeFailure(settingsOrder), /lock callback/);

  const settingsReference = scanSource(
    'import { memoizedStoreLoader } from "@/lib/plugin-store"; import { withAppStoreLock } from "@/lib/app-store-lock"; const getStore = memoizedStoreLoader("settings.json"); async function saveSettings(value) { const store = await getStore(); await store.set("settings", value); } const persist = saveSettings; function serializedRecentRepoWrite(fn) { return withAppStoreLock("settings.json", async () => { const store = await getStore(); await reloadToleratingEmptyStore(store); await fn(); await store.save(); }); }',
    "src/lib/settings/api.ts",
  );
  assert.match(
    settingsShapeFailure(settingsReference),
    /must not be referenced/,
  );

  const localLock = scanSource(
    'import { memoizedStoreLoader } from "@/lib/plugin-store"; const getStore = memoizedStoreLoader("fixture.json"); async function withAppStoreLock(file, fn) { return fn(); } async function save() { const store = await getStore(); await withAppStoreLock("fixture.json", async () => { await store.set("x", 1); await store.save(); }); }',
    "src/lib/jira/store.ts",
  );
  assert.match(
    localLock.failures.map((failure) => failure.message).join("\n"),
    /locally declared|must be imported/,
  );

  const foreignLock = scanSource(
    'import { memoizedStoreLoader } from "@/lib/plugin-store"; import { withAppStoreLock } from "./other-lock"; const getStore = memoizedStoreLoader("fixture.json"); async function save() { const store = await getStore(); await withAppStoreLock("fixture.json", async () => { await store.set("x", 1); await store.save(); }); }',
    "src/lib/jira/store.ts",
  );
  assert.match(
    foreignLock.failures.map((failure) => failure.message).join("\n"),
    /unaliased from/,
  );

  const commentedAcquire = `export async function withAppStoreLock(file, fn) { if (COLD_START) return fn(); // invoke("app_store_lock_acquire", {}) try { return await fn(); } finally { await invoke("app_store_lock_release", {}); } }`;
  assert.match(helperShapeFailure(commentedAcquire) ?? "", /one code acquire/);

  const plansGet = scanSource(
    'import { memoizedStoreLoader } from "@/lib/plugin-store"; const getStore = memoizedStoreLoader("plans.json"); async function savePersistedPlans(runs) { const store = await getStore(); await store.get("plans"); await store.set("plans", runs); }',
    "src/features/plan/persistence.ts",
  );
  assert.match(
    exemptionFailure("src/features/plan/persistence.ts", plansGet),
    /zero store\.get/,
  );

  const coldOutside = scanSource(
    'import { memoizedStoreLoader } from "@/lib/plugin-store"; const getStore = memoizedStoreLoader("review-notes.json"); async function writeBranchToStore(note) { const store = await getStore(); if (note === null) await store.delete("x"); else await store.set("x", 1); await store.save(); } async function write() { return writeBranchToStore(); } if (COLD_START) { writeBranchToStore(null); }',
    "src/lib/review-notes/store.ts",
  );
  assert.match(
    exemptionFailure("src/lib/review-notes/store.ts", coldOutside),
    /COLD_START branch/,
  );

  for (const literal of [
    '"x.json" + suffix',
    '"x.json".replace("x", "y")',
    "FILE",
  ]) {
    const suffix =
      literal === "FILE"
        ? 'const FILE = "x.json"; function shadow() { const FILE = pickOther(); }'
        : "";
    const anchored = scanSource(
      `import { memoizedStoreLoader } from "@/lib/plugin-store"; import { withAppStoreLock } from "@/lib/app-store-lock"; ${suffix} const getStore = memoizedStoreLoader(${literal}); async function save() { const store = await getStore(); await withAppStoreLock("x.json", async () => { await store.reload(); await store.set("x", 1); await store.save(); }); }`,
      "src/lib/jira/store.ts",
    );
    assert.match(
      anchored.failures.map((failure) => failure.message).join("\n"),
      /file literal/,
    );
  }

  const openerAlias = scanSource(
    'import { memoizedStoreLoader as mk } from "@/lib/plugin-store"; const getStore = mk("fixture.json");',
    "src/lib/jira/store.ts",
  );
  assert.match(
    openerAlias.failures.map((failure) => failure.message).join("\n"),
    /aliased import/,
  );
  const openerNamespace = scanSource(
    'import * as ps from "@tauri-apps/plugin-store"; const getStore = ps.load("fixture.json");',
    "src/lib/jira/store.ts",
  );
  assert.match(
    openerNamespace.failures.map((failure) => failure.message).join("\n"),
    /namespace import/,
  );
  for (const openerShape of [
    'import("@tauri-apps/plugin-store")',
    'new LazyStore("fixture.json")',
    'Store.load("fixture.json")',
    'export const getStore = memoizedStoreLoader("fixture.json")',
  ]) {
    const openerTripwire = scanSource(openerShape, "src/lib/jira/store.ts");
    assert.ok(
      openerTripwire.failures.length > 0,
      `${openerShape} must fail closed`,
    );
  }

  const receiverShapes = scanSource(
    'import { memoizedStoreLoader } from "@/lib/plugin-store"; import { withAppStoreLock } from "@/lib/app-store-lock"; const getStore = memoizedStoreLoader("fixture.json"); async function save() { const store = await getStore(); await withAppStoreLock("fixture.json", async () => { await store?.set("a", 1); await store!.delete("a"); await (store as any).set("a", 1); await this.store.set("a", 1); await store["set"]("a", 1); await (await getStore(r)).set("a", 1); await store.save(); }); }',
    "fixture.ts",
  );
  assert.match(
    receiverShapes.failures.map((failure) => failure.message).join("\n"),
    /fail-closed|opener result must be bound/,
  );

  const scheduledWrite = scanSource(
    'import { memoizedStoreLoader } from "@/lib/plugin-store"; import { withAppStoreLock } from "@/lib/app-store-lock"; const getStore = memoizedStoreLoader("fixture.json"); async function save() { const store = await getStore(); await withAppStoreLock("fixture.json", async () => { await store.reload(); await Promise.resolve().then(async () => { await store.set("x", 1); await store.save(); }); }); }',
    "fixture.ts",
  );
  assert.match(
    scheduledWrite.failures.map((failure) => failure.message).join("\n"),
    /inside \.\s*then|inside \.then/,
  );

  const foldAlias = scanSource(
    'import { memoizedStoreLoader } from "@/lib/plugin-store"; import { foldIdentityKey as fold } from "@/lib/git/repo-identity"; const getStore = memoizedStoreLoader("fixture.json"); async function save() { const store = await getStore(); await withAppStoreLock("fixture.json", async () => { await store.reload(); await fold(store, "x", a, b, merge); await store.save(); }); }',
    "src/lib/jira/store.ts",
  );
  assert.match(
    foldAlias.failures.map((failure) => failure.message).join("\n"),
    /aliased import of foldIdentityKey/,
  );

  const unawaitedSave = scanSource(
    'import { memoizedStoreLoader } from "@/lib/plugin-store"; import { withAppStoreLock } from "@/lib/app-store-lock"; const getStore = memoizedStoreLoader("fixture.json"); async function save() { const store = await getStore(); await withAppStoreLock("fixture.json", async () => { await store.reload(); await store.set("x", 1); void store.save(); }); }',
    "src/lib/jira/store.ts",
  );
  assert.match(
    unawaitedSave.failures.map((failure) => failure.message).join("\n"),
    /save must be awaited/,
  );

  const wrongReload = scanSource(
    'import { memoizedStoreLoader } from "@/lib/plugin-store"; import { withAppStoreLock } from "@/lib/app-store-lock"; const getStore = memoizedStoreLoader("fixture.json"); async function save() { const store = await getStore(); const other = await getStore(); await withAppStoreLock("fixture.json", async () => { await reloadToleratingEmptyStore(other); await store.set("x", 1); await store.save(); }); }',
    "src/lib/jira/store.ts",
  );
  assert.match(
    wrongReload.failures.map((failure) => failure.message).join("\n"),
    /tracked store binding|must precede/,
  );

  const protectedEscape = scanSource(
    'import { memoizedStoreLoader } from "@/lib/plugin-store"; import { withAppStoreLock } from "@/lib/app-store-lock"; const getStore = memoizedStoreLoader("fixture.json"); async function writeIt(store) { await store.set("x", 1); await store.save(); } async function save() { const store = await getStore(); await withAppStoreLock("fixture.json", async () => { await store.reload(); await writeIt(store); setTimeout(writeIt, 10); }); }',
    "src/lib/jira/store.ts",
  );
  assert.match(
    protectedEscape.failures.map((failure) => failure.message).join("\n"),
    /protected helper writeIt has a non-call reference/,
  );

  const returnedWrite = scanSource(
    'import { memoizedStoreLoader } from "@/lib/plugin-store"; import { withAppStoreLock } from "@/lib/app-store-lock"; const getStore = memoizedStoreLoader("fixture.json"); async function save() { const store = await getStore(); await withAppStoreLock("fixture.json", async () => { await store.reload(); return async () => { await store.set("x", 1); await store.save(); }; }); }',
    "src/lib/jira/store.ts",
  );
  assert.match(
    returnedWrite.failures.map((failure) => failure.message).join("\n"),
    /returned from a locked callback/,
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
