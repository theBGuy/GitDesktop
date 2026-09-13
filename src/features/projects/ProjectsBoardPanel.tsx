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
import { clipTitleFromText } from "@/lib/clip-title";
import { presentError } from "@/lib/error-summary";
import { useActiveGhHost, useForgeGhHost } from "@/lib/git/host";
import {
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

  /** The card DOM focus sits on, resolved from the DOM rather than from state:
   *  a bare Tab into the board moves focus without touching the cursor, and the
   *  arrows must act on where the user actually is. */
  function focusedCard(root: HTMLElement): { col: number; idx: number } | null {
    const el = document.activeElement;
    if (!(el instanceof HTMLElement) || !root.contains(el)) return null;
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
    const from = focusedCard(e.currentTarget) ?? liveCursor;
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
  const projectItems: Record<string, string> = {};
  for (const p of openProjects) projectItems[p.id] = p.title;

  const readError = projects.error ?? fields.error ?? items.error;
  // A DISABLED query is permanently "pending", so every loading test is gated on
  // the read actually being live — otherwise a GitLab repo would load forever.
  // The FIELDS leg matters as much as the items one: without it the board paints
  // ungrouped for a frame and then re-lays out into columns as the definitions
  // land.
  const loading =
    (canRead && projects.isPending) ||
    fieldsPending ||
    (canRead && projectId !== null && items.isPending);

  const body = (() => {
    switch (true) {
      // Still detecting: `gh.data` undefined is not yet "not GitHub".
      case gh.data === undefined:
        return <BoardSkeleton />;
      case provider !== null && !isGitHub:
        return (
          <BoardNotice>
            <p>
              This repository is on {providerLabel(provider)} — Projects boards
              are a GitHub feature.
            </p>
          </BoardNotice>
        );
      case !isGitHub:
        return (
          <BoardNotice>
            <p>
              This repository has no GitHub remote — Projects boards are a
              GitHub feature.
            </p>
          </BoardNotice>
        );
      case scopeGap:
        return (
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
            Project boards need the <span className="font-mono">project</span>{" "}
            scope, which your GitHub sign-in is missing.
          </ScopeGapBlock>
        );
      case readError !== null:
        return (
          <div className="px-3 py-4 text-xs">
            <p className="text-muted-foreground">
              {presentError(readError).summary}
            </p>
            <Button
              variant="outline"
              size="xs"
              className="mt-2"
              onClick={() => {
                if (projects.error !== null) projects.refetch();
                if (fields.error !== null) fields.refetch();
                if (items.error !== null) items.refetch();
              }}
            >
              Retry
            </Button>
          </div>
        );
      case loading:
        return <BoardSkeleton />;
      case projectId === null:
        return (
          <BoardNotice>
            <p>
              A GitHub Project is a board that gathers issues and pull requests
              — from this repository and others — into columns you define.
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
  const capped =
    projects.data?.truncated === true || fields.data?.truncated === true;
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
            items={projectItems}
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
              this one trigger: group-by is its only occupant today, and the
              filter and sort controls later slices add become further rows in
              the same body rather than more toolbar chrome. The project switcher
              stays outside it — a project title says what it is, where a bare
              "Status" never said what it DID, which is the whole reason these
              moved in here. */}
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
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="tabular-nums">
              {items.hasNextPage
                ? `${shown} of ${totalCount} items`
                : `${shown} ${shown === 1 ? "item" : "items"}`}
            </span>
            {items.hasNextPage && (
              <DisabledReasonButton
                variant="outline"
                size="xs"
                disabled={items.isFetchingNextPage}
                reason="Loading more items…"
                onClick={() => items.fetchNextPage()}
              >
                Load more
              </DisabledReasonButton>
            )}
          </span>
        </div>
      )}
      {/* In the layout FLOW, pushing the board down — a persistent claim about
          what this surface is showing must never float over its chrome. */}
      {showBoardChrome && capped && (
        <p className="mb-2 shrink-0 border-b pb-1.5 text-[11px] text-muted-foreground">
          {projects.data?.truncated === true
            ? "Some of this owner's projects aren't listed above."
            : "Some of this board's fields aren't offered above."}
        </p>
      )}
      {body}
    </div>
  );
}
