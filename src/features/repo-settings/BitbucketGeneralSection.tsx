import { SparkleIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  useBbRepoSettings,
  useBbUpdateRepoSettings,
  useBranches,
} from "@/lib/git/queries";
import type {
  BitbucketRepoSettings,
  BitbucketRepoSettingsInput,
  Branch,
} from "@/lib/git/types";
import { useAiConfigured, useAiEnabled } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";
import { DescriptionField } from "./DescriptionField";
import { useGenerateRepoDescription } from "./useGenerateRepoDescription";

/** The Bitbucket counterpart of {@link GeneralSettingsSection}: Bitbucket's
 *  managed fields are its own subset (a fork policy enum, a plain default
 *  branch), so it gets a Bitbucket-shaped form. Same batch Save posture as the
 *  GitLab section — name and visibility stay in the Danger zone. */
export function BitbucketGeneralSection({
  repoPath,
  open,
}: {
  repoPath: string;
  open: boolean;
}) {
  const settings = useBbRepoSettings(repoPath, open);
  const branches = useBranches(repoPath);

  if (settings.isLoading) {
    return (
      <div className="min-w-0 space-y-3">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    );
  }

  if (settings.isError || !settings.data) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
        <p className="font-medium text-destructive">Couldn't load settings.</p>
        <p className="mt-1 text-muted-foreground">
          {settings.error instanceof Error ? settings.error.message : null}
        </p>
      </div>
    );
  }

  return (
    <BitbucketGeneralForm
      repoPath={repoPath}
      settings={settings.data}
      branches={branches.data ?? []}
    />
  );
}

function toInput(s: BitbucketRepoSettings): BitbucketRepoSettingsInput {
  return {
    description: s.description,
    website: s.website,
    language: s.language,
    forkPolicy: s.forkPolicy,
    mainBranch: s.mainBranch,
  };
}

/** Bitbucket's fork policy enum, with its own UI vocabulary. */
const FORK_POLICIES = [
  { value: "allow_forks", label: "Allow all forks" },
  { value: "no_public_forks", label: "Allow only private forks" },
  { value: "no_forks", label: "No forks" },
] as const;

/** Base UI's <Select> resolves value → label from an `items` map; without it a
 *  closed select falls back to the raw value ("allow_forks") until reopened. */
const FORK_POLICY_ITEMS: Record<string, string> = Object.fromEntries(
  FORK_POLICIES.map((o) => [o.value, o.label]),
);

function BitbucketGeneralForm({
  repoPath,
  settings,
  branches,
}: {
  repoPath: string;
  settings: BitbucketRepoSettings;
  branches: Branch[];
}) {
  const update = useBbUpdateRepoSettings(repoPath);
  const base = toInput(settings);
  const [form, setForm] = useState<BitbucketRepoSettingsInput>(base);

  const aiEnabled = useAiEnabled();
  const aiConfigured = useAiConfigured();
  const openSettings = useUiStore((s) => s.openSettings);
  const repoName =
    useUiStore((s) => s.repoName) ?? repoPath.split(/[/\\]/).pop() ?? repoPath;
  const descGen = useGenerateRepoDescription(repoPath);

  function set<K extends keyof BitbucketRepoSettingsInput>(
    key: K,
    value: BitbucketRepoSettingsInput[K],
  ) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  const dirty = JSON.stringify(form) !== JSON.stringify(base);

  // Keep the current default selectable even if that branch isn't local; drop
  // agent-session branches (`gd/session/*`) — they're app-internal.
  const branchNames = branches
    .map((b) => b.name)
    .filter((n) => !n.startsWith("gd/session/"));
  const branchOptions =
    form.mainBranch && !branchNames.includes(form.mainBranch)
      ? [form.mainBranch, ...branchNames]
      : branchNames;

  return (
    <div className="min-w-0 space-y-4">
      <DescriptionField
        id="bb-repo-description"
        value={form.description}
        onChange={(v) => set("description", v)}
        placeholder="Short description of this repository"
        generate={
          aiEnabled &&
          (!aiConfigured ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="text-muted-foreground"
              onClick={() => openSettings("ai")}
            >
              <SparkleIcon data-icon="inline-start" />
              Set up AI
            </Button>
          ) : descGen.generating ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="text-muted-foreground"
              onClick={descGen.cancel}
            >
              <Spinner data-icon="inline-start" />
              Cancel
            </Button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() =>
                descGen.generate({
                  repoName,
                  onResult: ({ description }) => {
                    if (description) set("description", description);
                  },
                })
              }
            >
              <SparkleIcon data-icon="inline-start" />
              Generate
            </Button>
          ))
        }
      />

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="bb-repo-website">Website</Label>
          <Input
            id="bb-repo-website"
            value={form.website}
            onChange={(e) => set("website", e.target.value)}
            placeholder="https://example.com"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="bb-repo-language">Language</Label>
          <Input
            id="bb-repo-language"
            value={form.language}
            onChange={(e) => set("language", e.target.value)}
            placeholder="typescript"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="bb-fork-policy">Fork policy</Label>
          <Select
            items={FORK_POLICY_ITEMS}
            value={form.forkPolicy}
            onValueChange={(v) => {
              if (v) set("forkPolicy", v);
            }}
          >
            <SelectTrigger id="bb-fork-policy" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FORK_POLICIES.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="bb-main-branch">Default branch</Label>
          <Select
            items={Object.fromEntries(branchOptions.map((b) => [b, b]))}
            value={form.mainBranch}
            onValueChange={(v) => {
              if (v) set("mainBranch", v);
            }}
          >
            <SelectTrigger id="bb-main-branch" className="w-full">
              <SelectValue placeholder="No default branch yet" />
            </SelectTrigger>
            <SelectContent>
              {branchOptions.map((b) => (
                <SelectItem key={b} value={b}>
                  {b}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 rounded-md border p-3 text-xs">
        <div className="min-w-0">
          <p className="font-medium text-muted-foreground">Project</p>
          <p className="mt-0.5 truncate" title={settings.projectName}>
            {settings.projectName || settings.projectKey || "—"}
            {settings.projectKey && settings.projectName ? (
              <span className="text-muted-foreground">
                {" "}
                ({settings.projectKey})
              </span>
            ) : null}
          </p>
        </div>
        <div className="min-w-0">
          <p className="font-medium text-muted-foreground">Visibility</p>
          <p className="mt-0.5 capitalize">
            {settings.isPrivate ? "private" : "public"}
          </p>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 border-t pt-3">
        <Button
          disabled={!dirty || update.isPending}
          onClick={() =>
            update.mutate(form, {
              onSuccess: () => toast.success("Settings saved"),
              onError: toastError,
            })
          }
        >
          {update.isPending && <Spinner data-icon="inline-start" />}
          Save changes
        </Button>
      </div>
    </div>
  );
}
