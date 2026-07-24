// Thin, typed fetchers over the desktop's LAN server. These call the SAME routes
// the desktop's `src-tauri/src/lan/routes/*` mount and return the SAME serde
// camelCase types the desktop declares — imported TYPE-ONLY via the `@` alias
// (never the desktop's `api.ts`/`queries.ts`, which are Tauri-command-shaped).
//
// Auth is implicit: after pairing, the server set an HttpOnly `gd_lan` cookie the
// browser attaches to every same-origin request automatically. So there is NO
// Authorization header anywhere here — `credentials: "same-origin"` is the whole
// auth story. A 401 means the cookie is missing/revoked (→ re-pair).

import type {
  PrDetails,
  PrInfo,
  PrTimelineEvent,
  RepoStatus,
  ReviewThreadOut,
} from "@/lib/git/types";
import type { RunDetail, WorkflowRun } from "@/lib/github/actions";

/** A failed API call. `status` is the HTTP status (0 = the server was
 *  unreachable — DNS/connection refused/offline). `kind`/`message` mirror the
 *  server's `{ kind, message }` JSON body when it sent one. */
export class ApiError extends Error {
  readonly status: number;
  readonly kind?: string;
  /** Seconds to wait before retrying, from a `Retry-After` header (429 only);
   *  `null` when the header was absent or unparseable. */
  readonly retryAfter: number | null;
  constructor(
    status: number,
    message: string,
    kind?: string,
    retryAfter: number | null = null,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.kind = kind;
    this.retryAfter = retryAfter;
  }
  /** The server has no repository shared (`409 noActiveRepo`). */
  get isNoActiveRepo(): boolean {
    return this.status === 409;
  }
  /** Not paired, or the device token was revoked (`401`). Route to `#pair`. */
  get isUnauthorized(): boolean {
    return this.status === 401;
  }
  /** The server couldn't be reached at all (offline / wrong network). */
  get isUnreachable(): boolean {
    return this.status === 0;
  }
  /** Rate-limited by the pairing/auth throttle (`429`). */
  get isRateLimited(): boolean {
    return this.status === 429;
  }
  /**
   * There is no active pairing offer on the desktop — either it hasn't clicked
   * "Pair a device" yet, or the offer expired. NOT an error: the Pair screen
   * shows a calm "waiting for your desktop" state and gently re-checks.
   *
   * Grounded in the server shape: `auth.rs`'s `pairing_inactive()` returns
   * `403 Forbidden` with `{ kind: "pairingInactive", … }` from both the
   * challenge and submit routes (a `None` session AND an expired one collapse to
   * the same response). Match ONLY the distinctive `kind` — the other 403s
   * (`host_guard`'s bad-host / bad-origin, plain-text body, no `kind`) are real
   * connectivity/security problems that must NOT read as "waiting for desktop".
   */
  get isPairingInactive(): boolean {
    return this.kind === "pairingInactive";
  }
  /**
   * The repo has no `origin` remote (a local-only repo the desktop shows
   * "Publish repository…" for) — so PRs/CI, which live on a forge, can't be
   * fetched. NOT a failure to report as an error; the screens render a calm
   * teaching state instead.
   *
   * The server now mints a dedicated `400 { kind: "noRemote", … }` for this case,
   * so detection here is an exact `kind` match — no message-substring heuristic
   * on this side. (This getter previously sniffed the raw git stderr of a shared
   * `kind: "git"` error.) The wording-fragility didn't vanish, it moved: the LAN
   * boundary (`lan/auth.rs`) still substring-matches git's "no such remote" to
   * mint the kind — but now in exactly one server-side place, and a missed match
   * degrades to the generic error-with-retry state, not a crash.
   */
  get isNoRemote(): boolean {
    return this.kind === "noRemote";
  }
  /**
   * The `{repoId}` in a scoped route is not (or no longer) a shared repository —
   * the server mints `404 { kind: "noSuchRepo", … }` for an unknown OR unshared
   * id (deliberately indistinguishable). On a screen this means "the repo you had
   * selected stopped being shared from the desktop"; the device is still paired,
   * so the calm teaching state offers "Choose repository" (NEVER a bounce to
   * `#pair`). Both the status AND the 404-kind must match so an unrelated 404
   * (e.g. a PR number that doesn't exist) never reads as a gone repo.
   */
  get isNoSuchRepo(): boolean {
    return this.status === 404 && this.kind === "noSuchRepo";
  }
  /**
   * This repo's HOST can't serve Discussions — a non-GitHub repo (GitLab/Bitbucket
   * have no Discussions equivalent). The server mints
   * `400 { kind: "discussionsUnavailable", … }` for exactly that case; a GitHub
   * repo with the feature merely turned OFF is NOT an error — it answers 200 with
   * `DiscussionMeta.hasDiscussionsEnabled: false` (a separate teaching state). The
   * screen renders a calm teaching state for this kind (NOT the generic error, and
   * no retry — a retry can't change the host). Both the status AND the kind must
   * match so an unrelated 400 never reads as "no discussions here".
   *
   * The kind string `discussionsUnavailable` is a VERBATIM cross-layer contract
   * with the Rust LAN server (`src-tauri/src/lan/routes/forge.rs` mints it) — keep
   * the two spellings in lockstep.
   */
  get isDiscussionsUnavailable(): boolean {
    return this.status === 400 && this.kind === "discussionsUnavailable";
  }
}

