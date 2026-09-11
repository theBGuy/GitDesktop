import {
  ArrowLeftIcon,
  ArrowSquareOutIcon,
  ArrowsClockwiseIcon,
  CircleDashedIcon,
  CircleNotchIcon,
  GitPullRequestIcon,
} from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { ListRowSkeletons } from "@/components/list-row-skeleton";
import { ProviderIcon } from "@/components/provider-icon";
import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { clipTitleFromText } from "@/lib/clip-title";
import { copyText } from "@/lib/clipboard";
import { suppressContextMenu } from "@/lib/context-menu";
import { forgePrHeadRef, repoOriginPath, validateRepo } from "@/lib/git/api";
import { normPath } from "@/lib/git/path";
import { useForgeMyWork, useMyWorkSources } from "@/lib/git/queries";
import {
  type ForgeProvider,
  type MyWorkItem,
  type PrHeadRef,
  providerLabel,
  type RepoInfo,
  type RepoOrigin,
} from "@/lib/git/types";
import { listUserWorktrees, type UserWorktree } from "@/lib/git/worktree";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { applyRepoLens } from "@/lib/repo-lens/queries";
import type { RecentRepo } from "@/lib/settings/api";
import { useSettings } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { errorMessage, isAppError } from "@/lib/tauri/invoke";
import { parseableDate } from "@/lib/time";
import { toastError } from "@/lib/toast";
import { cn } from "@/lib/utils";
import {
  filterMyWork,
  MY_WORK_LISTBOX_ID,
  type MyWorkTab,
  matchLocalRepos,
  mergeMyWorkPages,
  myWorkOptionId,
} from "./mywork-utils";

/** Stable empty default, so a settings read that hasn't landed doesn't hand a
 *  fresh array to every render. */
const NO_RECENTS: RecentRepo[] = [];

// Per-provider copy as Records rather than ternary chains, so adding a forge is
// one entry per surface and no sentence can silently keep another's wording.

const FETCH_NOTICE: Record<ForgeProvider, string> = {
  github: "Fetching from GitHub…",
  gitlab: "Fetching from GitLab…",
  bitbucket: "Fetching from Bitbucket…",
};

const FAILURE_NOTICE: Record<ForgeProvider, string> = {
  github:
    "GitHub couldn't be reached. Check that gh is installed and signed in.",
  gitlab: "GitLab couldn't be reached.",
  bitbucket: "Bitbucket couldn't be reached.",
};

const SIGN_IN_TITLE: Record<ForgeProvider, string> = {
  github: "GitHub CLI (gh) not found",
  gitlab: "GitLab CLI (glab) not found",
  bitbucket: "Bitbucket account not connected",
};

const SIGN_IN_BODY: Record<ForgeProvider, string> = {
  github:
    "Install the GitHub CLI (gh) and run gh auth login to see your pull requests and issues here.",
  gitlab:
    "Install the GitLab CLI (glab) and run glab auth login to see your merge requests and issues here.",
  bitbucket:
    "Add an Atlassian API token in Settings → Accounts to see your Bitbucket pull requests here.",
};

/** The failure kinds a sign-in fixes, so a lone broken provider can name the
 *  remedy instead of echoing an IPC message. Reached two ways: the sources
 *  probe reads local config, so a CLI uninstalled while its hosts file
 *  survives still enables the leg and fails here loudly; and a sign-out
 *  inside the probe's 5-minute window does the same. */
const SIGN_IN_KINDS = new Set([
  "ghNotFound",
  "glabNotFound",
  "bitbucketNotConfigured",
]);

/** The sources probe's own failure. Its command folds every provider probe to
 *  false internally, so reaching this means the IPC call itself didn't land. */
const SOURCES_NOTICE = "Couldn't check which forges are connected.";

/** Which forges answer account-wide. Bitbucket has no cross-repo search, so its
 *  leg is asked per opened checkout and must never ride a claim about every repo
 *  you're involved in. */
const ACCOUNT_WIDE: Record<ForgeProvider, boolean> = {
  github: true,
  gitlab: true,
  bitbucket: false,
};

/** The empty state's second sentence when exactly one forge is configured. */
const EMPTY_SCOPE: Record<ForgeProvider, string> = {
  github: "This searches every repo you're involved in, not just local ones.",
  gitlab:
    "This searches every project you're involved in, not just local ones.",
  bitbucket: "This searches the Bitbucket repositories you've opened here.",
};

/** Every provider id, as an exhaustive Record so widening `ForgeProvider` fails
 *  the build here rather than quietly narrowing the check below. */
const FORGE_PROVIDERS: Record<ForgeProvider, true> = {
  github: true,
  gitlab: true,
  bitbucket: true,
};

/** `RecentRepo.provider` is a stored string, so an id this build doesn't know
 *  fails over to the item's own provider rather than reaching the backend as a
 *  tag it can't deserialize — a rejection the open's deadline would swallow into
 *  a silent main-workspace landing. */
function asForgeProvider(value: string | undefined): ForgeProvider | null {
  return value !== undefined && Object.hasOwn(FORGE_PROVIDERS, value)
    ? (value as ForgeProvider)
    : null;
}

/** "A" / "A and B" — the configured set is at most three. */
const joinLabels = (labels: string[]) =>
  labels.length > 1
    ? `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`
    : labels[0];

/** What the configured legs actually cover, so an empty inbox never claims a
 *  reach it doesn't have. One forge speaks for itself; a mix names which part is
 *  account-wide and which is bounded by the checkouts you've opened. */
function scopeSentence(providers: ForgeProvider[]): string {
  if (providers.length === 1) return EMPTY_SCOPE[providers[0]];
  const wide = providers.filter((p) => ACCOUNT_WIDE[p]).map(providerLabel);
  const scoped = providers.filter((p) => !ACCOUNT_WIDE[p]).map(providerLabel);
  const parts: string[] = [];
  if (wide.length > 0) {
    parts.push(
      `${joinLabels(wide)} ${wide.length > 1 ? "cover" : "covers"} every repo you're involved in, not just local ones.`,
    );
  }
  if (scoped.length > 0) {
    parts.push(
      `${joinLabels(scoped)} ${scoped.length > 1 ? "cover" : "covers"} the repositories you've opened here.`,
    );
  }
  return parts.join(" ");
}

/** One provider's slice of the inbox: whether it is configured at all, and the
 *  query carrying its rows. */
type MyWorkLeg = {
  provider: ForgeProvider;
  enabled: boolean;
  query: ReturnType<typeof useForgeMyWork>;
};

/** Which provider a failure came from, or null for the sources probe itself. */
type LegError = { provider: ForgeProvider | null; error: unknown };

