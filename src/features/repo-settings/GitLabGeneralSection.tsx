import { SparkleIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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
import { Switch } from "@/components/ui/switch";
import {
  useBranches,
  useGlRepoSettings,
  useUpdateGlRepoSettings,
} from "@/lib/git/queries";
import type {
  Branch,
  GitLabRepoSettings,
  GitLabRepoSettingsInput,
} from "@/lib/git/types";
import { usePublishGenerateAction } from "@/lib/hotkeys/useGenerateChord";
import { useAiConfigured, useAiEnabled } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";
import { DescriptionField } from "./DescriptionField";
import { GITLAB_TOPIC_RULES, TopicsField } from "./TopicsField";
import { useGenerateRepoDescription } from "./useGenerateRepoDescription";

/** The GitLab counterpart of {@link GeneralSettingsSection}: GitLab's settings
 *  model is its own shape (per-feature access levels, one merge-method enum, a
 *  squash option), so it gets a GitLab-shaped form instead of a lossy mapping
 *  onto the GitHub one. Same batch Save posture. */
export function GitLabGeneralSection({
  repoPath,
  open,
}: {
  repoPath: string;
  open: boolean;
}) {
  const settings = useGlRepoSettings(repoPath, open);
  const branches = useBranches(repoPath);

  if (settings.isLoading) {
    return (
      <div className="min-w-0 space-y-3">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-20 w-full" />
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
    <GitLabGeneralForm
      repoPath={repoPath}
      settings={settings.data}
      branches={branches.data ?? []}
    />
  );
}

function toInput(s: GitLabRepoSettings): GitLabRepoSettingsInput {
  return {
    description: s.description ?? "",
    topics: s.topics,
    defaultBranch: s.defaultBranch,
    issuesAccessLevel: s.issuesAccessLevel,
    mergeRequestsAccessLevel: s.mergeRequestsAccessLevel,
    wikiAccessLevel: s.wikiAccessLevel,
    snippetsAccessLevel: s.snippetsAccessLevel,
    forkingAccessLevel: s.forkingAccessLevel,
    mergeMethod: s.mergeMethod,
    squashOption: s.squashOption,
    removeSourceBranchAfterMerge: s.removeSourceBranchAfterMerge,
    onlyAllowMergeIfPipelineSucceeds: s.onlyAllowMergeIfPipelineSucceeds,
    onlyAllowMergeIfAllDiscussionsAreResolved:
      s.onlyAllowMergeIfAllDiscussionsAreResolved,
  };
}

/** GitLab's per-feature access levels — tri-state, never collapsed to a
 *  checkbox (that would silently clobber "Members only"). */
const ACCESS_LEVELS = [
  { value: "enabled", label: "Everyone with access" },
  { value: "private", label: "Members only" },
  { value: "disabled", label: "Disabled" },
] as const;

const FEATURES: { key: FeatureKey; label: string }[] = [
  { key: "issuesAccessLevel", label: "Issues" },
  { key: "mergeRequestsAccessLevel", label: "Merge requests" },
  { key: "wikiAccessLevel", label: "Wiki" },
  { key: "snippetsAccessLevel", label: "Snippets" },
  { key: "forkingAccessLevel", label: "Forking" },
];
type FeatureKey =
  | "issuesAccessLevel"
  | "mergeRequestsAccessLevel"
  | "wikiAccessLevel"
  | "snippetsAccessLevel"
  | "forkingAccessLevel";

/** GitLab's merge-method enum, with its own UI vocabulary. */
const MERGE_METHODS = [
  { value: "merge", label: "Merge commit" },
  { value: "rebase_merge", label: "Merge commit with semi-linear history" },
  { value: "ff", label: "Fast-forward merge" },
] as const;

const SQUASH_OPTIONS = [
  { value: "default_off", label: "Allow (off by default)" },
  { value: "default_on", label: "Encourage (on by default)" },
  { value: "always", label: "Require" },
  { value: "never", label: "Do not allow" },
] as const;

/** Base UI's <Select> resolves the selected value → its display label from an
 *  `items` map; without it a closed select falls back to the raw value (so the
 *  trigger reads "enabled" / "merge" / "default_off" until the popup is opened). */
const ACCESS_LEVEL_ITEMS: Record<string, string> = Object.fromEntries(
  ACCESS_LEVELS.map((o) => [o.value, o.label]),
);
const MERGE_METHOD_ITEMS: Record<string, string> = Object.fromEntries(
  MERGE_METHODS.map((o) => [o.value, o.label]),
);
const SQUASH_OPTION_ITEMS: Record<string, string> = Object.fromEntries(
  SQUASH_OPTIONS.map((o) => [o.value, o.label]),
);

/** Normalize AI-suggested topics per GitLab's rules (trim only, case + spaces
 *  preserved), deduped and with no cap — used when the Generate result seeds topics. */
function normalizeGlTopics(raw: string[]): string[] {
  return [
    ...new Set(raw.map((t) => GITLAB_TOPIC_RULES.normalize(t)).filter(Boolean)),
  ];
}

function GitLabGeneralForm({
  repoPath,
  settings,
  branches,
}: {
  repoPath: string;
  settings: GitLabRepoSettings;
  branches: Branch[];
}) {
  const update = useUpdateGlRepoSettings(repoPath);
  const base = toInput(settings);
  const [form, setForm] = useState<GitLabRepoSettingsInput>(base);

  const aiEnabled = useAiEnabled();
  const aiConfigured = useAiConfigured();
  const openSettings = useUiStore((s) => s.openSettings);
  const repoName =
    useUiStore((s) => s.repoName) ?? repoPath.split(/[/\\]/).pop() ?? repoPath;
  const descGen = useGenerateRepoDescription(repoPath);

  function set<K extends keyof GitLabRepoSettingsInput>(
    key: K,
    value: GitLabRepoSettingsInput[K],
  ) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  // Shared by the Generate button and the settings dialog's generate chord,
  // which this publishes to — the shell owns the chord because it owns the
  // DialogContent every section renders inside.
  function runGenerate() {
    descGen.generate({
      repoName,
      onResult: ({ description, topics }) => {
        if (description) set("description", description);
        if (topics.length) set("topics", normalizeGlTopics(topics));
      },
    });
  }
  const { hint: generateHint } = usePublishGenerateAction(
    aiEnabled && aiConfigured && !descGen.generating,
    runGenerate,
  );

  const dirty = JSON.stringify(form) !== JSON.stringify(base);

  // Awaited, not per-call callbacks: this subtree unmounts when the dialog
  // closes or the rail crossfades to another section, and react-query drops
  // per-call callbacks on unmount — the outcome would never reach the user.
  async function handleSave() {
    try {
      await update.mutateAsync(form);
      toast.success("Settings saved");
    } catch (e) {
      toastError(e);
    }
  }

  // Keep the current default selectable even if that branch isn't local; drop
  // agent-session branches (`gd/session/*`) — they're app-internal.
  const branchNames = branches
    .map((b) => b.name)
    .filter((n) => !n.startsWith("gd/session/"));
  const branchOptions =
    form.defaultBranch && !branchNames.includes(form.defaultBranch)
      ? [form.defaultBranch, ...branchNames]
      : branchNames;

  return (
    <div className="min-w-0 space-y-4">
      <DescriptionField
        id="gl-repo-description"
        value={form.description}
        onChange={(v) => set("description", v)}
        placeholder="Short description of this project"
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
              title={`Suggest a description + topics from the README with AI${generateHint}`}
              onClick={runGenerate}
            >
              <SparkleIcon data-icon="inline-start" />
              Generate
            </Button>
          ))
        }
      />

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor="gl-repo-topics">Topics</Label>
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {form.topics.length}
          </span>
        </div>
        <TopicsField
          id="gl-repo-topics"
          topics={form.topics}
          onChange={(next) => set("topics", next)}
          rules={GITLAB_TOPIC_RULES}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="gl-repo-default-branch">Default branch</Label>
        <Select
          items={Object.fromEntries(branchOptions.map((b) => [b, b]))}
          value={form.defaultBranch ?? ""}
          onValueChange={(v) => {
            if (v) set("defaultBranch", v);
          }}
        >
          <SelectTrigger id="gl-repo-default-branch" className="w-full">
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

      <div className="space-y-2">
        <p className="text-xs font-medium">Features</p>
        <p className="text-[11px] text-muted-foreground">
          “Members only” limits a feature to people with access to the project.
        </p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-3">
          {FEATURES.map(({ key, label }) => (
            <div key={key} className="space-y-1.5">
              <Label htmlFor={`gl-feature-${key}`} className="text-xs">
                {label}
              </Label>
              <Select
                items={ACCESS_LEVEL_ITEMS}
                value={form[key]}
                onValueChange={(v) => {
                  if (v) set(key, v);
                }}
              >
                <SelectTrigger id={`gl-feature-${key}`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ACCESS_LEVELS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-medium">Merge requests</p>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="gl-merge-method">Merge method</Label>
            <Select
              items={MERGE_METHOD_ITEMS}
              value={form.mergeMethod}
              onValueChange={(v) => {
                if (v) set("mergeMethod", v);
              }}
            >
              <SelectTrigger id="gl-merge-method" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MERGE_METHODS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="gl-squash-option">Squash commits</Label>
            <Select
              items={SQUASH_OPTION_ITEMS}
              value={form.squashOption}
              onValueChange={(v) => {
                if (v) set("squashOption", v);
              }}
            >
              <SelectTrigger id="gl-squash-option" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SQUASH_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="space-y-2 pt-1">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="gl-remove-source" className="text-xs">
              Delete source branch by default
            </Label>
            <Switch
              id="gl-remove-source"
              checked={form.removeSourceBranchAfterMerge}
              onCheckedChange={(v) => set("removeSourceBranchAfterMerge", v)}
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="gl-pipeline-succeeds" className="text-xs">
              Pipelines must succeed before merging
            </Label>
            <Switch
              id="gl-pipeline-succeeds"
              checked={form.onlyAllowMergeIfPipelineSucceeds}
              onCheckedChange={(v) =>
                set("onlyAllowMergeIfPipelineSucceeds", v)
              }
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="gl-discussions-resolved" className="text-xs">
              All threads must be resolved before merging
            </Label>
            <Switch
              id="gl-discussions-resolved"
              checked={form.onlyAllowMergeIfAllDiscussionsAreResolved}
              onCheckedChange={(v) =>
                set("onlyAllowMergeIfAllDiscussionsAreResolved", v)
              }
            />
          </div>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 border-t pt-3">
        <Button
          disabled={!dirty || update.isPending || descGen.generating}
          onClick={handleSave}
        >
          {update.isPending && <Spinner data-icon="inline-start" />}
          Save changes
        </Button>
      </div>
    </div>
  );
}