interface ErrorBody {
  kind?: unknown;
  message?: unknown;
}

/** GET a JSON API route, mapping any non-2xx (or a network failure) to an
 *  {@link ApiError}. */
async function getJson<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
  } catch {
    // A thrown fetch = the server is unreachable (offline, refused, DNS). Model
    // it as status 0 so hooks can show the "can't reach your desktop" banner.
    throw new ApiError(0, "Could not reach your desktop.");
  }
  if (!res.ok) {
    throw await toApiError(res);
  }
  return (await res.json()) as T;
}

/** Build an {@link ApiError} from a non-2xx response, reading the server's
 *  `{ kind, message }` body when present. */
async function toApiError(res: Response): Promise<ApiError> {
  let kind: string | undefined;
  let message: string | undefined;
  try {
    const body = (await res.json()) as ErrorBody;
    if (typeof body.kind === "string") kind = body.kind;
    if (typeof body.message === "string") message = body.message;
  } catch {
    // Non-JSON error body — fall back to the status text below.
  }
  const retryHeader = res.headers.get("Retry-After");
  const retryAfter =
    retryHeader && /^\d+$/.test(retryHeader) ? Number(retryHeader) : null;
  return new ApiError(
    res.status,
    message ?? res.statusText ?? "Request failed",
    kind,
    retryAfter,
  );
}

// ── Repo picker ───────────────────────────────────────────────────────────────

/** One shared repository the desktop is exposing over the LAN. `id` is 16
 *  lowercase hex chars; `active` marks the one currently open on the desktop. */
export interface RepoSummary {
  id: string;
  name: string;
  active: boolean;
}

/** The `/api/repos` envelope: the shared-repos list plus the desktop's "Hide AI
 *  features" preference. `hideAi` mirrors the desktop setting — when true the
 *  companion hides its AI surfaces (the Agents tab + agent-watch screen) to match.
 *  It rides this endpoint (rather than a dedicated one) because the companion
 *  already polls it, so a desktop toggle converges here within one poll. */
export interface ReposResponse {
  repos: RepoSummary[];
  hideAi: boolean;
}

/** The repositories shared from the desktop (plus the `hideAi` preference), as an
 *  envelope. Bearer-authed, NOT repo-scoped (no resolver) — `repos` may hold 0, 1,
 *  or N entries. Order is unspecified; callers sort. */
export const fetchRepos = () => getJson<ReposResponse>("/api/repos");

