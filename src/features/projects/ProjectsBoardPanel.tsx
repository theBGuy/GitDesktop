import { Popover } from "@base-ui/react/popover";
import { FadersHorizontalIcon } from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useId,
  useState,
} from "react";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { usePanelPortalContainer } from "@/components/panel-portal";
import { SelectClipText } from "@/components/select-clip-text";
import { Button } from "@/components/ui/button";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  projectScopeMissing,
  ScopeGapBlock,
} from "@/features/conversations/ProjectsPopover";
import { ForgeNotReady } from "@/features/repository/ForgeNotReady";
import { clipTitleFromText } from "@/lib/clip-title";
import { presentError } from "@/lib/error-summary";
import { useActiveGhHost, useForgeGhHost } from "@/lib/git/host";
import {
  forgeReady,
  useAvailableProjects,
  useForgeStatus,
  useGhScopes,
  useProjectFields,
  useProjectItems,
} from "@/lib/git/queries";
import { type BoardItem, providerLabel } from "@/lib/git/types";
import { useRemoteSlug, useRepoLens } from "@/lib/repo-lens/queries";
import { type RepoTab, useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";
import { BoardColumn } from "./BoardColumn";
import {
  buildColumns,
  firstCardPosition,
  groupableFields,
} from "./board-model";

/** Where an issue or pull request on this board lands, per kind: the tab that
 *  owns it in-app, and the web path a CROSS-REPO card falls back to (GitHub's own
 *  spelling, which differs from the tab's). Drafts open their own popover on the
 *  card and a redacted item has nothing to open, so neither appears here. */
const FORGE_KIND: Record<
  "issue" | "pullRequest",
  { tab: RepoTab; webPath: "issues" | "pull" }
> = {
  issue: { tab: "issues", webPath: "issues" },
  pullRequest: { tab: "pulls", webPath: "pull" },
};

const NO_GROUP_FIELDS_REASON =
  "This project has no single-select fields to group its board by";
const LOADING_FIELDS_REASON = "Loading this project's fields…";
const FIELDS_ERROR_REASON = "Couldn't load this project's fields";
/** A view-option row. Mirrors the field editor's own option rows, which are the
 *  same shape on the same kind of choice. */
const GROUP_ROW_CLASS =
  "flex cursor-pointer items-center gap-2 px-1 py-1 text-xs hover:bg-muted/60";

/** The board's first paint: three column shells rather than a spinner, so the
 *  real columns replace them without the surface shifting. */
function BoardSkeleton() {
  return (
    <>
      <span role="status" className="sr-only">
        Loading the project board…
      </span>
      <div aria-busy className="flex min-h-0 flex-1 gap-2">
        {["a", "b", "c"].map((key) => (
          <div
            key={key}
            className="flex w-76 shrink-0 flex-col gap-1.5 border bg-muted/20 p-1.5"
          >
            <Skeleton className="h-5 w-28" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ))}
      </div>
    </>
  );
}

/** The panel's error card: the failure's own summary plus the one control that
 *  can clear it. `presentError(...).summary` alone is the house error-card
 *  shape — the Issues and Pull Requests panels render exactly this. */
function ErrorCard({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <div className="px-3 py-4 text-xs">
      <p className="text-muted-foreground">{presentError(error).summary}</p>
      <Button variant="outline" size="xs" className="mt-2" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

/** A state that fills the panel with one short explanation, centred nowhere —
 *  top-left, where the board's own content starts. */
function BoardNotice({ children }: { children: ReactNode }) {
  return (
    <div className="max-w-prose space-y-2 px-3 py-4 text-xs text-muted-foreground">
      {children}
    </div>
  );
}

/**
 * The Projects tab: a read-only kanban of one GitHub Project, grouped by one of
 * the board's single-select fields.
 *
 * Every read gates on `active` as well as the provider — `<Activity>` defers a
 * hidden panel's effects but NOT its queries, so a board left on another tab
 * would otherwise keep paying for owner-wide project reads. Nothing here writes:
 * the switcher and the group-by are transient component state on purpose, so a
 * board the user looked at once doesn't become a stored preference.
 */
export function ProjectsBoardPanel({
  repoPath,
  active,
}: {
  repoPath: string;
  /** The Projects tab is the visible one. Gates every read in this subtree. */
  active: boolean;
}) {
  const gh = useForgeStatus(repoPath);
  const provider = gh.data?.provider;
  const isGitHub = provider === "github";
  const host = useActiveGhHost();
  const ghHost = useForgeGhHost(repoPath);
  const scopes = useGhScopes(host);
  // The same gate every other Projects surface reads, so none can fire a read
  // another one withholds.
  const scopeGap = projectScopeMissing(scopes.data);
  const canRead = active && isGitHub && !scopeGap;
  // The fork/upstream lens picks which repo's project catalog this is, and which
  // slug counts as "this repo" when a card opens — the same lens the Issues and
  // Pulls surfaces resolve, wired once at the view level.
  const lens = useRepoLens(repoPath);
  const repoSlug = useRemoteSlug(repoPath, lens, canRead);
  const openReconnect = useUiStore((s) => s.openReconnect);
  const selectIssue = useUiStore((s) => s.selectIssue);
  const selectPr = useUiStore((s) => s.selectPr);
  const setRepoTab = useUiStore((s) => s.setRepoTab);

  const projects = useAvailableProjects(repoPath, canRead, lens);
  // Closed boards are out in v1: they still hold items, but a board nobody is
  // working stands between the user and the one they came for.
  const openProjects = (projects.data?.projects ?? []).filter((p) => !p.closed);
  const [pickedProjectId, setPickedProjectId] = useState<string | null>(null);
  // Derived, not stored: the catalog arrives after the first render and can
  // change under the user, and a chosen board that has since closed or gone must
  // fall back rather than leave the board reading an id nothing serves. The
  // catalog's own order puts the repo's boards ahead of the owner's, so the
  // fallback IS "first repo-linked, else first owner".
  const projectId =
    openProjects.find((p) => p.id === pickedProjectId)?.id ??
    openProjects[0]?.id ??
    null;
  const project = openProjects.find((p) => p.id === projectId) ?? null;

  const fields = useProjectFields(
    repoPath,
    projectId ?? "",
    canRead && projectId !== null,
  );
  const groupFields = groupableFields(fields.data?.fields ?? []);
  const [pickedFieldId, setPickedFieldId] = useState<string | null>(null);
  // "Status" by name is what a GitHub board means by its columns; anything else
  // is a board that renamed or dropped it, where the first single-select is the
  // closest thing to the same promise.
  const defaultField =
    groupFields.find((f) => f.name === "Status") ?? groupFields[0] ?? null;
  const groupField =
    groupFields.find((f) => f.id === pickedFieldId) ?? defaultField;

  const items = useProjectItems(
    repoPath,
    projectId ?? "",
    canRead && projectId !== null,
  );
  const loaded = items.data?.pages.flatMap((page) => page.items) ?? [];
  const columns = buildColumns(loaded, groupField);
  // Counts the cards the board DRAWS, so it agrees with the column headers;
  // `totalCount` is the board's own figure and includes archived items, which is
  // why it only ever appears as the "of M" of a partly-loaded board.
  const shown = columns.reduce((n, column) => n + column.items.length, 0);
  const totalCount = items.data?.pages.at(-1)?.totalCount ?? shown;

  // The keyboard cursor, plus a nonce that bumps ONLY on an arrow press — the
  // columns move DOM focus off the nonce, never off the cursor, so a click or a
  // tab into the board can set the cursor without yanking focus around.
  const [cursor, setCursor] = useState<{ col: number; idx: number } | null>(
    null,
  );
  const [focusNonce, setFocusNonce] = useState(0);
  const onCardFocus = useCallback(
    (col: number, idx: number) => setCursor({ col, idx }),
    [],
  );
  // A cursor left over from another grouping (or a refetch that emptied its
  // column) can't address a card, so the tab stop falls back to the first one.
  const liveCursor =
    cursor !== null && cursor.idx < (columns[cursor.col]?.items.length ?? 0)
      ? cursor
      : null;
  const tabStop = liveCursor ?? firstCardPosition(columns);

  const openItem = useCallback(
    (item: BoardItem) => {
      const content = item.content;
      if (content.kind !== "issue" && content.kind !== "pullRequest") return;
      const target = FORGE_KIND[content.kind];
      // `selectIssue`/`selectPr` hand over a bare number that the destination
      // resolves under the repo's ACTIVE lens, so only a card from the repo that
      // lens points at can be opened in-app. Everything else on the board —
      // another repo, or the same repo under the other lens — leaves the app,
      // which is the same rule the Markdown reference links follow.
      // An unresolved slug (`null`) takes the browser branch deliberately: that
      // is the SAFE direction, since an in-app open on an unconfirmed match
      // would paint the wrong repository's detail view under this number.
      if (
        repoSlug !== null &&
        content.repoNameWithOwner.toLowerCase() === repoSlug.toLowerCase()
      ) {
        const id = String(content.number);
        if (content.kind === "issue") selectIssue({ kind: "remote", id });
        else selectPr({ kind: "remote", id });
        setRepoTab(target.tab);
        return;
      }
      void openUrl(
        `https://${host}/${content.repoNameWithOwner}/${target.webPath}/${content.number}`,
      ).catch(toastError);
    },
    [host, repoSlug, selectIssue, selectPr, setRepoTab],
  );

  /** The card `el` sits in, resolved from the DOM rather than from state: a bare
   *  Tab into the board moves focus without touching the cursor, and the arrows
   *  must act on where the user actually is. */
  function cardAt(el: HTMLElement): { col: number; idx: number } | null {
    const card = el.closest<HTMLElement>("[data-card-index]");
    const column = card?.closest<HTMLElement>("[data-column-index]");
    if (!card || !column) return null;
    const idx = Number(card.dataset.cardIndex);
    const col = Number(column.dataset.columnIndex);
    return Number.isInteger(idx) && Number.isInteger(col) ? { col, idx } : null;
  }

  /** The nearest column with a card in `step`'s direction, or -1. Empty columns
   *  are stepped OVER rather than landed on: there is nothing there to focus. */
  function nextColumn(from: number, step: number): number {
    for (let i = from + step; i >= 0 && i < columns.length; i += step) {
      if (columns[i].items.length > 0) return i;
    }
    return -1;
  }

  function onBoardKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    // DOM containment first, and it gates the cursor fallback too. React routes
    // synthetic events through the COMPONENT tree, so a keystroke typed inside a
    // draft card's PORTALLED popup arrives here even though the popup is not a
    // DOM descendant of the board — and the old `?? liveCursor` fallback then
    // moved the board under someone reading a draft. Focus outside this
    // container is not ours to act on, whatever the cursor still remembers.
    const focused = document.activeElement;
    if (!(focused instanceof HTMLElement) || !e.currentTarget.contains(focused))
      return;
    const from = cardAt(focused) ?? liveCursor;
    if (from === null) return;
    const column = columns[from.col];
    if (column === undefined || column.items.length === 0) return;
    const last = column.items.length - 1;
    let next = from;
    switch (e.key) {
      case "ArrowDown":
        next = { col: from.col, idx: Math.min(from.idx + 1, last) };
        break;
      case "ArrowUp":
        next = { col: from.col, idx: Math.max(from.idx - 1, 0) };
        break;
      case "Home":
        next = { col: from.col, idx: 0 };
        break;
      case "End":
        next = { col: from.col, idx: last };
        break;
      case "ArrowLeft":
      case "ArrowRight": {
        const col = nextColumn(from.col, e.key === "ArrowRight" ? 1 : -1);
        // Same visual row in the neighbour, clamped to its last card.
        if (col !== -1)
          next = {
            col,
            idx: Math.min(from.idx, columns[col].items.length - 1),
          };
        break;
      }
      default:
        return;
    }
    // Swallowed whether or not anything moved: a focused board must never scroll
    // sideways or jump to the page's end under a key it owns.
    e.preventDefault();
    if (next.col === from.col && next.idx === from.idx) return;
    setCursor(next);
    setFocusNonce((n) => n + 1);
  }

  // Ranked, because the popup can be opened before the fields read settles and
  // an UNSETTLED read is not the same claim as a settled empty one. Claiming "no
  // single-select fields" while the read is still in flight is a false
  // statement, not a placeholder.
  const fieldsPending = canRead && projectId !== null && fields.isPending;
  const groupHeldReason = (() => {
    switch (true) {
      case fieldsPending:
        return LOADING_FIELDS_REASON;
      // Ahead of the settled-empty claim: a FAILED read is neither pending nor
      // holding data, so without this arm a board whose fields call errored
      // would announce that it defines none.
      case fields.error !== null:
        return FIELDS_ERROR_REASON;
      case groupFields.length === 0:
        return NO_GROUP_FIELDS_REASON;
      default:
        return undefined;
    }
  })();
  // Names the radio group; its checked row supplies the value half of the
  // reading, so no id on the control itself.
  const groupLabelId = useId();
  const portalContainer = usePanelPortalContainer();
  const projectTitles: Record<string, string> = {};
  for (const p of openProjects) projectTitles[p.id] = p.title;

  // Cards already on screen outlive a failed read. A next-page failure, a failed
  // refetch, or a fields read that died after the board painted all leave the
  // items that DID arrive in place and say what went wrong beside them — the
  // error card is for having nothing to show, not for having stale-but-real
  // cards.
  const hasPages = (items.data?.pages.length ?? 0) > 0;
  const fatalError = hasPages
    ? null
    : (projects.error ?? fields.error ?? items.error);
  // ONE name for "the items read hasn't settled", shared by the skeleton gate
  // and the count beside it. Two expressions of the same condition would drift,
  // and this is the pair that must not: a count is an ASSERTION about the board,
  // so it may never state a number the read hasn't produced.
  const itemsPending = canRead && projectId !== null && items.isPending;
  // A DISABLED query is permanently "pending", so every loading test is gated on
  // the read actually being live — otherwise a GitLab repo would load forever.
  // The FIELDS leg matters as much as the items one: without it the board paints
  // ungrouped for a frame and then re-lays out into columns as the definitions
  // land.
  const loading =
    (canRead && projects.isPending) || fieldsPending || itemsPending;
  // An empty catalog is only an ABSENCE claim when the read was complete: a
  // capped catalog (or one whose owner arm was denied) can come back empty while
  // boards exist, and "there are none" would be a lie about a set we didn't
  // finish searching.
  const catalogTruncated = projects.data?.truncated === true;
  // `isFetchNextPageError` is query-core's own discrimination (`isError &&
  // fetchMeta.fetchMore.direction === "forward"`), which is what tells a dead
  // CONTINUATION apart from a dead initial load. Paired with `hasPages` so a
  // failure that left cards on screen never blanks them.
  const pageError = hasPages && items.isFetchNextPageError && items.error;
  // Load more is held for ANY in-flight items fetch, not just a continuation.
  // `fetchNextPage` defaults to query-core's `cancelRefetch: true`, so clicking
  // during the reconciliation refetch that an in-app edit triggered CANCELS that
  // refetch and appends a fresh page onto the stale ones — and the append's own
  // success then clears `isInvalidated`, stamping the stale cards provably fresh
  // for the rest of the staleTime window. Measured against query-core 5.102.8.
  // Two reasons, because the two waits mean different things to the user.
  const loadMoreHeld = (() => {
    switch (true) {
      case items.isFetchingNextPage:
        return "Loading more items…";
      case items.isFetching:
        return "Refreshing the board…";
      // The post-failure half of the same hazard. A REFRESH that failed leaves
      // the pre-edit pages on screen with the invalidation still owed, and both
      // fetching guards above have released. Appending a continuation onto those
      // pages would succeed, and that success clears the error AND the
      // invalidation — stamping a stale board provably fresh for the rest of the
      // staleTime window. Only the full refetch behind the strip's Retry can
      // clear it, which is why this points there. A failed CONTINUATION is
      // excluded: those pages were never invalidated, so retrying the page is
      // exactly the right move.
      case items.isError && !items.isFetchNextPageError:
        return "The board's last refresh failed. Retry the refresh before loading more.";
      default:
        return undefined;
    }
  })();
  // Once cards are on screen, EVERY failed read is non-fatal: it earns a line in
  // the in-flow strip with its own retry wired to its own refetch, rather than
  // vanishing behind a board that silently renders ungrouped or stale. Exactly
  // one visible recovery path per failed read, which is why the items arm
  // excludes a CONTINUATION failure — that one is recovered at Load more.
  const liveNotices: {
    key: string;
    what: string;
    message: string;
    retry: () => void;
  }[] = [];
  if (hasPages) {
    if (projects.error !== null)
      liveNotices.push({
        key: "projects",
        what: "the project list",
        message: presentError(projects.error).summary,
        retry: () => void projects.refetch(),
      });
    if (fields.error !== null)
      liveNotices.push({
        key: "fields",
        what: "this board's fields",
        message: presentError(fields.error).summary,
        retry: () => void fields.refetch(),
      });
    if (items.error !== null && !items.isFetchNextPageError)
      liveNotices.push({
        key: "items",
        what: "this board's items",
        message: presentError(items.error).summary,
        retry: () => void items.refetch(),
      });
  }

  const body = (() => {
    switch (true) {
      // A failed forge probe is not "still detecting": without this arm the
      // panel sits on a skeleton forever and nothing on screen can refetch it.
      case gh.error !== null:
        return <ErrorCard error={gh.error} onRetry={() => void gh.refetch()} />;
      // Still detecting: `gh.data` undefined is not yet "not GitHub".
      case gh.data === undefined:
        return <BoardSkeleton />;
      // A KNOWN other provider is the one thing this tab can name precisely, so
      // it is checked ahead of the not-ready ladder: telling a GitLab user to
      // install `glab` would walk them toward a feature GitLab doesn't have.
      case provider !== null && !isGitHub:
        return (
          <BoardNotice>
            <p>
              This repository is on {providerLabel(provider)} — Projects boards
              are a GitHub feature.
            </p>
          </BoardNotice>
        );
      // provider `null` ALSO means gh isn't installed, isn't signed in, or can't
      // resolve this remote — "no GitHub remote" misdiagnosed all three and
      // offered no way out. The shared ladder names the real blocker and pairs
      // it with the action that clears it, exactly as the Issues / Discussions /
      // Actions tabs do.
      case !forgeReady(gh.data):
        return <ForgeNotReady repoPath={repoPath} feature="project boards" />;
      case scopeGap:
        return (
          // ScopeGapBlock carries POPUP padding (px-1 py-1) — it was written for
          // the Projects picker's popover. This is a full-pane state, so the call
          // site makes up the difference: px-2 py-3 here lands it on the px-3 py-4
          // the sibling arms use, without touching a component two other surfaces
          // share.
          <div className="px-2 py-3">
            <ScopeGapBlock
              host={host}
              onReconnect={() =>
                openReconnect({
                  provider: "github",
                  host,
                  mode: "refresh",
                  scopes: ["project"],
                })
              }
            >
              {/* Names BOTH scopes the read accepts, matching the detector:
                  `projectScopeMissing` only fires when a classic token has
                  neither. The reconnect below asks for `project`, which is the
                  one that also permits the writes the pickers offer. */}
              Reading project boards needs the{" "}
              <span className="font-mono">project</span> or{" "}
              <span className="font-mono">read:project</span> scope, and your
              GitHub sign-in has neither.
            </ScopeGapBlock>
          </div>
        );
      case fatalError !== null:
        return (
          <ErrorCard
            error={fatalError}
            onRetry={() => {
              if (projects.error !== null) void projects.refetch();
              if (fields.error !== null) void fields.refetch();
              if (items.error !== null) void items.refetch();
            }}
          />
        );
      case loading:
        return <BoardSkeleton />;
      // A capped or half-answered catalog can be empty while boards exist, so
      // the definitive "there are none" is held back for a complete read and the
      // hedged wording names what wasn't searched.
      case projectId === null && catalogTruncated:
        return (
          <BoardNotice>
            <p>
              No open project came back for this repository or its owner, but
              the list was cut short, so there may be more.
            </p>
            <p>Open the owner's Projects page on GitHub to see all of them.</p>
          </BoardNotice>
        );
      case projectId === null:
        return (
          <BoardNotice>
            <p>
              A GitHub Project is a board that gathers issues and pull requests
              (from this repository and others) into columns you define.
            </p>
            <p>
              Neither this repository nor its owner has an open one yet. Start
              one on GitHub and it appears here.
            </p>
          </BoardNotice>
        );
      default:
        return (
          // One horizontal scroll region for the whole board; each column owns
          // its own vertical one.
          <div
            className="flex min-h-0 flex-1 gap-2 overflow-x-auto"
            onKeyDown={onBoardKeyDown}
          >
            {columns.map((column, i) => (
              <BoardColumn
                key={column.id}
                column={column}
                columnIndex={i}
                activeIndex={liveCursor?.col === i ? liveCursor.idx : null}
                tabStopIndex={tabStop?.col === i ? tabStop.idx : null}
                focusNonce={focusNonce}
                repoSlug={repoSlug}
                ghHost={ghHost}
                onCardFocus={onCardFocus}
                onOpen={openItem}
              />
            ))}
          </div>
        );
    }
  })();

  const showBoardChrome = isGitHub && !scopeGap && projectId !== null;
  const cappedNotes: string[] = [];
  if (catalogTruncated)
    cappedNotes.push("Some of this owner's projects aren't listed above.");
  if (fields.data?.truncated === true)
    cappedNotes.push("Some of this board's fields aren't offered above.");
  return (
    // `h-full`, not `min-h-0 flex-1`: the content pane (<main>) is a BLOCK box,
    // so a flex-item sizing chain never engages there and this root would take
    // its content's height — unbounding every column's scroller and leaving the
    // virtualizers rendering every row. `min-h-0 flex-1` is the SIDEBAR idiom
    // (that aside really is a flex column); the content-pane idiom is this one
    // (RemoteIssueView, RemotePrView, DiffViewer).
    <div className="flex h-full flex-col p-2">
      {project !== null && (
        <h2 className="sr-only">{project.title} project board</h2>
      )}
      {showBoardChrome && (
        <div className="mb-2 flex shrink-0 flex-wrap items-center gap-2">
          <Select
            items={projectTitles}
            value={projectId}
            onValueChange={(v) => {
              setPickedProjectId(v);
              // The new board defines its own fields, and the cursor addresses
              // columns that are about to be replaced.
              setPickedFieldId(null);
              setCursor(null);
            }}
          >
            <SelectTrigger size="sm" aria-label="Project" className="max-w-64">
              <SelectValue onMouseEnter={clipTitleFromText} />
            </SelectTrigger>
            <SelectContent>
              {openProjects.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  <SelectClipText>{p.title}</SelectClipText>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {/* Every control that shapes HOW the board is laid out lives behind
              this one trigger, so later slices add rows here rather than more
              toolbar chrome. The project switcher stays outside it: a project
              title already says what it is. */}
          <Popover.Root>
            <Popover.Trigger
              render={
                <Button variant="outline" size="sm" className="ml-auto" />
              }
            >
              <FadersHorizontalIcon data-icon="inline-start" />
              View options
            </Popover.Trigger>
            <Popover.Portal container={portalContainer}>
              <Popover.Positioner
                align="end"
                sideOffset={4}
                className="isolate z-50"
              >
                <Popover.Popup className="w-72 rounded-none bg-popover p-2 text-popover-foreground shadow-md ring-1 ring-foreground/10">
                  {/* The caption IS the popup's accessible name: Popup takes its
                      `aria-labelledby` from whatever Title registers, and a bare
                      element leaves the dialog unnamed. `render` keeps it a <p> —
                      Title's own default element is an <h2>. */}
                  <Popover.Title
                    render={<p />}
                    className="px-1 pb-1.5 text-xs font-medium"
                  >
                    View options
                  </Popover.Title>
                  {/* One section per view control; later slices add their own
                      beside this one, so the section shape is the contract.
                      INLINE rows, never a nested popup: a Select in here
                      portalled out to the panel container, and floating-ui's
                      `absolute` strategy then measured against one offset parent
                      and resolved against another — the popup landed ~750px
                      right of its trigger and horizontally scrolled the whole app
                      shell to reach it (measured live). A radio group has no
                      positioning machinery to get wrong, and it is what a
                      one-of-many choice already is. */}
                  <div className="space-y-2">
                    <div className="space-y-1">
                      {/* Names the GROUP, which is what carries the meaning here:
                          the label plus the checked row reads as "Group by …,
                          Status, selected". */}
                      <p
                        id={groupLabelId}
                        className="px-1 text-xs text-muted-foreground"
                      >
                        Group by
                      </p>
                      {groupHeldReason !== undefined || groupField === null ? (
                        // Nothing to choose from, so the reason IS the content
                        // rather than a hidden note on an empty control — the
                        // field editor's own empty-option-set shape, and it keeps
                        // the ranked wording (an unsettled read is not the same
                        // claim as a settled empty one).
                        <p className="px-1 py-1 text-xs text-muted-foreground">
                          {groupHeldReason ?? NO_GROUP_FIELDS_REASON}
                        </p>
                      ) : (
                        // Applies on change — no draft, no commit-on-close; the
                        // popup stays open so the board can be re-grouped without
                        // reopening it. `gap-0` only: the rows carry their own
                        // padding.
                        <RadioGroup
                          className="gap-0"
                          aria-labelledby={groupLabelId}
                          value={groupField.id}
                          onValueChange={(next) => {
                            // Base UI types the group's value as `any`; the
                            // guard is what narrows it back to the field id
                            // these rows actually carry.
                            if (typeof next !== "string") return;
                            setPickedFieldId(next);
                            setCursor(null);
                          }}
                        >
                          {groupFields.map((f) => (
                            <label key={f.id} className={GROUP_ROW_CLASS}>
                              <Radio value={f.id} />
                              <span
                                className="min-w-0 truncate"
                                onMouseEnter={clipTitleFromText}
                              >
                                {f.name}
                              </span>
                            </label>
                          ))}
                        </RadioGroup>
                      )}
                    </div>
                  </div>
                </Popover.Popup>
              </Popover.Positioner>
            </Popover.Portal>
          </Popover.Root>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {/* No number until the read has produced one. "0 items" is a CLAIM
                about the board, and neither unsettled state has earned it: still
                loading gets the skeleton, and failed-with-nothing-loaded gets
                nothing at all, because the error card below already says what
                happened and a zero beside it would read as the answer. */}
            {(() => {
              switch (true) {
                case itemsPending:
                  return <Skeleton className="h-4 w-20" aria-hidden />;
                case !hasPages:
                  return null;
                default:
                  return (
                    <span className="tabular-nums">
                      {items.hasNextPage
                        ? `${shown} of ${totalCount} items`
                        : `${shown} ${shown === 1 ? "item" : "items"}`}
                    </span>
                  );
              }
            })()}
            {/* A failed CONTINUATION says so HERE, beside the control that
                caused it, and leaves the loaded board alone. `refetch()` would
                replay every page already on screen; `fetchNextPage()` retries
                only the one that failed. */}
            {pageError && (
              <span className="text-destructive">
                {presentError(items.error).summary}
              </span>
            )}
            {(items.hasNextPage || pageError) && (
              <DisabledReasonButton
                variant="outline"
                size="xs"
                disabled={loadMoreHeld !== undefined}
                reason={loadMoreHeld}
                onClick={() => {
                  // Belt-and-braces with the `disabled` above: the held state is
                  // derived at render, and a click racing the render that sets it
                  // must not get through either.
                  if (items.isFetching) return;
                  void items.fetchNextPage();
                }}
              >
                {pageError ? "Try again" : "Load more"}
              </DisabledReasonButton>
            )}
          </div>
        </div>
      )}
      {/* In the layout FLOW, pushing the board down — a persistent claim about
          what this surface is showing must never float over its chrome. Failed
          reads come first (they are actionable), then the caps; both caps can be
          on at once and each names a different list, so they are joined rather
          than ranked. */}
      {showBoardChrome &&
        (liveNotices.length > 0 || cappedNotes.length > 0) && (
          <div className="mb-2 shrink-0 space-y-1 border-b pb-1.5 text-[11px]">
            {liveNotices.map((notice) => (
              <p
                key={notice.key}
                className="flex flex-wrap items-center gap-1.5"
              >
                <span className="text-destructive">{notice.message}</span>
                <button
                  type="button"
                  aria-label={`Retry loading ${notice.what}`}
                  onClick={notice.retry}
                  className="cursor-pointer text-muted-foreground underline hover:text-foreground"
                >
                  Retry
                </button>
              </p>
            ))}
            {cappedNotes.length > 0 && (
              <p className="text-muted-foreground">{cappedNotes.join(" ")}</p>
            )}
          </div>
        )}
      {body}
    </div>
  );
}
