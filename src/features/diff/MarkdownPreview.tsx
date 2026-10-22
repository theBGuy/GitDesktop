import { type ReactNode, useLayoutEffect, useMemo, useRef } from "react";
import { InfoNote } from "@/components/info-note";
import { Markdown } from "@/components/markdown/markdown";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  DegradedListNotice,
  useRetryFocusRescue,
} from "@/features/conversations/ConversationListPanel";
import {
  detailNoticeMessage,
  refreshFailed,
  resolveDetailPane,
} from "@/features/conversations/remote-section-state";
import { presentError } from "@/lib/error-summary";
import { decodeBase64Utf8 } from "@/lib/git/api";
import { useFileAtRev } from "@/lib/git/queries";
import { DiffPlaceholder } from "./DiffPlaceholder";
import type { DiffContentRevs } from "./DiffSurface";
import { useReportPaneSettled } from "./diff-pane-hold";
import {
  cleanMarkdownForPreview,
  isMarkdownPath,
  isMdxPath,
  PREVIEW_MAX_CHARS,
} from "./markdown-preview";

/** The diff pane's view of a markdown file. A later rich-diff mode joins this
 *  union as a third toggle segment. */
export type MarkdownDiffView = "raw" | "preview";

/** Preview needs somewhere to read the file's text from — surfaces that supply
 *  neither a rev pair nor a new-side preview rev keep the plain raw diff, with
 *  no inert control. */
export function canPreviewMarkdown(
  filePath: string,
  repoPath: string | undefined,
  revs: DiffContentRevs | undefined,
): boolean {
  return (
    isMarkdownPath(filePath) &&
    !!repoPath &&
    revs !== undefined &&
    (revs.oldRev !== undefined || revs.newRev !== undefined)
  );
}

/** The Raw ⇄ Preview segment pair, same vocabulary as {@link DiffModeToggle}. */
export function MarkdownViewToggle({
  view,
  onChange,
}: {
  view: MarkdownDiffView;
  onChange: (view: MarkdownDiffView) => void;
}) {
  return (
    <ButtonGroup aria-label="Markdown view">
      <Button
        variant={view === "raw" ? "secondary" : "ghost"}
        size="xs"
        aria-pressed={view === "raw"}
        onClick={() => onChange("raw")}
      >
        Raw
      </Button>
      <Button
        variant={view === "preview" ? "secondary" : "ghost"}
        size="xs"
        aria-pressed={view === "preview"}
        onClick={() => onChange("preview")}
      >
        Preview
      </Button>
    </ButtonGroup>
  );
}

/**
 * Rendered view of a markdown/MDX file for the diff pane's Preview mode: the
 * NEW side of the change (a deleted file falls back to the old side, with a
 * note). Reads share content mode's file-at-rev cache but deliberately don't
 * depend on content mode itself — a long README past its line/char caps (or a
 * truncated diff) is exactly the file that most wants a preview.
 */
