import { CubeIcon } from "@phosphor-icons/react";
import { type ReactNode, useId } from "react";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { ListRowSkeletons } from "@/components/list-row-skeleton";
import { PathText } from "@/components/path-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DegradedListNotice,
  useRetryFocusRescue,
} from "@/features/conversations/ConversationListPanel";
import {
  detailNoticeMessage,
  refreshFailed,
  resolveDetailPane,
} from "@/features/conversations/remote-section-state";
import { DIFF_PANE_ROOT_CLASS, DiffPathRow } from "@/features/diff/DiffPathRow";
import { useReportPaneSettled } from "@/features/diff/diff-pane-hold";
import { clipTitleFromText } from "@/lib/clip-title";
import { presentError } from "@/lib/error-summary";
import { KIND_BADGE } from "@/lib/git/change-kind-badge";
import { useSubmoduleChanges } from "@/lib/git/queries";
import type {
  SubmoduleChanges,
  SubmoduleCheckout,
  SubmoduleCommit,
} from "@/lib/git/types";
import { dispatchAction } from "@/lib/hotkeys/handler-registry";
import { useOpenSubmoduleAsRepo } from "./useOpenSubmoduleAsRepo";

const NO_CHECKOUT_REASON = "This submodule has no checkout on disk";

const short = (sha: string | null) => (sha ?? "").slice(0, 7);

/** The HEAD badge for a checkout the read could not look inside. */
const CHECKOUT_BADGE: Partial<Record<SubmoduleCheckout, string>> = {
  notInitialized: "Not initialized",
  missing: "Folder missing",
  replaced: "Replaced by a file",
};

/** Why a differing commit pair has no commit list, by checkout. */
const RANGE_UNKNOWN_LINE: Record<SubmoduleCheckout, string> = {
  ok: "The commits between these two can't be listed from this checkout.",
  unreadable:
    "The commits between these two can't be listed until this submodule can be read.",
  notInitialized:
    "The commits between these two can't be listed without a checkout of the submodule.",
  missing:
    "The commits between these two can't be listed without a checkout of the submodule.",
  replaced:
    "The commits between these two can't be listed without a checkout of the submodule.",
};

function headBadge(data: SubmoduleChanges | undefined): ReactNode {
  if (data === undefined || data.checkout === "unreadable") return null;
  const label = CHECKOUT_BADGE[data.checkout];
  if (label !== undefined) return <Badge variant="outline">{label}</Badge>;
  if (data.head === null)
    return <Badge variant="outline">No commits yet</Badge>;
  if (data.detached)
    return <Badge variant="outline">{`Detached at ${short(data.head)}`}</Badge>;
  if (data.branch !== null)
    return <Badge variant="secondary">{`on ${data.branch}`}</Badge>;
  return null;
}

/**
 * The Changes pane for a submodule row, in place of a text diff: where the
 * submodule's HEAD is, the commits between the recorded and checked-out
 * commit, and the uncommitted files inside, read-only, with Open submodule.
 */
