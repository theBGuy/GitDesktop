// The conflict pane identifies path refusals by the backend's opening sentence,
// so both sides must keep the same prefix. Runs in CI's installless guards job
// using only Node built-ins; a missing or reworded prefix must fail by side.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("Rust conflict path refusals keep the pane's prefix", () => {
  const rust = readFileSync(
    join(REPO_ROOT, "src-tauri/src/git/conflict.rs"),
    "utf8",
  );
  assert.match(
    rust,
    /"Can't resolve the conflict in \{shown\}/,
    "Rust conflict_rel_path must keep its refusal's opening format literal",
  );
});

test("TSX conflict pane keeps the backend's path-refusal prefix", () => {
  const view = readFileSync(
    join(REPO_ROOT, "src/features/repository/ConflictFileView.tsx"),
    "utf8",
  );
  assert.match(
    view,
    /^const PATH_REFUSAL_PREFIX\s*=\s*"Can't resolve the conflict in";/m,
    "TSX ConflictFileView must declare the exact backend PATH_REFUSAL_PREFIX",
  );
});
