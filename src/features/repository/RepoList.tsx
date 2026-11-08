import {
  BuildingsIcon,
  CloudIcon,
  FolderIcon,
  GitForkIcon,
  GlobeSimpleIcon,
  LockSimpleIcon,
  TreeStructureIcon,
} from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { type MouseEvent, useEffect, useRef, useState } from "react";
import { MENU_HELD_ROW_CLASS } from "@/components/menu-held-row";
import { PathText } from "@/components/path-text";
import { ProviderIcon } from "@/components/provider-icon";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import {
  clampHighlight,
  stepHighlight,
} from "@/features/shortcuts/palette-highlight";
import { clipTitle } from "@/lib/clip-title";
import { copyText } from "@/lib/clipboard";
import { suppressContextMenu } from "@/lib/context-menu";
import { applyFrozenOrder, frozenPathKey } from "@/lib/frozen-order";
import {
  forgeRepoUrl,
  forgeRepoVisibility,
  openInTerminal,
  openWithDefault,
  openWithProgram,
} from "@/lib/git/api";
import { useRepoOwners } from "@/lib/git/queries";
import {
  type ForgeProvider,
  knownProvider,
  OPEN_IN_BROWSER,
  providerLabel,
} from "@/lib/git/types";
import { formatBinding, hasChordModifier } from "@/lib/hotkeys/binding";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { useReopenHint } from "@/lib/last-checkout/hint";
import {
  persistRepoVisibility,
  type RecentRepo,
  repoDisplayName,
} from "@/lib/settings/api";
import {
  settingsKeys,
  usePersistRepoOwners,
  useSettings,
} from "@/lib/settings/queries";
import { toastError } from "@/lib/toast";
import { cn } from "@/lib/utils";
import {
  FILTER_INPUT_CLASS,
  FILTER_ROW_CLASS,
  LIST_VIEWPORT_CLASS,
} from "./repo-list-sizes";
import { useOpenRepoByPath } from "./useOpenRepoByPath";

const RECENT_COUNT = 5;
const OTHER_GROUP = "Other";

const REPO_LISTBOX_ID = "repo-list-listbox";
/** Stable DOM id per repo row, so the filter's aria-activedescendant can point
 *  at the keyboard-highlighted option for screen readers. `repo.path` is the
 *  unique key (already the row's `data-repo-path`). */
const repoOptionId = (path: string) =>
  `repo-list-${path.replace(/[^\w-]/g, "_")}`;
/** The id of a hinted row's escape description. encodeURIComponent is injective
 *  and emits no whitespace, so two paths never share one (repoOptionId's
 *  sanitizing can collide) and the value is a single valid IDREF. */
const reopenDescId = (path: string) =>
  `repo-reopen-desc-${encodeURIComponent(path)}`;

/** Kept out of the option's name: the name says where a plain open lands, the
 *  description how to land on the main workspace instead. */
const REOPEN_ESCAPE_DESC = `${formatBinding("shift+enter")} opens the main workspace`;
const reopenTitle = (name: string) =>
  `Opens in worktree ${name}. ${formatBinding("shift+enter")} or ${formatBinding("shift")}+click opens the main workspace.`;

/** Inset from the row's leading edge for a keyboard-opened menu's anchor, so the
 *  popup hangs beside the row rather than off the viewport edge. */
const MENU_KEY_ANCHOR_INSET_PX = 12;

/** A last-resort bound on the Menu key's follow-up `contextmenu` canceller, for
 *  a keyup that never arrives; a key held past it disarms too. */
const MENU_KEY_FOLLOW_UP_BOUND_MS = 10_000;

// Paths whose visibility probe has already been attempted this app session, so
// a failing probe (e.g. a signed-out provider) is retried at most once per
// session — no probe storms on every dropdown open. Module-level and read only
// inside the backfill effect (never during render), so React Compiler stays
// happy. Best-effort by design; cleared on reload.
const visibilityAttempted = new Set<string>();
const VISIBILITY_BACKFILL_CONCURRENCY = 3;

