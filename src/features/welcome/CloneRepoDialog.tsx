import {
  ArrowsClockwiseIcon,
  BookBookmarkIcon,
  GitForkIcon,
  LockSimpleIcon,
} from "@phosphor-icons/react";
import { useSelector } from "@tanstack/react-store";
import { useVirtualizer } from "@tanstack/react-virtual";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { groupByOwnerNamespace } from "@/features/explore/explore-utils";
import { useAppForm } from "@/lib/form";
import { cloneRepo, forgeClone, validateRepo } from "@/lib/git/api";
import { useForgeRepos } from "@/lib/git/queries";
import type { ForgeProvider, ForgeRepo } from "@/lib/git/types";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { repoStateLabel } from "@/lib/repo-labels";
import { useAddRecentRepo, useSettings } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { errorMessage, isAppError } from "@/lib/tauri/invoke";
import { toastError } from "@/lib/toast";
import { useSeedOnOpen } from "@/lib/use-seed-on-open";
import { cn } from "@/lib/utils";
import { nameFromUrl, parentDir } from "./clone-utils";

/** GitHub, GitLab, and Bitbucket list your repos to pick from; URL clones
 *  anything by link. */
type CloneTab = "github" | "gitlab" | "bitbucket" | "url";

/** A flat, virtualizer-friendly view of the owner-grouped repos. */
type Row =
  | { kind: "header"; owner: string }
  | { kind: "repo"; repo: ForgeRepo };

const DEFAULTS = { url: "", destination: "", recurseSubmodules: false };

const REPO_LISTBOX_ID = "clone-repo-listbox";
/** Stable DOM id per repo row, so the filter's aria-activedescendant can point
 *  at the keyboard-highlighted option for screen readers. */
const repoOptionId = (fullName: string) =>
  `clone-repo-${fullName.replace(/[^\w-]/g, "_")}`;

