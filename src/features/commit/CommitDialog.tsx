import { InfoIcon, SparkleIcon } from "@phosphor-icons/react";
import { DiffStat } from "@/components/diff-stat";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { clipTitle } from "@/lib/clip-title";
import { useWorkingLineStats } from "@/lib/git/queries";
import type { ChangeKind, FileEntry } from "@/lib/git/types";
import { formatBinding } from "@/lib/hotkeys/binding";
import { useEffectiveBindings } from "@/lib/hotkeys/hotkeys";
import { useGenerateChordHint } from "@/lib/hotkeys/useGenerateChord";
import { useUiStore } from "@/lib/stores/ui";
import { cn } from "@/lib/utils";
import { CoAuthorPicker } from "./CoAuthorPicker";
import { useCommitSubmit } from "./useCommitSubmit";

// The Changes panel's status letters and tokens, for the read-only staged
// summary: the same file in both surfaces must read the same letter and colour.
const KIND_BADGE: Record<
  ChangeKind,
  { letter: string; label: string; className: string }
> = {
  added: { letter: "A", label: "Added", className: "text-success" },
  untracked: { letter: "U", label: "Untracked", className: "text-success" },
  modified: { letter: "M", label: "Modified", className: "text-warning" },
  typechange: { letter: "T", label: "Type changed", className: "text-warning" },
  deleted: { letter: "D", label: "Deleted", className: "text-destructive" },
  renamed: { letter: "R", label: "Renamed", className: "text-info" },
  copied: { letter: "C", label: "Copied", className: "text-info" },
  conflicted: {
    letter: "!",
    label: "Conflicted",
    className: "text-destructive",
  },
};

/**
 * The pop-out commit composer. Rendered exactly ONCE, hoisted in RepositoryView:
 * it is the commit path that survives a collapsed sidebar, where the inline
 * CommitBox is `<Activity>`-hidden and its hotkeys are unregistered.
 *
 * Every field reads the shared ui-store draft, so this and the box are the same
 * message from two angles. Staging stays in the Changes panel — the file list
 * here is read-only.
 */
