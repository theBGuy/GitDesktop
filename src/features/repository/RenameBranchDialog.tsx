import { WarningIcon } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSelector } from "@tanstack/react-store";
import {
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { DIALOG_SCROLL } from "@/components/dialog-scroll";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { clipTitle } from "@/lib/clip-title";
import {
  GIT_PUSH_TIMEOUT_MESSAGE,
  mayHaveLanded,
  presentError,
} from "@/lib/error-summary";
import { focusIsLost } from "@/lib/focus-lost";
import { required, useAppForm } from "@/lib/form";
import {
  refuseWhileBranchPushes,
  refuseWhilePushRuns,
  remoteBranchPullsOptions,
  remoteRenameCheckOptions,
  usePendingPublishes,
  usePendingRemoteRenames,
  useRenameBranch,
  useRenameBranchOnRemote,
} from "@/lib/git/queries";
import {
  isSessionBranchName,
  refNameWarning,
  sanitizeRefName,
} from "@/lib/git/ref-name";
import {
  type FileEntry,
  type OldKeptCause,
  providerLabel,
  type RemoteBranchPulls,
  type RemoteRenameOutcome,
  type RemoteRenameRefusal,
  type RemoteRenameRefusalCode,
} from "@/lib/git/types";
import { isImeKeydown } from "@/lib/hotkeys/binding";
import { useGenerateChord } from "@/lib/hotkeys/useGenerateChord";
import {
  OFFLINE_ITEM_REASON,
  refuseWhileOffline,
  useOfflineHold,
} from "@/lib/offline-writes";
import { PR_HEAD_DELETED, PR_NOUN, prRef } from "@/lib/pulls/pr-state";
import { landedIn } from "@/lib/stores/notifications";
import { promotionBlocksCheckout } from "@/lib/stores/worktree-removal";
import type { AppError } from "@/lib/tauri/invoke";
import { toastError } from "@/lib/toast";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import {
  ARIA_DISABLED_CLASS,
  heldButtonRender,
  useDisabledReason,
} from "@/lib/use-disabled-reason";
import { useRetained } from "@/lib/use-retained";
import { cn } from "@/lib/utils";
import { PROMOTION_BLOCKS_CHECKOUT } from "./checkout-copy";
import {
  GenerateBranchNameButton,
  useBranchNameGenerateAction,
} from "./GenerateBranchNameButton";
import {
  PUBLISH_HOLD_REASON,
  refuseWhilePublishing,
} from "./PublishPendingBanner";
import {
  type BranchNameGenerator,
  type CommittedNameSource,
  useGenerateBranchName,
} from "./useGenerateBranchName";

/** Why Generate holds while the rename runs: the name it would revise has
 *  already been sent. */
const RENAME_PENDING_GENERATE_REASON = "Wait for the rename to finish";

const GENERATING_REASON = "Wait for the name suggestion to finish";

const OTHER_REMOTE_RENAME_REASON =
  "Another branch is being renamed on its remote";

/** How long the name settles before the remote check reads it: each check runs
 *  `ls-remote` with the remote's credentials, so never one per keystroke. */
const CHECK_DEBOUNCE_MS = 400;

/** The field's warning for a name in the agent-session namespace. A warning, not
 *  a validator: validator messages never render, and the backend refuses it. */
function sessionNameWarning(name: string): string | null {
  return isSessionBranchName(name)
    ? "gd/session/ is reserved for agent sessions — choose another name"
    : null;
}

/** The remote step this rename may offer; null hides the checkbox. */
export type RemoteRenameOffer = {
  remote: string;
  blocked: "remoteDefault" | "keepLocal" | null;
} | null;

type Names = { old: string; new: string; remote: string };

/** What the dialog showed when its remote rename was pressed. */
type Pressed = {
  oldName: string;
  newName: string;
  remote: string;
  upstream: { remote: string; branch: string } | null;
  confirm: boolean;
};

/** `text` closed by exactly one sentence end: git's own lines may carry one. */
function sentence(text: string): string {
  const t = text.trimEnd();
  return /[.!?…]$/.test(t) ? t : `${t}.`;
}

const DETAIL_MAX_LINES = 3;
const DETAIL_MAX_CHARS = 300;

/** git's own lead on a line it relays; one is dropped per line. */
const DETAIL_LEAD = /^(?:error|fatal|remote): /;

/** A remote's or git's own text, held to a toast's size: its first non-empty
 *  lines without git's lead, each but the last closed as a sentence unless it
 *  runs on (`:`, `;`, `,`), at most `DETAIL_MAX_CHARS` code points, an ellipsis
 *  where cut. The caller closes the last line. A hook can print any amount. A
 *  cut drops trailing sentence ends, so the ellipsis never follows a period. */
function cappedDetail(text: string): string {
  const lines = text
    .split(/\r\n|[\n\r]/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
  const kept = lines
    .slice(0, DETAIL_MAX_LINES)
    .map((l) => l.replace(DETAIL_LEAD, "").trimStart());
  const joined = kept
    .map((l, i) =>
      i === kept.length - 1 || /[:;,]$/.test(l) ? l : sentence(l),
    )
    .join(" ");
  // Code points, so an astral character is kept or dropped whole.
  let chars = Array.from(joined);
  let cut = lines.length > DETAIL_MAX_LINES;
  if (chars.length > (cut ? DETAIL_MAX_CHARS - 1 : DETAIL_MAX_CHARS)) {
    chars = chars.slice(0, DETAIL_MAX_CHARS - 1);
    cut = true;
  }
  if (!cut) return joined;
  return `${chars.join("").replace(/[\s.!?…]+$/, "")}…`;
}

const BLOCK_REASON: Record<
  "remoteDefault" | "keepLocal",
  (n: Names) => string
> = {
  remoteDefault: (n) => `${n.old} is the default branch on ${n.remote}`,
  keepLocal: (n) => `${n.old} is marked Keep local`,
};

type RefusalCopy = { reason: string; advice: string };

const UNTICK = "Untick to rename only here.";

/** Each refusal's reason and the advice that follows it under the box (both
 *  held on Rename). A refusal toasted after the dialog was dismissed carries
 *  the reason alone: the box the advice talks about is gone. */
const REFUSAL_COPY: {
  [K in RemoteRenameRefusalCode]: (
    n: Names,
    r: Extract<RemoteRenameRefusal, { code: K }>,
  ) => RefusalCopy;
} = {
  remoteAhead: (n) => ({
    reason: `${n.remote}/${n.old} has commits this branch doesn't have.`,
    advice: "Pull first, or untick to rename only here.",
  }),
  newExists: (n) => ({
    reason: `${n.new} already exists on ${n.remote}.`,
    advice: "Choose another name, or untick to rename only here.",
  }),
  unreachable: (n, r) => ({
    reason: `Couldn't reach ${n.remote}: ${sentence(cappedDetail(r.detail))}`,
    advice: UNTICK,
  }),
  mirror: (n) => ({
    reason: `${n.remote} is a mirror remote, so GitDesktop won't push to it.`,
    advice: UNTICK,
  }),
  pushUrlDiffers: (n) => ({
    reason: `${n.remote} pushes to a different address than it fetches from, so GitDesktop can't check it first.`,
    advice: UNTICK,
  }),
  caseOnly: (n) => ({
    reason: `A rename that changes only letter case can't be done on ${n.remote}, because this computer's file system ignores letter case in branch names.`,
    advice: UNTICK,
  }),
  remoteDefault: (n) => ({
    reason: `${n.old} is the default branch on ${n.remote}.`,
    advice: UNTICK,
  }),
  remoteGone: (n) => ({
    reason: `${n.remote}/${n.old} no longer exists.`,
    advice: UNTICK,
  }),
  notTracking: (n) => ({
    reason: `${n.old} no longer tracks ${n.remote}/${n.old}.`,
    advice: UNTICK,
  }),
  keepLocal: (n) => ({
    reason: `${n.old} is marked Keep local.`,
    advice: UNTICK,
  }),
  moved: (n) => ({
    reason: `${n.remote}/${n.old} changed since it was checked.`,
    advice: "Checking again…",
  }),
};

function refusalCopy(n: Names, r: RemoteRenameRefusal): RefusalCopy {
  return (
    REFUSAL_COPY[r.code] as (n: Names, r: RemoteRenameRefusal) => RefusalCopy
  )(n, r);
}

/** A refusal as the box shows it: its reason, then its advice. */
function refusalText(n: Names, r: RemoteRenameRefusal): string {
  const { reason, advice } = refusalCopy(n, r);
  return `${reason} ${advice}`;
}

/** Whether a lookup answer requires the destructive "Rename anyway": a request
 *  found, a scope that couldn't be checked, or a forge that can't be named. */
function pullsNeedConfirm(pulls: RemoteBranchPulls | undefined): boolean {
  if (pulls === undefined) return false;
  switch (pulls.status) {
    case "noForge":
      return false;
    case "unidentified":
      return true;
    case "checked":
      return pulls.items.length > 0 || pulls.unchecked.length > 0;
  }
}

/** A toast title that ends in a period takes the repository note before it. */
function titled(title: string, away: string): string {
  return title.endsWith(".") ? `${title.slice(0, -1)}${away}.` : title + away;
}

function withWarning(description: string, warning: string | null): string {
  return warning ? `${description} ${warning}` : description;
}

const OLD_KEPT_TITLE = (n: Names) =>
  `Renamed to ${n.new}, but ${n.remote}/${n.old} is still there`;
const REMOTE_GROUP_DELETE = (n: Names) =>
  `Delete ${n.old} on ${n.remote} from the branch menu's Remote group`;

/** Each kept-old cause's toast: what is where, and where to finish by hand. */
const OLD_KEPT_COPY: {
  [K in OldKeptCause["reason"]]: (
    n: Names,
    c: Extract<OldKeptCause, { reason: K }>,
    forge: string | null,
  ) => { title: string; description: string };
} = {
  notInPush: (n) => ({
    title: OLD_KEPT_TITLE(n),
    description: `${n.new} changed while the rename ran, so the pushed copy doesn't include everything on ${n.remote}/${n.old}. Compare the two before deleting ${n.old} on ${n.remote}.`,
  }),
  unverified: (n) => ({
    title: OLD_KEPT_TITLE(n),
    description: `Couldn't confirm that ${n.remote}/${n.new} includes everything on ${n.remote}/${n.old}, so ${n.old} wasn't deleted there. Compare the two before deleting ${n.old} on ${n.remote}.`,
  }),
  moved: (n) => ({
    title: OLD_KEPT_TITLE(n),
    description: `${n.remote}/${n.old} changed while the rename ran, so it wasn't deleted. Delete it from the branch menu's Remote group once you've checked it.`,
  }),
  rejected: (n, c, forge) => {
    const detail = cappedDetail(c.detail);
    return {
      title: OLD_KEPT_TITLE(n),
      description: `${detail === "" ? `${n.remote} refused the delete.` : sentence(detail)} ${REMOTE_GROUP_DELETE(n)}${forge ? `, or on ${forge}` : ""}.`,
    };
  },
  failed: (n, c) => ({
    title: `Renamed to ${n.new}, but ${n.remote}/${n.old} may still be there`,
    description: `${sentence(presentError(c.error).summary)} ${REMOTE_GROUP_DELETE(n)}.`,
  }),
};

/** The one toast a settled remote rename raises; `refused` is the caller's. */
function toastRemoteOutcome(
  outcome: Exclude<RemoteRenameOutcome, { status: "refused" }>,
  n: Names,
  away: string,
  forge: string | null,
) {
  switch (outcome.status) {
    case "renamed":
      toast.success(
        titled(`Renamed to ${n.new} here and on ${n.remote}`, away),
        { description: outcome.warning ?? undefined },
      );
      return;
    case "pushFailed": {
      const e: AppError = outcome.error;
      const hedged =
        mayHaveLanded(e) ||
        (e.kind === "timeout" && e.message === GIT_PUSH_TIMEOUT_MESSAGE);
      const summary = sentence(presentError(e).summary);
      toast.warning(
        titled(
          hedged
            ? `Renamed to ${n.new} here. Couldn't confirm the push to ${n.remote}.`
            : `Renamed to ${n.new} here. Couldn't push it to ${n.remote}.`,
          away,
        ),
        {
          description: withWarning(
            hedged
              ? summary
              : `${summary} ${n.new} still tracks ${n.remote}/${n.old}.`,
            outcome.warning,
          ),
        },
      );
      return;
    }
    case "oldKept": {
      const copy = (
        OLD_KEPT_COPY[outcome.cause.reason] as (
          n: Names,
          c: OldKeptCause,
          forge: string | null,
        ) => { title: string; description: string }
      )(n, outcome.cause, forge);
      toast.warning(titled(copy.title, away), {
        description: withWarning(copy.description, outcome.warning),
      });
      return;
    }
  }
}

/** Takes focus over when the box leaves while focused: its layout cleanup runs
 *  before React removes the section, so focus is still readable there. */
function FocusHandoff({ onLeaveFocused }: { onLeaveFocused: () => void }) {
  const ref = useRef<HTMLSpanElement>(null);
  const report = useEffectEvent(onLeaveFocused);
  useLayoutEffect(() => {
    const host = ref.current?.parentElement;
    return () => {
      if (host?.contains(document.activeElement)) report();
    };
  }, []);
  return <span ref={ref} hidden />;
}

/** One open request's row: plain text, never a link or a tab stop. */
function PullRow({
  provider,
  number,
  title,
  consequence,
}: {
  provider: Parameters<typeof prRef>[0];
  number: number;
  title: string;
  consequence: string;
}) {
  return (
    <li className="min-w-0">
      <div className="flex min-w-0 gap-2 text-foreground">
        <span className="shrink-0 font-mono">{prRef(provider, number)}</span>
        <span className="min-w-0 truncate" onMouseEnter={clipTitle(title)}>
          {title}
        </span>
      </div>
      <div className="text-muted-foreground">{consequence}</div>
    </li>
  );
}

/** One line per unchecked scope, each reason one sentence. Scopes that failed
 *  for the same reason (a missing or signed-out CLI) read as one line, under
 *  the repository's name. */
function uncheckedLines(
  unchecked: Extract<RemoteBranchPulls, { status: "checked" }>["unchecked"],
): { scope: "repository" | "parent"; summary: string }[] {
  const lines = unchecked.map((u) => ({
    scope: u.scope,
    summary: sentence(presentError(u.error).summary),
  }));
  const shared =
    lines.length > 1 && lines.every((l) => l.summary === lines[0].summary);
  return shared ? [{ scope: "repository", summary: lines[0].summary }] : lines;
}

/** What the lookup found, under the check's own line. `showNone` prints the
 *  all-clear line, which only a clear check may claim. */
function PullsBlock({
  pulls,
  names,
  showNone,
}: {
  pulls: RemoteBranchPulls;
  names: Names;
  showNone: boolean;
}) {
  if (pulls.status === "noForge") return null;
  if (pulls.status === "unidentified")
    return (
      <div className="flex items-start gap-1.5 text-warning">
        <WarningIcon aria-hidden className="mt-px size-3.5 shrink-0" />
        <div className="min-w-0 space-y-1 wrap-break-word">
          <p>
            Couldn't check {names.remote} for open pull or merge requests:
            GitDesktop can't identify the forge at {pulls.host}.
          </p>
          <p>
            A pull or merge request from {names.old} would lose its source
            branch.
          </p>
        </div>
      </div>
    );
  const { provider, items, unchecked } = pulls;
  const noun = PR_NOUN[provider];
  if (items.length === 0 && unchecked.length === 0)
    return showNone ? (
      <p className="text-muted-foreground">
        No open {noun} uses{" "}
        <span className="font-mono wrap-break-word">{names.old}</span>.
      </p>
    ) : null;
  return (
    <div className="flex items-start gap-1.5 text-warning">
      <WarningIcon aria-hidden className="mt-px size-3.5 shrink-0" />
      <div className="min-w-0 flex-1 space-y-1.5">
        {items.length > 0 && (
          <>
            <p className="wrap-break-word">
              Open {noun}s on <span className="font-mono">{names.old}</span>:
            </p>
            {/* About five rows before it scrolls, so the dialog stays short;
                a tab stop, since WebKit can't focus a scroller by itself. */}
            <ul
              tabIndex={0}
              aria-label={`Open ${noun}s`}
              className="max-h-48 space-y-1 overflow-y-auto outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
            >
              {items.map((item) => (
                <PullRow
                  key={`${item.scope}-${item.repo}-${item.number}`}
                  provider={provider}
                  number={item.number}
                  title={item.title}
                  consequence={
                    item.scope === "parent"
                      ? `in ${item.repo}: ${PR_HEAD_DELETED[provider].item}`
                      : PR_HEAD_DELETED[provider].item
                  }
                />
              ))}
            </ul>
          </>
        )}
        {unchecked.length > 0 && (
          <div className="space-y-1 wrap-break-word">
            {uncheckedLines(unchecked).map((u) => (
              <p key={u.scope}>
                Couldn't check{" "}
                {u.scope === "parent" ? "the parent repository" : names.remote}{" "}
                for open {noun}s: {u.summary}
              </p>
            ))}
            <p>
              A {noun} from {names.old} {PR_HEAD_DELETED[provider].would}.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Rename-branch dialog. Open when `target` is the branch being renamed (null =
 * closed). Owns its own form + the rename mutations; seeds the field with the
 * current name on open so the user edits from there. The target need not be the
 * checked-out branch — every branch row's context menu opens this — so AI name
 * generation reads the working tree only when it is. With `remoteRename`, an
 * unticked-by-default box also renames the branch on its upstream remote,
 * behind a live check and an open-request lookup.
 */
export function RenameBranchDialog({
  repoPath,
  target,
  targetUpstream,
  remoteRename,
  currentName,
  onClose,
  aiEnabled,
  aiConfigured,
  hasChanges,
  headExists,
  entries,
  allBranchNames,
  committedFallback,
  committedStatus,
  onOpenSettings,
}: {
  repoPath: string;
  target: string | null;
  /** `target`'s live upstream branch, by its remote and its name there; null when
   *  unpublished, gone, a local upstream, or not a branch. */
  targetUpstream: { remote: string; branch: string } | null;
  /** The remote step this rename may offer; null hides the checkbox. The row
   *  can be stale: the backend re-derives every fact. */
  remoteRename: RemoteRenameOffer;
  /** The checked-out branch — decides whether `target`'s working tree is its
   *  own (null when HEAD is detached, which is never the rename target). */
  currentName: string | null;
  onClose: () => void;
  aiEnabled: boolean;
  aiConfigured: boolean;
  hasChanges: boolean;
  headExists: boolean;
  entries: FileEntry[];
  allBranchNames: string[];
  /** The committed work of the branch being renamed, vs the default branch —
   *  compared against `target` itself, not HEAD. */
  committedFallback: CommittedNameSource | null;
  /** How the committed-work lookup stands (pending/error are surfaced rather
   *  than read as "there is none"). */
  committedStatus: "ready" | "pending" | "error";
  onOpenSettings: (section: "ai") => void;
}) {
  const queryClient = useQueryClient();
  const renameBranch = useRenameBranch(repoPath);
  const renameOnRemote = useRenameBranchOnRemote(repoPath);
  const branchNameGen = useGenerateBranchName(repoPath);
  // The Generate affordance's copy — and so its enabled state — is retained
  // through the close fade below, so the dispatch carries the liveness: a click
  // after close would start an uncancellable generation whose name lands in the
  // next open's field.
  const guardedGen: BranchNameGenerator = {
    ...branchNameGen,
    generate: async (opts) => {
      if (target === null) return;
      await branchNameGen.generate(opts);
    },
  };
  // The open session a rename settles against: a new one per open, retarget and
  // repository switch, dropped at the commit that closes, drops or switches it,
  // so a later settle reads the dialog as dismissed. A name compare can't tell a
  // same-named branch reopened in the next repo (this dialog outlives switches).
  const sessionRef = useRef<object | null>(null);
  // The same token as render state: the act's refusal latch belongs to the
  // session it was made in.
  const [openSession, setOpenSession] = useState<object | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a repository switch starts a new session even when the branch name stays
  useLayoutEffect(() => {
    if (target === null) return;
    const session = {};
    sessionRef.current = session;
    setOpenSession(session);
    return () => {
      sessionRef.current = null;
    };
  }, [target, repoPath]);
  // Every close path routes through here: the dialog stays mounted, so an
  // in-flight suggestion would otherwise land in the field on the NEXT open,
  // which may be naming a different branch.
  const closeDialog = () => {
    sessionRef.current = null;
    branchNameGen.cancel();
    onClose();
  };
  const shownTarget = useRetained(target);
  // The parent's committed-work lookup collapses when the dialog closes, so
  // these two retain on the dialog's own discriminant rather than their values:
  // null / "ready" are legitimate while it's open (a branch with no commits).
  const shownCommittedFallback = useRetained(
    committedFallback,
    target !== null,
  );
  const shownCommittedStatus = useRetained(committedStatus, target !== null);
  const shownUpstream = useRetained(targetUpstream, target !== null);
  const shownRemoteRename = useRetained(remoteRename, target !== null);
  // Only the checked-out branch's own working tree describes it.
  const targetIsCurrent = shownTarget !== null && shownTarget === currentName;

  const nameFieldId = useId();
  const remote = shownRemoteRename?.remote ?? null;
  const offlineHold = useOfflineHold();
  const publishActive = usePendingPublishes(repoPath).length > 0;
  const pendingRemoteRenames = usePendingRemoteRenames(repoPath);
  // A rename of the shown branch, under either name: a branches re-read after
  // the local step drops the old name's row (and the offer) while the push runs.
  const isHere = (p: { oldName: string; newName: string }) =>
    shownTarget !== null &&
    (p.oldName === shownTarget || p.newName === shownTarget);
  const runningHere = pendingRemoteRenames.find(isHere);
  const otherRunning = pendingRemoteRenames.some((p) => !isHere(p));
  // This dialog's own remote rename, from its press until a refusal or error
  // reopens the form, or through the close its settle makes: the branch re-read
  // after the local step drops the old name's upstream and the offer mid-run.
  const [pressed, setPressed] = useState<Pressed | null>(null);
  const running = pressed ?? runningHere;
  // A local-only rename that landed, through the close it makes: the form
  // stops submitting before the popup is gone.
  const [localDone, setLocalDone] = useState(false);
  // The box section's remote: the running rename's first, so it stays mounted
  // (held read-only) until that rename settles; null hides the section.
  const boxRemote = running?.remote ?? remote;
  const boxKey = boxRemote;
  // The tick, the press and a landed local rename are dropped in render, so no
  // commit carries one across a reopen or retarget, a repository switch, or the
  // box leaving and coming back. A close keeps all three for the fade: the
  // reads are gated on an open dialog.
  const [tick, setTick] = useState(false);
  const [tickScope, setTickScope] = useState({ repoPath, target, boxKey });
  if (
    tickScope.repoPath !== repoPath ||
    tickScope.target !== target ||
    tickScope.boxKey !== boxKey
  ) {
    setTickScope({ repoPath, target, boxKey });
    const closing =
      target === null &&
      tickScope.repoPath === repoPath &&
      tickScope.boxKey === boxKey;
    if (!closing) {
      setTick(false);
      setPressed(null);
      setLocalDone(false);
    }
  }
  const ticked = tick && remote !== null;
  const remoteStep =
    ticked && shownRemoteRename?.blocked === null && offlineHold === undefined;

  const renameForm = useAppForm({
    defaultValues: { name: "" },
    onSubmit: async ({ value }) => {
      if (!target) return;
      // Renaming moves the ref a push reads, and a push can start after the
      // dialog opened.
      if (refuseWhileBranchPushes(queryClient, repoPath, target, currentName))
        return;
      if (promotionBlocksCheckout(repoPath)) {
        toast.info(PROMOTION_BLOCKS_CHECKOUT);
        return;
      }
      if (remoteStep && refuseWhileOffline()) return;
      if (remoteStep && refuseWhilePushRuns(queryClient, repoPath)) return;
      const newName = sanitizeRefName(value.name);
      const session = sessionRef.current;
      if (!remoteStep) {
        // A repository publish pushes the checked-out branch by name.
        const isHead = target === currentName;
        if (isHead && refuseWhilePublishing(queryClient, repoPath)) return;
        try {
          const outcome = await renameBranch.mutateAsync({
            oldName: target,
            newName,
          });
          toast.success(`Renamed to ${newName}`, {
            description: outcome.warning ?? undefined,
          });
          if (sessionRef.current === session) {
            sessionRef.current = null;
            setLocalDone(true);
            onClose();
          }
        } catch (e) {
          toastError(e);
        }
        return;
      }
      // The submit's hold keeps a press off an unchecked remote step.
      if (remote === null || clearTip === null) return;
      // The remote step pushes, so any publish of the repository holds it.
      if (refuseWhilePublishing(queryClient, repoPath)) return;
      const names: Names = { old: target, new: newName, remote };
      // The forge a kept-old toast names, as the dialog showed it at the press.
      const forge =
        pulls.data?.status === "checked"
          ? providerLabel(pulls.data.provider)
          : null;
      const sentTip = clearTip;
      const press: Pressed = {
        oldName: target,
        newName,
        remote,
        upstream: shownUpstream,
        confirm: confirmNeeded,
      };
      setPressed(press);
      // Only an outcome that keeps the dialog open gives the form back.
      const release = () => setPressed((p) => (p === press ? null : p));
      try {
        const outcome = await renameOnRemote.mutateAsync({
          oldName: target,
          newName,
          remote,
          expectedOldTip: sentTip,
        });
        const { away } = landedIn(repoPath);
        const stillOpen = sessionRef.current === session && session !== null;
        if (outcome.status === "refused") {
          release();
          if (stillOpen) {
            setActRefusal({
              session,
              newName,
              tip: sentTip,
              refusal: outcome.refusal,
            });
            // No refetch of its own: the mutation's whole-repo settle already
            // re-read the check once, so `moved` resolves into a fresh verdict.
          } else {
            toast.info(
              `Didn't rename ${target}${away}: ${refusalCopy(names, outcome.refusal).reason}`,
            );
          }
          return;
        }
        toastRemoteOutcome(outcome, names, away, forge);
        if (stillOpen) {
          sessionRef.current = null;
          onClose();
        }
      } catch (e) {
        release();
        toastError(e);
      }
    },
  });

  // NOTE: seeding resets must pass keepDefaultValues — otherwise reset()
  // rewrites the form's defaultValues, and react-form's per-render options
  // sync sees "different defaults + untouched form" and clobbers the seeded
  // values right back on the next render.
  const seedOnOpen = useEffectEvent((name: string) => {
    // Reopened on a branch whose remote rename runs here: the name being applied.
    const applying = pendingRemoteRenames.find((p) => p.oldName === name);
    renameForm.reset(
      { name: applying?.newName ?? name },
      { keepDefaultValues: true },
    );
  });
  useEffect(() => {
    if (target !== null) seedOnOpen(target);
  }, [target]);

  // Generations are bound to the target they were started for: the rename
  // hotkey stays live over the open dialog, so `target` can swap mid-stream and
  // a suggestion for the old branch would otherwise land in a form that is now
  // renaming a different one. `cancel` is stable (a no-dep `useCallback` in
  // `useAiStream`), so this re-runs only on a target change. Closing cancels
  // here as well as in `closeDialog` — aborting twice is a no-op.
  const cancelGenerate = branchNameGen.cancel;
  useEffect(() => {
    if (target === null) return;
    return () => cancelGenerate();
  }, [target, cancelGenerate]);

  // The remote step's two reads: the check keyed on the settled name, the
  // lookup keyed without it, so typing never re-runs the lookup.
  const fieldName = useSelector(renameForm.store, (s) => s.values.name);
  const liveName = sanitizeRefName(fieldName);
  const settledName = useDebouncedValue(liveName, CHECK_DEBOUNCE_MS);
  const checkName =
    settledName === "" || settledName === shownTarget ? null : settledName;
  const isSubmitting = useSelector(renameForm.store, (s) => s.isSubmitting);
  // A local-only rename from its press until the form is given back or the
  // popup is gone (a remote one shows as `running`).
  const localRunning = isSubmitting || localDone;
  const readsOn =
    remoteStep && running === undefined && !localRunning && target !== null;
  const checkOptions = remoteRenameCheckOptions(
    repoPath,
    remote ?? "",
    shownTarget ?? "",
    checkName,
  );
  // The check waits for the debounce, so a tick right after a reseed never
  // checks the previous session's name.
  const check = useQuery({
    ...checkOptions,
    enabled: readsOn && settledName === liveName,
  });
  const pullsOptions = remoteBranchPullsOptions(
    repoPath,
    remote ?? "",
    shownTarget ?? "",
  );
  const pulls = useQuery({ ...pullsOptions, enabled: readsOn });
  const forgetReads = () => {
    if (remote === null || shownTarget === null) return;
    // Every new name's check for this branch: the key up to the new name.
    queryClient.removeQueries({ queryKey: checkOptions.queryKey.slice(0, 5) });
    queryClient.removeQueries({ queryKey: pullsOptions.queryKey });
  };

  // A refusal the act answered in this session holds while the field still
  // names what was sent and the shown check still carries the tip it pinned.
  const [actRefusal, setActRefusal] = useState<{
    session: object;
    newName: string;
    tip: string;
    refusal: RemoteRenameRefusal;
  } | null>(null);
  const clearTip = check.data?.status === "clear" ? check.data.oldTip : null;
  const latched =
    actRefusal !== null &&
    actRefusal.session === openSession &&
    actRefusal.newName === liveName &&
    clearTip === actRefusal.tip
      ? actRefusal.refusal
      : null;
  const names: Names = {
    old: shownTarget ?? "",
    new: liveName,
    remote: remote ?? "",
  };
  // Only a read with no answer for this tick checks: a background refetch over
  // an answer leaves the region and the hold as they are.
  const checking =
    remoteStep &&
    (check.isPending || pulls.isPending || settledName !== liveName);
  const readError: unknown = (() => {
    if (!remoteStep) return null;
    if (check.isError) return check.error;
    if (pulls.isError) return pulls.error;
    return null;
  })();
  const refusal =
    check.data?.status === "refused" ? check.data.refusal : latched;
  const confirmNeeded = remoteStep && pullsNeedConfirm(pulls.data);
  // The press's label and upstream line, held with its running state.
  const confirmShown = pressed !== null ? pressed.confirm : confirmNeeded;
  const upstreamShown = pressed !== null ? pressed.upstream : shownUpstream;
  const checkingLine = `Checking ${names.remote}…`;
  const readErrorLine =
    readError !== null
      ? `Couldn't check ${names.remote}: ${presentError(readError).summary}`
      : null;
  const refusalLine = refusal !== null ? refusalText(names, refusal) : null;

  // The box's tick hold, arms in precedence. While this dialog's rename runs,
  // remote or local-only (until its form is given back or the popup is gone),
  // the box holds in either state; otherwise a ticked box can be unticked.
  const tickReason = (() => {
    switch (true) {
      case running !== undefined:
        return RENAME_PENDING_GENERATE_REASON;
      case localRunning:
        return RENAME_PENDING_GENERATE_REASON;
      case shownRemoteRename?.blocked != null:
        return BLOCK_REASON[shownRemoteRename.blocked](names);
      case offlineHold !== undefined:
        return OFFLINE_ITEM_REASON;
      case otherRunning:
        return OTHER_REMOTE_RENAME_REASON;
      default:
        return null;
    }
  })();
  const boxChecked = ticked || running !== undefined;
  const boxReadOnly =
    running !== undefined ||
    localRunning ||
    (tickReason !== null && !boxChecked);
  const tickReasonId = useId();
  // Base UI toggles a checkbox on a Space KEYUP with no keydown state, so the
  // keyup of a Space pressed elsewhere would toggle it: only a Space pressed
  // on the box toggles it.
  const boxSpaceDown = useRef(false);
  // Set by the box's handoff as it leaves focused, consumed once it has gone.
  const refocusName = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `boxKey` is the re-run key, so the handoff lands once the box has gone
  useLayoutEffect(() => {
    if (!refocusName.current) return;
    refocusName.current = false;
    if (focusIsLost()) document.getElementById(nameFieldId)?.focus();
  }, [boxKey, nameFieldId]);

  // ONE hold, read by the button and by the form's submit, so Enter submits
  // exactly when the button would.
  // Offline is no arm: it turns the remote step off, so Rename stays a local
  // rename (the press re-checks the network for a remote step).
  const submitHeld = (() => {
    if (running !== undefined) return RENAME_PENDING_GENERATE_REASON;
    if (branchNameGen.generating) return GENERATING_REASON;
    // The same predicate as the press's publish refusal.
    if (publishActive && (remoteStep || shownTarget === currentName))
      return PUBLISH_HOLD_REASON;
    if (!remoteStep) return null;
    if (otherRunning) return OTHER_REMOTE_RENAME_REASON;
    if (checking) return checkingLine;
    return readErrorLine ?? refusalLine;
  })();
  const submitHold = useDisabledReason({
    disabled: submitHeld !== null,
    reason: submitHeld,
  });

  // One generate pair for the button and the chord — see
  // `useBranchNameGenerateAction`. It rides `guardedGen`, so a chord pressed
  // during the close fade can't start an uncancellable generation either.
  const generateAction = useBranchNameGenerateAction({
    gen: guardedGen,
    aiEnabled,
    aiConfigured,
    hasChanges,
    headExists,
    entries,
    recentBranches: allBranchNames,
    nameTarget: targetIsCurrent ? "checked-out-branch" : "other-branch",
    committedFallback: shownCommittedFallback,
    onName: (name) => renameForm.setFieldValue("name", name),
  });
  // This dialog opens from any branch row over any tab, including Changes where
  // the global generate-commit-message action is live. The chord is swallowed
  // here whenever it may fire, generate-capable or not (the hook mirrors the
  // global listener's own guards). A running rename holds it like the button:
  // the name it would revise has already been sent.
  const renameRunning = isSubmitting || localDone || running !== undefined;
  const generateChord = useGenerateChord({
    enabled:
      generateAction.enabled &&
      !isSubmitting &&
      !localDone &&
      running === undefined,
    run: generateAction.run,
  });

  // An empty or unchanged field names no branch, so the lines say what it is.
  const newLabel =
    liveName === "" || liveName === names.old ? "the renamed branch" : liveName;
  // Outside the live region: it follows every keystroke in the field.
  const helperLine =
    running === undefined && !remoteStep ? (
      <p className="pl-6 text-muted-foreground wrap-break-word">
        {names.remote}/{names.old} keeps its name and {newLabel} keeps tracking
        it.
      </p>
    ) : null;
  const statusLine = (() => {
    if (running !== undefined)
      return (
        <p className="text-muted-foreground wrap-break-word">
          Renaming {running.oldName} to {running.newName} on {running.remote}…
        </p>
      );
    if (!remoteStep) return null;
    if (checking)
      return <p className="text-muted-foreground">{checkingLine}</p>;
    if (readErrorLine !== null)
      return <p className="text-warning wrap-break-word">{readErrorLine}</p>;
    return (
      <>
        {refusalLine !== null ? (
          <p className="text-warning wrap-break-word">{refusalLine}</p>
        ) : (
          <p className="text-muted-foreground wrap-break-word">
            Pushes {newLabel} to {names.remote}, then deletes {names.remote}/
            {names.old}.
          </p>
        )}
        {pulls.data !== undefined && (
          <PullsBlock
            pulls={pulls.data}
            names={names}
            showNone={refusalLine === null}
          />
        )}
      </>
    );
  })();

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(o) => {
        if (!o) closeDialog();
      }}
    >
      <DialogContent
        className="flex max-h-[85vh] flex-col"
        onKeyDown={generateChord.onKeyDown}
      >
        <form
          // min-w-0: a long branch name must not push the form past the
          // dialog's max-width; min-h-0 lets the body scroll under the cap.
          className="flex min-h-0 min-w-0 flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            // Enter submits even while the submit button is held.
            if (submitHeld !== null || localDone) return;
            renameForm.handleSubmit();
          }}
          onKeyDown={(e) => {
            // A held Enter's repeats never submit: only a fresh press does. With
            // open requests at stake only the destructive button renames: every
            // Enter from the field, chorded or not, since a chorded Enter can
            // still submit implicitly. A generate chord rebound to Enter with
            // Ctrl, Alt or Meta still runs; a bare-Enter one stays with the
            // field while the confirm is up.
            if (
              (confirmNeeded || e.repeat) &&
              e.key === "Enter" &&
              e.target instanceof HTMLElement &&
              e.target.id === nameFieldId &&
              !isImeKeydown(e)
            )
              e.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename branch</DialogTitle>
            {/* The popup's aria-describedby, so the upstream note is announced
                on open. It promises nothing about Push: that depends on the
                push config. With the remote option shown, its own line says
                what happens there. */}
            <DialogDescription>
              Renames{" "}
              <span className="font-mono wrap-break-word">{shownTarget}</span>.
              {upstreamShown && (
                <>
                  {" "}
                  <span className="font-mono wrap-break-word">
                    {shownTarget}
                  </span>{" "}
                  tracks{" "}
                  <span className="font-mono wrap-break-word">
                    {upstreamShown.remote}/{upstreamShown.branch}
                  </span>
                  .
                  {boxRemote === null && (
                    <>
                      {" "}
                      Renaming changes only the local name; the branch on{" "}
                      <span className="font-mono wrap-break-word">
                        {upstreamShown.remote}
                      </span>{" "}
                      keeps its name.
                    </>
                  )}
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          {/* Header and footer stay pinned; a long request list scrolls. */}
          <div className={cn(DIALOG_SCROLL, "min-h-0 flex-1 space-y-4")}>
            <renameForm.AppField
              name="name"
              validators={{
                onChange: ({ value }) =>
                  required(value) ??
                  (sanitizeRefName(value) === target ? "Unchanged" : undefined),
              }}
            >
              {(field) => (
                <field.TextField
                  id={nameFieldId}
                  label="New name"
                  warning={(value) =>
                    sessionNameWarning(sanitizeRefName(value)) ??
                    refNameWarning(value)
                  }
                />
              )}
            </renameForm.AppField>
            <GenerateBranchNameButton
              gen={guardedGen}
              action={generateAction}
              hint={generateChord.hint}
              aiEnabled={aiEnabled}
              aiConfigured={aiConfigured}
              hasChanges={hasChanges}
              headExists={headExists}
              nameTarget={
                targetIsCurrent ? "checked-out-branch" : "other-branch"
              }
              committedFallback={shownCommittedFallback}
              committedStatus={shownCommittedStatus}
              // Renaming never picks a base — the fallback always applies here.
              basedElsewhere={null}
              heldReason={renameRunning ? RENAME_PENDING_GENERATE_REASON : null}
              onSetupAi={() => {
                closeDialog();
                onOpenSettings("ai");
              }}
            />
            {boxRemote !== null && (
              <div key={boxRemote} className="space-y-2 text-xs">
                <FocusHandoff
                  onLeaveFocused={() => {
                    refocusName.current = true;
                  }}
                />
                {/* The reason sits beside the label, not in it: the box's name is
                  its label alone, and the reason is its description. The row
                  wraps, so a reason that can't fit takes its own line. */}
                <div className="flex flex-wrap items-start gap-x-1 text-muted-foreground">
                  <label
                    className={cn(
                      "flex min-w-0 items-start gap-2",
                      boxReadOnly ? "cursor-not-allowed" : "cursor-pointer",
                    )}
                  >
                    <Checkbox
                      checked={boxChecked}
                      readOnly={boxReadOnly}
                      aria-disabled={boxReadOnly || undefined}
                      aria-describedby={
                        tickReason !== null ? tickReasonId : undefined
                      }
                      className={ARIA_DISABLED_CLASS}
                      onCheckedChange={(checked) => {
                        forgetReads();
                        setActRefusal(null);
                        setTick(checked === true && remote !== null);
                      }}
                      onKeyDown={(e) => {
                        // A held Space's auto-repeat lands here too once focus moves.
                        if (e.key === " " && !e.repeat)
                          boxSpaceDown.current = true;
                      }}
                      onKeyUp={(e) => {
                        if (e.key !== " ") return;
                        if (!boxSpaceDown.current) {
                          e.preventDefault();
                          e.preventBaseUIHandler();
                        }
                        boxSpaceDown.current = false;
                      }}
                      onBlur={() => {
                        boxSpaceDown.current = false;
                      }}
                    />
                    <span className="min-w-0 wrap-break-word">
                      Also rename on{" "}
                      <span className="font-mono">{boxRemote}</span>
                    </span>
                  </label>
                  {tickReason !== null && (
                    <span className="min-w-0 wrap-break-word text-warning">
                      {/* The dash is visual only: the description is the
                        reason alone. */}
                      <span aria-hidden>— </span>
                      <span id={tickReasonId}>{tickReason}</span>
                    </span>
                  )}
                </div>
                {helperLine}
                {/* Mounted with the box, so a line that appears is announced
                  once; its text changes in place. */}
                {/* Empty, it cancels the helper's bottom margin; never hidden,
                  which would take the region out of the accessibility tree. */}
                <div role="status" className="space-y-1.5 pl-6 empty:-mt-2">
                  {statusLine}
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeDialog}>
              {running !== undefined ? "Close" : "Cancel"}
            </Button>
            <span
              className={cn(
                "inline-flex",
                submitHold.blockedReason && "cursor-not-allowed",
              )}
              title={submitHold.wrapperTitle}
            >
              <renameForm.AppForm>
                <renameForm.SubmitButton
                  // Every hold carries a reason, so the button is never
                  // natively disabled and keeps its tab stop.
                  focusableWhenDisabled
                  render={heldButtonRender(submitHeld !== null || localDone)}
                  disabled={submitHeld !== null || localDone}
                  pending={running !== undefined || localDone}
                  variant={confirmShown ? "destructive" : "default"}
                  aria-describedby={submitHold.describedBy}
                  className={ARIA_DISABLED_CLASS}
                >
                  {confirmShown ? "Rename anyway" : "Rename"}
                </renameForm.SubmitButton>
              </renameForm.AppForm>
              {submitHold.blockedReason !== null && (
                <span id={submitHold.reasonId} className="sr-only">
                  {submitHold.blockedReason}
                </span>
              )}
            </span>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
