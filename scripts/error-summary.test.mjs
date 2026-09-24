// Pins which line of a failed push, fetch, or pull the one-line error summary
// leads with. git's transfer report opens with a `To <remote>` / `From <remote>`
// header (sideband `remote:` lines can precede it) and lists every ref it moved,
// so the summarizer skips the header and the non-`!` per-ref lines as noise and
// lands on git's reason. Matched and unmatched shapes: see the docs on
// PUSH_TRANSFER_HEADER, TRANSFER_REF_LINE, and TRANSFER_DELETED_LINE in
// src/lib/error-summary.ts.
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

const { composedErrorPresentation, presentError } = await import(
  "@/lib/error-summary"
);

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

// Transfer-report shapes measured on git 2.51.1.windows.1 with piped stderr, the
// Rust runner's own context. Remote paths shortened; the column padding is git's.
const LOCAL_ORIGIN = "C:/temp/w/origin";
const NEW_TAG = " * [new tag]         v2 -> v2";
const FF_TABLE = "   22952d8..c5bdbe9  main       -> origin/main";
const DIVERGED_HINTS = [
  "hint: Diverging branches can't be fast-forwarded, you need to either:",
  "hint:",
  "hint: \tgit merge --ff-only",
  "hint:",
  "hint: or:",
  "hint:",
  "hint: \tgit rebase",
  "hint:",
  'hint: Disable this message with "git config set advice.diverging false"',
];
const NOT_FF = "fatal: Not possible to fast-forward, aborting.";
const TAG_CLOBBER =
  " ! [rejected]        v1         -> v1  (would clobber existing tag)";

/** A push carrying a rejected branch and a new tag (`push.followTags`): the tag's
 *  success line comes first in git's report. */
const multiRefPush = (eol) =>
  [
    `To ${LOCAL_ORIGIN}.git`,
    NEW_TAG,
    REJECTED,
    `error: failed to push some refs to '${LOCAL_ORIGIN}.git'`,
    ...HINTS,
  ].join(eol);

/** `pull --ff-only` on a diverged branch: the fetch half's report, then git's
 *  refusal. */
const ffOnlyPull = (eol) =>
  [`From ${LOCAL_ORIGIN}`, FF_TABLE, ...DIVERGED_HINTS, NOT_FF].join(eol);

/** A merge-mode pull conflict as `full_failure_text` folds it: stderr (the fetch
 *  report) first, stdout (the merge verdict) below. */
const pullConflictFold = (eol) =>
  [
    `From ${LOCAL_ORIGIN}`,
    "   c4ff0f4..22952d8  main       -> origin/main",
    "Auto-merging a.txt",
    "CONFLICT (content): Merge conflict in a.txt",
    "Automatic merge failed; fix conflicts and then commit the result.",
  ].join(eol);

/** `fetch --tags` refusing to move an existing tag. */
const tagClobber = (eol) => [`From ${LOCAL_ORIGIN}`, TAG_CLOBBER].join(eol);

/** A push deleting one ref and rejecting another: the deletion prints first, with
 *  no arrow. */
const DELETED = " - [deleted]         doomed";
const deletionPush = (eol) =>
  [
    `To ${LOCAL_ORIGIN}.git`,
    DELETED,
    REJECTED,
    `error: failed to push some refs to '${LOCAL_ORIGIN}.git'`,
  ].join(eol);

/** A fetch naming a branch (bare `branch` summary word) beside a tag refusal and
 *  a forced update. */
const FETCH_BRANCH = " * branch            main       -> FETCH_HEAD";
const FORCED =
  " + c5bdbe9...1d0d257 main       -> origin/main  (forced update)";
const mixedFetch = (eol, lines) => [`From ${LOCAL_ORIGIN}`, ...lines].join(eol);

/** Fetching a `refs/remotes/*` ref names it with a two-word summary. */
const REMOTE_TRACKING = " * remote-tracking branch mirror/main -> FETCH_HEAD";

