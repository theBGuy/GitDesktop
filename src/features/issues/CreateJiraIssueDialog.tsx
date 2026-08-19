import { SparkleIcon, XIcon } from "@phosphor-icons/react";
import { useSelector } from "@tanstack/react-store";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useEffectEvent, useId, useMemo, useState } from "react";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { required, useAppForm } from "@/lib/form";
import { useGenerateChord } from "@/lib/hotkeys/useGenerateChord";
import { useJiraCreateIssue, useJiraIssueTypes } from "@/lib/jira/queries";
import type { JiraLink } from "@/lib/jira/store";
import { useAiEnabled } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { errorMessage } from "@/lib/tauri/invoke";
import { useGenerateIssueDraft } from "./useGenerateIssueDraft";

/**
 * Create an issue in the linked Jira project. Mirrors the local/GitHub create
 * dialogs (summary + markdown description) with a Jira issue-type picker driven
 * by the project's `createmeta` (subtasks filtered out — they can't be created
 * standalone). Only rendered when `createIssues` permission is present, so there
 * is never a dead form. On success it toasts the new key, selects the created
 * issue in the panel, and the mutation invalidates the list so the row appears.
 */
export function CreateJiraIssueDialog({
  repoPath,
  link,
  open,
  onOpenChange,
}: {
  repoPath: string;
  link: JiraLink;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const create = useJiraCreateIssue(repoPath, link);
  // Only fetch types while the dialog is open; surfaced errors get a retry
  // rather than a dead Select.
  const types = useJiraIssueTypes(repoPath, link, open);
  const selectIssue = useUiStore((s) => s.selectIssue);
  const repoName = useUiStore((s) => s.repoName) ?? "";
  const aiEnabled = useAiEnabled();
  const { generate, cancel, generating } = useGenerateIssueDraft(repoPath);

  // Creatable types only (a subtask needs a parent — not offered here). Manual
  // useMemo is LOAD-BEARING: the submit handler's try/catch bails this component
  // out of the React Compiler, so nothing auto-memoizes this derived array — and
  // it feeds the default-type effect's deps below (a fresh reference every render
  // would re-fire that effect each time).
  const creatable = useMemo(
    () => (types.data ?? []).filter((t) => !t.subtask),
    [types.data],
  );
  const [issueTypeId, setIssueTypeId] = useState<string>("");
  const issueTypeSelectId = useId();
  // A Jira validation error the create command surfaced (field-level messages
  // the Rust side joins readably) — shown inline under the form, not a toast.
  const [createError, setCreateError] = useState<string | null>(null);

  const form = useAppForm({
    defaultValues: { summary: "", body: "" },
    onSubmit: async ({ value }) => {
      setCreateError(null);
      try {
        const { key, url } = await create.mutateAsync({
          issueTypeId,
          summary: value.summary.trim(),
          descriptionMd: value.body.trim() || undefined,
        });
        toast.success(`Created ${key}`, {
          description: url,
          action: { label: "View", onClick: () => openUrl(url) },
        });
        onOpenChange(false);
        selectIssue({ kind: "jira", id: key });
      } catch (e) {
        // Keep the dialog open so the draft survives; surface the reason inline.
        setCreateError(errorMessage(e));
      }
    },
  });

  const titleVal = useSelector(form.store, (s) => s.values.summary);
  const bodyVal = useSelector(form.store, (s) => s.values.body);
  const notes = [titleVal, bodyVal].filter(Boolean).join("\n\n");

  // keepDefaultValues: otherwise the per-render options sync clobbers the reset
  // values back to empty on an untouched form.
  const seedOnOpen = useEffectEvent(() => {
    form.reset({ summary: "", body: "" }, { keepDefaultValues: true });
    setCreateError(null);
  });
  useEffect(() => {
    if (open) seedOnOpen();
  }, [open]);

  // Default to the first creatable type once they load; clear the selection if a
  // refetch dropped the currently-picked one (e.g. project changed).
  useEffect(() => {
    if (creatable.length === 0) {
      setIssueTypeId("");
      return;
    }
    setIssueTypeId((cur) =>
      cur && creatable.some((t) => t.id === cur) ? cur : creatable[0].id,
    );
  }, [creatable]);

  const typeItems = Object.fromEntries(creatable.map((t) => [t.id, t.name]));
  const noTypes = !types.isPending && !types.isError && creatable.length === 0;
  // Why the submit is disabled — shown via a span-wrapped title (a `title` on the
  // Button itself never shows: disabled sets pointer-events-none).
  const submitReason = generating
    ? "Wait for the AI draft to finish"
    : !issueTypeId
      ? "Select an issue type to create the issue"
      : null;

  // Shared by the Draft-with-AI button and the generate chord below.
  function runGenerate() {
    generate({
      notes,
      repoName,
      onResult: (d) => {
        if (d.title) form.setFieldValue("summary", d.title);
        form.setFieldValue("body", d.body);
      },
    });
  }
  // The generate chord drafts this issue while the dialog is open. It's mounted
  // on DialogContent, not the <form>: the X close button is a form SIBLING
  // inside the Popup, so a form-level handler would miss a chord pressed with
  // focus on X. The swallow is unconditional so it can't reach the global
  // generate-commit-message action behind the dialog; while generating it
  // swallows but DOESN'T cancel.
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
            <DialogTitle>Create Jira issue</DialogTitle>
            <DialogDescription>
              Opens a new issue in{" "}
              <span className="font-mono">{link.projectKey}</span> on your Jira
              site.
            </DialogDescription>
          </DialogHeader>

          {/* Fields scroll; header and submit footer stay pinned. */}
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
            <form.AppField
              name="summary"
              validators={{ onChange: ({ value }) => required(value) }}
            >
              {(field) => (
                <field.TextField
                  label="Summary"
                  placeholder="Summarize the issue"
                  warning={(v) =>
                    v.trim() ? null : "Enter a summary to create the issue"
                  }
                />
              )}
            </form.AppField>

            <div className="space-y-2">
              <Label htmlFor={issueTypeSelectId}>Issue type</Label>
              {types.isError ? (
                <div className="flex items-center gap-2 border px-3 py-2 text-xs text-muted-foreground">
                  <span className="flex-1">
                    Couldn't load issue types for {link.projectKey}.
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => types.refetch()}
                  >
                    Retry
                  </Button>
                </div>
              ) : noTypes ? (
                <p className="text-xs text-warning">
                  {link.projectKey} has no issue types you can create — create
                  one in Jira, or check your project permissions.
                </p>
              ) : (
                <Select
                  items={typeItems}
                  value={issueTypeId || null}
                  onValueChange={(v) => {
                    if (v) setIssueTypeId(v);
                  }}
                  disabled={types.isPending}
                >
                  <SelectTrigger id={issueTypeSelectId} className="w-full">
                    <SelectValue
                      placeholder={
                        types.isPending ? "Loading types…" : "Select a type"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {creatable.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

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

            {createError && (
              <p className="text-xs text-destructive">{createError}</p>
            )}
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
              <span className="inline-flex" title={submitReason ?? undefined}>
                <form.SubmitButton disabled={generating || !issueTypeId}>
                  Create issue
                </form.SubmitButton>
              </span>
            </form.AppForm>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
