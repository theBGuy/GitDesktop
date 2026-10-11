// Import-free so node's type stripping can load it directly in
// scripts/agent-number-reconcile.test.mjs; a runtime import here fails that suite.

/** Merges this instance's map into the persisted one so no number is held by two
 *  entries across instances: an id numbered on both sides takes the DISK number, and
 *  a memory-only id whose number is already taken on disk is re-minted past every
 *  counter, in order. `changed` says whether memory must absorb the result. */
export function reconcileNumbers(
  disk: Record<string, number>,
  diskCounter: number,
  memory: Record<string, number>,
  memoryCounter: number,
): { numbers: Record<string, number>; counter: number; changed: boolean } {
  const numbers = { ...disk };
  const taken = new Set(Object.values(disk));
  const maxOnDisk = Object.values(disk).reduce((m, n) => Math.max(m, n), 0);
  let next = Math.max(diskCounter, memoryCounter, maxOnDisk + 1, 1);
  for (const [id, n] of Object.entries(memory)) {
    if (disk[id] != null) continue;
    if (taken.has(n)) {
      while (taken.has(next)) next += 1;
      numbers[id] = next;
      next += 1;
    } else {
      numbers[id] = n;
    }
    taken.add(numbers[id]);
  }
  const changed =
    next !== memoryCounter ||
    Object.keys(numbers).length !== Object.keys(memory).length ||
    Object.entries(numbers).some(([id, n]) => memory[id] !== n);
  return { numbers, counter: next, changed };
}
