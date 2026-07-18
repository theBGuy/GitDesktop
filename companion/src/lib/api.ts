// Thin, typed fetchers over the desktop's LAN server. These call the SAME routes
// the desktop's `src-tauri/src/lan/routes/*` mount and return the SAME serde
// camelCase types the desktop declares — imported TYPE-ONLY via the `@` alias
// (never the desktop's `api.ts`/`queries.ts`, which are Tauri-command-shaped).
//
// Auth is implicit: after pairing, the server set an HttpOnly `gd_lan` cookie the
// browser attaches to every same-origin request automatically. So there is NO
// Authorization header anywhere here — `credentials: "same-origin"` is the whole
// auth story. A 401 means the cookie is missing/revoked (→ re-pair).

import type { PrDetails, PrInfo, RepoStatus } from "@/lib/git/types";
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
   * the same response). Match the distinctive `kind` primarily; the 403 status
   * is a secondary signal (the only other 403s are `host_guard`'s bad-host /
   * bad-origin, which carry a plain-text body, so no `kind`).
   */
  get isPairingInactive(): boolean {
    return this.kind === "pairingInactive" || this.status === 403;
  }
  /**
   * The repo has no `origin` remote (a local-only repo the desktop shows
   * "Publish repository…" for) — so PRs/CI, which live on a forge, can't be
   * fetched. NOT a failure to report as an error; the screens render a calm
   * teaching state instead.
   *
   * The server surfaces this as `AppError::Git` (`kind: "git"`) whose message is
   * the raw git stderr — `error: No such remote 'origin'` (confirmed by running
   * `git remote get-url origin` on a remoteless repo). `kind: "git"` is shared by
   * every git failure, so it can't distinguish this case; a case-insensitive
   * substring on the message is the only signal. This is a DISPLAY-ONLY
   * heuristic: if git's wording ever changes and the match misses, the screen
   * simply falls back to the generic error-with-retry state — no correctness or
   * data risk, just a less-tailored message.
   */
  get isNoRemote(): boolean {
    return this.kind === "git" && /no such remote/i.test(this.message);
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

// ── Read routes ──────────────────────────────────────────────────────────────

export const fetchStatus = () => getJson<RepoStatus>("/api/repo/status");

export const fetchPrs = (state = "open", limit = 30) =>
  getJson<PrInfo[]>(
    `/api/forge/prs?state=${encodeURIComponent(state)}&limit=${limit}`,
  );

export const fetchPr = (number: number) =>
  getJson<PrDetails>(`/api/forge/prs/${number}`);

export const fetchCiRuns = (limit = 20) =>
  getJson<WorkflowRun[]>(`/api/forge/ci/runs?limit=${limit}`);

export const fetchCiRun = (id: number) =>
  getJson<RunDetail>(`/api/forge/ci/runs/${id}`);

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
