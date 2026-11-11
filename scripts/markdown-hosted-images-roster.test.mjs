// Pins which rendered bodies load GitHub-hosted images through the user's
// GitHub CLI sign-in: every forge body site passes `hostedImages=`, every other
// `<Markdown` under src/features and src/components is excluded with a reason,
// and every Thread / ReviewThreadCard / ReviewThreadList site passes the
// `mentions=` source that Thread and the review cards derive the hosted source
// from. Sites are anchored on a code snippet in the element, never a line
// number. Stdlib only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  elementRanges,
  lineOf,
  loadCorpus,
  maskNonCode,
  openingTags,
  ScanError,
  srcEntries,
} from "./lib/ts-mask.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Bodies a forge (GitHub included) authored, which load hosted images. */
const GETS = [
  { file: "src/features/issues/RemoteIssueView.tsx", snippet: "{issue.body}" },
  { file: "src/features/pulls/RemotePrView.tsx", snippet: "{pr.body}" },
  { file: "src/features/conversations/Thread.tsx", snippet: "{thread.body}" },
  { file: "src/features/pulls/ReviewThreads.tsx", snippet: "{seg.text}" },
  { file: "src/features/discussions/DiscussionView.tsx", snippet: "{d.body}" },
  { file: "src/features/tags/TagDetailView.tsx", snippet: "{rel.body}" },
];

/** Every other body, with why it doesn't load hosted images. */
const EXCLUDED = [
  {
    file: "src/features/pulls/CommitComments.tsx",
    snippet: "{c.body}",
    reason:
      "inline diff anchor; its hook takes refs only (its Thread rows are covered)",
  },
  {
    file: "src/features/pulls/PendingReviewBar.tsx",
    snippet: "{draft.body}",
    reason: "the app's local draft store, not a forge body",
  },
  {
    file: "src/features/pulls/PrReviewPanel.tsx",
    snippet: "{text}",
    count: 2,
    reason: "AI review output",
  },
  {
    file: "src/features/pulls/PrReviewPanel.tsx",
    snippet: "{reviewText(keptPartial)}",
    reason: "AI review output",
  },
  {
    file: "src/features/pulls/ReviewHistory.tsx",
    snippet: "{reviewText(r)}",
    reason: "AI review output",
  },
  {
    file: "src/features/pulls/ThoughtsDisclosure.tsx",
    snippet: "{thoughts}",
    reason: "AI output",
  },
  {
    file: "src/features/issues/LocalIssueView.tsx",
    snippet: "{issue.body}",
    reason: "a local item",
  },
  {
    file: "src/features/pulls/LocalPrView.tsx",
    snippet: "{pr.body}",
    reason: "a local item",
  },
  {
    file: "src/features/conversations/LocalComment.tsx",
    snippet: "{comment.body}",
    reason: "a local item",
  },
  {
    file: "src/features/issues/JiraIssueView.tsx",
    snippet: "{comment.bodyMd}",
    reason: "Jira",
  },
  {
    file: "src/features/issues/JiraIssueView.tsx",
    snippet: "{worklog.commentMd}",
    reason: "Jira",
  },
  {
    file: "src/features/issues/JiraIssueView.tsx",
    snippet: "{issue.descriptionMd}",
    reason: "Jira",
  },
  {
    file: "src/features/security-findings/FindingDetailView.tsx",
    snippet: "{alert.description}",
    reason: "security advisory",
  },
  {
    file: "src/features/security-findings/FindingDetailView.tsx",
    snippet: "{advisory.description}",
    reason: "security advisory",
  },
  {
    file: "src/features/security-findings/FindingDetailView.tsx",
    snippet: "{finding.description}",
    count: 2,
    reason: "security finding",
  },
  {
    file: "src/features/projects/BoardCard.tsx",
    snippet: "{body}",
    reason: "Projects item: its repo isn't the open repo's pin",
  },
  {
    file: "src/features/projects/TableCell.tsx",
    snippet: "{body}",
    reason: "Projects item: its repo isn't the open repo's pin",
  },
  {
    file: "src/features/projects/ProjectStatusStrip.tsx",
    snippet: "{body}",
    reason: "Projects status update: no repo behind it",
  },
  {
    file: "src/features/explore/ExploreDetail.tsx",
    snippet: "{content}",
    reason: "another repo's README",
  },
  {
    file: "src/components/markdown-editor.tsx",
    snippet: "stagedImages=",
    reason: "the composer Preview: the user's own draft",
  },
  {
    file: "src/features/diff/MarkdownPreview.tsx",
    snippet: "repoImages=",
    reason: "a repository document (repoImages arm)",
  },
  {
    file: "src/features/help/HelpScreen.tsx",
    snippet: "{body}",
    reason: "app text",
  },
  {
    file: "src/features/updates/WhatsNew.tsx",
    snippet: "{notes}",
    reason: "app text",
  },
  {
    file: "src/features/actions/DebugJobDialog.tsx",
    snippet: "{text}",
    reason: "AI output",
  },
  {
    file: "src/features/automations/AutomationResultDialog.tsx",
    snippet: "{shownResult.text}",
    reason: "AI output",
  },
  {
    file: "src/features/research/ResearchView.tsx",
    snippet: "{turn.text}",
    reason: "AI output",
  },
  {
    file: "src/features/research/ResearchView.tsx",
    snippet: "{text}",
    reason: "AI output",
  },
  {
    file: "src/features/sessions/AgentTranscript.tsx",
    snippet: "{seg.text}",
    reason: "agent output",
  },
  {
    file: "src/features/sessions/AgentNarration.tsx",
    snippet: "{text}",
    reason: "agent output",
  },
];

