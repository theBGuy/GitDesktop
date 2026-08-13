import { RelativeTime } from "@/components/relative-time";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Markdown } from "@/components/ui/markdown";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useAutomationResults } from "@/lib/automations/results";

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
            AI {result?.mode === "security" ? "security audit" : "review"}
          </DialogTitle>
          <DialogDescription>
            {result?.subject}
            {result && (
              <>
                {" — "}
                <RelativeTime date={result.createdAt} />
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="min-h-0 flex-1">
          {result && <Markdown>{result.text}</Markdown>}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
