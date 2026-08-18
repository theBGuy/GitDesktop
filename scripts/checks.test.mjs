// Negative controls for the three guard scanners. Their worst failure mode is
// silent fail-open — a pattern that stops matching still prints "OK" — so every
// predicate keeps a fixture that MUST hit and a fixture that must not. The
// scripts export their predicates and gate their CLI body on a main-module path
// check (`process.argv[1]` vs `import.meta.url` — portable across node versions,
// unlike `import.meta.main`), so importing them here runs no scan, touches no
// disk, and cannot silently no-op on a runtime older than the gate.
//
// Node's stdlib test runner and node: imports only, no dev dependency, so the
// CI `guards` job runs `node --test "scripts/*.test.mjs"` with no install step.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CHECKS,
  runCheck,
  stripComments,
  view,
} from "./check-banned-patterns.mjs";
import {
  parseInvoked,
  parseRegistered,
  staleAllowlistEntries as staleCommandEntries,
} from "./check-dead-surface.mjs";
import {
  checkRefspecTemplates,
  checkSecretArgv,
  checkStderrOnlyGitError,
  checkSyncCommands,
  enclosingFn,
  staleAllowlistEntries,
} from "./check-rust-invariants.mjs";

// ------------------------------------------------------- check-banned-patterns

/** The named check's scanner, applied to a fixture source string. */
function scanner(name) {
  const check = CHECKS.find((c) => c.name === name);
  assert.ok(check, `no check named ${name}`);
  return (source) => check.scan(view(source));
}

const hoverReveal = scanner("hover-reveal");
const modKey = scanner("hand-rolled-mod-key");
const setQueryData = scanner("setQueryData-noop");

test("hover-reveal catches every Tailwind spelling of the idiom", () => {
  for (const classes of [
    "opacity-0 group-hover:opacity-100",
    "invisible group-hover:visible",
    "hidden group-hover:block",
    "hidden group-hover:flex",
    "hidden group-hover:inline",
    "hidden group-hover:inline-flex",
  ]) {
    assert.deepEqual(
      hoverReveal(`const cls = "${classes}";`),
      [1],
      `should flag ${classes}`,
    );
  }
});

test("hover-reveal pairs across a wrapped class list", () => {
  const source = [
    "<button",
    "  className={cn(",
    '    "invisible transition",',
    '    "group-hover:visible",',
    "  )}",
    "/>",
  ].join("\n");
  assert.deepEqual(hoverReveal(source), [3]);
});

test("hover-reveal does not pair a compound utility that merely ends in the token", () => {
  // The boundary guard's whole job: `overflow-hidden` is a layout utility, not
  // a hidden element, and pairing it would flag ordinary scroll containers.
  assert.deepEqual(
    hoverReveal('const cls = "overflow-hidden group-hover:block";'),
    [],
  );
  assert.deepEqual(
    hoverReveal('const cls = "group-hover:visible-ish invisible-thing";'),
    [],
  );
});

test("hover-reveal ignores a hiding utility with no reveal partner", () => {
  assert.deepEqual(hoverReveal('const cls = "hidden md:flex";'), []);
  assert.deepEqual(hoverReveal('const cls = "opacity-0 animate-in";'), []);
});

test("hover-reveal ignores the idiom named in a comment", () => {
  // src/main.tsx documents the vendored diff widget's own `group-hover:visible`
  // next to our `.invisible` utility; comment stripping is what keeps it clean.
  const source = [
    "// the add-widget button reveals via `group-hover:visible`,",
    "// which our `.invisible` utility would otherwise beat.",
    'import "@git-diff-view/react/styles/diff-view.css";',
  ].join("\n");
  assert.deepEqual(hoverReveal(source), []);
});

test("hand-rolled-mod-key flags a single raw flag and each half of a split pair", () => {
  assert.deepEqual(modKey("if (e.metaKey) submit();"), [1]);
  assert.deepEqual(modKey("if (e.ctrlKey) submit();"), [1]);
  const split = ["const mod =", "  e.metaKey ||", "  e.ctrlKey;"].join("\n");
  assert.deepEqual(modKey(split), [2, 3]);
});

