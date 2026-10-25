import {
  ClipboardTextIcon,
  FolderOpenIcon,
  NotePencilIcon,
} from "@phosphor-icons/react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { PathText } from "@/components/path-text";
import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DegradedListNotice,
  useRetryFocusRescue,
} from "@/features/conversations/ConversationListPanel";
import {
  DEGRADED_ACTION_CLASS,
  detailNoticeMessage,
  refreshFailed,
  resolveDetailPane,
} from "@/features/conversations/remote-section-state";
import { diffLang } from "@/features/diff/diff-lang";
import { HighlightedLine } from "@/features/diff/HighlightedLine";
import { CreateLocalIssueDialog } from "@/features/issues/CreateLocalIssueDialog";
import { useOpenFile } from "@/features/sessions/useOpenFile";
import { presentError } from "@/lib/error-summary";
import {
  useBlame,
  useFileText,
  useTodoScanInvalidate,
} from "@/lib/git/queries";
import type { BlameLine } from "@/lib/git/types";
import { validEpochMs } from "@/lib/time";
import { cn } from "@/lib/utils";
import { MarkerChip } from "./MarkerChip";
import { basename } from "./markers";

/** Lines of context to show on each side of the TODO line in the excerpt. */
const CONTEXT = 20;

export function CodeTodoDetailView({
  repoPath,
  path,
  line,
  marker,
  text,
}: {
  repoPath: string;
  path: string;
  line: number;
  /** The scan's authoritative marker word (e.g. `FIXME`) — the Rust scanner
   *  gates markers to real comment openers, so this beats any client re-parse. */
  marker: string;
  /** The scan's authoritative comment text after the marker (may be `""`). */
  text: string;
}) {
  const blame = useBlame(repoPath, path);
  // "Not tracked yet" only on git's own word for it; any other blame failure
  // (a damaged repository, say) is a failed read that says why. Read above the
  // ladder: these describe the failure, they never swap content.
  const notTracked = isNotInHead(blame.error);
  const blameReason =
    blame.error == null ? null : presentError(blame.error).summary;
  // A failed blame refresh keeps the loaded excerpt and attribution under a
  // notice; only a blame with nothing loaded falls back to the disk read below.
  const pane = resolveDetailPane({
    pending: blame.isPending,
    error: blame.isError,
    hasData: blame.data !== undefined,
    paused: blame.isPaused,
    fetching: blame.isFetching,
  });
  const failed = refreshFailed(blame);
  // Fallback content source: `git blame` refuses untracked files, but we scan
  // `--untracked`, so a brand-new file's content is read straight off disk.
  // Only a blame that errored with nothing loaded counts: a tracked file's
  // failed refresh keeps its blame, never pays the read. Any such failure takes
  // the disk read, so the excerpt still shows; `notTracked` decides what the
  // header says about it.
  const untracked = blame.isError && blame.data === undefined;
  const fileText = useFileText(repoPath, path, untracked);
  const openFile = useOpenFile();
  const rescan = useTodoScanInvalidate(repoPath);
  const [promoteOpen, setPromoteOpen] = useState(false);

  const blameLines = blame.data ?? [];
  const lang = diffLang(path);
  // The blame row for the TODO line (1-based → 0-based). Absent when blame
  // failed or the file drifted past this line; used ONLY for attribution — the
  // marker/text are authoritative props, and the excerpt has a file-read
  // fallback below.
  const todoLine: BlameLine | undefined = blameLines[line - 1];

  // A unified excerpt source: prefer blame (content + attribution in one call),
  // fall back to the raw file read for an untracked file. Both yield 1-based
  // { lineNo, content } rows the excerpt renders identically. When the fallback
  // hasn't resolved yet, `data` is undefined and this stays empty (so nothing
  // renders until the read lands — pending is handled below). Strip one
  // trailing terminator then split CRLF-safely (mirroring `capHunkLines` in
  // ai/review-tools.ts) so CRLF worktrees + a final newline can't skew the
  // stale boundary or render stray CRs.
  const excerptLines: { lineNo: number; content: string }[] = untracked
    ? fileText.data !== undefined
      ? fileText.data
          .replace(/\r?\n$/, "")
          .split(/\r?\n/)
          .map((content, i) => ({
            lineNo: i + 1,
            content,
          }))
      : []
    : blameLines.map((bl) => ({ lineNo: bl.lineNo, content: bl.content }));

  // The pre-filled promote-to-issue draft, built from the authoritative pair so
  // it works even when blame fails (e.g. an untracked file). Title = the comment
  // text capped ~80 chars, with a fallback when the text is empty.
  const draftTitle = text || `${marker} in ${basename(path)}:${line}`;
  const draftBody = [
    `From \`${path}:${line}\`:`,
    "",
    `> ${marker}${text ? `: ${text}` : ""}`,
  ].join("\n");

  async function copyPathLine() {
    try {
      await navigator.clipboard.writeText(`${path}:${line}`);
      toast.success("Path copied");
    } catch {
      toast.error("Could not copy to clipboard");
    }
  }

  // The excerpt window around the TODO line (clamped to the source length).
  const from = Math.max(0, line - 1 - CONTEXT);
  const to = Math.min(excerptLines.length, line + CONTEXT);
  const excerpt = excerptLines.slice(from, to);

  // Still resolving the content source: blame pending, or the file-read fallback
  // in flight after a blame error. Show skeletons rather than a false "stale"/
  // "no preview" verdict computed against a not-yet-known length.
  const sourcePending = blame.isPending || (untracked && fileText.isPending);
  // Both sources failed (blame refused AND the file couldn't be read — e.g.
  // deleted mid-session): no preview to show, and Retry re-asks both. A failed
  // re-read of a file already shown keeps it, and the notice says so.
  const previewUnavailable =
    !sourcePending &&
    untracked &&
    fileText.isError &&
    fileText.data === undefined;
  const retryErrored = () => {
    if (blame.isError) void blame.refetch();
    if (fileText.isError) void fileText.refetch();
  };
  // The notice follows the source on screen: an untracked file's disk read,
  // or its blame.
  const noticeFailed = untracked
    ? fileText.data !== undefined && refreshFailed(fileText)
    : failed;
  const noticeRetry = untracked
    ? () => void fileText.refetch()
    : () => void blame.refetch();
  // The file drifted: the scan pointed past the current file length (including a
  // file emptied to zero lines — an empty successful blame is stale, not "no
  // preview", so Rescan stays reachable). Only judged once a source resolved.
  const stale =
    !sourcePending && !previewUnavailable && line > excerptLines.length;

  // Retry resets both reads, swapping the error arm for the skeleton; every arm
  // renders in the same host, so focus lands there.
  const { hostRef, retryRef } = useRetryFocusRescue(previewUnavailable);
  // Degraded content is the same arm, so a failed or recovered refresh never
  // moves focus.
  const arm = pane === "content-degraded" ? "content" : pane;
  // An arm swap or record switch that unmounts the focused node would drop
  // focus to <body>; land it on the host. Change-only, so a mount never takes
  // focus from elsewhere.
  const focusHost = useRef<HTMLDivElement | null>(null);
  const viewFrame = `${arm}:${path}:${line}`;
  const lastViewFrame = useRef(viewFrame);
  useLayoutEffect(() => {
    if (lastViewFrame.current === viewFrame) return;
    lastViewFrame.current = viewFrame;
    if (document.activeElement === document.body)
      focusHost.current?.focus({ preventScroll: true });
  }, [viewFrame]);
  const shell = (content: ReactNode) => (
    <div
      ref={(node) => {
        hostRef(node);
        focusHost.current = node;
      }}
      tabIndex={-1}
      className="flex h-full min-h-0 flex-col outline-none"
    >
      <div className="border-b p-4">
        <div className="flex items-start gap-2">
          <MarkerChip marker={marker} className="mt-0.5 shrink-0" />
          <p className="min-w-0 flex-1 break-words text-sm">
            {text || (
              <span className="text-muted-foreground">(no description)</span>
            )}
          </p>
        </div>
        <PathText
          path={path}
          line={line}
          className="mt-1 font-mono text-xs text-muted-foreground"
        />
        {/* Attribution line for the TODO's blame — hidden while stale/absent. */}
        {todoLine && isRealCommit(todoLine.hash) && (
          <p className="mt-2 text-xs text-muted-foreground">
            Added by {todoLine.author}
            {todoLine.time && validEpochMs(todoLine.time * 1000) ? (
              <>
                {" · "}
                <RelativeTime
                  date={new Date(todoLine.time * 1000).toISOString()}
                />
              </>
            ) : null}
          </p>
        )}
        {untracked && (
          <p className="mt-2 text-xs text-muted-foreground">
            {notTracked ? (
              "Not tracked yet — no history."
            ) : (
              <>
                Couldn't read this file's history. {blameReason}{" "}
                <button
                  type="button"
                  aria-label="Retry reading this file's history"
                  onClick={() => void blame.refetch()}
                  className={DEGRADED_ACTION_CLASS}
                >
                  Retry
                </button>
              </>
            )}
          </p>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="xs"
            onClick={() => openFile(repoPath, path)}
          >
            <FolderOpenIcon data-icon="inline-start" />
            Open in editor
          </Button>
          <Button
            variant="outline"
            size="xs"
            onClick={() => setPromoteOpen(true)}
          >
            <NotePencilIcon data-icon="inline-start" />
            Promote to issue
          </Button>
          <Button variant="outline" size="xs" onClick={copyPathLine}>
            <ClipboardTextIcon data-icon="inline-start" />
            Copy path:line
          </Button>
        </div>
      </div>

      <DegradedListNotice
        noun="this excerpt"
        degraded={pane === "content-degraded" || noticeFailed}
        message={detailNoticeMessage({
          noun: "excerpt",
          isError: noticeFailed,
          stale: blame.isPlaceholderData,
        })}
        onRetry={noticeFailed ? noticeRetry : undefined}
        className="shrink-0 border-b px-4 py-1.5"
      />
      <div className="min-h-0 flex-1 overflow-auto">{content}</div>

      <CreateLocalIssueDialog
        repoPath={repoPath}
        open={promoteOpen}
        onOpenChange={setPromoteOpen}
        initialDraft={{
          // Codepoint-safe cap: UTF-16 `slice` can end on a lone high surrogate;
          // the spread splits by codepoint (consistent with the Rust `chars()`
          // text cap).
          title: [...draftTitle].slice(0, 80).join(""),
          body: draftBody,
        }}
      />
    </div>
  );

  if (sourcePending) {
    return shell(
      <div className="space-y-1.5 p-3">
        {Array.from({ length: 10 }, (_, i) => (
          <Skeleton key={i} className="h-4 w-full" />
        ))}
      </div>,
    );
  }
  if (stale) {
    return shell(
      <div className="p-4 text-xs">
        <p className="text-muted-foreground">
          This line is no longer in the file — the scan may be stale.
        </p>
        <Button
          variant="outline"
          size="xs"
          className="mt-3"
          onClick={() => rescan()}
        >
          Rescan
        </Button>
      </div>,
    );
  }
  if (previewUnavailable) {
    // Both blame and the file read failed (e.g. deleted mid-session). Header +
    // actions still work.
    const reason = fileText.error ?? blame.error;
    return shell(
      <div className="flex flex-col items-start gap-2 p-4 text-xs text-muted-foreground">
        <p>No file preview available.</p>
        {reason ? <p>{presentError(reason).summary}</p> : null}
        <Button
          ref={retryRef}
          variant="outline"
          size="sm"
          className="cursor-pointer"
          onClick={retryErrored}
        >
          Retry
        </Button>
      </div>,
    );
  }
  if (excerpt.length === 0) {
    // Nothing to show. Header + actions still work.
    return shell(
      <p className="p-4 text-xs text-muted-foreground">
        No file preview available.
      </p>,
    );
  }
  return shell(
    <div className="font-mono text-[11px] leading-relaxed">
      {excerpt.map((bl) => {
        const isTodo = bl.lineNo === line;
        return (
          <div
            key={bl.lineNo}
            className={cn(
              "flex w-full items-start",
              isTodo && "bg-accent text-accent-foreground",
            )}
          >
            <span
              aria-hidden
              className="w-4 shrink-0 select-none text-center text-muted-foreground/70"
            >
              {isTodo ? "▸" : ""}
            </span>
            <span
              className={cn(
                "w-10 shrink-0 select-none px-1 text-right text-muted-foreground/70",
                isTodo && "font-bold text-accent-foreground",
              )}
            >
              {bl.lineNo}
            </span>
            <HighlightedLine content={bl.content} language={lang} />
          </div>
        );
      })}
    </div>,
  );
}

/** Whether a blame failure is git refusing a path HEAD doesn't have, the one
 *  failure that means "untracked" (pinned by history.rs's
 *  `blame_untracked_file_says_no_such_path_in_head`). Structural, since the
 *  error is a plain object off the IPC boundary. */
function isNotInHead(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { kind?: unknown; stderr?: unknown; message?: unknown };
  if (e.kind !== "git") return false;
  const text = typeof e.stderr === "string" ? e.stderr : e.message;
  return typeof text === "string" && /no such path '.*' in HEAD/.test(text);
}

/** `git blame --porcelain` reports uncommitted lines with an all-zero sha —
 *  those rows aren't real commits, so their attribution stays hidden. */
function isRealCommit(hash: string): boolean {
  return !/^0+$/.test(hash);
}
