// Pins which src/ files name a forge provider through `providerLabel(` or a
// hand-rolled `"GitLab" : "GitHub"` ternary, and that the ones whose copy can
// render while the forge probe is pending go through the pending-aware helpers
// in src/lib/git/types/forge.ts instead:
// - ROSTER: every matching file is classified exactly once, WIRED (pending-
//   capable, adopts `shownProviderLabel`) or REVIEWED (settled-only, typed or
//   guarded, with the reason). An unclassified hit, a REVIEWED entry whose file
//   no longer matches, an entry whose file is missing, and a walk that matches
//   nothing all fail; a WIRED entry stays live through its anchors.
// - WIRED anchors: no `providerLabel(` call, at least one `shownProviderLabel(`;
//   the five views read the saved provider; RemotePrView hands the banner the
//   shown provider on the `<PrMergeabilityBanner` element itself.
//
// Comments are masked before matching; string and template-literal content is
// never masked (the banner's calls sit inside `${…}`). Shapes this roster
// CANNOT read, classified by review instead: pass-by-name adoption
// (`.map(providerLabel)`), an aliased import (`providerLabel as label`), and a
// label built in another module and passed in as a string. A single-quoted or
// double-quoted string is read only when it closes on its own line (JSX text
// apostrophes are not strings), so a line holding unbalanced quotes may show a
// trailing comment to the matcher.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");

const SETTLED_ONLY = "settled-only: every render path needs a settled probe";
const TYPED = "typed or guarded caller outside the pending fence";

/** Pending-capable sites: copy names the shown provider. */
const WIRED = [
  "src/features/pulls/PullRequestsPanel.tsx",
  "src/features/pulls/RemotePrView.tsx",
  "src/features/pulls/PrMergeabilityBanner.tsx",
  "src/features/issues/IssuesPanel.tsx",
  "src/features/issues/RemoteIssueView.tsx",
  "src/features/actions/RunDetailView.tsx",
];

/** The views (not the banner, which takes the shown provider as a prop). */
const READS_SAVED = WIRED.filter(
  (f) => !f.endsWith("PrMergeabilityBanner.tsx"),
);

const REVIEWED = {
  "src/features/pulls/CreatePrDialog.tsx": `${SETTLED_ONLY} (every opener gates on forgeFeatureReady mrCreate)`,
  "src/features/pulls/PromoteLocalPrDialog.tsx": `${SETTLED_ONLY} (only host LocalPrView, opened from its mrCreate-gated button)`,
  "src/features/pulls/LocalPrView.tsx": `${SETTLED_ONLY} (renders inside forgeFeatureReady mrCreate)`,
  "src/features/history/CommitDetailView.tsx": `${SETTLED_ONLY} (useCommitCommentsGate needs forgeReady)`,
  "src/features/tags/TagDetailView.tsx": `${SETTLED_ONLY} (release block keyed off ghReady)`,
  "src/features/actions/RunContextMenu.tsx": `${SETTLED_ONLY} (ActionsPanel rows render past the pending skeleton and ForgeNotReady)`,
  "src/features/mywork/MyWorkScreen.tsx":
    "every provider is a non-null ForgeProvider; a null LegError takes the length-1 branches",
  "src/features/plan/PlanView.tsx": `${SETTLED_ONLY} (inside ghReady = forgeFeatureReady issueCreate)`,
  "src/features/issues/CreateIssueDialog.tsx": `${SETTLED_ONLY} (IssuesPanel openers gate on issueCreate; the sub-issue opener never reads the label)`,
  "src/features/issues/PromoteLocalIssueDialog.tsx": `${SETTLED_ONLY} (every use needs canPublishForge = issueCreate)`,
  "src/features/issues/LocalIssueView.tsx": `${SETTLED_ONLY}, outside the fence (forge arm needs canPublishForge)`,
  "src/features/tags/CreateReleaseDialog.tsx": `${SETTLED_ONLY} (TagsPanel item and request effect gate on releaseCreate, TagDetailView's button on ghReady, the palette on releaseCreate; a repo switch closes it via useFinishAndSurface, and its View reopen needs the same repo)`,
  "src/features/repository/RepositoryMenu.tsx":
    "no pending window: its labels render under settled gates, viewLabel reads the saved provider",
  "src/features/repository/RepoList.tsx":
    "no pending window: providers persist with the owner that gates the item",
  "src/features/accounts/SessionExpiryNotice.tsx": TYPED,
  "src/features/accounts/ReconnectDialog.tsx": TYPED,
  "src/components/markdown/markdown-link-card.tsx": TYPED,
  "src/features/explore/ExploreDetail.tsx": TYPED,
  "src/features/repo-settings/DangerZone.tsx": TYPED,
  "src/features/repository/insights/ForkActivityCard.tsx": TYPED,
  "src/features/repository/ForgeNotReady.tsx": TYPED,
  "src/features/projects/ProjectsBoardPanel.tsx": TYPED,
  "src/features/security-findings/FindingsPanel.tsx": TYPED,
  "src/features/repo-settings/RepoSettingsDialog.tsx": TYPED,
};

