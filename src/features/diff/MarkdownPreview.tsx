import { InfoIcon } from "@phosphor-icons/react";
import { type ReactNode, useMemo } from "react";
import { Markdown } from "@/components/markdown/markdown";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { decodeBase64Utf8 } from "@/lib/git/api";
import { useFileAtRev } from "@/lib/git/queries";
import { DiffPlaceholder } from "./DiffPlaceholder";
import type { DiffContentRevs } from "./DiffSurface";
import {
  cleanMarkdownForPreview,
  isMarkdownPath,
  isMdxPath,
  PREVIEW_MAX_CHARS,
} from "./markdown-preview";

/** The diff pane's view of a markdown file. A later rich-diff mode joins this
 *  union as a third toggle segment. */
export type MarkdownDiffView = "raw" | "preview";

/** Preview needs somewhere to read the file's text from — surfaces that pass
 *  no revs (the PR views) keep the plain raw diff, with no inert control. */
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

/** One-line disclosure strip above the rendered body (same treatment as the
 *  working-tree line-stage hint). */
function PreviewNote({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground">
      <InfoIcon className="size-3.5 shrink-0" />
      <span className="leading-snug">{children}</span>
    </div>
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
  /** Must be the same pair the raw diff renders from. */
  revs: DiffContentRevs;
}) {
  const hasNew = revs.newRev !== undefined;
  const hasOld = revs.oldRev !== undefined;
  const newQ = useFileAtRev(repoPath, revs.newRev ?? null, filePath, hasNew);
  // The old side is read only once it's the side to show, so the common case
  // costs one IPC read. Every ENABLED read has a defined rev, which is what
  // keeps a disabled null-rev read from cache-hitting the other side.
  const newAbsent =
    hasNew && !newQ.isPending && !newQ.isError && newQ.data === null;
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

  if (!hasNew && !hasOld) {
    return <DiffPlaceholder message="Nothing to preview" />;
  }
  // Local reads settle near-instantly — render nothing on the way, the same
  // no-flash rule as the diff itself.
  if (activeQ.isPending) return null;
  if (activeQ.isError) {
    return <DiffPlaceholder message="Could not load this file to preview" />;
  }
  if (tooLarge) {
    return <DiffPlaceholder message="File too large to preview" />;
  }
  if (text === null) {
    return <DiffPlaceholder message="Nothing to preview" />;
  }
  if (cleaned === null) {
    return <DiffPlaceholder message="File too large to preview" />;
  }
  if (cleaned.trim() === "") {
    return <DiffPlaceholder message="Nothing to preview" />;
  }
  return (
    // Repo docs routinely carry repository-relative hrefs (LICENSE, docs/…).
    // This surface passes the renderer no forge context, so its dispatch has
    // nothing to resolve them against and leaves them inert.
    <div>
      {showOld && (
        <PreviewNote>
          File deleted — previewing the previous version.
        </PreviewNote>
      )}
      {isMdxPath(filePath) && (
        <PreviewNote>
          Approximate preview: MDX components and expressions render as plain
          text.
        </PreviewNote>
      )}
      {/* Same reading measure as the in-app guide's rendered pages. */}
      <div className="mx-auto w-full max-w-2xl p-6">
        <Markdown>{cleaned}</Markdown>
      </div>
    </div>
  );
}
