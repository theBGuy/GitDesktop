import type { ContextBudgetProfile } from "./context-budget";

export type AiProviderId =
  | "anthropic"
  | "openai"
  | "openai-compatible"
  | "openrouter"
  | "ollama"
  | "ollama-cloud"
  | "claude-cli"
  | "codex-cli"
  | "copilot-cli"
  | "opencode-cli";

export interface AiSettings {
  provider: AiProviderId;
  model: string;
  ollamaBaseUrl: string;
  /** Base URL for the `openai-compatible` provider (any OpenAI-compatible
   *  `/chat/completions` endpoint — set via a preset or typed). The host must be
   *  in the app's network allowlist (`capabilities/default.json`). */
  openaiCompatibleBaseUrl: string;
  /** Explicit path to the agent CLI binary (CLI providers only); empty/omitted
   *  means auto-detect on PATH and the known install locations. */
  cliPath?: string;
  /** Agentic review: let the review model explore — repo files and PR context
   *  via GitDesktop's read-only tools. CLI agents read the checked-out files and
   *  attach the MCP server; HTTP models get a native tool loop. Slower and
   *  pricier. (Field name unchanged — persisted.) */
  cliRepoAware?: boolean;
}

/** The hosting provider a generated artifact targets. Absent/`"github"` keeps the
 *  original GitHub wording byte-for-byte; the others swap the change-request noun +
 *  markdown flavor so a GitLab MR / Bitbucket PR prompt reads correctly. */
export type PromptProvider = "github" | "gitlab" | "bitbucket";

export interface AiStreamRequest {
  system: string;
  prompt: string;
  abortSignal?: AbortSignal;
  /** Repository the generation belongs to — required by the CLI agent providers
   *  (the subprocess's working directory); ignored by HTTP providers. */
  repoPath?: string;
}

export interface AiClient {
  /** Streams raw text chunks from the model. */
  stream: (req: AiStreamRequest) => AsyncIterable<string>;
  /** Cheap round-trip used by the Settings "Test connection" button. */
  testConnection: () => Promise<{ ok: true } | { ok: false; message: string }>;
}

export interface CommitPromptInput {
  diffText: string;
  diffTruncated: boolean;
  files: { path: string; added: number; deleted: number; isBinary: boolean }[];
  /** Changed files hidden from this context by the user's ignore patterns. */
  excludedFiles: number;
  recentSubjects: string[];
  repoInstructions: string | null;
  globalInstructions: string;
}

export interface PrPromptInput {
  diffText: string;
  diffTruncated: boolean;
  files: { path: string; added: number; deleted: number; isBinary: boolean }[];
  /** Subjects of the commits this PR would introduce (base..head). */
  commitSubjects: string[];
  baseBranch: string;
  headBranch: string;
  repoInstructions: string | null;
  globalInstructions: string;
  /** Author-provided "Notes for reviewers" — the deliberate calls behind the
   *  change. Reflected into the generated description (never pasted verbatim) so
   *  it captures the recorded decisions. Absent ⇒ the section is omitted. */
  reviewNotes?: string;
  /** The repo's existing labels, each with its stated purpose (description) when
   *  it has one. When non-empty, the model is asked to end its output with a
   *  `Labels:` line choosing ONLY from these; the parser drops anything not in
   *  this set (no invented labels). The description is shown so the model judges a
   *  label by what it's for, not a name-plausible match. Empty ⇒ no label line. */
  availableLabels: { name: string; description?: string | null }[];
  /** Real issues from the target repo's tracker the model MAY link (already
   *  validated to exist). When non-empty, the system prompt's issue-reference ban
   *  is swapped for a grounded rule: the model may end its output with
   *  `Closes:` / `Relates:` lines choosing ONLY from these numbers; the parser
   *  drops anything not in this set. Empty/absent ⇒ prompt unchanged, ban intact. */
  issueCandidates?: { number: number; title: string; state: string }[];
  /** Mention-only candidates from the repo's LINKED Jira project (Bitbucket
   *  repos — no native tracker). Mutually exclusive with issueCandidates by
   *  construction; when both are somehow non-empty, issueCandidates wins and
   *  these are ignored (mirrors the Rust precedence). Model may end with ONE
   *  `Relates:` line choosing ONLY these keys; never a Closes line. */
  jiraCandidates?: { key: string; summary: string; statusCategory: string }[];
  /** Target host — swaps the change-request noun + markdown flavor in the prompt.
   *  Absent/`"github"` keeps the original GitHub wording byte-for-byte. */
  provider?: PromptProvider;
}

