import {
  ArrowSquareOutIcon,
  CheckCircleIcon,
  ClockIcon,
  GitBranchIcon,
  GitCommitIcon,
  GitMergeIcon,
  PauseCircleIcon,
  PencilSimpleIcon,
  ProhibitIcon,
  ScissorsIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import type { ComponentType } from "react";
import { useState } from "react";
import { RelativeTime } from "@/components/relative-time";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useOplogHistory } from "@/lib/git/queries";
import type { OpLogEntry } from "@/lib/git/types";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { parseableDate } from "@/lib/time";
import { cn } from "@/lib/utils";

type IconType = ComponentType<{ className?: string }>;

/** Op key → friendly name + icon. Unknown keys fall through to a generic
 *  commit icon and the raw key, so a future backend value can't crash the row. */
const OP_META: Record<string, { name: string; Icon: IconType }> = {
  merge_local_pr: { name: "Local PR merge", Icon: GitMergeIcon },
  cherry_pick_onto: { name: "Cherry-pick", Icon: GitCommitIcon },
  rewrite_commits: { name: "Edit history", Icon: PencilSimpleIcon },
  rebase_edit: { name: "Interactive rebase", Icon: GitBranchIcon },
  pull_rebase_drop: { name: "Pull — dropped commits", Icon: ScissorsIcon },
};

/** Status → glyph + word + tone. Meaning is carried by the shape AND the word,
 *  never color alone. Unknown statuses render a generic glyph + the raw value. */
const STATUS_META: Record<
  string,
  { label: string; Icon: IconType; tone: string }
> = {
  pending: { label: "Pending", Icon: ClockIcon, tone: "text-warning" },
  paused: { label: "Paused", Icon: PauseCircleIcon, tone: "text-warning" },
  done: { label: "Done", Icon: CheckCircleIcon, tone: "text-success" },
  failed: {
    label: "Failed",
    Icon: WarningCircleIcon,
    tone: "text-destructive",
  },
  dismissed: {
    label: "Dismissed",
    Icon: ProhibitIcon,
    tone: "text-muted-foreground",
  },
  // A cherry-pick finished or abandoned in a terminal: over, but the journal never
  // saw how it ended, so it reads as neither Done nor Failed.
  concluded: {
    label: "Ended outside the app",
    Icon: ArrowSquareOutIcon,
    tone: "text-muted-foreground",
  },
};

function opMeta(op: string): { name: string; Icon: IconType } {
  return OP_META[op] ?? { name: op, Icon: GitCommitIcon };
}

function statusMeta(status: string): {
  label: string;
  Icon: IconType;
  tone: string;
} {
  return (
    STATUS_META[status] ?? {
      label: status,
      Icon: ClockIcon,
      tone: "text-muted-foreground",
    }
  );
}

/**
 * A flat, browsable record of the risky operations GitDesktop has journaled in
 * this repo (see `OpLogEntry`), each showing the state it started from so the
 * user can trace or recover it. Read-only: recovery routes through the Stashes
 * dialog's Recoverable view, git-native continue/abort through ConflictBanner.
 */
export function OperationHistoryDialog({
  repoPath,
  open,
  onOpenChange,
}: {
  repoPath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const history = useOplogHistory(repoPath, open);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const list = history.data ?? [];
  // Highlight the selected row, defaulting to the newest; fall back when the
  // previously-selected entry is gone from a refetch.
  const effectiveId =
    selectedId && list.some((e) => e.id === selectedId)
      ? selectedId
      : (list[0]?.id ?? null);

  // Arrow keys walk the list, mirroring the app's other lists.
  const onKeyDown = listKeyboardNav({
    items: list,
    activeIndex: list.findIndex((e) => e.id === effectiveId),
    onActivate: (entry) => setSelectedId(entry.id),
    rowKey: (entry) => entry.id,
    rowAttr: "data-op",
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[70vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Operation history</DialogTitle>
          <DialogDescription>
            Risky operations GitDesktop performed in this repo, and the state
            each one started from — so you can trace or recover them.
          </DialogDescription>
        </DialogHeader>

        {history.data === undefined ? (
          // A near-instant store read: gate on data rather than flashing a
          // spinner-in-content (the app favors calm skeletons over spinners).
          <div className="min-h-0 flex-1" />
        ) : list.length === 0 ? (
          <p className="flex-1 px-2 py-8 text-center text-xs text-muted-foreground">
            No operations recorded yet. GitDesktop journals risky operations
            here: local PR merges, cherry-picks, history edits, interactive
            rebases, and a rebase pull that drops commits. Each is recorded with
            the state it started from, so you can trace or recover it.
          </p>
        ) : (
          <ScrollArea className="min-h-0 flex-1 border">
            <div onKeyDown={onKeyDown}>
              {list.map((entry) => (
                <OpRow
                  key={entry.id}
                  entry={entry}
                  selected={effectiveId === entry.id}
                  onSelect={() => setSelectedId(entry.id)}
                />
              ))}
            </div>
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  );
}

function OpRow({
  entry,
  selected,
  onSelect,
}: {
  entry: OpLogEntry;
  selected: boolean;
  onSelect: () => void;
}) {
  const { name, Icon } = opMeta(entry.op);
  const status = statusMeta(entry.status);
  const sha7 = entry.originalSha ? entry.originalSha.slice(0, 7) : "";
  const tipSha7 = entry.preOpTip ? entry.preOpTip.slice(0, 7) : "";
  // A detached start is recorded as the string "HEAD"; show it as "detached".
  const refLabel =
    entry.originalRef && entry.originalRef !== "HEAD"
      ? entry.originalRef
      : "detached";
  const anchor = `${refLabel}${sha7 ? ` @ ${sha7}` : ""}`;

  return (
    <button
      type="button"
      data-op={entry.id}
      onClick={onSelect}
      className={cn(
        "block w-full border-b px-3 py-2 text-left",
        selected ? "bg-accent text-accent-foreground" : "hover:bg-muted/60",
      )}
    >
      <div className="flex items-center gap-2">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          <span className="text-muted-foreground">{name}</span>
          {" · "}
          <span title={entry.label}>{entry.label}</span>
        </span>
        <span
          className={cn(
            "flex shrink-0 items-center gap-1 text-[11px]",
            status.tone,
          )}
        >
          <status.Icon className="size-3 shrink-0" />
          {status.label}
        </span>
      </div>
      <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
        <RelativeTime date={entry.startedAt} />
        {entry.finishedAt && parseableDate(entry.finishedAt) && (
          <>
            {" · finished "}
            <RelativeTime date={entry.finishedAt} />
          </>
        )}
      </p>
      <p
        className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground"
        title={
          entry.preOpTip
            ? `${refLabel} @ ${entry.originalSha} → tip ${entry.preOpTip}`
            : `${refLabel} @ ${entry.originalSha}`
        }
      >
        {anchor}
        {tipSha7 ? ` → tip ${tipSha7}` : ""}
      </p>
      {entry.status === "failed" && entry.error ? (
        <p
          className="mt-0.5 truncate text-[11px] text-destructive"
          title={entry.error}
        >
          {entry.error}
        </p>
      ) : null}
    </button>
  );
}
