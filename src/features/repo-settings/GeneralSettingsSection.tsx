import { ArrowSquareOutIcon, SparkleIcon } from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useState } from "react";
import { toast } from "sonner";
import { SelectClipText } from "@/components/select-clip-text";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Switch } from "@/components/ui/switch";
import { clipTitleFromText } from "@/lib/clip-title";
import { useActiveGhHost } from "@/lib/git/host";
import {
  useBranches,
  useGhScopes,
  useRepoSettings,
  useUpdateRepoSettings,
} from "@/lib/git/queries";
import type { Branch, RepoSettings, RepoSettingsInput } from "@/lib/git/types";
import { usePublishGenerateAction } from "@/lib/hotkeys/useGenerateChord";
import { useAiConfigured, useAiEnabled } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";
import { DescriptionField } from "./DescriptionField";
import { AsyncErrorCard } from "./parts";
import { GITHUB_TOPIC_RULES, TopicsField } from "./TopicsField";
import { useGenerateRepoDescription } from "./useGenerateRepoDescription";

export function GeneralSettingsSection({
  repoPath,
  open,
}: {
  repoPath: string;
  open: boolean;
}) {
  const settings = useRepoSettings(repoPath, open);
  const branches = useBranches(repoPath);

  if (settings.isPending) {
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
      <AsyncErrorCard title="Couldn't load settings." error={settings.error} />
    );
  }

  return (
    <GeneralForm
      repoPath={repoPath}
      settings={settings.data}
      branches={branches.data ?? []}
    />
  );
}

function toInput(s: RepoSettings): RepoSettingsInput {
  return {
    description: s.description ?? "",
    homepage: s.homepage ?? "",
    topics: s.topics,
    defaultBranch: s.defaultBranch,
    hasIssues: s.hasIssues,
    hasProjects: s.hasProjects,
    hasWiki: s.hasWiki,
    hasDiscussions: s.hasDiscussions,
    allowSquashMerge: s.allowSquashMerge,
    allowMergeCommit: s.allowMergeCommit,
    allowRebaseMerge: s.allowRebaseMerge,
    allowUpdateBranch: s.allowUpdateBranch,
    deleteBranchOnMerge: s.deleteBranchOnMerge,
    allowAutoMerge: s.allowAutoMerge,
    webCommitSignoffRequired: s.webCommitSignoffRequired,
    isTemplate: s.isTemplate,
    // null = don't send allow_forking (only mutable on org-owned private repos).
    allowForking: s.canChangeForking ? s.allowForking : null,
    squashMergeCommitTitle: s.squashMergeCommitTitle,
    squashMergeCommitMessage: s.squashMergeCommitMessage,
    mergeCommitTitle: s.mergeCommitTitle,
    mergeCommitMessage: s.mergeCommitMessage,
  };
}

/** Valid squash/merge title+message pairs (GitHub 422s an invalid combo). Each
 *  encodes its `title/message` enum pair; the UI offers them as one choice. */
const SQUASH_DEFAULTS = [
  {
    value: "COMMIT_OR_PR_TITLE/COMMIT_MESSAGES",
    label: "Default (commit messages)",
  },
  { value: "PR_TITLE/PR_BODY", label: "Pull request title and description" },
  { value: "PR_TITLE/BLANK", label: "Pull request title" },
] as const;
const MERGE_DEFAULTS = [
  { value: "MERGE_MESSAGE/PR_TITLE", label: "Default merge message" },
  { value: "PR_TITLE/PR_BODY", label: "Pull request title and description" },
  { value: "PR_TITLE/BLANK", label: "Pull request title" },
] as const;

/** Repo settings that have NO GitHub API — only manageable in the browser.
 *  (The Sponsor button is editable in the Sponsor tab — it's `.github/FUNDING.yml`.) */
const WEB_ONLY_SETTINGS = [
  "Allow commenting on individual commits",
  "Include Git LFS objects in archives",
  "Limit branches and tags updated in a single push",
  "Auto-close issues with merged linked pull requests",
];

/** A muted readout of the gh token's OAuth scopes — context for what governance
 *  actions are available. Hidden for fine-grained/App tokens (no classic scopes). */
function GhScopesNote() {
  const scopes = useGhScopes(useActiveGhHost());
  if (!scopes.data?.classic || scopes.data.scopes.length === 0) return null;
  return (
    <p className="text-[11px] text-muted-foreground">
      Your GitHub sign-in grants:{" "}
      <span className="font-mono">{scopes.data.scopes.join(", ")}</span>
    </p>
  );
}

/** A single dropdown for a default commit title+message pair. Keeps the current
 *  (possibly non-standard) value selectable so the picker never shows blank. */