// ── Read routes (repo-scoped) ─────────────────────────────────────────────────
// Every data fetcher is scoped to a `repoId` (slice 4): the path is
// `/api/repos/{repoId}/…` and an unknown/unshared id 404s with `noSuchRepo`. The
// legacy alias routes (`/api/repo/…`, `/api/forge/…`) still exist server-side but
// the companion no longer uses them for data.

/** Base for a repo's scoped routes. The id is already grammar-validated by the
 *  router before it reaches here, but encode it anyway (defense in depth). */
const scope = (repoId: string) => `/api/repos/${encodeURIComponent(repoId)}`;

// ── Slice-6 read shapes (Changes · History · Branches · Issues) ───────────────
// These mirror the desktop's serde camelCase types EXACTLY (verified against the
// Rust handlers). They're declared HERE — not imported from `@/lib/git/types` — on
// purpose: the desktop's git types.ts carries far more than the LAN routes return,
// and a few (IssueComment, ForgeUserRef, IssueLabel) are re-named companion-side to
// read naturally on this surface. The RepoSummary idiom (own local interfaces).

/** One file's line-count summary in a diff (`StagedDiff.files[]`). */
export interface DiffStatEntry {
  path: string;
  added: number;
  deleted: number;
  isBinary: boolean;
}

/** The working-tree diff (staged ∪ unstaged), with a per-file stat list. `text` is
 *  the unified diff, `truncated` when it hit the server's 1MB cap; `excludedFiles`
 *  counts files hidden from the diff by ignore patterns. */
export interface StagedDiff {
  text: string;
  truncated: boolean;
  files: DiffStatEntry[];
  excludedFiles: number;
}

/** A single file's diff (`diff/file`). `text` is the unified diff for one path. */
export interface FileDiff {
  filePath: string;
  isBinary: boolean;
  isTruncated: boolean;
  text: string;
}

/** One local branch, for the Branches list. */
export interface Branch {
  name: string;
  isCurrent: boolean;
  upstream: string | null;
  lastCommitDate: string;
  archived: boolean;
  upstreamAhead: number;
  upstreamBehind: number;
  upstreamGone: boolean;
  upstreamRemote: string | null;
}

/** One commit in the history log. `tags` are refs pointing at it; `isMerge` marks a
 *  multi-parent commit. */
export interface CommitSummary {
  hash: string;
  subject: string;
  author: string;
  authorEmail: string;
  date: string;
  tags: string[];
  isMerge: boolean;
}

/** Full details for one commit (subject + full body). */
export interface CommitDetails {
  hash: string;
  subject: string;
  body: string;
  author: string;
  authorEmail: string;
  date: string;
}

/** One issue in the Issues list. `state` is "OPEN"/"CLOSED"; `author` is null for a
 *  ghost author; `labels` carries just the names for the list chips. */
export interface IssueInfo {
  number: number;
  url: string;
  title: string;
  state: string;
  createdAt: string;
  updatedAt: string;
  author: { login: string } | null;
  labels: { name: string }[];
}

/** A neutral user reference (assignees) — carries an avatar the provider supplies
 *  (GitLab) or the frontend derives from the login (GitHub). */
export interface ForgeUserRef {
  id: string;
  label: string;
  avatarUrl: string;
  isBot: boolean;
}

/** One issue conversation comment. The server names this `PrThreadOut` (shared with
 *  PRs); it's re-named `IssueComment` companion-side to read naturally on the Issues
 *  surface. `state` is empty for a plain comment. */
export interface IssueComment {
  author: string;
  authorAvatarUrl: string;
  state: string;
  body: string;
  date: string;
  id: string;
  url: string;
  viewerDidAuthor: boolean;
  isMinimized: boolean;
  minimizedReason: string;
  reviewId: string;
}

/** One issue label (the server's `RepoLabel`). `color` is hex without the leading
 *  '#', as GitHub returns it; `description` is absent/null when the source has none. */
export interface IssueLabel {
  id: string;
  name: string;
  color: string;
  description?: string | null;
}

/** Full details for one issue's read view: body, assignees, labels, and the
 *  conversation comments. Mirrors the desktop's `IssueDetails` exactly. */
