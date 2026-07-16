import {
  ClipboardTextIcon,
  FolderOpenIcon,
  NotePencilIcon,
} from "@phosphor-icons/react";
import hljs from "highlight.js/lib/common";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { diffLang } from "@/features/diff/diff-lang";
import { CreateLocalIssueDialog } from "@/features/issues/CreateLocalIssueDialog";
import { useOpenFile } from "@/features/sessions/useOpenFile";
import {
  useBlame,
  useFileText,
  useTodoScanInvalidate,
} from "@/lib/git/queries";
import type { BlameLine } from "@/lib/git/types";
import { formatRelativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { MarkerChip } from "./MarkerChip";
import { basename } from "./markers";
import "@/features/diff/code-highlight.css";

/** Lines of context to show on each side of the TODO line in the excerpt. */
const CONTEXT = 20;

/** One code line, syntax-highlighted when the language is recognized — a local
 *  equivalent of BlameDialog's `BlameCode` (we don't import its internals). */
function CodeLine({
  content,
  language,
}: {
  content: string;
  language: string | undefined;
}) {
  const html =
    language && hljs.getLanguage(language)
      ? hljs.highlight(content, { language, ignoreIllegals: true }).value
      : null;
  if (html === null) {
    return <span className="px-2 whitespace-pre-wrap">{content || " "}</span>;
  }
  return (
    <span
      className="gd-code px-2 whitespace-pre-wrap"
      dangerouslySetInnerHTML={{ __html: html || " " }}
    />
  );
}

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
  // Fallback content source: `git blame` refuses untracked files, but we scan
  // `--untracked`, so a brand-new file's content is read straight off disk.
  // Deferred until blame has actually errored, so tracked files never pay it.
  const fileText = useFileText(repoPath, path, blame.isError);
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
  // fall back to the raw file read when blame errored. Both yield 1-based
  // { lineNo, content } rows the excerpt renders identically. When blame errored
  // but the fallback hasn't resolved yet, `data` is undefined and this stays
  // empty (so nothing renders until the read lands — pending is handled below).
  const excerptLines: { lineNo: number; content: string }[] = blame.isError
    ? fileText.data !== undefined
      ? fileText.data.split("\n").map((content, i) => ({
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
  const sourcePending =
    blame.isPending || (blame.isError && fileText.isPending);
  // The file drifted: the scan pointed past the current file length. Only judged
  // once a source has resolved with content.
  const stale =
    !sourcePending && excerptLines.length > 0 && line > excerptLines.length;
  // Both sources failed (blame refused AND the file couldn't be read — e.g.
  // deleted mid-session): no preview to show.
  const previewUnavailable =
    !sourcePending && blame.isError && fileText.isError;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b p-4">
        <div className="flex items-start gap-2">
          <MarkerChip marker={marker} className="mt-0.5 shrink-0" />
          <p className="min-w-0 flex-1 break-words text-sm">
            {text || (
              <span className="text-muted-foreground">(no description)</span>
            )}
          </p>
        </div>
        <p className="mt-1 font-mono text-xs text-muted-foreground">
          {path}:{line}
        </p>
        {/* Attribution line for the TODO's blame — hidden while stale/absent. */}
        {todoLine && isRealCommit(todoLine.hash) && (
          <p className="mt-2 text-xs text-muted-foreground">
            Added by {todoLine.author}
            {todoLine.time
              ? ` · ${formatRelativeTime(new Date(todoLine.time * 1000).toISOString())}`
              : ""}
          </p>
        )}
        {blame.isError && (
          <p className="mt-2 text-xs text-muted-foreground">
            Not tracked yet — no history.
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

      <div className="min-h-0 flex-1 overflow-auto">
        {sourcePending ? (
          <div className="space-y-1.5 p-3">
            {Array.from({ length: 10 }, (_, i) => (
              <Skeleton key={i} className="h-4 w-full" />
            ))}
          </div>
        ) : stale ? (
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
          </div>
        ) : previewUnavailable || excerpt.length === 0 ? (
          // Both blame and the file read failed (e.g. deleted mid-session), or
          // there's simply nothing to show. Header + actions still work.
          <p className="p-4 text-xs text-muted-foreground">
            No file preview available.
          </p>
        ) : (
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
                  <CodeLine content={bl.content} language={lang} />
                </div>
              );
            })}
          </div>
        )}
      </div>

      <CreateLocalIssueDialog
        repoPath={repoPath}
        open={promoteOpen}
        onOpenChange={setPromoteOpen}
        initialDraft={{ title: draftTitle.slice(0, 80), body: draftBody }}
      />
    </div>
  );
}

/** `git blame --porcelain` reports uncommitted lines with an all-zero sha —
 *  those rows aren't real commits, so their attribution stays hidden. */
function isRealCommit(hash: string): boolean {
  return !/^0+$/.test(hash);
}
