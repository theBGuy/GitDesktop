// Pins which line of a failed push the one-line error summary leads with. git's
// own push report opens with a `To <remote>` transfer header (sideband `remote:`
// lines can precede it) that names the destination, not the failure, so the
// summarizer skips it as noise and lands on the next meaningful line. Matched and
// unmatched shapes: see PUSH_TRANSFER_HEADER's doc in src/lib/error-summary.ts.
//
// `src/lib/error-summary.ts` carries an `@/` value import, which Node's type
// stripping cannot resolve, so the shared src hooks go in first. The import is
// dynamic only because a static one links before any module body runs, i.e.
// before the hooks exist. It is deliberately NOT wrapped in a skip guard: the
// graph reaches no bare packages (`git/api` is a type-only import, and
// `tauri/invoke` -> `transport/index` imports nothing), so this suite runs in the
// no-install `guards` job too and any import failure there is a real breakage.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { installSrcHooks } from "./lib/src-import-hooks.mjs";

const hooks = installSrcHooks();
after(() => hooks.deregister());

const { presentError } = await import("@/lib/error-summary");

const REMOTE = "https://gitlab.com/x/y.git";
const REJECTED = " ! [rejected]        main -> main (non-fast-forward)";
/** git's column padding collapses to single spaces in the summary. */
const REJECTED_SUMMARY = "! [rejected] main -> main (non-fast-forward)";
const FAILED = `error: failed to push some refs to '${REMOTE}'`;
const HINTS = [
  "hint: Updates were rejected because the tip of your current branch is behind",
  "hint: its remote counterpart. If you want to integrate the remote changes,",
  "hint: use 'git pull' before pushing again.",
];

/** The Rust layer serializes a failed git call with `message` = the trimmed
 *  stderr, which is why `stderr` repeats it here. */
const gitError = (text) => ({
  kind: "git",
  message: text.trim(),
  code: 1,
  stderr: text.trim(),
});

/** The measured non-fast-forward push report, joined with `eol`. */
const nonFastForward = (eol) =>
  [`To ${REMOTE}`, REJECTED, FAILED, ...HINTS].join(eol);

test("a rejected push leads with the ! [rejected] line, not the To header", () => {
  const p = presentError(gitError(nonFastForward("\n")));
  assert.equal(p.summary, REJECTED_SUMMARY);
  assert.equal(p.label, "Git error");
  assert.ok(
    p.fullText.startsWith(`To ${REMOTE}\n`),
    "fullText keeps the header",
  );
  assert.ok(
    p.fullText.includes(REJECTED.trim()),
    "fullText keeps git's column padding",
  );
  assert.doesNotMatch(p.summary, /\s{2}/, "summary collapses whitespace runs");
  assert.equal(p.long, true);
});

test("header followed only by error: lands on the prefix-stripped error line", () => {
  const p = presentError(gitError(`To ${REMOTE}\n${FAILED}`));
  assert.equal(p.summary, `failed to push some refs to '${REMOTE}'`);
});

test("CRLF joints summarize the same as LF", () => {
  const p = presentError(gitError(nonFastForward("\r\n")));
  assert.equal(p.summary, REJECTED_SUMMARY);
});

test("scp-style and ssh remotes are skipped as the header too", () => {
  for (const remote of [
    "github.com:user/repo.git",
    "git@github.com:user/repo.git",
    "ssh://git@example.com:2222/user/repo.git",
    "git+ssh://git@example.com/user/repo.git",
    "http://example.com/user/repo.git",
  ]) {
    const p = presentError(gitError(`To ${remote}\n${REJECTED}\n${FAILED}`));
    assert.equal(p.summary, REJECTED_SUMMARY, remote);
  }
});

test("prose that opens with To keeps line one as the summary", () => {
  for (const first of [
    "To enable long paths, run git config --global core.longpaths true.",
    "To continue, resolve the conflicts.",
  ]) {
    const p = presentError(
      gitError(`${first}\nerror: something else went wrong`),
    );
    assert.equal(p.summary, first);
    const plain = presentError(new Error(`${first}\nsecond line`));
    assert.equal(plain.summary, first);
  }
});

test("a lone word:token line is skipped too (accepted residual)", () => {
  const p = presentError(gitError(`To origin:main\n${FAILED}`));
  assert.equal(p.summary, `failed to push some refs to '${REMOTE}'`);
});

test("a Windows drive-letter or file:// header is skipped like a remote", () => {
  for (const remote of [
    "C:/temp/bare.git",
    "C:\\temp\\bare.git",
    "file:///C:/temp/bare.git",
  ]) {
    const p = presentError(gitError(`To ${remote}\n${REJECTED}\n${FAILED}`));
    assert.equal(p.summary, REJECTED_SUMMARY, remote);
  }
});

test("a local-path header is not matched and keeps line one", () => {
  const header = "To /home/u/bare.git";
  const p = presentError(gitError(`${header}\n${REJECTED}\n${FAILED}`));
  assert.equal(p.summary, header);
});

test("a header-only message still summarizes as that line, never blank", () => {
  assert.equal(presentError(gitError(`To ${REMOTE}`)).summary, `To ${REMOTE}`);
  assert.equal(
    presentError(gitError(`To ${REMOTE}\nhint: nothing else`)).summary,
    `To ${REMOTE}`,
  );
});

test("a plain Error carrying push output skips the header as well", () => {
  const p = presentError(new Error(nonFastForward("\n")));
  assert.equal(p.label, null);
  assert.equal(p.summary, REJECTED_SUMMARY);
});

test("app prose in message still leads when the push output rides stderr", () => {
  const p = presentError({
    kind: "git",
    message: "Couldn't push main.",
    code: 1,
    stderr: nonFastForward("\n"),
  });
  assert.equal(p.summary, "Couldn't push main.");
  assert.ok(p.fullText.includes(`To ${REMOTE}`));
});

test("mapped families still outrank the fall-through", () => {
  const staleInfo = [
    `To ${REMOTE}`,
    " ! [rejected]        main -> main (stale info)",
    FAILED,
  ].join("\n");
  assert.match(
    presentError(gitError(staleInfo)).summary,
    /^Force push blocked — the remote moved since your last fetch\./,
  );

  // GitHub pads every `remote:` line with trailing spaces.
  const pushProtection = [
    "remote: error: GH013: Repository rule violations found for refs/heads/main.        ",
    "remote: ",
    "remote: - GITHUB PUSH PROTECTION        ",
    "remote:     Resolve the following violations before pushing again        ",
    "remote: ",
    "remote:     - Push cannot contain secrets        ",
    "remote: ",
    "To https://github.com/x/y.git",
    " ! [remote rejected] main -> main (push declined due to repository rule violations)",
    "error: failed to push some refs to 'https://github.com/x/y.git'",
  ].join("\n");
  assert.match(
    presentError(gitError(pushProtection)).summary,
    /^GitHub blocked this push because it detected a likely secret/,
  );
});

test("a rollback verdict on line one stays the summary", () => {
  const verdict = "The cherry-pick was rolled back — main is unchanged.";
  const message = [
    verdict,
    "Pick 1a2b3c4 failed, usually a conflict; nothing from this batch was kept.",
    "error: could not apply 1a2b3c4... fix the parser",
    "hint: Resolve all conflicts manually, mark them as resolved with",
  ].join("\n");
  assert.equal(presentError(gitError(message)).summary, verdict);
});
