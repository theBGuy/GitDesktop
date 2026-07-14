import { Popover } from "@base-ui/react/popover";
import { SparkleIcon, TagIcon, XIcon } from "@phosphor-icons/react";
import { useSelector } from "@tanstack/react-store";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { LabelChip } from "@/features/conversations/Thread";
import { AssigneesPopover } from "@/features/issues/IssueMetaPickers";
import { track } from "@/lib/analytics";
import { triggerAutomations } from "@/lib/automations/runner";
import { required, useAppForm } from "@/lib/form";
import {
  forgeFeatureReady,
  useCompareBranches,
  useCreatePr,
  useDefaultBranch,
  useForgeStatus,
  useRepoLabels,
  useRepoStatus,
} from "@/lib/git/queries";
import { type ForgeUserRef, providerLabel } from "@/lib/git/types";
import { useAiEnabled } from "@/lib/settings/queries";
import { toastError } from "@/lib/toast";
import { ReviewersPopover } from "./ReviewersPopover";
import { useBranchPickerOptions } from "./useBranchPickerOptions";
import { useGeneratePrDescription } from "./useGeneratePrDescription";

export function CreatePrDialog({
  repoPath,
  defaultBase,
  defaultHead,
  open,
  onOpenChange,
}: {
  repoPath: string;
  /** Seeds the base ("into") branch; defaults to the repo's default branch. */
  defaultBase?: string;
  /** Seeds the head ("merge") branch; defaults to the current branch. */
  defaultHead?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const status = useRepoStatus(repoPath);
  const defaultBranch = useDefaultBranch(repoPath);
  const createPr = useCreatePr(repoPath);
  const forge = useForgeStatus(repoPath);
  // Create-TIME reviewers stay Bitbucket-only: `forge_pr_create` rejects a reviewer
  // list for GitHub/GitLab (their create arms don't accept one yet). The
  // `mrReviewers` capability now covers all three, but only for editing reviewers on
  // an existing PR (the RemotePrView picker), so scope the create dialog explicitly.
  const canPickReviewers =
    forge.data?.provider === "bitbucket" &&
    forgeFeatureReady(forge.data, "mrReviewers");
  // Labels + assignees are GitHub/GitLab; a repo is exactly one provider, so
  // these and the Bitbucket create-time reviewers picker are mutually exclusive.
  const canPickLabels = forgeFeatureReady(forge.data, "mrLabels");
  const canPickAssignees = forgeFeatureReady(forge.data, "mrAssignees");
  const [reviewers, setReviewers] = useState<ForgeUserRef[]>([]);
  const [labels, setLabels] = useState<Set<string>>(new Set());
  const [assignees, setAssignees] = useState<ForgeUserRef[]>([]);
  const repoLabels = useRepoLabels(repoPath, open);
  const isGitLab = forge.data?.provider === "gitlab";
  const remoteLabel = providerLabel(forge.data?.provider);
  const prNoun = isGitLab ? "merge request" : "pull request";
  const { generate, cancel, generating } = useGeneratePrDescription(repoPath);
  const aiEnabled = useAiEnabled();
  const aiDescriptionRef = useRef(false);

  const currentName = status.data?.branch?.name ?? null;
  // Branch options with per-branch worktree chips; drops the app-internal
  // `gd/session/*` branches (submitting one would even PUSH it) and archived
  // branches, the same rules as BranchSwitcher. `keep` retains the seeded
  // defaults even if archived, so the head/base defaults stay selectable.
  const { names, items, annotations } = useBranchPickerOptions(repoPath, open, [
    currentName,
    defaultHead,
    defaultBase,
    defaultBranch.data,
  ]);

  const form = useAppForm({
    defaultValues: { head: "", base: "", title: "", body: "", draft: false },
    validators: {
      // Same branch on both sides proposes nothing — gate the submit.
      onChange: ({ value }) =>
        value.head === value.base ? "Pick two different branches." : undefined,
    },
    onSubmit: async ({ value }) => {
      try {
        const { number, url } = await createPr.mutateAsync({
          base: value.base,
          head: value.head,
          title: value.title.trim(),
          body: value.body,
          draft: value.draft,
          // Bitbucket-only; omit the key otherwise (GitHub/GitLab byte-identical).
          // An empty selection also omits it, preserving server-side default reviewers.
          ...(canPickReviewers && reviewers.length > 0
            ? { reviewers: reviewers.map((r) => r.id) }
            : {}),
          // GitHub/GitLab only; omit the key (and for empty selections) so the
          // backend leaves create behavior untouched.
          ...(canPickLabels && labels.size > 0 ? { labels: [...labels] } : {}),
          ...(canPickAssignees && assignees.length > 0
            ? { assignees: assignees.map((a) => a.id) }
            : {}),
        });
        track({
          name: "pull_request_created",
          properties: {
            is_draft: value.draft,
            has_ai_description: aiDescriptionRef.current,
          },
        });
        toast.success(`Opened ${prNoun} #${number}`, {
          description: url,
          action: { label: "View", onClick: () => openUrl(url) },
        });
        // This dialog is panel-hosted under <Activity>, so the success path must
        // only close — never setRepoTab/selectPr (a hidden Activity subtree would
        // defer the close and strand the dialog). Want navigation? Hoist it to
        // RepositoryView first, like CreateLocalPrDialog.
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
          target: { type: "remote", number },
        });
      } catch (e) {
        toastError(e);
      }
    },
  });

  // Seed branches each time the dialog opens: head = current branch, base =
  // the default branch (or, when you're already on it, the first other branch).
  // keepDefaultValues: otherwise the per-render options sync clobbers the
  // seeded values back to empty on an untouched form.
  const seedOnOpen = useEffectEvent(() => {
    aiDescriptionRef.current = false;
    setReviewers([]);
    setLabels(new Set());
    setAssignees([]);
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
        draft: false,
      },
      { keepDefaultValues: true },
    );
  });
  useEffect(() => {
    if (open) seedOnOpen();
  }, [open]);

  // Live head/base drive the "N commits" hint, AI generation, and submit gate.
  const head = useSelector(form.store, (s) => s.values.head);
  const base = useSelector(form.store, (s) => s.values.base);
  const comparison = useCompareBranches(repoPath, base || null, head || null);
  const ahead = comparison.data?.ahead ?? [];
  const sameBranch = base === head;
  const nothingToMerge = sameBranch || ahead.length === 0;

  function toggleLabel(name: string, on: boolean) {
    setLabels((prev) => {
      const next = new Set(prev);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });
  }

  const selectedChips = (repoLabels.data ?? []).filter((l) =>
    labels.has(l.name),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <form
          className="flex min-h-0 min-w-0 flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            form.handleSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Create {prNoun}</DialogTitle>
            <DialogDescription>
              Pushes <span className="font-mono">{head || "…"}</span> and opens
              a {prNoun} into <span className="font-mono">{base || "…"}</span>{" "}
              on {remoteLabel}.
            </DialogDescription>
          </DialogHeader>

          {/* Fields scroll; the header and submit footer stay pinned so a long
              body can't push the dialog off-screen. */}
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

            {canPickReviewers && (
              <div className="space-y-1.5">
                <Label>Reviewers</Label>
                <ReviewersPopover
                  repoPath={repoPath}
                  number={null}
                  enabled={open && canPickReviewers}
                  value={reviewers}
                  onChange={setReviewers}
                />
              </div>
            )}

            {canPickLabels && (
              <div className="flex flex-wrap items-center gap-1.5">
                <Popover.Root>
                  <Popover.Trigger
                    render={
                      <Button
                        variant="outline"
                        size="xs"
                        aria-label="Add labels"
                      />
                    }
                  >
                    <TagIcon data-icon="inline-start" />
                    Labels
                  </Popover.Trigger>
                  <Popover.Portal>
                    <Popover.Positioner
                      align="start"
                      sideOffset={4}
                      className="isolate z-50"
                    >
                      <Popover.Popup className="w-60 rounded-none bg-popover p-2 text-popover-foreground shadow-md ring-1 ring-foreground/10">
                        <p className="px-1 pb-1.5 text-xs font-medium">
                          Labels
                        </p>
                        {(repoLabels.data ?? []).length === 0 && (
                          <p className="px-1 py-1 text-xs text-muted-foreground">
                            {repoLabels.isPending
                              ? "Loading labels…"
                              : "This repository has no labels."}
                          </p>
                        )}
                        {(repoLabels.data ?? []).map((label) => (
                          <label
                            key={label.name}
                            className="flex cursor-pointer items-center gap-2 px-1 py-1.5 text-xs hover:bg-muted/60"
                          >
                            <Checkbox
                              checked={labels.has(label.name)}
                              onCheckedChange={(v) =>
                                toggleLabel(label.name, v === true)
                              }
                            />
                            <span
                              aria-hidden
                              className="size-2 shrink-0 rounded-full"
                              style={{ backgroundColor: `#${label.color}` }}
                            />
                            <span className="flex-1 truncate">
                              {label.name}
                            </span>
                          </label>
                        ))}
                      </Popover.Popup>
                    </Popover.Positioner>
                  </Popover.Portal>
                </Popover.Root>
                {selectedChips.map((label) => (
                  <LabelChip key={label.name} label={label} />
                ))}
              </div>
            )}

            {canPickAssignees && (
              <div className="space-y-1.5">
                <Label>Assignees</Label>
                <AssigneesPopover
                  repoPath={repoPath}
                  enabled={open}
                  value={assignees}
                  onChange={setAssignees}
                />
              </div>
            )}

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
                  textareaClassName="ph-no-capture max-h-72 min-h-24 resize-y font-mono"
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
                        disabled={nothingToMerge}
                        onClick={() => {
                          aiDescriptionRef.current = true;
                          generate(
                            base,
                            head,
                            ahead.map((c) => c.subject),
                            (d) => {
                              form.setFieldValue("title", d.title);
                              form.setFieldValue("body", d.body);
                              // Additive: union the model's (already repo-validated)
                              // labels with the user's manual picks, never replace.
                              setLabels(
                                (prev) => new Set([...prev, ...d.labels]),
                              );
                            },
                            // Provider-aware prompt copy (MR/merge-request noun,
                            // markdown flavor); null host → base GitHub wording.
                            forge.data?.provider ?? undefined,
                            // Existing repo label names the model may propose from;
                            // empty ⇒ no labels proposed.
                            repoLabels.data?.map((l) => l.name) ?? [],
                          );
                        }}
                        title="Generate the title and description with AI"
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

          <DialogFooter className="sm:items-center">
            <form.AppField name="draft">
              {(field) => (
                <field.CheckboxField
                  label="Create as draft"
                  className="mr-auto flex cursor-pointer items-center gap-2 text-xs text-muted-foreground"
                />
              )}
            </form.AppField>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <form.AppForm>
              <form.Subscribe selector={(s) => s.values.draft}>
                {(draft) => (
                  <form.SubmitButton disabled={generating || nothingToMerge}>
                    {draft ? "Create draft" : `Create ${prNoun}`}
                  </form.SubmitButton>
                )}
              </form.Subscribe>
            </form.AppForm>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
