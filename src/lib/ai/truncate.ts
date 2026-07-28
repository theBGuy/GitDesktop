import type { ContextBudgetProfile } from "./context-budget";

/** Character budget for the staged diff inside the AI prompt. */
export const DIFF_CHAR_BUDGET = 80_000;
/** Cap applied to each individual file section once over budget. */
const PER_FILE_CAP = 6_000;

/**
 * Slices `s` to at most `max` UTF-16 code units WITHOUT splitting a surrogate pair. A
 * plain `slice` can leave a LONE high surrogate, which becomes an invalid `\u` escape
 * once the prompt is JSON-serialized into the model request — rejected by every
 * provider (serde_json "unexpected end of hex escape" for the CLI providers, "Invalid
 * body: failed to parse JSON" for HTTP APIs), failing the whole review.
 */
export function safeSlice(s: string, max: number): string {
  if (s.length <= max) return s;
  const boundary = s.charCodeAt(max - 1);
  // High surrogate at the last kept index → its low half sits at `max` (dropped),
  // so drop the high half too rather than emit a lone surrogate.
  const end = boundary >= 0xd800 && boundary <= 0xdbff ? max - 1 : max;
  return s.slice(0, end);
}

/** The note appended in place of the text `capBody` cuts — split so its fixed length
 *  can be charged against the cap before the omitted count is known. Deliberately
 *  source-neutral: only two of the four things cut with it live on a PR thread, so
 *  naming a thread would send an agentic reviewer looking for text that isn't there.
 *  Module-private on purpose — `capBody` and `stripTruncationNote` are the contract,
 *  so no producer or consumer re-derives the note's shape. */
const TRUNCATION_NOTE_HEAD = "[content truncated — ";
const TRUNCATION_NOTE_TAIL = " more characters omitted]";

/**
 * Splits a trailing `capBody` note off `text`, returning the note-free body and the
 * count it disclosed (0 when absent). Lets a second cut of an already-cut block state
 * the CUMULATIVE omission instead of nesting notes or — worse — slicing the first note
 * away and leaving the block looking complete. The note may be indented: the own- and
 * external-section renderers write bodies under a `\n  ` continuation indent.
 */
export function stripTruncationNote(text: string): {
  text: string;
  omitted: number;
} {
  const nl = text.lastIndexOf("\n");
  if (nl < 0) return { text, omitted: 0 };
  const lastLine = text.slice(nl + 1).trimStart();
  if (
    !lastLine.startsWith(TRUNCATION_NOTE_HEAD) ||
    !lastLine.endsWith(TRUNCATION_NOTE_TAIL)
  )
    return { text, omitted: 0 };
  const digits = lastLine.slice(
    TRUNCATION_NOTE_HEAD.length,
    lastLine.length - TRUNCATION_NOTE_TAIL.length,
  );
  if (!/^\d+$/.test(digits)) return { text, omitted: 0 };
  return { text: text.slice(0, nl), omitted: Number(digits) };
}

/**
 * Max-min fair share of `budget` across blocks of the given `lengths`: walking
 * shortest-first, each block may claim an equal share of what's left, a block that
 * fits under its share donates the slack, and the first block to exceed its share
 * freezes that share for itself and every longer block. So a lone 6K brief inside an
 * 18K budget survives whole while a dozen 6K comments converge on the floor.
 *
 * `floor` is a guaranteed minimum per block — one value for all, or a per-index array
 * (the external section's floor differs by finding kind). It only ever LIFTS a cap, so
 * the caps can sum past `budget`: they decide how the budget is SHARED, while each
 * section's own fitter (`fitOwn` / `fit`) is the hard enforcement. Returned in the
 * caller's index order.
 */
