// Pins the hook templates (src/features/hooks/templates.ts) against fixed-width
// object ids: git hands a pre-push hook all-zero ids for a created or deleted ref,
// 40 zeros in a SHA-1 repo and 64 in a SHA-256 one. The no-wip-push template is
// executed through a real `git push` in both formats, so the test fails when the
// hook lets a WIP commit through at either width or refuses a clean push.
//
// The import below reaches straight into `src/` and relies on Node's default
// type stripping (>= 23.6), which resolves no bundler aliases, so the module must
// stay free of runtime imports.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { HOOK_TEMPLATES } from "../src/features/hooks/templates.ts";

const FORTY_ZEROS = /0{40}/;
const IS_ZERO_DEF =
  'is_zero() { case "$1" in *[!0]*) return 1 ;; esac; return 0; }\n';

const noWip = HOOK_TEMPLATES.find((t) => t.id === "no-wip-push");

test("the template set is non-empty and carries no-wip-push", () => {
  assert.ok(HOOK_TEMPLATES.length > 0);
  assert.ok(noWip, "no-wip-push template is missing");
});

test("no template body compares against a fixed-width 40-zero id", () => {
  for (const t of HOOK_TEMPLATES) {
    assert.doesNotMatch(
      t.body,
      FORTY_ZEROS,
      `${t.id} carries a 40-zero literal`,
    );
  }
});

test("the class pin flags a 40-zero literal re-inserted into no-wip-push", () => {
  assert.ok(
    noWip.body.includes(IS_ZERO_DEF),
    "is_zero definition line not found",
  );
  const reverted = noWip.body.replace(IS_ZERO_DEF, `z="${"0".repeat(40)}"\n`);
  assert.notEqual(reverted, noWip.body);
  assert.match(reverted, FORTY_ZEROS);
});

test("no-wip-push tests both ids width-free through one is_zero", () => {
  const body = noWip.body;
  assert.equal(body.split("is_zero() {").length - 1, 1);
  assert.doesNotMatch(body, /^z=/m);
  assert.ok(body.includes('  is_zero "$local_oid" && continue\n'));
  assert.ok(body.includes('  if is_zero "$remote_oid"; then\n'));
});

const root = mkdtempSync(join(tmpdir(), "gd-hook-tpl-"));
after(() => rmSync(root, { recursive: true, force: true }));

const emptyConfig = join(root, "empty-gitconfig");
writeFileSync(emptyConfig, "");
const env = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)),
);
Object.assign(env, {
  GIT_CONFIG_GLOBAL: emptyConfig,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Hook Test",
  GIT_AUTHOR_EMAIL: "hook@test.invalid",
  GIT_COMMITTER_NAME: "Hook Test",
  GIT_COMMITTER_EMAIL: "hook@test.invalid",
});

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  if (r.error) throw r.error;
  return r;
}

function ok(cwd, ...args) {
  const r = git(cwd, ...args);
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

for (const [format, width] of [
  ["sha1", 40],
  ["sha256", 64],
]) {
  test(`no-wip-push guards every push shape in a ${format} repo`, () => {
    const dir = join(root, format);
    mkdirSync(dir);
    const remote = join(dir, "remote.git");
    const work = join(dir, "work");
    ok(
      dir,
      "init",
      "-q",
      "--bare",
      `--object-format=${format}`,
      "-b",
      "main",
      remote,
    );
    ok(dir, "init", "-q", `--object-format=${format}`, "-b", "main", work);
    assert.equal(ok(work, "rev-parse", "--show-object-format"), format);
    ok(work, "commit", "-q", "--allow-empty", "-m", "init");
    assert.equal(ok(work, "rev-parse", "HEAD").length, width);
    ok(work, "remote", "add", "origin", remote);
    ok(work, "push", "-q", "origin", "main");

    const hook = join(work, ".git", "hooks", "pre-push");
    writeFileSync(hook, noWip.body);
    chmodSync(hook, 0o755);

    const remoteHas = (branch) =>
      git(remote, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`)
        .status === 0;
    const push = (...refs) => git(work, "push", "origin", ...refs);
    const allowed = (r) => {
      assert.equal(r.status, 0, `push was refused: ${r.stderr}`);
      assert.doesNotMatch(r.stderr, /Invalid revision range/);
    };
    const refused = (r) => {
      assert.notEqual(r.status, 0, `push was allowed: ${r.stderr}`);
      assert.match(r.stderr, /Refusing to push/);
      assert.doesNotMatch(r.stderr, /Invalid revision range/);
    };

    // A new branch whose only new commit is WIP.
    ok(work, "switch", "-q", "-c", "wip");
    ok(work, "commit", "-q", "--allow-empty", "-m", "WIP stuff");
    refused(push("wip"));
    assert.ok(!remoteHas("wip"), "the WIP branch reached the remote");

    // Clean new branch, then a clean update: the hook must not refuse everything.
    ok(work, "switch", "-q", "-c", "topic", "main");
    ok(work, "commit", "-q", "--allow-empty", "-m", "clean change");
    allowed(push("topic"));
    assert.ok(remoteHas("topic"));
    ok(work, "commit", "-q", "--allow-empty", "-m", "another clean change");
    allowed(push("topic"));

    // Existing-branch updates carrying fixup!/squash! commits.
    ok(work, "commit", "-q", "--allow-empty", "-m", "fixup! clean change");
    refused(push("topic"));
    ok(work, "reset", "-q", "--hard", "HEAD~1");
    ok(work, "commit", "-q", "--allow-empty", "-m", "squash! clean change");
    refused(push("topic"));
    ok(work, "reset", "-q", "--hard", "HEAD~1");

    // Deleting a branch carries an all-zero local id.
    allowed(push(":topic"));
    assert.ok(!remoteHas("topic"));
  });
}
