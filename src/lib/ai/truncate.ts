import type { ContextBudgetProfile } from "./context-budget";

/** Character budget for the staged diff inside the AI prompt. */
export const DIFF_CHAR_BUDGET = 80_000;
/** Cap applied to each individual file section once over budget. */
const PER_FILE_CAP = 6_000;

/**
 * Slices `s` to at most `max` UTF-16 code units WITHOUT splitting a surrogate
 * pair at the cut. A plain `s.slice(0, max)` cuts on code-unit boundaries, so a
 * cap landing between the two halves of an astral char (e.g. an emoji like 💡 in
 * a bot review) leaves a LONE high surrogate at the end. That lone surrogate
 * becomes an invalid `\u` escape the moment the prompt is JSON-serialized into
 * the model request — which every provider rejects (serde_json "unexpected end
 * of hex escape" for the CLI providers; "Invalid body: failed to parse JSON" for
 * HTTP APIs), failing the whole review. Backing off one unit when the boundary
 * char is a high surrogate keeps every emoji whole.
 */
export function safeSlice(s: string, max: number): string {
  if (s.length <= max) return s;
  const boundary = s.charCodeAt(max - 1);
  // High surrogate at the last kept index → its low half sits at `max` (dropped),
  // so drop the high half too rather than emit a lone surrogate.
  const end = boundary >= 0xd800 && boundary <= 0xdbff ? max - 1 : max;
  return s.slice(0, end);
}

const LOW_VALUE_PATH =
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.lock|bun\.lockb?|composer\.lock|Gemfile\.lock|go\.sum)$|\.min\.(js|css)$|\.(map|snap)$/;

interface FileSection {
  path: string;
  text: string;
}

export interface BudgetedDiff {
  text: string;
  truncated: boolean;
  omittedFiles: string[];
}

function splitIntoFileSections(diffText: string): FileSection[] {
  const sections: FileSection[] = [];
  const parts = diffText.split(/^(?=diff --git )/m).filter((p) => p.trim());
  for (const part of parts) {
    const header = part.slice(0, part.indexOf("\n"));
    // `diff --git a/<path> b/<path>` — take the b/ side
    const match = header.match(/ b\/(.+)$/);
    sections.push({ path: match?.[1] ?? header, text: part });
  }
  return sections;
}

/**
 * Fits a staged diff into the prompt budget: drop lockfile/generated diffs
 * first, then cap oversized per-file sections, then hard-cap the total.
 *
 * KEEP IN SYNC: src-tauri/src/mcp_server/generate.rs (`budget_diff`,
 * `is_low_value_path`, `split_into_file_sections`, `DIFF_CHAR_BUDGET`,
 * `PER_FILE_CAP`) mirrors this for the MCP recipe tools — with the DEFAULT
 * `budget`/`perFileCap`; the review path scales them per model (see
 * context-budget.ts) while the recipe tools keep the constants.
 */
export function budgetDiff(
  diffText: string,
  budget: number = DIFF_CHAR_BUDGET,
  perFileCap: number = PER_FILE_CAP,
): BudgetedDiff {
  if (diffText.length <= budget) {
    return { text: diffText, truncated: false, omittedFiles: [] };
  }

  const sections = splitIntoFileSections(diffText);
  const omittedFiles: string[] = [];

  let kept = sections.filter((s) => {
    if (LOW_VALUE_PATH.test(s.path)) {
      omittedFiles.push(s.path);
      return false;
    }
    return true;
  });

  let total = kept.reduce((sum, s) => sum + s.text.length, 0);
  if (total > budget) {
    kept = kept.map((s) =>
      s.text.length > perFileCap
        ? {
            ...s,
            text: `${safeSlice(s.text, perFileCap)}\n[... rest of ${s.path} truncated]\n`,
          }
        : s,
    );
    total = kept.reduce((sum, s) => sum + s.text.length, 0);
  }

  const included: FileSection[] = [];
  let used = 0;
  for (const section of kept) {
    if (used + section.text.length > budget) {
      omittedFiles.push(section.path);
      continue;
    }
    included.push(section);
    used += section.text.length;
  }

  return {
    text: included.map((s) => s.text).join(""),
    truncated: true,
    omittedFiles,
  };
}

/** Overall soft ceiling for the diff + delta + prior-findings sections combined.
 *  Above `DIFF_CHAR_BUDGET` so a full diff still leaves room for soft context. */
export const PROMPT_CHAR_BUDGET = 100_000;
/** Cap for the "changes since last review" delta. */
export const DELTA_DIFF_CHAR_BUDGET = 24_000;
/** Cap for the prior review's findings (head-kept — reviews front-load blockers). */
export const PRIOR_FINDINGS_CHAR_BUDGET = 8_000;
/** Cap for GitDesktop's OWN prior comments on the PR (ranked above external bots
 *  — our refutations are higher-signal than theirs — but below our prior review). */
export const OWN_COMMENTS_CHAR_BUDGET = 6_000;
/** Cap for third-party AI-reviewer findings (lowest priority — noisier, theirs). */
export const EXTERNAL_FINDINGS_CHAR_BUDGET = 8_000;