test("hand-rolled-mod-key ignores other modifiers and the helper's own name", () => {
  assert.deepEqual(modKey("if (e.shiftKey || e.altKey) return;"), []);
  assert.deepEqual(modKey("const label = formatBinding(binding);"), []);
});

test("setQueryData-noop catches a call wrapped across lines", () => {
  const source = [
    "queryClient.setQueryData(",
    "  keys.pullRequest(repo, number),",
    "  undefined,",
    ");",
  ].join("\n");
  assert.deepEqual(setQueryData(source), [1]);
});

test("setQueryData-noop sees through nested type arguments", () => {
  assert.deepEqual(
    setQueryData("qc.setQueryData<Record<string, Foo>>(key, undefined);"),
    [1],
  );
  assert.deepEqual(
    setQueryData("qc.setQueryData<Foo[]>(key, undefined);"),
    [1],
  );
});

test("setQueryData-noop resolves the LAST argument past a comma-bearing key", () => {
  assert.deepEqual(
    setQueryData("qc.setQueryData(keys.pr(repo, number), undefined);"),
    [1],
  );
});

test("setQueryData-noop leaves real writes alone", () => {
  assert.deepEqual(setQueryData("qc.setQueryData(key, previous);"), []);
  assert.deepEqual(
    setQueryData("qc.setQueryData(key, (old) => ({ ...old, x: 1 }));"),
    [],
  );
});

test("setQueryData-noop does not reach across a `;` statement boundary", () => {
  // The whole-file view joins lines, so the argument run is `;`-free and
  // length-bounded — otherwise this pairs one call with the next statement.
  // The bound is exactly that and no more: `;` is not the only boundary in JS,
  // so a JSX prop or object member holding `, undefined)` within 200 chars of a
  // clean call still pairs (a loud false positive, fixable at the call site),
  // and a `;` inside a string key ends the run early (the one fail-open).
  const source = [
    "qc.setQueryData(key, previous);",
    "logger.debug(label, undefined);",
  ].join("\n");
  assert.deepEqual(setQueryData(source), []);
});

test("an allowlist entry whose file no longer has the pattern is stale", () => {
  // Allowlisted files are scanned, not skipped: a live entry suppresses its hit
  // and stays; an entry with nothing left to suppress is reported so the ratchet
  // can only tighten.
  const check = {
    name: "fixture",
    appliesTo: () => true,
    scan: CHECKS.find((c) => c.name === "hover-reveal").scan,
    allowlist: ["still-reveals.tsx", "now-clean.tsx", "since-deleted.tsx"],
    message: "fixture message",
  };
  const files = ["still-reveals.tsx", "now-clean.tsx", "fresh.tsx"];
  const views = new Map([
    [
      "still-reveals.tsx",
      view('const c = "opacity-0 group-hover:opacity-100";'),
    ],
    ["now-clean.tsx", view('const c = "flex items-center gap-2";')],
    ["fresh.tsx", view('const c = "invisible group-hover:visible";')],
  ]);

  const { violations, stale } = runCheck(check, files, views);
  // The allowlisted hit is suppressed; the unlisted one is not.
  assert.deepEqual(violations, ["fresh.tsx:1"]);
  // Clean-now and no-longer-present entries both surface; the live one does not.
  assert.deepEqual(stale, ["now-clean.tsx", "since-deleted.tsx"]);
});

test("a rust allowlist record no hit maps to is stale, matched as (file, fn)", () => {
  const list = [
    { file: "git/ops.rs", fn: "live_one", rationale: "x" },
    { file: "git/ops.rs", fn: "site_removed", rationale: "x" },
    // Same fn name, different file: the pair must match, not either half.
    { file: "git/remote.rs", fn: "live_one", rationale: "x" },
  ];
  const hits = [
    { file: "git/ops.rs", fn: "live_one", allowlisted: true },
    { file: "git/ops.rs", fn: "unlisted", allowlisted: false },
  ];
  assert.deepEqual(
    staleAllowlistEntries(list, hits).map((e) => `${e.file}::${e.fn}`),
    ["git/ops.rs::site_removed", "git/remote.rs::live_one"],
  );
  // An empty allowlist (SECRET_ARGV_ALLOWLIST today) is a no-op, not a failure.
  assert.deepEqual(staleAllowlistEntries([], hits), []);
});

