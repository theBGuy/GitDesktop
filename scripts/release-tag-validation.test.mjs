// Pins the release dialog's tag-name checks: the git check-ref-format subset a
// typed tag is held to (first violated rule wins), and which typed names count
// as a NEW tag, the input that offers the Target picker and sends a target.
//
// The import below reaches straight into `src/` and relies on Node's default
// type stripping (>= 23.6), which resolves no bundler aliases, so `version.ts`
// must stay import-free.
import assert from "node:assert/strict";
import { test } from "node:test";

import { isNewTagName, validateTagName } from "../src/features/tags/version.ts";

test("valid tag names pass", () => {
  for (const name of [
    "v1.2.0",
    "1.0.0-rc.1",
    "pkg@1.2.3",
    "dashboard/v2.0.0",
    "release_2026-10",
    "v1.0.0+build.5",
    "  v3.0.0  ",
  ]) {
    assert.equal(validateTagName(name), null, name);
  }
});

test("empty and whitespace-only names", () => {
  assert.equal(validateTagName(""), "Enter a tag name");
  assert.equal(validateTagName("   "), "Enter a tag name");
});

test("embedded whitespace", () => {
  assert.equal(validateTagName("v1 .0"), "Tag names can't contain spaces");
  assert.equal(validateTagName("v1\t0"), "Tag names can't contain spaces");
});

test("leading dash", () => {
  assert.equal(validateTagName("-v1"), `Tag names can't start with "-"`);
});

test("trailing dot", () => {
  assert.equal(validateTagName("v1."), `Tag names can't end with "."`);
});

test("trailing .lock", () => {
  assert.equal(validateTagName("v1.lock"), `Tag names can't end with ".lock"`);
  // Only the suffix is refused.
  assert.equal(validateTagName("v1.lockstep"), null);
});

test("per-part rules name the offending part", () => {
  assert.equal(
    validateTagName("pkg.lock/v1"),
    `The tag name part "pkg.lock" can't end with ".lock"`,
  );
  assert.equal(
    validateTagName("pkg/.hidden"),
    `The tag name part ".hidden" can't start with "."`,
  );
  assert.equal(validateTagName(".hidden"), `Tag names can't start with "."`);
});

test("empty parts: leading, trailing, and doubled slashes", () => {
  assert.equal(validateTagName("pkg//v1"), `Tag names can't contain "//"`);
  assert.equal(validateTagName("/v1"), `Tag names can't start with "/"`);
  assert.equal(validateTagName("pkg/"), `Tag names can't end with "/"`);
});

test("hierarchical names pass", () => {
  // `v1/@/x` is pinned valid by the backend's validate_tag_name test (ops.rs).
  for (const name of ["pkg/v1", "a@b/c", "v1/@/x", "pkg.v1/x.lockstep"]) {
    assert.equal(validateTagName(name), null, name);
  }
});

test("double dot", () => {
  assert.equal(validateTagName("v1..2"), `Tag names can't contain ".."`);
});

test("@{ sequence rejected; @ itself is a creatable tag", () => {
  assert.equal(validateTagName("v1@{u}"), `Tag names can't contain "@{"`);
  // Mirrors the backend's probe-verified rule: git's anti-"@" check matches the
  // whole refname, never refs/tags/<name> (validate_tag_name, ops.rs).
  assert.equal(validateTagName("@"), null);
  assert.equal(validateTagName("v1@2"), null);
});

test("forbidden characters name the offending one", () => {
  for (const ch of ["~", "^", ":", "?", "*", "[", "\\"]) {
    assert.equal(
      validateTagName(`v1${ch}0`),
      `Tag names can't contain "${ch}"`,
      ch,
    );
  }
});

test("control characters", () => {
  assert.equal(
    validateTagName(`v1${String.fromCharCode(0)}0`),
    "Tag names can't contain control characters",
  );
  assert.equal(
    validateTagName(`v1${String.fromCharCode(0x7f)}0`),
    "Tag names can't contain control characters",
  );
});

test("the first violated rule is the one reported", () => {
  // Leading dash outranks a later forbidden character.
  assert.equal(validateTagName("-v1:0"), `Tag names can't start with "-"`);
  // Whitespace outranks everything after it.
  assert.equal(validateTagName("v 1.."), "Tag names can't contain spaces");
});

test("isNewTagName: typed, not existing, and valid", () => {
  const existing = ["v1.0.0", "v1.1.0"];
  assert.equal(isNewTagName("v2.0.0", existing), true);
  assert.equal(isNewTagName("v1.0.0", existing), false);
  assert.equal(isNewTagName("", existing), false);
  assert.equal(isNewTagName("v2..0", existing), false);
  assert.equal(isNewTagName("v2.0.0", []), true);
});