/** The Rust serialization verbatim: `message` is the trimmed stderr, `stderr`
 *  the raw blob with git's trailing newline. */
const rawGitError = (text) => ({
  kind: "git",
  message: text.trim(),
  code: 1,
  stderr: `${text}\n`,
});

for (const [name, eol] of [
  ["LF", "\n"],
  ["CRLF", "\r\n"],
]) {
  test(`a multi-ref push leads with the rejection, not the new tag's line (${name})`, () => {
    for (const make of [gitError, rawGitError]) {
      const p = presentError(make(multiRefPush(eol)));
      assert.equal(p.summary, REJECTED_SUMMARY);
      assert.ok(
        p.fullText.includes(NEW_TAG.trim()),
        "fullText keeps the tag line",
      );
    }
  });

  test(`a refused ff-only pull leads with git's reason (${name})`, () => {
    for (const make of [gitError, rawGitError]) {
      const p = presentError(make(ffOnlyPull(eol)));
      assert.equal(p.summary, "Not possible to fast-forward, aborting.");
      assert.ok(
        p.fullText.startsWith(`From ${LOCAL_ORIGIN}`),
        "fullText keeps the fetch report",
      );
      assert.ok(p.fullText.includes(FF_TABLE), "fullText keeps the table line");
    }
  });

  test(`a merge-mode pull conflict still reads as a paused merge (${name})`, () => {
    const p = presentError(gitError(pullConflictFold(eol)));
    assert.equal(
      p.summary,
      "Merge paused — resolve the conflicts, then commit.",
    );
  });

  test(`a tag-clobber refusal keeps its ! line as the summary (${name})`, () => {
    const p = presentError(gitError(tagClobber(eol)));
    assert.equal(
      p.summary,
      "! [rejected] v1 -> v1 (would clobber existing tag)",
    );
  });

  test(`a push deletion above a rejection is skipped (${name})`, () => {
    for (const make of [gitError, rawGitError]) {
      const p = presentError(make(deletionPush(eol)));
      assert.equal(p.summary, REJECTED_SUMMARY);
      assert.ok(p.fullText.includes(DELETED.trim()), "fullText keeps it");
    }
  });

  test(`a fetch's branch and forced-update lines are noise, its ! line is not (${name})`, () => {
    const measured = mixedFetch(eol, [FETCH_BRANCH, TAG_CLOBBER, FORCED]);
    assert.equal(
      presentError(gitError(measured)).summary,
      "! [rejected] v1 -> v1 (would clobber existing tag)",
    );
    // Without the ! line the report is all noise, so the header summarizes: both
    // remaining per-ref lines were skipped.
    const noiseOnly = mixedFetch(eol, [FETCH_BRANCH, FORCED]);
    assert.equal(
      presentError(gitError(noiseOnly)).summary,
      `From ${LOCAL_ORIGIN}`,
    );
  });

  test(`a fetched remote-tracking ref's line is noise above a rejection (${name})`, () => {
    // Measured: the two-word summary column is followed by a single space.
    const measured = mixedFetch(eol, [REMOTE_TRACKING, TAG_CLOBBER]);
    assert.equal(
      presentError(gitError(measured)).summary,
      "! [rejected] v1 -> v1 (would clobber existing tag)",
    );
    assert.equal(
      presentError(gitError(mixedFetch(eol, [REMOTE_TRACKING]))).summary,
      `From ${LOCAL_ORIGIN}`,
    );
  });
}

test("app prose in message still leads when the pull report rides stderr", () => {
  const p = presentError({
    kind: "git",
    message: "Couldn't pull main.",
    code: 128,
    stderr: ffOnlyPull("\n"),
  });
  assert.equal(p.summary, "Couldn't pull main.");
  assert.ok(
    p.fullText.includes(NOT_FF),
    "fullText appends the distinct stderr",
  );
});

