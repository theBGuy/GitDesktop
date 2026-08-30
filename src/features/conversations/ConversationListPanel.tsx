import { CaretDownIcon, CaretRightIcon, PlusIcon } from "@phosphor-icons/react";
import {
  Fragment,
  type KeyboardEventHandler,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { ForgeNotReady } from "@/features/repository/ForgeNotReady";
import { cn } from "@/lib/utils";
import { LoadMoreRow } from "./LoadMoreRow";

/** The "New ▾" dropdown's items (GitHub + local, plus an optional third for a
 *  linked Jira project on the issues panel). */
export interface NewMenuConfig {
  ghLabel: string;
  ghDisabled: boolean;
  ghReason?: string;
  onGh: () => void;
  localLabel: string;
  onLocal: () => void;
  /** Optional Jira create item — present only when a Jira project is linked AND
   *  the user can create issues in it (permission-gated at the call site). */
  jiraLabel?: string;
  onJira?: () => void;
}

const ROW_CLASS = "block w-full border-b px-3 py-2 text-left";
function rowClass(active: boolean) {
  return cn(
    ROW_CLASS,
    active ? "bg-accent text-accent-foreground" : "hover:bg-muted/60",
  );
}

/** A collapsible section header: a caret + the label, plus a count when
 *  collapsed so hidden content stays discoverable. Keeps the calm header
 *  typography (text-xs text-muted-foreground); the caret + count carry the
 *  collapsed state (never color alone). */
function SectionHeader(props: {
  label: ReactNode;
  collapsed: boolean;
  onToggle: () => void;
  /** Shown only when collapsed and non-null (omitted while a remote section is
   *  pending/not-ready, where the count would be wrong). */
  count?: number;
  className?: string;
}) {
  const { label, collapsed, onToggle, count, className } = props;
  const Caret = collapsed ? CaretRightIcon : CaretDownIcon;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      className={cn(
        "flex w-full cursor-pointer items-center gap-1 px-3 text-xs text-muted-foreground hover:text-foreground",
        className,
      )}
    >
      <Caret className="size-3 shrink-0" />
      <span>{label}</span>
      {collapsed && count != null && (
        <span className="tabular-nums">({count})</span>
      )}
    </button>
  );
}

/**
 * The master-detail list scaffold shared by the PR and issue panels: a state
 * tab toolbar + New menu + filter slot, a search input, and a Local / GitHub
 * two-section list with the GitHub-ready/pending ladder. The row button chrome
 * (and thus the `data-row` keys arrow-key nav depends on) is baked in here; each
 * panel supplies only the inner row content via render props.
 */
