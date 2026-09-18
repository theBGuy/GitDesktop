#!/usr/bin/env node
// Drift gate for the skills that ship in TWO trees by design: `.claude/skills/`
// (Claude Code) and `.agents/skills/` (the codex / opencode lanes). Nothing
// reads both, so a fix applied to one tree is invisible in the other — and that
// already happened: the repo-tuned "Applicability in this repo (GitDesktop)"
// section lived only in the `.claude` copy of vercel-react-best-practices,
// leaving the other lane reading upstream text that tells it to apply RSC, SSR
// and hydration rules to a Tauri SPA.
//
// EQUALITY, not presence — the opposite of check-rule-mirrors.mjs, and for the
// opposite reason: these carriers are copies of one upstream document, so any
// wording difference between them is drift rather than audience-appropriate
// phrasing. Equality is asserted over NORMALIZED text, because three classes of
// difference are legitimate and mechanical:
//   1. line endings — the two trees were installed at different times, so one
//      copy can be CRLF and the other LF with identical content;
//   2. each tree's self-referencing paths (`.agents/skills/…` vs
//      `.claude/skills/…`);
//   3. the command-invocation sigil, which differs per harness (`/skill` in
//      Claude, `$skill` elsewhere).
// YAML frontmatter is excluded entirely: it carries harness-specific keys
// (`user-invocable`, `allowed-tools`, `argument-hint`) that only one tree honors.
//
// Gating is by INTERSECTION, discovered at run time rather than listed: a skill
// added to both trees is gated automatically, and one that exists in a single
// tree (delegate, gd-conventions — Claude-only by design) is reported and
// skipped. That way a new mirrored skill cannot be added ungated.
//
// Run: node scripts/check-skill-mirrors.mjs
// GD_SKILL_MIRROR_ROOT points the check at a copy of the tree, for an ad-hoc
// negative control by hand: copy the trees, mutate one file, watch it go red.
// The committed controls live in scripts/checks.test.mjs and drive `diffTrees`
// in memory, touching no disk.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const CLAUDE_TREE = ".claude/skills";
export const AGENTS_TREE = ".agents/skills";

/**
 * Skills whose two copies are deliberately NOT identical, with the reason.
 * `impeccable` ships per-harness rewrites of its own instructions — 17 reference
 * files phrase the same step for a different tool ("call the AskUserQuestion
 * tool" vs "use Codex's structured user-input/question tool") and the `.agents`
 * copy carries agent definitions (`agents/*.toml`, `agents/openai.yaml`) that
 * have no Claude counterpart. Gating it would fail on every legitimate edit.
 */
export const EXEMPT = new Map([
  [
    "impeccable",
    "ships per-harness instruction rewrites and non-Claude agent definitions",
  ],
]);

/**
 * Skills that legitimately live in ONE tree, with the reason. This is an
 * allowlist rather than an inference, because "exists in one tree" is also what
 * a DELETED mirror copy looks like — the largest drift there is. Anything
 * single-tree and unlisted fails.
 */
export const SINGLE_TREE = new Map([
  [
    "delegate",
    "Claude-only orchestration skill, junction-mounted from the owner's skills repo",
  ],
  [
    "gd-conventions",
    "Claude-only repo playbook, preloaded into the Claude subagents",
  ],
]);

/** Extensions compared as text; everything else is compared by content hash. */
const TEXT_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".json",
  ".yml",
  ".yaml",
  ".toml",
  ".mjs",
  ".js",
  ".cjs",
  ".ts",
  ".tsx",
  ".css",
  ".html",
  ".sh",
  ".ps1",
  ".",
]);

export const isTextFile = (relPath) =>
  TEXT_EXTENSIONS.has(extname(relPath).toLowerCase() || ".");

/**
 * Splits a leading YAML frontmatter block from the body. A block counts only if
 * it holds at least one `key:` line — otherwise a document opening with a `---`
 * horizontal rule would have everything up to the next `---` swallowed as
 * frontmatter, hiding real body drift.
 */
export function splitFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match || !/^[A-Za-z_][\w-]*:/m.test(match[1]))
    return { frontmatter: null, body: text };
  return { frontmatter: match[1], body: text.slice(match[0].length) };
}