test("stripComments blanks comments but not comment-shaped strings", () => {
  assert.deepEqual(stripComments(["const a = 1; // e.metaKey"]), [
    "const a = 1; ",
  ]);
  assert.deepEqual(
    stripComments([
      "/* opacity-0",
      "   group-hover:opacity-100 */ const a = 1;",
    ]),
    ["", " const a = 1;"],
  );
  assert.deepEqual(stripComments(['const url = "https://x.dev/a";']), [
    'const url = "https://x.dev/a";',
  ]);
});

// -------------------------------------------------------- check-rust-invariants

test("enclosingFn attributes const, unsafe and extern signatures", () => {
  const cases = [
    ["pub const fn for_provider(p: Provider) -> Self {", "for_provider"],
    ["    const fn all() -> Self {", "all"],
    ["unsafe fn from_raw(p: *const u8) {", "from_raw"],
    ['pub unsafe extern "C" fn callback(v: i32) {', "callback"],
    // A bare `extern fn` is legal and defaults to the "C" ABI.
    ["extern fn bare_abi() {", "bare_abi"],
    ["pub(crate) const unsafe fn peek() -> u8 {", "peek"],
    ["pub async fn ordinary(x: u8) {", "ordinary"],
  ];
  for (const [signature, name] of cases) {
    // The preceding fn is the wrong answer a too-narrow pattern falls back to.
    const lines = ["fn preceding() {}", "}", signature, "    let x = 1;"];
    assert.equal(enclosingFn(lines, 3), name, `for ${signature}`);
  }
});

test("refspec-template hits are attributed to the enclosing fn", () => {
  const src = [
    "fn preceding() {}",
    "",
    "pub const fn build_ref(name: &str) -> String {",
    '    format!("refs/heads/{name}")',
    "}",
  ].join("\n");
  const hits = [];
  checkRefspecTemplates("fixture.rs", src, src.split("\n"), hits);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].fn, "build_ref");
  assert.equal(hits[0].line, 4);
  assert.equal(hits[0].allowlisted, false);
});

test("refspec-template check ignores format! templates with no ref marker", () => {
  const src = ["fn f() {", '    format!("hello {name}")', "}"].join("\n");
  const hits = [];
  checkRefspecTemplates("fixture.rs", src, src.split("\n"), hits);
  assert.deepEqual(hits, []);
});

test("secret-shaped argv is caught next to a -f-family flag", () => {
  const lines = [
    "fn send(token: &str) {",
    '    cmd.arg("-f")',
    '        .arg(format!("token={token}"));',
    "}",
  ];
  const hits = [];
  checkSecretArgv("fixture.rs", lines.join("\n"), lines, hits);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].fn, "send");
  assert.equal(hits[0].allowlisted, false);

  const benign = ["fn send() {", '    cmd.arg("-f").arg("title=hello");', "}"];
  const none = [];
  checkSecretArgv("fixture.rs", benign.join("\n"), benign, none);
  assert.deepEqual(none, []);
});

test("sync #[tauri::command] is caught, async is not, unreadable fails closed", () => {
  const sync = ["#[tauri::command]", "pub fn do_thing() -> u8 { 1 }"];
  const hits = [];
  checkSyncCommands("fixture.rs", sync.join("\n"), sync, hits);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].fn, "do_thing");
  assert.equal(hits[0].allowlisted, false);

  const asyncCmd = [
    "#[tauri::command]",
    '#[cfg(target_os = "macos")]',
    "pub async fn do_thing() -> u8 { 1 }",
  ];
  const none = [];
  checkSyncCommands("fixture.rs", asyncCmd.join("\n"), asyncCmd, none);
  assert.deepEqual(none, []);

  const unreadable = ["#[tauri::command]", "pub struct NotAFn;"];
  const failClosed = [];
  checkSyncCommands(
    "fixture.rs",
    unreadable.join("\n"),
    unreadable,
    failClosed,
  );
  assert.equal(failClosed.length, 1);
  assert.equal(failClosed[0].fn, "<unresolved>");
  assert.equal(failClosed[0].allowlisted, false);
});

