// The Changes tab: the working-tree diff list (staged · changed · untracked)
// grouped by section, plus a per-file diff view. F0 froze the export names + props
// and the shared router/api/queries; this package (F23) fills the bodies.

import { ArrowLeftIcon, CaretRightIcon } from "@phosphor-icons/react";
import { useMemo } from "react";
import type { FileEntry } from "@/lib/git/types";
import { DiffText } from "../components/DiffText";
import {
  EmptyState,
  ErrorState,
  isRepoGoneError,
  RepoGoneState,
  SkeletonRows,
  StaleBanner,
} from "../components/states";
import type { DiffStatEntry } from "../lib/api";
import { useFileDiff, useStatus, useWorkingDiff } from "../lib/queries";
import { encodeFileSegment, navigate, repoHash } from "../lib/router";
import { useRovingList } from "../lib/use-roving-list";

// The three working-tree sections, in the order the desktop presents them. The
// route section id is the discriminator (`staged`/`unstaged`/`untracked`); the
// heading is its human label.
type Section = "staged" | "unstaged" | "untracked";
const SECTION_LABELS: Record<Section, string> = {
  staged: "Staged",
  unstaged: "Changes",
  untracked: "Untracked",
};

/** One row's data: the file path, the section it belongs to (drives the diff-side
 *  flags), and its optional line-count stats (joined from the working diff). */
interface ChangeRow {
  path: string;
  section: Section;
  added: number | null;
  deleted: number | null;
  isBinary: boolean;
}

/** Partition the status entries into the three sections. A file staged AND
 *  unstaged appears in BOTH the Staged and Changes sections (git's index vs.
 *  working-tree distinction). Untracked is the `unstaged === "untracked"` marker.
 *  Stats come from the working diff, joined by path (a missing stat leaves the
 *  numbers off — never blocks the row). */
function buildRows(
  entries: FileEntry[],
  stats: Map<string, DiffStatEntry>,
): { staged: ChangeRow[]; unstaged: ChangeRow[]; untracked: ChangeRow[] } {
  const staged: ChangeRow[] = [];
  const unstaged: ChangeRow[] = [];
  const untracked: ChangeRow[] = [];
  for (const e of entries) {
    const stat = stats.get(e.path);
    const base = {
      path: e.path,
      added: stat ? stat.added : null,
      deleted: stat ? stat.deleted : null,
      isBinary: stat ? stat.isBinary : false,
    };
    if (e.staged) staged.push({ ...base, section: "staged" });
    if (e.unstaged === "untracked") {
      untracked.push({ ...base, section: "untracked" });
    } else if (e.unstaged) {
      unstaged.push({ ...base, section: "unstaged" });
    }
  }
  return { staged, unstaged, untracked };
}

/** The working-tree changes list, grouped by section. `active` gates polling. The
 *  status query is the authoritative per-section truth (already cached/polled by
 *  the hub); the working diff is a stats lookup joined by path — a failure there
 *  never blocks the row list, only omits the `+n −n` numbers. */
