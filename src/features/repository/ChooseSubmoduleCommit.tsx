import { CaretLeftIcon, WarningIcon } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { ListRowSkeletons } from "@/components/list-row-skeleton";
import { PathText } from "@/components/path-text";
import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxTrigger,
} from "@/components/ui/combobox";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  DegradedListNotice,
  useRetryFocusRescue,
} from "@/features/conversations/ConversationListPanel";
import {
  listNotice,
  splitInfiniteFailure,
} from "@/features/conversations/remote-section-state";
import { clipTitle, clipTitleFromText } from "@/lib/clip-title";
import { appErrorDetail, presentError } from "@/lib/error-summary";
import { focusIsLost } from "@/lib/focus-lost";
import {
  isShaPrefixQuery,
  isSubmoduleFetchPending,
  isSubmodulePickPending,
  submodulePickKeys,
  useFetchSubmodule,
  useSetSubmoduleCommit,
  useSubmoduleCommits,
  useSubmoduleFetchPending,
  useSubmodulePickPending,
  useSubmodulePickPlan,
  useSubmoduleRefs,
} from "@/lib/git/queries";
import type {
  SubmoduleCheckout,
  SubmodulePickBlock,
  SubmodulePickOutcome,
  SubmodulePickRead,
  SubmodulePickRelation,
  SubmodulePickUnstaged,
  SubmoduleRef,
  SubmoduleRefCommit,
  SubmoduleRefs,
} from "@/lib/git/types";
import { hasChordModifier } from "@/lib/hotkeys/binding";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { OFFLINE_WRITE_REASON } from "@/lib/offline-writes";
import { landedIn, refuseIfSwitched } from "@/lib/stores/notifications";
import { toastError } from "@/lib/toast";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { useDisabledReason } from "@/lib/use-disabled-reason";
import { useLatestRef } from "@/lib/use-latest-ref";
import { useOnline } from "@/lib/use-online";
import { cn } from "@/lib/utils";

const PICKING_REASON = "Checking out and staging…";
const LOADING_REASON = "Loading commits…";
const CHECKING_REASON = "Checking this commit…";
const LOOKUP_FAILED_REASON = "Couldn't look up that commit id.";
const FETCHING_REASON = "Fetching…";

/** ARIA_DISABLED_CLASS's dim without its `pointer-events-none`: the held ref
 *  trigger shows its reason as its own hover title. */
const HELD_TRIGGER_CLASS =
  "aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:focus-visible:opacity-100";

/** How long the highlight holds before its plan read is asked: the read costs a
 *  dozen git spawns, so arrowing through rows asks nothing. */
const PLAN_DEBOUNCE_MS = 150;
const SEARCH_DEBOUNCE_MS = 200;

/** Paths a would-overwrite note lists before it summarizes the rest; the
 *  backend lists at most PATHS_CAP (its `PICK_PATHS_CAP` in
 *  src-tauri/src/git/submodule.rs; change both together), so a full list can't
 *  give a count. */
const PATHS_SHOWN = 5;
const PATHS_CAP = 20;

const short = (sha: string) => sha.slice(0, 7);
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

type GroupKind = "remote" | "branch" | "tag";

const GROUP_LABEL: Record<GroupKind, string> = {
  remote: "Remote branches",
  branch: "Branches",
  tag: "Tags",
};

/** The trigger's word after a name another group also lists. */
const TWIN_CUE: Record<GroupKind, string> = {
  remote: "remote branch",
  branch: "branch",
  tag: "tag",
};

/** What sits at the path when no git can run inside it. */
const UNUSABLE_COPY: Record<
  Exclude<SubmoduleCheckout, "ok">,
  (p: string) => string
> = {
  notInitialized: (p) =>
    `${p} isn't initialized. Initialize it from the list first.`,
  missing: (p) =>
    `${p}'s folder is missing. Initialize it from the list first.`,
  replaced: (p) =>
    `Something other than a submodule checkout sits where ${p} should be.`,
  unreadable: (p) => `${p} couldn't be read.`,
};

/** The footer note: `lead` is also the button's reason when the note blocks. */
interface Note {
  lead: string;
  rest?: string;
  detail?: string | null;
  paths?: string[];
  more?: string | null;
  advisory?: boolean;
  emphasis?: "fetch" | "full" | null;
  checkAgain?: "read" | "check" | null;
  blocks: boolean;
}

interface BlockContext {
  p: string;
  reason: string | null;
  paths: string[];
  shallow: boolean | null;
  /** A fetch succeeded in this picker and this answer is newer than it. */
  refetched: boolean;
  /** The plan read predicts with git's dry run, which names only the first
   *  path it would overwrite (or the ignored ones); the setter lists git's own
   *  list, up to PATHS_CAP. */
  partialPaths: boolean;
}

/** "and N more" past the shown paths; at the backend's cap the count is
 *  unknown, so it says "and more". A partial list never reads as complete. */
function morePaths(paths: string[], partial: boolean): string | null {
  if (paths.length >= PATHS_CAP) return "and more";
  if (paths.length > PATHS_SHOWN) {
    const more = `and ${paths.length - PATHS_SHOWN} more`;
    return partial ? `${more}, possibly others` : more;
  }
  return partial ? "and possibly others" : null;
}

/** Splits off the first sentence, which is also Apply's reason. */
function firstSentence(text: string): Pick<Note, "lead" | "rest"> {
  const m = /^(.*?[.!?])\s+(\S[\s\S]*)$/.exec(text);
  return m === null ? { lead: text } : { lead: m[1], rest: m[2] };
}

