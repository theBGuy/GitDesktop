import { memoizedStoreLoader } from "@/lib/plugin-store";
import type { ResearchRun } from "./store";

// Research runs persist as a small JSON list (`<app_data>/research.json`),
// exactly like plans (see features/plan/persistence.ts): few, each light
// (metadata + the latest report markdown), so a whole-list store is plenty. The
// conversation itself lives in the CLI's own session store on disk, so a reloaded
// run can still be resumed (follow-up) via its persisted session ids.

/** The durable shape of a research run — live streaming fields dropped on load
 *  (a reloaded run is never mid-turn, and a reload must never resurrect a stuck
 *  `distilling` flag — excluding it here makes that type-enforced). */
type PersistedResearch = Omit<
  ResearchRun,
  "generating" | "status" | "distilling"
>;

const getStore = memoizedStoreLoader("research.json");

function toPersisted(r: ResearchRun): PersistedResearch {
  return {
    id: r.id,
    repoPath: r.repoPath,
    agent: r.agent,
    model: r.model,
    effort: r.effort,
    depth: r.depth,
    sessionId: r.sessionId,
    nativeSessionId: r.nativeSessionId,
    origin: r.origin,
    seed: r.seed,
    currentPrompt: r.currentPrompt,
    // Persist prior turns (whole session survives a reload), including their
    // interleaved transcript so the activity log survives a restart too.
    history: r.history?.map((h) => ({
      prompt: h.prompt,
      segments: h.segments,
      text: h.text,
      report: h.report,
      costUsd: h.costUsd,
      depth: h.depth,
    })),
    stopped: r.stopped,
    text: r.text,
    segments: r.segments,
    report: r.report,
    costUsd: r.costUsd,
    reportPath: r.reportPath,
    error: r.error,
  };
}

/** Load persisted research runs, idle (never mid-turn). Drops empty runs that
 *  were interrupted before producing anything. */
export async function loadPersistedResearch(): Promise<ResearchRun[]> {
  const store = await getStore();
  const saved = (await store.get<PersistedResearch[]>("research")) ?? [];
  return saved
    .filter((r) => r.report || r.text.trim())
    .map((r) => ({ ...r, generating: false, status: "" }));
}

/** Write the whole research list (transient streaming fields stripped). */
export async function savePersistedResearch(
  runs: ResearchRun[],
): Promise<void> {
  const store = await getStore();
  await store.set("research", runs.map(toPersisted));
}