export function ChangesBody({
  repoId,
  active,
}: {
  repoId: string;
  active: boolean;
}) {
  const { data, isError, error, refetch } = useStatus(repoId, active);
  const workingDiff = useWorkingDiff(repoId, active);
  const { register, onKeyDown } = useRovingList();

  // Index the working diff's per-file stats by path for an O(1) join. Memoized on
  // the diff data so the map is stable across renders (and cheap when it's absent).
  const stats = useMemo(() => {
    const map = new Map<string, DiffStatEntry>();
    for (const f of workingDiff.data?.files ?? []) map.set(f.path, f);
    return map;
  }, [workingDiff.data]);

  // Definitive gone WINS over stale data: a `noSuchRepo` 404 kicks to the teaching
  // state even when a cached status is on hand (mirrors StatusBody/PrsBody).
  if (isRepoGoneError(error)) return <RepoGoneState />;

  if (!data) {
    if (isError) return <ErrorState error={error} onRetry={() => refetch()} />;
    return <SkeletonRows />;
  }

  const { staged, unstaged, untracked } = buildRows(data.entries, stats);
  const sections: { id: Section; rows: ChangeRow[] }[] = [
    { id: "staged", rows: staged },
    { id: "unstaged", rows: unstaged },
    { id: "untracked", rows: untracked },
  ];
  const empty = staged.length + unstaged.length + untracked.length === 0;

  // A single running index across ALL sections so roving arrow-key nav flows
  // through the whole list (not per-section). Bumped as each row registers.
  let rowIndex = 0;

  return (
    <div className="flex flex-col">
      {isError ? <StaleBanner error={error} onRetry={() => refetch()} /> : null}
      {empty ? (
        <EmptyState
          title="Working tree clean."
          hint="Changes you make on the desktop will show up here."
        />
      ) : (
        <div className="flex flex-col">
          {sections.map((s) =>
            s.rows.length === 0 ? null : (
              <section key={s.id} className="flex flex-col">
                <h2 className="sticky top-0 z-10 bg-background/95 px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground backdrop-blur">
                  {SECTION_LABELS[s.id]} · {s.rows.length}
                </h2>
                <ul className="flex flex-col divide-y divide-border">
                  {s.rows.map((row) => {
                    const i = rowIndex++;
                    return (
                      <li key={`${s.id}:${row.path}`}>
                        <button
                          type="button"
                          ref={register(i)}
                          onKeyDown={onKeyDown}
                          onClick={() =>
                            navigate(
                              repoHash(
                                repoId,
                                `changes/${s.id}/${encodeFileSegment(row.path)}`,
                              ),
                            )
                          }
                          className="flex w-full min-h-14 items-center gap-3 px-4 py-3 text-left"
                        >
                          <ChangeRowContent row={row} />
                          <CaretRightIcon
                            size={16}
                            className="shrink-0 text-muted-foreground"
                          />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ),
          )}
        </div>
      )}
    </div>
  );
}

/** One change row: the file path (tail kept visible when long) with its `+n −n`
 *  stats or a binary chip. */
function ChangeRowContent({ row }: { row: ChangeRow }) {
  return (
    <div className="min-w-0 flex-1">
      <p className="truncate text-sm text-foreground" title={row.path}>
        {row.path}
      </p>
      <p className="mt-0.5 flex items-center gap-2 text-xs">
        {row.isBinary ? (
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-muted-foreground">
            binary
          </span>
        ) : row.added !== null || row.deleted !== null ? (
          <span className="tabular-nums">
            <span className="text-success">+{row.added ?? 0}</span>{" "}
            <span className="text-destructive">−{row.deleted ?? 0}</span>
          </span>
        ) : null}
      </p>
    </div>
  );
}

/** A single file's diff, scoped to one working-tree section. `filePath` is the
 *  decoded repo-relative path. The staged/untracked flags select the diff side. */
export function ChangesFileBody({
  repoId,
  section,
  filePath,
}: {
  repoId: string;
  section: Section;
  filePath: string;
}) {
  const { data, isPending, isError, error, refetch } = useFileDiff(
    repoId,
    filePath,
    { staged: section === "staged", untracked: section === "untracked" },
  );

  // Definitive gone WINS: the whole detail (back-bar included) is replaced by the
  // teaching state (mirrors PrDetail).
  if (isRepoGoneError(error)) return <RepoGoneState />;

  return (
    <div className="flex flex-col">
      <DetailBackBar
        label="Changes"
        onBack={() => navigate(repoHash(repoId, "changes"))}
        path={filePath}
      />
      {isError ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : isPending || !data ? (
        <SkeletonRows count={4} />
      ) : (
        <DiffText
          text={data.text}
          truncated={data.isTruncated}
          isBinary={data.isBinary}
        />
      )}
    </div>
  );
}

/** The sticky detail back bar shared by the Changes/History file-diff views — an
 *  ArrowLeft + section label, plus the file path as a heading. Long paths keep
 *  their TAIL visible (the filename matters more than the leading dirs), so the
 *  path truncates from the START. */
export function DetailBackBar({
  label,
  onBack,
  path,
}: {
  label: string;
  onBack: () => void;
  path: string;
}) {
  return (
    <div className="sticky top-0 z-10 flex flex-col gap-1 border-b border-border bg-background/95 px-2 py-2 backdrop-blur">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex min-h-11 items-center gap-1 self-start rounded px-2 text-sm font-medium text-primary"
      >
        <ArrowLeftIcon size={16} />
        {label}
      </button>
      {/* `direction: rtl` + text-align left flips the truncation ellipsis to the
          START so the filename tail stays visible; `dir="ltr"` on an inner span
          keeps the path text itself in normal reading order. */}
      <p
        className="truncate px-2 text-right font-mono text-xs text-foreground/90"
        style={{ direction: "rtl" }}
        title={path}
      >
        <span dir="ltr">{path}</span>
      </p>
    </div>
  );
}
