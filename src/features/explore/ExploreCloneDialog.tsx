import { useSelector } from "@tanstack/react-store";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useEffectEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { parentDir } from "@/features/welcome/clone-utils";
import { useAppForm } from "@/lib/form";
import { forgeClone, validateRepo } from "@/lib/git/api";
import type { ForgeProvider } from "@/lib/git/types";
import { useAddRecentRepo, useSettings } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";
import { useSeedOnOpen } from "@/lib/use-seed-on-open";

/** The repo an Explore clone is pinned to. */
export interface ExploreCloneTarget {
  provider: ForgeProvider;
  cloneUrl: string;
  name: string;
}

const DEFAULTS = { destination: "", recurseSubmodules: false };

/**
 * A clone dialog pinned to a repo chosen in Explore — same submit path as the
 * Welcome CloneRepoDialog (forgeClone → validateRepo → record recent → openRepo)
 * but with the URL fixed to the selected repo, so it only asks for the local path.
 */
export function ExploreCloneDialog({
  target,
  onOpenChange,
}: {
  target: ExploreCloneTarget | null;
  onOpenChange: (open: boolean) => void;
}) {
  const openRepo = useUiStore((s) => s.openRepo);
  const addRecent = useAddRecentRepo();
  const settings = useSettings();

  const form = useAppForm({
    defaultValues: DEFAULTS,
    onSubmit: async ({ value }) => {
      const dest = value.destination.trim();
      if (!target || !dest) return;
      try {
        const clonedPath = await forgeClone(
          target.provider,
          target.cloneUrl,
          dest,
          target.name,
          value.recurseSubmodules,
        );
        const info = await validateRepo(clonedPath);
        // Await the recents write so the row exists before RepositoryView mounts
        // (best-effort — a settings-write failure must never block opening).
        await addRecent
          .mutateAsync({ path: info.root, name: info.name })
          .catch(() => undefined);
        onOpenChange(false);
        openRepo(info);
      } catch (e) {
        toastError(e);
      }
    },
  });

  // Default the destination near the user's other repos each time it opens.
  const defaultPath = useEffectEvent(() => {
    const recent = settings.data?.recentRepos?.[0]?.path;
    return recent ? parentDir(recent) : "";
  });
  const seedOnOpen = useEffectEvent(() => {
    form.reset(
      { destination: defaultPath(), recurseSubmodules: false },
      { keepDefaultValues: true },
    );
  });
  const open = target !== null;
  useSeedOnOpen(open, seedOnOpen);

  const values = useSelector(form.store, (s) => s.values);
  const isSubmitting = useSelector(form.store, (s) => s.isSubmitting);

  async function pickDestination() {
    const path = await openDialog({ directory: true, title: "Local path" });
    if (path) form.setFieldValue("destination", path);
  }

  const canClone = values.destination.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            form.handleSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Clone {target?.name}</DialogTitle>
            <DialogDescription>
              Choose a folder to clone into. Clones over HTTPS or SSH using your
              system git credentials.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1.5">
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <form.AppField name="destination">
                  {(field) => (
                    <field.TextField
                      label="Local path"
                      placeholder="Choose a folder to clone into…"
                    />
                  )}
                </form.AppField>
              </div>
              <Button type="button" variant="outline" onClick={pickDestination}>
                Choose…
              </Button>
            </div>
            {values.destination.trim() && target && (
              <p className="truncate text-[11px] text-muted-foreground">
                Clones into{" "}
                <span className="font-mono">
                  {values.destination.trim().replace(/[\\/]$/, "")}
                  {values.destination.includes("/") ? "/" : "\\"}
                  {target.name}
                </span>
              </p>
            )}
          </div>

          <div className="space-y-1">
            <form.AppField name="recurseSubmodules">
              {(field) => (
                <field.CheckboxField
                  label="Clone submodules"
                  className="flex cursor-pointer items-center gap-2 text-xs"
                />
              )}
            </form.AppField>
            <p className="text-[11px] text-muted-foreground">
              Initializes every submodule, including nested ones, after cloning.
            </p>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <form.AppForm>
              {/* Wrap so the disabled reason still shows on hover — a
                  native-disabled button swallows its `title`. */}
              <span
                className="inline-flex"
                title={
                  canClone ? undefined : "Choose a local path to clone into"
                }
              >
                <form.SubmitButton disabled={!canClone}>
                  Clone
                </form.SubmitButton>
              </span>
            </form.AppForm>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
