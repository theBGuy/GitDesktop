import { CaretDownIcon, CaretRightIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Markdown } from "@/components/markdown/markdown";

/**
 * A collapsed-by-default "Thought process" disclosure for an agentic review's
 * streamed working narration ("Let me check the call sites…"). The narration is
 * peeled off the review body at settle and shown here so it stays available
 * without polluting the review. Shared by the live review panel and the history
 * rows; both render inside a `ph-no-capture` container, so no capture guard here.
 */
export function ThoughtsDisclosure({ thoughts }: { thoughts: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2 text-xs">
      <button
        type="button"
        className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? (
          <CaretDownIcon className="size-3" />
        ) : (
          <CaretRightIcon className="size-3" />
        )}
        Thought process
      </button>
      {open && (
        <div className="mt-1 text-muted-foreground">
          <Markdown>{thoughts}</Markdown>
        </div>
      )}
    </div>
  );
}
