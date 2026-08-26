import { useState } from "react";
import { toast } from "sonner";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { useLinearCreateIssue } from "@/lib/linear/queries";
import type { LinearLink } from "@/lib/linear/store";
import { useUiStore } from "@/lib/stores/ui";
import { errorMessage } from "@/lib/tauri/invoke";
import { useSeedOnOpen } from "@/lib/use-seed-on-open";

export function CreateLinearIssueDialog({
  repoPath,
  link,
  open,
  onOpenChange,
}: {
  repoPath: string;
  link: LinearLink;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const create = useLinearCreateIssue(repoPath, link);
  const selectIssue = useUiStore((s) => s.selectIssue);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  useSeedOnOpen(open, () => {
    setTitle("");
    setDescription("");
  });

  const canSubmit = title.trim().length > 0;
  const disabledReason = !title.trim() ? "Enter a title for the issue" : null;

  async function handleSubmit() {
    if (!canSubmit) return;
    try {
      const result = await create.mutateAsync({
        teamId: link.teamId,
        title: title.trim(),
        descriptionMd: description.trim() || undefined,
      });
      toast.success(`Created ${result.identifier}`);
      selectIssue({ kind: "linear", id: result.identifier });
      onOpenChange(false);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New issue in {link.teamKey}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="linear-title">Title</Label>
            <Input
              id="linear-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Issue title"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && canSubmit) {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="linear-desc">Description</Label>
            <Textarea
              id="linear-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe the issue (markdown)"
              rows={5}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            className="cursor-pointer"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <DisabledReasonButton
            size="sm"
            className="cursor-pointer"
            onClick={handleSubmit}
            disabled={!canSubmit || create.isPending}
            reason={disabledReason}
          >
            {create.isPending && <Spinner className="mr-1.5 size-3" />}
            Create
          </DisabledReasonButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