test("stderr-only AppError::Git is caught, bare and format!-wrapped", () => {
  const src = [
    "async fn plain(out: GitOutput) -> AppError {",
    "    AppError::Git {",
    "        code: out.code,",
    "        stderr: out.stderr,",
    "    }",
    "}",
    "async fn wrapped(out: GitOutput) -> AppError {",
    "    AppError::Git {",
    "        code: out.code,",
    '        stderr: format!("prefix\\n{}", out.stderr),',
    "    }",
    "}",
  ].join("\n");
  const hits = [];
  checkStderrOnlyGitError("fixture.rs", src, src.split("\n"), hits);
  assert.deepEqual(
    hits.map((h) => h.fn),
    ["plain", "wrapped"],
  );
  assert.equal(hits[0].allowlisted, false);
});

test("stderr-only check ignores correct shaping and bare binding patterns", () => {
  const src = [
    "async fn shaped(out: GitOutput) -> AppError {",
    "    AppError::Git {",
    "        code: out.code,",
    "        stderr: out.full_failure_text(),",
    "    }",
    "}",
    "fn matched(e: AppError) -> bool {",
    '    matches!(e, AppError::Git { stderr, .. } if stderr.contains("x"))',
    "}",
  ].join("\n");
  const hits = [];
  checkStderrOnlyGitError("fixture.rs", src, src.split("\n"), hits);
  assert.deepEqual(hits, []);
});

test("a stderr value naming a binding is judged by that binding's initializer", () => {
  // The shape the conflict batch itself uses (`let report = …; stderr: report`):
  // the field alone says nothing, so substituting `.stderr` into the binding
  // later has to stay visible.
  const src = [
    "async fn good(commit: GitOutput) -> AppError {",
    "    let report = commit.full_failure_text();",
    "    let _lower = report.to_lowercase();",
    "    AppError::Git {",
    "        code: commit.code,",
    "        stderr: report,",
    "    }",
    "}",
    "async fn bad(commit: GitOutput) -> AppError {",
    "    let report = commit.stderr;",
    "    AppError::Git {",
    "        code: commit.code,",
    "        stderr: report,",
    "    }",
    "}",
  ].join("\n");
  const hits = [];
  checkStderrOnlyGitError("fixture.rs", src, src.split("\n"), hits);
  assert.deepEqual(
    hits.map((h) => h.fn),
    ["bad"],
  );
});

test("an unresolvable stderr binding fails closed", () => {
  // A parameter has no initializer in range, so the checker cannot know which
  // shaping built it — that is a finding, not a pass.
  const src = [
    "async fn passthrough(code: i32, report: String) -> AppError {",
    "    AppError::Git {",
    "        code,",
    "        stderr: report,",
    "    }",
    "}",
  ].join("\n");
  const hits = [];
  checkStderrOnlyGitError("fixture.rs", src, src.split("\n"), hits);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].fn, "passthrough");
  assert.match(hits[0].fix, /cannot resolve/);
});

test("failure_text() substitution is caught apart from the combining helper", () => {
  const src = [
    "async fn substituting(out: GitOutput) -> AppError {",
    "    AppError::Git {",
    "        code: out.code,",
    "        stderr: out.failure_text(),",
    "    }",
    "}",
  ].join("\n");
  const hits = [];
  checkStderrOnlyGitError("fixture.rs", src, src.split("\n"), hits);
  assert.equal(hits.length, 1);
  assert.match(hits[0].fix, /SUBSTITUTES/);
});

test("a comment naming full_failure_text does not disarm the check", () => {
  // The verdict is read from the field VALUE as an expression; a window-wide
  // substring test would have accepted this site on the strength of its prose.
  const src = [
    "async fn commented(out: GitOutput) -> AppError {",
    "    // full_failure_text() is what this should use.",
    "    AppError::Git {",
    "        code: out.code,",
    "        stderr: out.stderr,",
    "    }",
    "}",
  ].join("\n");
  const hits = [];
  checkStderrOnlyGitError("fixture.rs", src, src.split("\n"), hits);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].fn, "commented");
});

