/** Branch tips as `[name, sha]` pairs sorted by name. A cached plain object
 *  would lose an own `__proto__` key: react-query's structural sharing rebuilds
 *  a changed object by assignment, which hits the prototype setter instead. */
export type BranchTipPairs = readonly (readonly [name: string, sha: string])[];

export function branchTipPairs(
  tips: Readonly<Record<string, string>>,
): BranchTipPairs {
  return Object.entries(tips)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .sort(([a], [b]) => Number(a > b) - Number(a < b));
}

export function tipInPairs(
  pairs: BranchTipPairs,
  name: string,
): string | undefined {
  return pairs.find(([n]) => n === name)?.[1];
}
