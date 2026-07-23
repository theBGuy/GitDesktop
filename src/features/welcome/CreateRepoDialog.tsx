import { open as openDialog } from "@tauri-apps/plugin-dialog";
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
import { required, useAppForm } from "@/lib/form";
import { createRepo, validateRepo } from "@/lib/git/api";
import { useGlobalDefaultBranch } from "@/lib/git/queries";
import { useAddRecentRepo } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";

const NONE = "__none__";
const GITIGNORE_TEMPLATES = ["Node", "Python", "Rust", "Go"];
const LICENSES = ["MIT", "Unlicense"];

function selectItems(values: string[]): Record<string, string> {
  return { [NONE]: "None", ...Object.fromEntries(values.map((v) => [v, v])) };
}

const DEFAULTS = {
  name: "",
  description: "",
  parentDir: "",
  initReadme: true,
  gitignore: NONE,
  license: NONE,
};

export function CreateRepoDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const openRepo = useUiStore((s) => s.openRepo);
  const addRecent = useAddRecentRepo();
  const globalDefaultBranch = useGlobalDefaultBranch();

  // The branch `git init` uses, from global git config; "main" when unset.
  const defaultBranch = (globalDefaultBranch.data ?? "").trim() || "main";

  const form = useAppForm({
    defaultValues: DEFAULTS,
    onSubmit: async ({ value }) => {
      try {
        const root = await createRepo({
          name: value.name.trim(),
          description: value.description.trim(),
          parentDir: value.parentDir.trim(),
          initReadme: value.initReadme,
          gitignore: value.gitignore === NONE ? null : value.gitignore,
          license: value.license === NONE ? null : value.license,
          defaultBranch,
        });
        const info = await validateRepo(root);
        // Await the recents write so the row exists before RepositoryView mounts
        // and its open-time visibility probe persists onto it (best-effort — a
        // settings-write failure must never block opening the repo).
        await addRecent
          .mutateAsync({ path: info.root, name: info.name })
          .catch(() => undefined);
        onOpenChange(false);
        openRepo(info);
        toast.success(`Created ${info.name}`);
      } catch (e) {
        toastError(e);
      }
    },
  });

  const seedOnOpen = useEffectEvent(() => form.reset(DEFAULTS));
  useEffect(() => {
    if (open) seedOnOpen();
  }, [open]);

  async function pickParentDir() {
    const path = await openDialog({
      directory: true,
      title: "Create repository in folder",
    });
    if (path) form.setFieldValue("parentDir", path);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            form.handleSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Create a new repository</DialogTitle>
            <DialogDescription>
              Initializes a git repository on the "{defaultBranch}" branch
              (change in Settings).
            </DialogDescription>
          </DialogHeader>
          <form.AppField
            name="name"
            validators={{ onChange: ({ value }) => required(value) }}
          >
            {(field) => (
              <field.TextField label="Name" placeholder="repository name" />
            )}
          </form.AppField>
          <form.AppField name="description">
            {(field) => <field.TextField label="Description" />}
          </form.AppField>
          <form.AppField
            name="parentDir"
            validators={{ onChange: ({ value }) => required(value) }}
          >
            {(field) => (
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <field.TextField
                    label="Local path"
                    placeholder="Type, paste, or choose a folder…"
                  />
                </div>
                <Button type="button" variant="outline" onClick={pickParentDir}>
                  Choose…
                </Button>
              </div>
            )}
          </form.AppField>
          <form.AppField name="initReadme">
            {(field) => (
              <field.CheckboxField
                label="Initialize this repository with a README"
                className="flex cursor-pointer items-center gap-2 text-xs"
              />
            )}
          </form.AppField>
          <div className="grid grid-cols-2 gap-4">
            <form.AppField name="gitignore">
              {(field) => (
                <field.SelectField
                  label="Git ignore"
                  items={selectItems(GITIGNORE_TEMPLATES)}
                />
              )}
            </form.AppField>
            <form.AppField name="license">
              {(field) => (
                <field.SelectField
                  label="License"
                  items={selectItems(LICENSES)}
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
              <form.SubmitButton>Create repository</form.SubmitButton>
            </form.AppForm>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
