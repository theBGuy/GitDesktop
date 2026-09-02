import { SparkleIcon, XIcon } from "@phosphor-icons/react";
import { useSelector } from "@tanstack/react-store";
import { useEffectEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { required, useAppForm } from "@/lib/form";
import { useGenerateChord } from "@/lib/hotkeys/useGenerateChord";
import { useCreateLocalIssue } from "@/lib/issues/queries";
import { useAiEnabled } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";
import { useSeedOnOpen } from "@/lib/use-seed-on-open";
import { useGenerateIssueDraft } from "./useGenerateIssueDraft";

export function CreateLocalIssueDialog({
  repoPath,
  open,
  onOpenChange,
  initialDraft,
}: {
  repoPath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Seed the form when opened (e.g. from a generated plan). */
  initialDraft?: { title: string; body: string };
}) {
  const createIssue = useCreateLocalIssue(repoPath);
  const selectIssue = useUiStore((s) => s.selectIssue);
  const repoName = useUiStore((s) => s.repoName) ?? "";
  const aiEnabled = useAiEnabled();
  const { generate, cancel, generating } = useGenerateIssueDraft(repoPath);

  const form = useAppForm({
    defaultValues: { title: "", body: "" },
    onSubmit: async ({ value }) => {
      try {
        const issue = await createIssue.mutateAsync({
          title: value.title.trim(),
          body: value.body,
        });
        toast.success(`Created local issue: ${issue.title}`);
        selectIssue({ kind: "local", id: issue.id });
        onOpenChange(false);
      } catch (e) {
        toastError(e);
      }
    },
  });

  // Live title/body drive the AI drafter's input and its enabled state.
  const titleVal = useSelector(form.store, (s) => s.values.title);
  const bodyVal = useSelector(form.store, (s) => s.values.body);
  const notes = [titleVal, bodyVal].filter(Boolean).join("\n\n");

  // keepDefaultValues: otherwise the per-render options sync clobbers the
  // reset values back to empty on an untouched form.
  const seedOnOpen = useEffectEvent(() => {
    form.reset(
      { title: initialDraft?.title ?? "", body: initialDraft?.body ?? "" },
      { keepDefaultValues: true },
    );
  });
  useSeedOnOpen(open, seedOnOpen);

  // Shared by the Draft-with-AI button and the generate chord below.
  function runGenerate() {
    generate({
      notes,
      repoName,
      onResult: (d) => {
        if (d.title) form.setFieldValue("title", d.title);
        form.setFieldValue("body", d.body);
      },
    });
  }
  // The generate chord drafts this issue while the dialog is open. It's mounted
  // on DialogContent, not the <form>: the X close button is a form SIBLING
  // inside the Popup, so a form-level handler would miss a chord pressed with
  // focus on X. It is swallowed here whenever it may fire (the hook mirrors the
  // global listener's own guards), so the global generate-commit-message action
  // can't run behind the dialog; while generating it swallows but DOESN'T
  // cancel.
  const generateChord = useGenerateChord({
    enabled: aiEnabled && !generating && notes.trim() !== "",
    run: runGenerate,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[85vh] flex-col sm:max-w-2xl"
        onKeyDown={generateChord.onKeyDown}
      >
        <form
          className="flex min-h-0 min-w-0 flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            form.handleSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>New local issue</DialogTitle>
            <DialogDescription>
              A private to-do for this repository, kept on your machine. Publish
              it later if it's worth sharing.
            </DialogDescription>
          </DialogHeader>

          {/* Fields scroll; header and submit footer stay pinned. */}
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
            <form.AppField
              name="title"
              validators={{ onChange: ({ value }) => required(value) }}
            >
              {(field) => (
                <field.TextField
                  label="Title"
                  placeholder="Summarize the issue"
                />
              )}
            </form.AppField>
            <form.AppField name="body">
              {(field) => (
                <field.MarkdownField
                  label="Description"
                  placeholder="Jot down rough notes, then draft with AI"
                  rows={8}
                  textareaClassName="max-h-72 min-h-24 resize-y font-mono"
                  actions={
                    !aiEnabled ? undefined : generating ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        onClick={cancel}
                      >
                        <XIcon data-icon="inline-start" />
                        Cancel
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        disabled={!notes.trim()}
                        onClick={runGenerate}
                        // The chord is only offered while it would do something —
                        // a disabled Generate's shortcut is dead too.
                        title={
                          notes.trim()
                            ? `Expand your notes into a structured issue with AI${generateChord.hint}`
                            : "Expand your notes into a structured issue with AI"
                        }
                      >
                        <SparkleIcon data-icon="inline-start" />
                        Draft with AI
                      </Button>
                    )
                  }
                />
              )}
            </form.AppField>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <form.AppForm>
              <form.SubmitButton disabled={generating}>
                Create local issue
              </form.SubmitButton>
            </form.AppForm>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
