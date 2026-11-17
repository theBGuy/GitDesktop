// Pins GitLab's finished status conclusions across src-tauri/src/forge/gitlab.rs
// and src/features/actions/RunFilterChips.tsx, using STATUS_FACETS.gitlab from
// src/features/actions/run-filters.ts. A one-sided edit would give a filter a
// different label from its rows or leave a documented active status unpolled.
// Runs installless: Rust and TSX are source text, never imported.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { installSrcHooks } from "./lib/src-import-hooks.mjs";

const hooks = installSrcHooks();
after(() => hooks.deregister());
const { STATUS_FACETS } = await import("@/features/actions/run-filters");
const rust = readFileSync(
  new URL("../src-tauri/src/forge/gitlab.rs", import.meta.url),
  "utf8",
);
const ts = readFileSync(
  new URL("../src/features/actions/RunFilterChips.tsx", import.meta.url),
  "utf8",
);

const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, () => " ");

function rustArms(source) {
  const declarations = [...source.matchAll(/\bfn\s+map_ci_status\s*\(/g)];
  assert.equal(declarations.length, 1, "Rust function not found exactly once");
  const body = source.match(
    /\bfn\s+map_ci_status\s*\([^{}]*\{\s*let\s+\(status,\s*conclusion\)\s*=\s*match\s+s\s*\{([^{}]*)\}/,
  );
  assert.ok(body, "Rust match body not found");
  const compact = stripComments(body[1])
    .replace(/\s+/g, () => " ")
    .trim();
  const pattern =
    /("[a-z_]+"(?:\s*\|\s*"[a-z_]+")*|_)\s*=>\s*\(\s*"([a-z_]*)"\s*,\s*"([a-z_]*)"\s*\)\s*,/g;
  const arms = [...compact.matchAll(pattern)];
  assert.ok(arms.length > 0, "No Rust arms parsed");
  assert.equal(
    compact.replace(pattern, () => "").trim(),
    "",
    "Unreadable Rust match text",
  );
  const result = new Map();
  let wildcards = 0;
  for (const [, alternatives, lifecycle, conclusion] of arms) {
    if (alternatives === "_") {
      wildcards += 1;
      continue;
    }
    for (const [, name] of alternatives.matchAll(/"([a-z_]+)"/g)) {
      assert.ok(!result.has(name), `Duplicate Rust status: ${name}`);
      result.set(name, { lifecycle, conclusion });
    }
  }
  assert.equal(wildcards, 1, "Rust must retain one wildcard arm");
  assert.ok(result.size > 0, "No explicit Rust statuses parsed");
  return result;
}

function finishedTable(source) {
  const declarations = [
    ...source.matchAll(/\bconst\s+GITLAB_FINISHED_CONCLUSIONS\b/g),
  ];
  assert.equal(declarations.length, 1, "TS table not found exactly once");
  const table = source.match(
    /\bconst\s+GITLAB_FINISHED_CONCLUSIONS\s*:\s*Record<string,\s*string>\s*=\s*\{([^{}]*)\}\s*;/,
  );
  assert.ok(table, "TS table body not found");
  const body = stripComments(table[1]).trim();
  const pattern = /([a-z_]+)\s*:\s*"([a-z_]+)"\s*,/g;
  const entries = [...body.matchAll(pattern)];
  assert.ok(entries.length > 0, "No TS entries parsed");
  assert.equal(
    body.replace(pattern, () => "").trim(),
    "",
    "Unreadable TS table",
  );
  const result = new Map();
  for (const [, name, conclusion] of entries) {
    assert.ok(!result.has(name), `Duplicate TS status: ${name}`);
    result.set(name, conclusion);
  }
  return result;
}

function check(rustSource, tsSource) {
  const arms = rustArms(rustSource);
  const finished = finishedTable(tsSource);
  assert.ok(STATUS_FACETS.gitlab.length > 0, "No GitLab facets");
  for (const status of STATUS_FACETS.gitlab) {
    const arm = arms.get(status);
    assert.ok(arm, `No explicit Rust arm: ${status}`);
    if (arm.lifecycle === "completed") {
      assert.equal(
        finished.get(status),
        arm.conclusion,
        `Finished conclusion mismatch: ${status}`,
      );
    } else {
      assert.ok(!finished.has(status), `In-flight TS conclusion: ${status}`);
    }
  }
  for (const status of finished.keys()) {
    assert.ok(
      STATUS_FACETS.gitlab.includes(status),
      `Non-facet key: ${status}`,
    );
  }
}

function swap(source, anchor, replacement) {
  assert.ok(source.includes(anchor), `Missing mutation anchor: ${anchor}`);
  return source.replace(anchor, () => replacement);
}

test("GitLab facets have explicit arms and matching conclusions", () => {
  check(rust, ts);
});

test("the status pin rejects one-sided changes and unreadable sources", () => {
  const mutants = [
    [
      "Rust conclusion changed",
      swap(
        rust,
        '"success" => ("completed", "success"),',
        '"success" => ("completed", "failure"),',
      ),
      ts,
      /Finished conclusion mismatch: success/,
    ],
    [
      "TS conclusion changed",
      rust,
      swap(ts, 'success: "success",', 'success: "failure",'),
      /Finished conclusion mismatch: success/,
    ],
    [
      "TS entry removed",
      rust,
      swap(ts, 'failed: "failure",', ""),
      /Finished conclusion mismatch: failed/,
    ],
    [
      "TS in-flight entry added",
      rust,
      swap(
        ts,
        'success: "success",',
        'success: "success", pending: "pending",',
      ),
      /In-flight TS conclusion: pending/,
    ],
    [
      "active status completed without TS entry",
      swap(
        rust,
        '"pending" => ("pending", ""),',
        '"pending" => ("completed", "success"),',
      ),
      ts,
      /Finished conclusion mismatch: pending/,
    ],
    [
      "callback alternative removed",
      swap(rust, ' | "waiting_for_callback"', ""),
      ts,
      /No explicit Rust arm: waiting_for_callback/,
    ],
    [
      "function renamed",
      swap(rust, "fn map_ci_status(", "fn renamed_ci_status("),
      ts,
      /Rust function not found exactly once/,
    ],
    [
      "table declared twice",
      rust,
      swap(
        ts,
        "const GITLAB_FINISHED_CONCLUSIONS",
        "const GITLAB_FINISHED_CONCLUSIONS = {};\nconst GITLAB_FINISHED_CONCLUSIONS",
      ),
      /TS table not found exactly once/,
    ],
    [
      "unreadable Rust arm",
      swap(
        rust,
        '"pending" => ("pending", ""),',
        '"pending" => pending_status(),',
      ),
      ts,
      /Unreadable Rust match text/,
    ],
    [
      "non-facet TS entry",
      rust,
      swap(ts, 'success: "success",', 'success: "success", novel: "success",'),
      /Non-facet key: novel/,
    ],
    [
      "function declared twice",
      swap(
        rust,
        "fn map_ci_status(",
        "fn map_ci_status() {}\nfn map_ci_status(",
      ),
      ts,
      /Rust function not found exactly once/,
    ],
    [
      "table renamed",
      rust,
      swap(
        ts,
        "const GITLAB_FINISHED_CONCLUSIONS",
        "const RENAMED_CONCLUSIONS",
      ),
      /TS table not found exactly once/,
    ],
    [
      "unreadable TS entry",
      rust,
      swap(ts, 'success: "success",', "success: dynamicConclusion(),"),
      /Unreadable TS table/,
    ],
  ];
  for (const [name, rustSource, tsSource, expectedMessage] of mutants) {
    assert.throws(() => check(rustSource, tsSource), expectedMessage, name);
  }
});

test("wrapped Rust alternatives and comments retain coverage", () => {
  check(
    swap(
      rust,
      '"waiting_for_resource" | "scheduled" | "waiting_for_callback" => ("waiting", ""),',
      '"waiting_for_resource"\n | /* waiting */ "scheduled"\n | "waiting_for_callback" =>\n ("waiting", ""),',
    ),
    ts,
  );
});

test("zero parsed arms fails closed", () => {
  assert.throws(() =>
    rustArms(
      "fn map_ci_status(s: &str) { let (status, conclusion) = match s {}; }",
    ),
  );
});
