import { CaretLeftIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  useCreateRuleset,
  useDeleteRuleset,
  useRuleset,
  useRulesets,
  useSetRulesetEnforcement,
  useUpdateRuleset,
} from "@/lib/git/queries";
import type { RulesetEnforcement, RulesetFull } from "@/lib/git/types";
import { toastError } from "@/lib/toast";
import { AsyncListBody, InlineConfirm } from "./parts";

const ENFORCEMENTS: { value: RulesetEnforcement; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "evaluate", label: "Evaluate" },
  { value: "disabled", label: "Disabled" },
];

/** Trigger labels for the enforcement selects — without them Base UI shows the
 *  raw value ("evaluate"). */
const ENFORCEMENT_ITEMS: Record<string, string> = Object.fromEntries(
  ENFORCEMENTS.map((e) => [e.value, e.label]),
);

/** Labels for the ref-scope select — trigger and popup both render from here. */
const REF_SCOPE_ITEMS: Record<string, string> = {
  default: "Default branch",
  all: "All branches",
  custom: "Custom patterns…",
};

/** Rule types we model in the editor. Any others on an edited ruleset are
 *  preserved untouched (so advanced rules aren't dropped). */
const MANAGED_RULE_TYPES = [
  "pull_request",
  "required_status_checks",
  "non_fast_forward",
  "deletion",
  "required_linear_history",
  "required_signatures",
];

interface Draft {
  name: string;
  enforcement: RulesetEnforcement;
  refScope: "default" | "all" | "custom";
  customPatterns: string;
  requirePr: boolean;
  approvals: number;
  dismissStale: boolean;
  codeOwner: boolean;
  lastPush: boolean;
  requireChecks: boolean;
  checkContexts: string;
  strictChecks: boolean;
  blockForcePush: boolean;
  restrictDeletions: boolean;
  linearHistory: boolean;
  requireSignatures: boolean;
}

const BLANK: Draft = {
  name: "",
  enforcement: "active",
  refScope: "default",
  customPatterns: "",
  requirePr: false,
  approvals: 1,
  dismissStale: false,
  codeOwner: false,
  lastPush: false,
  requireChecks: false,
  checkContexts: "",
  strictChecks: false,
  blockForcePush: false,
  restrictDeletions: false,
  linearHistory: false,
  requireSignatures: false,
};

const splitLines = (s: string) =>
  s
    .split(/[\n,]+/)
    .map((x) => x.trim())
    .filter(Boolean);

/** Check contexts split on newlines only: a context can carry a comma of its own,
 *  because GitHub Actions builds a matrix job's name by joining its values with
 *  ", ". Splitting there would save contexts no run will ever report. */
const splitCheckLines = (s: string) =>
  s
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);

