#!/usr/bin/env node
// Drift gate for the git-whitelist hard rule, which lives in FIVE carriers by
// design — the canonical playbook, its always-loaded excerpt, the repo
// AGENTS.md that agents outside Claude auto-load, and the two agent definitions
// that restate it as their own charter. Two review findings in one round came
// from a rule changing in one carrier and not the others, so the class ships
// its guard: each carrier must still state the whitelist's core.
//
// PRESENCE, not equality: the copies word the rule differently on purpose (one
// is a numbered hard rule, one a bullet, one prose for a different audience),
// so verbatim comparison would fail on every legitimate edit. Each sentinel is
// the smallest phrase whose ABSENCE means a carrier lost the rule.
//
// Matching runs over whitespace-NORMALIZED text: every carrier hand-wraps at a
// different width, so a line break inside a sentinel phrase would otherwise
// read as a missing rule.
//
// Run: node scripts/check-rule-mirrors.mjs
// GD_RULE_MIRROR_ROOT points the check at a copy of the tree, for an ad-hoc
// negative control by hand: copy the carriers, mutate one, watch it go red.
// The committed controls live in scripts/checks.test.mjs and drive
// `missingSentinels` in memory, touching no disk.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Every file that states the git-whitelist rule. */
export const CARRIERS = [
  ".claude/skills/gd-conventions/SKILL.md",
  ".claude/rules/git-safety.md",
  "AGENTS.md",
  ".claude/agents/implementer.md",
  ".claude/agents/spec-reviewer.md",
];

/**
 * Each sentinel names what its absence would mean, and carries the fix a
 * reader needs — never just "pattern not found".
 */
export const SENTINELS = [
  {
    name: "read-only git forms",
    pattern: /git --no-pager diff/,
    fix: "state the permitted read-only forms, starting `git --no-pager diff`",
  },
  {
    name: "branch --list allowance",
    pattern: /git branch --list/,
    fix: "keep `git branch --list` in the permitted set",
  },
  {
    name: "forbidden catchall",
    // The lookahead is the point: a carrier that keeps the sentence and then
    // carves an exception out of it ("is forbidden, except …") has lost the
    // rule as surely as one that deleted it.
    pattern:
      /(everything else|every other git invocation|every state-mutating git command)[\s\S]{0,300}?is forbidden(?!\s*(?:,|;|—|-)?\s*(?:except|but|unless)\b)/i,
    fix: "keep the catchall sentence that forbids every other git invocation",
  },
  {
    name: "-C worktree sanction",
    pattern: /-C <path>[^.]{0,40}task worktree/i,
    fix: "sanction the `-C <path>` form so worktree-scoped commands stay legal",
  },
];

export const normalize = (text) => text.replace(/\s+/g, " ");

/** Sentinels a carrier's text no longer satisfies. */
export function missingSentinels(text, sentinels = SENTINELS) {
  const flat = normalize(text);
  return sentinels.filter((s) => !s.pattern.test(flat));
}

function main() {
  const root = process.env.GD_RULE_MIRROR_ROOT
    ? resolve(process.env.GD_RULE_MIRROR_ROOT)
    : REPO_ROOT;

  let failed = false;
  for (const carrier of CARRIERS) {
    let text;
    try {
      text = readFileSync(join(root, carrier), "utf8");
    } catch (err) {
      failed = true;
      process.stderr.write(`rule-mirrors: FAIL — cannot read ${carrier}\n`);
      process.stderr.write(`    ${err.message}\n`);
      continue;
    }
    const missing = missingSentinels(text);
    if (missing.length === 0) {
      process.stdout.write(
        `rule-mirrors: OK ${carrier} (${SENTINELS.length} sentinels)\n`,
      );
      continue;
    }
    failed = true;
    process.stderr.write(
      `rule-mirrors: FAIL ${carrier} (${missing.length} of ${SENTINELS.length} sentinels missing)\n`,
    );
    for (const s of missing) {
      process.stderr.write(`  missing: ${s.name}\n`);
      process.stderr.write(`    ${s.fix}\n`);
    }
  }

  // Not `process.exit`: it can truncate a pending pipe write, losing the very
  // finding the failure is about on a CI runner.
  process.exitCode = failed ? 1 : 0;
}

// Main-module detection by PATH comparison, not `import.meta.main`: that form
// only exists from node 24.2 and fails SILENTLY on older runtimes (the gate
// reads `if (undefined)` and exits 0 having checked nothing).
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
