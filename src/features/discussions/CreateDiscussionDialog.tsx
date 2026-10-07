import { useSelector } from "@tanstack/react-store";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useEffectEvent } from "react";
import { toast } from "sonner";
import { DIALOG_SCROLL } from "@/components/dialog-scroll";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScopeRefreshHint } from "@/features/repo-settings/ScopeRefreshHint";
import { required, useAppForm } from "@/lib/form";
import { useCreateDiscussion, useDiscussionMeta } from "@/lib/git/queries";
import { refuseWhileOffline, useOfflineHold } from "@/lib/offline-writes";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";
import {
  ARIA_DISABLED_CLASS,
  useDisabledReason,
} from "@/lib/use-disabled-reason";
import { useSeedOnOpen } from "@/lib/use-seed-on-open";
import { cn } from "@/lib/utils";

export function CreateDiscussionDialog({
  repoPath,
  open,
  onOpenChange,
}: {
  repoPath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const meta = useDiscussionMeta(repoPath, open);
  const createDiscussion = useCreateDiscussion(repoPath);
  const selectDiscussion = useUiStore((s) => s.selectDiscussion);
  const categories = meta.data?.categories ?? [];
  const repoId = meta.data?.repoId ?? "";

  const form = useAppForm({
    defaultValues: { title: "", body: "", categoryId: "" },
    onSubmit: async ({ value }) => {
      if (refuseWhileOffline()) return;
      try {
        const { number, url } = await createDiscussion.mutateAsync({
          repoId,
          categoryId: value.categoryId,
          title: value.title.trim(),
          body: value.body,
        });
        toast.success(`Opened discussion #${number}`, {
          description: url,
          action: { label: "View", onClick: () => openUrl(url) },
        });
        onOpenChange(false);
        // Adopt the new discussion only while this repo is still on screen —
        // the create can settle after a repo switch.
        if (number > 0 && useUiStore.getState().repoPath === repoPath)
          selectDiscussion({ number });
      } catch (e) {
        toastError(e);
      }
    },
  });

  const categoryId = useSelector(form.store, (s) => s.values.categoryId);
  // Starting a discussion holds offline rather than park: a parked create
  // would land after the dialog was left behind. The missing-category hold keeps
  // its own hover hint; only the offline arm takes a reason.
  const offlineHold = useOfflineHold();
  const offlineSubmit = useDisabledReason({
    disabled: !categoryId || !!offlineHold,
    reason: offlineHold,
  });

  // keepDefaultValues: otherwise the per-render options sync clobbers the
  // reset values back to empty on an untouched form.
  const seedOnOpen = useEffectEvent(() => {
    form.reset(
      { title: "", body: "", categoryId: categories[0]?.id ?? "" },
      { keepDefaultValues: true },
    );
  });
  // Seed the default category once the (async) category list arrives.
  const ensureCategory = useEffectEvent(() => {
    if (!categoryId) form.setFieldValue("categoryId", categories[0].id);
  });
  useSeedOnOpen(open, seedOnOpen);
  useEffect(() => {
    if (open && categories.length > 0) ensureCategory();
  }, [open, categories.length]);

  const categoryItems = Object.fromEntries(
    categories.map((c) => [c.id, c.emoji ? `${c.emoji} ${c.name}` : c.name]),
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
            <DialogTitle>New discussion</DialogTitle>
            <DialogDescription>
              Starts a discussion on GitHub in the chosen category.
            </DialogDescription>
          </DialogHeader>

          {/* Fields scroll; header and submit footer stay pinned. */}
          <div className={cn(DIALOG_SCROLL, "min-h-0 flex-1 space-y-4")}>
            <ScopeRefreshHint
              scope="write:discussion"
              action="Creating a discussion"
              coveredBy={["repo"]}
            />
            <div className="min-w-0">
              <form.AppField name="categoryId">
                {(field) => (
                  <field.SelectField label="Category" items={categoryItems} />
                )}
              </form.AppField>
            </div>
            <form.AppField
              name="title"
              validators={{ onChange: ({ value }) => required(value) }}
            >
              {(field) => (
                <field.TextField
                  label="Title"
                  placeholder="Summarize the discussion"
                />
              )}
            </form.AppField>
            <form.AppField name="body">
              {(field) => (
                <field.MarkdownField
                  label="Body"
                  placeholder="What would you like to discuss?"
                  rows={8}
                  textareaClassName="max-h-72 min-h-24 resize-y font-mono"
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
              <span
                className={cn(
                  "inline-flex",
                  offlineSubmit.blockedReason && "cursor-not-allowed",
                )}
                title={offlineSubmit.wrapperTitle}
              >
                <form.SubmitButton
                  focusableWhenDisabled={!!offlineSubmit.blockedReason}
                  disabled={!categoryId || !!offlineHold}
                  title={categoryId ? undefined : "Choose a category first"}
                  aria-describedby={offlineSubmit.describedBy}
                  className={ARIA_DISABLED_CLASS}
                >
                  Start discussion
                </form.SubmitButton>
                {offlineSubmit.blockedReason ? (
                  <span id={offlineSubmit.reasonId} className="sr-only">
                    {offlineSubmit.blockedReason}
                  </span>
                ) : null}
              </span>
            </form.AppForm>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
