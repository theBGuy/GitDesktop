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
import { Badge } from "@/components/ui/badge";
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
import {
  OFFLINE_ROWS_NOTICE,
  offlinePendingMessage,
  refreshFailed,
} from "@/features/conversations/remote-section-state";
import { claimRepoOpen } from "@/features/repository/useOpenRepoByPath";
import { clipTitleFromText } from "@/lib/clip-title";
import { copyText } from "@/lib/clipboard";
import { suppressContextMenu } from "@/lib/context-menu";
import { composedErrorPresentation, presentError } from "@/lib/error-summary";
import { rateLimitSummary } from "@/lib/forge-backoff";
import { useForgeMyWork, useMyWorkSources } from "@/lib/git/queries";
import {
  type ForgeProvider,
  type MyWorkItem,
  providerLabel,
} from "@/lib/git/types";
import { sameOpenCheckout } from "@/lib/git/worktree-default-path";
import {
  keepNonRowPressOffList,
  listKeyboardNav,
} from "@/lib/list-keyboard-nav";
import {
  hasOpenableMatch,
  type LocalLandingTarget,
  openableMatches,
  openingStatus,
  PENDING_AFFORDANCE_MS,
  urlAuthority,
} from "@/lib/local-landing/match";
import {
  type LocalLanding,
  resolveLocalLanding,
} from "@/lib/local-landing/resolve";
import { useMenuKeyFollowUpCanceller } from "@/lib/menu-key-follow-up";
import { PR_NOUN, prRef } from "@/lib/pulls/pr-state";
import { applyRepoLens } from "@/lib/repo-lens/queries";
import type { RecentRepo } from "@/lib/settings/api";
import { useSettings } from "@/lib/settings/queries";
import { useErrorDialog } from "@/lib/stores/error-dialog";
import { useUiStore } from "@/lib/stores/ui";
import { isAppError } from "@/lib/tauri/invoke";
import { parseableDate } from "@/lib/time";
import { toastError } from "@/lib/toast";
import { cn } from "@/lib/utils";
import {
  filterMyWork,
  MY_WORK_LISTBOX_ID,
  type MyWorkTab,
  mergeMyWorkPages,
  myWorkOptionId,
} from "./mywork-utils";

/** Stable empty default, so a settings read that hasn't landed doesn't hand a
 *  fresh array to every render. */
const NO_RECENTS: RecentRepo[] = [];

/** A request row's glyph name: its forge's own noun, capitalized. */
function requestLabel(provider: ForgeProvider): string {
  const noun = PR_NOUN[provider];
  return `${noun.charAt(0).toUpperCase()}${noun.slice(1)}`;
}

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

/** The leg holds a page of its OWN, not the previous key's placeholder. */
const hasOwnData = (leg: MyWorkLeg) =>
  leg.query.data !== undefined && !leg.query.isPlaceholderData;

/** A leg has settled on what it shows NOW: a failure being refetched, or one
 *  parked offline with nothing of its own loaded, hasn't, so it can't let an
 *  empty inbox claim to be complete. A park over its own loaded page has: that
 *  page is still this leg's answer. */
const settledNow = (leg: MyWorkLeg) =>
  hasAnswered(leg) ||
  refreshFailed(leg.query) ||
  (leg.query.isPaused && hasOwnData(leg));

/**
 * What the error screen speaks for. The sources probe answers only when it left
 * nothing behind to ask: its data survives a failed refetch, so legs that are
 * still configured have their own answers and those are the truth — the probe's
 * failure drops to a notice rather than replacing a forge's real reply. Legs
 * speak only once every one of them has failed and settled: a leg parked
 * offline is waiting, not failing, and its Retry would only park again.
 */
function failedLegs(sourcesError: unknown, legs: MyWorkLeg[]): LegError[] {
  if (legs.length === 0) {
    return sourcesError === null
      ? []
      : [{ provider: null, error: sourcesError }];
  }
  if (!legs.every((l) => refreshFailed(l.query))) return [];
  return legs.map((l) => ({ provider: l.provider, error: l.query.error }));
}

