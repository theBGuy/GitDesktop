import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { globLiteralPath, literalPathspec } from "@/lib/git/glob";
import {
  useForceAdd,
  useIgnoredFiles,
  useTrackedFiles,
  useUnignoreRules,
  useUntrack,
} from "@/lib/git/queries";
import type { IgnoredFile } from "@/lib/git/types";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { toastError } from "@/lib/toast";
import { cn } from "@/lib/utils";

type Tab = "tracked" | "ignored";

/** The .gitignore rule that untracking a file adds, anchored to the repo root
 *  and escaped so a path holding `[`, `*` or `?` matches only itself. */
const ignorePattern = (path: string) => `/${globLiteralPath(path)}`;

/** How that rule reads to a human — the same anchored path without the glob
 *  escapes, which are noise to everyone but git. */
const ignoreLabel = (path: string) => `/${path}`;

/** What a pending confirm dialog will do once accepted. */
type Pending =
  | { kind: "untrack"; paths: string[] }
  | { kind: "forceAdd"; paths: string[] }
  | { kind: "removeRule"; rules: { source: string; pattern: string }[] }
  | null;

export function RepositoryFilesDialog({
  repoPath,
  open,
  onOpenChange,
}: {
  repoPath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [tab, setTab] = useState<Tab>("tracked");
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // The keyboard-focused row (arrow-key navigation) and the pivot a Shift+Arrow
  // range extends from — both tracked by path so they survive re-renders.
  const [activePath, setActivePath] = useState<string | null>(null);
  const [anchorPath, setAnchorPath] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);

  const tracked = useTrackedFiles(repoPath, open && tab === "tracked");
  const ignored = useIgnoredFiles(repoPath, open && tab === "ignored");
  const untrack = useUntrack(repoPath);
  const forceAdd = useForceAdd(repoPath);
  const unignore = useUnignoreRules(repoPath);
  const onError = (e: unknown) => toastError(e);
  const filterRef = useRef<HTMLInputElement>(null);

  // Reset transient state whenever the active list or the dialog changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: clear on tab/open switch
  useEffect(() => {
    setSelected(new Set());
    setFilter("");
    setActivePath(null);
    setAnchorPath(null);
  }, [tab, open]);

  const q = filter.trim().toLowerCase();
  const ignoredByPath = useMemo(() => {
    const map = new Map<string, IgnoredFile>();
    for (const f of ignored.data ?? []) map.set(f.path, f);
    return map;
  }, [ignored.data]);

  const filtered = useMemo(() => {
    const base =
      tab === "tracked"
        ? (tracked.data ?? [])
        : (ignored.data ?? []).map((f) => f.path);
    return q ? base.filter((p) => p.toLowerCase().includes(q)) : base;
  }, [tab, tracked.data, ignored.data, q]);

  const pendingLoad = tab === "tracked" ? tracked.isPending : ignored.isPending;
  const isError = tab === "tracked" ? tracked.isError : ignored.isError;
  const busy = untrack.isPending || forceAdd.isPending || unignore.isPending;

  // Actions and counts operate on the *visible* selection only: a file hidden
  // by the filter can't be acted on (it reappears, still selected, when the
  // filter clears), so you never touch something you can't see.
  const selectedPaths = filtered.filter((p) => selected.has(p));
  const count = selectedPaths.length;

  function toggle(path: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  const activeIndex = activePath ? filtered.indexOf(activePath) : -1;

  // ArrowUp/Down move the focused row; Shift extends a range from the anchor.
  // Wired on both the filter input and the list, so arrows always navigate
  // (never scroll) regardless of where focus sits.
  const navKeyDown = listKeyboardNav({
    items: filtered,
    activeIndex,
    onActivate: (path, to, shift) => {
      setActivePath(path);
      if (shift) {
        const anchor = anchorPath ?? activePath ?? path;
        const a = filtered.indexOf(anchor);
        if (a !== -1) {
          const [lo, hi] = a <= to ? [a, to] : [to, a];
          setSelected((prev) => {
            const next = new Set(prev);
            for (let i = lo; i <= hi; i++) next.add(filtered[i]);
            return next;
          });
        }
      } else {
        setAnchorPath(path);
      }
    },
  });
  // Enter toggles the focused row from the filter input (Space stays free to type).
  function onFilterKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" && activePath && filtered.includes(activePath)) {
      e.preventDefault();
      toggle(activePath);
      return;
    }
    navKeyDown(e);
  }
  // Inside the list, Space/Enter on the container toggles the focused row; a
  // focused checkbox handles its own Space natively, so only act on the container.
  function onListKeyDown(e: KeyboardEvent) {
    if (
      (e.key === "Enter" || e.key === " ") &&
      e.target === e.currentTarget &&
      activePath &&
      filtered.includes(activePath)
    ) {
      e.preventDefault();
      toggle(activePath);
      return;
    }
    navKeyDown(e);
  }

  // Header checkbox toggles every (filtered) row.
  const allSelected =
    filtered.length > 0 && filtered.every((p) => selected.has(p));
  function toggleAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) for (const p of filtered) next.delete(p);
      else for (const p of filtered) next.add(p);
      return next;
    });
  }

  function runUntrack(paths: string[]) {
    untrack.mutate(
      {
        pathspecs: paths.map(literalPathspec),
        ignorePatterns: paths.map(ignorePattern),
      },
      {
        onSuccess: () => {
          toast.success(
            `Untracked ${paths.length} file${paths.length === 1 ? "" : "s"} — kept on disk, added to .gitignore`,
          );
          setSelected(new Set());
          setPending(null);
        },
        onError: (e) => {
          onError(e);
          setPending(null);
        },
      },
    );
  }

  function runForceAdd(paths: string[]) {
    forceAdd.mutate(paths.map(literalPathspec), {
      onSuccess: () => {
        toast.success(`Force-added ${paths.length} items`);
        setSelected(new Set());
        setPending(null);
      },
      onError: (e) => {
        onError(e);
        setPending(null);
      },
    });
  }

  function runRemoveRules(rules: { source: string; pattern: string }[]) {
    unignore.mutate(rules, {
      onSuccess: () => {
        toast.success(
          `Removed ${rules.length} rule${rules.length === 1 ? "" : "s"} from .gitignore`,
        );
        setSelected(new Set());
        setPending(null);
      },
      onError: (e) => {
        onError(e);
        setPending(null);
      },
    });
  }

  // The distinct rules behind the selected ignored files (deduped — several
  // files can share one pattern like `*.log`).
  function selectedRules() {
    const seen = new Set<string>();
    const rules: { source: string; pattern: string }[] = [];
    for (const path of selectedPaths) {
      const f = ignoredByPath.get(path);
      if (!f || !f.pattern) continue;
      const key = `${f.source} ${f.pattern}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rules.push({ source: f.source, pattern: f.pattern });
    }
    return rules;
  }

  const rules = selectedRules();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[80vh] flex-col sm:max-w-2xl"
        initialFocus={() => filterRef.current}
      >
        <DialogHeader>
          <DialogTitle>Repository files</DialogTitle>
          <DialogDescription>
            Manage what git tracks beyond your pending changes — untrack files
            committed by mistake, or surface and re-add files ignored by
            mistake.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant={tab === "tracked" ? "secondary" : "ghost"}
            size="xs"
            aria-pressed={tab === "tracked"}
            onClick={() => setTab("tracked")}
          >
            Tracked
          </Button>
          <Button
            type="button"
            variant={tab === "ignored" ? "secondary" : "ghost"}
            size="xs"
            aria-pressed={tab === "ignored"}
            onClick={() => setTab("ignored")}
          >
            Ignored
          </Button>
        </div>

        <Input
          ref={filterRef}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={onFilterKeyDown}
          placeholder={`Filter ${tab} files — ↑↓ to move, Enter to select`}
          aria-label={`Filter ${tab} files`}
          className="h-8"
          autoComplete="off"
        />

        {filtered.length > 0 && (
          <label className="flex cursor-pointer items-center gap-2 px-1 text-xs text-muted-foreground">
            <Checkbox checked={allSelected} onCheckedChange={toggleAll} />
            <span className="flex-1">
              {count > 0
                ? `${count} selected`
                : `${filtered.length} ${tab} file${filtered.length === 1 ? "" : "s"}`}
            </span>
          </label>
        )}

        <div className="min-h-0 flex-1 border">
          {pendingLoad ? (
            <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
              <Spinner /> Loading…
            </div>
          ) : isError ? (
            <p className="p-4 text-xs text-muted-foreground">
              Couldn't load {tab} files.
            </p>
          ) : filtered.length === 0 ? (
            <p className="p-4 text-xs text-muted-foreground">
              {filter
                ? "No files match the filter."
                : tab === "tracked"
                  ? "No tracked files."
                  : "Nothing is being ignored."}
            </p>
          ) : (
            <FileList
              paths={filtered}
              ignoredByPath={ignoredByPath}
              selected={selected}
              activePath={activePath}
              rowHeight={tab === "ignored" ? 48 : 30}
              onToggle={toggle}
              onKeyDown={onListKeyDown}
            />
          )}
        </div>

        <DialogFooter className="flex-wrap gap-2 sm:justify-start">
          {count === 0 ? (
            <p className="text-xs text-muted-foreground">
              Select files to act on them.
            </p>
          ) : tab === "tracked" ? (
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                setPending({ kind: "untrack", paths: selectedPaths })
              }
            >
              Untrack {count} {count === 1 ? "file" : "files"} (keep on disk)
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  setPending({ kind: "forceAdd", paths: selectedPaths })
                }
              >
                Force-add {count}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy || rules.length === 0}
                onClick={() => setPending({ kind: "removeRule", rules })}
              >
                Remove {rules.length} rule{rules.length === 1 ? "" : "s"}
              </Button>
            </>
          )}
          {count > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={() => setSelected(new Set())}
            >
              Clear
            </Button>
          )}
        </DialogFooter>
      </DialogContent>

      {/* Confirm the .gitignore-affecting / index-bloating actions. Returns
          focus to the filter when it closes, since the action button it opened
          from often disappears (the selection clears) on success. */}
      <Dialog
        open={pending !== null}
        onOpenChange={(o) => !o && setPending(null)}
      >
        <DialogContent finalFocus={() => filterRef.current}>
          <DialogHeader>
            <DialogTitle>
              {pending?.kind === "untrack"
                ? `Untrack ${pending.paths.length} ${pending.paths.length === 1 ? "file" : "files"}?`
                : pending?.kind === "forceAdd"
                  ? `Force-add ${pending.paths.length} ${pending.paths.length === 1 ? "item" : "items"}?`
                  : `Remove ${pending?.kind === "removeRule" ? pending.rules.length : 0} .gitignore rule${pending?.kind === "removeRule" && pending.rules.length === 1 ? "" : "s"}?`}
            </DialogTitle>
            <DialogDescription>
              {pending?.kind === "untrack"
                ? "These files stay on disk, but git stops tracking them. Each gets an anchored rule added to .gitignore so it isn't re-added. To undo, remove the rule from the Ignored tab and re-add the file."
                : pending?.kind === "forceAdd"
                  ? "These start being tracked despite .gitignore. A directory (trailing “/”) tracks all of its currently-ignored contents — review the list before confirming:"
                  : "Removing a rule un-ignores every file it matched across the repo — not just the ones you selected. These lines are deleted from their .gitignore files:"}
            </DialogDescription>
          </DialogHeader>
          {pending?.kind === "untrack" && (
            <ul className="max-h-40 overflow-auto border p-2 text-xs">
              {pending.paths.map((p) => (
                <li key={p} className="truncate font-mono" title={p}>
                  {ignoreLabel(p)}
                </li>
              ))}
            </ul>
          )}
          {pending?.kind === "forceAdd" && (
            <ul className="max-h-40 overflow-auto border p-2 text-xs">
              {pending.paths.map((p) => (
                <li key={p} className="truncate font-mono" title={p}>
                  {p}
                  {p.endsWith("/") && (
                    <span className="ml-1 font-sans text-muted-foreground">
                      — directory, adds all contents
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {pending?.kind === "removeRule" && (
            <ul className="max-h-40 overflow-auto border p-2 text-xs">
              {pending.rules.map((r) => (
                <li key={`${r.source}:${r.pattern}`} className="font-mono">
                  {r.pattern}{" "}
                  <span className="font-sans text-muted-foreground">
                    — {r.source}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                if (pending?.kind === "untrack") runUntrack(pending.paths);
                else if (pending?.kind === "forceAdd")
                  runForceAdd(pending.paths);
                else if (pending?.kind === "removeRule")
                  runRemoveRules(pending.rules);
              }}
            >
              {pending?.kind === "untrack"
                ? "Untrack"
                : pending?.kind === "forceAdd"
                  ? "Force-add"
                  : "Remove"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}

/**
 * The virtualized file rows. Lives in its own component — mounted only once data
 * is ready and the dialog is laid out — so the scroll element exists when the
 * virtualizer first observes it (the same structure as CloneRepoDialog's
 * RepoBrowser). Mounting the virtualizer alongside an always-rendered scroll div
 * raced the ref and left the list blank until an unrelated re-render.
 */
function FileList({
  paths,
  ignoredByPath,
  selected,
  activePath,
  rowHeight,
  onToggle,
  onKeyDown,
}: {
  paths: string[];
  ignoredByPath: Map<string, IgnoredFile>;
  selected: Set<string>;
  activePath: string | null;
  rowHeight: number;
  onToggle: (path: string) => void;
  onKeyDown: (e: KeyboardEvent) => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: paths.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
  });

  // Keep the keyboard-focused row scrolled into view (it may not be mounted yet).
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on active/list change
  useEffect(() => {
    if (!activePath) return;
    const idx = paths.indexOf(activePath);
    if (idx >= 0) virtualizer.scrollToIndex(idx, { align: "auto" });
  }, [activePath, paths]);

  return (
    <div
      ref={parentRef}
      className="h-full overflow-y-auto"
      onKeyDown={onKeyDown}
      tabIndex={-1}
    >
      <div
        className="relative w-full"
        style={{ height: `${virtualizer.getTotalSize()}px` }}
      >
        {virtualizer.getVirtualItems().map((vi) => {
          const path = paths[vi.index];
          const info = ignoredByPath.get(path);
          return (
            <div
              key={path}
              data-index={vi.index}
              ref={virtualizer.measureElement}
              className="absolute top-0 left-0 w-full"
              style={{ transform: `translateY(${vi.start}px)` }}
            >
              <label
                className={cn(
                  "flex cursor-pointer items-start gap-2 border-b px-2 py-1.5 text-xs hover:bg-muted/60",
                  selected.has(path) && "bg-accent/60",
                  path === activePath && "ring-1 ring-ring ring-inset",
                )}
              >
                <Checkbox
                  className="mt-0.5"
                  checked={selected.has(path)}
                  onCheckedChange={() => onToggle(path)}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono" title={path}>
                    {path}
                  </span>
                  {info && (
                    <span className="block truncate text-[11px] text-muted-foreground">
                      ignored by{" "}
                      <span className="font-mono">
                        {info.source}
                        {info.line ? `:${info.line}` : ""}
                      </span>{" "}
                      · <span className="font-mono">{info.pattern}</span>
                    </span>
                  )}
                </span>
              </label>
            </div>
          );
        })}
      </div>
    </div>
  );
}