export function allocateBodyCaps(
  lengths: number[],
  budget: number,
  floor: number | number[],
): number[] {
  const floorAt = (i: number) => (typeof floor === "number" ? floor : floor[i]);
  const caps = lengths.map((_, i) => floorAt(i));
  // Shortest-first: only that order lets a short block's slack reach the long
  // ones (indices, so the result maps back to the caller's order).
  const order = lengths
    .map((_, i) => i)
    .sort((a, b) => lengths[a] - lengths[b] || a - b);
  let remaining = budget;
  let remainingCount = order.length;
  for (let k = 0; k < order.length; k++) {
    // `remainingCount` is > 0 for every iteration, so this never divides by zero;
    // a non-positive budget yields a non-positive share and thus the floor.
    const share = Math.floor(remaining / remainingCount);
    if (lengths[order[k]] > share) {
      // This block and every longer one are capped at the frozen share.
      for (let j = k; j < order.length; j++) {
        caps[order[j]] = Math.max(floorAt(order[j]), share);
      }
      break;
    }
    caps[order[k]] = Math.max(floorAt(order[k]), share);
    remaining -= lengths[order[k]];
    remainingCount--;
  }
  return caps;
}

/**
 * Head-keeps `text` within `cap`, saying so explicitly when it cuts — a bare `…` left
 * the model guessing whether the author's list simply ended. The note's own worst-case
 * length is charged against `cap`, so the result never exceeds it. `safeSlice`, never
 * a raw slice: a cut through a surrogate pair makes the whole prompt unserializable.
 *
 * `priorOmitted` carries the count from an EARLIER cut of the same text (pair it with
 * `stripTruncationNote`): it folds into the rendered number so a twice-cut block
 * discloses one cumulative note, and a non-zero value re-attaches the note even when
 * the body now fits — dropping it would make a cut block read as complete.
 *
 * `indent` prefixes the note line for callers whose blocks carry a continuation indent
 * (own-comments blocks use two spaces); it is charged against `cap`, and
 * `stripTruncationNote` trims it back off so an indented note round-trips.
 */
export function capBody(
  text: string,
  cap: number,
  priorOmitted = 0,
  indent = "",
): string {
  if (priorOmitted <= 0 && text.length <= cap) return text;
  const reserve =
    1 + // the note's own line break
    indent.length +
    TRUNCATION_NOTE_HEAD.length +
    String(text.length + priorOmitted).length + // omitted count ≤ text + prior
    TRUNCATION_NOTE_TAIL.length;
  const keep = cap - reserve;
  if (keep <= 0) {
    // Cap too small to hold the note at all — reachable, not defensive: `fitOwn` caps
    // at `min(remaining, ownBudget)`, so a nearly-spent prompt budget puts the pin's
    // 35% reserve under the ~59-char note. Disclosure is deliberately lossy here: the
    // ellipsis marks the cut, `priorOmitted` is DROPPED, and prompt.ts's section-level
    // "[own comments truncated …]" marker is what tells the model at all.
    return cap >= 1 ? `${safeSlice(text, cap - 1)}…` : safeSlice(text, cap);
  }
  let head = safeSlice(text, keep);
  // The text being cut may already CONTAIN notes (`fit` cuts a whole rendered section
  // whose items were each capped), and the cut can land inside one, leaving a dangling
  // partial in front of the note we're about to add. A note always occupies its own
  // line, so drop a final line that is a partial one. One-directional: it only removes
  // characters, and the omitted count below is computed from what survived.
  const lastNl = head.lastIndexOf("\n");
  if (lastNl >= 0) {
    const lastLine = head.slice(lastNl + 1).trimStart();
    const partialNote =
      lastLine.length > 0 &&
      (TRUNCATION_NOTE_HEAD.startsWith(lastLine) ||
        (lastLine.startsWith(TRUNCATION_NOTE_HEAD) &&
          !lastLine.endsWith(TRUNCATION_NOTE_TAIL)));
    if (partialNote) head = head.slice(0, lastNl);
  }
  const omitted = text.length - head.length + priorOmitted;
  return `${head}\n${indent}${TRUNCATION_NOTE_HEAD}${omitted}${TRUNCATION_NOTE_TAIL}`;
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

/** Overall soft ceiling for the soft-context sections combined (diff, delta,
 *  prior findings, own comments, external context).
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

/**
 * How many blocks a contiguous NEWEST-first suffix of `blocks` fits into
 * `budget`, charging a 2-char "\n\n" joiner between blocks and stopping at the
 * first block that doesn't fit (no skip-and-continue).
 *
 * Exported so the two recency-first selections can't drift: `fitOwn` below,
 * sizing the prompt's own-comments section, and own-distill.ts, sizing the
 * distiller's input. They pick over the same rendered blocks with the same joiner.
 */
export function newestSuffixCount(blocks: string[], budget: number): number {
  let keptCount = 0;
  let running = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const cost = blocks[i].length + (keptCount > 0 ? 2 : 0);
    if (running + cost > budget) break;
    running += cost;
    keptCount++;
  }
  return keptCount;
}

