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

/** The in-flight `hydrate()` attempt, so the retry `ensure` kicks on every unhydrated
 *  pass shares one disk read instead of starting a fresh one per call (the entry list
 *  it runs off changes on every streaming tick). Module-level like `saveTimer` below —
 *  this store is a singleton. */
let hydrating: Promise<void> | null = null;

/** The ids the most recent unhydrated `ensure` was asked for, replayed once that
 *  store's read lands. Holding them here is what keeps the retry loop OFF the caller:
 *  the mint happens when hydration finishes, not when the caller happens to re-render. */
let pendingIds: string[] = [];

export const useAgentNumbers = create<AgentNumberState>((set, get) => ({
  numbers: {},
  counter: 1,
  hydrated: false,

  // REJECTS when the file can't be read, and leaves `hydrated` false. Both halves of
  // this store key on that flag: `ensure` refuses to MINT (numbers restarted from 1
  // would collide with every number already on disk) and the subscription below
  // refuses to WRITE (it persists the whole map, so an empty one would erase the
  // assignments). An absent file is not a failure — the plugin's `load()` tolerates
  // it and both `get`s answer undefined, which hydrates as the empty first-run state.
  hydrate: async () => {
    if (get().hydrated) return;
    // Concurrent callers WAIT on the in-flight attempt rather than starting a second
    // read; cleared on settle so a FAILED attempt can be retried, while a successful
    // one is short-circuited by `hydrated` above.
    hydrating ??= (async () => {
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
    })().finally(() => {
      hydrating = null;
    });
    return hydrating;
  },

  ensure: (ids) => {
    const { numbers, counter, hydrated } = get();
    // The unhydrated arm is the RETRY seam, not a dead end: callers no longer gate on
    // `hydrated` (see SessionList), so this is where a startup read lost to a transient
    // failure gets re-attempted — the store loader retries on the next call. It mints
    // NOTHING this pass, which is the invariant that matters: an unhydrated map would
    // hand out numbers from 1 and collide with every number already on disk.
    //
    // The replay is what closes the loop without the caller's help: once hydration
    // lands, this re-enters `ensure` with `hydrated` now true and mints against the
    // real map. Re-entry is depth-1 by construction, and a second waiter replaying the
    // same ids finds them all numbered and sets nothing.
    if (!hydrated) {
      pendingIds = ids;
      void get()
        .hydrate()
        .then(() => get().ensure(pendingIds))
        .catch(() => undefined);
      return;
    }
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

// Persist on change (debounced). This writes the WHOLE map, so `hydrated` is what
// keeps it off the file: it turns true only after a successful read, and nothing can
// change `numbers`/`counter` before then (`ensure` refuses to mint while false), so
// every map this writes descends from what was on disk. The write aborts on a failed
// store open rather than rejecting unhandled — the numbers are re-derivable on the
// next launch, and a half-written pair is worse than a missed save.
let saveTimer: ReturnType<typeof setTimeout> | null = null;
useAgentNumbers.subscribe((state, prev) => {
  if (
    !state.hydrated ||
    (state.numbers === prev.numbers && state.counter === prev.counter)
  ) {
    return;
  }
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const st = useAgentNumbers.getState();
    void getStore()
      .then(async (store) => {
        await store.set("numbers", st.numbers);
        await store.set("counter", st.counter);
      })
      .catch(() => undefined);
  }, 500);
});

// A failure here leaves `hydrated` false, which holds BOTH gates above: no numbers are
// minted and nothing is written, so the file survives intact. Recovery lives in
// `ensure`'s unhydrated arm — the next entry-list pass retries the read and replays,
// so `#N` badges come back without a restart once the file reads.
void useAgentNumbers
  .getState()
  .hydrate()
  .catch(() => undefined);

/** The `#N` assigned to an entry, or undefined until it's been assigned. */
export function useAgentNumber(id: string): number | undefined {
  return useAgentNumbers((s) => s.numbers[id]);
}