/**
 * The frontmatter fields that are CONTENT rather than harness config. `name` and
 * `description` drive whether a skill is discovered and when it loads, so a
 * one-tree rewrite of either is real drift; `allowed-tools`, `user-invocable`
 * and `argument-hint` are Claude-only keys and are ignored.
 */
export function gatedFields(frontmatter) {
  if (frontmatter === null) return { present: false };
  const field = (key) =>
    frontmatter
      .match(
        new RegExp(
          `^${key}:[ \\t]*([\\s\\S]*?)(?=\\n[A-Za-z_][\\w-]*:|$)`,
          "m",
        ),
      )?.[1]
      ?.trim() ?? null;
  return {
    present: true,
    name: field("name"),
    description: field("description"),
  };
}

/**
 * The mechanical, legitimate differences between the two trees. `skillName`
 * scopes the command-sigil rule to the skill's OWN command: stripping every
 * backticked `/token` would also equate unrelated prose such as `/products`
 * with `$products`, and a backticked regex flag `/g` with `$g`.
 */
export const normalize = (text, skillName = null) => {
  let out = splitFrontmatter(text.replace(/\r\n/g, "\n")).body.replaceAll(
    `${AGENTS_TREE}/`,
    `${CLAUDE_TREE}/`,
  );
  if (skillName) {
    const escaped = skillName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp("`[/$](?=" + escaped + "\\b)", "g"), "`");
  }
  return out;
};

/**
 * Compares two skill copies given as Map<relativePath, fileContents>. Pure, so
 * the committed controls exercise it without touching disk.
 */
export function diffTrees(claudeFiles, agentsFiles, skillName = null) {
  const onlyClaude = [...claudeFiles.keys()]
    .filter((f) => !agentsFiles.has(f))
    .sort();
  const onlyAgents = [...agentsFiles.keys()]
    .filter((f) => !claudeFiles.has(f))
    .sort();
  const shared = [...claudeFiles.keys()].filter((f) => agentsFiles.has(f));
  const differ = shared
    .filter(
      (f) =>
        normalize(claudeFiles.get(f), skillName) !==
        normalize(agentsFiles.get(f), skillName),
    )
    .sort();
  const frontmatter = [];
  for (const f of shared.sort()) {
    const a = gatedFields(
      splitFrontmatter(claudeFiles.get(f).replace(/\r\n/g, "\n")).frontmatter,
    );
    const b = gatedFields(
      splitFrontmatter(agentsFiles.get(f).replace(/\r\n/g, "\n")).frontmatter,
    );
    if (a.present !== b.present) {
      frontmatter.push({
        file: f,
        field: "frontmatter block",
        reason: "present in only one copy",
      });
      continue;
    }
    if (!a.present) continue;
    for (const key of ["name", "description"])
      if (a[key] !== b[key])
        frontmatter.push({ file: f, field: key, reason: "values differ" });
  }
  return { onlyClaude, onlyAgents, differ, frontmatter };
}

/**
 * A Dirent for an NTFS junction reports isDirectory() FALSE and
 * isSymbolicLink() TRUE, so a bare isDirectory() filter drops junction-mounted
 * skills silently — a fail-open, since a dropped skill produces no line at all.
 * statSync follows the link; a broken mount throws and is treated as not-a-dir.
 */
function isDirectory(entry, fullPath) {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return statSync(fullPath).isDirectory();
  } catch {
    return false;
  }
}

function readTree(dir) {
  const files = new Map();
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (isDirectory(entry, full)) {
        walk(full);
        continue;
      }
      const rel = relative(dir, full).split("\\").join("/");
      // Binary assets (shadcn ships PNGs) are compared by hash: a utf8 decode
      // collapses every invalid byte to U+FFFD, so two different images can
      // decode to the same string and compare equal.
      files.set(
        rel,
        isTextFile(rel)
          ? readFileSync(full, "utf8")
          : `sha256:${createHash("sha256").update(readFileSync(full)).digest("hex")}`,
      );
    }
  };
  walk(dir);
  return files;
}

