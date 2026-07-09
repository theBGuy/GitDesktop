/** Character budget for the staged diff inside the AI prompt. */
export const DIFF_CHAR_BUDGET = 80_000;
/** Cap applied to each individual file section once over budget. */
const PER_FILE_CAP = 6_000;

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
 * `PER_FILE_CAP`) mirrors this for the MCP recipe tools.
 */
export function budgetDiff(
  diffText: string,
  budget: number = DIFF_CHAR_BUDGET,
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
      s.text.length > PER_FILE_CAP
        ? {
            ...s,
            text: `${s.text.slice(0, PER_FILE_CAP)}\n[... rest of ${s.path} truncated]\n`,
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
  /** Budgeted (head-truncated) GitDesktop's-own prior PR comments. */
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
 */
export function budgetReviewExtras(input: {
  diffLen: number;
  deltaText?: string;
  priorText?: string;
  ownText?: string;
  externalText?: string;
}): ReviewExtras {
  const emptyDiff: BudgetedDiff = {
    text: "",
    truncated: false,
    omittedFiles: [],
  };
  let remaining = Math.max(0, PROMPT_CHAR_BUDGET - input.diffLen);

  let delta = emptyDiff;
  let deltaDropped = false;
  if (input.deltaText?.trim()) {
    const cap = Math.min(remaining, DELTA_DIFF_CHAR_BUDGET);
    if (cap <= 0) {
      deltaDropped = true;
    } else {
      delta = budgetDiff(input.deltaText, cap);
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
        : { text: text.slice(0, cap), truncated: true };
    remaining -= result.text.length;
    return { result, dropped: false };
  };

  const priorFit = fit(input.priorText, PRIOR_FINDINGS_CHAR_BUDGET);
  const ownFit = fit(input.ownText, OWN_COMMENTS_CHAR_BUDGET);
  const externalFit = fit(input.externalText, EXTERNAL_FINDINGS_CHAR_BUDGET);

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