export interface IssueDetails {
  id: string;
  number: number;
  title: string;
  body: string;
  author: string;
  authorAvatarUrl: string;
  state: string;
  createdAt: string;
  url: string;
  assignees: ForgeUserRef[];
  milestone: { number: number; title: string } | null;
  issueType: { id: string; name: string; color: string } | null;
  isPinned: boolean;
  locked: boolean;
  activeLockReason: string | null;
  confidential: boolean;
  dueDate: string | null;
  comments: IssueComment[];
  labels: IssueLabel[];
}

export const fetchStatus = (repoId: string) =>
  getJson<RepoStatus>(`${scope(repoId)}/status`);

export const fetchPrs = (repoId: string, state = "open", limit = 30) =>
  getJson<PrInfo[]>(
    `${scope(repoId)}/prs?state=${encodeURIComponent(state)}&limit=${limit}`,
  );

export const fetchPr = (repoId: string, number: number) =>
  getJson<PrDetails>(`${scope(repoId)}/prs/${number}`);

export const fetchCiRuns = (repoId: string, limit = 20) =>
  getJson<WorkflowRun[]>(`${scope(repoId)}/ci/runs?limit=${limit}`);

export const fetchCiRun = (repoId: string, id: number) =>
  getJson<RunDetail>(`${scope(repoId)}/ci/runs/${id}`);

/** A PR's activity timeline (force-pushes, label changes, review requests, state
 *  changes, approvals). Same neutral shape the desktop's `forgePrTimeline` returns. */
export const fetchPrTimeline = (repoId: string, number: number) =>
  getJson<PrTimelineEvent[]>(`${scope(repoId)}/prs/${number}/timeline`);

/** A PR's file:line-anchored review threads with their comment chains. Same
 *  neutral shape the desktop's `forgePrReviewThreads` returns. */
export const fetchPrThreads = (repoId: string, number: number) =>
  getJson<ReviewThreadOut[]>(`${scope(repoId)}/prs/${number}/threads`);

// ── Slice-6 read fetchers (Changes · History · Branches · Issues) ─────────────

/** The repo's local branches (`branches`). */
export const fetchBranches = (repoId: string) =>
  getJson<Branch[]>(`${scope(repoId)}/branches`);

/** A page of the commit history (`log?limit&skip`). Named `fetchLog` to mirror the
 *  route (not `fetchHistory`). */
export const fetchLog = (repoId: string, limit = 50, skip = 0) =>
  getJson<CommitSummary[]>(`${scope(repoId)}/log?limit=${limit}&skip=${skip}`);

/** One commit's details (`commits/{hash}`). */
export const fetchCommit = (repoId: string, hash: string) =>
  getJson<CommitDetails>(
    `${scope(repoId)}/commits/${encodeURIComponent(hash)}`,
  );

/** One commit's unified diff (`commits/{hash}/diff`). No `maxBytes` param — the
 *  server applies its default 1MB cap and sets `truncated` when it's hit. */
export const fetchCommitDiff = (repoId: string, hash: string) =>
  getJson<StagedDiff>(
    `${scope(repoId)}/commits/${encodeURIComponent(hash)}/diff`,
  );

/** The working-tree diff (`diff/working`) — staged ∪ unstaged, with per-file stats. */
export const fetchWorkingDiff = (repoId: string) =>
  getJson<StagedDiff>(`${scope(repoId)}/diff/working`);

/** One file's diff (`diff/file?path&staged&untracked`). `staged` reads the index
 *  side; `untracked` diffs an on-disk file with `--no-index`. The path is
 *  `encodeURIComponent`-encoded into the query string (the router already decoded it
 *  from the hash). */
export const fetchFileDiff = (
  repoId: string,
  path: string,
  opts: { staged?: boolean; untracked?: boolean },
) =>
  getJson<FileDiff>(
    `${scope(repoId)}/diff/file?path=${encodeURIComponent(path)}&staged=${
      opts.staged ?? false
    }&untracked=${opts.untracked ?? false}`,
  );

