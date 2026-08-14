// Per-entity draft state keyed by entity identity: a settle callback holds the
// key captured at submit, so a late mutation can only touch its own entity's
// entry. Every write is a functional update, so a captured setter can't go
// stale, and entries matching `isEmpty` are pruned so blank drafts can't pile
// up. Unless a custom `isEmpty` is passed, `empty` must be a primitive or a
// stable module-level constant: the default is Object.is against it, so a
// per-render literal never prunes and re-identifies `value` every render.
import { useState } from "react";

function without<T>(map: Record<string, T>, key: string): Record<string, T> {
  if (!(key in map)) return map;
  const next = { ...map };
  delete next[key];
  return next;
}

export function useKeyedEntityState<T>(
  entityKey: string,
  empty: T,
  isEmpty: (value: T) => boolean = (v) => Object.is(v, empty),
): {
  /** The active entity's value (`empty` when none stored). */
  value: T;
  /** Write the ACTIVE entity's value. Accepts a value or functional updater. */
  set: (next: T | ((prev: T) => T)) => void;
  /** Update the entry for a CAPTURED key (settle callbacks use this). */
  setFor: (key: string, updater: (prev: T) => T) => void;
  /** Remove the entry for a captured key. */
  clearFor: (key: string) => void;
} {
  const [entries, setEntries] = useState<Record<string, T>>({});

  const setFor = (key: string, updater: (prev: T) => T) => {
    setEntries((cur) => {
      const next = updater(key in cur ? cur[key] : empty);
      return isEmpty(next) ? without(cur, key) : { ...cur, [key]: next };
    });
  };

  return {
    value: entityKey in entries ? entries[entityKey] : empty,
    set: (next) =>
      setFor(entityKey, (prev) =>
        typeof next === "function" ? (next as (prev: T) => T)(prev) : next,
      ),
    setFor,
    clearFor: (key) => setEntries((cur) => without(cur, key)),
  };
}
