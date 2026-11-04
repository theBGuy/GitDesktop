import { useEffect } from "react";
import { useConflictResolve } from "@/lib/stores/conflict-resolve";

/**
 * Advances `scope`'s AI walk once its file leaves the conflicted set: the view
 * mounts only for conflicted files, so a walk armed on a resolved file would
 * stall. `conflicted` is null until the host's real status read answers. Holds
 * off while a Resolve all reads for this tree, since advancing would drop that
 * run. The bumped generation keeps the view's own accept from advancing twice,
 * and the move is a non-bumping landing because no user made it.
 */
export function useWalkSelfHeal(
  scope: string,
  conflicted: readonly string[] | null,
) {
  const activePath = useConflictResolve((s) =>
    s.scopePath === scope ? s.activePath : null,
  );
  const reading = useConflictResolve((s) => s.prefiltering === scope);
  const gone =
    activePath !== null &&
    conflicted !== null &&
    !conflicted.includes(activePath);
  useEffect(() => {
    if (!gone || reading) return;
    const walk = useConflictResolve.getState();
    if (
      walk.scopePath === scope &&
      walk.activePath === activePath &&
      walk.prefiltering !== scope
    ) {
      walk.advance({ landing: true });
    }
  }, [gone, reading, scope, activePath]);
}