test("the documented success flags (+ - * = t, and space) with known summaries are noise; ! is not", () => {
  for (const line of [
    FF_TABLE,
    " + 22952d8...c5bdbe9 main       -> origin/main  (forced update)",
    " - [deleted]         (none)     -> origin/gone",
    NEW_TAG,
    " * [new branch]      feat       -> origin/feat",
    " = [up to date]      main       -> main",
    " t [tag update]      v1         -> v1",
    " * branch            main       -> FETCH_HEAD",
    " * tag               v1         -> FETCH_HEAD",
    " * remote-tracking branch mirror/main -> FETCH_HEAD",
    // A push deletion prints no arrow, only the remote refname.
    " - [deleted]         feat",
  ]) {
    const p = presentError(
      gitError(`From ${LOCAL_ORIGIN}\n${line}\n${NOT_FF}`),
    );
    assert.equal(p.summary, "Not possible to fast-forward, aborting.", line);
  }
  for (const line of [
    REJECTED,
    " ! [remote rejected] main -> main (pre-receive hook declined)",
  ]) {
    const p = presentError(gitError(`To ${REMOTE}\n${line}\n${FAILED}`));
    assert.equal(p.summary, line.trim().replace(/\s+/g, " "), line);
  }
});

test("prose shaped near a per-ref line stays meaningful", () => {
  for (const line of [
    // The flag column without the arrow.
    " - make sure the remote still exists",
    // The deletion status followed by more than one refname-shaped token.
    " - [deleted]         feat and the rest",
    // An arrow mid-prose, without the flag column.
    "Renamed main -> trunk on the remote.",
    // A flag column whose summary is no `[…]` status, hex range, or bare
    // `branch`/`tag` word.
    "   Fix the parser -> faster builds",
    " * note: main -> trunk",
    " * branches main -> trunk",
  ]) {
    const p = presentError(
      gitError(`From ${LOCAL_ORIGIN}\n${line}\n${NOT_FF}`),
    );
    assert.equal(p.summary, line.trim().replace(/\s+/g, " "), line);
  }
});

test("a From header needs a remote token, like the To header", () => {
  for (const first of [
    "From /home/u/origin",
    "From here on, retry the fetch.",
  ]) {
    const p = presentError(gitError(`${first}\n${NOT_FF}`));
    assert.equal(p.summary, first);
  }
  for (const remote of [
    "https://github.com/x/y.git",
    "git@github.com:x/y.git",
    "file:///C:/temp/origin",
    "C:\\temp\\origin",
  ]) {
    const p = presentError(gitError(`From ${remote}\n${NOT_FF}`));
    assert.equal(p.summary, "Not possible to fast-forward, aborting.", remote);
  }
});

test("an all-noise report still summarizes its first non-empty line", () => {
  // Header plus table: the header is the first non-empty line.
  const headed = [`From ${LOCAL_ORIGIN}`, FF_TABLE, NEW_TAG].join("\n");
  assert.equal(presentError(gitError(headed)).summary, `From ${LOCAL_ORIGIN}`);
  // Table alone, indent intact (a plain Error is never trimmed upstream).
  const tableOnly = ["", FF_TABLE, NEW_TAG].join("\n");
  assert.equal(
    presentError(new Error(tableOnly)).summary,
    "22952d8..c5bdbe9 main -> origin/main",
  );
});

// `git ls-remote` refusals measured on git 2.51.1.windows.1, 2026-09-24: an SSH
// remote with no usable key, a missing local path, and an unresolvable SSH host
// (the ssh client's lines end in CRLF, git's own in LF), all ending on git's
// shared `fatal:` tail; and an https remote naming a missing project.
const SSH_KEY_REFUSED_SUMMARY =
  "The remote refused the SSH connection because no key it accepts was offered. Add or load an SSH key with access to this remote, then try again.";
const UNREADABLE_TAIL =
  "fatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n";
const sshNoAccess = (host) =>
  `git@${host}: Permission denied (publickey).\r\n${UNREADABLE_TAIL}`;
const MISSING_PATH_LINE =
  "'C:/definitely-not-a-repo-x7q9z' does not appear to be a git repository";