test("a chain of stderr aliases is followed to its shaping", () => {
  // One hop lands on a bare ident that matches none of the shaping tests, which
  // reads as correctly shaped — so the walk has to continue.
  const src = [
    "async fn chained_bad(out: GitOutput) -> AppError {",
    "    let raw = out.stderr;",
    "    let report = raw;",
    "    AppError::Git {",
    "        code: out.code,",
    "        stderr: report,",
    "    }",
    "}",
    "async fn chained_ok(out: GitOutput) -> AppError {",
    "    let raw = out.full_failure_text();",
    "    let report = raw;",
    "    AppError::Git {",
    "        code: out.code,",
    "        stderr: report,",
    "    }",
    "}",
  ].join("\n");
  const hits = [];
  checkStderrOnlyGitError("fixture.rs", src, src.split("\n"), hits);
  assert.deepEqual(
    hits.map((h) => h.fn),
    ["chained_bad"],
  );
  assert.match(hits[0].fix, /full_failure_text/);
});

test("a cycle of stderr aliases fails closed", () => {
  const src = [
    "async fn looped(out: GitOutput) -> AppError {",
    "    let first = second;",
    "    let second = first;",
    "    AppError::Git {",
    "        code: out.code,",
    "        stderr: first,",
    "    }",
    "}",
  ].join("\n");
  const hits = [];
  checkStderrOnlyGitError("fixture.rs", src, src.split("\n"), hits);
  assert.equal(hits.length, 1);
  assert.match(hits[0].fix, /cannot resolve/);
});

test("a stderr field beyond a six-line constructor is still read", () => {
  // Brace balance, not a line count: rustfmt and a long field list push the
  // field down, and a window that ends first reads as "no stderr field".
  const src = [
    "async fn padded(out: GitOutput) -> AppError {",
    "    AppError::Git {",
    "        // one",
    "        // two",
    "        // three",
    "        // four",
    "        // five",
    "        // six",
    "        // seven",
    "        code: out.code,",
    "        stderr: out.stderr,",
    "    }",
    "}",
  ].join("\n");
  const hits = [];
  checkStderrOnlyGitError("fixture.rs", src, src.split("\n"), hits);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].fn, "padded");
});

test("an alias initializer is judged whole, not truncated at a `;`", () => {
  // The `;` that ends the statement can also sit inside a string literal, and
  // the truncated head matches no shaping test and is not an ident — a pass.
  const src = [
    "async fn semicolon_in_literal(out: GitOutput) -> AppError {",
    '    let report = format!("a; {}", out.stderr);',
    "    AppError::Git {",
    "        code: out.code,",
    "        stderr: report,",
    "    }",
    "}",
  ].join("\n");
  const hits = [];
  checkStderrOnlyGitError("fixture.rs", src, src.split("\n"), hits);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].fn, "semicolon_in_literal");
  assert.match(hits[0].fix, /full_failure_text/);
});

test("a `stderr:` inside a string literal does not answer for the real field", () => {
  // Matching the first `stderr:` in the text lets an earlier field's STRING
  // stand in for the field — and a string naming the correct helper passes.
  const src = [
    "async fn masked(out: GitOutput) -> AppError {",
    "    AppError::Git {",
    '        code: fallback("shape it as stderr: out.full_failure_text()"),',
    "        stderr: out.stderr,",
    "    }",
    "}",
  ].join("\n");
  const hits = [];
  checkStderrOnlyGitError("fixture.rs", src, src.split("\n"), hits);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].fn, "masked");
  assert.match(hits[0].fix, /full_failure_text/);
});

test("a raw string literal does not swallow the rest of a constructor", () => {
  // `r"\\?\"` ends at its own quote — raw literals honor no escapes — but an
  // escape-aware scan reads the trailing backslash as escaping that quote and
  // consumes everything after it, so the real field is never reached.
  const src = [
    "async fn raw_in_ctor(out: GitOutput) -> AppError {",
    "    AppError::Git {",
    String.raw`        code: parse(r"\\?\"),`,
    "        stderr: out.stderr,",
    "    }",
    "}",
  ].join("\n");
  const hits = [];
  checkStderrOnlyGitError("fixture.rs", src, src.split("\n"), hits);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].fn, "raw_in_ctor");
});

test("an attribute-decorated test module is still recognized as a span", () => {
  // The gate and the `mod` can be separated by outer attributes; missing the
  // span reads every renaming pattern inside it as an unresolvable field.
  const src = [
    "#[cfg(test)]",
    "#[allow(clippy::too_many_lines)]",
    "mod tests {",
    "    fn renamed(e: &AppError) {",
    "        if let AppError::Git { code: c, stderr: text } = e {",
    "            drop((c, text));",
    "        }",
    "    }",
    "}",
  ].join("\n");
  const hits = [];
  checkStderrOnlyGitError("fixture.rs", src, src.split("\n"), hits);
  assert.deepEqual(hits, []);
});

