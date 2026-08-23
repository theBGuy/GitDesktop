import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useMemo, useState } from "react";
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
  useApplySecurity,
  useDeleteDependabot,
  useDependabotConfig,
  useRepoSettings,
  useSecurity,
  useSetDependabot,
} from "@/lib/git/queries";
import type { SecurityFeature, SecurityStatus } from "@/lib/git/types";
import { toastError } from "@/lib/toast";
import { AsyncErrorCard, InlineConfirm } from "./parts";

/** Dependabot / dependency-graph options GitHub exposes to NO repo-level API —
 *  they're web-UI-only. (Version updates is handled by the dependabot.yml
 *  scaffold below — a real action, not a link.) */
const WEB_ONLY_SECURITY = [
  "Dependency graph",
  "Grouped security updates",
  "Dependabot on self-hosted runners",
];

/** Common Dependabot package ecosystems for the version-updates scaffold. */
const ECOSYSTEMS = [
  { value: "npm", label: "npm / Yarn / pnpm" },
  { value: "github-actions", label: "GitHub Actions" },
  { value: "pip", label: "pip / Poetry" },
  { value: "cargo", label: "Cargo (Rust)" },
  { value: "gomod", label: "Go modules" },
  { value: "bundler", label: "Bundler (Ruby)" },
  { value: "composer", label: "Composer (PHP)" },
  { value: "maven", label: "Maven" },
  { value: "gradle", label: "Gradle" },
  { value: "nuget", label: "NuGet (.NET)" },
  { value: "docker", label: "Docker" },
];
const INTERVALS = ["daily", "weekly", "monthly"];

function generateDependabot(ecosystems: string[], interval: string): string {
  const entries = ecosystems
    .map(
      (e) =>
        `  - package-ecosystem: "${e}"\n    directory: "/"\n    schedule:\n      interval: "${interval}"`,
    )
    .join("\n");
  return `version: 2\nupdates:\n${entries}\n`;
}

/** The toggles, in dependency-safe APPLY order (parents before children) — the
 *  save sends changes in this order so a parent is enabled before its child. */
const FEATURES: {
  key: SecurityFeature;
  field: keyof SecurityStatus;
  label: string;
  desc: string;
  dependsOn?: SecurityFeature;
  privateOnly?: boolean;
}[] = [
  {
    key: "advanced_security",
    field: "advancedSecurity",
    label: "GitHub Advanced Security",
    desc: "Required for secret and code scanning on a private repo (uses a seat).",
    privateOnly: true,
  },
  {
    key: "secret_scanning",
    field: "secretScanning",
    label: "Secret scanning",
    desc: "Detect secrets pushed to the repository.",
  },
  {
    key: "secret_scanning_push_protection",
    field: "secretScanningPushProtection",
    label: "Push protection",
    desc: "Block pushes that contain a detected secret.",
    dependsOn: "secret_scanning",
  },
  {
    key: "secret_scanning_ai_detection",
    field: "secretScanningAiDetection",
    label: "Secret scanning — AI detection",
    desc: "Use AI to surface generic passwords and other non-pattern secrets.",
    dependsOn: "secret_scanning",
  },
  {
    key: "secret_scanning_non_provider_patterns",
    field: "secretScanningNonProviderPatterns",
    label: "Secret scanning — non-provider patterns",
    desc: "Scan for generic, non-provider-specific secret patterns.",
    dependsOn: "secret_scanning",
  },
  {
    key: "dependabot_alerts",
    field: "dependabotAlerts",
    label: "Dependabot alerts",
    desc: "Get alerted to vulnerable dependencies.",
  },
  {
    key: "dependabot_security_updates",
    field: "dependabotSecurityUpdates",
    label: "Dependabot security updates",
    desc: "Open pull requests to fix vulnerable dependencies.",
    dependsOn: "dependabot_alerts",
  },
  {
    key: "code_scanning",
    field: "codeScanning",
    label: "Code scanning (default setup)",
    desc: "Run CodeQL analysis on pushes and pull requests.",
  },
  {
    key: "private_vulnerability_reporting",
    field: "privateVulnerabilityReporting",
    label: "Private vulnerability reporting",
    desc: "Let people privately report security issues to you.",
  },
];