export interface BranchNamePromptInput {
  diffText: string;
  diffTruncated: boolean;
  files: { path: string; added: number; deleted: number; isBinary: boolean }[];
  /** Untracked (new) file paths — no diff content, but the names guide naming. */
  untrackedPaths: string[];
  /** Changed files hidden from this context by the user's ignore patterns. */
  excludedFiles: number;
  /** Existing branch names, as a naming-convention / style reference. */
  recentBranches: string[];
  repoInstructions: string | null;
  globalInstructions: string;
}

export type ReviewMode = "general" | "security";

/** How the "changes since last review" delta relates to the prior review.
 *  `head-unchanged` is JS-only (the Rust command never returns it); the Rust
 *  `missing` reason is mapped to `indeterminate` before it reaches the prompt. */
export type ReviewDeltaState =
  | "ok"
  | "rewritten"
  | "indeterminate"
  | "head-unchanged";

export interface ReviewPromptInput {
  title: string;
  body: string;
  commitSubjects: string[];
  diffText: string;
  diffTruncated: boolean;
  files: { path: string; added: number; deleted: number; isBinary: boolean }[];
  /** Author-provided "Notes for reviewers" — the author's deliberate calls behind
   *  the change. Treated as author input like `body` (NOT soft bot context), so it
   *  is fed to both review modes and never subject to the extras budget. Absent ⇒
   *  the section is omitted; the prompt is byte-for-byte identical to before. */
  reviewNotes?: string;
  /** Prior review's raw finding markdown — soft, re-verifiable context. When
   *  absent, the prompt is byte-for-byte identical to a first-ever review. */
  priorFindings?: string;
  /** When the prior review ran (epoch ms) — for the section header. */
  priorReviewedAt?: number;
  /** Two-dot delta of what changed since the prior review (when computable). */
  deltaDiffText?: string;
  /** Whether `deltaDiffText` was already truncated upstream (Rust max_bytes). */
  deltaTruncated?: boolean;
  /** Why the delta is present or absent — frames the "Changes since" section. */
  deltaState?: ReviewDeltaState;
  /** Pre-formatted findings posted on the remote PR by third-party AI reviewers
   *  (GitHub Copilot, CodeRabbit, …) — soft, re-verifiable context like
   *  `priorFindings`. Absent for local PRs and when none were found. */
  externalFindings?: string;
  /** Distinct external reviewer display names — for the section header. */
  externalReviewers?: string[];
  /** Whether any external finding may be stale (made against an older commit). */
  externalStale?: boolean;
  /** One formatted block per comment attributed to GitDesktop on this PR — agent
   *  follow-ups (refutations / "fixed in `<sha>`" replies) and thread replies,
   *  oldest first — so the model resolves what it already covered instead of
   *  re-raising it. Our own posted AI review/audit bodies are excluded (redundant
   *  with `priorFindings`). Soft context like `priorFindings`; absent when none. */
  ownItems?: string[];
  /** True when `ownItems` is a single machine-distilled decision ledger instead of
   *  the raw per-comment blocks — the section couldn't render the whole record (the
   *  caps would drop whole comments outright, or trim away more than a quarter of
   *  the budget), so it was compressed rather than cut. Flips the own-section
   *  preamble to frame it as a compressed summary. */
  ownDistilled?: boolean;
  /** Target host — swaps the change-request noun + markdown flavor in the review
   *  system prompt. Absent/`"github"` keeps the original GitHub wording. */
  provider?: PromptProvider;
  /** Per-model scaled character budgets for this review's prompt. When absent,
   *  the module-constant defaults apply, so the prompt is byte-for-byte identical
   *  to before the profile support. Resolved via `resolveBudgetProfile`. */
  budgetProfile?: ContextBudgetProfile;
  /** Present only for CLI repo-aware runs — what the review agent can actually do,
   *  so the prompt frames truncation honestly instead of "coverage is partial". */
  agentic?: {
    /** The PR's files are checked out in the agent's working directory. */
    filesOnDisk: boolean;
    /** GitDesktop is attached as a read-only MCP server (`gitdesktop` tools). */
    mcpTools: boolean;
    /** HTTP provider with a native AI-SDK tool loop — same explore capability,
     *  no files on disk. */
    httpTools?: boolean;
    /** Forge PR number for the MCP PR tools — remote PRs only. */
    prNumber?: string;
  };
}