const EXCLUDED = new Set(["src/lib/git/types/forge.ts"]);

const CALL = /(?<![A-Za-z])providerLabel\(/;
const TERNARY = /"GitLab"\s*:\s*"GitHub"/;
const SHOWN_CALL = /shownProviderLabel\(/;

const REGEX_PRECEDERS = new Set([
  "(",
  ",",
  "=",
  ":",
  "[",
  "!",
  "&",
  "|",
  "?",
  "{",
  "}",
  ";",
]);

/** Blanks comments (keeping newlines), leaving strings and templates whole. */
export function maskComments(src) {
  const out = src.split("");
  const n = src.length;
  // Each template level records the code-brace depth its `${` opened at.
  const templates = [];
  let braces = 0;
  let inTemplate = false;
  let lastSignificant = "";
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (inTemplate) {
      if (c === "\\") {
        i += 2;
      } else if (c === "`") {
        inTemplate = false;
        lastSignificant = "`";
        i++;
      } else if (c === "$" && src[i + 1] === "{") {
        templates.push(braces);
        braces++;
        inTemplate = false;
        lastSignificant = "{";
        i += 2;
      } else {
        i++;
      }
      continue;
    }
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      blank(i, stop);
      i = stop;
    } else if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== "\n")
        j += src[j] === "\\" ? 2 : 1;
      if (j < n && src[j] === c) {
        i = j + 1;
        lastSignificant = c;
      } else {
        i++;
      }
    } else if (c === "`") {
      inTemplate = true;
      i++;
    } else if (
      c === "/" &&
      (lastSignificant === "" || REGEX_PRECEDERS.has(lastSignificant))
    ) {
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== "\n") {
        if (src[j] === "\\") j += 2;
        else {
          if (src[j] === "[") inClass = true;
          else if (src[j] === "]") inClass = false;
          else if (src[j] === "/" && !inClass) break;
          j++;
        }
      }
      if (j < n && src[j] === "/") {
        i = j + 1;
        lastSignificant = "/";
      } else {
        lastSignificant = "/";
        i++;
      }
    } else {
      if (c === "{") braces++;
      else if (c === "}") {
        braces--;
        if (
          templates.length > 0 &&
          templates[templates.length - 1] === braces
        ) {
          templates.pop();
          inTemplate = true;
        }
      }
      if (!/\s/.test(c)) lastSignificant = c;
      i++;
    }
  }
  return out.join("");
}

/** Whether masked source names a provider the roster tracks. */
export function namesProvider(masked) {
  return CALL.test(masked) || TERNARY.test(masked);
}

/** The anchor failures for one WIRED file's masked source. */
export function wiredFailures(file, masked) {
  const failures = [];
  if (CALL.test(masked)) failures.push(`${file}: calls providerLabel(`);
  if (TERNARY.test(masked))
    failures.push(`${file}: hand-rolls "GitLab" : "GitHub"`);
  if (!SHOWN_CALL.test(masked))
    failures.push(`${file}: no shownProviderLabel( call`);
  const flat = masked.replace(/\s+/g, "");
  if (
    READS_SAVED.includes(file) &&
    !flat.includes("savedProvider(settings.data?.recentRepos,repoPath)")
  ) {
    failures.push(
      `${file}: doesn't read savedProvider(settings.data?.recentRepos, repoPath)`,
    );
  }
  if (file.endsWith("RemotePrView.tsx")) {
    const start = masked.indexOf("<PrMergeabilityBanner");
    const end = start === -1 ? -1 : masked.indexOf("/>", start);
    if (start === -1 || end === -1)
      failures.push(`${file}: no <PrMergeabilityBanner element`);
    else if (!/\bprovider=\{shown\}/.test(masked.slice(start, end))) {
      failures.push(
        `${file}: <PrMergeabilityBanner doesn't pass provider={shown}`,
      );
    }
  }
  return failures;
}

function walk(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
  }
  return files;
}

function repoRel(full) {
  return relative(ROOT, full).split(sep).join("/");
}

function readMasked(rel) {
  return maskComments(readFileSync(join(ROOT, rel), "utf8"));
}