export function ConversationListPanel<L, R, J = never>(props: {
  repoPath: string;
  /** ForgeNotReady's `feature` (e.g. "pull requests"). */
  feature: string;
  // toolbar
  stateFilter: "open" | "closed";
  onStateFilter: (s: "open" | "closed") => void;
  newMenu: NewMenuConfig;
  filterSlot: ReactNode;
  /** Optional Fork | Upstream lens switch, rendered in the toolbar after the
   *  state filter (before the New menu). Omit (the default) and nothing renders,
   *  so panels without a lens are unaffected. */
  lensControl?: ReactNode;
  // search
  filterRef: Ref<HTMLInputElement>;
  filterText: string;
  onFilterText: (s: string) => void;
  // keyboard nav over the whole list
  onListKeyDown: KeyboardEventHandler;
  // local section
  stateLocal: L[];
  visibleLocal: L[];
  localKey: (item: L) => string;
  isLocalActive: (item: L) => boolean;
  onSelectLocal: (item: L) => void;
  renderLocalRow: (item: L) => ReactNode;
  /** Optional right-click wrapper for a local row — receives the row's `<button>`
   *  element and returns it wrapped in a context menu. Omit (the default) to
   *  render the row bare, unchanged. The row keeps its `data-row` key + onClick,
   *  so selection and arrow-key nav are unaffected. */
  localRowContextMenu?: (item: L, row: ReactElement) => ReactNode;
  archivedLocalCount: number;
  showArchived: boolean;
  onToggleArchived: () => void;
  /** Collapse state for the two sections. When collapsed the section body
   *  unmounts entirely — the caller MUST also drop that section's rows from its
   *  arrow-key registry so no invisible row stays selectable. */
  localCollapsed: boolean;
  remoteCollapsed: boolean;
  onToggleLocal: () => void;
  onToggleRemote: () => void;
  // remote (provider) section
  ghPending: boolean;
  ghReady: boolean;
  /** The provider's display name for the section header (default "GitHub"). */
  remoteLabel?: string;
  /** Replaces the ForgeNotReady ladder in the not-ready branch when the host
   *  can't support this feature at all (e.g. Bitbucket's retired issue tracker),
   *  so the section explains the platform reality instead of prompting a
   *  connection that would never surface anything. */
  remoteNotReadySlot?: ReactNode;
  listPending: boolean;
  stateRemote: R[];
  visibleRemote: R[];
  remoteKey: (item: R) => string;
  isRemoteActive: (item: R) => boolean;
  onSelectRemote: (item: R) => void;
  onRemoteHover: (item: R) => void;
  renderRemoteRow: (item: R) => ReactNode;
  /** Skeleton rows while the GitHub list loads (PR=2, issue=3). */
  remoteSkeletonRows: number;
  /** The remote list fetch failed — render `remoteErrorSlot` in place of the
   *  empty state so a failed load doesn't read as "no items". Omit (the default)
   *  and the remote section behaves exactly as before. */
  remoteError?: boolean;
  /** Rendered in place of the remote list on error (e.g. a Retry prompt). */
  remoteErrorSlot?: ReactNode;
  // empty-state nouns
  localNoun: string;
  remoteNoun: string;
  /** Optional THIRD section, rendered after the remote section (the issue panel's
   *  linked Jira project). All props optional — omit the whole `jira` object and
   *  the section (and its header) don't render, so the PR panel is unaffected.
   *  Rows carry `data-row="jira:<key>"` so the shared arrow-key nav spans them. */
  jira?: {
    /** Section header, e.g. "Jira · PROJ". */
    header: ReactNode;
    /** Right-aligned header affordance (e.g. a "View in Jira" link). */
    headerAction?: ReactNode;
    pending: boolean;
    isError: boolean;
    /** Rendered in place of the list on error (e.g. a Reconnect prompt). */
    errorSlot?: ReactNode;
    items: J[];
    itemKey: (item: J) => string;
    isActive: (item: J) => boolean;
    onSelect: (item: J) => void;
    renderRow: (item: J) => ReactNode;
    skeletonRows: number;
    /** Empty-state teaching copy when the linked project has no matching issues. */
    emptyLabel: ReactNode;
  };
  /** "Load more" for the REMOTE section: true when the remote list filled its
   *  requested limit (more may exist server-side). Renders a focusable row at the
   *  very bottom of the list; `onLoadMore` bumps the caller's limit, `loadingMore`
   *  disables + shows the busy state while the grown page fetches. Omit `hasMore`
   *  (the default) to render no row. */
  hasMore?: boolean;
  onLoadMore?: () => void;
  loadingMore?: boolean;
  /** How many remote items are currently loaded (shown in the row). */
  remoteCount?: number;
  /** Create dialogs etc. rendered after the list. */
  children?: ReactNode;
}) {
  const {
    stateFilter,
    onStateFilter,
    newMenu,
    filterSlot,
    lensControl,
    filterRef,
    filterText,
    onFilterText,
    onListKeyDown,
    stateLocal,
    visibleLocal,
    localKey,
    isLocalActive,
    onSelectLocal,
    renderLocalRow,
    localRowContextMenu,
    archivedLocalCount,
    showArchived,
    onToggleArchived,
    localCollapsed,
    remoteCollapsed,
    onToggleLocal,
    onToggleRemote,
    ghPending,
    ghReady,
    remoteLabel = "GitHub",
    remoteNotReadySlot,
    listPending,
    repoPath,
    feature,
    stateRemote,
    visibleRemote,
    remoteKey,
    isRemoteActive,
    onSelectRemote,
    onRemoteHover,
    renderRemoteRow,
    remoteSkeletonRows,
    remoteError,
    remoteErrorSlot,
    localNoun,
    remoteNoun,
    jira,
    hasMore,
    onLoadMore,
    loadingMore,
    remoteCount,
    children,
  } = props;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-1 border-b p-2">
        {(["open", "closed"] as const).map((s) => (
          <Button
            key={s}
            variant={stateFilter === s ? "secondary" : "ghost"}
            size="xs"
            aria-pressed={stateFilter === s}
            onClick={() => onStateFilter(s)}
          >
            {s === "open" ? "Open" : "Closed"}
          </Button>
        ))}
        {lensControl}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" size="xs" className="ml-auto">
                <PlusIcon data-icon="inline-start" />
                New
                <CaretDownIcon data-icon="inline-end" />
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="min-w-56">
            <DropdownMenuItem
              disabled={newMenu.ghDisabled}
              title={newMenu.ghReason}
              onClick={newMenu.onGh}
            >
              {newMenu.ghLabel}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={newMenu.onLocal}>
              {newMenu.localLabel}
            </DropdownMenuItem>
            {newMenu.jiraLabel && newMenu.onJira && (
              <DropdownMenuItem onClick={newMenu.onJira}>
                {newMenu.jiraLabel}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        {filterSlot}
      </div>
      <div className="border-b p-2">
        <Input
          ref={filterRef}
          value={filterText}
          onChange={(e) => onFilterText(e.target.value)}
          placeholder="Search by title, #, author, or label"
          className="h-7"
          autoComplete="off"
        />
      </div>
      {/* overflow-hidden: the vendored ScrollArea Root is upstream-faithful
          (`relative` only), so without containment the list's natural height
          leaks into the document once it exceeds the viewport (a window
          scrollbar over a black void). The Viewport still scrolls internally. */}
      <ScrollArea className="min-h-0 flex-1 overflow-hidden">
        <div onKeyDown={onListKeyDown}>
          <SectionHeader
            label="Local"
            collapsed={localCollapsed}
            onToggle={onToggleLocal}
            count={visibleLocal.length}
            className="pt-2 pb-1"
          />
          {!localCollapsed && (
            <>
              {visibleLocal.length === 0 ? (
                <p className="px-3 py-2 text-xs text-muted-foreground">
                  {stateLocal.length > 0
                    ? `No local ${localNoun} match the filter.`
                    : `No ${stateFilter} local ${localNoun}.`}
                </p>
              ) : (
                visibleLocal.map((item) => {
                  const row = (
                    <button
                      type="button"
                      data-row={`local:${localKey(item)}`}
                      className={rowClass(isLocalActive(item))}
                      onClick={() => onSelectLocal(item)}
                    >
                      {renderLocalRow(item)}
                    </button>
                  );
                  // The context-menu wrapper renders the same `<button>` as its
                  // trigger (no extra DOM node), so `data-row` stays intact for
                  // arrow-key nav. Bare row when no wrapper is supplied.
                  return (
                    <Fragment key={localKey(item)}>
                      {localRowContextMenu
                        ? localRowContextMenu(item, row)
                        : row}
                    </Fragment>
                  );
                })
              )}
              {archivedLocalCount > 0 && (
                <button
                  type="button"
                  onClick={onToggleArchived}
                  className="cursor-pointer px-3 py-1 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  {showArchived
                    ? "Hide archived"
                    : `Show archived (${archivedLocalCount})`}
                </button>
              )}
            </>
          )}

          <SectionHeader
            label={remoteLabel}
            collapsed={remoteCollapsed}
            onToggle={onToggleRemote}
            // Omit the count while the remote section is pending/not-ready — a
            // count then would be wrong or misleading; show it only once the
            // list is loaded.
            count={
              ghReady && !ghPending && !listPending
                ? visibleRemote.length
                : undefined
            }
            className="pt-3 pb-1"
          />
          {!remoteCollapsed &&
            (ghPending ? (
              <div className="space-y-2 p-3">
                <Skeleton className="h-9 w-full" />
              </div>
            ) : !ghReady ? (
              (remoteNotReadySlot ?? (
                <ForgeNotReady repoPath={repoPath} feature={feature} />
              ))
            ) : listPending ? (
              <div className="space-y-2 p-3">
                {Array.from({ length: remoteSkeletonRows }, (_, i) => (
                  <Skeleton key={i} className="h-9 w-full" />
                ))}
              </div>
            ) : remoteError ? (
              (remoteErrorSlot ?? (
                <p className="px-3 py-4 text-xs text-muted-foreground">
                  Couldn't load {remoteNoun}.
                </p>
              ))
            ) : visibleRemote.length === 0 ? (
              <p className="px-3 py-4 text-xs text-muted-foreground">
                {stateRemote.length > 0
                  ? `No ${remoteNoun} match the filter.`
                  : `No ${stateFilter} ${remoteNoun}.`}
              </p>
            ) : (
              visibleRemote.map((item) => (
                <button
                  type="button"
                  key={remoteKey(item)}
                  data-row={`remote:${remoteKey(item)}`}
                  className={rowClass(isRemoteActive(item))}
                  onClick={() => onSelectRemote(item)}
                  onMouseEnter={() => onRemoteHover(item)}
                >
                  {renderRemoteRow(item)}
                </button>
              ))
            ))}

          {jira && (
            <>
              <div className="flex items-center gap-1 px-3 pt-3 pb-1">
                <p className="text-xs text-muted-foreground">{jira.header}</p>
                {jira.headerAction && (
                  <span className="ml-auto">{jira.headerAction}</span>
                )}
              </div>
              {jira.pending ? (
                <div className="space-y-2 p-3">
                  {Array.from({ length: jira.skeletonRows }, (_, i) => (
                    <Skeleton key={i} className="h-9 w-full" />
                  ))}
                </div>
              ) : jira.isError ? (
                (jira.errorSlot ?? (
                  <p className="px-3 py-4 text-xs text-muted-foreground">
                    Couldn't load Jira issues.
                  </p>
                ))
              ) : jira.items.length === 0 ? (
                <p className="px-3 py-4 text-xs text-muted-foreground">
                  {jira.emptyLabel}
                </p>
              ) : (
                jira.items.map((item) => (
                  <button
                    type="button"
                    key={jira.itemKey(item)}
                    data-row={`jira:${jira.itemKey(item)}`}
                    className={rowClass(jira.isActive(item))}
                    onClick={() => jira.onSelect(item)}
                  >
                    {jira.renderRow(item)}
                  </button>
                ))
              )}
            </>
          )}

          {/* "Load more" for the remote section, at the very bottom of the list.
              Only the remote list paginates (local + Jira load in full). */}
          {hasMore && onLoadMore && (
            <LoadMoreRow
              count={remoteCount ?? 0}
              loading={loadingMore ?? false}
              onLoadMore={onLoadMore}
            />
          )}
        </div>
      </ScrollArea>

      {children}
    </div>
  );
}
