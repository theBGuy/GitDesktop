import { create } from "zustand";
import { memoizedStoreLoader } from "@/lib/plugin-store";

// A GitHub-style short identifier (`#N`) for every agent entry — sessions, plans,
// and research — so an entry is easy to reference and a plan can point at the
// session that implemented it ("Implemented · ready for review #10"). Entries are
// UUID-only, so the number is MINTED from one global, monotonically-increasing
// counter and never reused (like GitHub PR/issue numbers). It's kept in ONE small
// central store keyed by entry id — not on each entry — so the three entry stores
// (and the Rust session transcript) need no schema change. Persisted to
// `<app_data>/agent-numbers.json` so numbers are stable across restarts.

interface AgentNumberState {
  /** entry id → its assigned `#N`. */
  numbers: Record<string, number>;
  /** The next number to mint. */
  counter: number;
  /** Whether the persisted map has loaded (gates minting so a number assigned
   *  before load can't collide with an already-persisted one). */
  hydrated: boolean;
  hydrate: () => Promise<void>;
  /** Assign `#N` to any of `ids` that don't have one yet (in the given order, so
   *  numbers track creation order), in a single update. Backfills existing entries
   *  on first run and numbers new ones thereafter. No-op until hydrated. */
  ensure: (ids: string[]) => void;
}

const getStore = memoizedStoreLoader("agent-numbers.json");

export const useAgentNumbers = create<AgentNumberState>((set, get) => ({
  numbers: {},
  counter: 1,
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return;
    try {
      const store = await getStore();
      const numbers =
        (await store.get<Record<string, number>>("numbers")) ?? {};
      const counter = (await store.get<number>("counter")) ?? 1;
      // The counter must clear every number already handed out, even if a stale
      // file lagged the map.
      const maxAssigned = Object.values(numbers).reduce(
        (m, n) => Math.max(m, n),
        0,
      );
      set({
        numbers,
        counter: Math.max(counter, maxAssigned + 1, 1),
        hydrated: true,
      });
    } catch {
      set({ hydrated: true });
    }
  },

  ensure: (ids) => {
    const { numbers, counter, hydrated } = get();
    if (!hydrated) return;
    let next = counter;
    let changed = false;
    const updated = { ...numbers };
    for (const id of ids) {
      if (updated[id] == null) {
        updated[id] = next;
        next += 1;
        changed = true;
      }
    }
    if (changed) set({ numbers: updated, counter: next });
  },
}));

// Persist on change (debounced), gated on hydrated so the initial empty state never
// clobbers what's on disk.
let saveTimer: ReturnType<typeof setTimeout> | null = null;
useAgentNumbers.subscribe((state, prev) => {
  if (
    !state.hydrated ||
    (state.numbers === prev.numbers && state.counter === prev.counter)
  ) {
    return;
  }
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const st = useAgentNumbers.getState();
    const store = await getStore();
    await store.set("numbers", st.numbers);
    await store.set("counter", st.counter);
  }, 500);
});

void useAgentNumbers.getState().hydrate();

/** The `#N` assigned to an entry, or undefined until it's been assigned. */
export function useAgentNumber(id: string): number | undefined {
  return useAgentNumbers((s) => s.numbers[id]);
}