/** The repo's issues (`issues?state&limit`). `state` is "open" or "closed". Errors
 *  with a typed variant on a Bitbucket repo (issues unsupported) or a fork with
 *  issues disabled — the screen renders a teaching state for those. */
export const fetchIssues = (repoId: string, state = "open", limit = 30) =>
  getJson<IssueInfo[]>(
    `${scope(repoId)}/issues?state=${encodeURIComponent(state)}&limit=${limit}`,
  );

/** One issue's full read view (`issues/{number}`). */
export const fetchIssue = (repoId: string, number: number) =>
  getJson<IssueDetails>(`${scope(repoId)}/issues/${number}`);

// ── Companion-extras read shapes (Tags · Code TODOs · Discussions) ────────────
// These mirror the desktop's serde camelCase types EXACTLY (verified against the
// desktop Rust structs). Declared HERE (own local interfaces, like the slice-6
// shapes above) rather than imported from `@/lib/git/types`.

/** One tag ref for the Tags list (the desktop's `TagInfo`). `target` is the commit
 *  sha the tag points at; `date` is the tagger date (annotated) or commit date
 *  (lightweight); `annotated` distinguishes the two; `subject` is the annotation
 *  message subject (empty for a lightweight tag). */
export interface TagInfo {
  name: string;
  target: string;
  date: string;
  annotated: boolean;
  subject: string;
}

/** One hit from a code-TODO scan (the desktop's `TodoScanItem`). `path` is the
 *  repo-relative file, `line` the 1-based line number, `marker` the matched marker
 *  (e.g. "TODO"/"FIXME"), `text` the trailing comment text. */
export interface TodoScanItem {
  path: string;
  line: number;
  marker: string;
  text: string;
}

/** A code-TODO scan result (the desktop's `TodoScan`). `truncated` is true when the
 *  scan hit the server's max-hits cap and the list is a prefix. */
export interface TodoScan {
  items: TodoScanItem[];
  truncated: boolean;
}

/** One discussion category (the desktop's `DiscussionCategory`). `emoji` is the
 *  rendered category emoji; `isAnswerable` marks a Q&A category. */
export interface DiscussionCategory {
  id: string;
  name: string;
  emoji: string;
  isAnswerable: boolean;
}

/** The repo's discussions metadata (the desktop's `DiscussionMeta`): whether
 *  Discussions are enabled and the available categories. */
export interface DiscussionMeta {
  repoId: string;
  hasDiscussionsEnabled: boolean;
  categories: DiscussionCategory[];
}

/** One discussion label (the desktop's `DiscussionLabel`). `color` is hex without
 *  the leading '#', as GitHub returns it; `description` is null when the source has
 *  none. Distinct from {@link IssueLabel} (whose `description` is optional) — the
 *  discussion wire shape always carries the field. */
export interface DiscussionLabel {
  id: string;
  name: string;
  color: string;
  description: string | null;
}

/** One discussion in the Discussions list (the desktop's `DiscussionInfo`). */
export interface DiscussionInfo {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  isAnswered: boolean;
  closed: boolean;
  stateReason: string | null;
  categoryName: string;
  categoryEmoji: string;
  author: string;
  commentCount: number;
  upvoteCount: number;
  labels: DiscussionLabel[];
}

/** One reply under a discussion comment (the desktop's `DiscussionReply`). */
export interface DiscussionReply {
  id: string;
  author: string;
  body: string;
  date: string;
  url: string;
  viewerDidAuthor: boolean;
  isMinimized: boolean;
  minimizedReason: string;
}

/** One top-level discussion comment (the desktop's `DiscussionComment`) — a
 *  {@link DiscussionReply} plus upvotes, the answer flag, and its nested replies. */
export interface DiscussionComment extends DiscussionReply {
  upvoteCount: number;
  viewerHasUpvoted: boolean;
  isAnswer: boolean;
  replies: DiscussionReply[];
}

/** Full details for one discussion's read view (the desktop's `DiscussionDetails`):
 *  body, category, answer/lock/close state, labels, and the comment threads. */