/** The comment-row components whose bodies take the hosted source from
 *  `mentions`. */
const MENTION_HOPS = ["Thread", "ReviewThreadCard", "ReviewThreadList"];

const scanned = (rel) =>
  /^src\/(features|components)\//.test(rel) && !rel.startsWith("src/test/");

const squash = (s) => s.replace(/\s+/g, " ");

/** Every problem the corpus shows; empty when the roster holds. */
export function audit(files) {
  if (files.size === 0) throw new ScanError("empty corpus");
  const problems = [];
  const entries = [
    ...GETS.map((e) => ({ ...e, gets: true, count: 1, hits: 0 })),
    ...EXCLUDED.map((e) => ({
      ...e,
      gets: false,
      count: e.count ?? 1,
      hits: 0,
    })),
  ];
  let sites = 0;
  for (const [rel, text] of files) {
    const jsx = rel.endsWith(".tsx");
    const masked = maskNonCode(text, jsx);
    if (!jsx) {
      if (/<Markdown(?![\w.$-])/.test(masked))
        problems.push(`${rel}: <Markdown in a .ts file`);
      continue;
    }
    for (const [start, end] of elementRanges(rel, text, masked, "Markdown")) {
      sites++;
      const where = `${rel}:${lineOf(text, start)}`;
      const element = squash(text.slice(start, end));
      const matched = entries.filter(
        (e) => e.file === rel && element.includes(e.snippet),
      );
      if (matched.length !== 1) {
        problems.push(
          `${where}: <Markdown matches ${matched.length} roster entries (add it to GETS or EXCLUDED)`,
        );
        continue;
      }
      const [entry] = matched;
      entry.hits++;
      const [, tagClose] = openingTags(rel, text, masked, start, end)[0];
      const passes = masked.slice(start, tagClose).includes("hostedImages=");
      if (entry.gets && !passes)
        problems.push(`${where}: a forge body without hostedImages=`);
      if (!entry.gets && passes)
        problems.push(`${where}: an excluded body passes hostedImages=`);
    }
    for (const name of MENTION_HOPS) {
      for (const [start] of elementRanges(rel, text, masked, name)) {
        const [, tagClose] = openingTags(
          rel,
          text,
          masked,
          start,
          start + 1e6,
        )[0];
        if (!masked.slice(start, tagClose).includes("mentions="))
          problems.push(
            `${rel}:${lineOf(text, start)}: <${name} without mentions=`,
          );
      }
    }
  }
  if (sites === 0) throw new ScanError("no <Markdown sites found");
  for (const e of entries)
    if (e.hits !== e.count)
      problems.push(
        `${e.file} "${e.snippet}": ${e.hits} sites, roster says ${e.count} (stale entry?)`,
      );
  return problems;
}

