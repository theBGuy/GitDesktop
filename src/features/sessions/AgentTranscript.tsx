import {
  CaretRightIcon,
  FilePlusIcon,
  FileTextIcon,
  FolderOpenIcon,
  GlobeIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  SparkleIcon,
  TerminalWindowIcon,
  WrenchIcon,
} from "@phosphor-icons/react";
import type { UseQueryResult } from "@tanstack/react-query";
import { type ComponentType, useState } from "react";
import { Markdown } from "@/components/ui/markdown";
import { GitDiffView } from "@/features/diff/DiffSurfaceLazy";
import { SPLIT_MIN_CONTAINER_PX } from "@/features/diff/split-threshold";
import type { AgentToolKind, TranscriptSegment } from "@/lib/ai/agent";
import { useSessionFileDiff } from "@/lib/git/queries";
import type { FileDiff } from "@/lib/git/types";
import { useContainerWidth } from "@/lib/use-container-width";
import { cn } from "@/lib/utils";
import { AgentNarration } from "./AgentNarration";

type GlyphIcon = ComponentType<{ className?: string }>;

/** Per-category icon + verb. `file` marks targets that are repo paths, so they're
 *  shown relative to the run's base dir (commands / URLs / queries stay verbatim). */
const META: Record<
  AgentToolKind,
  { icon: GlyphIcon; verb: string; file?: boolean }
> = {
  read: { icon: FileTextIcon, verb: "Read", file: true },
  search: { icon: MagnifyingGlassIcon, verb: "Searched" },
  list: { icon: FolderOpenIcon, verb: "Listed", file: true },
  edit: { icon: PencilSimpleIcon, verb: "Edited", file: true },
  write: { icon: FilePlusIcon, verb: "Wrote", file: true },
  run: { icon: TerminalWindowIcon, verb: "Ran" },
  "web-fetch": { icon: GlobeIcon, verb: "Fetched" },
  "web-search": { icon: GlobeIcon, verb: "Searched the web" },
  task: { icon: SparkleIcon, verb: "Delegated" },
  other: { icon: WrenchIcon, verb: "Used" },
};

/** Container bind-mount of the worktree inside the agent's sandbox (the agent's
 *  cwd there). See `agent_sandbox.rs` — WORKDIR /workspace + the `:/workspace`
 *  mount. A container session reports paths under this, not the host worktree. */
const CONTAINER_MOUNT = "/workspace/";

/** Show a repo path relative to the run's base dir (the worktree/repo root), so
 *  steps read `src/foo.ts`, not the absolute CLI path. Slash-insensitive. A
 *  CONTAINER session's agent reports paths under the `/workspace` bind-mount
 *  rather than the host worktree path, so strip that prefix too — the host
 *  worktree holds the same files via the mount, so the relative path resolves
 *  there (and is a valid git pathspec for the inline diff). */
function relativize(target: string, baseDir?: string): string {
  const t = target.replace(/\\/g, "/");
  if (baseDir) {
    const b = baseDir.replace(/\\/g, "/").replace(/\/+$/, "");
    if (t.toLowerCase().startsWith(`${b.toLowerCase()}/`)) {
      return t.slice(b.length + 1);
    }
  }
  if (t.startsWith(CONTAINER_MOUNT)) return t.slice(CONTAINER_MOUNT.length);
  return target;
}

/** One inline tool step in the transcript — a calm row (icon + verb + target)
 *  set slightly apart from the surrounding prose by a faint tint. */
function ToolStep({
  tool,
  target,
  baseDir,
}: {
  tool: AgentToolKind;
  target: string | null;
  baseDir?: string;
}) {
  const meta = META[tool] ?? META.other;
  const Glyph = meta.icon;
  const shown = target && meta.file ? relativize(target, baseDir) : target;
  return (
    <div className="flex items-center gap-1.5 bg-muted/40 px-2 py-1 text-[11px] leading-relaxed">
      <Glyph className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="shrink-0 text-muted-foreground">{meta.verb}</span>
      {shown && (
        <span
          className="min-w-0 truncate font-mono text-foreground/75"
          title={target ?? undefined}
        >
          {shown}
        </span>
      )}
    </div>
  );
}

/** A target long or multi-line enough that the single-line row hides most of it —
 *  e.g. a shell command. The row truncates; expanding shows the whole thing. */
function isLongTarget(target: string): boolean {
  return target.length > 80 || target.includes("\n") || target.endsWith("…");
}

/** A tool step whose target is too long to read in the row (typically a shell
 *  command) — expands to show the FULL command/target verbatim. This is what makes
 *  a run like `pwsh … -Command 'Get-ChildItem -Recurse -Include package.json,…'`
 *  legible instead of a truncated path that looks like it's roaming the system. */
function CommandStep({
  tool,
  target,
  baseDir,
}: {
  tool: AgentToolKind;
  target: string;
  baseDir?: string;
}) {
  const [open, setOpen] = useState(false);
  const meta = META[tool] ?? META.other;
  const Glyph = meta.icon;
  const shown = meta.file ? relativize(target, baseDir) : target;
  return (
    <div className="flex flex-col bg-muted/40">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-1.5 px-2 py-1 text-left text-[11px] leading-relaxed hover:bg-muted/70 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
      >
        <CaretRightIcon
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        <Glyph className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-muted-foreground">{meta.verb}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-foreground/75">
          {shown}
        </span>
      </button>
      {open && (
        <pre className="overflow-x-auto border-t border-border/60 px-2 py-1.5 font-mono text-[11px] whitespace-pre-wrap text-foreground/80">
          {target}
        </pre>
      )}
    </div>
  );
}