/**
 * The full forge-provider fallback chain for a repo, in ONE place so the rows,
 * the context menu, and the visibility backfill all resolve the same provider
 * (a divergence here would probe a different repo set than the badges show).
 * Prefer the persisted provider (right from the first frame), then the live
 * owners query (covers records not yet backfilled), then a gitlab.com host
 * compare (covers records persisted before providers were stored) — with the
 * host itself resolved persisted-then-live via {@link resolveHost}. Pure: the
 * render-scope maps are passed in, so it's never a reactive dependency.
 */
function resolveHost(
  repo: RecentRepo,
  hostByPath: Map<string, string | null>,
): string | undefined {
  return repo.host || hostByPath.get(repo.path) || undefined;
}

/** The row menu's view-on-host label. A stored id this build doesn't know
 *  names no host rather than defaulting to GitHub. */
function viewOnLabel(provider: string | null): string {
  if (provider === null) return `View on ${providerLabel(null)}`;
  const known = knownProvider(provider);
  return known ? `View on ${providerLabel(known)}` : OPEN_IN_BROWSER;
}

function resolveProvider(
  repo: RecentRepo,
  providerByPath: Map<string, string | null>,
  hostByPath: Map<string, string | null>,
): ForgeProvider | null {
  return (repo.provider ??
    providerByPath.get(repo.path) ??
    (resolveHost(repo, hostByPath) === "gitlab.com"
      ? "gitlab"
      : null)) as ForgeProvider | null;
}

/**
 * Filterable list of every repo GitDesktop has opened — a "Recent" shortcut
 * section plus all repos grouped by owner (from each repo's origin remote).
 * Used by the welcome screen and the in-app repo switcher; both render the
 * alias/remove dialogs themselves (the switcher's popover would unmount
 * dialogs nested in here).
 *
 * Keyboard-first: the filter autofocuses; ArrowUp/Down move a highlight
 * through the visible rows and Enter opens the highlighted repo; while
 * filtering, the first match starts highlighted.
 */