function rulesetToDraft(rs: RulesetFull): Draft {
  const include = rs.conditions?.ref_name?.include ?? [];
  const refScope = include.includes("~DEFAULT_BRANCH")
    ? "default"
    : include.includes("~ALL")
      ? "all"
      : "custom";
  const byType = (t: string) => rs.rules?.find((r) => r.type === t);
  const pr = byType("pull_request")?.parameters ?? {};
  const checks = byType("required_status_checks")?.parameters ?? {};
  const contexts =
    (checks.required_status_checks as { context: string }[] | undefined) ?? [];
  return {
    name: rs.name ?? "",
    enforcement: (rs.enforcement as RulesetEnforcement) ?? "active",
    refScope,
    customPatterns:
      refScope === "custom"
        ? include.map((p) => p.replace(/^refs\/heads\//, "")).join("\n")
        : "",
    requirePr: !!byType("pull_request"),
    approvals: Number(pr.required_approving_review_count ?? 1),
    dismissStale: !!pr.dismiss_stale_reviews_on_push,
    codeOwner: !!pr.require_code_owner_review,
    lastPush: !!pr.require_last_push_approval,
    requireChecks: !!byType("required_status_checks"),
    checkContexts: contexts.map((c) => c.context).join("\n"),
    strictChecks: !!checks.strict_required_status_checks_policy,
    blockForcePush: !!byType("non_fast_forward"),
    restrictDeletions: !!byType("deletion"),
    linearHistory: !!byType("required_linear_history"),
    requireSignatures: !!byType("required_signatures"),
  };
}

/** The ref-name include list each scope sends: the two fixed scopes are
 *  GitHub's own tokens; "custom" qualifies bare patterns as branch refs. */
const REF_INCLUDES: Record<Draft["refScope"], (d: Draft) => string[]> = {
  default: () => ["~DEFAULT_BRANCH"],
  all: () => ["~ALL"],
  custom: (d) =>
    splitLines(d.customPatterns).map((p) =>
      p.startsWith("refs/") ? p : `refs/heads/${p}`,
    ),
};

/** The stored parameters of one rule on the ruleset being edited. A save is a full
 *  PUT replace, so every managed rule is rebuilt FROM these rather than from the
 *  draft alone — the draft models a subset of each rule's fields. */
const storedParameters = (original: RulesetFull | undefined, type: string) =>
  original?.rules?.find((r) => r.type === type)?.parameters;

function draftToBody(
  d: Draft,
  original?: RulesetFull,
): Record<string, unknown> {
  const include = REF_INCLUDES[d.refScope](d);
  const rules: Record<string, unknown>[] = [];
  if (d.requirePr) {
    rules.push({
      type: "pull_request",
      parameters: {
        // Seeds a new ruleset only: GitHub's schema demands the field and the
        // editor has no control for it, so a stored value must win the spread.
        required_review_thread_resolution: false,
        ...storedParameters(original, "pull_request"),
        required_approving_review_count: d.approvals,
        dismiss_stale_reviews_on_push: d.dismissStale,
        require_code_owner_review: d.codeOwner,
        require_last_push_approval: d.lastPush,
      },
    });
  }
  if (d.requireChecks) {
    const checks = storedParameters(original, "required_status_checks");
    // Kept lines consume their stored entries in order. An entry can pin the check
    // to one app (`integration_id`) and GitHub accepts several pins under a single
    // context, neither of which this editor displays, so a save must preserve every
    // entry rather than reduce a context to one. Fresh lines have no pin to keep.
    const storedList =
      (checks?.required_status_checks as { context: string }[] | undefined) ??
      [];
    const storedChecks = new Map<string, { context: string }[]>();
    for (const entry of storedList) {
      const queue = storedChecks.get(entry.context);
      if (queue) queue.push(entry);
      else storedChecks.set(entry.context, [entry]);
    }
    rules.push({
      type: "required_status_checks",
      parameters: {
        do_not_enforce_on_create: false,
        ...checks,
        strict_required_status_checks_policy: d.strictChecks,
        required_status_checks: splitCheckLines(d.checkContexts).map(
          (context) => storedChecks.get(context)?.shift() ?? { context },
        ),
      },
    });
  }
  if (d.blockForcePush) rules.push({ type: "non_fast_forward" });
  if (d.restrictDeletions) rules.push({ type: "deletion" });
  if (d.linearHistory) rules.push({ type: "required_linear_history" });
  if (d.requireSignatures) rules.push({ type: "required_signatures" });
  // Preserve rule types the editor doesn't model.
  const extra = (original?.rules ?? []).filter(
    (r) => !MANAGED_RULE_TYPES.includes(r.type),
  );
  return {
    name: d.name.trim(),
    // Target, ref excludes and any other condition are the ruleset's own state,
    // not the draft's: an edit rewrites what it models and resends the rest.
    target: original?.target ?? "branch",
    enforcement: d.enforcement,
    bypass_actors: original?.bypass_actors ?? [],
    conditions: {
      ...original?.conditions,
      ref_name: {
        include,
        exclude: original?.conditions?.ref_name?.exclude ?? [],
      },
    },
    rules: [...rules, ...extra],
  };
}

export function RulesetsSection({
  repoPath,
  open,
}: {
  repoPath: string;
  open: boolean;
}) {
  const [editing, setEditing] = useState<number | "new" | null>(null);

  if (editing !== null) {
    return (
      <RulesetEditor
        repoPath={repoPath}
        id={editing === "new" ? null : editing}
        onDone={() => setEditing(null)}
      />
    );
  }
  return (
    <RulesetList
      repoPath={repoPath}
      open={open}
      onNew={() => setEditing("new")}
      onEdit={setEditing}
    />
  );
}

function RulesetList({
  repoPath,
  open,
  onNew,
  onEdit,
}: {
  repoPath: string;
  open: boolean;
  onNew: () => void;
  onEdit: (id: number) => void;
}) {
  const rulesets = useRulesets(repoPath, open);
  const setEnforcement = useSetRulesetEnforcement(repoPath);
  const del = useDeleteRuleset(repoPath);
  const [confirming, setConfirming] = useState<number | null>(null);

  // Awaited, not per-call callbacks: react-query drops those when this subtree
  // unmounts mid-flight — closing the dialog or switching the rail's section —
  // so the outcome would never reach the user.
  async function handleDelete(id: number) {
    try {
      await del.mutateAsync(id);
      toast.success("Ruleset deleted");
      setConfirming(null);
    } catch (e) {
      toastError(e);
    }
  }

  async function handleEnforcement(
    id: number,
    enforcement: RulesetEnforcement,
  ) {
    try {
      await setEnforcement.mutateAsync({ id, enforcement });
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <div className="min-w-0 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Layered branch protection — the modern replacement for classic
          protection.
        </p>
        <Button size="sm" variant="outline" onClick={onNew}>
          <PlusIcon data-icon="inline-start" />
          New ruleset
        </Button>
      </div>

      <AsyncListBody
        loading={rulesets.isLoading}
        error={rulesets.error}
        empty={rulesets.data?.length === 0}
        emptyLabel="No rulesets yet."
        skeletonClassName="h-12 w-full"
        errorTitle="Couldn't load rulesets."
        errorHint="Managing rulesets needs repo-admin access."
      >
        {rulesets.data?.map((rs) => {
          const org = rs.sourceType === "Organization";
          return (
            <div
              key={rs.id}
              className="flex items-center gap-2 rounded-md border p-2.5 text-xs"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{rs.name}</p>
                <p className="text-[11px] text-muted-foreground">
                  {rs.target}
                  {org && " · from organization"}
                </p>
              </div>
              {org ? (
                <Badge variant="secondary" className="capitalize">
                  {rs.enforcement}
                </Badge>
              ) : confirming === rs.id ? (
                <InlineConfirm
                  prompt="Delete?"
                  actLabel="Delete"
                  pending={del.isPending}
                  onCancel={() => setConfirming(null)}
                  onAct={() => handleDelete(rs.id)}
                />
              ) : (
                <>
                  <Select
                    items={ENFORCEMENT_ITEMS}
                    value={rs.enforcement}
                    disabled={setEnforcement.isPending}
                    onValueChange={(v) =>
                      v && handleEnforcement(rs.id, v as RulesetEnforcement)
                    }
                  >
                    <SelectTrigger size="sm" className="w-28">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ENFORCEMENTS.map((e) => (
                        <SelectItem key={e.value} value={e.value}>
                          {e.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onEdit(rs.id)}
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground hover:text-destructive"
                    title="Delete"
                    onClick={() => setConfirming(rs.id)}
                  >
                    <TrashIcon />
                  </Button>
                </>
              )}
            </div>
          );
        })}
      </AsyncListBody>
    </div>
  );
}

function RulesetEditor({
  repoPath,
  id,
  onDone,
}: {
  repoPath: string;
  id: number | null;
  onDone: () => void;
}) {
  const existing = useRuleset(repoPath, id);
  if (id != null && existing.isLoading) {
    return <Skeleton className="h-64 w-full" />;
  }
  return (
    <RulesetForm
      repoPath={repoPath}
      id={id}
      original={id != null ? existing.data : undefined}
      onDone={onDone}
    />
  );
}

function RulesetForm({
  repoPath,
  id,
  original,
  onDone,
}: {
  repoPath: string;
  id: number | null;
  original?: RulesetFull;
  onDone: () => void;
}) {
  const create = useCreateRuleset(repoPath);
  const update = useUpdateRuleset(repoPath);
  const pending = create.isPending || update.isPending;
  const seed = useMemo(
    () => (original ? rulesetToDraft(original) : BLANK),
    [original],
  );
  const [d, setD] = useState<Draft>(seed);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setD((p) => ({ ...p, [key]: value }));

  async function save() {
    try {
      // Inside the try: building the body reads the stored ruleset's own shape, so
      // a malformed one must surface as a toast rather than a silent no-op.
      const body = draftToBody(d, original);
      if (id != null) await update.mutateAsync({ id, body });
      else await create.mutateAsync(body);
      toast.success(id != null ? "Ruleset updated" : "Ruleset created");
      onDone();
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <div className="min-w-0 space-y-4">
      <button
        type="button"
        onClick={onDone}
        className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <CaretLeftIcon />
        Back to rulesets
      </button>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="ruleset-name">Name</Label>
          <Input
            id="ruleset-name"
            value={d.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="e.g. Protect main"
            autoComplete="off"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ruleset-enforcement">Enforcement</Label>
          <Select
            items={ENFORCEMENT_ITEMS}
            value={d.enforcement}
            onValueChange={(v) =>
              v && set("enforcement", v as RulesetEnforcement)
            }
          >
            <SelectTrigger id="ruleset-enforcement" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ENFORCEMENTS.map((e) => (
                <SelectItem key={e.value} value={e.value}>
                  {e.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="ruleset-scope">Target branches</Label>
        <Select
          items={REF_SCOPE_ITEMS}
          value={d.refScope}
          onValueChange={(v) => v && set("refScope", v as Draft["refScope"])}
        >
          <SelectTrigger id="ruleset-scope" className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(REF_SCOPE_ITEMS).map(([scope, label]) => (
              <SelectItem key={scope} value={scope}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {d.refScope === "custom" && (
          <Textarea
            value={d.customPatterns}
            onChange={(e) => set("customPatterns", e.target.value)}
            placeholder={"main\nrelease/*  (one fnmatch pattern per line)"}
            rows={2}
            autoComplete="off"
            spellCheck={false}
          />
        )}
      </div>

      <div className="space-y-2">
        <Label>Rules</Label>

        <RuleToggle
          label="Require a pull request before merging"
          checked={d.requirePr}
          onChange={(v) => set("requirePr", v)}
        />
        {d.requirePr && (
          <div className="ml-6 space-y-2 border-l pl-3">
            <div className="flex items-center gap-2">
              <Label htmlFor="ruleset-approvals" className="text-xs">
                Required approvals
              </Label>
              <Input
                id="ruleset-approvals"
                type="number"
                min={0}
                max={10}
                value={d.approvals}
                onChange={(e) => set("approvals", Number(e.target.value))}
                className="h-7 w-16"
              />
            </div>
            <RuleToggle
              label="Dismiss stale approvals on new pushes"
              checked={d.dismissStale}
              onChange={(v) => set("dismissStale", v)}
            />
            <RuleToggle
              label="Require review from Code Owners"
              checked={d.codeOwner}
              onChange={(v) => set("codeOwner", v)}
            />
            <RuleToggle
              label="Require approval of the most recent push"
              checked={d.lastPush}
              onChange={(v) => set("lastPush", v)}
            />
          </div>
        )}

        <RuleToggle
          label="Require status checks to pass"
          checked={d.requireChecks}
          onChange={(v) => set("requireChecks", v)}
        />
        {d.requireChecks && (
          <div className="ml-6 space-y-2 border-l pl-3">
            <Textarea
              value={d.checkContexts}
              onChange={(e) => set("checkContexts", e.target.value)}
              placeholder="check names, one per line"
              rows={2}
              autoComplete="off"
              spellCheck={false}
            />
            <RuleToggle
              label="Require branches to be up to date before merging"
              checked={d.strictChecks}
              onChange={(v) => set("strictChecks", v)}
            />
          </div>
        )}

        <RuleToggle
          label="Block force pushes"
          checked={d.blockForcePush}
          onChange={(v) => set("blockForcePush", v)}
        />
        <RuleToggle
          label="Restrict deletions"
          checked={d.restrictDeletions}
          onChange={(v) => set("restrictDeletions", v)}
        />
        <RuleToggle
          label="Require linear history"
          checked={d.linearHistory}
          onChange={(v) => set("linearHistory", v)}
        />
        <RuleToggle
          label="Require signed commits"
          checked={d.requireSignatures}
          onChange={(v) => set("requireSignatures", v)}
        />
      </div>

      <div className="flex items-center justify-end gap-2 pt-1">
        <Button variant="outline" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
        <Button onClick={save} disabled={pending || !d.name.trim()}>
          {pending && <Spinner data-icon="inline-start" />}
          {id != null ? "Save ruleset" : "Create ruleset"}
        </Button>
      </div>
    </div>
  );
}

function RuleToggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 text-xs">
      <span>{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  );
}