/** Stable empty defaults, so a suppressed notice, error list or unpainted row
 *  set doesn't hand a fresh array to every render. */
const NO_LEGS: MyWorkLeg[] = [];
const NO_ERRORS: LegError[] = [];
const NO_ITEMS: MyWorkItem[] = [];

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

/** Moves the open generation on from outside the component, so a new writer adds
 *  no React Compiler bail-out reason of its own. */
function bumpOpenGen(): number {
  openGen += 1;
  return openGen;
}

/** What the shared resolver needs to know about a row. The authority comes from
 *  the row's URL, the only place a My Work item carries its port. */
function landingTarget(item: MyWorkItem): LocalLandingTarget {
  return {
    provider: item.provider,
    host: item.host,
    authority: urlAuthority(item.url),
    repoOwner: item.repoOwner,
    repoName: item.repoName,
    repoFullName: item.repoFullName,
    number: item.number,
    isPullRequest: item.isPullRequest,
  };
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
  // The row whose open is still resolving where to land, with the sentence its
  // wait speaks (fixed at the open's start), or null.
  const [pendingOpen, setPendingOpen] = useState<{
    url: string;
    status: string;
  } | null>(null);
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
  // Nothing drawn, a leg parked before it ever answered, and every other leg
  // parked or settled: the inbox waits for the connection, never an endless
  // skeleton or an empty claim. A leg that answered empty doesn't count: zero
  // rows is a loaded answer, so the empty copy stays and the notice line beneath
  // says it's parked.
  const offline =
    !fatal &&
    items.length === 0 &&
    enabledLegs.some((l) => l.query.isPaused && !hasOwnData(l)) &&
    enabledLegs.every((l) => l.query.isPaused || settledNow(l));
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
    // A newer open clears an older one's wait at once, browser-only opens
    // included; the older wait is never announced as done.
    setPendingOpen(null);
    // The same set the row's affordances render from, so a local-looking row is
    // never one this refuses over a provider. Both open arms below start here,
    // so PRs and issues are gated alike.
    const candidates = openableMatches(item, recents);
    if (candidates.length === 0) {
      openUrl(item.url).catch(toastError);
      return;
    }
    // Claimed here, before the first await but after the browser-only arm, so a
    // browser-only click leaves opens made elsewhere (the picker, a held
    // notification jump) alone; this screen's own it retires by `openGen`. A newer
    // open claimed elsewhere retires this one. Read only before the navigator
    // call, whose own claim would retire it.
    const claimed = claimRepoOpen();
    const superseded = () =>
      gen !== openGen || !claimed() || useUiStore.getState().view !== "mywork";
    // Fixed at the open's start, so a refetch that drops or retitles the row
    // can't blank or change the sentence mid-wait.
    const status = openingStatus(item);
    // Armed before the first await: the resolve's first folder check can take its
    // whole budget, and a freeze the row doesn't acknowledge reads as a dropped
    // keypress. Held locally as well as on the ref: the ref is what an unmount can
    // reach, but only this generation may clear its own timer out of it.
    const timer = setTimeout(() => {
      if (!superseded()) setPendingOpen({ url: item.url, status });
    }, PENDING_AFFORDANCE_MS);
    pendingTimerRef.current = timer;
    // Ownership is claimed at ARM time, not fire time: a successor open must
    // own the affordance from its first instant, or the superseded open's
    // cleanup darkens a row the successor is still resolving.
    pendingGenRef.current = gen;
    let landing: LocalLanding;
    try {
      landing = await resolveLocalLanding(landingTarget(item), candidates, {
        preferWorktree: opts?.preferWorktree ?? true,
        superseded,
      });
    } finally {
      clearTimeout(timer);
      if (pendingTimerRef.current === timer) pendingTimerRef.current = null;
      // Only the generation that owns the affordance may darken it.
      if (pendingGenRef.current === gen) {
        pendingGenRef.current = 0;
        setPendingOpen(null);
      }
    }
    if (superseded()) return;
    if (landing.kind === "superseded") return;
    if (landing.kind === "browser") {
      // No proven clone keeps the row a working link. A stale recents folder
      // also names its path; repair lives in the repo list.
      openUrl(item.url).catch(toastError);
      if (landing.reason === "stale") {
        // Only a real notARepo earns the stale-path sentence — a missing CLI or
        // an IPC failure would be misdescribed by it, so it takes the generic
        // toast.
        if (isAppError(landing.error) && landing.error.kind === "notARepo") {
          toast.error(`${landing.path} is no longer a git repository.`);
        } else {
          toastError(landing.error);
        }
      }
      return;
    }
    // Recents can spell the open checkout differently, and the store tells a
    // same-repository landing by strict string equality, so the store's own path.
    const { repoPath: openPath, repoName: openName } = useUiStore.getState();
    const here = openPath !== null && sameOpenCheckout(landing.path, openPath);
    const targetPath = here ? openPath : landing.path;
    const targetName = (here ? openName : null) ?? landing.name;
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
    // Re-checked when the navigator applies, a frame or a warm-up hold after this
    // call: generation for a later click here (a browser-only one claims nothing
    // and moves no epoch), epoch for any other action. Never `claimed()`: the
    // navigator claims again, which would retire this open.
    const stillValid = (epochAtRequest: number) =>
      gen === openGen &&
      useUiStore.getState().interactionEpoch === epochAtRequest;
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
        stillValid,
      });
    } else {
      openIssue({
        repoPath: targetPath,
        repoName: targetName,
        number: item.number,
        beforeSelect: applyLens,
        stillValid,
      });
    }
  }

  // The row menu's browser open retires a pending local open the way openItem's
  // browser-only arm does: generation first, then the wait. It claims nothing, so
  // an open made elsewhere stands.
  function openOnWeb(item: MyWorkItem) {
    bumpOpenGen();
    setPendingOpen(null);
    openUrl(item.url).catch(toastError);
  }

  const armMenuKeyFollowUp = useMenuKeyFollowUpCanceller();

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
      if (e.repeat) return;
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
        if (e.key === "ContextMenu") armMenuKeyFollowUp();
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
        offline={offline}
        errors={fatal ? errors : NO_ERRORS}
        // "Items may be missing", never "the page is full": a leg hit its
        // server-side cap, the merged union overshot, or a provider lost part of
        // its results. True on a page that arrives short, so the copy it drives
        // may only claim incompleteness.
        capped={page.truncated}
        noSources={sources.isSuccess && enabledLegs.length === 0}
        answered={answeredLegs.map((l) => l.provider)}
        allSettled={enabledLegs.every(settledNow)}
        items={items}
        visible={visible}
        activeIndex={activeIndex}
        recents={recents}
        pendingOpenUrl={pendingOpen?.url ?? null}
        onRetry={refresh}
        onSelect={setActiveUrl}
        onOpen={(item, opts) => void openItem(item, opts)}
        onOpenOnWeb={openOnWeb}
      />
      {/* Outside every body branch and never unmounted: a live region announces
          CHANGES, so one that appears already carrying its first line is silent.
          Given nothing to say while the error screen owns the message. */}
      <MyWorkNotices
        legs={fatal ? NO_LEGS : enabledLegs}
        bodyOffline={offline}
        sourcesFailed={!fatal && sources.isError}
      />
      {/* A slow open's spoken wait, mounted empty for the same reason. Nothing
          visible: the row's spinner is the sighted cue, and focus stays put. */}
      <div role="status" className="sr-only">
        {pendingOpen?.status}
      </div>
    </div>
  );
}