test("the roster classifies every src file that names a provider", () => {
  const hits = walk(SRC)
    .map(repoRel)
    .filter((rel) => !rel.startsWith("src/test/") && !EXCLUDED.has(rel))
    .filter((rel) => namesProvider(readMasked(rel)));
  assert.ok(
    hits.length > 0,
    "the walk matched no file: the scan can't read src/",
  );
  const classified = new Set([...WIRED, ...Object.keys(REVIEWED)]);
  for (const f of WIRED)
    assert.ok(!(f in REVIEWED), `${f} is both WIRED and REVIEWED`);
  const unclassified = hits.filter((rel) => !classified.has(rel));
  assert.deepEqual(unclassified, [], "unclassified provider-label sites");
  for (const f of classified) {
    assert.ok(existsSync(join(ROOT, f)), `roster entry ${f} is missing`);
  }
  // A WIRED file names no provider through these shapes once wired; its anchors
  // (the next test) are what keep the entry live.
  const stale = Object.keys(REVIEWED).filter((f) => !hits.includes(f));
  assert.deepEqual(
    stale,
    [],
    "REVIEWED entries that no longer name a provider",
  );
  for (const [f, reason] of Object.entries(REVIEWED)) {
    assert.ok(reason.trim().length > 0, `${f} has no reason`);
  }
});

test("WIRED sites name the shown provider", () => {
  const failures = WIRED.flatMap((f) => wiredFailures(f, readMasked(f)));
  assert.deepEqual(failures, []);
});

test("mutation controls: an unwired site fails the anchors", () => {
  for (const f of WIRED) {
    const src = readFileSync(join(ROOT, f), "utf8");
    const reverted = src.replaceAll("shownProviderLabel(", "providerLabel(");
    assert.notDeepEqual(
      wiredFailures(f, maskComments(reverted)),
      [],
      `${f}: revert not caught`,
    );
  }
  const pr = "src/features/pulls/RemotePrView.tsx";
  const raw = readFileSync(join(ROOT, pr), "utf8").replace(
    "provider={shown}",
    "provider={provider}",
  );
  assert.ok(
    wiredFailures(pr, maskComments(raw)).some((m) =>
      m.includes("provider={shown}"),
    ),
    "banner prop revert not caught",
  );
  for (const f of READS_SAVED) {
    const src = readFileSync(join(ROOT, f), "utf8").replaceAll(
      "savedProvider(",
      "savedProviderX(",
    );
    assert.ok(
      wiredFailures(f, maskComments(src)).some((m) =>
        m.includes("savedProvider"),
      ),
      `${f}: saved-provider revert not caught`,
    );
  }
});

test("fixtures: what the matcher reads and skips", () => {
  const unrolled = `const label = provider === "gitlab" ? "GitLab" : "GitHub";\n`;
  assert.ok(namesProvider(maskComments(unrolled)));
  const wrapped = `const label = isGitLab\n  ? "GitLab"\n  : "GitHub";\n`;
  assert.ok(namesProvider(maskComments(wrapped)));
  // Same-name locals and JSX reads are not calls.
  assert.ok(
    !namesProvider(
      maskComments("  const providerLabel = reviewAi\n    ? x : y;\n"),
    ),
  );
  assert.ok(
    !namesProvider(maskComments("<span>{providerLabel} | {model}</span>\n")),
  );
  assert.ok(!namesProvider(maskComments("const a = shownProviderLabel(p);\n")));
  // Comments are masked; strings and template substitutions are not.
  assert.ok(
    !namesProvider(
      maskComments("// see providerLabel(x)\n/* providerLabel(y) */\n"),
    ),
  );
  assert.ok(!namesProvider(maskComments('{/* "GitLab" : "GitHub" */}\n')));
  assert.ok(
    namesProvider(maskComments("const s = `Reach ${providerLabel(p)} now`;\n")),
  );
  assert.ok(
    namesProvider(
      maskComments("const s = `a ${`b ${providerLabel(p)}`} c`;\n"),
    ),
  );
  assert.ok(
    namesProvider(maskComments('const u = "https://x"; providerLabel(p);\n')),
  );
  // A JSX apostrophe doesn't swallow the rest of the file.
  assert.ok(
    namesProvider(maskComments("<p>Couldn't load</p>;\nproviderLabel(p);\n")),
  );
  // A regex literal holding slashes and quotes doesn't read as a comment.
  assert.ok(
    namesProvider(
      maskComments("const r = /https?:\\/\\//; providerLabel(p);\n"),
    ),
  );
  // A WIRED file keeping a raw call fails its anchors.
  const fixture = "src/features/pulls/PrMergeabilityBanner.tsx";
  assert.notDeepEqual(wiredFailures(fixture, maskComments(unrolled)), []);
});
