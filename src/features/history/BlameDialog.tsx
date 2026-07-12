import { useVirtualizer } from "@tanstack/react-virtual";
import hljs from "highlight.js/lib/common";
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { diffLang } from "@/features/diff/diff-lang";
import { useBlame } from "@/lib/git/queries";
import type { BlameLine } from "@/lib/git/types";
import { formatRelativeTime } from "@/lib/time";
import "@/features/diff/code-highlight.css";

/** One code line, syntax-highlighted when the language is recognized. */
function BlameCode({
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

/** `git blame` view: each line's content with the commit that last changed it. */
export function BlameDialog({
  repoPath,
  path,
  open,
  onOpenChange,
}: {
  repoPath: string;
  path: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const blame = useBlame(repoPath, open ? path : null);
  const lines = blame.data ?? [];
  const name = path.split("/").pop() ?? path;
  const lang = diffLang(path);
  // Native scroll container held in STATE (not a ref) so attaching it
  // re-renders and the child's virtualizer re-initializes with the real node —
  // a plain ref stays null at the virtualizer's mount effect, so
  // getVirtualItems() returns [] and no rows paint. See
  // docs/list-virtualization.md and HistoryPanel's `setScrollEl` wiring.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* ph-no-capture: file name, path, and full file content — block from replay. */}
      <DialogContent className="ph-no-capture flex h-[80vh] flex-col sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="truncate">Blame: {name}</DialogTitle>
          <DialogDescription className="truncate font-mono">
            {path}
          </DialogDescription>
        </DialogHeader>

        {/* Native overflow scroll container (not the Base-UI ScrollArea) so the
            virtualizer's getScrollElement gets the real scrollable node — see
            docs/list-virtualization.md. Fixed-height flex child so getTotalSize
            resolves (max-h would leave it unbounded → 0). */}
        <div ref={setScrollEl} className="min-h-0 flex-1 overflow-auto border">
          {blame.isPending ? (
            <div className="flex justify-center p-4">
              <Spinner />
            </div>
          ) : blame.isError ? (
            <p className="p-3 text-xs text-muted-foreground">
              Couldn't blame this file (it may be binary or untracked).
            </p>
          ) : lines.length === 0 ? (
            <p className="p-3 text-xs text-muted-foreground">Empty file.</p>
          ) : (
            // Data-gated child: the useVirtualizer call lives here (never in the
            // dialog host) so (a) BlameDialog keeps compiling under the React
            // Compiler — useVirtualizer bails its host out — and (b) the
            // virtualizer only mounts once there are lines, dodging the
            // variable-height first-row measureElement race
            // (docs/list-virtualization.md).
            <BlameLines scrollEl={scrollEl} lines={lines} language={lang} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The virtualized blame rows. Isolated in its own leaf so useVirtualizer
 *  doesn't bail the dialog host out of the React Compiler, and so it mounts
 *  only once `lines` is non-empty. hljs highlighting now runs only for the
 *  mounted (visible) rows — the perf win for very large files. */
function BlameLines({
  scrollEl,
  lines,
  language,
}: {
  scrollEl: HTMLDivElement | null;
  lines: BlameLine[];
  language: string | undefined;
}) {
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollEl,
    // Most lines are a single ~18px text row; measureElement corrects any that
    // wrap (whitespace-pre-wrap on long lines makes rows taller).
    estimateSize: () => 18,
    overscan: 24,
    getItemKey: (index) => lines[index].lineNo,
  });

  return (
    <div
      className="relative w-full font-mono text-[11px] leading-relaxed"
      style={{ height: `${virtualizer.getTotalSize()}px` }}
    >
      {virtualizer.getVirtualItems().map((vi) => {
        const line = lines[vi.index];
        // Show the commit gutter only when it changes, like git's blame.
        // Index-based against the full `lines` array, so it works unchanged
        // inside virtual rows.
        const newCommit =
          vi.index === 0 || lines[vi.index - 1].hash !== line.hash;
        const when = line.time
          ? formatRelativeTime(new Date(line.time * 1000).toISOString())
          : "";
        return (
          <div
            key={vi.key}
            data-index={vi.index}
            ref={virtualizer.measureElement}
            className="absolute top-0 left-0 flex w-full items-start hover:bg-muted/40"
            style={{ transform: `translateY(${vi.start}px)` }}
          >
            <span
              className="w-40 shrink-0 truncate border-r px-2 text-muted-foreground"
              title={
                newCommit
                  ? `${line.hash.slice(0, 7)} · ${line.author} · ${when}\n${line.summary}`
                  : undefined
              }
            >
              {newCommit ? `${line.hash.slice(0, 7)} ${line.author}` : ""}
            </span>
            <span className="w-10 shrink-0 select-none px-1 text-right text-muted-foreground/70">
              {line.lineNo}
            </span>
            <BlameCode content={line.content} language={language} />
          </div>
        );
      })}
    </div>
  );
}
