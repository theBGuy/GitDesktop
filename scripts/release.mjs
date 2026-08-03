#!/usr/bin/env node
// Interactive release driver for GitDesktop. One command drives the whole
// release runbook: checks preconditions, previews what's shipping, proposes a
// patch/minor/major bump, then (on confirmation) runs release:prepare, syncs
// Cargo.lock, and commits + tags + pushes. Usage:
//   pnpm release              (interactive)
//   pnpm release --dry-run    (rehearse: prints every mutating step, writes nothing)
//   pnpm release --no-merge   (passed through to release:prepare)
//
// It also fixes two runbook defects the manual path has hit before:
//   1. release tags here are LIGHTWEIGHT, so `git push --follow-tags` silently
//      skips them (this dropped the v0.2.0 tag). We push the tag explicitly.
//   2. release:prepare bumps package.json + Cargo.toml but NOT Cargo.lock,
//      whose gitdesktop [[package]] entry also carries the version. We sync it.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  readFragments,
  readLF,
  renderGroupBlocks,
  writeLF,
} from "./changelog-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");
const noMerge = process.argv.includes("--no-merge");

// --- tiny ANSI + emoji helpers (colors only when attached to a TTY) ---------
const tty = process.stdout.isTTY;
const paint = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => paint("1", s);
const dim = (s) => paint("2", s);
const green = (s) => paint("32", s);
const yellow = (s) => paint("33", s);
const red = (s) => paint("31", s);
const cyan = (s) => paint("36", s);
const rule = () => process.stdout.write(dim("─".repeat(60)) + "\n");
const say = (s) => process.stdout.write(`${s}\n`);
const ok = (s) => say(`${green("✓")} ${s}`);
const warn = (s) => say(`${yellow("⚠")}  ${s}`);
const bad = (s) => say(`${red("✗")} ${s}`);

// A precondition failure. In real mode ✗ aborts; in dry-run it downgrades to a
// warning so the runbook can be rehearsed against any working-tree state.
const fatal = (msg) => {
  if (dryRun) {
    warn(msg);
    return;
  }
  bad(msg);
  process.exit(1);
};

// Read stdin line-by-line into a queue. `readline/promises`' `question()` hangs
// on EOF and (with piped input) delivers only the first buffered line before
// stalling, so we drive plain readline ourselves: buffer `line` events, hand
// them to waiting prompts, and resolve to null on `close` (EOF) so a prompt
// past the supplied input aborts cleanly instead of hanging.
const rl = createInterface({ input: process.stdin });
const lineQueue = [];
const waiters = [];
let stdinClosed = false;
rl.on("line", (line) => {
  const w = waiters.shift();
  if (w) w(line);
  else lineQueue.push(line);
});
rl.on("close", () => {
  stdinClosed = true;
  while (waiters.length) waiters.shift()(null);
});

// Ask a question; on EOF (piped input exhausted) exit cleanly rather than
// hanging or throwing an unhandled rejection.
async function ask(prompt) {
  process.stdout.write(prompt);
  let answer;
  if (lineQueue.length) answer = lineQueue.shift();
  else if (stdinClosed) answer = null;
  else answer = await new Promise((resolve) => waiters.push(resolve));
  if (answer === null) {
    say("");
    bad("aborted (stdin closed)");
    rl.close();
    process.exit(1);
  }
  return answer.trim();
}

async function confirm(prompt, defaultYes) {
  const suffix = defaultYes ? " [Y/n] " : " [y/N] ";
  const a = (await ask(prompt + suffix)).toLowerCase();
  if (a === "") return defaultYes;
  return a === "y" || a === "yes";
}

// --- process execution (array args, never shell:true — Windows quoting) -----

// Capture form: returns trimmed stdout, or null when the command fails.
function capture(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.status !== 0 || r.error) return null;
  return (r.stdout || "").trim();
}

// Inherit form for visible mutating commands: streams to the terminal and
// hard-fails on nonzero exit. In dry-run it only prints what it would run.
function run(cmd, args) {
  const printable = [cmd, ...args].join(" ");
  if (dryRun) {
    say(dim(`[dry-run] would run: ${printable}`));
    return;
  }
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.error || r.status !== 0) {
    bad(`command failed: ${printable}`);
    rl.close();
    process.exit(1);
  }
}

const git = (...args) => capture("git", args);

