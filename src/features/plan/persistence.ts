import { memoizedStoreLoader } from "@/lib/plugin-store";
import type { PlanRun } from "./store";

// Plans persist as a small JSON list (`<app_data>/plans.json`) — they're few and
// each is light (metadata + the latest plan markdown + parsed draft), so a
// whole-list store is plenty (unlike sessions' append-only transcripts). The
// conversation itself lives in the CLI's own session store on disk, so a reloaded
// plan can still be resumed (refine / follow-up) via its persisted session ids.

/** The durable shape of a plan run — the live streaming fields are dropped and
 *  reset on load (a reloaded run is never mid-turn). */
type PersistedPlan = Omit<PlanRun, "generating" | "status">;

const getStore = memoizedStoreLoader("plans.json");

function toPersisted(r: PlanRun): PersistedPlan {
  return {
    id: r.id,
    repoPath: r.repoPath,
    agent: r.agent,
    model: r.model,
    effort: r.effort,
    sessionId: r.sessionId,
    nativeSessionId: r.nativeSessionId,
    origin: r.origin,
    seed: r.seed,
    stopped: r.stopped,
    text: r.text,
    // Persist the interleaved transcript (tool steps + prose) so the activity log
    // survives a restart instead of falling back to the flat prose.
    segments: r.segments,
    draft: r.draft,
    costUsd: r.costUsd,
    implementedSessionId: r.implementedSessionId,
    error: r.error,
  };
}

/** Load persisted plans, idle (never mid-turn). Drops empty runs that were
 *  interrupted before producing anything. */
export async function loadPersistedPlans(): Promise<PlanRun[]> {
  const store = await getStore();
  const saved = (await store.get<PersistedPlan[]>("plans")) ?? [];
  return saved
    .filter((p) => p.draft || p.text.trim())
    .map((p) => ({ ...p, generating: false, status: "" }));
}

/** Write the whole plan list (transient streaming fields stripped). */
export async function savePersistedPlans(runs: PlanRun[]): Promise<void> {
  const store = await getStore();
  await store.set("plans", runs.map(toPersisted));
}