const UNRESOLVED_HOST_LINE =
  "ssh: Could not resolve hostname definitely-not-a-host-x7q9z.invalid: Name or service not known";

test("an SSH remote with no usable key gets the calm key-refusal line", () => {
  for (const host of ["gitlab.com", "github.com"]) {
    for (const make of [gitError, rawGitError]) {
      const p = presentError(make(sshNoAccess(host)));
      assert.equal(p.summary, SSH_KEY_REFUSED_SUMMARY, host);
      assert.ok(
        p.fullText.includes(`git@${host}: Permission denied (publickey).`),
        "fullText keeps the ssh line",
      );
    }
  }
});

test("an https missing-project refusal keeps its remote: line", () => {
  const gitlabLine =
    "remote: The project you were looking for could not be found or you don't have permission to view it.";
  const githubLine = "remote: Repository not found.";
  for (const [first, url] of [
    [gitlabLine, "https://gitlab.com/x/y.git/"],
    [githubLine, "https://github.com/x/y.git/"],
  ]) {
    const text = `${first}\nfatal: repository '${url}' not found\n`;
    for (const make of [gitError, rawGitError]) {
      assert.equal(presentError(make(text)).summary, first, url);
    }
  }
});

test("first-contact failures on git's shared tail keep their own first line", () => {
  for (const [text, summary] of [
    [`fatal: ${MISSING_PATH_LINE}\n${UNREADABLE_TAIL}`, MISSING_PATH_LINE],
    [`${UNRESOLVED_HOST_LINE}\r\n${UNREADABLE_TAIL}`, UNRESOLVED_HOST_LINE],
  ]) {
    for (const make of [gitError, rawGitError]) {
      assert.equal(presentError(make(text)).summary, summary);
    }
  }
});

test("constructed method lists: publickey among several maps, keyless lists fall through", () => {
  const withKey = "git@example.com: Permission denied (publickey,password).";
  assert.equal(
    presentError(gitError(withKey)).summary,
    SSH_KEY_REFUSED_SUMMARY,
  );
  for (const keyless of [
    "git@example.com: Permission denied (password).",
    "git@example.com: Permission denied (keyboard-interactive).",
  ]) {
    assert.equal(presentError(gitError(keyless)).summary, keyless);
  }
});

test("a composed presentation headlines the title over one error's own text", () => {
  const error = gitError(sshNoAccess("gitlab.com"));
  const own = presentError(error);
  const p = composedErrorPresentation("Created issue #12, but it failed.", [
    error,
  ]);
  assert.equal(p.summary, "Created issue #12, but it failed.");
  assert.equal(p.label, own.label);
  assert.equal(p.fullText, own.fullText);
  assert.equal(p.long, own.long);
});

test("a composed presentation sections several errors under their headings", () => {
  const first = gitError("fatal: first failure");
  const second = new Error("second failure\nwith detail");
  const p = composedErrorPresentation(
    "Created issue #12, but two steps failed.",
    [first, second],
    ["Adding to project", "Setting labels"],
  );
  assert.deepEqual(p, {
    label: null,
    summary: "Created issue #12, but two steps failed.",
    fullText:
      "Adding to project\nfatal: first failure\n\nSetting labels\nsecond failure\nwith detail",
    long: true,
  });
  // Without headings the sections join bare.
  assert.equal(
    composedErrorPresentation("t", [first, second]).fullText,
    "fatal: first failure\n\nsecond failure\nwith detail",
  );
});

test("ssh's key refusal after other text on its line falls through", () => {
  const line = "warning: git@gitlab.com: Permission denied (publickey).";
  const p = presentError(gitError(line));
  assert.notEqual(p.summary, SSH_KEY_REFUSED_SUMMARY);
  assert.equal(p.summary, line);
});

test("empty messages fall through to a non-blank summary", () => {
  assert.equal(
    presentError({ kind: "git", message: "", code: 1, stderr: "" }).summary,
    "Git error",
  );
  assert.equal(presentError(new Error("")).summary, "Unexpected error");
});