export interface DiscussionDetails {
  id: string;
  number: number;
  title: string;
  body: string;
  url: string;
  author: string;
  createdAt: string;
  categoryName: string;
  categoryEmoji: string;
  isAnswerable: boolean;
  isAnswered: boolean;
  upvoteCount: number;
  viewerHasUpvoted: boolean;
  locked: boolean;
  activeLockReason: string | null;
  closed: boolean;
  stateReason: string | null;
  labels: DiscussionLabel[];
  comments: DiscussionComment[];
}

// ── Companion-extras read fetchers (Tags · Code TODOs · Discussions) ──────────

/** The repo's tags (`tags`), newest first (server-ordered). */
export const fetchTags = (repoId: string) =>
  getJson<TagInfo[]>(`${scope(repoId)}/tags`);

/** A code-TODO scan (`todos?markers&maxHits`). `markers` are comma-joined into the
 *  query; `maxHits` caps the result (server default when omitted). */
export const fetchTodoScan = (
  repoId: string,
  markers: string[],
  maxHits?: number,
) =>
  getJson<TodoScan>(
    `${scope(repoId)}/todos?markers=${encodeURIComponent(markers.join(","))}${
      maxHits != null ? `&maxHits=${maxHits}` : ""
    }`,
  );

/** The repo's discussions metadata (`discussions/meta`) — enablement + categories.
 *  Errors with a typed `discussionsUnavailable` variant on a non-GitHub repo. */
export const fetchDiscussionMeta = (repoId: string) =>
  getJson<DiscussionMeta>(`${scope(repoId)}/discussions/meta`);

/** The repo's discussions (`discussions?limit&category`). `category` filters by a
 *  category NODE ID (a `DiscussionCategory.id`, not its name — the server forwards
 *  it verbatim into the GraphQL category filter) when non-null; `limit` caps the
 *  page. */
export const fetchDiscussions = (
  repoId: string,
  category: string | null,
  limit: number,
) =>
  getJson<DiscussionInfo[]>(
    `${scope(repoId)}/discussions?limit=${limit}${
      category != null ? `&category=${encodeURIComponent(category)}` : ""
    }`,
  );

/** One discussion's full read view (`discussions/{number}`). */
export const fetchDiscussion = (repoId: string, number: number) =>
  getJson<DiscussionDetails>(`${scope(repoId)}/discussions/${number}`);

// ── Agent streams (live AI review / agent sessions) ───────────────────────────

/** One shareable agent stream — an AI PR review (`review`) or an agent session
 *  (`session`). `id` is a UUID-like STRING (never a number). `startedAt` is
 *  ISO-8601. The live event stream is at `/api/repos/{repoId}/reviews/{id}/stream`
 *  (SSE). */
export interface ReviewInfo {
  id: string;
  kind: "review" | "session";
  startedAt: string;
}

export const fetchReviews = (repoId: string) =>
  getJson<ReviewInfo[]>(`${scope(repoId)}/reviews`);

// ── Pairing ──────────────────────────────────────────────────────────────────

/** `POST /api/pair/challenge` → `{ challenge, salt }` (hex). Requires an active
 *  pairing offer on the desktop; 403 `pairingInactive` when expired/absent. */
interface Challenge {
  challenge: string;
  salt: string;
}

export async function pairChallenge(): Promise<Challenge> {
  return postJson<Challenge>("/api/pair/challenge", {});
}

/** `POST /api/pair` with `{ deviceName, proof }`. On success the server sets the
 *  `gd_lan` cookie and returns `{ deviceId, token, name, scope }`; the browser
 *  keeps the cookie, so the companion just needs to know it succeeded. */
export interface PairResult {
  deviceId: string;
  name: string;
  scope: string;
}

export async function pairSubmit(
  deviceName: string,
  proof: string,
): Promise<PairResult> {
  return postJson<PairResult>("/api/pair", { deviceName, proof });
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "Could not reach your desktop.");
  }
  if (!res.ok) {
    throw await toApiError(res);
  }
  return (await res.json()) as T;
}