// --- semver helpers ---------------------------------------------------------
const parseSemver = (v) => v.split(".").map(Number);
// Strictly-greater numeric per-part compare (never string compare).
function isGreater(a, b) {
  const [a1, a2, a3] = parseSemver(a);
  const [b1, b2, b3] = parseSemver(b);
  if (a1 !== b1) return a1 > b1;
  if (a2 !== b2) return a2 > b2;
  return a3 > b3;
}
function bump(v, kind) {
  const [maj, min, pat] = parseSemver(v);
  if (kind === "major") return `${maj + 1}.0.0`;
  if (kind === "minor") return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

async function main() {
  say("");
  say(`🚀 ${bold("GitDesktop release")}${dryRun ? dim("  (dry run)") : ""}`);
  rule();

  // === 1. Preconditions =====================================================
  say(bold("Preconditions"));

  // git fetch first so freshness checks see the real origin state (a read, so
  // performed in dry-run too). An offline failure is a warning, not an abort.
  const fetch = spawnSync("git", ["fetch", "origin", "--tags"], {
    encoding: "utf8",
  });
  if (fetch.error || fetch.status !== 0) {
    warn("could not fetch; freshness checks may be stale");
  } else {
    ok("fetched origin --tags");
  }

  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch === "master") {
    ok("on branch master");
  } else {
    fatal(`current branch is '${branch}', not master`);
  }

  // Clean tree: tracked changes abort; uncommitted changelog fragments abort
  // (release:prepare would consume and DELETE them); other untracked → warn.
  const porcelain = git("status", "--porcelain") ?? "";
  const statusLines = porcelain.split("\n").filter((l) => l.length > 0);
  const trackedDirty = statusLines.filter((l) => !l.startsWith("??"));
  const untracked = statusLines
    .filter((l) => l.startsWith("??"))
    .map((l) => l.slice(3));
  const untrackedFragments = untracked.filter(
    (p) => p.startsWith("changelog.d/") && p !== "changelog.d/README.md",
  );
  const otherUntracked = untracked.filter(
    (p) => !untrackedFragments.includes(p),
  );

  if (trackedDirty.length === 0) {
    ok("working tree has no tracked changes");
  } else {
    fatal(
      `working tree has ${trackedDirty.length} tracked change(s) — the release commit must contain only release changes`,
    );
  }
  if (untrackedFragments.length > 0) {
    fatal(
      `uncommitted changelog fragment(s) present (${untrackedFragments.join(", ")}) — release:prepare would consume and DELETE them; commit the feature first`,
    );
  } else {
    ok("no uncommitted changelog fragments");
  }
  if (otherUntracked.length > 0) {
    warn(
      `untracked files present (ignored by the release): ${otherUntracked.join(", ")}`,
    );
  }

  // master vs origin/master.
  const behind = Number(
    git("rev-list", "--count", "master..origin/master") ?? "0",
  );
  const ahead = Number(
    git("rev-list", "--count", "origin/master..master") ?? "0",
  );
  if (behind > 0) {
    fatal(`master is ${behind} commit(s) behind origin/master — pull first`);
  } else if (ahead > 0) {
    warn(
      `master is ${ahead} commit(s) ahead of origin/master — the release push will publish these:`,
    );
    const list = git("log", "origin/master..master", "--oneline") ?? "";
    for (const l of list.split("\n").filter(Boolean)) say(`    ${dim(l)}`);
    if (
      !dryRun &&
      !(await confirm("Continue and publish these commits?", false))
    ) {
      bad("aborted");
      rl.close();
      process.exit(1);
    }
  } else {
    ok("master is level with origin/master");
  }

  // gh availability (never fatal — the watch step degrades to printed URLs).
  const ghVersion = capture("gh", ["--version"]);
  const hasGh = ghVersion !== null;
  if (hasGh) {
    ok(`gh CLI available (${ghVersion.split("\n")[0]})`);
  } else {
    warn("gh CLI not found — release watch will degrade to printed URLs");
  }

  // === 2. Context ===========================================================
  say("");
  say(bold("Context"));

  const pkgSrc = readLF(join(root, "package.json"));
  const pkgMatch = pkgSrc.match(/"version":\s*"(\d+\.\d+\.\d+)"/);
  if (!pkgMatch) {
    bad("could not parse the version from package.json");
    rl.close();
    process.exit(1);
  }
  const currentVersion = pkgMatch[1];

  const tagList = (git("tag", "--list", "v*", "--sort=-v:refname") ?? "")
    .split("\n")
    .map((t) => t.trim())
    .filter((t) => /^v\d+\.\d+\.\d+$/.test(t));
  const latestTag = tagList[0] ?? null;

  say(
    `📦 Current version: ${bold(currentVersion)}   ${dim(`(latest tag: ${latestTag ?? "none"})`)}`,
  );
  if (latestTag && `v${currentVersion}` !== latestTag) {
    warn(
      `package.json (v${currentVersion}) and latest tag (${latestTag}) disagree — suggestions use the package.json version`,
    );
  }

  // Commits since the latest tag (against origin/master).
  const sinceRange = latestTag
    ? `${latestTag}..origin/master`
    : "origin/master";
  const sinceRaw = git("log", sinceRange, "--oneline", "--no-merges") ?? "";
  const sinceLines = sinceRaw.split("\n").filter(Boolean);
  const commitCount = sinceLines.length;
  say(
    `   ${commitCount} commit(s) since ${latestTag ?? "the start of history"}:`,
  );
  for (const l of sinceLines.slice(0, 25)) say(`    ${dim(l)}`);
  if (sinceLines.length > 25)
    say(`    ${dim(`… and ${sinceLines.length - 25} more`)}`);
  if (!latestTag)
    say(
      dim(
        "   (no release tags yet — suggestions use the package.json version)",
      ),
    );

  // Pending fragments.
  const { groups } = readFragments(join(root, "changelog.d"));
  const fragmentBlocks = renderGroupBlocks(groups);
  const fragmentCount =
    groups.Added.length + groups.Changed.length + groups.Fixed.length;
  say("");
  say(`   ${bold("Pending changelog fragments:")} ${fragmentCount}`);
  if (fragmentBlocks.length) {
    for (const l of fragmentBlocks) say(`    ${l}`);
  }

  // Peek at CHANGELOG.md's [Unreleased] body (same locate logic as
  // changelog-release.mjs step 2).
  const clLines = readLF(join(root, "CHANGELOG.md")).split("\n");
  const unreleasedIdx = clLines.findIndex((l) =>
    /^##\s*\[Unreleased\]/i.test(l),
  );
  let unreleasedBody = [];
  if (unreleasedIdx !== -1) {
    let nextIdx = clLines.length;
    for (let i = unreleasedIdx + 1; i < clLines.length; i++) {
      if (/^##\s*\[/.test(clLines[i])) {
        nextIdx = i;
        break;
      }
    }
    unreleasedBody = clLines.slice(unreleasedIdx + 1, nextIdx);
  }
  const unreleasedHasContent = unreleasedBody.some((l) => l.trim() !== "");
  if (unreleasedHasContent) {
    say(dim("   hand-written Unreleased notes present — will be merged"));
  }

  if (fragmentCount === 0 && !unreleasedHasContent) {
    warn("release notes will be empty (no fragments, no Unreleased body)");
    if (!(await confirm("Release with empty notes?", false))) {
      bad("aborted");
      rl.close();
      process.exit(1);
    }
  }

  // === 3. Version selection =================================================
  say("");
  say(bold("Version"));
  const options = [
    ["Patch", bump(currentVersion, "patch")],
    ["Minor", bump(currentVersion, "minor")],
    ["Major", bump(currentVersion, "major")],
  ];
  say(
    `Current version: ${bold(currentVersion)}   ${dim(`(latest tag: ${latestTag ?? "none"})`)}`,
  );
  options.forEach(([label, v], i) =>
    say(`  ${i + 1}) ${label} → ${cyan(`v${v}`)}`),
  );

  // Outer: pick the bump (default patch). Inner: the free-text override, which
  // re-prompts on garbage / an existing tag without losing the chosen bump.
  let suggested;
  while (true) {
    const choice = (await ask("Choice [1]: ")) || "1";
    const idx = Number(choice) - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx > 2) {
      warn("enter 1, 2, or 3");
      continue;
    }
    suggested = options[idx][1];
    break;
  }

  let chosen;
  while (true) {
    const overrideRaw = await ask(`Version [${suggested}]: `);
    const candidate = (overrideRaw || suggested).replace(/^v/, "");
    if (!/^\d+\.\d+\.\d+$/.test(candidate)) {
      warn(`'${candidate}' is not a valid X.Y.Z version`);
      continue;
    }
    const existing = git("tag", "--list", `v${candidate}`);
    if (existing) {
      warn(`tag v${candidate} already exists — choose another version`);
      continue;
    }
    if (!isGreater(candidate, currentVersion)) {
      if (
        !(await confirm(
          `v${candidate} is not greater than the current v${currentVersion} — proceed anyway?`,
          false,
        ))
      ) {
        continue;
      }
    }
    chosen = candidate;
    break;
  }
  const tag = `v${chosen}`;

  // === 4. Plan + confirm ====================================================
  say("");
  rule();
  say(bold("Release plan"));
  const perCat = ["Added", "Changed", "Fixed"]
    .filter((c) => groups[c].length)
    .map((c) => `${groups[c].length} ${c}`)
    .join(", ");
  say(`  Version:   ${bold(chosen)}  (tag ${cyan(tag)})`);
  say(`  Fragments: ${fragmentCount}${perCat ? ` (${perCat})` : ""}`);
  say(`  Commits:   ${commitCount} since ${latestTag ?? "start"}`);
  say("  Steps:");
  say(
    "    1. release:prepare (assemble changelog, bump package.json + Cargo.toml)",
  );
  say("    2. sync src-tauri/Cargo.lock");
  say("    3. commit");
  say(`    4. tag ${tag}`);
  say("    5. push master + tag atomically");
  rule();
  if (!(await confirm("Proceed?", true))) {
    bad("aborted");
    rl.close();
    process.exit(1);
  }

  // === 5. Prepare ===========================================================
  say("");
  say(bold("Preparing release…"));
  const prepareArgs = ["scripts/changelog-release.mjs", chosen];
  if (noMerge) prepareArgs.push("--no-merge");
  // In dry-run we must NOT invoke changelog-release.mjs — it deletes fragments.
  run("node", prepareArgs);

  // Cargo.lock sync: release:prepare skips it, but the gitdesktop [[package]]
  // entry carries the version too (an unsynced lock only shipped by accident).
  const lockPath = join(root, "src-tauri", "Cargo.lock");
  if (dryRun) {
    say(
      dim(
        `[dry-run] would sync ${lockPath} name="gitdesktop" version → ${chosen}`,
      ),
    );
  } else {
    const lockSrc = readLF(lockPath);
    const lockRe = /(name = "gitdesktop"\nversion = ")\d+\.\d+\.\d+(")/;
    if (!lockRe.test(lockSrc)) {
      bad(`could not find the gitdesktop version entry in ${lockPath}`);
      rl.close();
      process.exit(1);
    }
    writeLF(lockPath, lockSrc.replace(lockRe, `$1${chosen}$2`));
    ok("synced src-tauri/Cargo.lock");
  }

  // === 6. Review gate =======================================================
  say("");
  say(bold("Review"));
  if (dryRun) {
    // Nothing was written, so there is no diff to gate on — skip the review
    // prompt entirely and preview the commit/tag/push steps below.
    say(dim("[dry-run] would run: git --no-pager diff --stat"));
    say(dim("[dry-run] review gate skipped (no changes to review)"));
  } else {
    run("git", ["--no-pager", "diff", "--stat"]);
  }

  while (!dryRun) {
    const a = (
      await ask(
        "(y) commit + tag + push · (d) show full CHANGELOG.md diff · (n) abort: ",
      )
    ).toLowerCase();
    if (a === "y" || a === "yes") break;
    if (a === "d") {
      if (dryRun) {
        say(dim("[dry-run] would run: git --no-pager diff -- CHANGELOG.md"));
      } else {
        run("git", ["--no-pager", "diff", "--", "CHANGELOG.md"]);
      }
      continue;
    }
    if (a === "n" || a === "no") {
      const restoreCmd =
        "git restore CHANGELOG.md package.json src-tauri/Cargo.toml src-tauri/Cargo.lock changelog.d";
      // Safe because the clean-tree gate passed: everything restored was clean
      // at start, and restoring the dir resurrects the deleted tracked fragments.
      if (await confirm("Revert the prepared changes?", false)) {
        run("git", [
          "restore",
          "CHANGELOG.md",
          "package.json",
          "src-tauri/Cargo.toml",
          "src-tauri/Cargo.lock",
          "changelog.d",
        ]);
      } else {
        say("To revert manually, run:");
        say(`  ${restoreCmd}`);
      }
      bad("aborted");
      rl.close();
      process.exit(1);
    }
    warn("enter y, d, or n");
  }

  // === 7. Commit + tag + push ===============================================
  say("");
  say(bold("Committing, tagging, pushing…"));
  run("git", [
    "add",
    "CHANGELOG.md",
    "package.json",
    "src-tauri/Cargo.toml",
    "src-tauri/Cargo.lock",
    "changelog.d",
  ]);
  run("git", ["commit", "-m", `chore(release): ${tag}`]);
  // Lightweight tag — matches v0.1.0/v0.2.0.
  run("git", ["tag", tag]);
  if (dryRun) {
    say(dim(`[dry-run] would run: git push --atomic origin master ${tag}`));
  } else {
    // One atomic push — both refs land or neither does. We push the tag
    // explicitly: it is lightweight, so --follow-tags would silently skip it.
    // Rides the ruleset's Repository-admin always-bypass (build + fragment are
    // required checks); losing that bypass rejects this push, tag included.
    const push = spawnSync(
      "git",
      ["push", "--atomic", "origin", "master", tag],
      { stdio: "inherit" },
    );
    if (push.error || push.status !== 0) {
      say("");
      bad(
        "push failed. Recovery: a pull --rebase moves the release commit, so re-point the tag:",
      );
      say(
        `  git pull --rebase origin master && git tag -f ${tag} && git push --atomic origin master ${tag}`,
      );
      rl.close();
      process.exit(1);
    }
    ok(`pushed master + ${tag}`);
  }

  // === 8. Post-push =========================================================
  const { owner, repo } = parseOriginRemote(git("remote", "get-url", "origin"));

  if (hasGh && !dryRun) {
    if (await confirm("Watch the release build now?", true)) {
      const runId = await findReleaseRun(tag);
      if (runId) {
        // Soft call (not the hard-failing run()): watching is long-running and
        // the user may Ctrl+C, so a nonzero exit — an interrupt or a red leg —
        // must not suppress the closing checklist printed below.
        spawnSync("gh", ["run", "watch", String(runId)], { stdio: "inherit" });
      } else {
        warn("release run did not appear yet — check the Actions page below");
      }
    }
  }

  say("");
  rule();
  say(green(`✅ ${dryRun ? "Dry run complete" : "Release pushed"}: ${tag}`));
  printChecklist(owner, repo, chosen);
  rl.close();
  process.exit(0);
}

