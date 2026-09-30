import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { issueDetailsOptions, useIssueList } from "@/lib/git/queries";
import type { RemoteLens } from "@/lib/git/types";
import { extractIssueNumbers } from "@/lib/issues/extract";
import { jiraIssueView } from "@/lib/jira/api";
import { extractJiraKeys } from "@/lib/jira/keys";
import { useJiraIssues } from "@/lib/jira/queries";
import type { JiraLink } from "@/lib/jira/store";
import type { JiraMentionChip, LinkedIssueChip } from "./LinkedIssuesField";
import {
  addExtractedIssue,
  backfillFromOpenPage,
  bucketFor,
  dismissIssue,
  EMPTY_LINKED_ISSUE_BUCKET,
  fillIssueMeta,
  INITIAL_LINKED_ISSUE_BUCKETS,
  type LinkedIssueBucket,
  type LinkedIssueBuckets,
  type LinkedIssueTargetSig,
  linkedIssueTargetKey,
  pickIssue,
  routeBucketUpdate,
  seedBuckets,
  toggleIssueKeyword,
  upsertAiIssues,
} from "./linked-issue-selection";

/** A validated real issue the model may link (grounded candidate for the AI
 *  generate). Structurally matches `useGeneratePrDescription`'s IssueCandidate. */
export interface IssueCandidate {
  number: number;
  title: string;
  state: string;
}

/** One ref peeled from a body's trailing block or seeded manually: the issue
 *  number plus the keyword to preserve (a pre-existing `Closes` stays closes). */
export interface BodyRef {
  number: number;
  keyword: "closes" | "relates";
}

// A trailing-block line: `Closes #N` or `Relates to #N` (case-insensitive),
// optional surrounding whitespace. The block is the run of these lines at the
// very end of the body (blank lines between/after are consumed).
const REF_LINE = /^(closes|relates to)\s+#(\d+)\s*$/i;
// A trailing Jira mention line: `Relates to KEY-123` (case-insensitive). Only
// `Relates to` is recognized — `Closes KEY` is deliberately NOT a form (Jira
// tickets are never closed from PR text, so we neither peel nor compose it).
const JIRA_REF_LINE = /^relates to\s+([A-Z][A-Z0-9_]*-\d+)\s*$/i;

/**
 * Peel the EXACT trailing ref block off a PR body for the ACTIVE tracker `kind`.
 * The block is the run of final lines each matching either the numeric form
 * (`Closes #N` / `Relates to #N`) or the Jira mention form (`Relates to KEY-123`);
 * blank lines between/after are consumed. The whole block is walked, but only
 * ACTIVE-kind lines are EXTRACTED into chips — INACTIVE-kind lines are RE-APPENDED
 * to `text` in canonical form and original relative order, so an unedited save
 * loses no line of either kind. Prose refs elsewhere in the body are untouched.
 *
 * Contract: exactly ONE of `refs` / `jiraRefs` is populated (the active kind); the
 * other is always `[]`. Native: a repeated number keeps the LAST line's keyword.
 * Jira: first occurrence wins.
 *
 *   native: "x\n\nCloses #6\nRelates to JIRA-4"
 *             → { text: "x\n\nRelates to JIRA-4", refs: [C#6] }
 *   jira:   same input → { text: "x\n\nCloses #6", jiraRefs: [JIRA-4] }
 */
