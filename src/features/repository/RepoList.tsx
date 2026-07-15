import {
  BuildingsIcon,
  CloudIcon,
  FolderIcon,
  GitForkIcon,
  GlobeSimpleIcon,
  LockSimpleIcon,
} from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { type MouseEvent, useEffect, useRef, useState } from "react";
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
import { copyText } from "@/lib/clipboard";
import {
  forgeRepoUrl,
  forgeRepoVisibility,
  openInTerminal,
  openWithDefault,
  openWithProgram,
} from "@/lib/git/api";
import { useRepoOwners } from "@/lib/git/queries";
import { type ForgeProvider, providerLabel } from "@/lib/git/types";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
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
import { useOpenRepoByPath } from "./useOpenRepoByPath";

const RECENT_COUNT = 5;
const OTHER_GROUP = "Other";

const REPO_LISTBOX_ID = "repo-list-listbox";
/** Stable DOM id per repo row, so the filter's aria-activedescendant can point
 *  at the keyboard-highlighted option for screen readers. `repo.path` is the
 *  unique key (already the row's `data-repo-path`). */
const repoOptionId = (path: string) =>
  `repo-list-${path.replace(/[^\w-]/g, "_")}`;

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
 * through the visible rows and Enter opens the highlighted repo (or the
 * first match when filtering).
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
  // The repo the one shared context menu acts on, set on right-click.
  const [menuRepo, setMenuRepo] = useState<RecentRepo | null>(null);
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

  // Backfill resolved owners + hosts + providers onto the recent records so the
  // NEXT open groups (and labels its context menu) synchronously. Fires once
  // whenever a record's stored value is stale; the helper no-ops when nothing
  // changed, so its settings refetch doesn't loop.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mutate() is stable; rerun only on resolved owners / records
  useEffect(() => {
    const resolved = owners.data;
    if (!resolved?.length) return;
    const stale = resolved.some((o) => {
      const r = recents.find((rec) => rec.path === o.path);
      return (
        (o.owner || undefined) !== r?.owner ||
        (o.host || undefined) !== r?.host ||
        (o.provider || undefined) !== r?.provider
      );
    });
    if (stale) persistOwners.mutate(resolved);
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
  const filtered = recents.filter(
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
  const highlightedPath = visible[highlight]?.path ?? null;

  // Keep the keyboard highlight in view as it moves.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scrolls to whichever row carries the current highlight
  useEffect(() => {
    listRef.current
      ?.querySelector('[data-highlighted="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  async function handleOpen(path: string) {
    setOpeningPath(path);
    try {
      await open(path);
      onOpened?.();
    } finally {
      setOpeningPath(null);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, visible.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      // Open the highlighted repo, or the first match of a typed filter.
      // Plain Enter with no highlight and no filter does nothing, so an
      // accidental keypress never opens a repo.
      const target = visible[highlight] ?? (q ? visible[0] : undefined);
      if (target && !openingPath) handleOpen(target.path);
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
      e.preventDefault();
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
      <div className="shrink-0 p-2">
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
          className="h-7"
        />
      </div>
      <ScrollArea
        className="min-h-0 **:data-[slot=scroll-area-viewport]:max-h-96"
        ref={listRef}
      >
        <ContextMenu>
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
                onAlias={onAliasRepo}
                onRemove={onRemoveRepo}
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
  onOpen: (path: string) => void;
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
  const opening = repo.path === openingPath;
  const provider = providerOf(repo);
  const host = hostOf(repo);
  const badge = visibilityBadge(repo.visibility);
  // Name the upstream when we know it, so the glyph's meaning isn't shape-only.
  const forkLabel = repo.forkParent ? `Fork of ${repo.forkParent}` : "Fork";

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
        onClick={() => onOpen(repo.path)}
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
          <span className="block truncate text-[11px] text-muted-foreground">
            {repo.path}
          </span>
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
  onAlias,
  onRemove,
}: {
  repo: RecentRepo;
  owner: string | null;
  /** The resolved provider ("gitlab", …) — names it on the view item. */
  provider: string | null;
  editor: string;
  editorName: string;
  terminal?: string;
  terminalPath?: string;
  onAlias: (repo: RecentRepo) => void;
  onRemove: (repo: RecentRepo) => void;
}) {
  return (
    <>
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
          View on {providerLabel(provider as ForgeProvider | null)}
        </ContextMenuItem>
      )}
      <ContextMenuItem
        onClick={() =>
          openInTerminal(repo.path, terminal, terminalPath).catch(toastError)
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
