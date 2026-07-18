import {
  CaretDownIcon,
  CaretRightIcon,
  PlusIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { useId, useState } from "react";
import { Badge } from "@/components/ui/badge";
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
import {
  ACTION_LABELS,
  type ActionId,
  type BranchConditions,
  branchConditionsPass,
  LIFECYCLE_LABELS,
  type LifecycleEvent,
} from "@/lib/automations/types";
import { matchesGlob } from "@/lib/branch-rules/match";

const ACTION_IDS = Object.keys(ACTION_LABELS) as ActionId[];
const LIFECYCLE_ORDER: LifecycleEvent[] = ["commit", "pr-open", "pr-sync"];

const LIFECYCLE_HELP: Record<LifecycleEvent, string> = {
  commit: "Runs after you commit on a branch that meets the conditions.",
  "pr-open": "Runs once when a pull request is opened.",
  "pr-sync":
    "Re-reviews a pull request when new commits arrive — only PRs already reviewed in that mode.",
};

const MATCH_LABELS: Record<BranchConditions["match"], string> = {
  head: "Source branch",
  base: "Target branch",
  either: "Either branch",
};

/**
 * The resolved state of one action within one lifecycle, as shown in the grid.
 * `overridden` drives the repo dialog's "overridden" badge; it's always false on
 * the global surface.
 */
export interface CellState {
  enabled: boolean;
  conditions?: BranchConditions;
  overridden: boolean;
}

/** How the editor reports an edit back to its host (global draft or repo override). */
export interface CellPatch {
  enabled?: boolean;
  conditions?: BranchConditions;
}

const EMPTY_CONDITIONS: BranchConditions = {
  include: [],
  exclude: [],
  match: "head",
};

/** A conditions object with at least one non-blank include/exclude pattern.
 *  Blank rows (a not-yet-typed input) don't count — they carry no meaning and
 *  are stripped before persisting. */
export function hasConditions(c: BranchConditions | undefined): boolean {
  if (!c) return false;
  return [...c.include, ...c.exclude].some((p) => p.trim() !== "");
}

/** A copy of the conditions with blank/whitespace-only pattern rows removed, so
 *  the UI never persists an empty include/exclude entry. `undefined` stays
 *  `undefined` (inherit). */
export function sanitizeConditions(
  c: BranchConditions | undefined,
): BranchConditions | undefined {
  if (!c) return undefined;
  return {
    include: c.include.filter((p) => p.trim() !== ""),
    exclude: c.exclude.filter((p) => p.trim() !== ""),
    match: c.match,
  };
}

/** A short muted line for a collapsed conditions editor (e.g. "only release/**, except wip/*").
 *  Only non-blank patterns contribute. */
function conditionsSummary(c: BranchConditions | undefined): string | null {
  if (!hasConditions(c)) return null;
  const include = (c?.include ?? []).filter((p) => p.trim() !== "");
  const exclude = (c?.exclude ?? []).filter((p) => p.trim() !== "");
  const parts: string[] = [];
  if (include.length) parts.push(`only ${include.join(", ")}`);
  if (exclude.length) parts.push(`except ${exclude.join(", ")}`);
  return parts.join(", ");
}

/** Whether the lifecycle's conditions apply to head/base branches (PR events only). */
function usesMatch(lifecycle: LifecycleEvent): boolean {
  return lifecycle === "pr-open" || lifecycle === "pr-sync";
}

function ConditionsEditor({
  lifecycle,
  conditions,
  onChange,
}: {
  lifecycle: LifecycleEvent;
  conditions: BranchConditions | undefined;
  onChange: (next: BranchConditions) => void;
}) {
  const [open, setOpen] = useState(false);
  const [testBranch, setTestBranch] = useState("");
  const c = conditions ?? EMPTY_CONDITIONS;
  const summary = conditionsSummary(conditions);
  const includeLabelId = useId();
  const excludeLabelId = useId();
  const matchSelectId = useId();
  const testBranchId = useId();

  function patchList(key: "include" | "exclude", next: string[]) {
    onChange({ ...c, [key]: next });
  }

  function renderPatternRows(key: "include" | "exclude", placeholder: string) {
    const list = c[key];
    return (
      <div className="space-y-1.5">
        {list.map((pattern, i) => (
          // Patterns have no stable id; index keys are correct for this
          // append/remove list edited in place (mirrors BranchRulesDialog).
          <div key={i} className="flex items-center gap-2">
            <Input
              value={pattern}
              onChange={(e) =>
                patchList(
                  key,
                  list.map((p, j) => (j === i ? e.target.value : p)),
                )
              }
              placeholder={placeholder}
              className="font-mono"
            />
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Remove pattern"
              onClick={() =>
                patchList(
                  key,
                  list.filter((_, j) => j !== i),
                )
              }
            >
              <TrashIcon />
            </Button>
          </div>
        ))}
        <Button
          variant="outline"
          size="xs"
          onClick={() => patchList(key, [...list, ""])}
        >
          <PlusIcon data-icon="inline-start" />
          Add pattern
        </Button>
      </div>
    );
  }

  // Empty test → no verdict; otherwise use the runner's own predicate so the
  // verdict can never diverge from what actually runs. Name the winning exclude
  // glob when one is responsible.
  const trimmedTest = testBranch.trim();
  const branchEvent =
    lifecycle === "commit"
      ? { kind: lifecycle, branch: trimmedTest }
      : { kind: lifecycle, head: trimmedTest, base: trimmedTest };
  const runs = branchConditionsPass(c, branchEvent);
  const blockingExclude = c.exclude.find(
    (p) => p.trim() !== "" && matchesGlob(p.trim(), trimmedTest),
  );

  return (
    <div className="pl-6">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex cursor-pointer items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        {open ? (
          <CaretDownIcon className="size-3" />
        ) : (
          <CaretRightIcon className="size-3" />
        )}
        Conditions
        {!open && summary && (
          <span className="text-muted-foreground/80">— {summary}</span>
        )}
      </button>

      {open && (
        <div className="mt-2 space-y-3">
          <div
            className="space-y-1"
            role="group"
            aria-labelledby={includeLabelId}
          >
            <Label id={includeLabelId} className="text-xs">
              Only these branches (optional)
            </Label>
            {renderPatternRows("include", "release/**")}
          </div>
          <div
            className="space-y-1"
            role="group"
            aria-labelledby={excludeLabelId}
          >
            <Label id={excludeLabelId} className="text-xs">
              Except these branches
            </Label>
            {renderPatternRows("exclude", "wip/*")}
          </div>
          {usesMatch(lifecycle) && (
            <div className="space-y-1">
              <Label htmlFor={matchSelectId} className="text-xs">
                Match against
              </Label>
              <Select
                items={MATCH_LABELS}
                value={c.match}
                onValueChange={(v) =>
                  v && onChange({ ...c, match: v as BranchConditions["match"] })
                }
              >
                <SelectTrigger id={matchSelectId} className="w-full" size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(
                    Object.keys(MATCH_LABELS) as BranchConditions["match"][]
                  ).map((m) => (
                    <SelectItem key={m} value={m}>
                      {MATCH_LABELS[m]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1">
            <Label htmlFor={testBranchId} className="text-xs">
              Try a branch
            </Label>
            <div className="flex items-center gap-2">
              <Input
                id={testBranchId}
                value={testBranch}
                onChange={(e) => setTestBranch(e.target.value)}
                placeholder="feature/login"
                className="font-mono"
              />
              {trimmedTest !== "" && (
                <span
                  className={
                    runs
                      ? "shrink-0 text-xs text-success"
                      : "shrink-0 text-xs text-destructive"
                  }
                >
                  {runs ? (
                    "runs"
                  ) : blockingExclude ? (
                    <>
                      skipped — excluded by{" "}
                      <span className="font-mono">{blockingExclude}</span>
                    </>
                  ) : (
                    "skipped — no include matches"
                  )}
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ActionRow({
  lifecycle,
  action,
  cell,
  onPatch,
}: {
  lifecycle: LifecycleEvent;
  action: ActionId;
  cell: CellState;
  onPatch: (patch: CellPatch) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <label className="flex cursor-pointer items-center gap-2 text-xs">
          <Checkbox
            checked={cell.enabled}
            onCheckedChange={(checked) =>
              onPatch({ enabled: checked === true })
            }
          />
          {ACTION_LABELS[action]}
        </label>
        {cell.overridden && (
          <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
            Overridden
          </Badge>
        )}
      </div>
      {cell.enabled && (
        <ConditionsEditor
          lifecycle={lifecycle}
          conditions={cell.conditions}
          onChange={(conditions) => onPatch({ conditions })}
        />
      )}
    </div>
  );
}

/**
 * The lifecycle-grouped automations grid, shared by the global Settings panel
 * and the per-repo dialog. The host owns the data model (global draft vs repo
 * override) and supplies each cell's resolved state plus a patch handler; this
 * component is purely presentational over that.
 */
export function LifecycleEditor({
  cellState,
  onCellPatch,
}: {
  cellState: (lifecycle: LifecycleEvent, action: ActionId) => CellState;
  onCellPatch: (
    lifecycle: LifecycleEvent,
    action: ActionId,
    patch: CellPatch,
  ) => void;
}) {
  return (
    <div className="space-y-3">
      {LIFECYCLE_ORDER.map((lifecycle) => (
        <div key={lifecycle} className="space-y-2.5 rounded-md border p-2.5">
          <div>
            <h3 className="text-xs font-medium">
              {LIFECYCLE_LABELS[lifecycle]}
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {LIFECYCLE_HELP[lifecycle]}
            </p>
          </div>
          <div className="space-y-3">
            {ACTION_IDS.map((action) => (
              <ActionRow
                key={action}
                lifecycle={lifecycle}
                action={action}
                cell={cellState(lifecycle, action)}
                onPatch={(patch) => onCellPatch(lifecycle, action, patch)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