export function SubmoduleChangesPane({
  repoPath,
  path,
  staged,
  origPath,
}: {
  repoPath: string;
  path: string;
  staged: boolean;
  /** A staged rename's old path, where HEAD still records the gitlink. */
  origPath?: string;
}) {
  const changes = useSubmoduleChanges(repoPath, path, staged, origPath);
  useReportPaneSettled(!changes.isPending);
  const openSubmodule = useOpenSubmoduleAsRepo(repoPath);
  // A failed poll keeps the loaded content under a notice; only a read with
  // nothing loaded replaces it.
  const pane = resolveDetailPane({
    pending: changes.isPending,
    error: changes.isError,
    hasData: changes.data !== undefined,
    paused: changes.isPaused,
    fetching: changes.isFetching,
  });
  const failed = refreshFailed(changes);
  // Retry resets the read to pending, swapping the error arm for the
  // skeleton; every arm renders in the same host, so focus lands there.
  const { hostRef, retryRef } = useRetryFocusRescue(
    pane === "error" && changes.isError,
  );
  const data = changes.data;
  const noCheckout =
    data !== undefined && CHECKOUT_BADGE[data.checkout] !== undefined;

  const shell = (content: ReactNode) => (
    <div className={DIFF_PANE_ROOT_CLASS}>
      <DiffPathRow filePath={path} />
      {/* The host wraps the scroller rather than being it. */}
      <div
        ref={hostRef}
        tabIndex={-1}
        className="flex min-h-0 flex-1 flex-col outline-none"
      >
        <DegradedListNotice
          noun="this submodule"
          degraded={pane === "content-degraded"}
          message={detailNoticeMessage({
            noun: "submodule",
            isError: failed,
            stale: changes.isPlaceholderData,
          })}
          onRetry={failed ? () => void changes.refetch() : undefined}
          className="shrink-0 border-b px-3 py-1.5"
        />
        <section
          aria-label="Submodule changes"
          // A tab stop, so keyboard users can scroll a body with no controls.
          tabIndex={0}
          className="min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <div className="flex items-center gap-2 border-b px-3 py-2 text-xs">
            <CubeIcon className="shrink-0 text-muted-foreground" />
            <PathText path={path} className="min-w-0 flex-1 font-mono" />
            {headBadge(data)}
            <DisabledReasonButton
              variant="outline"
              size="xs"
              disabled={noCheckout}
              reason={NO_CHECKOUT_REASON}
              onClick={() => void openSubmodule(path)}
            >
              Open submodule
            </DisabledReasonButton>
          </div>
          {content}
        </section>
      </div>
    </div>
  );

  // The read is local, so it never parks offline: that arm keeps loading.
  if (pane === "skeleton" || pane === "offline") {
    return shell(
      <ListRowSkeletons rows={3} lines={1} name="submodule changes" />,
    );
  }
  if (pane === "error" || data === undefined) {
    return shell(
      <div className="flex flex-col items-start gap-2 p-3 text-xs text-muted-foreground">
        <p>Couldn't read this submodule.</p>
        {changes.isError ? (
          <>
            <p>{presentError(changes.error).summary}</p>
            <Button
              ref={retryRef}
              variant="outline"
              size="sm"
              className="cursor-pointer"
              onClick={() => void changes.refetch()}
            >
              Retry
            </Button>
          </>
        ) : null}
      </div>,
    );
  }
  return shell(
    <SubmoduleChangesBody
      data={data}
      origPath={origPath}
      onRetry={() => void changes.refetch()}
    />,
  );
}

/** Everything the payload decides below the header. Its root is the rescue
 *  host for the `unreadable` Retry, so it stays mounted across that state. */
