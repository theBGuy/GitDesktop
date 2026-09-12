/** A directory row of a compacted path tree. */
export interface PathTreeFolderRow {
  kind: "folder";
  /** Full directory path of the node's DEEPEST segment (e.g.
   *  "src/features/repository") — the collapse identity. Stable when compaction
   *  changes as siblings appear and disappear. */
  path: string;
  /** Compacted label relative to the parent (e.g. "features/repository"). */
  label: string;
  depth: number;
  /** Total descendant leaves, including those hidden under nested collapse. */
  fileCount: number;
}

/** A file row of a compacted path tree, carrying the caller's own item. */
export interface PathTreeLeafRow<T> {
  kind: "leaf";
  item: T;
  depth: number;
}

export type PathTreeRow<T> = PathTreeFolderRow | PathTreeLeafRow<T>;

/**
 * Last path segment ("src/lib/x.ts" → "x.ts"). Splits on "/" ALONE: these are
 * git repo paths, where "\" is a legal POSIX filename character, and this helper
 * DISCARDS the prefix — splitting on "\" too would drop half of `foo\bar.ts` and
 * collide it with a real `bar.ts`. Truncating displays like `PathText` may treat
 * both as separators because they keep both sides. `checkout-copy.ts`'s
 * `baseName` splits the same way for its own domain (git-reported worktree
 * paths) — a shared spelling, not a shared contract, so keep them separate.
 */
export function pathBasename(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? path : path.slice(cut + 1);
}

/** Hoisted: a per-comparison collator is the expensive half of a sort this size. */
const NAME_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

/** Numeric-aware, case-insensitive name order — "file2" before "file10". */
function compareNames(a: string, b: string): number {
  return NAME_COLLATOR.compare(a, b);
}

interface DirNode<T> {
  /** Full path of this directory ("" at the root). */
  path: string;
  dirs: Map<string, DirNode<T>>;
  leaves: T[];
  /** Descendant leaves, counted as the tree is built. */
  count: number;
}

/**
 * Builds a compacted directory tree over `items`' slash-separated paths and
 * flattens it to render-order rows, omitting descendants of folders whose
 * `path` is in `collapsed` (a collapsed folder row itself still appears, with
 * its full `fileCount`). Folders sort before leaves, both by name.
 *
 * Compaction is the VS Code SCM shape: a directory holding one subdirectory and
 * no files of its own merges into it, so one ROW can span several path segments
 * and `depth` counts rows, not segments.
 */
export function flattenPathTree<T>(
  items: T[],
  getPath: (item: T) => string,
  collapsed: ReadonlySet<string>,
): PathTreeRow<T>[] {
  const root: DirNode<T> = {
    path: "",
    dirs: new Map(),
    leaves: [],
    count: 0,
  };
  for (const item of items) {
    const segments = getPath(item).split("/");
    let node = root;
    node.count++;
    for (const name of segments.slice(0, -1)) {
      let child = node.dirs.get(name);
      if (!child) {
        child = {
          path: node.path ? `${node.path}/${name}` : name,
          dirs: new Map(),
          leaves: [],
          count: 0,
        };
        node.dirs.set(name, child);
      }
      child.count++;
      node = child;
    }
    node.leaves.push(item);
  }

  const rows: PathTreeRow<T>[] = [];
  const emit = (node: DirNode<T>, depth: number) => {
    const dirs = [...node.dirs.entries()].toSorted((a, b) =>
      compareNames(a[0], b[0]),
    );
    for (const [name, child] of dirs) {
      let folder = child;
      let label = name;
      // A collapsed node ends its chain: compacting THROUGH it would re-key the
      // row to a deeper path, and the row would render expanded again.
      while (
        folder.leaves.length === 0 &&
        folder.dirs.size === 1 &&
        !collapsed.has(folder.path)
      ) {
        const [onlyName, only] = [...folder.dirs.entries()][0];
        label = `${label}/${onlyName}`;
        folder = only;
      }
      rows.push({
        kind: "folder",
        path: folder.path,
        label,
        depth,
        fileCount: folder.count,
      });
      if (!collapsed.has(folder.path)) emit(folder, depth + 1);
    }
    const leaves = node.leaves.toSorted((a, b) =>
      compareNames(pathBasename(getPath(a)), pathBasename(getPath(b))),
    );
    for (const item of leaves) rows.push({ kind: "leaf", item, depth });
  };
  emit(root, 0);
  return rows;
}