export function MarkdownDocPreview({
  repoPath,
  filePath,
  revs,
}: {
  repoPath: string;
  filePath: string;
  /** The versions the diff itself shows. Omit a side rather than passing `null`
   *  unless the working tree really is that side — `null` reads the checkout. */
  revs: DiffContentRevs;
}) {
  const hasNew = revs.newRev !== undefined;
  const hasOld = revs.oldRev !== undefined;
  const newQ = useFileAtRev(repoPath, revs.newRev ?? null, filePath, hasNew);
  // The old side is read only once it's the side to show, so the common case
  // costs one IPC read. Every ENABLED read has a defined rev, which is what
  // keeps a disabled null-rev read from cache-hitting the other side.
  // A retained `null` outlasts a failed refresh, so the old side stays shown;
  // that failure goes unannounced, since the notice reads the old side's read.
  const newAbsent = hasNew && !newQ.isPending && newQ.data === null;
  const showOld = hasOld && (!hasNew || newAbsent);
  const oldQ = useFileAtRev(repoPath, revs.oldRev ?? null, filePath, showOld);
  const activeQ = showOld ? oldQ : newQ;
  const b64 = activeQ.data?.base64 ?? null;
  // The backend's own refusal (its 20MB cap, far past the preview cap) ships
  // without bytes. Under it, a clearly oversized file is rejected on its base64
  // length instead of being decoded first: UTF-8 yields at least one UTF-16 unit
  // per 3 bytes, so past 4× the cap in base64 (3× in bytes) the decoded length
  // cannot come in under it.
  const tooLarge =
    activeQ.data?.tooLarge === true ||
    (typeof b64 === "string" && b64.length > PREVIEW_MAX_CHARS * 4);
  const text = useMemo(
    () => (typeof b64 === "string" && !tooLarge ? decodeBase64Utf8(b64) : null),
    [b64, tooLarge],
  );
  const cleaned = useMemo(
    () =>
      text !== null && text.length <= PREVIEW_MAX_CHARS
        ? cleanMarkdownForPreview(text, filePath)
        : null,
    [text, filePath],
  );
  // Gates the file read only: the pending arm below renders nothing. A lazy
  // fence grammar or an embedded image can still repaint after it settles.
  useReportPaneSettled((!hasNew && !hasOld) || !activeQ.isPending);

  // A failed refresh keeps the loaded preview under a notice; only a read with
  // nothing loaded replaces it. A missing file is data (`null`), never an error.
  const pane = resolveDetailPane({
    pending: activeQ.isPending,
    error: activeQ.isError,
    hasData: activeQ.data !== undefined,
    paused: activeQ.isPaused,
    fetching: activeQ.isFetching,
  });
  const failed = refreshFailed(activeQ);
  // Retry resets the read to pending, swapping the error arm for the empty
  // pending arm; every arm renders in the same host, so focus lands there.
  const { hostRef, retryRef } = useRetryFocusRescue(
    pane === "error" && activeQ.isError,
  );
  // Degraded content is the same arm, so a failed or recovered refresh never
  // moves focus.
  const arm = pane === "content-degraded" ? "content" : pane;
  // An arm swap or record switch that unmounts the focused node would drop
  // focus to <body>; land it on the host. Change-only, so a mount never takes
  // focus from elsewhere.
  const focusHost = useRef<HTMLDivElement | null>(null);
  const viewFrame = `${arm}:${filePath}@${revs.newRev ?? ""}:${revs.oldRev ?? ""}`;
  const lastViewFrame = useRef(viewFrame);
  useLayoutEffect(() => {
    if (lastViewFrame.current === viewFrame) return;
    lastViewFrame.current = viewFrame;
    if (document.activeElement === document.body)
      focusHost.current?.focus({ preventScroll: true });
  }, [viewFrame]);
  // A flex column with the scroller's full height: the placeholders center in
  // it, and under the notice they shrink rather than overflow by its height.
  const shell = (content: ReactNode) => (
    <div
      ref={(node) => {
        hostRef(node);
        focusHost.current = node;
      }}
      tabIndex={-1}
      className="flex h-full flex-col outline-none"
    >
      <DegradedListNotice
        noun="this preview"
        degraded={pane === "content-degraded"}
        message={detailNoticeMessage({
          noun: "preview",
          isError: failed,
          stale: activeQ.isPlaceholderData,
        })}
        onRetry={failed ? () => void activeQ.refetch() : undefined}
        className="border-b px-4 py-1.5"
      />
      {content}
    </div>
  );

  if (!hasNew && !hasOld) {
    return shell(<DiffPlaceholder message="Nothing to preview" />);
  }
  // Local reads settle near-instantly — render nothing on the way, the same
  // no-flash rule as the diff itself. They never park offline either.
  if (pane === "skeleton" || pane === "offline") return shell(null);
  if (pane === "error" || activeQ.data === undefined) {
    return shell(
      <DiffPlaceholder
        message="Could not load this file to preview"
        action={
          activeQ.isError ? (
            <div className="flex flex-col items-center gap-2">
              <p className="max-w-md text-center text-xs">
                {presentError(activeQ.error).summary}
              </p>
              <Button
                ref={retryRef}
                variant="outline"
                size="sm"
                className="cursor-pointer"
                onClick={() => void activeQ.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : undefined
        }
      />,
    );
  }
  if (tooLarge) {
    return shell(<DiffPlaceholder message="File too large to preview" />);
  }
  if (text === null) {
    return shell(<DiffPlaceholder message="Nothing to preview" />);
  }
  if (cleaned === null) {
    return shell(<DiffPlaceholder message="File too large to preview" />);
  }
  if (cleaned.trim() === "") {
    return shell(<DiffPlaceholder message="Nothing to preview" />);
  }
  return shell(
    <>
      {showOld && (
        <InfoNote>File deleted — previewing the previous version.</InfoNote>
      )}
      {isMdxPath(filePath) && (
        <InfoNote>
          Approximate preview: MDX components and expressions render as plain
          text.
        </InfoNote>
      )}
      {/* Same reading measure as the in-app guide's rendered pages. */}
      <div className="mx-auto w-full max-w-2xl p-6">
        {/* No forge context: repo docs routinely carry repository-relative
            hrefs (LICENSE, docs/…), and with nothing to resolve them against
            the renderer leaves them inert with an explanatory card. */}
        <Markdown>{cleaned}</Markdown>
      </div>
    </>,
  );
}