export function CloneRepoDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const openRepo = useUiStore((s) => s.openRepo);
  const addRecent = useAddRecentRepo();
  const settings = useSettings();

  // Tab, selection, and filter are UI state; the URL and local path are form
  // fields so submission and its spinner come from the form.
  const [tab, setTab] = useState<CloneTab>("github");
  const [selected, setSelected] = useState<ForgeRepo | null>(null);
  const [filter, setFilter] = useState("");

  // The active provider tab (github/gitlab/bitbucket) drives which account's
  // repos load; the URL tab loads nothing.
  const provider: ForgeProvider =
    tab === "gitlab" ? "gitlab" : tab === "bitbucket" ? "bitbucket" : "github";
  const repos = useForgeRepos(provider, open && tab !== "url");

  const form = useAppForm({
    defaultValues: DEFAULTS,
    onSubmit: async ({ value }) => {
      const dest = value.destination.trim();
      const cloneUrl =
        tab === "url" ? value.url.trim() : (selected?.cloneUrl ?? "");
      if (!cloneUrl || !dest) return;
      try {
        // GitHub + URL clone via plain git (gh's credential helper covers private
        // GitHub repos); GitLab routes through glab so its token authenticates a
        // private repo that git's credential store doesn't know about. Bitbucket
        // clones over plain git too — a private Bitbucket repo relies on the
        // user's git credential setup (e.g. Git Credential Manager); GitDesktop
        // does not inject the Atlassian API token into git.
        const clonedPath =
          tab === "url"
            ? await cloneRepo(
                cloneUrl,
                dest,
                undefined,
                value.recurseSubmodules,
              )
            : await forgeClone(
                provider,
                cloneUrl,
                dest,
                selected?.name,
                value.recurseSubmodules,
              );
        const info = await validateRepo(clonedPath);
        // Await the recents write so the row exists before RepositoryView mounts
        // and its open-time visibility probe persists onto it (best-effort — a
        // settings-write failure must never block opening the repo).
        await addRecent
          .mutateAsync({ path: info.root, name: info.name })
          .catch(() => undefined);
        onOpenChange(false);
        openRepo(info);
      } catch (e) {
        toastError(e);
      }
    },
  });

  // Default the destination near the user's other repos.
  const defaultPath = useEffectEvent(() => {
    const recent = settings.data?.recentRepos?.[0]?.path;
    return recent ? parentDir(recent) : "";
  });
  const seedOnOpen = useEffectEvent(() => {
    setTab("github");
    setSelected(null);
    setFilter("");
    form.reset(
      { url: "", destination: defaultPath(), recurseSubmodules: false },
      { keepDefaultValues: true },
    );
  });
  useSeedOnOpen(open, seedOnOpen);

  const values = useSelector(form.store, (s) => s.values);
  const isSubmitting = useSelector(form.store, (s) => s.isSubmitting);

  // Group by owner and flatten to rows for the virtualizer, sharing Explore's
  // ordering so the two surfaces list the same repos in the same order. Each group
  // keeps the API's order.
  const rows = useMemo<Row[]>(() => {
    const data = repos.data;
    if (!data) return [];
    const q = filter.trim().toLowerCase();
    const matched = data.repos.filter(
      (r) =>
        !q ||
        r.name.toLowerCase().includes(q) ||
        r.fullName.toLowerCase().includes(q),
    );
    return groupByOwnerNamespace(
      matched,
      (r) => r.owner,
      data.ownedNamespaces,
    ).flatMap(([owner, list]): Row[] => [
      { kind: "header", owner },
      ...list.map((repo) => ({ kind: "repo" as const, repo })),
    ]);
  }, [repos.data, filter]);

  // Just the repo rows in display order, for arrow-key navigation.
  const repoRows = useMemo(
    () => rows.flatMap((r) => (r.kind === "repo" ? [r.repo] : [])),
    [rows],
  );

  // Drop a selection that the filter (or a provider switch) has hidden, so the
  // Clone target always matches what's on screen.
  useEffect(() => {
    if (selected && !repoRows.some((r) => r.fullName === selected.fullName)) {
      setSelected(null);
    }
  }, [repoRows, selected]);

  const onFilterKeyDown = listKeyboardNav({
    items: repoRows,
    activeIndex: repoRows.findIndex((r) => r.fullName === selected?.fullName),
    onActivate: (r) => setSelected(r),
  });

  async function pickDestination() {
    const path = await openDialog({ directory: true, title: "Local path" });
    if (path) form.setFieldValue("destination", path);
  }

  const finalName =
    tab === "url" ? nameFromUrl(values.url) : (selected?.name ?? "");
  const canClone =
    values.destination.trim().length > 0 &&
    (tab === "url" ? values.url.trim().length > 0 : selected !== null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            form.handleSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Clone a repository</DialogTitle>
            <DialogDescription>
              Pick one of your GitHub, GitLab, or Bitbucket repositories, or
              paste a URL. Clones over HTTPS or SSH using your system git
              credentials.
            </DialogDescription>
          </DialogHeader>

          <Tabs value={tab} onValueChange={(v) => setTab(v as CloneTab)}>
            <TabsList className="w-full">
              <TabsTrigger value="github" className="flex-1">
                GitHub
              </TabsTrigger>
              <TabsTrigger value="gitlab" className="flex-1">
                GitLab
              </TabsTrigger>
              <TabsTrigger value="bitbucket" className="flex-1">
                Bitbucket
              </TabsTrigger>
              <TabsTrigger value="url" className="flex-1">
                URL
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {tab !== "url" ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Input
                  autoFocus
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  onKeyDown={onFilterKeyDown}
                  placeholder="Filter your repositories"
                  aria-label="Filter your repositories"
                  role="combobox"
                  aria-expanded={repos.isSuccess}
                  aria-controls={REPO_LISTBOX_ID}
                  aria-autocomplete="list"
                  aria-activedescendant={
                    selected ? repoOptionId(selected.fullName) : undefined
                  }
                  disabled={!repos.isSuccess}
                  className="h-8 flex-1"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  aria-label="Refresh"
                  disabled={repos.isFetching}
                  onClick={() => repos.refetch()}
                >
                  {repos.isFetching ? <Spinner /> : <ArrowsClockwiseIcon />}
                </Button>
              </div>
              <div className="h-72 rounded-none border">
                <RepoBrowser
                  provider={provider}
                  repos={repos}
                  rows={rows}
                  selected={selected}
                  onSelect={setSelected}
                  onUseUrl={() => setTab("url")}
                />
              </div>
            </div>
          ) : (
            <form.AppField name="url">
              {(field) => (
                <field.TextField
                  label="Repository URL or owner/name"
                  placeholder="https://github.com/user/repo.git"
                />
              )}
            </form.AppField>
          )}

          <div className="space-y-1.5">
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <form.AppField name="destination">
                  {(field) => (
                    <field.TextField
                      label="Local path"
                      placeholder="Choose a folder to clone into…"
                    />
                  )}
                </form.AppField>
              </div>
              <Button type="button" variant="outline" onClick={pickDestination}>
                Choose…
              </Button>
            </div>
            {values.destination.trim() && finalName && (
              <p className="truncate text-[11px] text-muted-foreground">
                Clones into{" "}
                <span className="font-mono">
                  {values.destination.trim().replace(/[\\/]$/, "")}
                  {values.destination.includes("/") ? "/" : "\\"}
                  {finalName}
                </span>
              </p>
            )}
          </div>

          <div className="space-y-1">
            <form.AppField name="recurseSubmodules">
              {(field) => (
                <field.CheckboxField
                  label="Clone submodules"
                  className="flex cursor-pointer items-center gap-2 text-xs"
                />
              )}
            </form.AppField>
            <p className="text-[11px] text-muted-foreground">
              Initializes every submodule, including nested ones, after cloning.
            </p>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <form.AppForm>
              {/* Wrap so the disabled reason still shows on hover — a
                  native-disabled button swallows its `title` (vendored Button's
                  pointer-events-none). */}
              <span
                className="inline-flex"
                title={
                  canClone
                    ? undefined
                    : !values.destination.trim()
                      ? "Choose a local path to clone into"
                      : tab === "url"
                        ? "Enter a repository URL to clone"
                        : "Select a repository to clone"
                }
              >
                <form.SubmitButton disabled={!canClone}>
                  Clone
                </form.SubmitButton>
              </span>
            </form.AppForm>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RepoBrowser({
  provider,
  repos,
  rows,
  selected,
  onSelect,
  onUseUrl,
}: {
  provider: ForgeProvider;
  repos: ReturnType<typeof useForgeRepos>;
  rows: Row[];
  selected: ForgeRepo | null;
  onSelect: (repo: ForgeRepo) => void;
  onUseUrl: () => void;
}) {
  const openSettings = useUiStore((s) => s.openSettings);
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => (rows[i].kind === "header" ? 26 : 30),
    overscan: 12,
  });

  // Keep the keyboard-selected repo scrolled into view.
  const selectedKey = selected?.fullName;
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the selection or list changes
  useEffect(() => {
    if (!selectedKey) return;
    const idx = rows.findIndex(
      (r) => r.kind === "repo" && r.repo.fullName === selectedKey,
    );
    if (idx >= 0) virtualizer.scrollToIndex(idx, { align: "auto" });
  }, [selectedKey, rows]);

  if (repos.isPending) {
    return (
      <div className="space-y-2 p-2">
        {["a", "b", "c", "d", "e"].map((k) => (
          <Skeleton key={k} className="h-7 w-full" />
        ))}
      </div>
    );
  }

  if (repos.isError) {
    const kind = isAppError(repos.error) ? repos.error.kind : "";
    const cliMissing = kind === "ghNotFound" || kind === "glabNotFound";
    // Bitbucket has no CLI — an unconfigured account means "add a token in
    // Settings → Accounts" rather than "install a CLI". A general Bitbucket API
    // failure (kind "bitbucket") falls through to the generic error rendering.
    const bbUnconfigured = kind === "bitbucketNotConfigured";
    const cli = provider === "gitlab" ? "GitLab CLI (glab)" : "GitHub CLI (gh)";
    const authCmd = provider === "gitlab" ? "glab auth login" : "gh auth login";
    if (bbUnconfigured) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
          <p className="text-xs font-medium">Connect your Bitbucket account</p>
          <p className="max-w-xs text-xs text-muted-foreground">
            Add an Atlassian API token in Settings → Accounts to browse your
            Bitbucket repositories, or clone from a URL instead.
          </p>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => openSettings("accounts")}
            >
              Open Settings → Accounts
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={onUseUrl}>
              Clone from a URL
            </Button>
          </div>
        </div>
      );
    }
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <p className="text-xs font-medium">
          {cliMissing ? `${cli} not found` : "Couldn't load your repositories"}
        </p>
        <p className="max-w-xs text-xs text-muted-foreground">
          {cliMissing
            ? `Install the ${cli} and run ${authCmd} to browse your repositories, or clone from a URL instead.`
            : errorMessage(repos.error)}
        </p>
        <Button type="button" variant="outline" size="sm" onClick={onUseUrl}>
          Clone from a URL
        </Button>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <p className="flex h-full items-center justify-center p-6 text-center text-xs text-muted-foreground">
        No repositories match.
      </p>
    );
  }

  return (
    <div
      ref={parentRef}
      className="h-full overflow-auto"
      role="listbox"
      id={REPO_LISTBOX_ID}
      aria-label="Your repositories"
    >
      <div
        className="relative w-full"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((v) => {
          const row = rows[v.index];
          return (
            <div
              key={v.key}
              data-index={v.index}
              ref={virtualizer.measureElement}
              // Presentation wrapper so the virtualizer's positioning div doesn't
              // sit between the listbox and its options in the a11y tree.
              role="presentation"
              className="absolute top-0 left-0 w-full"
              style={{ transform: `translateY(${v.start}px)` }}
            >
              {row.kind === "header" ? (
                <p className="bg-muted/50 px-3 pt-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                  {row.owner}
                </p>
              ) : (
                <RepoRow
                  repo={row.repo}
                  active={selected?.fullName === row.repo.fullName}
                  onSelect={onSelect}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RepoRow({
  repo,
  active,
  onSelect,
}: {
  repo: ForgeRepo;
  active: boolean;
  onSelect: (repo: ForgeRepo) => void;
}) {
  const Icon = repo.private
    ? LockSimpleIcon
    : repo.fork
      ? GitForkIcon
      : BookBookmarkIcon;
  // The glyph takes no `title`: the row already hovers its description / full
  // name.
  const stateLabel = repoStateLabel(repo.private, repo.fork);
  return (
    <button
      type="button"
      id={repoOptionId(repo.fullName)}
      role="option"
      aria-selected={active}
      onClick={() => onSelect(repo)}
      title={repo.description ?? repo.fullName}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs",
        active ? "bg-accent text-accent-foreground" : "hover:bg-muted/60",
      )}
    >
      {stateLabel ? (
        <span
          role="img"
          aria-label={stateLabel}
          className="flex shrink-0 items-center text-muted-foreground"
        >
          <Icon className="size-3.5" aria-hidden />
        </span>
      ) : (
        <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      )}
      <span className="min-w-0 flex-1 truncate">{repo.name}</span>
      {repo.archived && (
        <Badge variant="secondary" className="shrink-0 text-[10px]">
          Archived
        </Badge>
      )}
    </button>
  );
}