export function splitBodyRefBlock(
  body: string,
  kind: "native" | "jira",
): {
  text: string;
  refs: BodyRef[];
  jiraRefs: string[];
} {
  const lines = body.split("\n");
  // Walk up from the end, collecting block lines (either kind); blank lines
  // inside/after the block are consumed but not treated as refs. Stop at the
  // first non-blank, non-ref line — that's the end of the description text. The
  // two forms never overlap (the numeric form requires `#\d+`).
  let cut = lines.length; // index where the block (incl. its leading blanks) starts
  // Each block line captured bottom-to-top, tagged by kind so the inactive ones
  // can be re-appended in original (top-to-bottom) order.
  type BlockLine =
    | { kind: "native"; ref: BodyRef }
    | { kind: "jira"; key: string };
  const block: BlockLine[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.trim() === "") {
      // A trailing/inside blank before any ref is consumed. Keep scanning; `cut`
      // only advances past a ref line.
      cut = i;
      continue;
    }
    const m = REF_LINE.exec(line);
    if (m) {
      block.push({
        kind: "native",
        ref: {
          number: Number.parseInt(m[2], 10),
          keyword: m[1].toLowerCase() === "closes" ? "closes" : "relates",
        },
      });
      cut = i;
      continue;
    }
    const jm = JIRA_REF_LINE.exec(line);
    if (!jm) break;
    block.push({ kind: "jira", key: jm[1].toUpperCase() });
    cut = i;
  }
  // No block at all → whole body is text; leave it as-is.
  if (block.length === 0) {
    return { text: body.trimEnd(), refs: [], jiraRefs: [] };
  }
  // `block` is bottom-to-top; reverse to original order.
  block.reverse();

  // Extract the ACTIVE kind; collect INACTIVE lines to re-append (canonical
  // form, so no stray CRLF/whitespace from the raw source rides along).
  const refs: BodyRef[] = [];
  const jiraRefs: string[] = [];
  const inactiveLines: string[] = [];
  if (kind === "native") {
    // Dedupe by number, keeping the LAST line's keyword (later entry wins).
    const byNumber = new Map<number, "closes" | "relates">();
    for (const b of block)
      if (b.kind === "native") byNumber.set(b.ref.number, b.ref.keyword);
    const emitted = new Set<number>();
    for (const b of block) {
      if (b.kind === "native") {
        if (emitted.has(b.ref.number)) continue;
        emitted.add(b.ref.number);
        const keyword = byNumber.get(b.ref.number);
        if (keyword) refs.push({ number: b.ref.number, keyword });
      } else {
        inactiveLines.push(`Relates to ${b.key}`);
      }
    }
  } else {
    // Jira active: extract mention keys (first occurrence wins — no keyword to
    // carry). Inactive numeric lines re-appended in canonical form.
    const emittedJira = new Set<string>();
    for (const b of block) {
      if (b.kind === "jira") {
        if (emittedJira.has(b.key)) continue;
        emittedJira.add(b.key);
        jiraRefs.push(b.key);
      } else {
        inactiveLines.push(
          b.ref.keyword === "closes"
            ? `Closes #${b.ref.number}`
            : `Relates to #${b.ref.number}`,
        );
      }
    }
  }

  // Prose above the block, then any inactive-kind lines re-appended below it
  // (separated by one blank line when prose remains). `filter(Boolean)` collapses
  // an empty prose half so a block-only body doesn't gain a leading blank line.
  const prose = lines.slice(0, cut).join("\n").trimEnd();
  const text =
    inactiveLines.length > 0
      ? [prose, inactiveLines.join("\n")].filter(Boolean).join("\n\n")
      : prose;
  return { text, refs, jiraRefs };
}

/**
 * Compose the final body: text + the chips' ref lines (`Closes #N` /
 * `Relates to #N`, chip order), joined by a blank line; either part absent degrades
 * cleanly (text alone / lines alone / ""). The single composition used by ALL
 * create/edit save paths.
 */
export function composeBodyWithRefs(
  text: string,
  chips: LinkedIssueChip[],
): string {
  const refLines = chips.map((c) =>
    c.keyword === "closes" ? `Closes #${c.number}` : `Relates to #${c.number}`,
  );
  if (refLines.length === 0) return text;
  return [text.trimEnd(), refLines.join("\n")].filter(Boolean).join("\n\n");
}

/**
 * The Jira-mention twin of {@link composeBodyWithRefs}: text + the chips'
 * `Relates to KEY` lines, same degrade-cleanly joining. Only `Relates to` is
 * emitted — there is no close form for Jira.
 */
export function composeBodyWithJiraRefs(
  text: string,
  chips: JiraMentionChip[],
): string {
  const refLines = chips.map((c) => `Relates to ${c.key}`);
  if (refLines.length === 0) return text;
  return [text.trimEnd(), refLines.join("\n")].filter(Boolean).join("\n\n");
}

/** Lowercased tokens (length ≥ 4, split on non-alphanumerics) for ranking issue
 *  titles against the branch + commit subjects by shared-token overlap. Shared by
 *  the native and Jira candidate rankers. */
function rankTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 4),
  );
}

/** Count shared ≥4-char tokens between a title/summary and the rank text (the
 *  branch + commit subjects). Shared scoring for both hooks' candidate ranking. */
function sharedTokenScore(title: string, rankText: Set<string>): number {
  let score = 0;
  for (const t of rankTokens(title)) if (rankText.has(t)) score++;
  return score;
}