export function RepoList({
  currentPath,
  onOpened,
  onAliasRepo,
  onRemoveRepo,
}: {
  currentPath?: string | null;
  onOpened?: () => void;
  onAliasRepo: (repo: RecentRepo) => void;
  onRemoveRepo: (repo: RecentRepo) => void;
}) {
  const settings = useSettings();
  const recents = settings.data?.recentRepos ?? [];
  const owners = useRepoOwners(recents.map((r) => r.path));
  const persistOwners = usePersistRepoOwners();
  const queryClient = useQueryClient();
  const open = useOpenRepoByPath();
  const [filter, setFilter] = useState("");
  const [highlight, setHighlight] = useState(-1);
  const [openingPath, setOpeningPath] = useState<string | null>(null);
  // The row order at an open's click, held until the open resolves false: the
  // recents write moves the opened row to the top while the switch still waits on
  // its warm-up, and a successful open unmounts this list (popover close, the
  // Welcome view swap) before the new order would ever paint.
  const [frozenOrder, setFrozenOrder] = useState<string[] | null>(null);
  // The repo the one shared context menu acts on, set on right-click.
  const [menuRepo, setMenuRepo] = useState<RecentRepo | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  // True from the menu's open until its close animation completes, so the
  // fading popup keeps its items too.
  const [menuShown, setMenuShown] = useState(false);
  // Held for the menu's lifetime, so the escape item can't unmount under the
  // pointer and shift the items below it. A row that left recents (menuRepo is
  // never cleared) asks about nothing, keeping no worktree-list observer alive.
  const menuHint = useReopenHint(
    menuRepo &&
      recents.some(
        (r) => frozenPathKey(r.path) === frozenPathKey(menuRepo.path),
      )
      ? menuRepo.path
      : "",
    currentPath ?? null,
    menuShown,
  );
  const listRef = useRef<HTMLDivElement>(null);
  const filterInputRef = useRef<HTMLInputElement>(null);

  // On the welcome screen "show repositories" means "jump to the filter";
  // inside the switcher popover this list is only mounted while open, so
  // its registration simply outranks the trigger's while visible.
  useHotkeyAction("show-repositories", () => filterInputRef.current?.focus());
  useHotkeyAction("focus-filter", () => filterInputRef.current?.focus());

  const ownerByPath = new Map(
    (owners.data ?? []).map((o) => [o.path, o.owner]),
  );
  // The resolved provider per repo — names it in the context menu. Resolved
  // backend-side so self-managed GitLab hosts (glab's known hosts) label right.
  const providerByPath = new Map(
    (owners.data ?? []).map((o) => [o.path, o.provider]),
  );
  // The owner each repo groups under. Prefer the value stored on the record
  // (synchronous → no reflow on open); fall back to the async query result for
  // a repo not yet backfilled. `OTHER_GROUP` only when neither is known.
  const ownerOf = (r: RecentRepo) =>
    r.owner || ownerByPath.get(r.path) || undefined;

  // The origin remote's host, preferring the stored value (right from the first
  // frame) and falling back to the live owners query for a not-yet-backfilled
  // record. `undefined` when the repo has no remote.
  const hostByPath = new Map((owners.data ?? []).map((o) => [o.path, o.host]));
  const hostOf = (r: RecentRepo) => resolveHost(r, hostByPath);

  // The resolved forge provider for a repo — used by the row's leading glyph,
  // the context menu's "View on …" label, AND the visibility backfill, all via
  // the one module-level `resolveProvider` so they can never diverge. Thin
  // wrapper closing over the render-scope maps.
  const providerOf = (r: RecentRepo): ForgeProvider | null =>
    resolveProvider(r, providerByPath, hostByPath);

  // Backfill resolved owners + hosts + providers + remote repo names onto the
  // recent records so the NEXT open groups (and labels its context menu)
  // synchronously, and remote-name matching works cold. Fires once
  // whenever a record's stored value is stale; the helper no-ops when nothing
  // changed, so its settings refetch doesn't loop.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mutateAsync() is stable; rerun only on resolved owners / records
  useEffect(() => {
    const resolved = owners.data;
    if (!resolved?.length) return;
    const stale = resolved.some((o) => {
      const r = recents.find((rec) => rec.path === o.path);
      return (
        (o.owner || undefined) !== r?.owner ||
        (o.host || undefined) !== r?.host ||
        (o.provider || undefined) !== r?.provider ||
        (o.repoName || undefined) !== r?.repoName
      );
    });
    if (stale) void persistOwners.mutateAsync(resolved).catch(() => undefined);
  }, [owners.data, recents]);

  // Backfill visibility + fork provenance for rows whose provider resolves but
  // whose persisted `visibility` OR `isFork` is still unknown — so their badges
  // fill in progressively. The `isFork === undefined` arm also migrates records
  // probed before fork-ness existed (they carry `visibility` but no `isFork`),
  // which a visibility-only condition would never revisit; both fields land
  // together from the single probe below. Runs a small concurrency-capped queue,
  // persisting each success as it lands, and records every attempted path in a
  // module-level Set (read only here, never in render) so a failing probe is
  // tried at most once per app session.
  // biome-ignore lint/correctness/useExhaustiveDependencies: queryClient is stable; rerun only on the resolved rows / records
  useEffect(() => {
    if (!owners.data) return;
    // Resolve via the shared module-level fn (not `providerOf`, which isn't a
    // dependency) so the backfill probes exactly the repo set the badges show.
    const pending = recents
      .filter(
        (r) =>
          (r.visibility === undefined || r.isFork === undefined) &&
          resolveProvider(r, providerByPath, hostByPath) !== null &&
          !visibilityAttempted.has(r.path),
      )
      .map((r) => r.path);
    if (pending.length === 0) return;

    let cancelled = false;
    let cursor = 0;
    const worker = async () => {
      // `cancelled` only stops STARTING new probes (e.g. the popover closed) —
      // a probe already in flight must still persist when it lands, or its
      // path stays marked attempted with no badge until an app restart. Persist
      // via the raw helper + captured queryClient (both stable across an
      // unmount), not a component-bound mutation that dies with the component.
      while (!cancelled && cursor < pending.length) {
        const path = pending[cursor++];
        visibilityAttempted.add(path);
        try {
          const { visibility, isFork, parent } =
            await forgeRepoVisibility(path);
          await persistRepoVisibility([
            { path, visibility, isFork, forkParent: parent ?? undefined },
          ]);
          queryClient.invalidateQueries({ queryKey: settingsKeys.settings });
        } catch {
          // Signed out / API failure — leave the persisted value alone.
        }
      }
    };
    const workers = Array.from(
      { length: Math.min(VISIBILITY_BACKFILL_CONCURRENCY, pending.length) },
      worker,
    );
    Promise.all(workers).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [owners.data, recents]);

  const q = filter.trim().toLowerCase();
  // Frozen BEFORE the Recent slice and the owner grouping, so section membership
  // holds too; rows that moved between sections would remount under new keys.
  const ordered = applyFrozenOrder(recents, frozenOrder, (r) =>
    frozenPathKey(r.path),
  );
  const filtered = ordered.filter(
    (r) =>
      !q ||
      r.name.toLowerCase().includes(q) ||
      (r.alias ?? "").toLowerCase().includes(q) ||
      r.path.toLowerCase().includes(q) ||
      (ownerOf(r) ?? "").toLowerCase().includes(q),
  );

  // Recent shortcut (only when not filtering). Excluded from the owner groups
  // below so a repo is never listed twice.
  const recent = q ? [] : filtered.slice(0, RECENT_COUNT);
  const recentPaths = new Set(recent.map((r) => r.path));

  // Group the remaining repos by owner; "Other" (no remote) sorts last.
  const groups = new Map<string, RecentRepo[]>();
  for (const r of filtered) {
    if (recentPaths.has(r.path)) continue;
    const owner = ownerOf(r) || OTHER_GROUP;
    const list = groups.get(owner);
    if (list) list.push(r);
    else groups.set(owner, [r]);
  }
  const groupNames = [...groups.keys()].sort((a, b) => {
    if (a === OTHER_GROUP) return 1;
    if (b === OTHER_GROUP) return -1;
    return a.localeCompare(b);
  });

  // Flattened render order, for arrow-key navigation.
  const visible = [
    ...recent,
    ...groupNames.flatMap((name) => groups.get(name) ?? []),
  ];
  // -1 sentinel = no cursor yet (unarrowed since the last filter edit, or the
  // list was empty). With a filter typed the first match is the cursor (Enter
  // opens it, so it must be marked); with none, a stray Enter opens nothing.
  const active =
    !q && highlight < 0 ? -1 : clampHighlight(highlight, visible.length);
  const highlightedPath = visible[active]?.path ?? null;

  // Keep the marked row in view, re-running when its index or its identity
  // changes: filtering can move one without the other.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run per marked row and slot
  useEffect(() => {
    listRef.current
      ?.querySelector('[data-highlighted="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [active, highlightedPath]);

  // The one route into `open`; the guard backs up the disabled rows and escape
  // item while an open is in flight.
  async function handleOpen(path: string, opts?: { preferMain?: boolean }) {
    if (openingPath !== null) return;
    setOpeningPath(path);
    setFrozenOrder(ordered.map((r) => frozenPathKey(r.path)));
    try {
      if (
        !(await open(path, "recent", undefined, {
          preferMain: opts?.preferMain === true,
        }))
      )
        setFrozenOrder(null);
      onOpened?.();
    } finally {
      setOpeningPath(null);
    }
  }

  /**
   * Opens the highlighted row's context menu from the keyboard. A real
   * `contextmenu` event is the only route: Base UI anchors the popup solely
   * from such an event, and handleContextMenu reads the row off its target.
   * Found through the highlight marker, never an id: repoOptionId can collide.
   */
  function openHighlightedRowMenu() {
    const menuTarget = listRef.current?.querySelector(
      '[data-highlighted="true"] [role="option"]',
    );
    if (!menuTarget) return;
    const rect = menuTarget.getBoundingClientRect();
    menuTarget.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: Math.round(rect.left + MENU_KEY_ANCHOR_INSET_PX),
        clientY: Math.round(rect.top + rect.height / 2),
      }),
    );
  }

  // WebView2 follows the Menu key's keyup with a trusted `contextmenu` that would
  // stack its native menu over ours: cancel that one (never stop it), armed until
  // it fires, a task after the keyup, a window blur, or the last-resort bound.
  const disarmMenuKeyFollowUp = useRef<(() => void) | null>(null);
  useEffect(() => () => disarmMenuKeyFollowUp.current?.(), []);

  function armMenuKeyFollowUp() {
    disarmMenuKeyFollowUp.current?.();
    let afterKeyUp: number | undefined;
    let bound: number | undefined;
    const onContextMenu = (ev: Event) => {
      ev.preventDefault();
      disarm();
    };
    const onKeyUp = (ev: KeyboardEvent) => {
      if (ev.key === "ContextMenu") afterKeyUp ??= window.setTimeout(disarm, 0);
    };
    const disarm = () => {
      document.removeEventListener("contextmenu", onContextMenu, true);
      document.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", disarm);
      window.clearTimeout(afterKeyUp);
      window.clearTimeout(bound);
      if (disarmMenuKeyFollowUp.current === disarm)
        disarmMenuKeyFollowUp.current = null;
    };
    document.addEventListener("contextmenu", onContextMenu, true);
    document.addEventListener("keyup", onKeyUp, true);
    // A keyup that lands in another window would otherwise leave it armed.
    window.addEventListener("blur", disarm);
    bound = window.setTimeout(disarm, MENU_KEY_FOLLOW_UP_BOUND_MS);
    disarmMenuKeyFollowUp.current = disarm;
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (hasChordModifier(e)) return;
    // Focus never leaves the filter, so the menu keys would otherwise open the
    // input's own edit menu; with no highlighted row that menu stays reachable.
    if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      if (highlightedPath !== null) {
        e.preventDefault();
        openHighlightedRowMenu();
        if (e.key === "ContextMenu") armMenuKeyFollowUp();
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight(
        active < 0
          ? clampHighlight(0, visible.length)
          : stepHighlight(active, visible.length, 1),
      );
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight(
        active < 0
          ? clampHighlight(0, visible.length)
          : stepHighlight(active, visible.length, -1),
      );
    } else if (e.key === "Enter") {
      // Open the marked row; while filtering the first match carries the
      // cursor. With no filter and no arrowing nothing is marked, so an
      // accidental keypress never opens a repo.
      const target = visible[active];
      if (target && !openingPath)
        handleOpen(target.path, { preferMain: e.shiftKey });
    }
  }

  // One shared context menu for the whole list (capture phase, so it records
  // the row before the menu opens). A right-click on blank space / a section
  // header hits no row — suppress the menu rather than show an empty one.
  function handleContextMenu(e: MouseEvent) {
    const rowEl = (e.target as HTMLElement).closest("[data-repo-path]");
    const path = rowEl?.getAttribute("data-repo-path");
    const repo = path ? recents.find((r) => r.path === path) : undefined;
    if (repo) {
      setMenuRepo(repo);
    } else {
      setMenuRepo(null);
      suppressContextMenu(e);
    }
  }

  const editor = (settings.data?.externalEditor ?? "").trim();
  const editorName =
    (settings.data?.externalEditorName ?? "").trim() || "editor";

  const sectionProps = {
    currentPath: currentPath ?? null,
    highlightedPath,
    openingPath,
    onOpen: handleOpen,
    providerOf,
    hostOf,
  };

  return (
    <div className="flex min-h-0 flex-col">
      <div className={FILTER_ROW_CLASS}>
        <Input
          // the filter is the keyboard entry point of this surface
          autoFocus
          ref={filterInputRef}
          autoComplete="off"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setHighlight(-1);
          }}
          onKeyDown={handleKeyDown}
          placeholder="Filter repositories"
          aria-label="Filter repositories"
          role="combobox"
          // The listbox is always rendered (the empty state lives inside it), and
          // aria-expanded reflects popup visibility, not result count.
          aria-expanded={true}
          aria-controls={REPO_LISTBOX_ID}
          aria-autocomplete="list"
          aria-activedescendant={
            highlightedPath ? repoOptionId(highlightedPath) : undefined
          }
          className={FILTER_INPUT_CLASS}
        />
      </div>
      <ScrollArea className={LIST_VIEWPORT_CLASS} ref={listRef}>
        <ContextMenu
          onOpenChange={(isOpen) => {
            setMenuOpen(isOpen);
            if (isOpen) setMenuShown(true);
          }}
          onOpenChangeComplete={(isOpen) => {
            if (!isOpen) setMenuShown(false);
          }}
        >
          <ContextMenuTrigger
            render={
              <div
                onContextMenuCapture={handleContextMenu}
                role="listbox"
                id={REPO_LISTBOX_ID}
                aria-label="Repositories"
              />
            }
          >
            {filtered.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                {recents.length === 0
                  ? "No repositories yet."
                  : "No repositories match."}
              </p>
            ) : (
              <>
                <RepoSection title="Recent" repos={recent} {...sectionProps} />
                {groupNames.map((name) => (
                  <RepoSection
                    key={name}
                    title={name}
                    repos={groups.get(name) ?? []}
                    {...sectionProps}
                  />
                ))}
              </>
            )}
          </ContextMenuTrigger>
          <ContextMenuContent className="min-w-52">
            {menuRepo && (
              <RepoMenuItems
                repo={menuRepo}
                owner={ownerOf(menuRepo) ?? null}
                provider={providerOf(menuRepo)}
                editor={editor}
                editorName={editorName}
                terminal={settings.data?.terminal}
                terminalPath={settings.data?.terminalPath}
                terminalCommand={settings.data?.terminalCommand}
                onAlias={onAliasRepo}
                onRemove={onRemoveRepo}
                openMainWorkspace={
                  menuHint && menuRepo
                    ? () => handleOpen(menuRepo.path, { preferMain: true })
                    : null
                }
                busy={menuOpen && openingPath !== null}
              />
            )}
          </ContextMenuContent>
        </ContextMenu>
      </ScrollArea>
    </div>
  );
}