// Derive owner/repo from an origin URL (https or ssh, optional .git).
function parseOriginRemote(url) {
  if (!url) return { owner: "OWNER", repo: "REPO" };
  const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
  if (!m) return { owner: "OWNER", repo: "REPO" };
  return { owner: m[1], repo: m[2] };
}

// Poll gh for the release run whose headBranch is the tag (tag pushes surface
// the tag name there). Newest createdAt wins if several match.
async function findReleaseRun(tag) {
  for (let i = 0; i < 12; i++) {
    const json = capture("gh", [
      "run",
      "list",
      "--workflow=release.yml",
      "--limit",
      "10",
      "--json",
      "databaseId,headBranch,status,createdAt",
    ]);
    if (json) {
      try {
        const runs = JSON.parse(json)
          .filter((r) => r.headBranch === tag)
          .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
        if (runs.length) return runs[0].databaseId;
      } catch {
        // malformed output — fall through to retry / URL
      }
    }
    await sleep(5000);
  }
  return null;
}

function printChecklist(owner, repo, version) {
  say("");
  say(bold("Next steps:"));
  say(
    `  1. Wait for all 3 platform legs (Windows, Linux, macOS universal) to go green (~30–45 min):`,
  );
  say(`     https://github.com/${owner}/${repo}/actions/workflows/release.yml`);
  say(
    `  2. Publish the DRAFT release: https://github.com/${owner}/${repo}/releases`,
  );
  say(
    `     (publishing flips releases/latest/download/latest.json over to v${version})`,
  );
  say(`  3. Verify the updater redirect:`);
  say(
    `     curl -sI https://github.com/${owner}/${repo}/releases/latest/download/latest.json`,
  );
  say(`     → expect HTTP 302 with the new version in the location`);
  say(
    dim("Note: MSI installs never auto-update (latest.json offers NSIS only)."),
  );
}

main().catch((err) => {
  bad(`unexpected error: ${err?.message ?? err}`);
  rl.close();
  process.exit(1);
});
