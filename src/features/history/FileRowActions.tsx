import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { useState } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { suppressContextMenu } from "@/lib/context-menu";
import { BlameDialog } from "./BlameDialog";
import { FileHistoryDialog } from "./FileHistoryDialog";

/**
 * Wraps a file-row list with a right-click menu offering **View file history…**
 * and **Blame…**, plus the two dialogs those items open. One shared component so
 * the commit drill-ins, PR Files pane, and Compare list don't each duplicate the
 * menu + dialog wiring (mirrors ChangesPanel's richer version, minus the
 * staging/discard items those surfaces don't have).
 *
 * The rows must carry `data-path={file.path}`; the capture-phase handler resolves
 * which one was hit before the menu opens. Right-clicking blank space (no
 * `data-path` under the cursor) opens no menu — same as ChangesPanel falling back
 * to its global target, but here there's simply nothing to show.
 *
 * `blameRev` pins Blame at that revision (a commit sha or a branch name): the
 * dialog blames the file *as of* that rev and titles it `@ <rev>`. When it's
 * absent the Blame item is hidden — a worktree blame on these historical surfaces
 * would show the wrong (current) content.
 *
 * Composition: the list's existing scroll-inner container is re-created here via
 * the `render` prop of `ContextMenuTrigger`, so callers hand over the container's
 * props (`className`, `onKeyDown`) and their rows as `children`. That keeps each
 * surface's arrow-key navigation (`onKeyDown`) intact on the same element.
 */
export function FileRowActions({
  repoPath,
  blameRev,
  className,
  onKeyDown,
  children,
}: {
  repoPath: string;
  /** Revision to pin Blame at (commit sha or branch). Omit to hide Blame. */
  blameRev?: string;
  /** Passed to the wrapped container element. */
  className?: string;
  /** The list's arrow-key handler — preserved on the container. */
  onKeyDown?: (e: KeyboardEvent) => void;
  /** The file rows (each carrying `data-path`). */
  children: ReactNode;
}) {
  // The path under the cursor when the menu opened, or null for blank space.
  const [menuPath, setMenuPath] = useState<string | null>(null);
  const [historyPath, setHistoryPath] = useState<string | null>(null);
  const [blamePath, setBlamePath] = useState<string | null>(null);

  // Capture phase, so it runs before the menu opens and records the hit row.
  function handleContextMenu(e: MouseEvent) {
    const path = (e.target as HTMLElement)
      .closest("[data-path]")
      ?.getAttribute("data-path");
    if (!path) {
      setMenuPath(null);
      suppressContextMenu(e);
      return;
    }
    setMenuPath(path);
  }

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger
          render={
            <div
              className={className}
              onKeyDown={onKeyDown}
              onContextMenuCapture={handleContextMenu}
            />
          }
        >
          {children}
        </ContextMenuTrigger>
        {menuPath && (
          <ContextMenuContent className="min-w-56">
            <ContextMenuItem onClick={() => setHistoryPath(menuPath)}>
              View file history…
            </ContextMenuItem>
            {blameRev && (
              <ContextMenuItem onClick={() => setBlamePath(menuPath)}>
                Blame…
              </ContextMenuItem>
            )}
          </ContextMenuContent>
        )}
      </ContextMenu>

      {historyPath && (
        <FileHistoryDialog
          repoPath={repoPath}
          path={historyPath}
          open
          onOpenChange={(o) => {
            if (!o) setHistoryPath(null);
          }}
        />
      )}
      {blamePath && (
        <BlameDialog
          repoPath={repoPath}
          path={blamePath}
          rev={blameRev}
          open
          onOpenChange={(o) => {
            if (!o) setBlamePath(null);
          }}
        />
      )}
    </>
  );
}