interface RepoRowsProps {
  currentPath: string | null;
  highlightedPath: string | null;
  openingPath: string | null;
  onOpen: (path: string, opts?: { preferMain?: boolean }) => void;
  /** Resolves a row's forge provider (shared with the context menu). */
  providerOf: (r: RecentRepo) => ForgeProvider | null;
  /** Resolves a row's origin-remote host, or undefined when local-only. */
  hostOf: (r: RecentRepo) => string | undefined;
}

function RepoSection({
  title,
  repos,
  ...rowProps
}: RepoRowsProps & { title: string; repos: RecentRepo[] }) {
  if (repos.length === 0) return null;
  return (
    // Presentation wrapper so this section div (and its header <p>) doesn't sit
    // as a non-option node between the listbox and its options in the a11y tree.
    <div role="presentation">
      <p className="px-3 pt-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {title}
      </p>
      {repos.map((r) => (
        <RepoRow key={`${title}:${r.path}`} repo={r} {...rowProps} />
      ))}
    </div>
  );
}

/** The trailing visibility badge (icon + accessible label) for a resolved
 *  visibility, or null when it's unknown — absence must never read as public. */
function visibilityBadge(
  visibility: string | undefined,
): { Icon: typeof LockSimpleIcon; label: string } | null {
  if (visibility === "private")
    return { Icon: LockSimpleIcon, label: "Private" };
  if (visibility === "internal")
    return { Icon: BuildingsIcon, label: "Internal" };
  if (visibility === "public")
    return { Icon: GlobeSimpleIcon, label: "Public" };
  return null;
}

