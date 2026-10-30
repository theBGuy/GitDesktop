// The conflict pane identifies path refusals by the backend's opening sentence,
// so both sides must keep the same prefix. It also lifts the whole-file
// accepts' hold for one reason alone (a symbolic link at the leaf, which git's
// side checkout replaces itself), so that reason's text must match on both
// sides too. Runs in CI's installless guards job using only Node built-ins; a
// missing or reworded string must fail by side.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUST = "src-tauri/src/git/conflict.rs";
const VIEW = "src/features/repository/ConflictFileView.tsx";
const OPS = "src-tauri/src/git/ops.rs";
const read = (file) => readFileSync(join(REPO_ROOT, file), "utf8");

const REASON = "it's a symbolic link";
const RUST_DECL = /^const CONFLICT_LINKED_LEAF: &str = "([^"\\]*)";\r?$/m;
const VIEW_DECL = /^const LINKED_LEAF_REASON = "([^"\\]*)";\r?$/m;
const ANCESTOR_DECL =
  /^pub\(crate\) const DISCARD_LINKED: &str = "([^"\\]*)";\r?$/m;

test("Rust conflict path refusals keep the pane's prefix", () => {
  assert.match(
    read(RUST),
    /"Can't resolve the conflict in \{shown\}/,
    "Rust conflict_path_refusal must keep its refusal's opening format literal",
  );
});

test("TSX conflict pane keeps the backend's path-refusal prefix", () => {
  assert.match(
    read(VIEW),
    /^const PATH_REFUSAL_PREFIX\s*=\s*"Can't resolve the conflict in";/m,
    "TSX ConflictFileView must declare the exact backend PATH_REFUSAL_PREFIX",
  );
});

/** The leaf-link reason as each side declares it; throws when either side's
 *  declaration is missing or the two disagree. */
function leafReason(rust, view) {
  const r = RUST_DECL.exec(rust);
  assert.ok(r, "conflict.rs must declare `const CONFLICT_LINKED_LEAF: &str`");
  const t = VIEW_DECL.exec(view);
  assert.ok(t, "ConflictFileView must declare `const LINKED_LEAF_REASON`");
  assert.equal(t[1], r[1], "the leaf-link reason differs between Rust and TSX");
  return r[1];
}

test("the leaf-link reason is one string on both sides", () => {
  assert.equal(leafReason(read(RUST), read(VIEW)), REASON);
});

test("the leaf-link match keeps the sentence's dash, period and close", () => {
  const view = read(VIEW);
  assert.match(
    view,
    /^const LINKED_LEAF_TAIL = ` — \$\{LINKED_LEAF_REASON\}\. Nothing was changed\.`;\r?$/m,
    "LINKED_LEAF_TAIL must frame the reason exactly as the refusal ends",
  );
  assert.match(
    view,
    /\bconst linkedLeaf = pathRefusal\?\.endsWith\(LINKED_LEAF_TAIL\) === true;/,
    "linkedLeaf must match the whole sentence tail, never a substring",
  );
  // The linked-ancestor reason must never end the way the leaf tail does.
  const ancestor = ANCESTOR_DECL.exec(read(OPS));
  assert.ok(ancestor, "ops.rs must declare DISCARD_LINKED");
  const tail = ` — ${leafReason(read(RUST), view)}. Nothing was changed.`;
  const ancestorTail = ` — ${ancestor[1]}. Nothing was changed.`;
  assert.ok(!ancestorTail.endsWith(tail), "the ancestor reason reads as leaf");
});

test("a reworded leaf-link reason on either side fails the pin", () => {
  const rust = read(RUST);
  const view = read(VIEW);
  const rustDecl = `const CONFLICT_LINKED_LEAF: &str = "${REASON}";`;
  const viewDecl = `const LINKED_LEAF_REASON = "${REASON}";`;
  assert.ok(rust.includes(rustDecl), "the Rust fixture moved");
  assert.ok(view.includes(viewDecl), "the TSX fixture moved");
  const badRust = rust.replace(rustDecl, rustDecl.replace("link", "links"));
  const badView = view.replace(viewDecl, viewDecl.replace("link", "Link"));
  assert.throws(() => leafReason(badRust, view), /differs/);
  assert.throws(() => leafReason(rust, badView), /differs/);
  const noRust = rust.replace(rustDecl, "");
  const noView = view.replace(viewDecl, "");
  assert.throws(() => leafReason(noRust, view), /CONFLICT_LINKED_LEAF/);
  assert.throws(() => leafReason(rust, noView), /LINKED_LEAF_REASON/);
});
