// Pins which rendered bodies load GitHub-hosted images through the user's
// GitHub CLI sign-in: every forge body site passes `hostedImages=`, every other
// `<Markdown` under src/features and src/components is excluded with a reason,
// and every Thread / ReviewThreadCard / ReviewThreadList site passes the
// `mentions=` source that Thread and the review cards derive the hosted source
// from. Sites are anchored on a code snippet in the element, never a line
// number. Stdlib only. Out of reach: JSX nested in an attribute expression of
// the opening tag (`footer={<X hostedImages={h} />}`) reads as passing the prop,
// as does a default parameter or an assignment inside an attribute's arrow
// (`({ mentions = m }) =>`, `() => (mentions = m)`).
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

/** Whether the opening tag at `masked[start, tagClose)` passes `name`: the
 *  attribute name not preceded by a name character, dot, colon or hyphen, so
 *  `data-hostedImages=` is not the prop, and its `=` not starting `==` or `=>`,
 *  so a comparison or an arrow is not either. */
function passesProp(masked, start, tagClose, name) {
  return new RegExp(`(?<![\\w$.:-])${name}\\s*=(?![=>])`).test(
    masked.slice(start, tagClose),
  );
}

/** Bodies a forge (GitHub included) authored, which load hosted images. */
const GETS = [
  { file: "src/features/issues/RemoteIssueView.tsx", snippet: "{issue.body}" },
  { file: "src/features/pulls/RemotePrView.tsx", snippet: "{pr.body}" },
  { file: "src/features/conversations/Thread.tsx", snippet: "{thread.body}" },
  { file: "src/features/pulls/ReviewThreads.tsx", snippet: "{seg.text}" },
  { file: "src/features/discussions/DiscussionView.tsx", snippet: "{d.body}" },
  { file: "src/features/tags/TagDetailView.tsx", snippet: "{rel.body}" },
  // The composer Preview: a draft's hosted URLs load when its editor site
  // passes a source (EDITOR_SITES below).
  { file: "src/components/markdown-editor.tsx", snippet: "stagedImages=" },
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
      const passes = passesProp(masked, start, tagClose, "hostedImages");
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
        if (!passesProp(masked, start, tagClose, "mentions"))
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

/** The editor elements whose Preview renders a draft, and the forwarders that
 *  carry `hostedImages` down to MarkdownEditor's Preview. */
const EDITOR_TAGS = [
  "MarkdownEditor",
  "field.MarkdownField",
  "CommentComposer",
  "CommentEditor",
  "EditTitleBodyDialog",
];

const FORWARDER = "a forwarder: carries its own prop down";
const OUTSIDE = "outside the attachment routes' scope; behaves as before";

/** Every editor site: whether its Preview loads hosted images, else why not. */
const EDITOR_SITES = [
  {
    file: "src/components/form/fields.tsx",
    tag: "MarkdownEditor",
    why: FORWARDER,
  },
  {
    file: "src/features/conversations/CommentComposer.tsx",
    tag: "MarkdownEditor",
    why: FORWARDER,
  },
  {
    file: "src/features/conversations/CommentEditor.tsx",
    tag: "MarkdownEditor",
    why: FORWARDER,
  },
  {
    file: "src/features/conversations/EditTitleBodyDialog.tsx",
    tag: "field.MarkdownField",
    why: FORWARDER,
  },
  { file: "src/features/issues/RemoteIssueView.tsx", tag: "CommentComposer" },
  {
    file: "src/features/issues/RemoteIssueView.tsx",
    tag: "EditTitleBodyDialog",
  },
  {
    file: "src/features/pulls/RemotePrView.tsx",
    tag: "CommentComposer",
    count: 2,
  },
  { file: "src/features/pulls/RemotePrView.tsx", tag: "EditTitleBodyDialog" },
  { file: "src/features/conversations/Thread.tsx", tag: "CommentEditor" },
  {
    file: "src/features/issues/CreateIssueDialog.tsx",
    tag: "field.MarkdownField",
  },
  { file: "src/features/pulls/CreatePrDialog.tsx", tag: "field.MarkdownField" },
  { file: "src/features/pulls/ReviewThreads.tsx", tag: "MarkdownEditor" },
  { file: "src/features/pulls/ReviewComposer.tsx", tag: "MarkdownEditor" },
  { file: "src/features/pulls/SubmitReviewDialog.tsx", tag: "MarkdownEditor" },
  {
    file: "src/features/issues/LocalIssueView.tsx",
    tag: "CommentComposer",
    without: "a local item",
  },
  {
    file: "src/features/issues/LocalIssueView.tsx",
    tag: "EditTitleBodyDialog",
    without: "a local item",
  },
  {
    file: "src/features/pulls/LocalPrView.tsx",
    tag: "CommentComposer",
    without: "a local item",
  },
  {
    file: "src/features/pulls/LocalPrView.tsx",
    tag: "EditTitleBodyDialog",
    without: "a local item",
  },
  {
    file: "src/features/conversations/LocalComment.tsx",
    tag: "CommentEditor",
    without: "a local item",
  },
  {
    file: "src/features/issues/CreateLocalIssueDialog.tsx",
    tag: "field.MarkdownField",
    without: "a local item",
  },
  {
    file: "src/features/pulls/CreateLocalPrDialog.tsx",
    tag: "field.MarkdownField",
    without: "a local item",
  },
  {
    file: "src/features/issues/JiraIssueView.tsx",
    tag: "CommentEditor",
    without: "Jira",
  },
  {
    file: "src/features/issues/JiraIssueView.tsx",
    tag: "CommentComposer",
    without: "Jira",
  },
  {
    file: "src/features/issues/CreateJiraIssueDialog.tsx",
    tag: "field.MarkdownField",
    without: "Jira",
  },
  {
    file: "src/features/pulls/PendingReviewBar.tsx",
    tag: "CommentEditor",
    without: "the app's local draft store",
  },
  {
    file: "src/features/pulls/ReviewerNotesField.tsx",
    tag: "field.MarkdownField",
    without: "the app's own note store",
  },
  {
    file: "src/features/pulls/CommitComments.tsx",
    tag: "CommentComposer",
    without: "its hook takes refs only",
  },
  {
    file: "src/features/pulls/CommitComments.tsx",
    tag: "MarkdownEditor",
    without: "its hook takes refs only",
  },
  {
    file: "src/features/projects/BoardAddDialogs.tsx",
    tag: "field.MarkdownField",
    without: OUTSIDE,
  },
  {
    file: "src/features/projects/BoardDraftEditDialog.tsx",
    tag: "field.MarkdownField",
    without: OUTSIDE,
  },
  {
    file: "src/features/projects/ProjectStatusStrip.tsx",
    tag: "field.MarkdownField",
    without: OUTSIDE,
  },
  {
    file: "src/features/discussions/CreateDiscussionDialog.tsx",
    tag: "field.MarkdownField",
    without: OUTSIDE,
  },
  {
    file: "src/features/discussions/DiscussionView.tsx",
    tag: "MarkdownEditor",
    without: OUTSIDE,
  },
  {
    file: "src/features/discussions/DiscussionView.tsx",
    tag: "CommentComposer",
    without: OUTSIDE,
  },
  {
    file: "src/features/tags/CreateReleaseDialog.tsx",
    tag: "MarkdownEditor",
    without: OUTSIDE,
  },
  {
    file: "src/features/tags/TagDetailView.tsx",
    tag: "MarkdownEditor",
    without: OUTSIDE,
  },
];

/** Every problem the editor sites show; empty when EDITOR_SITES holds. */
export function auditEditors(files) {
  if (files.size === 0) throw new ScanError("empty corpus");
  const problems = [];
  const entries = EDITOR_SITES.map((e) => ({
    ...e,
    count: e.count ?? 1,
    hits: 0,
  }));
  let sites = 0;
  for (const [rel, text] of files) {
    if (!rel.endsWith(".tsx")) continue;
    const masked = maskNonCode(text, true);
    for (const tag of EDITOR_TAGS) {
      for (const [start, end] of elementRanges(rel, text, masked, tag)) {
        sites++;
        const where = `${rel}:${lineOf(text, start)}`;
        const entry = entries.find((e) => e.file === rel && e.tag === tag);
        if (entry === undefined) {
          problems.push(
            `${where}: <${tag} is not in EDITOR_SITES (add it as gets or without)`,
          );
          continue;
        }
        entry.hits++;
        const [, tagClose] = openingTags(rel, text, masked, start, end)[0];
        const passes = passesProp(masked, start, tagClose, "hostedImages");
        if (entry.without === undefined && !passes)
          problems.push(`${where}: <${tag} without hostedImages=`);
        if (entry.without !== undefined && passes)
          problems.push(`${where}: a "without" <${tag} passes hostedImages=`);
      }
    }
  }
  if (sites === 0) throw new ScanError("no editor sites found");
  for (const e of entries)
    if (e.hits !== e.count)
      problems.push(
        `${e.file} <${e.tag}: ${e.hits} sites, roster says ${e.count} (stale entry?)`,
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

test("every editor site passes the hosted source or is listed without it", () => {
  assert.deepEqual(auditEditors(corpus()), []);
});

test("an editor site that drops hostedImages= fails", () => {
  const next = edited(
    corpus(),
    "src/features/issues/CreateIssueDialog.tsx",
    "hostedImages={descHostedImages}",
    "data-x={descHostedImages}",
  );
  assert.match(
    auditEditors(next).join("\n"),
    /CreateIssueDialog.*field\.MarkdownField without hostedImages=/,
  );
});

test("a data- attribute ending in the prop's name is not the prop", () => {
  const editor = edited(
    corpus(),
    "src/features/issues/CreateIssueDialog.tsx",
    "hostedImages={descHostedImages}",
    "data-hostedImages={descHostedImages}",
  );
  assert.match(
    auditEditors(editor).join("\n"),
    /CreateIssueDialog.*field\.MarkdownField without hostedImages=/,
  );
  const files = corpus();
  const file = "src/features/pulls/RemotePrView.tsx";
  const text = files.get(file);
  const prop = text.lastIndexOf("hostedImages=", text.indexOf("{pr.body}"));
  const body = new Map(files);
  body.set(file, `${text.slice(0, prop)}data-${text.slice(prop)}`);
  assert.match(audit(body).join("\n"), /RemotePrView.*without hostedImages=/);
  const hop = "src/features/issues/RemoteIssueView.tsx";
  const hopText = files.get(hop);
  const at = hopText.indexOf("mentions=", hopText.indexOf("<Thread"));
  const mentions = new Map(files);
  mentions.set(hop, `${hopText.slice(0, at)}data-${hopText.slice(at)}`);
  assert.match(
    audit(mentions).join("\n"),
    /RemoteIssueView.*Thread without mentions=/,
  );
});

test("a comparison or an arrow over the prop's name is not the prop", () => {
  for (const shape of [
    "data-x={hostedImages === descHostedImages}",
    "data-x={hostedImages => descHostedImages}",
  ]) {
    const editor = edited(
      corpus(),
      "src/features/issues/CreateIssueDialog.tsx",
      "hostedImages={descHostedImages}",
      shape,
    );
    assert.match(
      auditEditors(editor).join("\n"),
      /CreateIssueDialog.*field\.MarkdownField without hostedImages=/,
      shape,
    );
  }
});

test("the prop spelled with spaces around = still counts at an editor site, a body and a mentions hop", () => {
  const files = corpus();
  const editor = edited(
    files,
    "src/features/issues/CreateIssueDialog.tsx",
    "hostedImages={descHostedImages}",
    "hostedImages = {descHostedImages}",
  );
  assert.deepEqual(auditEditors(editor), auditEditors(files));
  const file = "src/features/pulls/RemotePrView.tsx";
  const text = files.get(file);
  const prop = text.lastIndexOf("hostedImages=", text.indexOf("{pr.body}"));
  const body = new Map(files);
  body.set(
    file,
    `${text.slice(0, prop)}hostedImages = ${text.slice(prop + "hostedImages=".length)}`,
  );
  assert.deepEqual(audit(body), audit(files));
  const hop = "src/features/issues/RemoteIssueView.tsx";
  const hopText = files.get(hop);
  const at = hopText.indexOf("mentions=", hopText.indexOf("<Thread"));
  const mentions = new Map(files);
  mentions.set(
    hop,
    `${hopText.slice(0, at)}mentions = ${hopText.slice(at + "mentions=".length)}`,
  );
  assert.deepEqual(audit(mentions), audit(files));
});

test("a new editor element fails until EDITOR_SITES names it", () => {
  const next = new Map(corpus());
  next.set(
    "src/features/new/NewEditor.tsx",
    "export const E = (p) => <CommentEditor {...p} />;\n",
  );
  assert.match(
    auditEditors(next).join("\n"),
    /NewEditor.*CommentEditor is not in EDITOR_SITES/,
  );
});

test("a 'without' editor site that starts passing hostedImages= fails", () => {
  const files = corpus();
  const file = "src/features/issues/LocalIssueView.tsx";
  const text = files.get(file);
  const at = text.indexOf("<EditTitleBodyDialog");
  const next = new Map(files);
  next.set(
    file,
    `${text.slice(0, at)}<EditTitleBodyDialog hostedImages={h}${text.slice(at + "<EditTitleBodyDialog".length)}`,
  );
  assert.match(
    auditEditors(next).join("\n"),
    /LocalIssueView.*"without" <EditTitleBodyDialog passes hostedImages=/,
  );
});

test("a stale editor entry fails", () => {
  const next = new Map(corpus());
  next.delete("src/features/pulls/SubmitReviewDialog.tsx");
  assert.match(auditEditors(next).join("\n"), /SubmitReviewDialog.*0 sites/);
});

test("an empty corpus, a file with no sites, or an unreadable file fails closed", () => {
  assert.throws(() => auditEditors(new Map()), ScanError);
  assert.throws(
    () =>
      auditEditors(new Map([["src/features/a.tsx", "export const a = 1;\n"]])),
    ScanError,
  );
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