type Draft = Record<SecurityFeature, boolean>;

function toDraft(status: SecurityStatus): Draft {
  const d = {} as Draft;
  for (const f of FEATURES) d[f.key] = status[f.field] === true;
  return d;
}

export function SecuritySection({
  repoPath,
  open,
}: {
  repoPath: string;
  open: boolean;
}) {
  const security = useSecurity(repoPath, open);

  if (security.isPending) {
    return (
      <div className="min-w-0 space-y-3">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }
  if (security.isError || !security.data) {
    return (
      <AsyncErrorCard
        title="Couldn't load security."
        error={security.error}
        hint="These settings need repo-admin access."
      />
    );
  }

  // Remount on refetch so the draft reseeds after a save.
  return (
    <div className="min-w-0 space-y-4">
      <SecurityForm
        key={security.dataUpdatedAt}
        repoPath={repoPath}
        status={security.data}
      />
      <DependabotVersionUpdates repoPath={repoPath} open={open} />
      <MoreOnGitHub repoPath={repoPath} open={open} />
    </div>
  );
}

/** Dependabot version updates — no API, so we scaffold `.github/dependabot.yml`
 *  (a local file the user commits). We only create or remove it, never
 *  regenerate over an existing one, so a customized config isn't clobbered. */
function DependabotVersionUpdates({
  repoPath,
  open,
}: {
  repoPath: string;
  open: boolean;
}) {
  const config = useDependabotConfig(repoPath, open);
  const set = useSetDependabot(repoPath);
  const del = useDeleteDependabot(repoPath);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  // Awaited, not per-call callbacks: react-query drops those when this subtree
  // unmounts mid-flight — closing the dialog or switching the rail's section —
  // so the outcome would never reach the user.
  async function handleRemove() {
    try {
      await del.mutateAsync(undefined);
      toast.success("Removed .github/dependabot.yml — commit it");
      setConfirmingRemove(false);
    } catch (e) {
      toastError(e);
    }
  }

  async function handleCreate(content: string) {
    try {
      await set.mutateAsync(content);
      toast.success("Wrote .github/dependabot.yml — commit it to enable");
      setDialogOpen(false);
    } catch (e) {
      toastError(e);
    }
  }

  if (config.isPending) return null;
  const exists = config.data != null;

  return (
    <div className="border-t pt-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium">Dependabot version updates</p>
          <p className="text-[11px] text-muted-foreground">
            {exists
              ? "Configured in .github/dependabot.yml."
              : "Open scheduled PRs to keep dependencies current (writes .github/dependabot.yml)."}
          </p>
        </div>
        {exists ? (
          confirmingRemove ? (
            <div className="flex shrink-0 items-center gap-2">
              <InlineConfirm
                actLabel="Remove"
                pending={del.isPending}
                onCancel={() => setConfirmingRemove(false)}
                onAct={handleRemove}
              />
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() => setConfirmingRemove(true)}
            >
              Remove
            </Button>
          )
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => setDialogOpen(true)}
          >
            Set up…
          </Button>
        )}
      </div>
      <DependabotDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        pending={set.isPending}
        onCreate={handleCreate}
      />
    </div>
  );
}