/** A leg has ANSWERED for its current key. Placeholder rows belong to the
 *  previous one — a recents change re-keys the Bitbucket leg — so they stay on
 *  screen without being an answer this screen may count or speak for. */
const hasAnswered = (leg: MyWorkLeg) =>
  leg.query.isSuccess && !leg.query.isPlaceholderData;

/** A leg has settled, either way. `isPending` can't stand in for this: a leg
 *  the sources probe left disabled stays pending forever. */
const settled = (leg: MyWorkLeg) => hasAnswered(leg) || leg.query.isError;

/**
 * What the error screen speaks for. The sources probe answers only when it left
 * nothing behind to ask: its data survives a failed refetch, so legs that are
 * still configured have their own answers and those are the truth — the probe's
 * failure drops to a notice rather than replacing a forge's real reply. Legs
 * speak only once every one of them has failed.
 */
function failedLegs(sourcesError: unknown, legs: MyWorkLeg[]): LegError[] {
  if (legs.length === 0) {
    return sourcesError === null
      ? []
      : [{ provider: null, error: sourcesError }];
  }
  if (!legs.every((l) => l.query.isError)) return [];
  return legs.map((l) => ({ provider: l.provider, error: l.query.error }));
}

/** Stable empty defaults, so a suppressed notice, error list or unpainted row
 *  set doesn't hand a fresh array to every render. */
const NO_LEGS: MyWorkLeg[] = [];
const NO_ERRORS: LegError[] = [];
const NO_ITEMS: MyWorkItem[] = [];

/** Total budget for resolving where to open a PR, spanning EVERY awaited leg of
 *  the resolution — the worktree list, the head-ref read, and the validate of
 *  whatever checkout they point at. Opening must stay a keypress-fast action,
 *  and any one leg can block for seconds (git's prune, a stalled network mount).
 *  Legs that consume the whole budget leave nothing for the ones after them,
 *  which fall back to the main checkout — the safe direction. */
const WORKTREE_RESOLVE_BUDGET_MS = 1500;

/** Grace period before a resolving open lights its row, so a resolution that
 *  answers quickly never flashes a spinner. */
const PENDING_AFFORDANCE_MS = 300;

/** How long the skeleton holds after the FIRST forge answers, waiting for the
 *  rest. Owner-ratified trade: one clean paint beats fastest-first rows — a
 *  handful of rows landing and then reshuffling as a slower leg arrives reads
 *  worse than a brief wait. Sized to cover a cold `gh search` pair (measured
 *  2-4s), the slowest common leg; a forge slower than this still paints late
 *  under its "Fetching from…" notice. */
const FIRST_PAINT_GRACE_MS = 3500;

/** Open generation. Module-scoped because MyWorkScreen unmounts on every view
 *  change: against a component ref, a continuation from a previous mount would
 *  compare with a fresh counter, pass its own supersede check, and navigate the
 *  app by itself. Read only from handlers and continuations, never in render. */
let openGen = 0;

/** Resolves `work` against what's left of `deadline`, answering `fallback` on
 *  both rejection and expiry — the caller treats slow and broken alike. */
