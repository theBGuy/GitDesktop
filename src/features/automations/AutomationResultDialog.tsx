import { Markdown } from "@/components/markdown/markdown";
import { RelativeTime } from "@/components/relative-time";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useAutomationResults } from "@/lib/automations/results";
import { parseableDate } from "@/lib/time";
import { useRetained } from "@/lib/use-retained";

/**
 * Viewer for automation results that have no durable surface (commit
 * reviews). Opened from the completion toast; mounted once at the app root.
 */
export function AutomationResultDialog() {
  const openId = useAutomationResults((s) => s.openId);
  const setOpen = useAutomationResults((s) => s.setOpen);
  const result = useAutomationResults((s) =>
    s.results.find((r) => r.id === s.openId),
  );
  const shownResult = useRetained(result);

  return (
    <Dialog
      open={openId !== null && result !== undefined}
      onOpenChange={(open) => {
        if (!open) setOpen(null);
      }}
    >
      <DialogContent className="flex max-h-[80vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            AI {shownResult?.mode === "security" ? "security audit" : "review"}
          </DialogTitle>
          <DialogDescription>
            {shownResult?.subject}
            {shownResult && parseableDate(shownResult.createdAt) && (
              <>
                {" — "}
                <RelativeTime date={shownResult.createdAt} />
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="min-h-0 flex-1">
          {shownResult && <Markdown>{shownResult.text}</Markdown>}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