function DependabotDialog({
  open,
  onOpenChange,
  pending,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  onCreate: (content: string) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [interval, setInterval] = useState("weekly");
  useEffect(() => {
    if (open) {
      setSelected(new Set());
      setInterval("weekly");
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set up version updates</DialogTitle>
          <DialogDescription>
            Pick the package ecosystems to keep up to date. This writes
            <span className="font-mono"> .github/dependabot.yml</span> to your
            working tree for you to commit.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2">
          {ECOSYSTEMS.map((e) => (
            <label
              key={e.value}
              className="flex cursor-pointer items-center gap-2 text-xs"
            >
              <Checkbox
                checked={selected.has(e.value)}
                onCheckedChange={(c) =>
                  setSelected((s) => {
                    const next = new Set(s);
                    if (c === true) next.add(e.value);
                    else next.delete(e.value);
                    return next;
                  })
                }
              />
              {e.label}
            </label>
          ))}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="dependabot-interval" className="text-xs">
            Check for updates
          </Label>
          <Select value={interval} onValueChange={(v) => v && setInterval(v)}>
            <SelectTrigger id="dependabot-interval" className="w-40">
              <SelectValue className="capitalize" />
            </SelectTrigger>
            <SelectContent>
              {INTERVALS.map((i) => (
                <SelectItem key={i} value={i} className="capitalize">
                  {i}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={selected.size === 0 || pending}
            onClick={() =>
              onCreate(generateDependabot([...selected], interval))
            }
          >
            {pending && <Spinner data-icon="inline-start" />}
            Create dependabot.yml
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The Dependabot / dependency-graph options with no API → "manage on GitHub". */
function MoreOnGitHub({ repoPath, open }: { repoPath: string; open: boolean }) {
  const settings = useRepoSettings(repoPath, open);
  const url = settings.data?.htmlUrl;
  if (!url) return null;
  return (
    <div className="space-y-2 border-t pt-3">
      <Label>Only on GitHub</Label>
      <p className="text-[11px] text-muted-foreground">
        GitHub exposes no API for these — manage them in your browser.
      </p>
      <ul className="space-y-1">
        {WEB_ONLY_SECURITY.map((label) => (
          <li key={label}>
            <button
              type="button"
              className="flex cursor-pointer items-center gap-1 text-left text-xs text-muted-foreground transition-colors hover:text-foreground hover:underline"
              onClick={() => openUrl(`${url}/settings/security_analysis`)}
            >
              {label}
              <ArrowSquareOutIcon className="size-3 shrink-0" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SecurityForm({
  repoPath,
  status,
}: {
  repoPath: string;
  status: SecurityStatus;
}) {
  const apply = useApplySecurity(repoPath);
  const seed = useMemo(() => toDraft(status), [status]);
  const [draft, setDraft] = useState(seed);

  const dirty = FEATURES.some((f) => draft[f.key] !== seed[f.key]);

  function set(key: SecurityFeature, value: boolean) {
    setDraft((d) => {
      const next = { ...d, [key]: value };
      // Turning a parent off turns its dependents off too.
      if (!value) {
        for (const f of FEATURES) if (f.dependsOn === key) next[f.key] = false;
      }
      return next;
    });
  }

  async function save() {
    const changes = FEATURES.filter((f) => draft[f.key] !== seed[f.key]).map(
      (f) => ({ feature: f.key, enabled: draft[f.key] }),
    );
    try {
      await apply.mutateAsync(changes);
      toast.success("Security settings saved");
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <div className="min-w-0 space-y-2">
      {FEATURES.map((f) => {
        if (f.privateOnly && !status.isPrivate) return null;
        const blocked = f.dependsOn ? !draft[f.dependsOn] : false;
        return (
          <label
            key={f.key}
            className={`flex items-start justify-between gap-3 rounded-md border p-3 ${
              blocked ? "opacity-60" : "cursor-pointer"
            }`}
          >
            <div className="min-w-0">
              <p className="text-xs font-medium">{f.label}</p>
              <p className="text-[11px] text-muted-foreground">{f.desc}</p>
            </div>
            <Switch
              checked={draft[f.key]}
              disabled={blocked || apply.isPending}
              onCheckedChange={(next) => set(f.key, next)}
            />
          </label>
        );
      })}

      {status.isPrivate && (
        <p className="pt-1 text-[11px] text-muted-foreground">
          On private repositories, secret and code scanning require GitHub
          Advanced Security (and may use paid seats). Dependabot alerts,
          security updates, and private vulnerability reporting are free.
        </p>
      )}

      {dirty && (
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setDraft(seed)}
            disabled={apply.isPending}
          >
            Discard
          </Button>
          <Button size="sm" onClick={save} disabled={apply.isPending}>
            {apply.isPending && <Spinner data-icon="inline-start" />}
            Save changes
          </Button>
        </div>
      )}
    </div>
  );
}
