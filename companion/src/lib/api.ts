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