function withDeadline<T>(
  work: Promise<T>,
  deadline: number,
  fallback: T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work.catch(() => fallback),
    new Promise<T>((resolve) => {
      timer = setTimeout(
        () => resolve(fallback),
        Math.max(0, deadline - Date.now()),
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * A checkout's navigation target, or null when it can't be validated in time.
 * `root` rather than the caller's path: git prints worktree paths with forward
 * slashes while validate_repo answers the canonical spelling, and every
 * repo-identity consumer (query keys, per-repo stores, the session lists'
 * `s.repoPath === repoPath` filters) compares that form as a plain string — two
 * spellings of one checkout would read as two different repos.
 */
async function resolveTarget(
  path: string,
  deadline: number,
): Promise<{ path: string; name: string } | null> {
  // A spent budget would race git against a zero-length timeout and discard the
  // result — don't spawn the process at all.
  if (Date.now() >= deadline) return null;
  const info = await withDeadline<RepoInfo | null>(
    validateRepo(path),
    deadline,
    null,
  );
  return info ? { path: info.root, name: info.name } : null;
}

/**
 * Whether a matched checkout's STORED classification can support opening this
 * row. Repo detection answers from glab's SAVED hosts, while the inbox
 * enumerates account hosts as well — a token authenticates glab with no saved
 * host at all — so a self-managed host known only by token classifies its clones
 * as GitHub while its rows arrive as GitLab, and landing there would resolve the
 * wrong integration.
 *
 * This is the cheap half of a two-stage gate, and it only drops KNOWN
 * disagreement: it runs at render time with no IPC, so an unclassified checkout
 * (the same token-only host, which the backfill can never tag) has to pass here.
 * `originMatches` settles those against the backend's own live verdict.
 */
function providerAgrees(recent: RecentRepo, item: MyWorkItem): boolean {
  const stored = asForgeProvider(recent.provider);
  return stored === null || stored === item.provider;
}

/**
 * The checkouts an open may land on: key-matched AND classified compatibly.
 * `openItem` resolves from this list and the row affordances read it, so a row
 * can never advertise a local action the open refuses over a provider — that
 * disagreement is knowable at render time, from fields already in memory.
 * The ORIGIN proof is deliberately not part of it: it costs a git read per
 * candidate, so it stays an open-time check whose browser fallback remains the
 * recorded optimistic-display trade.
 */
function openableMatches(
  item: MyWorkItem,
  recents: readonly RecentRepo[],
): RecentRepo[] {
  return matchLocalRepos(item, recents).filter((r) => providerAgrees(r, item));
}

/**
 * `openableMatches` reduced to its yes/no, for the display sites — which ask
 * once per row per render and only ever read the answer, so this stops at the
 * first hit rather than materializing the filtered list. It reads the same
 * `matchLocalRepos` + `providerAgrees` pair, with no second copy of either rule,
 * so a row's affordance can't come to disagree with the open's candidate set.
 */
function hasOpenableMatch(
  item: MyWorkItem,
  recents: readonly RecentRepo[],
): boolean {
  return matchLocalRepos(item, recents).some((r) => providerAgrees(r, item));
}

/** The item's own authority: `URL.host` is the hostname plus any port the scheme
 *  doesn't default (`:443` drops on https, `:8443` stays), lowercased as it
 *  parses — the spelling the origin side answers with. Null when it won't parse. */
function itemAuthority(item: MyWorkItem): string | null {
  try {
    return new URL(item.url).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Whether `repoPath`'s origin really is this item's repository AND would resolve
 * this item's integration, read inside the caller's deadline.
 *
 * EVERY axis must match. Equal namespaces on two hosts are different projects;
 * equal hostnames on two ports are different instances; and the match key's host
 * is a stored value that goes stale the moment a remote is re-pointed — only the
 * origin's own answer settles any of it. Host and authority are deliberately
 * BOTH compared even though authority subsumes host in practice: should the two
 * derivations ever drift apart, requiring both turns that drift into a browser
 * open rather than a wrong one.
 *
 * `provider` is the axis identity alone cannot supply: a checkout on a host only
 * a glab TOKEN knows is the right repository, yet detection can't recognise it
 * and its landing would resolve GitHub's resilient default. Every row reaches
 * here, so this reads "the checkout must route to the forge this row came from"
 * — the live verdict `providerAgrees` can't see.
 *
 * Every unknown — a slow or failed read, a checkout with no origin, an
 * unparseable row URL, any field empty — answers false: an identity that can't
 * be proven must not become a navigation into somebody else's project.
 */
async function originMatches(
  item: MyWorkItem,
  repoPath: string,
  deadline: number,
): Promise<boolean> {
  const origin = await withDeadline<RepoOrigin | null>(
    repoOriginPath(repoPath),
    deadline,
    null,
  );
  const authority = itemAuthority(item);
  if (
    origin === null ||
    authority === null ||
    origin.host === "" ||
    origin.authority === "" ||
    origin.path === "" ||
    origin.provider === ""
  ) {
    return false;
  }
  return (
    origin.path.toLowerCase() === item.repoFullName.toLowerCase() &&
    origin.host.toLowerCase() === item.host.toLowerCase() &&
    origin.authority.toLowerCase() === authority &&
    origin.provider === item.provider
  );
}

/**
 * The first candidate whose origin really is this item's repository, else null.
 * Both clones of an ambiguous key can be in recents, so a single failed proof
 * says nothing about the rest. Sequential and bounded: candidates number a
 * handful at most, and an expiry mid-loop simply stops proving — the caller
 * treats that like any other unproven match.
 */
async function provenCandidate(
  item: MyWorkItem,
  candidates: readonly RecentRepo[],
  deadline: number,
): Promise<RecentRepo | null> {
  for (const candidate of candidates) {
    // A spent budget would race git against a zero-length timeout and discard
    // the result — stop rather than spawn one per remaining candidate.
    if (Date.now() >= deadline) return null;
    if (await originMatches(item, candidate.path, deadline)) return candidate;
  }
  return null;
}

/**
 * The repo's main worktree when `repoPath` is itself a linked one, else null.
 * A worktree opened through the folder picker lands in recents like any other
 * checkout, so a matched row can't be assumed to be the main workspace.
 */
function mainWorktreeOf(
  worktrees: UserWorktree[],
  repoPath: string,
): string | null {
  const main = worktrees.find((w) => w.isMain);
  // normPath for comparison only — git spells worktree paths with forward
  // slashes where validate_repo hands back Windows separators.
  if (!main || normPath(main.path) === normPath(repoPath)) return null;
  return main.path;
}

/**
 * The worktree whose checked-out branch is provably this PR's head, else null.
 * Every unknown — a slow or failed head-ref read, an unproven head, no branch
 * match — is a null, and the caller's deadline bounds the read. Candidates are
 * not filtered against `repoPath`: a head branch checked out in the matched
 * checkout itself is still the proven answer, and returning it is what keeps
 * the main-workspace preference from pulling the user off their own branch.
 */
async function branchWorktreeOf(
  item: MyWorkItem,
  worktrees: UserWorktree[],
  repoPath: string,
  provider: ForgeProvider,
  deadline: number,
): Promise<string | null> {
  const candidates = worktrees.filter((w) => w.branch !== "");
  if (candidates.length === 0) return null;
  // A spent budget would race the forge CLI against a zero-length timeout and
  // discard the result — don't spawn the process at all.
  if (Date.now() >= deadline) return null;
  const head = await withDeadline<PrHeadRef | null>(
    forgePrHeadRef(provider, repoPath, item.number),
    deadline,
    null,
  );
  // A fork PR's head branch lives in a different repository, where that branch
  // name routinely also exists locally — only a head slug matching this item's
  // repo proves a local branch IS the PR's, so an empty or foreign slug falls
  // back to whatever the caller had chosen.
  if (
    !head ||
    head.headRefName === "" ||
    head.headRepoFullName.toLowerCase() !== item.repoFullName.toLowerCase()
  ) {
    return null;
  }
  // Exact compare: git branch names are case-sensitive.
  return candidates.find((w) => w.branch === head.headRefName)?.path ?? null;
}

/** Inset from the row's leading edge for a keyboard-opened menu's anchor, so the
 *  popup hangs beside the row rather than off the viewport edge. */
const MENU_KEY_ANCHOR_INSET_PX = 12;

/**
 * Opens a row's context menu from the keyboard.
 *
 * A real `contextmenu` event on the row is the only route: Base UI takes the
 * popup's anchor solely from such an event's coordinates (its trigger's handler
 * is what calls `setAnchor`, and the public actions ref exposes only
 * close/unmount), and the list's own capture handler reads the row out of the
 * event target. Dispatching one drives both, exactly as a right-click does.
 */
function openRowContextMenu(url: string): void {
  const row = document.getElementById(myWorkOptionId(url));
  if (!row) return;
  const rect = row.getBoundingClientRect();
  row.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: Math.round(rect.left + MENU_KEY_ANCHOR_INSET_PX),
      clientY: Math.round(rect.top + rect.height / 2),
    }),
  );
}

/**
 * The cross-repo work inbox — every open pull request and issue involving you on
 * GitHub, GitLab and Bitbucket, newest first, without switching repositories to
 * find them. Each forge loads on its own, so a provider you aren't signed in to
 * (or one that is down) never decides what the others can show.
 * Read-only: Enter (or a click) navigates, to the repo when it's cloned locally
 * and to the browser when it isn't. Palette-reachable and launched from the
 * Welcome screen; Back / Esc return to the previous view.
 */
export function MyWorkScreen() {
  const closeMyWork = useUiStore((s) => s.closeMyWork);
  const openPr = useUiStore((s) => s.openPr);
  const openIssue = useUiStore((s) => s.openIssue);
  const [tab, setTab] = useState<MyWorkTab>("all");
  const [filter, setFilter] = useState("");
  // The active row is tracked by URL (unique per item) rather than by index, so
  // a filter change can't silently retarget the selection to a different item.
  const [activeUrl, setActiveUrl] = useState<string | null>(null);
  // The row whose open is still resolving where to land, or null.
  const [pendingOpenUrl, setPendingOpenUrl] = useState<string | null>(null);
  // Latches the first paint: set when every configured leg has answered, or when
  // the grace window closes, whichever comes first. Never unset — a leg that
  // becomes configured later (a sign-in mid-session) and every refetch arrive
  // underneath the rows already on screen instead of dropping back to a
  // skeleton. Component state because the screen unmounts on close, so each open
  // gets its own window.
  const [firstPaint, setFirstPaint] = useState(false);

  const settings = useSettings();
  const recents = settings.data?.recentRepos ?? NO_RECENTS;
  // One leg per forge, each gated on the sources probe: a provider with no
  // sign-in behind it is never asked, so it can neither fail nor delay the rows
  // the others already have. Bitbucket has no account-wide search, so its leg
  // takes EVERY recent path: `bitbucket_my_work` gates each on its own origin,
  // which costs a `git remote get-url` per recent on essentially every fetch
  // (that cache's TTL is far shorter than the gap between opens). Filtering on
  // the stored `provider` here would instead hide Bitbucket work forever for
  // anyone who never opens the repo list that backfills it.
  const sources = useMyWorkSources(true);
  const recentPaths = useMemo(
    () => recents.map((r) => r.path).sort(),
    [recents],
  );
  const githubOn = sources.data?.github === true;
  const gitlabOn = sources.data?.gitlab === true;
  const bitbucketOn = sources.data?.bitbucket === true;
  const github = useForgeMyWork("github", githubOn);
  const gitlab = useForgeMyWork("gitlab", gitlabOn);
  const bitbucket = useForgeMyWork("bitbucket", bitbucketOn, recentPaths);
  const legs: MyWorkLeg[] = [
    { provider: "github", enabled: githubOn, query: github },
    { provider: "gitlab", enabled: gitlabOn, query: gitlab },
    { provider: "bitbucket", enabled: bitbucketOn, query: bitbucket },
  ];
  const enabledLegs = legs.filter((l) => l.enabled);
  // The legs that actually ANSWERED. Only these may describe what an empty inbox
  // covers: a forge that failed has no reach to claim, and saying otherwise makes
  // a page that is hiding items look complete.
  const answeredLegs = enabledLegs.filter(hasAnswered);
  // Only configured legs contribute rows: a provider the probe has since turned
  // off keeps its cached page, and serving rows nothing can refresh would also
  // leave the combobox pointing at a listbox no branch mounts.
  const page = mergeMyWorkPages(enabledLegs.map((l) => l.query.data));
  const queryClient = useQueryClient();
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Which open generation lit the pending row, so an older open finishing late
  // can't darken an affordance a newer one owns.
  const pendingGenRef = useRef(0);

  const items = page.items;
  const prCount = items.filter((i) => i.isPullRequest).length;
  const visible = filterMyWork(items, tab, filter);

  const anySettled = enabledLegs.some(settled);
  const allSettled = enabledLegs.every(settled);
  const sourcesPending = sources.isPending;
  // Everything configured has answered — or the probe came back with nothing to
  // configure — so there is no window left to wait out. Read during render, not
  // only from the latch effect below: a reopen with every leg still cached is
  // due on its FIRST render, and waiting for the effect would paint one
  // skeleton frame the single-query screen never had.
  const paintDue = !sourcesPending && allSettled;
  const loading = !firstPaint && !paintDue;
  // The latch. A leg's settled state is monotonic within a mount, so the window
  // arms at most once — when the first forge answers — and is cleared again the
  // moment the rest catch up inside it. Latching even when `paintDue` already
  // painted is what stops a leg configured LATER from dropping rows back to a
  // skeleton.
  useEffect(() => {
    if (firstPaint) return;
    if (paintDue) {
      setFirstPaint(true);
      return;
    }
    // Nothing to hold yet: the probe is still out, or no forge has answered.
    if (sourcesPending || !anySettled) return;
    const timer = setTimeout(() => setFirstPaint(true), FIRST_PAINT_GRACE_MS);
    return () => clearTimeout(timer);
  }, [firstPaint, paintDue, sourcesPending, anySettled]);

  // The rows a user can actually act on. The grace window holds skeletons over a
  // settled leg's rows, so `visible` alone would let arrows reach — and Enter
  // OPEN — an item never painted, and would point the combobox's ARIA ids at a
  // listbox no branch has mounted. Keyboard, ARIA and the painted list read this
  // one set, which is `visible` itself the moment anything paints.
  const interactive = loading ? NO_ITEMS : visible;
  // Every page-derived total in the shell rides the body's paint gate together:
  // a partial number sitting above skeletons and then changing as the held-back
  // legs land is one defect, not one per tab. Header and tab strip share the
  // predicate so they can't disagree: numbers appear once something is on screen
  // for them to describe — rows, or a forge that answered empty. Skeletons, "no
  // accounts connected" and the all-failed screen get none. Deliberately NOT
  // gated on allSettled while rows show: totals grow as legs land and the
  // per-provider pending notice is the disclosure — hiding numbers above
  // rendered rows would desync the header from the list it describes.
  const showCounts =
    !loading && (items.length > 0 || (allSettled && answeredLegs.length > 0));
  const counts = showCounts
    ? { all: items.length, prs: prCount, issues: items.length - prCount }
    : { all: null, prs: null, issues: null };
  // Derived, never stored: a row the filter has hidden simply stops being
  // active, and arrow keys restart from the ends of the new visible set.
  const activeIndex = interactive.findIndex((i) => i.url === activeUrl);
  const activeId =
    activeIndex >= 0 ? myWorkOptionId(interactive[activeIndex].url) : undefined;
  // Only a total failure earns the error screen — one failed leg among several
  // is a quiet notice under the rows the rest supplied.
  const errors = failedLegs(
    sources.isError ? sources.error : null,
    enabledLegs,
  );
  // And only when there is nothing for it to replace: rows an earlier fetch or
  // another leg supplied outlive the failure, which drops to a notice line.
  const fatal = errors.length > 0 && items.length === 0;
  const refreshing =
    sources.isFetching || enabledLegs.some((l) => l.query.isFetching);
  // Refetches the sources probe too: a sign-in that landed while the inbox was
  // open only shows up as a newly configured leg.
  function refresh() {
    void sources.refetch();
    for (const leg of enabledLegs) void leg.query.refetch();
  }

  // Esc closes the inbox. Guarded so Base UI popups (which mark the event
  // consumed) get first claim; an effect event reads the latest closeMyWork.
  const onEscape = useEffectEvent(() => closeMyWork());
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !e.defaultPrevented) onEscape();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // openItem clears its own timer on every exit path; this catches an unmount
  // while one is still armed — and retires the mount's continuations: a quick
  // reopen restores view === "mywork", so the view guard alone can't see it.
  useEffect(() => {
    return () => {
      openGen += 1;
      if (pendingTimerRef.current !== null) {
        clearTimeout(pendingTimerRef.current);
      }
    };
  }, []);

  // Every navigation goes through an atomic navigator: an openRepo followed by a
  // select would pair the new repo with the old selection, because the
  // view-transition callback that carries the selection is deferred.
  // `preferWorktree: false` is the escape hatch back to the main workspace
  // (Shift+Enter, shift-click, or the context menu); everything else lands where
  // the branch actually is.
  async function openItem(
    item: MyWorkItem,
    opts?: { preferWorktree?: boolean },
  ) {
    // Claim the generation before any early return, so EVERY open — including
    // the browser arm, which never awaits — supersedes a pending one; a stale
    // continuation must strand rather than stomp the newer action or yank the
    // user back. The counter outlives the screen (this one unmounts on every
    // view change), so a continuation from a previous mount stays superseded;
    // the view is read live because the screen can be gone entirely.
    const gen = ++openGen;
    const superseded = () =>
      gen !== openGen || useUiStore.getState().view !== "mywork";
    // The same set the row's affordances render from, so a local-looking row is
    // never one this refuses over a provider. Both open arms below start here,
    // so PRs and issues are gated alike.
    const candidates = openableMatches(item, recents);
    if (candidates.length === 0) {
      openUrl(item.url);
      return;
    }
    // EVERY row is proven below, whatever its provider: the key's host and owner
    // are STORED values, so a re-pointed origin leaves any provider's key naming
    // a checkout that is no longer this project. GitLab carries a second reason —
    // it persists only the segment BEFORE the repo name, so `team-a/sub/repo` and
    // `team-b/sub/repo` answer the same key and the candidates can be DIFFERENT
    // projects. Elsewhere the key is identity, so several candidates are clones of
    // the one right repository and the proof only has to find a live one.
    let match = candidates[0];
    // Recents rows outlive deleted and moved clones, so prove the path is still
    // a repo before navigating; the browser fallback keeps the row a working
    // link while the toast names the stale path (repair lives in the repo list).
    try {
      await validateRepo(match.path);
    } catch (e) {
      if (superseded()) return;
      // A stale FIRST candidate is not the end of a multi-candidate row: the
      // proof rejects a dead path anyway, so only a row with nowhere else to
      // look reports it and gives up here.
      if (candidates.length === 1) {
        openUrl(item.url);
        // Only a real notARepo earns the stale-path sentence — a missing CLI or
        // an IPC failure would be misdescribed by it, so it takes the generic
        // toast.
        if (isAppError(e) && e.kind === "notARepo") {
          toast.error(`${match.path} is no longer a git repository.`);
        } else {
          toastError(e);
        }
        return;
      }
    }
    if (superseded()) return;
    // Where a local landing goes, in one rule: a matched row that is itself a
    // linked worktree prefers its repo's main workspace, and a PROVEN PR head
    // branch outranks that toward the worktree holding it. Every unknown stays
    // on match.path, silently — nothing broke for the user.
    let targetPath = match.path;
    let targetName = match.name;
    {
      // Armed before the first await, not before the network leg: listing
      // worktrees runs a prune that can block for seconds, and a freeze the row
      // doesn't acknowledge reads as a dropped keypress. Held locally as well as
      // on the ref — the ref is what an unmount can reach, but only this
      // generation may clear its own timer out of it.
      const timer = setTimeout(() => {
        if (superseded()) return;
        setPendingOpenUrl(item.url);
      }, PENDING_AFFORDANCE_MS);
      pendingTimerRef.current = timer;
      // Ownership is claimed at ARM time, not fire time: a successor open must
      // own the affordance from its first instant, or the superseded open's
      // cleanup darkens a row the successor is still resolving.
      pendingGenRef.current = gen;
      // One budget for the whole resolution, however many legs it takes.
      const deadline = Date.now() + WORKTREE_RESOLVE_BUDGET_MS;
      try {
        // Settle which candidate is really this row's first in the budget —
        // ahead of the optional worktree legs, which may spend the rest of it.
        // None proven opens the browser: the row stays a working link, and no
        // open lands in a checkout that isn't this project's.
        const proven = await provenCandidate(item, candidates, deadline);
        if (superseded()) return;
        if (!proven) {
          openUrl(item.url);
          return;
        }
        // Everything below resolves against the PROVEN checkout, not the key's
        // first match.
        match = proven;
        targetPath = proven.path;
        targetName = proven.name;
        // Listed once and shared: both preferences read the same snapshot, and
        // this is the leg that can block.
        const worktrees = await withDeadline(
          listUserWorktrees(match.path),
          deadline,
          [],
        );
        if (superseded()) return;
        // The fallback is resolved AND validated first, before the optional
        // network leg can spend the budget on it: the semantics promise the main
        // workspace whenever the branch is unconfirmed, so that promise must not
        // depend on how slow the head-ref read turns out to be. Costs one local
        // git call even when the branch goes on to win.
        // Null when the matched row already IS the main workspace, so the
        // ordinary main-clone open never re-validates or re-spells its path.
        const mainPath = mainWorktreeOf(worktrees, match.path);
        // Where the open lands if the branch is never looked up. Proving a head
        // can only matter when some branch-bearing checkout sits somewhere ELSE
        // than that: a single-checkout clone has nowhere to be redirected to, and
        // the common open must stay keypress-instant rather than wait on a forge
        // call whose every outcome is the path it already has.
        const fallbackPath = mainPath ?? match.path;
        const lookupCanMove = worktrees.some(
          (w) => w.branch !== "" && normPath(w.path) !== normPath(fallbackPath),
        );
        let landing: { path: string; name: string } | null = null;
        if (mainPath) {
          // git skips its prune while another process holds the worktree-admin
          // lock, so a checkout deleted out-of-band can still be listed.
          landing = await resolveTarget(mainPath, deadline);
          if (superseded()) return;
        }
        if (
          lookupCanMove &&
          item.isPullRequest &&
          (opts?.preferWorktree ?? true)
        ) {
          // `providerAgrees` already dropped every candidate whose stored provider
          // contradicts the row, so a CLASSIFIED checkout necessarily agrees here.
          // The fallback covers the unclassified ones: a recent the owner probe
          // hasn't touched, or one carrying an id this build doesn't know.
          const branch = await branchWorktreeOf(
            item,
            worktrees,
            match.path,
            asForgeProvider(match.provider) ?? item.provider,
            deadline,
          );
          if (superseded()) return;
          if (branch && normPath(branch) === normPath(match.path)) {
            // The proven head is the matched checkout itself — stay on the
            // user's own branch rather than moving them to the main workspace.
            landing = null;
          } else if (branch) {
            const branchTarget = await resolveTarget(branch, deadline);
            if (superseded()) return;
            // A branch that won't validate keeps the main-workspace fallback
            // rather than dropping back to the matched worktree.
            if (branchTarget) landing = branchTarget;
          }
        }
        if (landing) {
          targetPath = landing.path;
          targetName = landing.name;
        }
      } finally {
        clearTimeout(timer);
        if (pendingTimerRef.current === timer) pendingTimerRef.current = null;
        // Only the generation that owns the affordance may darken it.
        if (pendingGenRef.current === gen) {
          pendingGenRef.current = 0;
          setPendingOpenUrl(null);
        }
      }
      if (superseded()) return;
    }
    // Land under the origin lens (the match keyed on the ORIGIN slug): a fork
    // sitting on "upstream" resolves this number against the parent repo. Keyed on
    // the path actually navigated to, since a worktree carries its own lens. The
    // lens write is session-only. Clears are safe: an unchanged lens short-circuits
    // before them, and a real flip drops old-lens siblings before the landing set.
    const applyLens = () =>
      applyRepoLens(queryClient, targetPath, "origin", {
        clearSelections: true,
        persist: false,
      });
    if (item.isPullRequest) {
      openPr({
        kind: "remote",
        repoPath: targetPath,
        repoName: targetName,
        ref: String(item.number),
        section: null,
        // Inside the navigator's view-transition callback, so the lens and the
        // selection reach the same commit; applied here it would land a render
        // early and fetch the new lens against the OLD number.
        beforeSelect: applyLens,
      });
    } else {
      openIssue({
        repoPath: targetPath,
        repoName: targetName,
        number: item.number,
        beforeSelect: applyLens,
      });
    }
  }

  // Arrow keys from the filter input move the selection through the visible
  // rows and Enter opens it, so a keyboard user goes type → arrows → Enter
  // without ever leaving the input. Shift+Enter is the keyboard route to the
  // main workspace.
  const onInputArrow = listKeyboardNav({
    items: interactive,
    activeIndex,
    onActivate: (item) => setActiveUrl(item.url),
  });
  function onInputKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      const item = interactive[activeIndex];
      if (!item) return;
      e.preventDefault();
      void openItem(item, { preferWorktree: !e.shiftKey });
      return;
    }
    // The menu keys reach the row's context menu from here because focus never
    // leaves this input: pressed on the input they would target it instead, and
    // it sits outside the list's menu trigger, so the rows' only menu route is
    // this one. Targets the active row, which the menu already acts on.
    if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      const item = interactive[activeIndex];
      // Swallowed whenever a row is active, even if it scrolled out of the
      // virtualizer and couldn't be found: the input's own edit menu is the
      // wrong answer to a row-menu request. With no active row there is no row
      // menu to ask for, so that menu stays reachable.
      if (item) {
        e.preventDefault();
        openRowContextMenu(item.url);
      }
      return;
    }
    onInputArrow(e);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Back"
          onClick={closeMyWork}
        >
          <ArrowLeftIcon />
        </Button>
        <span className="text-sm font-medium">My work</span>
        {showCounts && (
          <span className="text-xs tabular-nums text-muted-foreground">
            {items.length}
          </span>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto"
          aria-label="Refresh"
          title="Refresh"
          disabled={refreshing}
          onClick={refresh}
        >
          {refreshing ? <Spinner /> : <ArrowsClockwiseIcon />}
        </Button>
      </header>

      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <Tabs value={tab} onValueChange={(v) => setTab(v as MyWorkTab)}>
          <TabsList>
            <TabsTrigger value="all">
              All
              <Count n={counts.all} />
            </TabsTrigger>
            <TabsTrigger value="prs">
              Pull requests
              <Count n={counts.prs} />
            </TabsTrigger>
            <TabsTrigger value="issues">
              Issues
              <Count n={counts.issues} />
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={onInputKeyDown}
          placeholder="Filter by title, repository, or number"
          aria-label="Filter your work"
          role="combobox"
          aria-expanded={interactive.length > 0}
          // Same predicate as aria-expanded, and the same set the list renders:
          // the listbox only mounts in the list branch, so pointing at its id
          // from any other state — including the grace window's skeletons —
          // would reference a node that isn't there.
          aria-controls={
            interactive.length > 0 ? MY_WORK_LISTBOX_ID : undefined
          }
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          className="h-8 min-w-40 flex-1"
        />
      </div>

      <MyWorkBody
        loading={loading}
        errors={fatal ? errors : NO_ERRORS}
        // "Items may be missing", never "the page is full": a leg hit its
        // server-side cap, the merged union overshot, or a provider lost part of
        // its results. True on a page that arrives short, so the copy it drives
        // may only claim incompleteness.
        capped={page.truncated}
        noSources={sources.isSuccess && enabledLegs.length === 0}
        answered={answeredLegs.map((l) => l.provider)}
        allSettled={allSettled}
        items={items}
        visible={visible}
        activeIndex={activeIndex}
        recents={recents}
        pendingOpenUrl={pendingOpenUrl}
        onRetry={refresh}
        onSelect={setActiveUrl}
        onOpen={(item, opts) => void openItem(item, opts)}
      />
      {/* Outside every body branch and never unmounted: a live region announces
          CHANGES, so one that appears already carrying its first line is silent.
          Given nothing to say while the error screen owns the message. */}
      <MyWorkNotices
        legs={fatal ? NO_LEGS : enabledLegs}
        sourcesFailed={!fatal && sources.isError}
      />
    </div>
  );
}

/** Opens an item, optionally overriding the worktree preference. */
type OpenItem = (item: MyWorkItem, opts?: { preferWorktree?: boolean }) => void;

/** The body's state machine: loading → error → no sources → empty →
 *  filtered-empty → list. Split from the shell so the virtualizer below only
 *  ever mounts with rows. */
function MyWorkBody({
  loading,
  errors,
  capped,
  noSources,
  answered,
  allSettled,
  items,
  visible,
  activeIndex,
  recents,
  pendingOpenUrl,
  onRetry,
  onSelect,
  onOpen,
}: {
  loading: boolean;
  errors: LegError[];
  capped: boolean;
  noSources: boolean;
  /** The forges that ANSWERED — the only ones the empty state may speak for. */
  answered: ForgeProvider[];
  allSettled: boolean;
  items: MyWorkItem[];
  visible: MyWorkItem[];
  activeIndex: number;
  recents: readonly RecentRepo[];
  pendingOpenUrl: string | null;
  onRetry: () => void;
  onSelect: (url: string) => void;
  onOpen: OpenItem;
}) {
  if (loading) {
    return <ListRowSkeletons rows={8} lines={1} name="your work" />;
  }
  if (errors.length > 0) {
    return <MyWorkError errors={errors} onRetry={onRetry} />;
  }
  if (noSources) {
    // The cold-start landing for a machine with no CLI installed: the sources
    // probe folds a missing gh to "not configured", so this line, not the error
    // screen, is where a first run needs the sign-in commands.
    return (
      <QuietLine>
        No forge accounts connected. Run gh auth login or glab auth login for
        GitHub or GitLab, or add an Atlassian API token in Settings → Accounts
        for Bitbucket.
      </QuietLine>
    );
  }
  // Rows appear on the first leg's data, but "nothing involves you" answers for
  // EVERY forge — a leg that settles instantly and empty (Bitbucket with no
  // local checkouts) must not speak for one still fetching.
  if (items.length === 0 && !allSettled) {
    return <ListRowSkeletons rows={8} lines={1} name="your work" />;
  }
  if (items.length === 0) {
    // Every claim here is scoped to the forges that ANSWERED, so a failed leg's
    // reach is never spoken for; the notice below names it instead. One answering
    // forge names itself; several can only speak neutrally, since the empty
    // answer is every one of theirs. A capped EMPTY page carries its own sentence
    // rather than CapNote: the note's filter advice has nothing to narrow, but
    // the page must not read as "nothing exists".
    const sole = answered.length === 1 ? answered[0] : null;
    const source = sole ? providerLabel(sole) : "Your forges";
    const nothing = sole
      ? `Nothing on ${providerLabel(sole)} involves you right now.`
      : "Nothing involves you right now.";
    return capped ? (
      <QuietLine>
        {`${source} didn't return everything. There may be work this view can't show.`}
      </QuietLine>
    ) : (
      <QuietLine>{`${nothing} ${scopeSentence(answered)}`}</QuietLine>
    );
  }
  if (visible.length === 0) {
    return (
      <>
        <QuietLine>No items match.</QuietLine>
        {capped && <CapNote />}
      </>
    );
  }
  return (
    <>
      <MyWorkList
        items={visible}
        activeIndex={activeIndex}
        recents={recents}
        pendingOpenUrl={pendingOpenUrl}
        onSelect={onSelect}
        onOpen={onOpen}
      />
      {capped && <CapNote />}
    </>
  );
}

/** The virtualized row list, plus one shared context menu for the whole list
 *  (capture phase records the row before the menu opens). */
function MyWorkList({
  items,
  activeIndex,
  recents,
  pendingOpenUrl,
  onSelect,
  onOpen,
}: {
  items: MyWorkItem[];
  activeIndex: number;
  recents: readonly RecentRepo[];
  pendingOpenUrl: string | null;
  onSelect: (url: string) => void;
  onOpen: OpenItem;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [menuItem, setMenuItem] = useState<MyWorkItem | null>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 33,
    overscan: 12,
  });

  // Armed by a right-click, consumed by the very next run of the align effect:
  // the menu opens anchored to the cursor, so aligning the row it selected would
  // slide the list out from under it.
  const skipAlignRef = useRef(false);

  // Keep the keyboard-selected row in view. Keyed on the active ITEM, not its
  // index: a re-scroll on any list change would fight the user's own scrolling
  // on every unrelated re-render (the shared clock ticks these rows every 30s),
  // and a later provider's rows merging in ABOVE the selection shift its index
  // without moving it — re-aligning there yanks a user who scrolled elsewhere.
  const activeItemUrl = activeIndex >= 0 ? items[activeIndex].url : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the selection moves
  useEffect(() => {
    if (skipAlignRef.current) {
      skipAlignRef.current = false;
      return;
    }
    if (activeIndex >= 0) {
      virtualizer.scrollToIndex(activeIndex, { align: "auto" });
    }
  }, [activeItemUrl]);

  // A right-click on blank space hits no row — suppress the menu rather than
  // show an empty popup.
  function onContextMenu(e: ReactMouseEvent) {
    const url = (e.target as HTMLElement)
      .closest("[data-my-work-url]")
      ?.getAttribute("data-my-work-url");
    const item = url ? items.find((i) => i.url === url) : undefined;
    if (item) {
      setMenuItem(item);
      // Move the highlight with the menu, so it can't act on a row other than
      // the one aria-activedescendant is pointing at — but arm the skip only
      // when the index will actually change, or the flag would outlive this
      // click and swallow the next keyboard scroll.
      if (item.url !== items[activeIndex]?.url) skipAlignRef.current = true;
      onSelect(item.url);
    } else {
      setMenuItem(null);
      suppressContextMenu(e);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ContextMenu>
        {/* The scroll element keeps its own ref rather than riding the Trigger's
            render prop — the virtualizer needs that node, and a merged-ref miss
            would leave the list unmeasured and blank. */}
        <ContextMenuTrigger
          render={
            <div
              onContextMenuCapture={onContextMenu}
              className="flex min-h-0 flex-1 flex-col"
            />
          }
        >
          {/* Arrow-key navigation lives on the filter Input (combobox pattern),
              so the listbox itself is neither a Tab stop nor the owner of
              aria-activedescendant — focus never leaves the input, and a second
              copy here would be inert. A pure a11y container. */}
          <div
            ref={parentRef}
            className="min-h-0 flex-1 overflow-y-auto"
            role="listbox"
            id={MY_WORK_LISTBOX_ID}
            aria-label="Your work"
          >
            <div
              className="relative w-full"
              style={{ height: `${virtualizer.getTotalSize()}px` }}
            >
              {virtualizer.getVirtualItems().map((v) => {
                const item = items[v.index];
                return (
                  <div
                    key={v.key}
                    data-index={v.index}
                    ref={virtualizer.measureElement}
                    // Presentation wrapper so the virtualizer's positioning div
                    // doesn't sit between the listbox and its options.
                    role="presentation"
                    className="absolute top-0 left-0 w-full"
                    style={{ transform: `translateY(${v.start}px)` }}
                  >
                    <MyWorkRow
                      item={item}
                      local={hasOpenableMatch(item, recents)}
                      active={v.index === activeIndex}
                      pending={item.url === pendingOpenUrl}
                      onSelect={onSelect}
                      onOpen={onOpen}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-44">
          {menuItem && (
            <>
              {/* The escape hatch from the worktree-aware default: only ever
                  offered for a PR that resolves to a checkout the open would
                  actually take — same set, so the entry can't promise a landing
                  the provider gate refuses. */}
              {menuItem.isPullRequest &&
                hasOpenableMatch(menuItem, recents) && (
                  <ContextMenuItem
                    onClick={() => onOpen(menuItem, { preferWorktree: false })}
                  >
                    Open in main workspace
                  </ContextMenuItem>
                )}
              <ContextMenuItem onClick={() => openUrl(menuItem.url)}>
                {`Open on ${providerLabel(menuItem.provider)}`}
              </ContextMenuItem>
              <ContextMenuItem
                onClick={() => copyText(menuItem.url, "Link copied")}
              >
                Copy link
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
}

/** One muted line per configured leg that is still working or already broken,
 *  under whatever the body rendered, plus the sources probe's own failure. The
 *  caller keeps this mounted through every body state — a live region announces
 *  changes to itself, never the content it first appears holding — so with
 *  nothing to say it renders an empty, zero-height container. */
function MyWorkNotices({
  legs,
  sourcesFailed,
}: {
  legs: MyWorkLeg[];
  sourcesFailed: boolean;
}) {
  const lines = legs.flatMap((leg) => {
    if (leg.query.isError) return [FAILURE_NOTICE[leg.provider]];
    return settled(leg) ? [] : [FETCH_NOTICE[leg.provider]];
  });
  if (sourcesFailed) lines.push(SOURCES_NOTICE);
  return (
    <div aria-live="polite" className="px-3 text-[11px] text-muted-foreground">
      {lines.map((line) => (
        <p key={line} className="py-1">
          {line}
        </p>
      ))}
    </div>
  );
}

/** The one-page-of-results note. Rendered by the body, not the list, so it
 *  survives a filter that matches nothing. */
function CapNote() {
  return (
    <p className="px-3 py-2 text-center text-[11px] text-muted-foreground">
      This list may be missing items. Filter to narrow what's loaded.
    </p>
  );
}

/** One inbox row — a `role="option"` in the listbox. Single line: type glyph,
 *  number, title, repository, and when it last moved. */
function MyWorkRow({
  item,
  local,
  active,
  pending,
  onSelect,
  onOpen,
}: {
  item: MyWorkItem;
  local: boolean;
  active: boolean;
  pending: boolean;
  onSelect: (url: string) => void;
  onOpen: OpenItem;
}) {
  const Icon = item.isPullRequest ? GitPullRequestIcon : CircleDashedIcon;
  const typeLabel = item.isPullRequest ? "Pull request" : "Issue";
  const browserLabel = `Opens on ${item.host || providerLabel(item.provider)} — not a local repository`;
  return (
    <button
      type="button"
      id={myWorkOptionId(item.url)}
      data-my-work-url={item.url}
      role="option"
      aria-selected={active}
      aria-busy={pending}
      // The combobox input owns focus and drives the selection, so an option
      // must not also be a Tab stop.
      tabIndex={-1}
      // tabIndex alone doesn't stop a CLICK from focusing the button, which
      // would move focus off the combobox input and kill arrow/Enter nav;
      // suppressing mousedown's default keeps focus without affecting activation.
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        onSelect(item.url);
        // Shift-click mirrors Shift+Enter: open the main workspace instead of
        // the worktree holding the head branch.
        onOpen(item, { preferWorktree: !e.shiftKey });
      }}
      className={cn(
        "flex w-full items-center gap-2 border-b px-3 py-2 text-left text-xs",
        active ? "bg-accent text-accent-foreground" : "hover:bg-muted/60",
      )}
    >
      {/* role="img" prunes the glyph's own markup, so the label is what carries
          the PR-vs-issue distinction to readers — never the shape alone. */}
      <span
        role="img"
        aria-label={typeLabel}
        title={typeLabel}
        className="flex shrink-0 items-center text-muted-foreground"
      >
        <Icon className="size-3.5" aria-hidden />
      </span>
      <span className="shrink-0 tabular-nums text-muted-foreground">
        #{item.number}
      </span>
      <span
        className="min-w-0 flex-1 truncate"
        onMouseEnter={clipTitleFromText}
      >
        {item.title}
      </span>
      {/* The glyph is decorative, so the forge rides the row's ACCESSIBLE text,
          announced after the name (rows are scanned by repo): one name can live
          on several forges, and a shape says nothing to a screen reader.
          `sr-only` is absolutely positioned, so the name's truncation is
          untouched. Kept on ↗ rows too — their hint names the HOST, which on a
          self-managed server doesn't reveal the forge. */}
      <span className="flex max-w-56 shrink-0 items-center gap-1 text-muted-foreground">
        <ProviderIcon provider={item.provider} className="size-3 shrink-0" />
        <span className="min-w-0 truncate" onMouseEnter={clipTitleFromText}>
          {item.repoFullName}
        </span>
        <span className="sr-only">, {providerLabel(item.provider)}</span>
      </span>
      {!local && (
        <span
          role="img"
          aria-label={browserLabel}
          title={browserLabel}
          className="flex shrink-0 items-center text-muted-foreground"
        >
          <ArrowSquareOutIcon className="size-3" aria-hidden />
        </span>
      )}
      {pending && (
        <span
          className="flex shrink-0 items-center text-muted-foreground"
          aria-hidden
        >
          <CircleNotchIcon className="size-3.5 animate-spin" />
        </span>
      )}
      {parseableDate(item.updatedAt) && (
        <span className="shrink-0 text-muted-foreground">
          <RelativeTime date={item.updatedAt} />
        </span>
      )}
    </button>
  );
}

/** A tab's item count. Null while the list is still resolving: the tab keeps its
 *  label, but a total that would change as held-back legs land shows nothing. */
function Count({ n }: { n: number | null }) {
  if (n === null) return null;
  return (
    <span className="ml-1.5 text-[10px] tabular-nums text-muted-foreground">
      {n}
    </span>
  );
}

function QuietLine({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex flex-1 items-center justify-center p-6 text-center text-xs text-muted-foreground">
      <span className="max-w-sm">{children}</span>
    </p>
  );
}

/** The lines under the error title: a lone provider whose sign-in is the fixable
 *  thing gets that remedy, a lone provider otherwise gets its own message, and
 *  several failing at once each get a labelled one. */
function errorLines(
  errors: LegError[],
  signIn: ForgeProvider | null,
): string[] {
  if (signIn !== null) return [SIGN_IN_BODY[signIn]];
  if (errors.length === 1) return [errorMessage(errors[0].error)];
  return errors.map(
    (e) => `${providerLabel(e.provider)}: ${errorMessage(e.error)}`,
  );
}

/** Shown only when every configured forge failed, so it never hides rows another
 *  provider supplied. Offers a retry either way. */
function MyWorkError({
  errors,
  onRetry,
}: {
  errors: LegError[];
  onRetry: () => void;
}) {
  const soleProvider = errors.length === 1 ? errors[0].provider : null;
  const soleError = errors.length === 1 ? errors[0].error : null;
  const soleKind = isAppError(soleError) ? soleError.kind : "";
  const signIn =
    soleProvider !== null && SIGN_IN_KINDS.has(soleKind) ? soleProvider : null;
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <p className="text-xs font-medium">
        {signIn !== null ? SIGN_IN_TITLE[signIn] : "Couldn't load your work"}
      </p>
      <div className="max-w-xs text-xs text-muted-foreground">
        {errorLines(errors, signIn).map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