function SubmoduleChangesBody({
  data,
  origPath,
  onRetry,
}: {
  data: SubmoduleChanges;
  /** A staged rename's old path, which the stage line names. */
  origPath: string | undefined;
  onRetry: () => void;
}) {
  const unreadable = data.checkout === "unreadable";
  const { hostRef, retryRef } = useRetryFocusRescue(unreadable);
  const from7 = short(data.fromSha);
  const to7 = short(data.toSha);
  const removal = data.staged && data.toSha === null;
  const pairDiffers =
    data.fromSha !== null && data.toSha !== null && data.fromSha !== data.toSha;
  const initNote =
    (data.checkout === "notInitialized" || data.checkout === "missing") &&
    !removal;
  const sections: ReactNode[] = [];
  if (data.rangeKnown && data.aheadCount > 0)
    sections.push(
      <CommitSection
        key="ahead"
        heading={`New commits · ${from7} → ${to7}`}
        commits={data.ahead}
        total={data.aheadCount}
      />,
    );
  if (data.rangeKnown && data.behindCount > 0)
    sections.push(
      <CommitSection
        key="behind"
        heading={`Commits no longer included · ${from7} → ${to7}`}
        commits={data.behind}
        total={data.behindCount}
      />,
    );
  if (!data.rangeKnown)
    sections.push(
      <Section key="unknown" heading={`Commit changed · ${from7} → ${to7}`}>
        <p className="text-muted-foreground">
          {RANGE_UNKNOWN_LINE[data.checkout]}
        </p>
      </Section>,
    );
  if (data.staged && data.fromSha === null && data.toSha !== null)
    sections.push(<Section key="new" heading={`New submodule · ${to7}`} />);
  if (removal && data.fromSha !== null)
    sections.push(
      <Section key="removed" heading={`Submodule removed · was ${from7}`} />,
    );
  if (data.files.length > 0)
    sections.push(<FilesSection key="files" data={data} />);
  const stageSentence = STAGE_LINES.find(([applies]) =>
    applies(data, pairDiffers),
  )?.[1];
  const stageLine = stageSentence?.(data, origPath) ?? null;

  return (
    <div
      ref={hostRef}
      tabIndex={-1}
      className="flex flex-col gap-3 p-3 text-xs outline-none"
    >
      {unreadable && (
        <div className="flex flex-col items-start gap-2 text-muted-foreground">
          <p>{`Couldn't read this submodule: ${data.reason ?? ""}`}</p>
          <Button
            ref={retryRef}
            variant="outline"
            size="sm"
            className="cursor-pointer"
            onClick={onRetry}
          >
            Retry
          </Button>
        </div>
      )}
      {initNote && (
        <div className="flex flex-col items-start gap-2 text-muted-foreground">
          <p>
            This submodule has no checkout on disk. Initialize it from
            Submodules in the repository menu.
          </p>
          <Button
            variant="outline"
            size="xs"
            className="cursor-pointer"
            onClick={() => dispatchAction("submodules")}
          >
            Open Submodules
          </Button>
        </div>
      )}
      {data.checkout === "replaced" && (
        <p className="text-muted-foreground">
          A file now sits where this submodule's folder was, so it has no
          checkout on disk.
        </p>
      )}
      {sections}
      {data.checkout === "ok" && sections.length === 0 && (
        <p className="text-muted-foreground">
          {/* A folder in a file's place still has a row to stage, so its line
              says what changed rather than that nothing did. */}
          {!data.staged && data.fromSha === null && data.toSha !== null
            ? "A repository now sits where this file was, with no uncommitted changes inside."
            : "No changes in this submodule right now."}
        </p>
      )}
      {stageLine !== null && (
        <p className="text-muted-foreground">{stageLine}</p>
      )}
    </div>
  );
}

const theseFiles = (d: SubmoduleChanges) =>
  d.filesTotal === 1 ? "this file" : "these files";

/** The stage line: the FIRST row whose test passes; a null sentence says
 *  nothing. `differs` = both shas present and different; `origPath` is a
 *  staged rename's old path. */
