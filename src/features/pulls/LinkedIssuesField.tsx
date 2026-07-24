import { Popover } from "@base-ui/react/popover";
import { LinkIcon, SparkleIcon, XIcon } from "@phosphor-icons/react";
import { type KeyboardEvent, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { IssuePicker, StateIcon } from "@/features/issues/IssueRelations";
import type { RemoteLens } from "@/lib/git/types";

/** One linked-issue chip: a real repo issue the PR will reference on create. The
 *  keyword becomes a `Closes #N` / `Relates to #N` line appended to the body. */
export interface LinkedIssueChip {
  number: number;
  title: string;
  /** "OPEN" | "CLOSED" (neutral IssueInfo casing). */
  state: string;
  keyword: "closes" | "relates";
  source: "extraction" | "ai" | "manual";
  /** The model proposed this as a close — sorts first, keyword gets a hint tooltip. */
  aiSuggestedClose: boolean;
}

/** The chip cluster in Create PR: extraction-seeded, AI-proposed, and
 *  manually-added issue links. The parent owns the chip state; this renders the
 *  band + the "Link issue" picker and reports toggles/removes/picks upward. */
export function LinkedIssuesField({
  repoPath,
  lens,
  chips,
  onToggleKeyword,
  onRemove,
  onPick,
  disabled,
}: {
  repoPath: string;
  lens: RemoteLens;
  chips: LinkedIssueChip[];
  onToggleKeyword: (issueNumber: number) => void;
  onRemove: (issueNumber: number) => void;
  onPick: (issueNumber: number) => void;
  disabled?: boolean;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  // Roving tabindex: the band is a single tab stop; ArrowLeft/Right move the
  // roved index, which sets which chip is focusable + focused.
  const [focusIndex, setFocusIndex] = useState(0);
  const chipRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // AI-suggested closes sort first; ties keep insertion order (stable sort).
  const ordered = [...chips].sort(
    (a, b) => Number(b.aiSuggestedClose) - Number(a.aiSuggestedClose),
  );
  const excluded = new Set(chips.map((c) => c.number));

  function focusChip(index: number) {
    const clamped = Math.max(0, Math.min(index, ordered.length - 1));
    setFocusIndex(clamped);
    chipRefs.current[clamped]?.focus();
  }

  function onChipKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    const chip = ordered[index];
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (index > 0) focusChip(index - 1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      if (index < ordered.length - 1) focusChip(index + 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onToggleKeyword(chip.number);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      onRemove(chip.number);
      // Focus the chip that slides into this slot (or the new last one).
      const nextCount = ordered.length - 1;
      if (nextCount > 0) focusChip(Math.min(index, nextCount - 1));
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Label>Linked issues</Label>
        <span className="flex-1" />
        <Popover.Root open={pickerOpen} onOpenChange={setPickerOpen}>
          <Popover.Trigger
            render={
              <Button
                variant="outline"
                size="xs"
                disabled={disabled}
                aria-label="Link an issue"
              />
            }
          >
            <LinkIcon data-icon="inline-start" />
            Link issue
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Positioner
              align="end"
              sideOffset={4}
              className="isolate z-50"
            >
              <Popover.Popup className="w-72 rounded-none bg-popover p-2 text-popover-foreground shadow-md ring-1 ring-foreground/10">
                <IssuePicker
                  repoPath={repoPath}
                  exclude={excluded}
                  pending={false}
                  lens={lens}
                  onPick={(n) => {
                    setPickerOpen(false);
                    onPick(n);
                  }}
                />
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      </div>

      {ordered.length > 0 && (
        <>
          <div
            role="group"
            aria-label="Linked issues"
            className="flex flex-wrap items-center gap-1.5"
          >
            {ordered.map((chip, index) => {
              const keywordLabel =
                chip.keyword === "closes" ? "Closes" : "Relates to";
              const keywordHint =
                chip.aiSuggestedClose && chip.keyword === "relates"
                  ? `AI suggests this pull request closes #${chip.number} — click to switch to Closes.`
                  : undefined;
              const stateWord = chip.state === "CLOSED" ? "Closed" : "Open";
              const switchTo =
                chip.keyword === "closes" ? "Relates to" : "Closes";
              return (
                <span
                  key={chip.number}
                  className="inline-flex items-center gap-1 border py-0.5 pr-0.5 pl-1.5 text-xs"
                >
                  <StateIcon state={chip.state} />
                  <button
                    type="button"
                    ref={(el) => {
                      chipRefs.current[index] = el;
                    }}
                    tabIndex={index === focusIndex ? 0 : -1}
                    title={keywordHint}
                    aria-label={`${keywordLabel} issue ${chip.number}: ${chip.title}. ${stateWord} issue. Press Enter to switch to ${switchTo}, Delete to remove.`}
                    onClick={() => onToggleKeyword(chip.number)}
                    onFocus={() => setFocusIndex(index)}
                    onKeyDown={(e) => onChipKeyDown(e, index)}
                    className="inline-flex items-center gap-1 cursor-pointer rounded-none outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
                  >
                    {chip.source === "ai" && (
                      <SparkleIcon className="size-3 shrink-0 text-muted-foreground" />
                    )}
                    <span
                      className={
                        chip.keyword === "closes"
                          ? "font-medium text-foreground"
                          : "text-muted-foreground"
                      }
                    >
                      {keywordLabel}
                    </span>
                    <span className="text-muted-foreground">
                      #{chip.number}
                    </span>
                    <span className="max-w-40 truncate" title={chip.title}>
                      {chip.title}
                    </span>
                  </button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    tabIndex={-1}
                    aria-label={`Remove #${chip.number}`}
                    className="text-muted-foreground"
                    onClick={() => onRemove(chip.number)}
                  >
                    <XIcon />
                  </Button>
                </span>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            Added to the description on create.
          </p>
        </>
      )}
    </div>
  );
}