/** Tie-break comparator: newest `updatedAt` first, as a proper three-way that
 *  returns 0 for equal timestamps (a comparator that never returns 0 violates the
 *  sort contract). ISO-8601 strings compare correctly as plain strings — no
 *  locale-sensitive `localeCompare`. */
function byUpdatedAtDesc(a: string, b: string): number {
  if (a > b) return -1;
  if (a < b) return 1;
  return 0;
}

/**
 * The shared linked-issue chip state machine used by the create, edit and
 * local-create paths: chips, dismissed/probed refs, extraction seeding, AI union,
 * candidate ranking. Fully inert while `enabled` is false (no queries, no seeding),
 * so a caller can mount it unconditionally and gate on forge/dialog state. Knows
 * only the forge's own issue tracker — the Jira sibling is
 * {@link useJiraMentionChips}.
 *
 * All of it is per TARGET (`repoPath` + `lens`): an issue number means a
 * different issue on another target, so a flip shows that target's own cluster
 * and a flip back restores this one. Async writes land in the bucket of the
 * target they were started under, never whichever one is on screen by then.
 */
export function useLinkedIssueChips(opts: {
  repoPath: string;
  lens: RemoteLens;
  /** Master gate — when false the hook is fully inert (no queries, no seeding). */
  enabled: boolean;
  /** Extraction text sources; re-seed when they change. */
  headBranch: string | null;
  commitSubjects: string[];
}): {
  chips: LinkedIssueChip[];
  resetWith: (refs: BodyRef[]) => void;
  toggleKeyword: (n: number) => void;
  remove: (n: number) => void;
  pick: (n: number) => void;
  buildCandidates: () => IssueCandidate[];
  /** `sig` names the target the draft's run was started under; omitted, the
   *  target of the render that produced this function. */
  upsertFromDraft: (
    draft: { closes: number[]; relates: number[] },
    sig?: LinkedIssueTargetSig,
  ) => void;
} {
  const { repoPath, lens, enabled, headBranch, commitSubjects } = opts;
  const queryClient = useQueryClient();
  const targetKey = linkedIssueTargetKey({ repoPath, lens });

  // Open issues (page of 50) to validate seeds against and to rank as prompt
  // candidates. Uses the caller's lens, so the parent target reads the parent's
  // issues; its placeholder is lens-matched, so a flip never reads another
  // target's page.
  const issueList = useIssueList(repoPath, enabled, "open", 50, lens);

  // Every target's chips + dismissals; the visible cluster is the current one.
  // Each async write carries the reset generation it was fired in, so one that
  // settles after a reset is dropped instead of reviving a cleared cluster.
  const [buckets, setBuckets] = useState<LinkedIssueBuckets>(
    INITIAL_LINKED_ISSUE_BUCKETS,
  );
  // The generation's source of truth; `buckets.generation` is its applied
  // mirror. It advances synchronously in `resetWith` because the create
  // dialogs declare their open-seed effect before this hook: in one passive
  // flush the reset runs first and the extraction seed right after it, reading
  // a render that predates the reset, so a rendered generation would be stale.
  const generationRef = useRef(INITIAL_LINKED_ISSUE_BUCKETS.generation);
  const chips = bucketFor(buckets, targetKey).chips;
  // Per target: numbers already probed this reset-cycle (present-or-absent from
  // the open page), so each probe runs at most once per number per target.
  // Stamped with its generation: only a probe of that generation may mark it.
  const probedRef = useRef<{
    generation: number;
    byTarget: Map<string, Set<number>>;
  }>({
    generation: INITIAL_LINKED_ISSUE_BUCKETS.generation,
    byTarget: new Map(),
  });
  // Per target: the exact candidate set last fed to the AI generate —
  // `upsertFromDraft` resolves an AI-proposed number's title/state from the
  // run's own target's set.
  const lastCandidatesRef = useRef<Map<string, Map<number, IssueCandidate>>>(
    new Map(),
  );

  function probedFor(key: string): Set<number> {
    const { byTarget } = probedRef.current;
    let probed = byTarget.get(key);
    if (!probed) {
      probed = new Set();
      byTarget.set(key, probed);
    }
    return probed;
  }
  // A probe from a superseded generation never marks the current set, so it
  // can't stop the number being probed again after the reset.
  function markProbed(key: string, gen: number, n: number) {
    if (probedRef.current.generation === gen) probedFor(key).add(n);
  }
  function route(
    key: string,
    gen: number,
    update: (bucket: LinkedIssueBucket) => LinkedIssueBucket,
  ) {
    setBuckets((prev) => routeBucketUpdate(prev, key, gen, update));
  }
  // Resolve a chip's title/state once; a failed probe leaves the chip as it is.
  function probeTitle(key: string, gen: number, n: number) {
    markProbed(key, gen, n);
    queryClient
      .fetchQuery(issueDetailsOptions(repoPath, n, lens))
      .then((issue) => route(key, gen, (b) => fillIssueMeta(b, n, issue)))
      .catch(() => undefined);
  }

  // Reset EVERY target's chip state and seed the current one from body-parsed
  // refs. An unresolvable body-parsed ref KEEPS its chip with title "" (the
  // author's existing content must never be silently dropped; contrast
  // extraction seeds, which drop when unverified). Resolves titles/states
  // lazily from the open page or a one-shot probe.
  const resetWith = useEffectEvent((refs: BodyRef[]) => {
    // Advance first, then seed with that value: the counter and the applied
    // generation must stay in lockstep.
    generationRef.current += 1;
    const gen = generationRef.current;
    probedRef.current = { generation: gen, byTarget: new Map() };
    lastCandidatesRef.current = new Map();
    // Seed a chip per body ref, keyword preserved, source "manual"; title/state
    // fill in lazily below. A repeated number keeps its first appearance.
    const seen = new Set<number>();
    const seeded: LinkedIssueChip[] = [];
    const unresolved: number[] = [];
    for (const r of refs) {
      if (seen.has(r.number)) continue;
      seen.add(r.number);
      const hit = (issueList.data ?? []).find((i) => i.number === r.number);
      seeded.push({
        number: r.number,
        title: hit?.title ?? "",
        state: hit?.state ?? "OPEN",
        keyword: r.keyword,
        source: "manual",
        aiSuggestedClose: false,
      });
      if (!hit) unresolved.push(r.number);
    }
    setBuckets(seedBuckets(gen, targetKey, seeded));
    // Not on the open page yet — probe once to resolve title/state, but keep
    // the chip regardless of the probe outcome (author content is preserved).
    if (enabled) for (const n of unresolved) probeTitle(targetKey, gen, n);
  });

  // Backfill a body-parsed chip's title/state once the open-issues page arrives.
  // Only touches chips still missing a title, so it never fights a probe result or a
  // user edit. A chip NOT on the open page is probed once here — resetWith's own
  // probe is skipped when `enabled` still reflects the pre-open render, so this is
  // the reliable resolution point. A failed probe leaves the chip intact (title "").
  const backfillTitles = useEffectEvent(
    (
      key: string,
      openIssues: NonNullable<typeof issueList.data>,
      current: LinkedIssueChip[],
    ) => {
      const gen = generationRef.current;
      route(key, gen, (b) => backfillFromOpenPage(b, openIssues));
      // Probe any still-unresolved chip not on the open page, once per number.
      const probed = probedFor(key);
      for (const c of current) {
        if (c.title !== "" || probed.has(c.number)) continue;
        if (openIssues.some((i) => i.number === c.number)) continue;
        probeTitle(key, gen, c.number);
      }
    },
  );
  useEffect(() => {
    if (!enabled || !issueList.data) return;
    backfillTitles(targetKey, issueList.data, chips);
  }, [enabled, issueList.data, chips, targetKey]);

  function toggleKeyword(issueNumber: number) {
    route(targetKey, generationRef.current, (b) =>
      toggleIssueKeyword(b, issueNumber),
    );
  }
  function remove(issueNumber: number) {
    route(targetKey, generationRef.current, (b) =>
      dismissIssue(b, issueNumber),
    );
  }
  // Manual pick: explicit intent, so it clears any prior dismissal and adds a
  // `manual` relates chip (the picker already excludes current chips). The picker
  // offers CLOSED issues too, which aren't on the open page — seed those with an
  // empty title/state so the backfill-probe effect resolves them (a placeholder
  // `#N`/OPEN would be a permanent lie: that effect only targets empty titles).
  // Clearing the probed marker lets the effect re-probe this number.
  function pick(issueNumber: number) {
    probedFor(targetKey).delete(issueNumber);
    const found = (issueList.data ?? []).find((i) => i.number === issueNumber);
    route(targetKey, generationRef.current, (b) =>
      pickIssue(b, {
        number: issueNumber,
        title: found?.title ?? "",
        state: found?.state ?? "",
        keyword: "relates",
        source: "manual",
        aiSuggestedClose: false,
      }),
    );
  }

  // Extraction seeding: pull candidate issue numbers from the head branch name and
  // commit subjects, then add a chip for each that's a real repo issue — resolved
  // from the open page or probed once (dropped on any error: a PR number, a deleted
  // issue, or noise). Dismissed/present numbers skipped; once per number per
  // reset, per target, so returning to a target re-seeds only what it lacks.
  const seedExtractedIssues = useEffectEvent(
    (key: string, numbers: number[], openIssues: typeof issueList.data) => {
      const gen = generationRef.current;
      // A reset queued in this same flush hasn't rendered yet, so the rendered
      // bucket is the previous open's; skip only against a current one (each
      // write re-checks presence and dismissal against the applied state).
      const current =
        buckets.generation === gen
          ? bucketFor(buckets, key)
          : EMPTY_LINKED_ISSUE_BUCKET;
      const existing = new Set(current.chips.map((c) => c.number));
      const probed = probedFor(key);
      for (const n of numbers) {
        if (existing.has(n) || current.dismissed.has(n)) continue;
        const hit = openIssues?.find((i) => i.number === n);
        if (hit) {
          route(key, gen, (b) => addExtractedIssue(b, extractedChip(hit)));
          continue;
        }
        // Not on the open page — probe the tracker once. Skip if the open list
        // hasn't loaded yet (a later run resolves it) so we don't probe numbers
        // that would have matched the page.
        if (!openIssues) continue;
        if (probed.has(n)) continue;
        // `gen` was read at fire time: a reset before this settles makes the
        // seed stale.
        markProbed(key, gen, n);
        queryClient
          .fetchQuery(issueDetailsOptions(repoPath, n, lens))
          .then((issue) =>
            route(key, gen, (b) => addExtractedIssue(b, extractedChip(issue))),
          )
          .catch(() => undefined);
      }
    },
  );
  // Join the subjects into a stable string so a fresh `commitSubjects` array each
  // render doesn't re-fire this effect (the seeder is idempotent, but keep it to
  // real changes). `targetKey` re-runs it on a flip to seed the incoming target.
  const subjectsText = commitSubjects.join("\n");
  useEffect(() => {
    if (!enabled) return;
    const numbers = extractIssueNumbers(`${headBranch ?? ""}\n${subjectsText}`);
    if (numbers.length === 0) return;
    seedExtractedIssues(targetKey, numbers, issueList.data);
  }, [enabled, headBranch, subjectsText, issueList.data, targetKey]);

  // chips ∪ validated extraction ∪ top-ranked open issues, cap 8 — for generate().
  // Current chips are pinned first; then the highest-scoring OPEN issues by
  // shared-token overlap between the title and the branch + commit subjects.
  // Records the exact set fed, under the current target, so `upsertFromDraft`
  // can resolve title/state.
  function buildCandidates(): IssueCandidate[] {
    if (!enabled) {
      lastCandidatesRef.current.delete(targetKey);
      return [];
    }
    const chipNumbers = new Set(chips.map((c) => c.number));
    const chipCandidates: IssueCandidate[] = chips.map((c) => ({
      number: c.number,
      title: c.title,
      state: c.state,
    }));
    const rankText = rankTokens(
      `${headBranch ?? ""} ${commitSubjects.join(" ")}`,
    );
    const ranked = (issueList.data ?? [])
      .filter((i) => !chipNumbers.has(i.number))
      .map((i) => ({ issue: i, score: sharedTokenScore(i.title, rankText) }))
      .sort(
        (a, b) =>
          b.score - a.score ||
          byUpdatedAtDesc(a.issue.updatedAt, b.issue.updatedAt),
      )
      .map((r) => ({
        number: r.issue.number,
        title: r.issue.title,
        state: r.issue.state,
      }));
    const candidates = [...chipCandidates, ...ranked].slice(0, 8);
    lastCandidatesRef.current.set(
      targetKey,
      new Map(candidates.map((c) => [c.number, c])),
    );
    return candidates;
  }

  // Union the model's proposed close/relate numbers into the run target's chip
  // cluster — a chunk arriving after a flip lands in the target the run was
  // grounded against, whose candidates resolve its titles.
  function upsertFromDraft(
    draft: { closes: number[]; relates: number[] },
    sig?: LinkedIssueTargetSig,
  ) {
    const key = sig ? linkedIssueTargetKey(sig) : targetKey;
    const fed = lastCandidatesRef.current.get(key) ?? new Map();
    route(key, generationRef.current, (b) => upsertAiIssues(b, draft, fed));
  }

  return {
    chips,
    resetWith,
    toggleKeyword,
    remove,
    pick,
    buildCandidates,
    upsertFromDraft,
  };
}

