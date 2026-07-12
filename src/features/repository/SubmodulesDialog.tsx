import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { useSubmodules, useUpdateSubmodule } from "@/lib/git/queries";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { toastError } from "@/lib/toast";

const STATUS: Record<
  string,
  { label: string; variant: "secondary" | "outline" | "destructive" }
> = {
  ok: { label: "Up to date", variant: "secondary" },
  uninitialized: { label: "Not initialized", variant: "outline" },
  modified: { label: "Modified", variant: "secondary" },
  conflict: { label: "Conflict", variant: "destructive" },
};

export function SubmodulesDialog({
  repoPath,
  open,
  onOpenChange,
}: {
  repoPath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const subs = useSubmodules(repoPath);
  const update = useUpdateSubmodule(repoPath);
  const list = subs.data ?? [];
  const [activeIndex, setActiveIndex] = useState(-1);

  // Refetching may shrink `list` while `activeIndex` lingers, so clamp the
  // stale value (keeping -1 = "nothing active yet") to keep a row focusable.
  const safeActive =
    activeIndex >= list.length ? list.length - 1 : activeIndex;

  const onKeyDown = listKeyboardNav<(typeof list)[number]>({
    items: list,
    activeIndex: safeActive,
    onActivate: (_s, to) => setActiveIndex(to),
    rowKey: (s) => s.path,
    rowAttr: "data-sub-row",
  });

  function doUpdate(path?: string) {
    update.mutate(path, {
      onSuccess: () =>
        toast.success(path ? `Updated ${path}` : "Submodules updated"),
      onError: toastError,
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Submodules</DialogTitle>
          <DialogDescription>
            Initialize and update the submodules this repository references to
            the commit it records. Updating fetches over the network.
          </DialogDescription>
        </DialogHeader>

        {/* A roving-focus list — arrow keys move between rows, Enter runs the
            row's Initialize/Update action. */}
        <div
          className="max-h-96 overflow-y-auto border"
          onKeyDown={onKeyDown}
        >
          {subs.isPending ? (
            <div className="flex justify-center p-4">
              <Spinner />
            </div>
          ) : list.length === 0 ? (
            <p className="p-3 text-xs text-muted-foreground">
              This repository has no submodules.
            </p>
          ) : (
            list.map((s, i) => {
              const meta = STATUS[s.status] ?? {
                label: s.status,
                variant: "outline" as const,
              };
              const action =
                s.status === "uninitialized" ? "Initialize" : "Update";
              return (
                <div
                  key={s.path}
                  data-sub-row={s.path}
                  aria-label={`${s.path}, ${meta.label}. Press Enter to ${action.toLowerCase()}.`}
                  tabIndex={
                    i === safeActive || (safeActive === -1 && i === 0) ? 0 : -1
                  }
                  onFocus={() => setActiveIndex(i)}
                  onKeyDown={(e) => {
                    // Only the row itself acts on Enter — not when the child
                    // Initialize/Update button is focused.
                    if (
                      e.key === "Enter" &&
                      e.target === e.currentTarget &&
                      !update.isPending
                    ) {
                      e.preventDefault();
                      doUpdate(s.path);
                    }
                  }}
                  className="flex items-center gap-2 border-b px-3 py-2 text-xs outline-none last:border-b-0 focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono font-medium">{s.path}</p>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {s.sha.slice(0, 7)}
                      {s.describe ? ` · ${s.describe}` : ""}
                    </p>
                  </div>
                  <Badge variant={meta.variant}>{meta.label}</Badge>
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={update.isPending}
                    onClick={() => doUpdate(s.path)}
                  >
                    {action}
                  </Button>
                </div>
              );
            })
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button
            disabled={update.isPending || list.length === 0}
            onClick={() => doUpdate()}
          >
            {update.isPending && <Spinner data-icon="inline-start" />}
            Update all
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