function RepoRow({
  repo,
  currentPath,
  highlightedPath,
  openingPath,
  onOpen,
  providerOf,
  hostOf,
}: RepoRowsProps & { repo: RecentRepo }) {
  const highlighted = repo.path === highlightedPath;
  // Normalized: the recents write can respell the row's path (case refresh) while
  // the open is still in flight, and the spinner must stay on it.
  const opening =
    openingPath !== null &&
    frozenPathKey(repo.path) === frozenPathKey(openingPath);
  const provider = providerOf(repo);
  const host = hostOf(repo);
  const badge = visibilityBadge(repo.visibility);
  // Name the upstream when we know it, so the glyph's meaning isn't shape-only.
  const forkLabel = repo.forkParent ? `Fork of ${repo.forkParent}` : "Fork";
  // Held while an open is in flight, so an earlier landing's late record write
  // can't reflow the row under the spinner.
  const hint = useReopenHint(repo.path, currentPath, openingPath !== null);

  return (
    <div
      data-repo-path={repo.path}
      data-highlighted={highlighted || undefined}
      className={cn(
        "flex items-center",
        currentPath === repo.path
          ? "bg-accent text-accent-foreground"
          : highlighted
            ? "bg-muted"
            : "hover:bg-muted/60",
      )}
    >
      <button
        type="button"
        id={repoOptionId(repo.path)}
        role="option"
        aria-selected={highlighted}
        className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left"
        aria-describedby={hint ? reopenDescId(repo.path) : undefined}
        onClick={(e) => onOpen(repo.path, { preferMain: e.shiftKey })}
        // Shift+click is the main-workspace escape; keep it from selecting text.
        onMouseDown={(e) => {
          if (e.shiftKey) e.preventDefault();
        }}
        disabled={openingPath !== null}
      >
        <LeadingGlyph opening={opening} provider={provider} host={host} />
        <span className="min-w-0 flex-1">
          <span
            className={cn("block truncate text-xs", repo.alias && "italic")}
            title={repo.alias ? repo.name : undefined}
          >
            {repoDisplayName(repo)}
          </span>
          <PathText
            path={repo.path}
            className="text-[11px] text-muted-foreground"
          />
          {hint && (
            <span
              className="flex min-w-0 items-center gap-1 text-[10px] leading-tight text-muted-foreground"
              title={reopenTitle(hint.name)}
            >
              <TreeStructureIcon
                className="size-3 shrink-0"
                weight="bold"
                aria-hidden
              />
              <span className="sr-only">opens in worktree </span>
              <span
                className="min-w-0 truncate"
                onMouseEnter={clipTitle(hint.name)}
              >
                {hint.name}
              </span>
            </span>
          )}
        </span>
        {repo.isFork && (
          <span
            className="shrink-0 text-muted-foreground"
            role="img"
            title={forkLabel}
            aria-label={forkLabel}
          >
            <GitForkIcon className="size-3" />
          </span>
        )}
        {badge && (
          <span
            className="shrink-0 text-muted-foreground"
            role="img"
            title={badge.label}
            aria-label={badge.label}
          >
            <badge.Icon className="size-3" />
          </span>
        )}
      </button>
      {/* `hidden`, not sr-only: a describedby reference still reads it, and it
          stays out of the listbox's browse-mode content. */}
      {hint && (
        <span id={reopenDescId(repo.path)} hidden>
          {REOPEN_ESCAPE_DESC}
        </span>
      )}
    </div>
  );
}