function CommitMessageSelect({
  id,
  label,
  disabled,
  options,
  title,
  message,
  onChange,
}: {
  id: string;
  label: string;
  disabled: boolean;
  options: readonly { value: string; label: string }[];
  title: string;
  message: string;
  onChange: (title: string, message: string) => void;
}) {
  const value = `${title}/${message}`;
  const opts = options.some((o) => o.value === value)
    ? options
    : [{ value, label: `${title} / ${message}` }, ...options];
  // Trigger labels, built per render because `opts` carries the synthesized
  // current pair — without them Base UI shows the raw "title/message" value.
  const items = Object.fromEntries(opts.map((o) => [o.value, o.label]));
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className={disabled ? "text-muted-foreground" : ""}>
        {label}
      </Label>
      <Select
        items={items}
        value={value}
        disabled={disabled}
        onValueChange={(v) => {
          if (!v) return;
          const [t, m] = v.split("/");
          onChange(t, m);
        }}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue onMouseEnter={clipTitleFromText} />
        </SelectTrigger>
        <SelectContent className="max-w-[min(22rem,80vw)]">
          {opts.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              <SelectClipText>{o.label}</SelectClipText>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** Normalize a list of raw topic strings per GitHub's rules (slugified,
 *  deduped, capped 20) — used when the AI Generate result seeds topics. */
function normalizeTopics(raw: string[]): string[] {
  const seen = new Set<string>();
  for (const t of raw) {
    const topic = GITHUB_TOPIC_RULES.normalize(t);
    if (topic) seen.add(topic);
  }
  // `maxTopics` is optional on `TopicRules`, so the `?? 20` satisfies the type;
  // the GitHub preset always sets 20, so the fallback never fires at runtime.
  return [...seen].slice(0, GITHUB_TOPIC_RULES.maxTopics ?? 20);
}

function GeneralForm({
  repoPath,
  settings,
  branches,
}: {
  repoPath: string;
  settings: RepoSettings;
  branches: Branch[];
}) {
  const update = useUpdateRepoSettings(repoPath);
  const base = toInput(settings);
  const [form, setForm] = useState<RepoSettingsInput>(base);

  const aiEnabled = useAiEnabled();
  const aiConfigured = useAiConfigured();
  const openSettings = useUiStore((s) => s.openSettings);
  const repoName =
    useUiStore((s) => s.repoName) ?? repoPath.split(/[/\\]/).pop() ?? repoPath;
  const descGen = useGenerateRepoDescription(repoPath);

  function set<K extends keyof RepoSettingsInput>(
    key: K,
    value: RepoSettingsInput[K],
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
        if (topics.length) set("topics", normalizeTopics(topics));
      },
    });
  }
  const { hint: generateHint } = usePublishGenerateAction(
    aiEnabled && aiConfigured && !descGen.generating,
    runGenerate,
  );

  const mergeValid =
    form.allowSquashMerge || form.allowMergeCommit || form.allowRebaseMerge;
  const dirty = JSON.stringify(form) !== JSON.stringify(base);

  // Keep the current default selectable even if that branch isn't local; drop
  // agent-session branches (`gd/session/*`) — they're app-internal.
  const branchNames = branches
    .map((b) => b.name)
    .filter((n) => !n.startsWith("gd/session/"));
  const branchOptions = branchNames.includes(form.defaultBranch)
    ? branchNames
    : [form.defaultBranch, ...branchNames];

  // Awaited, not per-call callbacks: react-query drops those when this subtree
  // unmounts mid-flight — closing the dialog or switching the rail's section —
  // so the outcome would never reach the user.
  async function handleSave() {
    try {
      await update.mutateAsync(form);
      toast.success("Repository settings saved");
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <div className="min-w-0 space-y-4">
      <DescriptionField
        id="repo-description"
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
          <Label htmlFor="repo-topics">Topics</Label>
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {form.topics.length} / 20
          </span>
        </div>
        <TopicsField
          id="repo-topics"
          topics={form.topics}
          onChange={(next) => set("topics", next)}
          rules={GITHUB_TOPIC_RULES}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="repo-homepage">Homepage URL</Label>
          <Input
            id="repo-homepage"
            value={form.homepage}
            onChange={(e) => set("homepage", e.target.value)}
            placeholder="https://…"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="repo-default-branch">Default branch</Label>
          <Select
            value={form.defaultBranch}
            onValueChange={(v) => {
              if (v) set("defaultBranch", v);
            }}
          >
            <SelectTrigger id="repo-default-branch" className="w-full">
              <SelectValue onMouseEnter={clipTitleFromText} />
            </SelectTrigger>
            <SelectContent className="max-w-[min(20rem,80vw)]">
              {branchOptions.map((b) => (
                <SelectItem key={b} value={b}>
                  <SelectClipText>{b}</SelectClipText>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-2">
        <Label>Features</Label>
        <div className="grid grid-cols-2 gap-2">
          <label className="flex cursor-pointer items-center gap-2 text-xs">
            <Checkbox
              checked={form.hasIssues}
              onCheckedChange={(c) => set("hasIssues", c === true)}
            />
            Issues
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-xs">
            <Checkbox
              checked={form.hasProjects}
              onCheckedChange={(c) => set("hasProjects", c === true)}
            />
            Projects
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-xs">
            <Checkbox
              checked={form.hasWiki}
              onCheckedChange={(c) => set("hasWiki", c === true)}
            />
            Wiki
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-xs">
            <Checkbox
              checked={form.hasDiscussions}
              onCheckedChange={(c) => set("hasDiscussions", c === true)}
            />
            Discussions
          </label>
        </div>
      </div>

      <div className="space-y-2">
        <Label>Pull request merges</Label>
        <div className="grid grid-cols-3 gap-2">
          <label className="flex cursor-pointer items-center gap-2 text-xs">
            <Checkbox
              checked={form.allowMergeCommit}
              onCheckedChange={(c) => set("allowMergeCommit", c === true)}
            />
            Merge commits
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-xs">
            <Checkbox
              checked={form.allowSquashMerge}
              onCheckedChange={(c) => set("allowSquashMerge", c === true)}
            />
            Squash merging
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-xs">
            <Checkbox
              checked={form.allowRebaseMerge}
              onCheckedChange={(c) => set("allowRebaseMerge", c === true)}
            />
            Rebase merging
          </label>
        </div>
        <div className="grid grid-cols-2 gap-4 pt-1">
          <CommitMessageSelect
            id="squash-default"
            label="Squash merge message"
            disabled={!form.allowSquashMerge}
            options={SQUASH_DEFAULTS}
            title={form.squashMergeCommitTitle}
            message={form.squashMergeCommitMessage}
            onChange={(t, m) =>
              setForm((f) => ({
                ...f,
                squashMergeCommitTitle: t,
                squashMergeCommitMessage: m,
              }))
            }
          />
          <CommitMessageSelect
            id="merge-default"
            label="Merge commit message"
            disabled={!form.allowMergeCommit}
            options={MERGE_DEFAULTS}
            title={form.mergeCommitTitle}
            message={form.mergeCommitMessage}
            onChange={(t, m) =>
              setForm((f) => ({
                ...f,
                mergeCommitTitle: t,
                mergeCommitMessage: m,
              }))
            }
          />
        </div>
        <label className="flex cursor-pointer items-center gap-2 pt-1 text-xs">
          <Switch
            checked={form.allowUpdateBranch}
            onCheckedChange={(c) => set("allowUpdateBranch", c)}
          />
          Always suggest updating pull request branches
        </label>
        <label className="flex cursor-pointer items-center gap-2 text-xs">
          <Switch
            checked={form.allowAutoMerge}
            onCheckedChange={(c) => set("allowAutoMerge", c)}
          />
          Allow auto-merge
        </label>
        <label className="flex cursor-pointer items-center gap-2 text-xs">
          <Switch
            checked={form.deleteBranchOnMerge}
            onCheckedChange={(c) => set("deleteBranchOnMerge", c)}
          />
          Automatically delete head branches after merge
        </label>
      </div>

      <div className="space-y-2">
        <Label>Commits</Label>
        <label className="flex cursor-pointer items-center gap-2 text-xs">
          <Switch
            checked={form.webCommitSignoffRequired}
            onCheckedChange={(c) => set("webCommitSignoffRequired", c)}
          />
          Require contributors to sign off on web-based commits
        </label>
      </div>

      <div className="space-y-2">
        <Label>Repository</Label>
        <label className="flex cursor-pointer items-center gap-2 text-xs">
          <Switch
            checked={form.isTemplate}
            onCheckedChange={(c) => set("isTemplate", c)}
          />
          Template repository
        </label>
        {/* GitHub only allows changing this on org-owned private repos. */}
        {settings.canChangeForking && (
          <label className="flex cursor-pointer items-center gap-2 text-xs">
            <Switch
              checked={form.allowForking ?? false}
              onCheckedChange={(c) => set("allowForking", c)}
            />
            Allow forking
          </label>
        )}
      </div>

      {settings.htmlUrl && (
        <div className="space-y-2">
          <Label>Only on GitHub</Label>
          <p className="text-xs text-muted-foreground">
            GitHub doesn't expose these to apps — manage them in your browser.
          </p>
          <ul className="space-y-1">
            {WEB_ONLY_SETTINGS.map((label) => (
              <li key={label}>
                <button
                  type="button"
                  className="flex cursor-pointer items-center gap-1 text-left text-xs text-muted-foreground transition-colors hover:text-foreground hover:underline"
                  onClick={() => openUrl(`${settings.htmlUrl}/settings`)}
                >
                  {label}
                  <ArrowSquareOutIcon className="size-3 shrink-0" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <GhScopesNote />

      <div className="flex items-center justify-end gap-3 pt-2">
        {!mergeValid && (
          <span className="mr-auto text-xs text-destructive">
            Enable at least one merge method.
          </span>
        )}
        <Button
          disabled={
            !dirty || !mergeValid || update.isPending || descGen.generating
          }
          onClick={handleSave}
        >
          {update.isPending && <Spinner data-icon="inline-start" />}
          Save changes
        </Button>
      </div>
    </div>
  );
}