/** git's reason ends a sentence before the app's own sentence follows it. */
function asSentence(text: string): string {
  const t = text.trimEnd();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

const BLOCK_NOTE: Record<SubmodulePickBlock, (c: BlockContext) => Note> = {
  wouldOverwrite: (c) => ({
    lead: `${c.p} has local changes this commit would overwrite.`,
    rest: `Commit or stash them inside ${c.p} first.`,
    detail: c.reason,
    paths: c.paths.slice(0, PATHS_SHOWN),
    more: morePaths(c.paths, c.partialPaths),
    blocks: true,
  }),
  untrackedInTheWay: (c) => ({
    lead: `${c.p} has untracked files in the way of this commit.`,
    rest: `Move or delete them inside ${c.p} first, or stash them with untracked files included.`,
    detail: c.reason,
    paths: c.paths.slice(0, PATHS_SHOWN),
    more: morePaths(c.paths, c.partialPaths),
    blocks: true,
  }),
  ignoredInTheWay: (c) => ({
    lead: `${c.p} has ignored files where this commit adds or removes files.`,
    rest: `Move or delete them inside ${c.p} first.`,
    detail: c.reason,
    paths: c.paths.slice(0, PATHS_SHOWN),
    more: morePaths(c.paths, c.partialPaths),
    blocks: true,
  }),
  detachedOrphan: (c) => ({
    lead: `${c.p} has commits only its detached HEAD holds.`,
    rest: `Create a branch for them inside ${c.p} first, or they'd be left behind.`,
    blocks: true,
  }),
  detachedUnverified: (c) =>
    c.shallow === true
      ? {
          lead: `Can't confirm that the commits ${c.p} has checked out are saved on a branch, because its history is shallow.`,
          rest: "Use Fetch full history under the list, then try again.",
          emphasis: "full",
          blocks: true,
        }
      : {
          lead: `Can't confirm that the commits ${c.p} has checked out are saved on a branch.`,
          detail: c.reason,
          blocks: true,
        },
  notFetched: (c) =>
    c.refetched
      ? {
          lead: `${c.p} still doesn't have this commit after fetching.`,
          rest: "Its remote may not share it on any branch.",
          blocks: true,
        }
      : {
          lead: `${c.p} doesn't have this commit yet.`,
          rest: "Fetch, then try again.",
          emphasis: "fetch",
          blocks: true,
        },
  midOperation: (c) => ({
    ...firstSentence(
      c.reason !== null
        ? appErrorDetail("invalidArgument", c.reason)
        : "Another operation is in progress in this repository. Finish or abort it first.",
    ),
    blocks: true,
  }),
  submoduleMidOperation: (c) => {
    switch (true) {
      case c.reason === null:
        return {
          lead: `A conflict, merge, rebase, cherry-pick or revert is in progress inside ${c.p}.`,
          rest: "Finish or abort it there first.",
          blocks: true,
        };
      // The contract's phrase for unmerged index entries, which resolving clears.
      case c.reason === "unresolved conflicts":
        return {
          lead: `Resolve the conflicts inside ${c.p} first.`,
          blocks: true,
        };
      default:
        return {
          lead: `Finish or abort ${c.reason} inside ${c.p} first.`,
          blocks: true,
        };
    }
  },
  noPointer: (c) => ({
    lead: `This repository has no commit recorded for ${c.p} to change.`,
    rest: `If ${c.p} is conflicted, resolve it in Changes; if it is no longer a submodule here, add it again from the list.`,
    blocks: true,
  }),
  notInitialized: (c) => ({
    lead: `${c.p} isn't initialized.`,
    rest: "Initialize it from the list first.",
    blocks: true,
  }),
  unusable: (c) => ({
    lead: `${c.p} can't be used as a submodule checkout.`,
    detail: c.reason,
    blocks: true,
  }),
  notFound: (c) => ({
    lead: `No commit in ${c.p} matches that id.`,
    blocks: true,
  }),
  ambiguous: (c) => ({
    lead: "More than one commit starts with that id.",
    rest: "Paste more of it.",
    detail: c.reason,
    blocks: true,
  }),
  notACommit: () => ({ lead: "That id isn't a commit.", blocks: true }),
  checkFailed: (c) => ({
    lead: "Couldn't check whether this commit is safe to check out.",
    detail: c.reason,
    checkAgain: "check",
    blocks: true,
  }),
};

/** Blocks a read answers before it resolves the id (`sha` null): they stop
 *  every id, so a pasted one's lookup line and Apply say which. */
const PRE_RESOLUTION: ReadonlySet<SubmodulePickBlock> = new Set([
  "notInitialized",
  "unusable",
  "noPointer",
  "midOperation",
  "submoduleMidOperation",
  "checkFailed",
]);

/** What a ready checkout does, by how the commit relates to the recorded one.
 *  `diverged` claims another line of history only on complete history. */
const RELATION_NOTE: Record<
  SubmodulePickRelation["kind"],
  (
    p: string,
    s: string,
    r: SubmodulePickRelation,
    shallow: boolean | null,
  ) => string
> = {
  forward: (p, _s, r) =>
    `Moves ${p} forward ${plural(r.kind === "forward" ? r.ahead : 0, "commit")}.`,
  rewind: (p, _s, r) =>
    `Moves ${p} back ${plural(r.kind === "rewind" ? r.behind : 0, "commit")}.`,
  diverged: (p, s, _r, shallow) =>
    shallow === false
      ? `Moves ${p} to a commit on a different line of history.`
      : `Moves ${p} to ${s}.`,
  same: (p, s) =>
    `Checks ${p} out at ${s}, the commit this repository already records.`,
  unknown: (p, s) => `Moves ${p} to ${s}.`,
};

/** The checked-out-but-not-staged toast; `at` is the short id plus any repo
 *  suffix. */
const UNSTAGED_COPY: Record<
  SubmodulePickUnstaged,
  {
    headline: (p: string, at: string) => string;
    description: (p: string) => string;
    showsReason: boolean;
  }
> = {
  pointerMoved: {
    headline: (p, at) =>
      `${p} is checked out at ${at}, but the new commit isn't staged.`,
    description: (p) =>
      `Its recorded commit changed while the checkout ran. Stage ${p} in Changes to finish.`,
    showsReason: true,
  },
  stageFailed: {
    headline: (p, at) =>
      `${p} is checked out at ${at}, but the new commit isn't staged.`,
    description: (p) => `Stage ${p} in Changes to finish.`,
    showsReason: true,
  },
  stageUnconfirmed: {
    headline: (p, at) =>
      `${p} is checked out at ${at}, but staging it couldn't be confirmed.`,
    description: (p) =>
      `The staged commit couldn't be read back, so it may or may not have landed. Check ${p} in Changes and stage it there if it isn't.`,
    showsReason: true,
  },
};

function planNote(
  read: SubmodulePickRead,
  p: string,
  s: string,
  refetched: boolean,
): Note {
  const advisory = read.commit?.onRemote === false;
  switch (read.plan.kind) {
    case "current":
      return {
        lead: `${p} already points at this commit.`,
        advisory,
        blocks: true,
      };
    case "ready":
      return {
        lead:
          read.plan.checkout === "alreadyThere"
            ? `Stages ${s}, which ${p} already has checked out.`
            : RELATION_NOTE[read.relation.kind](
                p,
                s,
                read.relation,
                read.shallow,
              ),
        advisory,
        blocks: false,
      };
    case "blocked":
      return BLOCK_NOTE[read.plan.why]({
        p,
        reason: read.plan.reason,
        paths: read.plan.paths,
        shallow: read.shallow,
        refetched,
        partialPaths: true,
      });
  }
}

const noteKey = (n: Note) => JSON.stringify(n);

/** The dialog popup, where Base UI parks focus a removed control held. */
const popupOf = (node: Element | null) =>
  node?.closest('[role="dialog"]') ?? null;

/** A row of the list: a commit, or a pasted full id not fetched yet. */
interface PickRow {
  sha: string;
  commit: SubmoduleRefCommit | null;
}

interface RefEntry {
  ref: SubmoduleRef;
  kind: GroupKind;
}

/** The tracked branch, then the first remote branch, branch, tag, then the
 *  checked-out commit. */
function defaultRevOf(r: SubmoduleRefs): string | null {
  return (
    r.defaultRev ??
    r.remoteBranches[0]?.rev ??
    r.branches[0]?.rev ??
    r.tags[0]?.rev ??
    r.head
  );
}

/** ASCII control characters become spaces: a pasted tab-separated line still
 *  searches its words. */
function cleanSearch(text: string): string | null {
  const cleaned = Array.from(text, (c) => {
    const n = c.charCodeAt(0);
    return n < 0x20 || n === 0x7f ? " " : c;
  })
    .join("")
    .trim();
  return cleaned === "" ? null : cleaned;
}

/**
 * The Submodules dialog's "Choose commit" body: one ref's history inside the
 * submodule at `path`, a note saying what applying the highlighted commit would
 * do, and one button that checks it out and stages it. Rendered keyed per repo
 * and path, inside the dialog's own content.
 */
export function ChooseSubmoduleCommit({
  repoPath,
  path,
  title,
  isOpen,
  onBack,
  onDone,
}: {
  repoPath: string;
  path: string;
  /** The dialog's `DialogTitle`, spelled where its `DialogContent` is so the
   *  title-inset scan can classify it; it renders in a `pr-8` row here. */
  title: ReactNode;
  /** Whether the dialog is still open, read at settle time. */
  isOpen: () => boolean;
  onBack: () => void;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const online = useOnline();
  const refs = useSubmoduleRefs(repoPath, path);
  const pick = useSetSubmoduleCommit(repoPath, path);
  const fetchSub = useFetchSubmodule(repoPath, path);
  const pickPending = useSubmodulePickPending(repoPath, path);
  const fetchPending = useSubmoduleFetchPending(repoPath, path);

  const [pickedRev, setPickedRev] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // The row the user moved to, and the paste whose pin was shown when they did:
  // a pin outranks a move made before it landed or over another paste, so a
  // paste is what Apply acts on.
  const [userPick, setUserPick] = useState<{
    sha: string;
    overPaste: number | null;
  } | null>(null);
  // A setter refusal for the pressed commit outranks the plan read's note (the
  // plan is advisory) until the highlight moves by any route, another apply or
  // fetch starts, or Check again asks the plan afresh.
  const [heldBlock, setHeldBlock] = useState<{
    sha: string;
    outcome: Extract<SubmodulePickOutcome, { kind: "blocked" }>;
  } | null>(null);
  // Apply holds until a plan read newer than `stamp` lands for `sha`: after
  // `changed` the answer that lost the compare-and-swap must not be resent, and
  // after a held block's Check again the old answer is the one the setter refused.
  const [recheckHold, setRecheckHold] = useState<{
    sha: string;
    stamp: number;
  } | null>(null);
  const [fetchStamp, setFetchStamp] = useState<number | null>(null);
  const [lastNote, setLastNote] = useState<Note | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // Synchronous twin of the pending read, set before the call: two presses in
  // one tick both precede the mutation cache's notification. Handlers only.
  const pressing = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Entry lands in the search box after the opening menu or palette finishes
  // closing: Base UI's close-time focus return runs after a mount-time focus.
  // A refs answer that already removed the search parks it on the body, and the
  // search box's first mount takes it over while focus is still where entry put
  // it or fell to <body>; a key, a press or a focus move elsewhere ends the entry
  // first (every user route to <body> passes the first two). A fresh key or a
  // press before the frame also stands the frame down, leaving focus where the
  // user put it; a focus move doesn't, since Base UI's own return is one.
  const entryParked = useRef(false);
  useLayoutEffect(() => {
    let acted = false;
    const id = requestAnimationFrame(() => {
      if (acted) return;
      (searchRef.current ?? bodyRef.current)?.focus({ preventScroll: true });
      entryParked.current = searchRef.current === null;
    });
    const end = () => {
      entryParked.current = false;
    };
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (!e.repeat) acted = true;
      end();
    };
    const onPointerDown = () => {
      acted = true;
      end();
    };
    const onFocusIn = (e: FocusEvent) => {
      const t = e.target;
      if (t !== bodyRef.current && t !== popupOf(bodyRef.current)) end();
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("focusin", onFocusIn, true);
    return () => {
      cancelAnimationFrame(id);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("focusin", onFocusIn, true);
    };
  }, []);
  useLayoutEffect(() => {
    if (!entryParked.current || searchRef.current === null) return;
    entryParked.current = false;
    const active = document.activeElement;
    if (
      active === null ||
      active === document.body ||
      active === bodyRef.current ||
      active === popupOf(bodyRef.current)
    )
      searchRef.current.focus({ preventScroll: true });
  });

  const search = useDebouncedValue(cleanSearch(query), SEARCH_DEBOUNCE_MS);
  // Until the debounce catches up with the box, the rows and highlight answer
  // an older search: Apply would act on a commit the user typed past.
  const searchCaughtUp = (text: string) => cleanSearch(text) === search;
  const shaText =
    search !== null && isShaPrefixQuery(search) ? search.toLowerCase() : null;
  const lookup = useSubmodulePickPlan(repoPath, path, shaText);
  // Each pasted id the box takes is a new paste, the same id pasted again
  // included.
  const [pasteSeen, setPasteSeen] = useState(shaText);
  const [pasteGen, setPasteGen] = useState(0);
  if (pasteSeen !== shaText) {
    setPasteSeen(shaText);
    if (shaText !== null) setPasteGen(pasteGen + 1);
  }

  // An answer cached before this mount may paint data (rows, refs, the state
  // line) but never a verdict: a not-usable refs or commits answer, or any plan
  // or lookup answer. A masked verdict reads as loading until a re-read lands
  // (every pick read re-reads on observe), or as that read's failure. An answer
  // is read here when its own query, the one cached at open or a newer one
  // under its key, took data since: never a stamp, which two keys can share. A
  // refetch over data keeps status "error", hence isFetching.
  const [openCounts] = useState(
    () =>
      new Map(
        queryClient
          .getQueryCache()
          .findAll({ queryKey: submodulePickKeys.all(repoPath, path) })
          .map((q) => [
            q.queryHash,
            { query: q, count: q.state.dataUpdateCount },
          ]),
      ),
  );
  const freshInCache = (queryKey: readonly unknown[], data?: unknown) => {
    const q = queryClient.getQueryCache().find({ queryKey, exact: true });
    if (q === undefined || q.state.data === undefined) return false;
    if (data !== undefined && q.state.data !== data) return false;
    const open = openCounts.get(q.queryHash);
    return (
      open === undefined ||
      open.query !== q ||
      q.state.dataUpdateCount > open.count
    );
  };
  const readHere = (
    r: { data: unknown; isPlaceholderData: boolean },
    queryKey: readonly unknown[],
  ) =>
    r.data !== undefined &&
    !r.isPlaceholderData &&
    freshInCache(queryKey, r.data);
  const refsData =
    refs.data !== undefined &&
    refs.data.checkout !== "ok" &&
    !readHere(refs, submodulePickKeys.refs(repoPath, path))
      ? undefined
      : refs.data;
  const refsLoading =
    refsData === undefined && (refs.isFetching || !refs.isError);
  const refEntries = new Map<string, RefEntry>();
  const nameKinds = new Map<string, Set<GroupKind>>();
  const groups: { kind: GroupKind; items: string[] }[] = [];
  if (refsData) {
    for (const [kind, list] of [
      ["remote", refsData.remoteBranches],
      ["branch", refsData.branches],
      ["tag", refsData.tags],
    ] as const) {
      for (const ref of list) {
        refEntries.set(ref.rev, { ref, kind });
        const kinds = nameKinds.get(ref.name) ?? new Set<GroupKind>();
        kinds.add(kind);
        nameKinds.set(ref.name, kinds);
      }
      if (list.length > 0) groups.push({ kind, items: list.map((r) => r.rev) });
    }
  }
  const usableRefs = refsData?.checkout === "ok";
  const rev = ((): string | null => {
    switch (true) {
      case refsData === undefined || refsData.checkout !== "ok":
        return null;
      case pickedRev !== null && refEntries.has(pickedRev):
        return pickedRev;
      default:
        return defaultRevOf(refsData);
    }
  })();
  const revEntry = rev === null ? undefined : refEntries.get(rev);
  const refLabel =
    revEntry?.ref.name ??
    (rev !== null && rev === refsData?.head
      ? "Checked-out commit"
      : (rev ?? ""));
  const twin =
    revEntry !== undefined && (nameKinds.get(revEntry.ref.name)?.size ?? 0) > 1;

  const commits = useSubmoduleCommits(repoPath, path, rev, search);
  // A placeholder is never read here: it is another key's answer. Any
  // cached not-usable page is a verdict, a Load more page included.
  const commitsData =
    commits.data !== undefined &&
    commits.data.pages.some((p) => p.checkout !== "ok") &&
    !readHere(
      commits,
      submodulePickKeys.commits(repoPath, path, rev ?? "", search),
    )
      ? undefined
      : commits.data;
  const pages = commitsData?.pages ?? [];

  // Not usable: the refs read, or a commits page, says no git can run inside.
  // The newest such page speaks; the mask above keeps a cached one off screen.
  const unusablePage = pages.findLast((p) => p.checkout !== "ok");
  const unusableKind = ((): Exclude<SubmoduleCheckout, "ok"> | null => {
    switch (true) {
      case refsData !== undefined && refsData.checkout !== "ok":
        return refsData.checkout;
      case unusablePage !== undefined && unusablePage.checkout !== "ok":
        return unusablePage.checkout;
      default:
        return null;
    }
  })();
  const unusableReason =
    refsData && refsData.checkout !== "ok"
      ? refsData.reason
      : (unusablePage?.reason ?? null);
  const unusableText =
    unusableKind === null ? null : UNUSABLE_COPY[unusableKind](path);
  const refsFailed = refsData === undefined && refs.isError && !refsLoading;

  // The pasted id's lookup pins its commit above the page rows.
  const lookupRead =
    shaText !== null &&
    readHere(lookup, submodulePickKeys.plan(repoPath, path, shaText))
      ? lookup.data
      : undefined;
  const pin: PickRow | null = (() => {
    if (!lookupRead || lookupRead.sha === null) return null;
    if (lookupRead.commit !== null)
      return { sha: lookupRead.sha, commit: lookupRead.commit };
    if (
      lookupRead.plan.kind === "blocked" &&
      lookupRead.plan.why === "notFetched"
    )
      return { sha: lookupRead.sha, commit: null };
    return null;
  })();
  // No ref to list, but a pasted id the lookup resolved is still a row to pick.
  const unborn = usableRefs && rev === null && pin === null;
  const lookupBlock =
    lookupRead !== undefined &&
    lookupRead.sha === null &&
    lookupRead.plan.kind === "blocked" &&
    PRE_RESOLUTION.has(lookupRead.plan.why)
      ? BLOCK_NOTE[lookupRead.plan.why]({
          p: path,
          reason: lookupRead.plan.reason,
          paths: lookupRead.plan.paths,
          shallow: lookupRead.shallow,
          refetched: false,
          partialPaths: true,
        }).lead
      : null;
  // A pasted id whose lookup is running, or has no answer read here yet, may
  // still pin another row above whatever the search listed, so Apply waits for
  // it; a cached answer shown meanwhile may predate a fetch.
  const lookupLoading =
    shaText !== null &&
    (lookup.isFetching || (lookupRead === undefined && !lookup.isError));
  // A failed lookup still holds Apply: the user typed an exact id, so a row the
  // message search listed must never be applied in its place.
  const lookupFailed =
    shaText !== null &&
    lookupRead === undefined &&
    lookup.isError &&
    !lookup.isFetching;
  const seen = new Set<string>(pin ? [pin.sha] : []);
  const pageRows: PickRow[] = [];
  for (const page of pages)
    for (const c of page.commits) {
      if (seen.has(c.sha)) continue;
      seen.add(c.sha);
      pageRows.push({ sha: c.sha, commit: c });
    }
  const rows: PickRow[] = pin ? [pin, ...pageRows] : pageRows;
  const placeholder = commitsData !== undefined && commits.isPlaceholderData;

  const pointer = refsData?.pointer ?? null;
  const highlighted = ((): string | null => {
    switch (true) {
      case userPick !== null &&
        seen.has(userPick.sha) &&
        (pin === null || userPick.overPaste === pasteGen):
        return userPick.sha;
      case pin !== null:
        return pin.sha;
      case pointer !== null && seen.has(pointer):
        return pointer;
      default:
        return rows[0]?.sha ?? null;
    }
  })();
  const highlightRef = useLatestRef(highlighted);
  // Any move of the highlight drops a held block, a derived one included (a
  // search that drops the commit), so it never returns with the commit.
  const [blockShownFor, setBlockShownFor] = useState(highlighted);
  if (blockShownFor !== highlighted) {
    setBlockShownFor(highlighted);
    if (heldBlock !== null) setHeldBlock(null);
  }

  // The plan for the highlighted commit, once it held still; a pinned full id
  // shares the lookup's key, so it is one read.
  const planSha = useDebouncedValue(highlighted, PLAN_DEBOUNCE_MS);
  const plan = useSubmodulePickPlan(repoPath, path, planSha);
  const planForThis = highlighted !== null && planSha === highlighted;
  const planRead =
    planForThis &&
    readHere(plan, submodulePickKeys.plan(repoPath, path, planSha ?? ""))
      ? plan.data
      : undefined;
  const rechecking =
    planForThis &&
    recheckHold !== null &&
    recheckHold.sha === highlighted &&
    plan.dataUpdatedAt <= recheckHold.stamp;
  // A held re-read that failed settles as a failed check, never a hold that
  // waits for an answer nothing is asking for.
  const recheckFailed =
    rechecking &&
    plan.isError &&
    !plan.isFetching &&
    recheckHold !== null &&
    plan.errorUpdatedAt > recheckHold.stamp;
  const planFailed =
    planForThis &&
    ((planRead === undefined && plan.isError && !plan.isFetching) ||
      recheckFailed);
  const planChecking =
    highlighted !== null &&
    (!planForThis ||
      (planRead === undefined && (plan.isFetching || !plan.isError)) ||
      (rechecking && !recheckFailed));

  const refetched =
    fetchStamp !== null &&
    planRead !== undefined &&
    plan.dataUpdatedAt > fetchStamp;
  const s = highlighted === null ? "" : short(highlighted);
  const heldNote =
    heldBlock !== null && heldBlock.sha === highlighted
      ? BLOCK_NOTE[heldBlock.outcome.why]({
          p: path,
          reason: heldBlock.outcome.reason,
          paths: heldBlock.outcome.paths,
          shallow: planRead?.shallow ?? null,
          refetched,
          partialPaths: false,
        })
      : null;
  const showList = unusableText === null && !refsFailed;
  // A note describes the highlighted row, so it never outlives the list.
  const noteApplies = showList && highlighted !== null;
  const settledNote: Note | null = (() => {
    if (!noteApplies || planChecking) return null;
    if (heldNote !== null) return heldNote;
    if (planFailed)
      return {
        lead: "Couldn't check this commit.",
        detail: presentError(plan.error).summary,
        checkAgain: "read",
        blocks: true,
      };
    if (planRead === undefined) return null;
    return planNote(planRead, path, s, refetched);
  })();
  // The live region speaks settled notes only, once per change; while a check
  // runs it keeps its last text, hidden, so arrowing announces nothing. With no
  // row to describe it empties, so a hidden note can't outlive its commit.
  if (!noteApplies) {
    if (lastNote !== null) setLastNote(null);
  } else if (
    settledNote !== null &&
    (lastNote === null || noteKey(lastNote) !== noteKey(settledNote))
  )
    setLastNote(settledNote);

  const shallow =
    pages.some((p) => p.shallow === true) ||
    refsData?.shallow === true ||
    planRead?.shallow === true;
  // A failed first page says so even beside a pinned pasted id.
  const commitsFailed =
    rev !== null &&
    commitsData === undefined &&
    commits.isError &&
    !commits.isFetching;
  const failedNoRows = commitsFailed && rows.length === 0;
  const commitsLoading =
    rev !== null &&
    commitsData === undefined &&
    (commits.isFetching || !commits.isError);
  const emptyRead =
    rev !== null &&
    commitsData !== undefined &&
    !placeholder &&
    rows.length === 0;

  // One ranked, total reason; the first term that holds Apply names it.
  const applyReason = ((): string | null => {
    switch (true) {
      case pickPending:
        return PICKING_REASON;
      case unusableText !== null:
        return unusableText;
      case refsFailed:
        return `${path}'s branches and tags couldn't be read`;
      case refsLoading ||
        commitsLoading ||
        lookupLoading ||
        !searchCaughtUp(query):
        return LOADING_REASON;
      case lookupFailed:
        return LOOKUP_FAILED_REASON;
      case unborn:
        return `${path} has no commits yet.`;
      case lookupBlock !== null:
        return lookupBlock;
      case failedNoRows:
        return "Commits couldn't be loaded";
      case emptyRead:
        return "No commits to pick from";
      // A new search over rows that matched nothing has no row to highlight yet.
      case placeholder:
        return LOADING_REASON;
      case highlighted === null:
        return "Pick a commit first";
      case planChecking:
        return CHECKING_REASON;
      case planFailed:
        return "This commit couldn't be checked";
      case heldNote !== null:
        return heldNote.lead;
      case settledNote?.blocks === true:
        return settledNote.lead;
      default:
        return null;
    }
  })();

  async function apply() {
    if (applyReason !== null || planRead === undefined) return;
    // The box's text at the event: a paste can precede the render that holds.
    if (!searchCaughtUp(searchRef.current?.value ?? query)) return;
    // The lookup's state at the event: a re-read can start, answer or fail
    // before the render that holds, and its answer may pin another row.
    if (shaText !== null) {
      const live = queryClient.getQueryState(
        submodulePickKeys.plan(repoPath, path, shaText),
      );
      if (
        live?.fetchStatus === "fetching" ||
        live?.dataUpdatedAt !== lookup.dataUpdatedAt ||
        live.errorUpdatedAt !== lookup.errorUpdatedAt ||
        (live.status === "error" &&
          !freshInCache(submodulePickKeys.plan(repoPath, path, shaText)))
      )
        return;
    }
    if (pressing.current || isSubmodulePickPending(queryClient, repoPath, path))
      return;
    if (refuseIfSwitched(repoPath, "nothing was checked out")) return;
    // Both ids come from the ONE plan read that passed the gate: the pair is the
    // setter's compare-and-swap token.
    const { sha, pointer: expected } = planRead;
    if (sha === null || expected === null) return;
    const pressed = { sha, expected, startedIn: repoPath };
    pressing.current = true;
    setHeldBlock(null);
    try {
      const outcome = await pick.mutateAsync({
        sha,
        expectedIndexSha: expected,
      });
      report(outcome, pressed);
    } catch (e) {
      toastError(e);
    } finally {
      pressing.current = false;
    }
  }

  function report(
    outcome: SubmodulePickOutcome,
    pressed: { sha: string; expected: string; startedIn: string },
  ) {
    const { away, live } = landedIn(pressed.startedIn);
    const ui = mounted.current && isOpen() && live;
    const ps = short(pressed.sha);
    // Apply waits for a plan read newer than the one this press sent.
    const holdForRecheck = () => {
      const state = queryClient.getQueryState(
        submodulePickKeys.plan(repoPath, path, pressed.sha),
      );
      if (mounted.current)
        setRecheckHold({
          sha: pressed.sha,
          stamp: state?.dataUpdatedAt ?? 0,
        });
    };
    switch (outcome.kind) {
      case "set": {
        const nested =
          outcome.nestedLeft !== null && outcome.nestedLeft > 0
            ? {
                description: `Its own submodules still need updating; use ${path}'s Update in this list.`,
              }
            : undefined;
        // Only a moved pointer leaves anything staged.
        toast.success(
          pressed.expected === pressed.sha
            ? `${path} is checked out at ${ps}${away}, the commit this repository already records.`
            : `${path} now points at ${ps}${away}, staged for you to commit.`,
          nested,
        );
        if (ui) onDone();
        return;
      }
      case "changed": {
        // Either the recorded commit or the checkout itself moved.
        toast.info(
          `${path} changed${away} while this ran; nothing was staged.`,
          {
            description: `${ps} wasn't checked out. Look again before picking.`,
          },
        );
        holdForRecheck();
        return;
      }
      case "movedAfter": {
        const { head, pointer } = outcome;
        const headClause =
          head === null
            ? "Its folder no longer holds that checkout."
            : `It's now at ${short(head)}.`;
        // What the index records now, never whether this call wrote: the
        // setter skips an unchanged pointer, and an outside write can undo one.
        const pointerClause = (() => {
          switch (true) {
            case pointer === pressed.sha:
              return `Its recorded commit is ${ps}, the one you picked.`;
            case pointer === null:
              return "This repository no longer records a commit for it.";
            default:
              return `Its recorded commit is ${short(pointer)}.`;
          }
        })();
        toast.warning(`${path} moved${away} after ${ps} was checked out.`, {
          description: `${headClause} ${pointerClause} Look again before picking.`,
          duration: 10_000,
        });
        holdForRecheck();
        return;
      }
      case "readBackFailed":
        toast.warning(
          `${ps} was checked out in ${path}${away}, but its state couldn't be read back.`,
          {
            description: `${asSentence(outcome.reason)} Check ${path} in Changes, then look again before picking.`,
            duration: 10_000,
          },
        );
        holdForRecheck();
        return;
      case "blocked": {
        if (ui && highlightRef.current === pressed.sha) {
          setHeldBlock({ sha: pressed.sha, outcome });
          return;
        }
        const note = BLOCK_NOTE[outcome.why]({
          p: path,
          reason: outcome.reason,
          paths: outcome.paths,
          shallow: null,
          refetched: false,
          partialPaths: false,
        });
        toast.error(`Didn't check out ${ps} in ${path}${away}.`, {
          description: note.lead,
        });
        return;
      }
      case "checkoutFailed":
        toast.error(
          `Checking out ${ps} in ${path}${away} didn't finish. Nothing was staged.`,
          {
            description: `${asSentence(outcome.reason)} ${path}'s own checkout may have changed.`,
          },
        );
        return;
      case "checkedOutNotStaged": {
        const copy = UNSTAGED_COPY[outcome.why];
        toast.warning(copy.headline(path, `${ps}${away}`), {
          description:
            copy.showsReason && outcome.reason
              ? `${copy.description(path)} ${asSentence(outcome.reason)}`
              : copy.description(path),
          duration: 10_000,
        });
        return;
      }
    }
  }

  const fetchReason = ((): string | null => {
    switch (true) {
      case !online:
        return OFFLINE_WRITE_REASON;
      case fetchPending !== null:
        return FETCHING_REASON;
      case pickPending:
        return PICKING_REASON;
      default:
        return null;
    }
  })();

  async function runFetch(unshallow: boolean) {
    if (fetchReason !== null) return;
    if (
      isSubmodulePickPending(queryClient, repoPath, path) ||
      isSubmoduleFetchPending(queryClient, repoPath, path)
    )
      return;
    const startedIn = repoPath;
    setHeldBlock(null);
    try {
      const result = await fetchSub.mutateAsync({ unshallow });
      const { away } = landedIn(startedIn);
      // A failed shallow read after the fetch claims neither outcome.
      if (!unshallow || result.shallow === null)
        toast.success(`Fetched ${path}${away}.`);
      else if (result.shallow === true)
        toast.info(
          `Fetched what ${path}'s remote has${away}; it is itself shallow, so older history is still missing.`,
        );
      else toast.success(`Fetched ${path}'s full history${away}.`);
      if (mounted.current) setFetchStamp(Date.now());
    } catch (e) {
      toastError(e);
    }
  }

  function moveHighlight(sha: string) {
    setUserPick({ sha, overPaste: pin === null ? null : pasteGen });
  }

  // A held block's Check again asks the plan afresh and holds Apply until that
  // answer lands: re-applying the old one would only meet the same refusal.
  function checkAgain() {
    if (heldNote !== null && highlighted !== null) {
      setHeldBlock(null);
      setRecheckHold({ sha: highlighted, stamp: plan.dataUpdatedAt });
    }
    void plan.refetch();
  }

  const nav = listKeyboardNav<PickRow>({
    items: rows,
    activeIndex: rows.findIndex((r) => r.sha === highlighted),
    onActivate: (row) => moveHighlight(row.sha),
    rowKey: (r) => r.sha,
    rowAttr: "data-pick-row",
  });

  function focusRow(sha: string) {
    const el = document.querySelector<HTMLElement>(
      `[data-pick-row="${CSS.escape(sha)}"]`,
    );
    el?.focus();
    el?.scrollIntoView({ block: "nearest" });
  }

  function onListKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Enter") {
      if (hasChordModifier(e) || e.repeat) return;
      if (!(e.target instanceof HTMLElement)) return;
      if (e.target.closest("[data-pick-row]") === null) return;
      e.preventDefault();
      void apply();
      return;
    }
    if (e.key === "Home" || e.key === "End") {
      if (hasChordModifier(e) || rows.length === 0) return;
      e.preventDefault();
      const row = e.key === "Home" ? rows[0] : rows[rows.length - 1];
      moveHighlight(row.sha);
      focusRow(row.sha);
      return;
    }
    nav(e);
  }

  function onSearchKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (
      e.key !== "ArrowDown" ||
      e.shiftKey ||
      hasChordModifier(e) ||
      highlighted === null
    )
      return;
    e.preventDefault();
    focusRow(highlighted);
  }

  // A focused row that leaves the list (a refresh, a narrowed search) hands
  // focus to the search box. Read in the ref cleanup, which runs just before
  // React removes the node.
  const rowLeftWithFocus = useRef(false);
  const rowRef = useCallback(
    (node: HTMLElement | null) => () => {
      if (node?.contains(document.activeElement))
        rowLeftWithFocus.current = true;
    },
    [],
  );
  useLayoutEffect(() => {
    if (!rowLeftWithFocus.current) return;
    rowLeftWithFocus.current = false;
    if (focusIsLost()) searchRef.current?.focus({ preventScroll: true });
  });

  const refsRescue = useRetryFocusRescue(refsFailed);
  const unusableRescue = useRetryFocusRescue(unusableText !== null);
  const commitsRescue = useRetryFocusRescue(commitsFailed);
  // Placeholder rows carry no `hasNextPage` of their own (react-query derives it
  // from the new key's data), so their last page decides; the button is held.
  const moreShown =
    rows.length > 0 &&
    (placeholder ? pages.at(-1)?.hasMore === true : commits.hasNextPage);
  const moreRescue = useRetryFocusRescue(moreShown);
  const readRetryRescue = useRetryFocusRescue(
    settledNote?.checkAgain === "read",
  );
  const checkRetryRescue = useRetryFocusRescue(
    settledNote?.checkAgain === "check",
  );

  const notice =
    commitsData === undefined
      ? null
      : listNotice({
          noun: "commits",
          ...splitInfiniteFailure(commits),
          offline: false,
          placeholder: false,
          hasRows: rows.length > 0,
        });

  const stateLine = (() => {
    if (!refsData || refsData.checkout !== "ok") return null;
    const records =
      refsData.pointer === null
        ? "Records no commit"
        : `Records ${short(refsData.pointer)}`;
    const head =
      refsData.head === null
        ? "nothing checked out"
        : `checked out ${short(refsData.head)}`;
    return `${records} · ${head}`;
  })();

  const backReason = pickPending ? PICKING_REASON : null;
  const emphasis = settledNote?.emphasis ?? null;
  const moreHeld = placeholder || commits.isFetchingNextPage;
  // The refs answer can remove the list with focus inside it (not usable, or
  // failed): focus then lands on the body, which outlives it. The rescues
  // nested in the list unmount with their hosts in the same commit.
  const listRescue = useRetryFocusRescue(showList);
  // Fetch full history's success removes its notice: the search box takes the
  // focus, before Base UI's dialog would park it on the popup.
  const shallowRescue = useRetryFocusRescue(showList && shallow);
  // The combobox cancels a change while a pick runs; its trigger says why.
  const refHold = useDisabledReason({
    disabled: pickPending,
    reason: PICKING_REASON,
  });
  const refHeld = refHold.blockedReason !== null;

  return (
    <>
      <DialogHeader>
        <div className="flex items-center gap-2 pr-8">
          <DisabledReasonButton
            variant="ghost"
            size="icon-sm"
            disabled={backReason !== null}
            reason={backReason}
            onClick={onBack}
            aria-label="Back to submodules"
          >
            <CaretLeftIcon />
          </DisabledReasonButton>
          {title}
        </div>
        <DialogDescription>
          <PathText path={path} className="font-mono" />
        </DialogDescription>
        {/* Holds its height while the refs load, and says nothing until then. */}
        <p className="min-h-4 text-[11px] text-muted-foreground">{stateLine}</p>
      </DialogHeader>

      <div
        ref={(node) => {
          refsRescue.hostRef(node);
          unusableRescue.hostRef(node);
          listRescue.hostRef(node);
          bodyRef.current = node;
        }}
        tabIndex={-1}
        className="min-w-0 space-y-2 outline-none"
      >
        {unusableText !== null && (
          <div className="border p-3 text-xs">
            <p>{unusableText}</p>
            {unusableKind === "unreadable" && unusableReason && (
              <p className="mt-1 text-muted-foreground">{unusableReason}</p>
            )}
            {/* An outside fix can change any verdict: re-read its source. */}
            <Button
              ref={unusableRescue.retryRef}
              variant="outline"
              size="xs"
              className="mt-2"
              onClick={() =>
                void (
                  refsData !== undefined && refsData.checkout !== "ok"
                    ? refs
                    : commits
                ).refetch()
              }
            >
              Retry
            </Button>
          </div>
        )}
        {unusableText === null && refsFailed && (
          <div className="border p-3 text-xs">
            <p>Couldn't read {path}'s branches and tags.</p>
            <p className="mt-1 text-muted-foreground">
              {presentError(refs.error).summary}
            </p>
            <Button
              ref={refsRescue.retryRef}
              variant="outline"
              size="xs"
              className="mt-2"
              onClick={() => void refs.refetch()}
            >
              Retry
            </Button>
          </div>
        )}
        {showList && (
          <div ref={listRescue.retryRef} className="min-w-0 space-y-2">
            <div className="flex min-w-0 items-center gap-2">
              <Combobox
                items={groups}
                value={rev}
                itemToStringLabel={(item: string) =>
                  refEntries.get(item)?.ref.name ?? item
                }
                // Typeahead on the closed trigger commits a match blind; every
                // item is a ref, so a commit can only switch the list.
                onValueChange={(next: string | null, details) => {
                  if (next === null || next === rev) return;
                  if (
                    pickPending ||
                    isSubmodulePickPending(queryClient, repoPath, path)
                  ) {
                    details.cancel();
                    return;
                  }
                  setPickedRev(next);
                }}
                onOpenChange={(next: boolean, details) => {
                  if (
                    next &&
                    (pickPending ||
                      isSubmodulePickPending(queryClient, repoPath, path))
                  )
                    details.cancel();
                }}
              >
                {/* Held, not disabled: the trigger keeps its pointer events so its
                    own title shows the reason, and onOpenChange refuses the open. */}
                <ComboboxTrigger
                  aria-label="Commits from"
                  aria-disabled={refHeld || undefined}
                  aria-describedby={refHold.describedBy}
                  title={refHold.wrapperTitle}
                  className={cn(
                    HELD_TRIGGER_CLASS,
                    "flex h-7 min-w-0 flex-1 items-center justify-between gap-1.5 rounded-none border border-input bg-transparent pr-2 pl-2.5 text-xs whitespace-nowrap outline-none select-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 dark:bg-input/30",
                  )}
                >
                  {/* While held the trigger's reason is the hover title across it:
                      the label remounts untitled and measures no clip. */}
                  <span
                    key={`${refLabel}:${twin}:${refHeld}`}
                    className="flex min-w-0 flex-1 items-baseline gap-1.5"
                  >
                    <span
                      className="min-w-0 truncate text-left"
                      onMouseEnter={refHeld ? undefined : clipTitleFromText}
                    >
                      {refLabel}
                    </span>
                    {twin && revEntry && (
                      <>
                        <span className="sr-only">,</span>{" "}
                        <span className="shrink-0 text-[10px] text-muted-foreground">
                          {TWIN_CUE[revEntry.kind]}
                        </span>
                      </>
                    )}
                  </span>
                </ComboboxTrigger>
                {refHeld && (
                  <span id={refHold.reasonId} className="sr-only">
                    {refHold.blockedReason}
                  </span>
                )}
                <ComboboxContent>
                  <ComboboxInput
                    showTrigger={false}
                    placeholder="Filter branches and tags…"
                  />
                  <ComboboxEmpty>
                    {refsLoading
                      ? "Loading branches and tags…"
                      : "No branches or tags match"}
                  </ComboboxEmpty>
                  <ComboboxList aria-label="Branches and tags">
                    {(group: { kind: GroupKind; items: string[] }) => (
                      <ComboboxGroup key={group.kind} items={group.items}>
                        <ComboboxLabel>{GROUP_LABEL[group.kind]}</ComboboxLabel>
                        <ComboboxCollection>
                          {(item: string) => {
                            const name = refEntries.get(item)?.ref.name ?? item;
                            return (
                              <ComboboxItem key={item} value={item}>
                                <span
                                  className="min-w-0 flex-1 truncate"
                                  onMouseEnter={clipTitle(name)}
                                >
                                  {name}
                                </span>
                              </ComboboxItem>
                            );
                          }}
                        </ComboboxCollection>
                      </ComboboxGroup>
                    )}
                  </ComboboxList>
                  {/* Not items: arrow keys skip them. */}
                  {refsData?.truncated && (
                    <p className="px-2 py-1.5 text-xs text-muted-foreground">
                      Showing 500 per group. Paste a commit id below to reach
                      any other commit.
                    </p>
                  )}
                  {refsData !== undefined && refsData.brokenRefs > 0 && (
                    <p className="px-2 py-1.5 text-xs text-muted-foreground">
                      {refsData.brokenRefs === 1
                        ? "1 ref points at a missing commit and isn't listed."
                        : `${refsData.brokenRefs} refs point at missing commits and aren't listed.`}
                    </p>
                  )}
                </ComboboxContent>
              </Combobox>
              <DisabledReasonButton
                variant={emphasis === "fetch" ? "default" : "outline"}
                size="sm"
                disabled={fetchReason !== null}
                reason={fetchReason}
                onClick={() => void runFetch(false)}
              >
                {fetchPending === "fetch" && (
                  <Spinner data-icon="inline-start" />
                )}
                Fetch
              </DisabledReasonButton>
            </div>

            <Input
              ref={(node) => {
                searchRef.current = node;
                shallowRescue.hostRef(node);
              }}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKeyDown}
              placeholder="Search commit messages, or paste a sha"
              aria-label="Search commits"
              autoComplete="off"
              spellCheck={false}
              className="h-7"
            />

            <div
              ref={(node) => {
                commitsRescue.hostRef(node);
                moreRescue.hostRef(node);
              }}
              tabIndex={-1}
              className="min-w-0 border outline-none"
            >
              <DegradedListNotice
                noun="commits"
                degraded={notice !== null}
                message={notice?.message}
                retryLabel={notice?.retryLabel}
                onRetry={
                  notice?.cause === "refresh"
                    ? () => void commits.refetch()
                    : undefined
                }
                className="border-b px-3 py-1.5"
              />
              {/* Outside the listbox, which holds options only. */}
              <DegradedListNotice
                noun="commit id lookup"
                degraded={lookupFailed}
                message={
                  lookupFailed
                    ? `${LOOKUP_FAILED_REASON} ${presentError(lookup.error).summary}`
                    : undefined
                }
                retryLabel="Retry looking up that commit id"
                onRetry={() => void lookup.refetch()}
                className="border-b px-3 py-1.5"
              />
              <ShaLookupLine
                path={path}
                shaText={shaText}
                lookup={lookupRead}
                blockLead={lookupBlock}
              />
              <div
                className="max-h-96 overflow-y-auto"
                aria-busy={placeholder || undefined}
              >
                {(() => {
                  switch (true) {
                    case unborn:
                      return (
                        <p className="p-3 text-[11px] text-muted-foreground">
                          {path} has no commits yet.
                        </p>
                      );
                    case refsLoading || (commitsLoading && rows.length === 0):
                      return (
                        <ListRowSkeletons rows={6} lines={2} name="commits" />
                      );
                    default:
                      return (
                        <>
                          <div
                            role="listbox"
                            aria-label={
                              rev === null
                                ? "Commits"
                                : `Commits on ${refLabel}`
                            }
                            aria-disabled={pickPending || undefined}
                            onKeyDown={onListKeyDown}
                            className={cn(placeholder && "opacity-60")}
                          >
                            {rows.map((row) => (
                              <CommitRow
                                key={row.sha}
                                row={row}
                                rowRef={rowRef}
                                highlighted={row.sha === highlighted}
                                pointer={refsData?.pointer ?? null}
                                head={refsData?.head ?? null}
                                onPick={() => moveHighlight(row.sha)}
                              />
                            ))}
                          </div>
                          {commitsFailed && (
                            <div className="p-3 text-xs">
                              <p>Couldn't load the commits on {refLabel}.</p>
                              <p className="mt-1 text-muted-foreground">
                                {presentError(commits.error).summary}
                              </p>
                              <Button
                                ref={commitsRescue.retryRef}
                                variant="outline"
                                size="xs"
                                className="mt-2"
                                onClick={() => void commits.refetch()}
                              >
                                Retry
                              </Button>
                            </div>
                          )}
                          {emptyRead && (
                            <p className="p-3 text-[11px] text-muted-foreground">
                              {search === null
                                ? `No commits on ${refLabel}.`
                                : `No commits on ${refLabel} match "${search}".`}
                            </p>
                          )}
                          {moreShown && (
                            <DisabledReasonButton
                              ref={moreRescue.retryRef}
                              variant="ghost"
                              size="xs"
                              wrapperClassName="flex w-full"
                              className="h-auto w-full gap-1.5 px-3 py-2 text-[11px] font-normal text-muted-foreground"
                              disabled={moreHeld}
                              reason={
                                commits.isFetchingNextPage
                                  ? "Loading more commits…"
                                  : LOADING_REASON
                              }
                              onClick={() => void commits.fetchNextPage()}
                            >
                              {commits.isFetchingNextPage && (
                                <Spinner data-icon="inline-start" />
                              )}
                              Load more
                            </DisabledReasonButton>
                          )}
                        </>
                      );
                  }
                })()}
              </div>
              {shallow && (
                <div
                  ref={shallowRescue.retryRef}
                  className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t px-3 py-1.5 text-[11px] text-muted-foreground"
                >
                  <span className="min-w-0 flex-1">
                    This submodule's history is shallow, so older commits aren't
                    listed.
                  </span>
                  <DisabledReasonButton
                    variant={emphasis === "full" ? "default" : "outline"}
                    size="xs"
                    disabled={fetchReason !== null}
                    reason={fetchReason}
                    onClick={() => void runFetch(true)}
                  >
                    {fetchPending === "full" && (
                      <Spinner data-icon="inline-start" />
                    )}
                    Fetch full history
                  </DisabledReasonButton>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <div
        ref={(node) => {
          readRetryRescue.hostRef(node);
          checkRetryRescue.hostRef(node);
        }}
        tabIndex={-1}
        className="min-h-9 min-w-0 text-xs outline-none"
      >
        <div
          aria-live="polite"
          className={settledNote === null ? "sr-only" : undefined}
        >
          {lastNote !== null && <NoteBody note={lastNote} />}
        </div>
        {showList && planChecking && (
          <p className="text-muted-foreground">{CHECKING_REASON}</p>
        )}
        {settledNote?.checkAgain === "read" && (
          <Button
            ref={readRetryRescue.retryRef}
            variant="outline"
            size="xs"
            className="mt-1"
            onClick={() => void plan.refetch()}
          >
            Check again
          </Button>
        )}
        {settledNote?.checkAgain === "check" && (
          <Button
            ref={checkRetryRescue.retryRef}
            variant="outline"
            size="xs"
            className="mt-1"
            onClick={checkAgain}
          >
            Check again
          </Button>
        )}
      </div>

      <DialogFooter className="items-center">
        <DisabledReasonButton
          variant="outline"
          disabled={backReason !== null}
          reason={backReason}
          onClick={onBack}
        >
          Back
        </DisabledReasonButton>
        <DisabledReasonButton
          disabled={applyReason !== null}
          reason={applyReason}
          onClick={() => void apply()}
        >
          {pickPending && <Spinner data-icon="inline-start" />}
          Check out and stage
        </DisabledReasonButton>
      </DialogFooter>
    </>
  );
}

const LOOKUP_LINE = "border-b px-3 py-1.5 text-[11px] text-muted-foreground";

/** The pasted id's own line atop the list box, for answers that pin no row. */
function ShaLookupLine({
  path,
  shaText,
  lookup,
  blockLead,
}: {
  path: string;
  shaText: string | null;
  lookup: SubmodulePickRead | undefined;
  /** A block that stopped the lookup before it resolved the id. */
  blockLead: string | null;
}) {
  if (shaText === null) return null;
  if (blockLead !== null) return <p className={LOOKUP_LINE}>{blockLead}</p>;
  if (lookup === undefined || lookup.plan.kind !== "blocked") return null;
  if (lookup.plan.why === "ambiguous")
    return (
      <p className={LOOKUP_LINE}>
        More than one commit starts with that id. Paste more of it.
        {lookup.plan.reason !== null && ` ${lookup.plan.reason}`}
      </p>
    );
  if (lookup.plan.why === "notACommit")
    return <p className={LOOKUP_LINE}>That id isn't a commit.</p>;
  // The lookup searched the whole object store, not just this ref's history.
  if (lookup.plan.why === "notFound")
    return <p className={LOOKUP_LINE}>No commit in {path} matches that id.</p>;
  return null;
}

function NoteBody({ note }: { note: Note }) {
  return (
    <>
      <p>
        {note.lead}
        {note.rest !== undefined && ` ${note.rest}`}
      </p>
      {note.detail && <p className="text-muted-foreground">{note.detail}</p>}
      {note.paths !== undefined && note.paths.length > 0 && (
        <ul className="mt-0.5 space-y-0.5 text-[11px] text-muted-foreground">
          {note.paths.map((p) => (
            <li key={p} className="min-w-0">
              <PathText path={p} className="font-mono" />
            </li>
          ))}
          {note.more && <li>{note.more}</li>}
        </ul>
      )}
      {note.advisory && (
        <p className="mt-0.5 flex items-start gap-1 text-warning">
          <WarningIcon className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
          <span>
            No remote branch or tag fetched here contains it, so other clones
            may not be able to check it out until it's pushed.
          </span>
        </p>
      )}
    </>
  );
}

function CommitRow({
  row,
  rowRef,
  highlighted,
  pointer,
  head,
  onPick,
}: {
  row: PickRow;
  rowRef: (node: HTMLElement | null) => () => void;
  highlighted: boolean;
  pointer: string | null;
  head: string | null;
  onPick: () => void;
}) {
  const { sha, commit } = row;
  const subject =
    commit === null
      ? `${short(sha)} · not fetched yet`
      : commit.subject || "(no commit message)";
  // Tags are words; the warning token on "not on a remote" is emphasis only.
  const tags: { label: string; className?: string }[] = [];
  if (sha === pointer) tags.push({ label: "recorded" });
  if (sha === head) tags.push({ label: "checked out" });
  if (commit?.onRemote === false)
    tags.push({
      label: "not on a remote",
      className: "border-warning/40 bg-warning/10 text-warning",
    });
  return (
    <button
      ref={rowRef}
      type="button"
      role="option"
      aria-selected={highlighted}
      data-pick-row={sha}
      tabIndex={highlighted ? 0 : -1}
      onFocus={onPick}
      onClick={onPick}
      className={cn(
        "flex w-full min-w-0 flex-col border-b px-3 py-2 text-left last:border-b-0",
        highlighted ? "bg-muted" : "hover:bg-muted/60",
      )}
    >
      <span className="flex w-full min-w-0 items-center gap-1.5">
        <span
          className="min-w-0 flex-1 truncate text-xs"
          onMouseEnter={clipTitle(subject)}
        >
          {subject}
        </span>
        {tags.map((t) => (
          <Fragment key={t.label}>
            <span className="sr-only">,</span>{" "}
            <Badge variant="outline" className={t.className}>
              {t.label}
            </Badge>
          </Fragment>
        ))}
      </span>
      {commit !== null && (
        <>
          <span className="sr-only">,</span>{" "}
          <span
            className="mt-0.5 block w-full truncate font-mono text-[11px] text-muted-foreground"
            onMouseEnter={clipTitleFromText}
          >
            {short(sha)} · {commit.author} ·{" "}
            <RelativeTime date={commit.authoredAt} />
          </span>
        </>
      )}
    </button>
  );
}