export function CommitDialog({ repoPath }: { repoPath: string }) {
  const open = useUiStore((s) => s.commitDialogOpen);
  const closeCommitDialog = useUiStore((s) => s.closeCommitDialog);
  const openSettings = useUiStore((s) => s.openSettings);
  const {
    title,
    body,
    coAuthors,
    setCommitTitle,
    setCommitBody,
    setCoAuthors,
    clearCommitDraft,
    amending,
    amendingHash,
    branchName,
    locked,
    stagedEntries,
    stagedCount,
    canCommit,
    commitDisabledReason,
    commitLabel,
    committing,
    aiEnabled,
    aiConfigured,
    generate,
    cancel,
    generating,
    doCommit,
  } = useCommitSubmit(repoPath, {
    active: open,
    onCommitted: closeCommitDialog,
  });
  // Same query (and cache entry) the Changes panel's rows read, so a file's
  // counts here can't disagree with its counts there. Only fetched while the
  // list is on screen with something in it.
  const lineStats = useWorkingLineStats(repoPath, open && stagedCount > 0);
  const commitBinding = useEffectiveBindings().get("commit") ?? null;
  const generateHint = useGenerateChordHint();

  const stagedStats = new Map(
    (lineStats.data?.staged ?? []).map((e) => [e.path, e]),
  );
  // numstat can't see untracked paths and emits duplicate noise rows for
  // conflicted ones, so both render a blank slot — the Changes panel's rule.
  function statFor(entry: FileEntry) {
    if (entry.staged === "untracked" || entry.staged === "conflicted")
      return undefined;
    return stagedStats.get(entry.path);
  }

  const emptyStagedNote = amending
    ? "Nothing staged — this rewrites the last commit's message only."
    : "Nothing staged — stage files in the Changes panel.";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) closeCommitDialog();
      }}
    >
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Commit</DialogTitle>
          <DialogDescription>
            Compose the message with more room. Staging stays in the Changes
            panel.
          </DialogDescription>
        </DialogHeader>

        {locked && (
          <div className="bg-muted px-2.5 py-2 text-xs text-muted-foreground">
            <p className="flex items-start gap-2">
              <InfoIcon className="mt-0.5 size-3.5 shrink-0" />
              <span className="flex-1">
                <span className="font-medium">{branchName}</span> requires
                changes via a pull request — direct commits are blocked by a
                branch rule.
              </span>
            </p>
          </div>
        )}
        {amending && (
          <div className="bg-warning/10 px-2.5 py-2 text-xs text-warning">
            <p className="flex items-start gap-2">
              <InfoIcon className="mt-0.5 size-3.5 shrink-0" />
              <span className="flex-1">
                Your changes will amend the most recent commit (
                <span className="font-mono">{amendingHash?.slice(0, 7)}</span>).{" "}
                <button
                  type="button"
                  className="font-medium underline underline-offset-2 hover:no-underline"
                  onClick={clearCommitDraft}
                >
                  Stop amending
                </button>{" "}
                to commit them separately instead.
              </span>
            </p>
          </div>
        )}

        <div className="space-y-2">
          <div className="relative">
            <Input
              autoFocus
              placeholder="Commit title"
              value={title}
              onChange={(e) => setCommitTitle(e.target.value)}
              disabled={generating}
              className="ph-no-capture pr-12"
              autoComplete="off"
            />
            <span
              className={cn(
                "pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-[10px] tabular-nums",
                title.length > 72
                  ? "text-destructive"
                  : "text-muted-foreground",
              )}
            >
              {title.length > 0 && `${title.length}/72`}
            </span>
          </div>
          <Textarea
            placeholder="Description (optional)"
            value={body}
            onChange={(e) => setCommitBody(e.target.value)}
            disabled={generating}
            // The point of the pop-out: a body field with room to write in.
            className="ph-no-capture max-h-80 min-h-40 resize-y"
          />
          <CoAuthorPicker
            repoPath={repoPath}
            value={coAuthors}
            onChange={setCoAuthors}
            disabled={generating}
          />
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-1.5">
          <h3 className="text-xs font-medium text-muted-foreground">
            Staged ({stagedCount})
          </h3>
          {stagedCount > 0 ? (
            <ScrollArea className="min-h-0 flex-1 overflow-hidden border">
              <ul className="py-1">
                {stagedEntries.map((entry) => {
                  const badge = KIND_BADGE[entry.staged ?? "modified"];
                  const label = entry.origPath
                    ? `${entry.origPath} → ${entry.path}`
                    : entry.path;
                  const stat = statFor(entry);
                  return (
                    <li
                      key={entry.path}
                      className="flex items-center gap-2 px-2 py-0.5 text-xs"
                    >
                      <span
                        aria-hidden
                        className={cn(
                          "w-3 shrink-0 font-semibold",
                          badge.className,
                        )}
                      >
                        {badge.letter}
                      </span>
                      {/* The letter carries no meaning for assistive tech; the
                          name span sits ahead of the path so the kind is
                          announced first, and its trailing space keeps the two
                          from fusing. */}
                      <span className="sr-only">{badge.label} </span>
                      <span
                        className="min-w-0 flex-1 truncate"
                        onMouseEnter={clipTitle(label)}
                      >
                        {label}
                      </span>
                      {stat ? (
                        <DiffStat
                          added={stat.added}
                          deleted={stat.deleted}
                          isBinary={stat.isBinary}
                          className="text-[11px]"
                        />
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </ScrollArea>
          ) : (
            <p className="text-xs text-muted-foreground">{emptyStagedNote}</p>
          )}
        </div>

        <DialogFooter>
          {aiEnabled && (
            <GenerateButton
              aiConfigured={aiConfigured}
              generating={generating}
              stagedCount={stagedCount}
              hint={generateHint}
              onGenerate={generate}
              onCancel={cancel}
              onSetUpAi={() => openSettings("ai")}
            />
          )}
          <DisabledReasonButton
            disabled={!canCommit || generating}
            reason={commitDisabledReason}
            title={commitBinding ? formatBinding(commitBinding) : undefined}
            onClick={doCommit}
          >
            {committing && <Spinner data-icon="inline-start" />}
            <span className="truncate">{commitLabel}</span>
          </DisabledReasonButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The footer's AI arm: cancel while a stream runs, generate when one could. */
function GenerateButton({
  aiConfigured,
  generating,
  stagedCount,
  hint,
  onGenerate,
  onCancel,
  onSetUpAi,
}: {
  aiConfigured: boolean;
  generating: boolean;
  stagedCount: number;
  hint: string;
  onGenerate: () => void;
  onCancel: () => void;
  onSetUpAi: () => void;
}) {
  if (generating) {
    return (
      <Button variant="outline" onClick={onCancel}>
        <Spinner data-icon="inline-start" />
        Cancel
      </Button>
    );
  }
  if (!aiConfigured) {
    // AI is on but no provider is set up yet — turn the dead-end Generate click
    // into a one-time path to Settings → AI.
    return (
      <Button
        variant="outline"
        onClick={onSetUpAi}
        title="Connect an AI provider to generate commit messages"
      >
        <SparkleIcon data-icon="inline-start" />
        Set up AI
      </Button>
    );
  }
  return (
    <DisabledReasonButton
      variant="outline"
      disabled={stagedCount === 0}
      reason="Stage changes to generate a commit message"
      // The chord is only offered while it would do something — a disabled
      // Generate's shortcut is dead too.
      title={
        stagedCount > 0
          ? `Generate commit message with AI${hint}`
          : "Generate commit message with AI"
      }
      onClick={onGenerate}
    >
      <SparkleIcon data-icon="inline-start" />
      Generate
    </DisabledReasonButton>
  );
}