const corpus = () => loadCorpus(srcEntries(ROOT, scanned));

test("every forge body loads hosted images and every other body is excluded", () => {
  assert.deepEqual(audit(corpus()), []);
});

/** One in-memory edit of a corpus file; the anchor must occur exactly once. */
function edited(files, file, from, to) {
  const text = files.get(file);
  assert.equal(text.split(from).length, 2, `${file}: ${from}`);
  const next = new Map(files);
  next.set(
    file,
    text.replace(from, () => to),
  );
  return next;
}

test("a forge body that drops hostedImages= fails", () => {
  const files = corpus();
  const text = files.get("src/features/pulls/RemotePrView.tsx");
  const site = text.indexOf("{pr.body}");
  const prop = text.lastIndexOf("hostedImages=", site);
  const next = new Map(files);
  next.set(
    "src/features/pulls/RemotePrView.tsx",
    `${text.slice(0, prop)}data-x=${text.slice(prop + "hostedImages=".length)}`,
  );
  assert.equal(audit(next).length, 1);
  assert.match(audit(next)[0], /RemotePrView.*without hostedImages=/);
});

test("a new <Markdown site fails until the roster names it", () => {
  const files = corpus();
  const next = new Map(files);
  next.set(
    "src/features/new/NewView.tsx",
    "export const V = ({ b }) => <Markdown>{b}</Markdown>;\n",
  );
  assert.match(audit(next).join("\n"), /NewView.*matches 0 roster entries/);
});

test("a stale roster entry fails", () => {
  const files = corpus();
  const next = new Map(files);
  next.delete("src/features/updates/WhatsNew.tsx");
  assert.match(audit(next).join("\n"), /WhatsNew.*0 sites/);
});

test("each mentions hop that drops mentions= fails", () => {
  const files = corpus();
  const hops = [
    ["src/features/issues/RemoteIssueView.tsx", "<Thread"],
    ["src/features/pulls/PrActivityFeed.tsx", "<ReviewThreadList"],
    ["src/features/pulls/RemotePrViewParts.tsx", "<ReviewThreadCard"],
    ["src/features/pulls/ReviewThreads.tsx", "<ReviewThreadList"],
  ];
  for (const [file, open] of hops) {
    const text = files.get(file);
    const start = text.indexOf(open);
    const prop = text.indexOf("mentions=", start);
    const next = new Map(files);
    next.set(
      file,
      `${text.slice(0, prop)}data-x=${text.slice(prop + "mentions=".length)}`,
    );
    assert.match(
      audit(next).join("\n"),
      new RegExp(
        `${file.split("/").pop()}.*${open.slice(1)} without mentions=`,
      ),
      file,
    );
  }
  // Every hop in the tree passes the source today.
  assert.equal(audit(files).length, 0);
});

test("an excluded body that starts passing hostedImages= fails", () => {
  const next = edited(
    corpus(),
    "src/features/help/HelpScreen.tsx",
    "<Markdown>{body}</Markdown>",
    "<Markdown hostedImages={h}>{body}</Markdown>",
  );
  assert.match(audit(next).join("\n"), /HelpScreen.*excluded body passes/);
});

test("an empty corpus, a file with no sites, or an unreadable file fails closed", () => {
  assert.throws(() => audit(new Map()), ScanError);
  assert.throws(
    () => audit(new Map([["src/features/a.tsx", "export const a = 1;\n"]])),
    ScanError,
  );
  assert.throws(
    () => loadCorpus([["src/features/a.tsx", `x${String.fromCharCode(0)}`]]),
    ScanError,
  );
});
