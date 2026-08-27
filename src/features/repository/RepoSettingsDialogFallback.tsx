import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useGenerateChord } from "@/lib/hotkeys/useGenerateChord";
import { cn } from "@/lib/utils";

/** Six rows: the shortest provider rail (GitLab) offers six sections, and the
 *  real count isn't knowable until the provider tables load with the chunk. */
const RAIL_ROW_WIDTHS = ["w-16", "w-20", "w-14", "w-24", "w-12", "w-18"];

/**
 * The repository-settings dialog's frame while its lazy chunk loads, so the
 * click paints a dialog instead of nothing and the loaded dialog fills the same
 * frame rather than arriving from an empty screen. Provider-worded copy (the
 * description, the rail's section names) lives inside the lazy module, so it
 * stays skeletal here rather than flashing a label the repo's forge contradicts.
 */
export function RepoSettingsDialogFallback({
  onOpenChange,
}: {
  onOpenChange: (open: boolean) => void;
}) {
  // The chord must not reach the Changes-tab generator behind this frame. A
  // defined `run` is what arms the hook's swallow at all; `enabled: false` is
  // what keeps it from generating before the real dialog owns the chord.
  const generateChord = useGenerateChord({
    enabled: false,
    run: () => undefined,
  });

  return (
    <Dialog open onOpenChange={onOpenChange}>
      {/* Frame classes mirror RepoSettingsDialog's DialogContent: the swap to
          the loaded dialog must not resize or reposition the box. */}
      <DialogContent
        className="flex h-150 max-h-[85vh] flex-col sm:max-w-3xl"
        onKeyDown={generateChord.onKeyDown}
      >
        <DialogHeader>
          <DialogTitle>Repository settings</DialogTitle>
          <Skeleton className="h-4 w-2/3" />
        </DialogHeader>
        <div className="flex min-h-0 min-w-0 flex-1 gap-4">
          <div className="w-40 shrink-0 space-y-0.5">
            {RAIL_ROW_WIDTHS.map((width) => (
              // Mirrors a rail row's geometry (h-7 row, px-2 label inset); the
              // loaded rail is taller, since its groups carry headers.
              <div key={width} className="flex h-7 items-center px-2">
                <Skeleton className={cn("h-3", width)} />
              </div>
            ))}
          </div>
          <div
            aria-busy
            className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto pr-1"
          >
            {/* aria-busy alone announces nothing outside a live region, so the
                state gets words a screen reader will actually read. */}
            <span className="sr-only">Loading repository settings…</span>
            {/* The General section's own loading shape, so fallback → dialog →
                section reads as one progressive fill, not three layouts. */}
            <div className="min-w-0 space-y-3">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
