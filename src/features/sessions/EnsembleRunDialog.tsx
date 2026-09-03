import { PlusIcon, WarningIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { AgentKind } from "@/lib/ai/agent";
import { formatUsd, type RunCostEstimate } from "@/lib/ai/cost";
import {
  AgentPicker,
  EffortPicker,
  imageMissingAgentText,
  ModelPicker,
} from "./AgentPickers";

/** One arm of a best-of-N run: which agent/model/effort attacks the task. */
export interface EnsembleArm {
  agent: AgentKind;
  model: string;
  effort: string;
}

// Best-of-N earns its (multiplied) cost only when the arms are genuinely
// different — same model N times mostly re-samples noise, while different
// providers/models attack a task from different angles. So the dialog defaults to
// two arms and invites you to vary them; 2 is the floor (it's an ensemble), 5 the
// ceiling (cost climbs linearly and review gets unwieldy past that).
const MIN_ARMS = 2;
const MAX_ARMS = 5;

/**
 * Sets up and confirms a best-of-N run: one editable arm per agent (its own
 * agent/model/effort), an upfront cost estimate that scales with the arm count,
 * and the explicit opt-in. This is the cost guardrail for the fan-out — multi-agent
 * runs are deliberate spend, never a default.
 */
export function EnsembleRunDialog({
  open,
  onOpenChange,
  seed,
  estimate,
  imageAgents,
  onRun,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Config the arms start from (the composer's current agent/model/effort). */
  seed: EnsembleArm;
  estimate: RunCostEstimate;
  /** Agent CLIs the saved image config bakes in — set ONLY when this run starts
   *  containerized AND settings resolved; `undefined` (worktree isolation, or an
   *  unknown config) means no arm can be judged, so none warns. */
  imageAgents?: readonly AgentKind[];
  onRun: (arms: EnsembleArm[]) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Run this task several ways</DialogTitle>
          <DialogDescription>
            Each arm runs the same task in its own worktree with its own
            agent/model — vary them to get genuinely different approaches, then
            keep the best. Every arm is billed separately.
          </DialogDescription>
        </DialogHeader>
        {/* Remount on open so the arms re-seed from the current composer config. */}
        {open && (
          <EnsembleArms
            seed={seed}
            estimate={estimate}
            imageAgents={imageAgents}
            onCancel={() => onOpenChange(false)}
            onRun={(arms) => {
              onOpenChange(false);
              onRun(arms);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function EnsembleArms({
  seed,
  estimate,
  imageAgents,
  onCancel,
  onRun,
}: {
  seed: EnsembleArm;
  estimate: RunCostEstimate;
  imageAgents?: readonly AgentKind[];
  onCancel: () => void;
  onRun: (arms: EnsembleArm[]) => void;
}) {
  // A stable per-row key so React reconciles add/remove correctly — an index key
  // would mis-associate the controlled pickers when a middle arm is removed. The
  // key is dialog-only; it's stripped before the arms are run.
  const [arms, setArms] = useState<(EnsembleArm & { key: string })[]>(() => [
    { ...seed, key: crypto.randomUUID() },
    { ...seed, key: crypto.randomUUID() },
  ]);

  const patchArm = (i: number, patch: Partial<EnsembleArm>) =>
    setArms((a) => a.map((arm, j) => (j === i ? { ...arm, ...patch } : arm)));
  const addArm = () =>
    setArms((a) =>
      a.length < MAX_ARMS
        ? [...a, { ...a[a.length - 1], key: crypto.randomUUID() }]
        : a,
    );
  const removeArm = (i: number) =>
    setArms((a) => (a.length > MIN_ARMS ? a.filter((_, j) => j !== i) : a));

  const { perSession, sampleSize } = estimate;
  const total = perSession != null ? perSession * arms.length : null;
  const usesCopilot = arms.some((a) => a.agent === "copilot");

  // Warn per arm, never block: a stale image can legitimately carry MORE agents
  // than the saved config lists, and the backend rejects turn 1 anyway.
  const missingFromImage = (agent: AgentKind) =>
    imageAgents !== undefined && !imageAgents.includes(agent);
  const missingSummary = arms
    .map((arm, i) =>
      missingFromImage(arm.agent)
        ? `Arm ${i + 1}: ${imageMissingAgentText(arm.agent)}`
        : "",
    )
    .filter(Boolean)
    .join(" ");
  // Content already present when a live region enters the a11y tree is never
  // announced, and this dialog remounts on every open — so the region mounts empty
  // and takes its text from an effect. The visible lines stay render-derived.
  const [announced, setAnnounced] = useState("");
  useEffect(() => {
    setAnnounced(missingSummary);
  }, [missingSummary]);

  return (
    <>
      <p role="status" aria-live="polite" className="sr-only">
        {announced}
      </p>
      <div className="space-y-1.5">
        {arms.map((arm, i) => (
          <div
            key={arm.key}
            className="flex flex-wrap items-center gap-1.5 border bg-muted/30 px-2 py-1.5"
          >
            <span className="w-4 shrink-0 text-center text-[11px] text-muted-foreground tabular-nums">
              {i + 1}
            </span>
            <AgentPicker
              value={arm.agent}
              onChange={(agent) => patchArm(i, { agent, model: "" })}
            />
            <ModelPicker
              value={arm.model}
              onChange={(model) => patchArm(i, { model })}
              agent={arm.agent}
            />
            <EffortPicker
              value={arm.effort}
              onChange={(effort) => patchArm(i, { effort })}
            />
            <Button
              size="icon-xs"
              variant="ghost"
              className="ml-auto text-muted-foreground"
              disabled={arms.length <= MIN_ARMS}
              onClick={() => removeArm(i)}
              aria-label={`Remove arm ${i + 1}`}
            >
              <XIcon />
            </Button>
            {missingFromImage(arm.agent) && (
              // `basis-full` wraps the line under the row's controls; the text
              // carries the meaning, the token only tones it.
              <p className="flex basis-full items-center gap-1.5 text-[11px] text-warning">
                <WarningIcon
                  weight="fill"
                  className="size-3.5 shrink-0"
                  aria-hidden
                />
                {imageMissingAgentText(arm.agent)}
              </p>
            )}
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={arms.length >= MAX_ARMS}
          onClick={addArm}
        >
          <PlusIcon data-icon="inline-start" />
          Add arm
        </Button>
        <p className="min-w-0 text-right text-[11px] text-muted-foreground">
          {total != null ? (
            <>
              Estimated{" "}
              <span className="tabular-nums text-foreground">
                ~{formatUsd(total)}
              </span>{" "}
              · {arms.length} × {formatUsd(perSession ?? 0)} avg of your last{" "}
              {sampleSize}
            </>
          ) : (
            <>{arms.length} agents, each billed separately</>
          )}
          {usesCopilot && " · Copilot arms are premium requests"}
        </p>
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          onClick={() =>
            onRun(
              arms.map((a) => ({
                agent: a.agent,
                model: a.model,
                effort: a.effort,
              })),
            )
          }
        >
          Run {arms.length} agents
        </Button>
      </DialogFooter>
    </>
  );
}