/** The continuation indent own-comment blocks render their bodies under (see
 *  `formatOwnComments` in own-context.ts). Every re-cut of an already-rendered
 *  block passes it to `capBody` so the re-stated note stays inside its list item:
 *  `fitOwn` below, and own-distill.ts's per-block / input caps. */
export const OWN_BLOCK_INDENT = "  ";

export interface ReviewExtras {
  /** Budgeted delta diff (empty when absent or dropped for budget). */
  delta: BudgetedDiff;
  /** Delta dropped entirely to protect the authoritative diff's budget. */
  deltaDropped: boolean;
  /** Budgeted (head-truncated) prior findings. */
  prior: { text: string; truncated: boolean };
  /** Prior findings dropped entirely for budget. */
  priorDropped: boolean;
  /** Budgeted GitDesktop's-own prior PR comments — everything when it fits, otherwise
   *  the OLDEST block pinned plus a contiguous NEWEST-first suffix, rendered
   *  oldest-first; the MIDDLE blocks drop. `truncated` when any block was excluded or
   *  head-sliced (a sliced block also says so inline). */
  own: { text: string; truncated: boolean };
  /** Own comments dropped entirely for budget. */
  ownDropped: boolean;
  /** Budgeted (head-truncated) third-party AI-reviewer findings. */
  external: { text: string; truncated: boolean };
  /** External findings dropped entirely for budget. */
  externalDropped: boolean;
}

/**
 * Allocates the soft context (delta + prior findings + our own PR comments + external
 * findings) into whatever budget the authoritative diff leaves, against one shared
 * ceiling. Order is enforced — diff, then delta, then our prior findings, then our own
 * comments, then third-party findings — so under pressure external drops first and the
 * diff never does. `diffLen` is the already-budgeted main diff's length.
 *
 * Our own comments fit RECENCY-FIRST with the oldest block PINNED, not head-first: the
 * newest follow-ups are the highest signal, the opening brief is held on to, and the
 * middle drops (the reverse of prior/external, which head-slice a single blob).
 */
