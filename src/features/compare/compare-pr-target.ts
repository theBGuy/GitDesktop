import type { CreatePrPreset } from "@/features/pulls/CreatePrDialog";
import type { RemoteLens } from "@/lib/git/types";
import { remoteCompareValue } from "./compare-remote-ref";

/** How a Compare pick maps onto Create PR. `local` is a bare local branch;
 *  `parent`/`fork` need the lens gate (a GitHub fork with an upstream remote);
 *  `plain` is origin/<b> without it; `own-copy` is origin/<current>. */
export type ComparePrKind =
  | "local"
  | "parent"
  | "fork"
  | "plain"
  | "hidden"
  | "own-copy";

const KIND_PROPS: Record<
  ComparePrKind,
  { probeLens: RemoteLens | null; showLocalPr: boolean }
> = {
  local: { probeLens: "origin", showLocalPr: true },
  parent: { probeLens: "upstream", showLocalPr: false },
  fork: { probeLens: "origin", showLocalPr: false },
  plain: { probeLens: "origin", showLocalPr: false },
  hidden: { probeLens: null, showLocalPr: false },
  "own-copy": { probeLens: null, showLocalPr: false },
};

/** The Create PR button's label per kind; a kind with no Create button has
 *  none. */
export const CREATE_PR_LABEL: Partial<
  Record<ComparePrKind, (prNoun: string) => string>
> = {
  local: (prNoun) => `Create ${prNoun}…`,
  parent: (prNoun) => `Create ${prNoun} in parent…`,
  fork: (prNoun) => `Create ${prNoun} in your fork…`,
  plain: (prNoun) => `Create ${prNoun}…`,
};

export interface ComparePrTarget {
  kind: ComparePrKind;
  /** The lens the existing-PR probe reads; null = no probe and no PR buttons. */
  probeLens: RemoteLens | null;
  showLocalPr: boolean;
  /** Passed to the dialog for a remote pick; null for a local one. */
  preset: CreatePrPreset | null;
  /** The bare base branch the PR would target. */
  base: string;
  /** The dialog's fork-side base. Undefined for the parent, whose base need
   *  not exist locally: the dialog's fork reconcile then falls back to its own
   *  default rather than re-seeding a branch it doesn't offer. */
  defaultBase: string | undefined;
  /** Own copy that is also the configured upstream: the push/pull line. */
  ownCopyLine: boolean;
}

function pickKind(
  pick: { remote: string; name: string } | null,
  currentName: string,
  lensGate: boolean,
): ComparePrKind {
  if (pick === null) return "local";
  if (pick.remote === "origin" && pick.name === currentName) return "own-copy";
  if (pick.remote === "origin") return lensGate ? "fork" : "plain";
  if (pick.remote === "upstream" && lensGate) return "parent";
  return "hidden";
}

function presetFor(
  kind: ComparePrKind,
  pick: { remote: string; name: string } | null,
): CreatePrPreset | null {
  if (pick === null) return null;
  if (kind === "parent" || kind === "fork" || kind === "plain")
    return {
      target: kind === "parent" ? "upstream" : "origin",
      base: pick.name,
      baseRef: remoteCompareValue(pick.remote, pick.name),
    };
  return null;
}

/**
 * Own copy is origin/<current> whatever the branch tracks; the push/pull line
 * additionally needs that ref to be the configured upstream. A tracking pair
 * alone can't decide it: `switch -c fix upstream/main` tracks (upstream, main),
 * and picking upstream/main there is the classic fork PR.
 */
export function comparePrTarget(input: {
  value: string;
  pick: { remote: string; name: string } | null;
  currentName: string;
  lensGate: boolean;
  upstreamRemote: string | null;
  upstreamBranch: string | null;
}): ComparePrTarget {
  const { pick, currentName } = input;
  const kind = pickKind(pick, currentName, input.lensGate);
  return {
    kind,
    ...KIND_PROPS[kind],
    preset: presetFor(kind, pick),
    base: pick?.name ?? input.value,
    defaultBase: kind === "parent" ? undefined : (pick?.name ?? input.value),
    ownCopyLine:
      kind === "own-copy" &&
      input.upstreamRemote === "origin" &&
      input.upstreamBranch === currentName,
  };
}