/** The row's leading glyph: opening spinner → provider logo → cloud (remote on
 *  an unrecognized host) → folder (local-only). Each informational glyph carries
 *  a `title` + aria-label so its meaning isn't conveyed by shape alone. */
function LeadingGlyph({
  opening,
  provider,
  host,
}: {
  opening: boolean;
  provider: ForgeProvider | null;
  host: string | undefined;
}) {
  if (opening)
    return <Spinner className="size-3.5 shrink-0 text-muted-foreground" />;
  if (provider) {
    const label = providerLabel(provider);
    return (
      <span
        className="shrink-0 text-muted-foreground"
        role="img"
        title={label}
        aria-label={label}
      >
        <ProviderIcon provider={provider} className="size-3.5" />
      </span>
    );
  }
  if (host) {
    const label = `Remote: ${host}`;
    return (
      <span
        className="shrink-0 text-muted-foreground"
        role="img"
        title={label}
        aria-label={label}
      >
        <CloudIcon className="size-3.5" />
      </span>
    );
  }
  const label = "Local repository — no remote";
  return (
    <span
      className="shrink-0 text-muted-foreground"
      role="img"
      title={label}
      aria-label={label}
    >
      <FolderIcon className="size-3.5" />
    </span>
  );
}

/** The shared context menu's items for whichever repo row was right-clicked. */
function RepoMenuItems({
  repo,
  owner,
  provider,
  editor,
  editorName,
  terminal,
  terminalPath,
  terminalCommand,
  onAlias,
  onRemove,
  openMainWorkspace,
  busy,
}: {
  repo: RecentRepo;
  owner: string | null;
  /** The resolved provider ("gitlab", …) — names it on the view item. */
  provider: string | null;
  editor: string;
  editorName: string;
  terminal?: string;
  terminalPath?: string;
  terminalCommand?: string;
  onAlias: (repo: RecentRepo) => void;
  onRemove: (repo: RecentRepo) => void;
  /** The main-workspace escape for a hinted row; null renders no item. */
  openMainWorkspace: (() => void) | null;
  /** An open is in flight while the menu is open; the escape item holds with
   *  its reason, and a closing menu keeps the label the user clicked. */
  busy: boolean;
}) {
  return (
    <>
      {openMainWorkspace && (
        <>
          <ContextMenuItem
            className={MENU_HELD_ROW_CLASS}
            disabled={busy}
            onClick={openMainWorkspace}
          >
            {/* A disabled item's tooltip never shows, so the reason rides the
                label. */}
            Open in main workspace{busy && " (a repository is opening)"}
          </ContextMenuItem>
          <ContextMenuSeparator />
        </>
      )}
      <ContextMenuItem onClick={() => onAlias(repo)}>
        {repo.alias ? "Change alias…" : "Create alias…"}
      </ContextMenuItem>
      <ContextMenuItem
        onClick={() => copyText(repo.name, "Repository name copied")}
      >
        Copy repo name
      </ContextMenuItem>
      <ContextMenuItem
        onClick={() => copyText(repo.path, "Repository path copied")}
      >
        Copy repo path
      </ContextMenuItem>
      <ContextMenuSeparator />
      {owner && (
        <ContextMenuItem
          onClick={() =>
            forgeRepoUrl(repo.path)
              .then((url) => openUrl(url))
              .catch(toastError)
          }
        >
          {/* Name the repo's actual provider (incl. self-managed GitLab and
              Bitbucket); unrecognized hosts route through gh (Enterprise etc.),
              so GitHub is the honest default label. */}
          {viewOnLabel(provider)}
        </ContextMenuItem>
      )}
      <ContextMenuItem
        onClick={() =>
          openInTerminal(
            repo.path,
            terminal,
            terminalPath,
            terminalCommand,
          ).catch(toastError)
        }
      >
        Open in terminal
      </ContextMenuItem>
      <ContextMenuItem
        onClick={() => openWithDefault(repo.path).catch(toastError)}
      >
        Show in Explorer
      </ContextMenuItem>
      {editor && (
        <ContextMenuItem
          onClick={() => openWithProgram(editor, repo.path).catch(toastError)}
        >
          Open in {editorName}
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => onRemove(repo)}>Remove…</ContextMenuItem>
    </>
  );
}
