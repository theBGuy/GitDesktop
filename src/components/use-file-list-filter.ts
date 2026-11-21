import { create, type StoreApi, type UseBoundStore } from "zustand";
import { useUiStore } from "@/lib/stores/ui";

/** One text per host pane. Each scope may be mounted by at most one rail at a time. */
export const FILE_FILTER_SURFACES = {
  history: { scope: "history", claimFocusFilter: false },
  compare: { scope: "compare", claimFocusFilter: true },
  "local-pr-commits": { scope: "local-pr-commits", claimFocusFilter: false },
  "local-pr-files": { scope: "local-pr-files", claimFocusFilter: false },
  session: { scope: "session", claimFocusFilter: false },
  "pr-commits": { scope: "pr-commits", claimFocusFilter: false },
  "pr-files": { scope: "pr-files", claimFocusFilter: false },
  stash: { scope: "stash", claimFocusFilter: false },
  "stash-recoverable": { scope: "stash-recoverable", claimFocusFilter: false },
} as const;
export type FileFilterSurface = keyof typeof FILE_FILTER_SURFACES;

interface FileFilterState {
  texts: Record<string, string>;
  setText: (scope: string, text: string) => void;
}

// By own key: `texts` is a plain object, so a scope named like one of its
// inherited members would otherwise read a function.
function storedText(texts: Record<string, string>, scope: string): string {
  return Object.hasOwn(texts, scope) ? texts[scope] : "";
}

/** In-memory text per scope. Cleared whenever the ui store's `repoPath` changes. */
export const useFileFilterStore: UseBoundStore<StoreApi<FileFilterState>> =
  create<FileFilterState>()((set) => ({
    texts: {},
    setText: (scope, text) =>
      set((s) =>
        storedText(s.texts, scope) === text
          ? s
          : { texts: { ...s.texts, [scope]: text } },
      ),
  }));

// Per-repo state in a separate store: ui.ts's CROSS_REPO_RESET cannot reach it,
// so it clears itself, synchronously inside the switch's set, before the new
// repo's views render. Never through a rail's `setText`, so it pins nothing.
useUiStore.subscribe((s, prev) => {
  if (s.repoPath === prev.repoPath) return;
  if (Object.keys(useFileFilterStore.getState().texts).length > 0) {
    useFileFilterStore.setState({ texts: {} });
  }
});

/** The trimmed, lower-cased query a text filters by; "" filters nothing. */
export function fileFilterQuery(text: string): string {
  return text.trim().toLowerCase();
}

/** THE match rule: `path.toLowerCase().includes(query)`, the Changes list's.
 *  The one place a later matcher replaces. `query` comes from `fileFilterQuery`. */
export function matchesFileFilter(path: string, query: string): boolean {
  return path.toLowerCase().includes(query);
}

/** What the rail needs from a filter. Build it only through `useFileListFilter`. */
export interface DetailRailFilter {
  /** The scope whose text this rail edits; the rail uses it only to recognise
   *  a same-scope successor. */
  scope: string;
  text: string;
  /** The ONLY way the rail changes the text (typing, Escape, x, `Clear filter`).
   *  Pins the open path as the caller's pick first; see `useFileListFilter`. */
  setText: (text: string) => void;
  /** The trimmed query is non-empty: rows are being filtered. */
  active: boolean;
  matchCount: number;
  totalCount: number;
  /** Path of the first rendered row, or null when no row is rendered. */
  firstPath: string | null;
  /** The open file's path while its row is rendered, else null. */
  openRowPath: string | null;
  /** A user pick made from the field (Enter, or Arrow Down onto a row that is not open). */
  onPick: (path: string) => void;
  /** The mount registers the tab-wide `focus-filter` answer (Compare only). */
  claimFocusFilter: boolean;
  /** The caller's `settled`, passed through. While it is false the status holds
   *  its text, and the field's Enter and Arrow Down pick nothing. */
  settled: boolean;
}

export interface FileListFilterOptions<T extends { path: string }> {
  /** Any string; the scopes this package uses are FILE_FILTER_SURFACES' values. */
  scope: string;
  claimFocusFilter?: boolean;
  /** The FULL list in render order; `[]` while nothing is loaded. */
  files: T[];
  /** False while `files` is a placeholder for another identity, or not loaded. */
  settled: boolean;
  /** The caller's explicit pick, or null. The caller owns it and its reset. */
  picked: string | null;
  /** The caller's own pick setter: called for a pick made from the field, and to
   *  pin the open path before a user edit of the text. */
  onPick: (path: string) => void;
}

export interface FileListFilter<T> {
  /** The rows to render AND `listKeyboardNav`'s `items`: `files` itself (same
   *  array) while the query is empty, else the matching rows in order. */
  visible: T[];
  /** The path whose diff is open: replaces each caller's first-file fallback. */
  openPath: string | null;
  /** `visible.findIndex((f) => f.path === openPath)`: `listKeyboardNav`'s `activeIndex`. */
  activeIndex: number;
  /** Pass to `<DetailRail filter>` and `<DetailRailFilterStatus filter>`. */
  rail: DetailRailFilter;
}

/**
 * The file list's text filter, for a consumer that owns its pick or a host that
 * owns it for a presentational child. `openPath` is a live derivation with no
 * state of its own: the caller's valid pick, else (on a settled list under a
 * query) the first match, else the first file, so an untouched filter derives
 * exactly as the caller did before it. Typing never moves the open file because
 * every user edit of the text first pins the open path as the pick; a new list
 * identity opens its first match because the caller's own reset clears the pick.
 * Nothing pins or first-matches on an unsettled list: its rows are another
 * identity's, and a pin taken on them would outlive the switch.
 */
export function useFileListFilter<T extends { path: string }>({
  scope,
  claimFocusFilter = false,
  files,
  settled,
  picked,
  onPick,
}: FileListFilterOptions<T>): FileListFilter<T> {
  const text = useFileFilterStore((s) => storedText(s.texts, scope));
  const query = fileFilterQuery(text);
  const active = query !== "";
  const visible = active
    ? files.filter((f) => matchesFileFilter(f.path, query))
    : files;
  const pickedValid =
    picked !== null && files.some((f) => f.path === picked) ? picked : null;
  const openPath =
    pickedValid ??
    (settled && active ? visible[0]?.path : undefined) ??
    files[0]?.path ??
    null;
  const activeIndex =
    openPath === null ? -1 : visible.findIndex((f) => f.path === openPath);

  // The one text writer the rail gets: the pin and the write land in one
  // handler, so one render batch, and a repeat before the re-render re-pins the
  // same path.
  const setText = (next: string) => {
    if (settled && pickedValid === null && openPath !== null) onPick(openPath);
    useFileFilterStore.getState().setText(scope, next);
  };

  return {
    visible,
    openPath,
    activeIndex,
    rail: {
      scope,
      text,
      setText,
      active,
      matchCount: visible.length,
      totalCount: files.length,
      firstPath: visible[0]?.path ?? null,
      openRowPath: activeIndex === -1 ? null : openPath,
      onPick,
      claimFocusFilter,
      settled,
    },
  };
}