const listSkills = (dir) =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((e) => isDirectory(e, join(dir, e.name)))
        .map((e) => e.name)
        .sort()
    : [];

function main() {
  const root = process.env.GD_SKILL_MIRROR_ROOT
    ? resolve(process.env.GD_SKILL_MIRROR_ROOT)
    : REPO_ROOT;

  const claudeDir = join(root, CLAUDE_TREE);
  const agentsDir = join(root, AGENTS_TREE);
  const claudeSkills = listSkills(claudeDir);
  const agentsSkills = listSkills(agentsDir);
  const mirrored = claudeSkills.filter((n) => agentsSkills.includes(n));

  if (mirrored.length === 0) {
    process.stderr.write(
      "skill-mirrors: FAIL — no skill exists in both trees; the gate would pass vacuously\n",
    );
    process.stderr.write(`    looked in ${CLAUDE_TREE} and ${AGENTS_TREE}\n`);
    process.exitCode = 1;
    return;
  }

  let failed = false;
  for (const name of mirrored) {
    const reason = EXEMPT.get(name);
    if (reason) {
      process.stdout.write(`skill-mirrors: SKIP ${name} (exempt: ${reason})\n`);
      continue;
    }
    const { onlyClaude, onlyAgents, differ, frontmatter } = diffTrees(
      readTree(join(claudeDir, name)),
      readTree(join(agentsDir, name)),
      name,
    );
    if (
      onlyClaude.length === 0 &&
      onlyAgents.length === 0 &&
      differ.length === 0 &&
      frontmatter.length === 0
    ) {
      process.stdout.write(`skill-mirrors: OK ${name}\n`);
      continue;
    }
    failed = true;
    process.stderr.write(
      `skill-mirrors: FAIL ${name} — the two copies have drifted\n`,
    );
    for (const { file, field, reason } of frontmatter) {
      process.stderr.write(`  frontmatter ${field} ${reason}: ${file}\n`);
      process.stderr.write(
        "    name and description decide when the skill loads — keep them equal\n",
      );
    }
    for (const f of differ) {
      process.stderr.write(`  differs: ${f}\n`);
      process.stderr.write(
        `    copy the intended version over the other: ${CLAUDE_TREE}/${name}/${f} vs ${AGENTS_TREE}/${name}/${f}\n`,
      );
    }
    for (const f of onlyClaude) {
      process.stderr.write(`  missing from ${AGENTS_TREE}/${name}: ${f}\n`);
      process.stderr.write(
        "    add it there, or exempt the skill with a reason\n",
      );
    }
    for (const f of onlyAgents) {
      process.stderr.write(`  missing from ${CLAUDE_TREE}/${name}: ${f}\n`);
      process.stderr.write(
        "    add it there, or exempt the skill with a reason\n",
      );
    }
  }

  // A skill in one tree is either declared single-tree or a DELETED mirror copy,
  // and those look identical from here — so an unlisted one fails rather than
  // reporting the largest possible drift as a SKIP line.
  for (const [name, present, missing] of [
    ...claudeSkills
      .filter((n) => !agentsSkills.includes(n))
      .map((n) => [n, CLAUDE_TREE, AGENTS_TREE]),
    ...agentsSkills
      .filter((n) => !claudeSkills.includes(n))
      .map((n) => [n, AGENTS_TREE, CLAUDE_TREE]),
  ]) {
    const reason = SINGLE_TREE.get(name);
    if (reason) {
      process.stdout.write(
        `skill-mirrors: SKIP ${name} (${present} only: ${reason})\n`,
      );
      continue;
    }
    failed = true;
    process.stderr.write(
      `skill-mirrors: FAIL ${name} — exists in ${present} but not ${missing}\n`,
    );
    process.stderr.write(
      `    restore ${missing}/${name}, or declare it in SINGLE_TREE with the reason it belongs to one tree\n`,
    );
  }

  for (const name of SINGLE_TREE.keys())
    if (!claudeSkills.includes(name) && !agentsSkills.includes(name))
      process.stdout.write(
        `skill-mirrors: NOTE ${name} is declared in SINGLE_TREE but absent\n`,
      );

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