/** An extraction-seeded chip for a validated issue. */
function extractedChip(issue: {
  number: number;
  title: string;
  state: string;
}): LinkedIssueChip {
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    keyword: "relates",
    source: "extraction",
    aiSuggestedClose: false,
  };
}

/** A validated Jira issue the model may MENTION (grounded candidate for the AI
 *  generate). Structurally matches `useGeneratePrDescription`'s JiraCandidate. */
export interface JiraCandidate {
  key: string;
  summary: string;
  statusCategory: string;
}

/**
 * The Jira twin of {@link useLinkedIssueChips} for Bitbucket repos with a linked
 * project (no native tracker). Same state machine — dismissed set, manual picks,
 * extraction seeding, AI union, candidate ranking — but keyed by the human key
 * (`PROJ-123`) and MENTION-ONLY: no keyword, no close semantics; chips compose into
 * the body as `Relates to KEY` lines. Fully inert while `enabled` is false.
 */
export function useJiraMentionChips(opts: {
  repoPath: string;
  /** Master gate — when false the hook is fully inert (no queries, no seeding). */
  enabled: boolean;
  /** Extraction text sources; re-seed when they change. */
  headBranch: string | null;
  commitSubjects: string[];
  /** The repo's Jira link (site + project). Null ⇒ the hook is inert regardless
   *  of `enabled` (nothing to fetch or extract against). */
  link: JiraLink | null;
}): {
  chips: JiraMentionChip[];
  resetWith: (keys: string[]) => void;
  remove: (key: string) => void;
  pick: (key: string) => void;
  buildCandidates: () => JiraCandidate[];
  upsertFromDraft: (draft: { jiraMentions: string[] }) => void;
} {
  const { repoPath, enabled, headBranch, commitSubjects, link } = opts;

  // Open page of the linked project's issues to validate seeds against and to
  // rank as prompt candidates. `useJiraIssues` gates on `!!link`, so pass null to
  // disable when the hook is inert (or the repo is unlinked).
  const active = enabled && !!link;
  const issueList = useJiraIssues(repoPath, active ? link : null, "open");

  const [chips, setChips] = useState<JiraMentionChip[]>([]);
  // Each async write carries the reset generation it was fired in and is dropped
  // if a reset lands first. The ref is the source of truth, advanced
  // synchronously in `resetWith` (the create dialog's open-seed effect runs
  // before this hook's in one flush); `chipsGeneration` is the rendered mirror.
  // A repo switch always closes and reseeds the dialog, and Jira has one link
  // per repo, so this covers what per-target buckets cover on the forge path.
  const generationRef = useRef(0);
  const [chipsGeneration, setChipsGeneration] = useState(0);
  // A key the user removed (or that came in dismissed): upserts (seed/AI) skip it;
  // a MANUAL pick clears it (explicit intent overrides). Reset in resetWith.
  const dismissedRef = useRef<Set<string>>(new Set());
  // Keys already probed this reset-cycle (present-or-absent from the open page),
  // so the per-key fetch runs at most once per key per reset. Stamped with its
  // generation: only a probe of that generation may mark it.
  const probedRef = useRef<{ generation: number; keys: Set<string> }>({
    generation: 0,
    keys: new Set(),
  });
  // The exact candidate set last fed to the AI generate — `upsertFromDraft`
  // resolves an AI-proposed key's summary/status from here.
  const lastCandidatesRef = useRef<Map<string, JiraCandidate>>(new Map());

  // A probe from a superseded generation never marks the current set, so it
  // can't stop the key being probed again after the reset.
  function markProbed(gen: number, key: string) {
    if (probedRef.current.generation === gen) probedRef.current.keys.add(key);
  }
  // Resolve a chip's summary/status once; a failed probe leaves the chip as it is.
  function probeSummary(gen: number, siteHost: string, key: string) {
    markProbed(gen, key);
    jiraIssueView(siteHost, key)
      .then((issue) => {
        if (generationRef.current !== gen) return;
        setChips((prev) =>
          prev.map((c) =>
            c.key === key && c.summary === ""
              ? {
                  ...c,
                  summary: issue.summary,
                  statusCategory: issue.statusCategory,
                }
              : c,
          ),
        );
      })
      .catch(() => undefined);
  }

  // Reset and seed from body-parsed keys. An unresolvable key KEEPS its chip with
  // summary "" (author content is never silently dropped; contrast extraction seeds,
  // which drop when unverified); summary/status resolve lazily.
  const resetWith = useEffectEvent((keys: string[]) => {
    // Advance first: every write below, and every probe fired from here, carries
    // the new generation.
    generationRef.current += 1;
    const gen = generationRef.current;
    dismissedRef.current = new Set();
    probedRef.current = { generation: gen, keys: new Set() };
    lastCandidatesRef.current = new Map();
    const seen = new Set<string>();
    const seeded: JiraMentionChip[] = [];
    for (const key of keys) {
      if (seen.has(key)) continue;
      seen.add(key);
      const hit = (issueList.data ?? []).find((i) => i.key === key);
      seeded.push({
        key,
        summary: hit?.summary ?? "",
        statusCategory: hit?.statusCategory ?? "",
        source: "manual",
      });
      // Not on the open page yet — probe once to resolve summary/status, but keep
      // the chip regardless of the probe outcome (author content is preserved).
      if (!hit && active && link) probeSummary(gen, link.siteHost, key);
    }
    setChips(seeded);
    setChipsGeneration(gen);
  });

  // Backfill a chip's summary/status once the open page arrives. Only touches chips
  // still missing a summary, so it never fights a probe result or a user edit. A chip
  // NOT on the open page is probed once here — `resetWith`'s own probe is skipped
  // when `active` still reflects the pre-open render. A failed probe leaves the chip
  // intact (summary "").
  const backfillSummaries = useEffectEvent(
    (
      siteHost: string,
      openIssues: NonNullable<typeof issueList.data>,
      current: JiraMentionChip[],
    ) => {
      const gen = generationRef.current;
      // Rendered chips from before a reset in this same flush would mark their
      // keys probed for the new cycle; the reset's own render re-runs this.
      if (chipsGeneration !== gen) return;
      setChips((prev) => {
        let changed = false;
        const next = prev.map((c) => {
          if (c.summary !== "") return c;
          const hit = openIssues.find((i) => i.key === c.key);
          if (!hit) return c;
          changed = true;
          return {
            ...c,
            summary: hit.summary,
            statusCategory: hit.statusCategory,
          };
        });
        return changed ? next : prev;
      });
      // Probe any still-unresolved chip not on the open page, once per key.
      for (const c of current) {
        if (c.summary !== "" || probedRef.current.keys.has(c.key)) continue;
        if (openIssues.some((i) => i.key === c.key)) continue;
        probeSummary(gen, siteHost, c.key);
      }
    },
  );
  useEffect(() => {
    if (!active || !issueList.data || !link) return;
    backfillSummaries(link.siteHost, issueList.data, chips);
  }, [active, issueList.data, link, chips]);

  function remove(key: string) {
    dismissedRef.current.add(key);
    setChips((prev) => prev.filter((c) => c.key !== key));
  }
  // Manual pick: explicit intent, so it clears any prior dismissal and adds a
  // `manual` chip (the picker already excludes current chips). The picker offers ALL
  // states, which aren't on the open page — seed those with an empty summary so the
  // backfill-probe effect resolves them (a `key` placeholder would be a permanent
  // lie: that effect only targets empty summaries). Clearing the probed marker lets
  // the effect re-probe this key.
  function pick(key: string) {
    dismissedRef.current.delete(key);
    probedRef.current.keys.delete(key);
    const found = (issueList.data ?? []).find((i) => i.key === key);
    setChips((prev) => {
      if (prev.some((c) => c.key === key)) return prev;
      return [
        ...prev,
        {
          key,
          summary: found?.summary ?? "",
          statusCategory: found?.statusCategory ?? "",
          source: "manual",
        },
      ];
    });
  }

  // Extraction seeding: pull linked-project keys from the head branch and commit
  // subjects, then add a chip for each that's a real project issue — resolved from
  // the open page or probed once (dropped on any error). Dismissed/present keys
  // skipped; once per key per reset.
  const seedExtractedKeys = useEffectEvent(
    (keys: string[], openIssues: typeof issueList.data) => {
      // Read at call time, never bumped here: a reset queued in this same flush
      // hasn't rendered yet, so the rendered chips count as present only when
      // they belong to the current generation (the updaters below dedupe again).
      const gen = generationRef.current;
      const existing = new Set(
        chipsGeneration === gen ? chips.map((c) => c.key) : [],
      );
      for (const key of keys) {
        if (existing.has(key) || dismissedRef.current.has(key)) continue;
        const hit = openIssues?.find((i) => i.key === key);
        if (hit) {
          setChips((prev) =>
            prev.some((c) => c.key === key)
              ? prev
              : [
                  ...prev,
                  {
                    key,
                    summary: hit.summary,
                    statusCategory: hit.statusCategory,
                    source: "extraction",
                  },
                ],
          );
          continue;
        }
        // Not on the open page — probe the project once. Skip if the open list
        // hasn't loaded yet (a later run resolves it) so we don't probe keys that
        // would have matched the page.
        if (!openIssues) continue;
        if (probedRef.current.keys.has(key) || !link) continue;
        markProbed(gen, key);
        jiraIssueView(link.siteHost, key)
          .then((issue) => {
            if (generationRef.current !== gen) return;
            if (dismissedRef.current.has(key)) return;
            setChips((prev) =>
              prev.some((c) => c.key === key)
                ? prev
                : [
                    ...prev,
                    {
                      key: issue.key,
                      summary: issue.summary,
                      statusCategory: issue.statusCategory,
                      source: "extraction",
                    },
                  ],
            );
          })
          .catch(() => undefined);
      }
    },
  );
  const subjectsText = commitSubjects.join("\n");
  useEffect(() => {
    if (!active || !link) return;
    const keys = extractJiraKeys(
      `${headBranch ?? ""}\n${subjectsText}`,
      link.projectKey,
    );
    if (keys.length === 0) return;
    seedExtractedKeys(keys, issueList.data);
  }, [active, link, headBranch, subjectsText, issueList.data]);

  // chips ∪ extraction ∪ top-ranked open issues, cap 8 — for generate(). Chips
  // pinned first, then highest shared-token overlap, `updatedAt` desc tie-break.
  // Records the exact fed set so `upsertFromDraft` can resolve summary/status.
  function buildCandidates(): JiraCandidate[] {
    if (!active) {
      lastCandidatesRef.current = new Map();
      return [];
    }
    const chipKeys = new Set(chips.map((c) => c.key));
    const chipCandidates: JiraCandidate[] = chips.map((c) => ({
      key: c.key,
      summary: c.summary,
      statusCategory: c.statusCategory,
    }));
    const rankText = rankTokens(
      `${headBranch ?? ""} ${commitSubjects.join(" ")}`,
    );
    const ranked = (issueList.data ?? [])
      .filter((i) => !chipKeys.has(i.key))
      .map((i) => ({ issue: i, score: sharedTokenScore(i.summary, rankText) }))
      .sort(
        (a, b) =>
          b.score - a.score ||
          byUpdatedAtDesc(a.issue.updatedAt, b.issue.updatedAt),
      )
      .map((r) => ({
        key: r.issue.key,
        summary: r.issue.summary,
        statusCategory: r.issue.statusCategory,
      }));
    const candidates = [...chipCandidates, ...ranked].slice(0, 8);
    // Key the fed map by UPPERCASED key: AI mention keys arrive uppercased from
    // `extractPrDraft`, while candidate keys come raw from the Jira API — so a
    // case-insensitive lookup in `upsertFromDraft` reliably resolves the meta.
    lastCandidatesRef.current = new Map(
      candidates.map((c) => [c.key.toUpperCase(), c]),
    );
    return candidates;
  }

  // Union the model's proposed mention keys into the chip cluster, marked `ai`.
  // Skip dismissed keys; skip existing chips. Resolve a new chip's summary/status
  // from the last-built candidates (looked up case-insensitively). Needs no
  // generation stamp: a reset empties the candidate set its keys resolve against.
  function upsertFromDraft(draft: { jiraMentions: string[] }) {
    const fed = lastCandidatesRef.current;
    setChips((prev) => {
      let next = prev;
      for (const key of draft.jiraMentions) {
        if (dismissedRef.current.has(key)) continue;
        if (next.some((c) => c.key === key)) continue;
        const meta = fed.get(key.toUpperCase());
        if (!meta) continue;
        next = [
          ...next,
          {
            key,
            summary: meta.summary,
            statusCategory: meta.statusCategory,
            source: "ai",
          },
        ];
      }
      return next;
    });
  }

  return { chips, resetWith, remove, pick, buildCandidates, upsertFromDraft };
}
