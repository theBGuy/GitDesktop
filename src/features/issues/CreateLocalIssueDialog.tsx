import { SparkleIcon, XIcon } from "@phosphor-icons/react";
import { useSelector } from "@tanstack/react-store";
import { useEffectEvent, useRef } from "react";
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
import { useFinishAndSurface } from "@/features/conversations/useAiStream";
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
  // Closing mid-generation never cancels the run: it finishes into the retained
  // form state, and this surfaces the result while the dialog is away.
  const surface = useFinishAndSurface(repoPath, open, {
    cancel,
    generating,
    close: () => onOpenChange(false),
    readyTitle: "Issue draft ready",
    readyDescription: "It's waiting in the dialog.",
    reopen: () => onOpenChange(true),
  });
  /** The serialized explicit draft the current form state was seeded from. */
  const seededDraftRef = useRef<string | null>(null);

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
    const key = initialDraft
      ? JSON.stringify([initialDraft.title, initialDraft.body])
      : null;
    // A plan or to-do handing over new content retargets the one shared form, so
    // a waiting or streaming run's result must not survive into it; a reopen
    // carrying the same content is the ordinary hold path below.
    const isNewRequest = key !== null && key !== seededDraftRef.current;
    if (isNewRequest) {
      if (generating) cancel();
      void surface.consumeSkipSeed();
    } else if (surface.shouldSkipSeed(generating)) {
      // A generation still streaming — or one that settled while the dialog was
      // closed — leaves the whole draft in form state, which this reset would
      // blank on reopen.
      return;
    }
    form.reset(
      { title: initialDraft?.title ?? "", body: initialDraft?.body ?? "" },
      { keepDefaultValues: true },
    );
    seededDraftRef.current = key;
  });
  useSeedOnOpen(open, seedOnOpen);

  // Shared by the Draft-with-AI button and the generate chord below.
  async function runGenerate() {
    // `generate` resolves void and fires onResult only on a usable draft, so the
    // flag is how the settle learns whether a result actually landed.
    let ok = false;
    // finally: a throw past the stream (draft extraction, these field writes)
    // must still settle, or the switch-abort latch stays armed for the next run.
    try {
      await generate({
        notes,
        repoName,
        onResult: (d) => {
          ok = true;
          if (d.title) form.setFieldValue("title", d.title);
          form.setFieldValue("body", d.body);
        },
      });
    } finally {
      surface.noteRunSettled(ok);
    }
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
  // The one submit gate, shared by the button and the form's native submit:
  // Enter must submit exactly when the button would.
  const submitBlocked = generating;

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
            if (submitBlocked) return;
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
              <form.SubmitButton disabled={submitBlocked}>
                Create local issue
              </form.SubmitButton>
            </form.AppForm>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
