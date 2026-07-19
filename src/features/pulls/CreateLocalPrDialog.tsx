import { SparkleIcon, XIcon } from "@phosphor-icons/react";
import { useSelector } from "@tanstack/react-store";
import { useEffect, useEffectEvent } from "react";
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
import { triggerAutomations } from "@/lib/automations/runner";
import { required, useAppForm } from "@/lib/form";
import {
  useCompareBranches,
  useDefaultBranch,
  useRepoStatus,
} from "@/lib/git/queries";
import { eventToBinding, formatBinding } from "@/lib/hotkeys/binding";
import { useEffectiveBindings } from "@/lib/hotkeys/hotkeys";
import { useCreateLocalPr } from "@/lib/pulls/queries";
import { useAiEnabled } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";
import { useBranchPickerOptions } from "./useBranchPickerOptions";
import { useGeneratePrDescription } from "./useGeneratePrDescription";

/** Platform-correct submit hint (Cmd+Enter on macOS, Ctrl+Enter else) — never a
 *  literal modifier (house platform-mod-key rule). */
const SUBMIT_HINT = formatBinding("mod+enter");

// Rendered exactly ONCE, hoisted in RepositoryView — never render it inside a tab
// panel. Its success handler's `setRepoTab("pulls")` would hide a panel host's
// <Activity> subtree and defer the `onOpenChange(false)`, stranding the dialog open.
export function CreateLocalPrDialog({
  repoPath,
  defaultBase,
  defaultHead,
  open,
  onOpenChange,
}: {
  repoPath: string;
  defaultBase?: string;
  defaultHead?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const status = useRepoStatus(repoPath);
  const defaultBranch = useDefaultBranch(repoPath);
  const createPr = useCreateLocalPr(repoPath);
  const { generate, cancel, generating } = useGeneratePrDescription(repoPath);
  const aiEnabled = useAiEnabled();
  const selectPr = useUiStore((s) => s.selectPr);
  const setRepoTab = useUiStore((s) => s.setRepoTab);

  const currentName = status.data?.branch?.name ?? null;
  // Branch options with per-branch worktree chips; drops the app-internal
  // `gd/session/*` branches (a local PR must never target one) and archived
  // branches, matching BranchSwitcher. `keep` retains the seeded defaults even
  // if archived, so the head/base defaults stay selectable.
  const { names, items, annotations } = useBranchPickerOptions(repoPath, open, [
    currentName,
    defaultHead,
    defaultBase,
    defaultBranch.data,
  ]);

  const form = useAppForm({
    defaultValues: { head: "", base: "", title: "", body: "" },
    validators: {
      // Same branch on both sides proposes nothing — gate the submit.
      onChange: ({ value }) =>
        value.head === value.base ? "Pick two different branches." : undefined,
    },
    onSubmit: async ({ value }) => {
      try {
        const pr = await createPr.mutateAsync({
          title: value.title.trim(),
          body: value.body,
          base: value.base,
          head: value.head,
        });
        toast.success(`Created local PR: ${pr.title}`);
        setRepoTab("pulls");
        selectPr({ kind: "local", id: pr.id });
        onOpenChange(false);
        triggerAutomations({
          kind: "pr-open",
          repoPath,
          base: value.base,
          head: value.head,
          // `ahead` (git log) is newest-first, so the head is the first entry.
          headSha: ahead[0]?.hash,
          title: value.title.trim(),
          body: value.body,
          commitSubjects: ahead.map((c) => c.subject),
          target: { type: "local", id: pr.id },
        });
      } catch (e) {
        toastError(e);
      }
    },
  });

  // keepDefaultValues: otherwise the per-render options sync clobbers the
  // seeded head/base back to empty (untouched form).
  const seedOnOpen = useEffectEvent(() => {
    const h = defaultHead ?? currentName ?? names[0] ?? "";
    const fallbackBase =
      defaultBranch.data && defaultBranch.data !== h
        ? defaultBranch.data
        : (names.find((n) => n !== h) ?? "");
    form.reset(
      {
        head: h,
        base: defaultBase ?? fallbackBase,
        title: "",
        body: "",
      },
      { keepDefaultValues: true },
    );
  });
  useEffect(() => {
    if (open) seedOnOpen();
  }, [open]);

  // Live head/base drive the "N commits to merge" hint and AI generation.
  const head = useSelector(form.store, (s) => s.values.head);
  const base = useSelector(form.store, (s) => s.values.base);
  const comparison = useCompareBranches(repoPath, base || null, head || null);
  const ahead = comparison.data?.ahead ?? [];
  const sameBranch = base === head;

  // AI title+description generation — shared by the Generate button's onClick and
  // the dialog-local generate chord below. Verbatim the button's prior body.
  function runGenerate() {
    generate(
      base,
      head,
      ahead.map((c) => c.subject),
      (d) => {
        form.setFieldValue("title", d.title);
        form.setFieldValue("body", d.body);
      },
    );
  }
  // Context-sensitive reuse of the `generate-commit-message` binding (mod+g by
  // default) while this dialog is open — never a hardcoded chord, so a
  // Settings → Keyboard rebinding drives it. null = explicitly unbound.
  const generateBinding =
    useEffectiveBindings().get("generate-commit-message") ?? null;
  const generateHint = generateBinding
    ? ` (${formatBinding(generateBinding)})`
    : "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[85vh] flex-col sm:max-w-2xl"
        // mod+enter submits from anywhere in the dialog. It's captured on
        // DialogContent (the Popup), not the <form>: this dialog is hoisted in
        // RepositoryView and can sit open over the Changes tab, where the global
        // `commit` action (also mod+enter) has a live handler, and the X close
        // button renders as a SIBLING of the form inside the Popup — a chord
        // pressed with focus on the X would otherwise bypass a form-level
        // handler and commit behind the dialog. Capturing on the Popup covers
        // the X and every field, so the UNCONDITIONAL preventDefault here is
        // what actually contains the chord. Submit only when the SubmitButton
        // would be enabled (handleSubmit still enforces the field validators).
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
            e.preventDefault();
            if (!generating) form.handleSubmit();
            return;
          }
          // The generate-commit-message chord (mod+g by default) runs this
          // dialog's own Generate while it's open. Only when AI is on (no
          // Generate surface otherwise) and the chord is bound. ALWAYS swallow
          // it: this dialog is hoisted over the Changes tab, where the global
          // generate-commit-message action has a live handler — without this the
          // chord would generate a COMMIT MESSAGE behind the dialog. Run Generate
          // only when its button would be enabled; while generating we swallow
          // but DON'T cancel (an accidental repeat must not abort a running one).
          if (
            aiEnabled &&
            generateBinding !== null &&
            eventToBinding(e) === generateBinding
          ) {
            e.preventDefault();
            if (!generating && !(sameBranch || ahead.length === 0)) {
              runGenerate();
            }
          }
        }}
      >
        <form
          className="flex min-h-0 min-w-0 flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            form.handleSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>New local pull request</DialogTitle>
            <DialogDescription>
              Propose merging one branch into another and review it locally — no
              GitHub involved. Merge it later with a{" "}
              <span className="font-mono">--no-ff</span> commit.
            </DialogDescription>
          </DialogHeader>

          {/* Fields scroll; header and submit footer stay pinned. */}
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-initial">
                <form.AppField name="head">
                  {(field) => (
                    <field.SelectField
                      label="Merge"
                      items={items}
                      annotations={annotations}
                      sizeToContent
                    />
                  )}
                </form.AppField>
              </div>
              <span className="shrink-0 pb-2 text-xs text-muted-foreground">
                into
              </span>
              <div className="min-w-0 flex-initial">
                <form.AppField name="base">
                  {(field) => (
                    <field.SelectField
                      label="Base"
                      items={items}
                      annotations={annotations}
                      sizeToContent
                    />
                  )}
                </form.AppField>
              </div>
            </div>
            <div className="space-y-0.5">
              <p className="font-mono text-xs wrap-break-word text-foreground/80">
                {head || "…"} <span className="text-muted-foreground">→</span>{" "}
                {base || "…"}
              </p>
              {sameBranch ? (
                <p className="text-xs text-warning">
                  Pick two different branches.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {ahead.length} commit{ahead.length === 1 ? "" : "s"} to merge.
                </p>
              )}
            </div>

            <form.AppField
              name="title"
              validators={{ onChange: ({ value }) => required(value) }}
            >
              {(field) => (
                <field.TextField
                  label="Title"
                  placeholder="Summarize the change"
                />
              )}
            </form.AppField>
            <form.AppField name="body">
              {(field) => (
                <field.MarkdownField
                  label="Description"
                  placeholder="Describe what changed and why"
                  rows={7}
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
                        disabled={sameBranch || ahead.length === 0}
                        onClick={runGenerate}
                        title={`Generate the title and description with AI${generateHint}`}
                      >
                        <SparkleIcon data-icon="inline-start" />
                        Generate
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
              <form.SubmitButton disabled={generating} title={SUBMIT_HINT}>
                Create local PR
              </form.SubmitButton>
            </form.AppForm>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