export function budgetReviewExtras(input: {
  diffLen: number;
  deltaText?: string;
  priorText?: string;
  ownItems?: string[];
  externalText?: string;
  /** Per-model scaled caps. Absent ⇒ the module constants. */
  profile?: ContextBudgetProfile;
}): ReviewExtras {
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

  // THE enforcement point for the head-sliced sections, and so where the disclosure
  // guarantee lives: the section formatters can only size their shares approximately
  // (their floors can lift a body back over budget, and `remaining` is unknowable at
  // format time), so whatever arrives oversized is cut HERE, with `capBody` disclosing it.
  const fit = (text: string | undefined, max: number) => {
    if (!text?.trim())
      return { result: { text: "", truncated: false }, dropped: false };
    const cap = Math.min(remaining, max);
    if (cap <= 0)
      return { result: { text: "", truncated: false }, dropped: true };
    const result =
      text.length <= cap
        ? { text, truncated: false }
        : { text: capBody(text, cap), truncated: true };
    remaining -= result.text.length;
    return { result, dropped: false };
  };

  // Our own comments fit recency-first with the OLDEST block PINNED, rendered in
  // original oldest-first order. A pure newest-first suffix dropped `present[0]` first,
  // but that block is typically the opening brief — context nothing later supersedes —
  // so under pressure we keep it (up to a reserve) and let the MIDDLE blocks drop.
  const fitOwn = (items: string[] | undefined, max: number) => {
    const present = items?.filter((t) => t.trim()) ?? [];
    if (present.length === 0)
      return { result: { text: "", truncated: false }, dropped: false };
    const cap = Math.min(remaining, max);
    if (cap <= 0)
      return { result: { text: "", truncated: false }, dropped: true };

    // A single block (also the distilled-ledger case) has no middle and no pin to
    // apply: head-keep it alone.
    if (present.length === 1) {
      const only = present[0];
      if (only.length <= cap) {
        remaining -= only.length;
        return { result: { text: only, truncated: false }, dropped: false };
      }
      // `OWN_BLOCK_INDENT`: a per-comment block renders its body under a two-space
      // continuation indent, so the re-cut note must sit inside the list item. The
      // other single-block input, a distilled ledger, arrives bare — the indent is
      // simply inert there, not wrong.
      const { text: body, omitted } = stripTruncationNote(only);
      const text = capBody(body, cap, omitted, OWN_BLOCK_INDENT);
      remaining -= text.length;
      return { result: { text, truncated: true }, dropped: false };
    }

    // Everything fits — take it whole.
    if (newestSuffixCount(present, cap) === present.length) {
      const text = present.join("\n\n");
      remaining -= text.length;
      return { result: { text, truncated: false }, dropped: false };
    }

    // Pressure regime. The pin gets at most ~a third of the cap: the opening
    // comment records design intent nothing later supersedes, but the newest
    // follow-ups carry the live dispositions (refutations, "fixed in `<sha>`"), so
    // the pin must never crowd out the majority of the recency signal.
    const reserve = Math.min(present[0].length, Math.floor(cap * 0.35));
    let pinned: string;
    if (present[0].length <= reserve) {
      pinned = present[0];
    } else {
      const { text: body, omitted } = stripTruncationNote(present[0]);
      pinned = capBody(body, reserve, omitted, OWN_BLOCK_INDENT);
    }
    // Degenerate cap (a handful of characters): rather than render an empty pin,
    // fall back to the oldest block head-sliced to the whole cap.
    if (!pinned) pinned = safeSlice(present[0], cap);

    const rest = present.slice(1);
    // `- 2` = the "\n\n" joiner between the pin and the suffix.
    const restCap = cap - pinned.length - 2;
    const keptCount = restCap > 0 ? newestSuffixCount(rest, restCap) : 0;
    let selected = keptCount > 0 ? rest.slice(rest.length - keptCount) : [];
    if (keptCount === 0 && restCap > 0) {
      // Not even the newest follow-up fits WHOLE, but the leftover is real: head-slice
      // it in rather than render the pin alone — dropping it would throw away every
      // live disposition to keep an opener that fit many times over. `capBody` can
      // still come back empty at a tiny leftover, hence the guard.
      const newest = rest[rest.length - 1];
      const { text: body, omitted } = stripTruncationNote(newest);
      const sliced = capBody(body, restCap, omitted, OWN_BLOCK_INDENT);
      if (sliced) selected = [sliced];
    }
    const text = [pinned, ...selected].join("\n\n");
    // A degenerate cap can slice BOTH parts away. An empty-but-present section renders
    // neither the section nor the truncation marker, so the model reads "nothing on
    // record" — report it as dropped, which prompt.ts renders as an explicit marker.
    if (!text) return { result: { text: "", truncated: false }, dropped: true };
    remaining -= text.length;
    // Always truncated here: we only reach this branch because the full set
    // didn't fit the cap, so something was sliced or dropped by definition.
    return { result: { text, truncated: true }, dropped: false };
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