export interface ReviewExtras {
  /** Budgeted delta diff (empty when absent or dropped for budget). */
  delta: BudgetedDiff;
  /** Delta dropped entirely to protect the authoritative diff's budget. */
  deltaDropped: boolean;
  /** Budgeted (head-truncated) prior findings. */
  prior: { text: string; truncated: boolean };
  /** Prior findings dropped entirely for budget. */
  priorDropped: boolean;
  /** Budgeted GitDesktop's-own prior PR comments — a contiguous NEWEST-first
   *  suffix of the comment blocks, rendered back in oldest-first order.
   *  `truncated` when any block was excluded or the newest was head-sliced. */
  own: { text: string; truncated: boolean };
  /** Own comments dropped entirely for budget. */
  ownDropped: boolean;
  /** Budgeted (head-truncated) third-party AI-reviewer findings. */
  external: { text: string; truncated: boolean };
  /** External findings dropped entirely for budget. */
  externalDropped: boolean;
}

/**
 * Allocates the soft context (delta + prior findings + our own PR comments +
 * external findings) into whatever budget the authoritative full diff leaves,
 * against one shared ceiling. Order is enforced: the diff is sacrosanct, the
 * delta gets next claim, our prior findings take the remainder, our own PR
 * comments take what's left, third-party reviewer findings get the rest — so
 * under pressure external drops first, then our comments, then prior, then the
 * delta, never the diff. `diffLen` is the length of the already-budgeted main diff.
 *
 * Our own comments (`ownItems`) fit RECENCY-FIRST rather than head-first: the
 * newest, highest-signal follow-ups are kept and the oldest drop when the cap
 * bites (the reverse of prior/external, which head-slice a single blob).
 */
export function budgetReviewExtras(input: {
  diffLen: number;
  deltaText?: string;
  priorText?: string;
  ownItems?: string[];
  externalText?: string;
  /** Per-model scaled caps. When absent, the module constants are used, so the
   *  default path is byte-identical to before the profile support. */
  profile?: ContextBudgetProfile;
}): ReviewExtras {
  // Fall back to the module constants when no profile is supplied — this keeps
  // the default path byte-for-byte identical to the pre-profile behavior.
  const promptBudget = input.profile?.promptCharBudget ?? PROMPT_CHAR_BUDGET;
  const deltaBudget = input.profile?.deltaCharBudget ?? DELTA_DIFF_CHAR_BUDGET;
  const priorBudget =
    input.profile?.priorCharBudget ?? PRIOR_FINDINGS_CHAR_BUDGET;
  const ownBudget = input.profile?.ownCharBudget ?? OWN_COMMENTS_CHAR_BUDGET;
  const externalBudget =
    input.profile?.externalCharBudget ?? EXTERNAL_FINDINGS_CHAR_BUDGET;
  const emptyDiff: BudgetedDiff = {
    text: "",
    truncated: false,
    omittedFiles: [],
  };
  let remaining = Math.max(0, promptBudget - input.diffLen);

  let delta = emptyDiff;
  let deltaDropped = false;
  if (input.deltaText?.trim()) {
    const cap = Math.min(remaining, deltaBudget);
    if (cap <= 0) {
      deltaDropped = true;
    } else {
      delta = budgetDiff(input.deltaText, cap, input.profile?.perFileCap);
      remaining -= delta.text.length;
    }
  }

  const fit = (text: string | undefined, max: number) => {
    if (!text?.trim())
      return { result: { text: "", truncated: false }, dropped: false };
    const cap = Math.min(remaining, max);
    if (cap <= 0)
      return { result: { text: "", truncated: false }, dropped: true };
    const result =
      text.length <= cap
        ? { text, truncated: false }
        : { text: safeSlice(text, cap), truncated: true };
    remaining -= result.text.length;
    return { result, dropped: false };
  };

  // Our own comments fit recency-first: walk from the NEWEST block (array end)
  // backwards, accumulating each block's length plus a 2-char "\n\n" joiner for
  // every block after the first, and keep a CONTIGUOUS newest suffix while it fits
  // the cap — stopping at the first block that doesn't (no skip-and-continue). If
  // not even the newest block fits, the newest alone is head-sliced to the cap.
  // The kept blocks render in ORIGINAL oldest-first order.
  const fitOwn = (items: string[] | undefined, max: number) => {
    const present = items?.filter((t) => t.trim()) ?? [];
    if (present.length === 0)
      return { result: { text: "", truncated: false }, dropped: false };
    const cap = Math.min(remaining, max);
    if (cap <= 0)
      return { result: { text: "", truncated: false }, dropped: true };

    let keptCount = 0;
    let running = 0;
    for (let i = present.length - 1; i >= 0; i--) {
      const cost = present[i].length + (keptCount > 0 ? 2 : 0);
      if (running + cost > cap) break;
      running += cost;
      keptCount++;
    }

    let text: string;
    let truncated: boolean;
    if (keptCount === 0) {
      // Not even the newest block fits — include it alone, head-sliced.
      text = safeSlice(present[present.length - 1], cap);
      truncated = true;
    } else {
      const selected = present.slice(present.length - keptCount);
      text = selected.join("\n\n");
      truncated = keptCount < present.length;
    }
    remaining -= text.length;
    return { result: { text, truncated }, dropped: false };
  };

  const priorFit = fit(input.priorText, priorBudget);
  const ownFit = fitOwn(input.ownItems, ownBudget);
  const externalFit = fit(input.externalText, externalBudget);

  return {
    delta,
    deltaDropped,
    prior: priorFit.result,
    priorDropped: priorFit.dropped,
    own: ownFit.result,
    ownDropped: ownFit.dropped,
    external: externalFit.result,
    externalDropped: externalFit.dropped,
  };
}
