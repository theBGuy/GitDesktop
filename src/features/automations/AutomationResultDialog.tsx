import { Markdown } from "@/components/markdown/markdown";
import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useAutomationResults } from "@/lib/automations/results";
import { clipTitleFromText } from "@/lib/clip-title";
import { parseableDate } from "@/lib/time";
import { useRetained } from "@/lib/use-retained";

/**
 * Viewer for automated commit reviews, the one review target with no comment
 * surface of its own. Opened from the completion toast or the result's inbox
 * row (which reads the persisted copy after a restart); mounted once at the app
 * root, so a cross-repo notification can open it without a repo switch.
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
            {shownResult?.hash && (
              <>
                <span className="font-mono">
                  {shownResult.hash.slice(0, 7)}
                </span>
                {" · "}
              </>
            )}
            {shownResult?.subject}
            {shownResult && parseableDate(shownResult.createdAt) && (
              <>
                {" — "}
                <RelativeTime date={shownResult.createdAt} />
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        {/* Says in words what the tone shows — kept output is not a review. */}
        {shownResult?.phase === "error" && (
          <div className="flex items-center gap-2">
            <Badge
              variant="outline"
              className="shrink-0 border-warning/40 bg-warning/10 text-warning"
            >
              {shownResult.timedOut === true
                ? "Timed out — partial output"
                : "Stopped early"}
            </Badge>
            {typeof shownResult.error === "string" && shownResult.error && (
              <span
                className="min-w-0 truncate text-muted-foreground text-sm"
                onMouseEnter={clipTitleFromText}
              >
                {shownResult.error}
              </span>
            )}
          </div>
        )}
        <ScrollArea className="min-h-0 flex-1">
          {shownResult && <Markdown>{shownResult.text}</Markdown>}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
