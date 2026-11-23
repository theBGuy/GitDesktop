/**
 * The one wording for each phase of a research run's "Turn into a Plan" distill,
 * shared by the research canvas and the sidebar row so the two can't drift.
 * Every stopping-phase line but the canvas button's label holds whether or not
 * Plan opens (the sidebar shows mostly while the user is elsewhere).
 */
import type { DistillPhase } from "./store";

export const PLAN_BUTTON_LABEL: Record<DistillPhase, string> = {
  idle: "Turn into a Plan",
  distilling: "Distilling…",
  stopping: "Opening Plan…",
};

export const PLAN_BUTTON_REASON: Partial<Record<DistillPhase, string>> = {
  distilling: "Writing the plan brief from this research",
  stopping: "Plan gets the full report once the brief stops",
};

export const STOP_SLOT_LABEL: Record<DistillPhase, string> = {
  idle: "Stop",
  distilling: "Stop",
  stopping: "Stopping…",
};

export const STOP_SLOT_REASON: Partial<Record<DistillPhase, string>> = {
  stopping: "Stopping the plan brief; Plan gets the full report",
};

export const MENU_PLAN_LABEL: Record<DistillPhase, string> = {
  idle: "Turn into a Plan",
  distilling: "Distilling…",
  stopping: "Sending Plan the full report…",
};

/** `idle` is the row shown while a research turn generates. */
export const MENU_STOP_LABEL: Record<DistillPhase, string> = {
  idle: "Stop",
  distilling: "Stop",
  stopping: "Stopping… (Plan gets the full report)",
};

export const DISTILL_ROW_LABEL: Record<
  Exclude<DistillPhase, "idle">,
  string
> = {
  distilling: "Distilling plan brief…",
  stopping: "Stopping plan brief…",
};

/** Why the follow-up Send is held. */
export type SendHold = "generating" | Exclude<DistillPhase, "idle">;

/** `generating` rarely renders (the composer shows only beside a finished
 *  report) and stays for totality over `SendHold`. */
export const SEND_HOLD_REASON: Record<SendHold, string> = {
  generating: "Wait for this turn to finish",
  distilling: "Wait for the plan brief to finish",
  stopping: "Wait for the plan brief to stop",
};