/** The diff body shown under an expanded edit/write step — the file's cumulative
 *  change in the session, with the usual placeholders. Reuses the shared diff
 *  renderer (200-line cap + "Show full diff" + syntax highlighting). */
function InlineDiff({
  filePath,
  repoPath,
  diff,
}: {
  filePath: string;
  repoPath?: string;
  diff: UseQueryResult<FileDiff>;
}) {
  // A transcript step's diff sits inside the conversation column, which is
  // narrower than a diff pane at any window size — measure it so split never
  // renders below two legible columns.
  const [paneRef, paneWidth] = useContainerWidth<HTMLDivElement>();
  let body: React.ReactNode;
  if (diff.isPending) {
    body = <InlineNote>Loading diff…</InlineNote>;
  } else if (diff.isError || !diff.data) {
    body = <InlineNote>Couldn't load the diff for this file.</InlineNote>;
  } else if (diff.data.isBinary) {
    body = <InlineNote>Binary file — no text diff.</InlineNote>;
  } else if (!diff.data.text.trim()) {
    body = <InlineNote>No changes to show.</InlineNote>;
  } else {
    body = (
      <GitDiffView
        filePath={filePath}
        text={diff.data.text}
        repoPath={repoPath}
        forceUnified={paneWidth !== null && paneWidth < SPLIT_MIN_CONTAINER_PX}
      />
    );
  }
  // ph-no-capture: the diff is user code/paths — keep it out of session replay.
  return (
    <div
      ref={paneRef}
      className="ph-no-capture max-h-96 overflow-auto border-t border-border/60 text-xs"
    >
      {body}
    </div>
  );
}

function InlineNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-2 py-1.5 text-[11px] text-muted-foreground">{children}</p>
  );
}

/** An edit/write tool step that expands to show the file's diff inline (the
 *  agent-session case). Keyboard-accessible disclosure; the diff is fetched only
 *  when first opened (idle query until then). */
function EditDiffStep({
  tool,
  target,
  baseDir,
  base,
  live,
}: {
  tool: AgentToolKind;
  target: string;
  baseDir?: string;
  base: string;
  /** The session is still working, so poll an open diff to keep it fresh. */
  live: boolean;
}) {
  const [open, setOpen] = useState(false);
  const meta = META[tool] ?? META.other;
  const Glyph = meta.icon;
  const relPath = relativize(target, baseDir);
  const diff = useSessionFileDiff(baseDir ?? "", relPath, base, open, live);
  return (
    <div className="flex flex-col bg-muted/40">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-1.5 px-2 py-1 text-left text-[11px] leading-relaxed hover:bg-muted/70 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
      >
        <CaretRightIcon
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        <Glyph className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-muted-foreground">{meta.verb}</span>
        <span
          className="min-w-0 flex-1 truncate font-mono text-foreground/75"
          title={target}
        >
          {relPath}
        </span>
      </button>
      {open && <InlineDiff filePath={relPath} repoPath={baseDir} diff={diff} />}
    </div>
  );
}

/**
 * Renders an agent turn as one chronological transcript — streamed prose with the
 * tool steps interleaved exactly where they happened (text → tool → text), the
 * way Claude Code / the VS Code agent view read. Shared by the session, plan, and
 * research surfaces; `fileLinks` routes prose through {@link AgentNarration} (so
 * file paths open in the editor) for sessions/plans, or plain {@link Markdown} for
 * research reports (which cite web URLs and shouldn't bounce to an editor).
 */
export function AgentTranscript({
  segments,
  baseDir,
  fileLinks = true,
  editDiffBase,
  editDiffLive = false,
}: {
  segments: TranscriptSegment[];
  /** Repo/worktree root, used to show file targets + links as relative paths. */
  baseDir?: string;
  /** Render prose with clickable file paths (sessions/plans) vs plain markdown. */
  fileLinks?: boolean;
  /** The session's base commit. When set (a write session with a live worktree),
   *  edit/write steps expand to show the file's diff inline. Omitted for read-only
   *  plan/research surfaces and kept sessions (worktree freed). */
  editDiffBase?: string;
  /** The session is still running, so an open edit diff polls to stay fresh. */
  editDiffLive?: boolean;
}) {
  if (segments.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {segments.map((seg, i) => {
        if (seg.type === "text") {
          // Segments are append-only within a turn, so the index is a stable key.
          return fileLinks ? (
            <AgentNarration key={i} text={seg.text} baseDir={baseDir ?? ""} />
          ) : (
            <Markdown key={i}>{seg.text}</Markdown>
          );
        }
        // A file edit in a write session expands to its inline diff; everything
        // else (and read-only surfaces) stays a calm static row.
        if (
          editDiffBase &&
          seg.target &&
          (seg.tool === "edit" || seg.tool === "write")
        ) {
          return (
            <EditDiffStep
              key={i}
              tool={seg.tool}
              target={seg.target}
              baseDir={baseDir}
              base={editDiffBase}
              live={editDiffLive}
            />
          );
        }
        // A long/clipped target (typically a shell command) expands to its full
        // text, so a truncated row never misreads as the agent roaming the system.
        if (seg.target && isLongTarget(seg.target)) {
          return (
            <CommandStep
              key={i}
              tool={seg.tool}
              target={seg.target}
              baseDir={baseDir}
            />
          );
        }
        return (
          <ToolStep
            key={i}
            tool={seg.tool}
            target={seg.target}
            baseDir={baseDir}
          />
        );
      })}
    </div>
  );
}
