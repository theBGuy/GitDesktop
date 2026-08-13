import { Popover } from "@base-ui/react/popover";
import { SmileyIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { Reaction } from "@/lib/git/types";
import { cn } from "@/lib/utils";

/** GitHub's eight reactions, in their canonical picker order. */
const REACTION_EMOJI: Record<string, string> = {
  THUMBS_UP: "👍",
  THUMBS_DOWN: "👎",
  LAUGH: "😄",
  HOORAY: "🎉",
  CONFUSED: "😕",
  HEART: "❤️",
  ROCKET: "🚀",
  EYES: "👀",
};

const REACTION_ORDER = [
  "THUMBS_UP",
  "THUMBS_DOWN",
  "LAUGH",
  "HOORAY",
  "CONFUSED",
  "HEART",
  "ROCKET",
  "EYES",
] as const;

const label = (content: string) => content.toLowerCase().replace(/_/g, " ");

/**
 * Emoji reactions for a reactable subject (issue/PR body or comment). Existing
 * reactions render as toggle chips (highlighted when the viewer reacted); the
 * smiley opens a picker of all eight. `onToggle(content, active)` — `active` is
 * whether the viewer currently has that reaction, so the caller adds or removes.
 */
export function ReactionBar({
  reactions,
  onToggle,
  disabled,
}: {
  reactions: Reaction[];
  onToggle: (content: string, active: boolean) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const reacted = new Set(
    reactions.filter((r) => r.viewerReacted).map((r) => r.content),
  );

  return (
    <div className="flex flex-wrap items-center gap-1">
      {reactions.map((r) => (
        <button
          key={r.content}
          type="button"
          aria-label={`${label(r.content)} reaction, ${r.count}`}
          aria-pressed={r.viewerReacted}
          disabled={disabled}
          onClick={() => onToggle(r.content, r.viewerReacted)}
          className={cn(
            "flex items-center gap-1 border px-1.5 py-0.5 text-[11px] tabular-nums transition-colors",
            r.viewerReacted
              ? "border-primary bg-primary/10 text-foreground"
              : "text-muted-foreground hover:bg-muted/60",
          )}
          title={`${label(r.content)} · ${r.count}`}
        >
          <span aria-hidden>{REACTION_EMOJI[r.content] ?? "?"}</span>
          {r.count}
        </button>
      ))}
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Add reaction"
              disabled={disabled}
              className="text-muted-foreground hover:text-foreground data-popup-open:text-foreground"
            />
          }
        >
          <SmileyIcon className="size-4" />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner
            align="start"
            sideOffset={4}
            className="isolate z-50"
          >
            <Popover.Popup className="flex gap-0.5 rounded-none bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10">
              {REACTION_ORDER.map((content) => (
                <button
                  key={content}
                  type="button"
                  aria-label={`React with ${label(content)}`}
                  aria-pressed={reacted.has(content)}
                  disabled={disabled}
                  onClick={() => {
                    onToggle(content, reacted.has(content));
                    setOpen(false);
                  }}
                  className={cn(
                    "flex size-7 items-center justify-center text-base hover:bg-muted/60",
                    reacted.has(content) && "bg-primary/10",
                  )}
                  title={label(content)}
                >
                  {REACTION_EMOJI[content]}
                </button>
              ))}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