/** Opens an item, optionally overriding the worktree preference. */
type OpenItem = (item: MyWorkItem, opts?: { preferWorktree?: boolean }) => void;

/** The body's state machine: offline → loading → error → no sources → empty →
 *  filtered-empty → list. Split from the shell so the virtualizer below only
 *  ever mounts with rows. */
function MyWorkBody({
  loading,
  offline,
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
  onOpenOnWeb,
}: {
  loading: boolean;
  /** Nothing drawn while a leg waits offline: a parked first fetch never ends
   *  the paint window, so this outranks `loading`. */
  offline: boolean;
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
  onOpenOnWeb: (item: MyWorkItem) => void;
}) {
  if (offline) {
    return <QuietLine>{offlinePendingMessage("your work")}</QuietLine>;
  }
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
        onOpenOnWeb={onOpenOnWeb}
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
  onOpenOnWeb,
}: {
  items: MyWorkItem[];
  activeIndex: number;
  recents: readonly RecentRepo[];
  pendingOpenUrl: string | null;
  onSelect: (url: string) => void;
  onOpen: OpenItem;
  onOpenOnWeb: (item: MyWorkItem) => void;
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
          {/* -1: Chromium makes an overflowing scroller of unfocusable rows a
              Tab stop. */}
          <div
            ref={parentRef}
            className="min-h-0 flex-1 overflow-y-auto"
            role="listbox"
            id={MY_WORK_LISTBOX_ID}
            aria-label="Your work"
            tabIndex={-1}
            onMouseDown={keepNonRowPressOffList}
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
              <ContextMenuItem onClick={() => onOpenOnWeb(menuItem)}>
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
  bodyOffline,
  sourcesFailed,
}: {
  legs: MyWorkLeg[];
  /** The body already says the inbox waits offline; parked legs add nothing. */
  bodyOffline: boolean;
  sourcesFailed: boolean;
}) {
  const lines = legs.flatMap((leg) => {
    // A parked leg is waiting, not failing: no failure line. Its drawn rows are
    // its last loaded ones only when they aren't another key's placeholder.
    if (leg.query.isPaused) {
      if (bodyOffline) return [];
      return hasOwnData(leg)
        ? [OFFLINE_ROWS_NOTICE]
        : [offlinePendingMessage(`${providerLabel(leg.provider)} work`)];
    }
    if (refreshFailed(leg.query)) return [FAILURE_NOTICE[leg.provider]];
    return settledNow(leg) ? [] : [FETCH_NOTICE[leg.provider]];
  });
  if (sourcesFailed) lines.push(SOURCES_NOTICE);
  return (
    <div aria-live="polite" className="px-3 text-[11px] text-muted-foreground">
      {/* Deduped: several parked legs share the one offline line. */}
      {[...new Set(lines)].map((line) => (
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
  const typeLabel = item.isPullRequest ? requestLabel(item.provider) : "Issue";
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
        // One multi-click gesture opens once: a second browser page or resolve
        // would duplicate the first. A keyboard-synthesized click has detail 0.
        if (e.detail > 1) return;
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
        {item.isPullRequest
          ? prRef(item.provider, item.number)
          : `#${item.number}`}
      </span>
      <span
        className="min-w-0 flex-1 truncate"
        onMouseEnter={clipTitleFromText}
      >
        {item.title}
      </span>
      {item.isDraft && (
        <Badge variant="secondary" className="h-4">
          Draft
        </Badge>
      )}
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
 *  thing gets that remedy, a lone provider otherwise gets its own summary, and
 *  several failing at once each get a labelled one. Summaries, never raw text:
 *  forge CLI output is multi-line, and an outage reads as the shared
 *  "Couldn't reach …" line. */
function errorLines(
  errors: LegError[],
  signIn: ForgeProvider | null,
): string[] {
  if (signIn !== null) return [SIGN_IN_BODY[signIn]];
  if (errors.length === 1) return [presentError(errors[0].error).summary];
  return errors.map((e) => {
    const label = providerLabel(e.provider);
    const summary = presentError(e.error).summary;
    // The outage and rate-limit sentences already name their forge; a limit an
    // app headline wraps reads as that headline, so it keeps the label.
    return summary.startsWith(`Couldn't reach ${label}`) ||
      rateLimitSummary(e.error) !== null
      ? summary
      : `${label}: ${summary}`;
  });
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
  // The lines above show summaries only, so Details is the one route to the raw
  // forge text (an outage's host and OS reason ride only there).
  const details =
    errors.length === 1
      ? presentError(errors[0].error)
      : composedErrorPresentation(
          "Couldn't load your work",
          errors.map((e) => e.error),
          errors.map((e) => providerLabel(e.provider)),
        );
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
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => useErrorDialog.getState().open(details)}
        >
          Details
        </Button>
      </div>
    </div>
  );
}