test("test modules are skipped by SPAN, so production code after one is scanned", () => {
  // A renaming pattern (`stderr: text`) is indistinguishable from an
  // unresolvable field, and only tests carry them. Cutting the scan at the
  // module instead of bounding it would leave everything below unchecked.
  const src = [
    "#[cfg(test)]",
    "mod tests {",
    "    fn renamed(e: &AppError) {",
    "        if let AppError::Git { code: c, stderr: text } = e {",
    "            drop((c, text));",
    "        }",
    "    }",
    "}",
    "async fn after_tests(out: GitOutput) -> AppError {",
    "    AppError::Git {",
    "        code: out.code,",
    "        stderr: out.stderr,",
    "    }",
    "}",
  ].join("\n");
  const hits = [];
  checkStderrOnlyGitError("fixture.rs", src, src.split("\n"), hits);
  assert.deepEqual(
    hits.map((h) => h.fn),
    ["after_tests"],
  );
});

// ----------------------------------------------------------- check-dead-surface

test("a commented-out handler entry does not read as registered", () => {
  // The dangerous direction: `foo` survives `split("::").pop()` from a
  // commented-out line, so a disabled-but-invoked command would read as clean.
  const source = [
    ".invoke_handler(tauri::generate_handler![",
    "    git::status,",
    "    // git::disabled_line,",
    "    /* git::disabled_block, */",
    "    git::commit,",
    "])",
  ].join("\n");
  assert.deepEqual([...parseRegistered(source, "fixture")].sort(), [
    "commit",
    "status",
  ]);
});

test("the registered parser survives nested brackets and a missing marker", () => {
  const nested = [
    "tauri::generate_handler![",
    "    git::status,",
    "    with_array::[a],",
    "    git::commit",
    "]",
  ].join("\n");
  const names = parseRegistered(nested, "fixture");
  assert.ok(names.has("status") && names.has("commit"));
  assert.throws(
    () => parseRegistered("no handler here", "fixture"),
    /Could not find/,
  );
});

test("a commented-out invoke does not read as a live call", () => {
  // The mirror of the handler-list bug: a retired command whose only call site
  // is commented out would otherwise stay "invoked" and never surface as dead.
  const source = [
    'const a = invoke("git_status");',
    '// const b = invoke("git_retired_command");',
    "/*",
    'const c = invoke("git_retired_block");',
    "*/",
    // A comment-shaped string is not a comment: this call still counts.
    'const d = invoke("git_open_url"); // see https://example.dev/docs',
  ].join("\n");
  assert.deepEqual([...parseInvoked(source)].sort(), [
    "git_open_url",
    "git_status",
  ]);
});

test("an allowlist entry that suppresses nothing is stale, in both shapes", () => {
  const registered = new Set(["git_status", "git_commit", "git_menu_only"]);
  const invoked = new Set(["git_status"]);
  // Only registered-but-uninvoked (`git_menu_only`) is what an entry is FOR, so
  // it stays. The other two shapes both suppress nothing: a command the handler
  // list no longer registers, and one with a live caller — which never reaches
  // the `dead` filter, so its entry quiets a hit that cannot happen.
  assert.deepEqual(
    staleCommandEntries(
      ["git_menu_only", "git_status", "git_retired_command"],
      registered,
      invoked,
    ),
    ["git_retired_command", "git_status"],
  );
  // The empty allowlist (today's tree) is a no-op, not a failure.
  assert.deepEqual(staleCommandEntries([], registered, invoked), []);
});

test("invoke matching survives nested generics and wrapped calls", () => {
  const source = [
    'const a = invoke<Record<string, string>>("git_branch_tips");',
    "const b = await invoke<PublishTarget[]>(",
    '  "forge_publish_targets",',
    ");",
    'const c = invoke("git_status");',
  ].join("\n");
  assert.deepEqual([...parseInvoked(source)].sort(), [
    "forge_publish_targets",
    "git_branch_tips",
    "git_status",
  ]);
});