const STAGE_LINES: readonly [
  (d: SubmoduleChanges, differs: boolean) => boolean,
  ((d: SubmoduleChanges, origPath: string | undefined) => string) | null,
][] = [
  [
    (d) => d.staged && d.toSha === null,
    () => "The next commit removes this submodule.",
  ],
  [
    (d) => d.staged && d.fromSha === null,
    (d) => `The next commit adds this submodule at ${short(d.toSha)}.`,
  ],
  [
    (d) => d.staged,
    (d, origPath) =>
      origPath === undefined
        ? `The next commit records this submodule at ${short(d.toSha)}.`
        : `The next commit records this submodule at ${short(d.toSha)}, moved from ${origPath}.`,
  ],
  [
    (d) => d.checkout === "replaced",
    () => "Stage this row to record the file in place of the submodule.",
  ],
  [(d) => d.checkout !== "ok", null],
  [
    (d) => d.toSha === null && d.files.length > 0,
    (d) =>
      `Nothing to stage here yet: no commit is checked out in this submodule. Open it to commit ${theseFiles(d)}.`,
  ],
  [
    (d) => d.fromSha === null && d.toSha !== null,
    () => "Stage this row to record a submodule here in place of the file.",
  ],
  [
    (d) => d.fromSha !== null && d.fromSha === d.toSha && d.files.length > 0,
    (d) =>
      `Nothing to stage here yet: the submodule still points at the same commit. Open it to commit ${theseFiles(d)}.`,
  ],
  [
    (d, differs) => differs && d.files.length > 0,
    () =>
      "Staging this row records only the commit the submodule points at. Open the submodule to stage and commit its files.",
  ],
  [
    (d, differs) =>
      differs && d.rangeKnown && d.aheadCount > 0 && d.behindCount === 0,
    (d) =>
      `Stage this row to move this repository's record forward to ${short(d.toSha)}.`,
  ],
  [
    (d, differs) =>
      differs && d.rangeKnown && d.behindCount > 0 && d.aheadCount === 0,
    (d) =>
      `Stage this row to move this repository's record back to ${short(d.toSha)}.`,
  ],
  [
    (_d, differs) => differs,
    (d) => `Stage this row to record ${short(d.toSha)} for this submodule.`,
  ],
];

/** h3, the level the Changes list's own section headings use; a list under it
 *  passes `headingId` and takes `aria-labelledby` from it. */
function Section({
  heading,
  headingId,
  children,
}: {
  heading: string;
  headingId?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <h3 id={headingId} className="font-medium">
        {heading}
      </h3>
      {children}
    </div>
  );
}

function MoreRow({ n }: { n: number }) {
  return <li className="text-muted-foreground">{`and ${n} more`}</li>;
}

function CommitSection({
  heading,
  commits,
  total,
}: {
  heading: string;
  commits: SubmoduleCommit[];
  total: number;
}) {
  const headingId = useId();
  return (
    <Section heading={heading} headingId={headingId}>
      <ul aria-labelledby={headingId} className="flex flex-col gap-0.5">
        {commits.map((c) => (
          <li key={c.sha} className="flex min-w-0 gap-2">
            <span className="shrink-0 font-mono text-muted-foreground">
              {c.sha.slice(0, 7)}
            </span>
            <span className="min-w-0 truncate" onMouseEnter={clipTitleFromText}>
              {c.subject}
            </span>
          </li>
        ))}
        {total > commits.length && <MoreRow n={total - commits.length} />}
      </ul>
    </Section>
  );
}

function FilesSection({ data }: { data: SubmoduleChanges }) {
  const kinds = data.files.map((f) => f.unstaged ?? f.staged ?? "modified");
  const heading = kinds.every((k) => k === "untracked")
    ? "Untracked files inside"
    : "Uncommitted changes inside";
  const headingId = useId();
  return (
    <Section heading={heading} headingId={headingId}>
      <ul aria-labelledby={headingId} className="flex flex-col gap-0.5">
        {data.files.map((f, i) => {
          const badge = KIND_BADGE[kinds[i]];
          // One path can be listed twice: a staged deletion and an untracked
          // file of the same name are separate status records.
          return (
            <li
              key={`${f.staged ?? ""}:${f.unstaged ?? ""}:${f.path}`}
              className="flex min-w-0 items-center gap-2"
            >
              <span
                aria-hidden
                className={`w-3 shrink-0 font-semibold ${badge.className}`}
              >
                {badge.letter}
              </span>
              <span className="sr-only">{`${badge.label} `}</span>
              <PathText path={f.path} className="min-w-0 flex-1" />
              {f.submodule !== undefined && (
                <Badge
                  variant="outline"
                  className="h-4 shrink-0 px-1 text-[10px]"
                >
                  Submodule
                </Badge>
              )}
            </li>
          );
        })}
        {data.filesTotal > data.files.length && (
          <MoreRow n={data.filesTotal - data.files.length} />
        )}
      </ul>
    </Section>
  );
}
