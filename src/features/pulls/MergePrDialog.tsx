import {
  ArrowCounterClockwiseIcon,
  PencilSimpleIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { DIALOG_SCROLL } from "@/components/dialog-scroll";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { LabeledGroup } from "@/components/form/labeled-group";
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
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { SUMMARY_BUDGET } from "@/features/commit/summary-counter";
import { useRetryFocusRescue } from "@/features/conversations/ConversationListPanel";
import { clipTitleFromText } from "@/lib/clip-title";
import {
  type MergeCommitKind,
  type MergeMessageCommit,
  type NoMergeMessageReason,
  UNKNOWN_HOST,
} from "@/lib/git/types";
import { eventToBinding, SUBMIT_HINT } from "@/lib/hotkeys/binding";
import { ACT_PENDING_REASON } from "@/lib/offline-writes";
import {
  ARIA_DISABLED_CLASS,
  useDisabledReason,
} from "@/lib/use-disabled-reason";
import { cn } from "@/lib/utils";
import {
  bodyLineCount,
  type MergeMessageDraft,
  type MergeMessagePlan,
  mergeMessageHold,
  normalizeTitle,
  type RowDraft,
  rowChanged,
  titleLength,
} from "./merge-message";

type MergeTarget =
  | { kind: "remote"; number: number; host: string; prNoun: string }
  | { kind: "local" };

interface MergePrDialogProps {
  open: boolean;
  onClose: () => void;
  target: MergeTarget;
  headRefName: string;
  baseRefName: string;
  strategyLabel: string;
  /** Omitted = no delete-branch option (local PRs have none). `headIsDefault`
   *  hides it (every forge refuses that delete); `blocked` (a branch rule)
   *  shows it disabled. */
  deleteBranch?: {
    checked: boolean;
    onChange: (v: boolean) => void;
    headIsDefault: boolean;
    blocked: boolean;
  };
  pending: boolean;
  /** The host's own hold: offline (remote), the merge gate (local). */
  heldReason?: string;
  onConfirm: () => void;
  /** Arms merge-when-pipeline-succeeds instead of merging now (GitLab-only). */
  auto?: boolean;
  /** Extra scope this merge takes with it (a cascading stack), shown above the
   *  options. */
  stackNotice?: string;
  /** Overrides the confirm's label so a stacked merge can name how many PRs it
   *  lands. Absent = the strategy label. */
  confirmLabel?: string;
  /** Its `plan` is the one the dialog renders and holds on, the same object the
   *  host's confirm reads. */
  draft: MergeMessageDraft;
  /** The last attempt's failure text, shown because the text was kept. */
  failure?: string;
  /** Where focus lands when the dialog closes (Base UI's `finalFocus`), given
   *  the dialog's popup; absent = the default return to the element that
   *  opened it. */
  finalFocus?: (popup: HTMLElement | null) => boolean;
}

/** Close-time focus, in order: focus the user moved out of the dialog stays
 *  where it is (`false`); a connected footer takes Base UI's default return
 *  (`true`); with no connected frame, the default return too (`true`); else
 *  focus moves to the frame itself (`false`: Base UI would pick a non-tabbable
 *  target's first tabbable child). */
export function mergeDialogFinalFocus(
  footer: HTMLElement | null,
  frame: HTMLElement | null,
  popup: HTMLElement | null,
  active: Element | null = document.activeElement,
): boolean {
  const moved =
    active !== null &&
    active !== active.ownerDocument.body &&
    !popup?.contains(active);
  if (moved) return false;
  if (footer?.isConnected) return true;
  if (!frame?.isConnected) return true;
  frame.focus({ preventScroll: true });
  return false;
}

/** Marks the message fields: the only targets the Ctrl/Cmd+Enter chord merges
 *  from. */
const FIELD_ATTR = "data-merge-message-field";

const NO_MESSAGE_LINE: Record<
  NoMergeMessageReason,
  (head: string, base: string) => string
> = {
  rebase: () =>
    "Rebase and merge keeps each commit's own message, so there is no merge message to edit.",
  fastForward: () =>
    "A fast-forward moves the branch without writing a commit, so there is no merge message to edit.",
  stacked: () =>
    "A stacked merge can land several pull requests, and one message can't cover them all, so there is no merge message to edit.",
  gitlabFastForward: () =>
    "This project fast-forwards its merges, so GitLab writes no merge commit and there is no merge message to edit.",
  alreadyMerged: (head, base) =>
    `${head} is already part of ${base}, so this merge writes no commit and there is no merge message to edit.`,
};

interface RowNames {
  caption: string;
  edit: string;
  reset: string;
  title: string;
  description: string;
  hold: string;
}

const ONE_ROW: RowNames = {
  caption: "Commit message",
  edit: "Edit commit message",
  reset: "Reset to default",
  title: "Commit title",
  description: "Commit description",
  hold: "Add a title, or reset to the default.",
};

const TWO_ROWS: Record<MergeCommitKind, RowNames> = {
  squash: {
    caption: "Squash commit",
    edit: "Edit squash commit message",
    reset: "Reset to default, squash commit message",
    title: "Squash commit title",
    description: "Squash commit description",
    hold: "Add a title to the squash commit message, or reset it to the default.",
  },
  merge: {
    caption: "Merge commit",
    edit: "Edit merge commit message",
    reset: "Reset to default, merge commit message",
    title: "Merge commit title",
    description: "Merge commit description",
    hold: "Add a title to the merge commit message, or reset it to the default.",
  },
};

/** The host label where it opens a sentence: the unknown-provider fallback is
 *  lowercase for mid-sentence use, so it takes a capital there. */
function hostLead(host: string): string {
  return host === UNKNOWN_HOST
    ? host.charAt(0).toUpperCase() + host.slice(1)
    : host;
}

const UNCHANGED_FOOTER: Record<MergeCommitKind, (host: string) => string> = {
  squash: (host) => `${host}'s default for a squash merge.`,
  merge: (host) => `${host}'s default for a merge commit.`,
};

type TitleInputs = Partial<Record<MergeCommitKind, HTMLElement | null>>;

function linesLabel(n: number): string {
  return n === 1 ? "+1 line" : `+${n} lines`;
}

/** The open row's footer line; the first matching rule wins. */
function rowFooter(
  row: RowDraft,
  commit: MergeMessageCommit,
  ctx: { host: string; local: boolean; auto: boolean },
): { text: string; warn: boolean } {
  const changed = rowChanged(row);
  const title = normalizeTitle(row.title);
  if (changed && title === "")
    return { text: "Add a title, or reset to the default.", warn: true };
  const length = titleLength(row.title);
  if (length > SUMMARY_BUDGET)
    return {
      text: `Title is ${length} characters, over the ${SUMMARY_BUDGET}-character guideline.`,
      warn: true,
    };
  if (changed) {
    if (ctx.local)
      return { text: "Edited. The merge uses this message.", warn: false };
    if (ctx.auto)
      return {
        text: `Edited. ${hostLead(ctx.host)} writes this message when the pipeline passes and the merge lands.`,
        warn: false,
      };
    return {
      text: `Edited. ${hostLead(ctx.host)} writes this message instead of its default.`,
      warn: false,
    };
  }
  if (row.baseline === null)
    return {
      text: `Leave this blank and ${ctx.host} writes its default message.`,
      warn: false,
    };
  if (!commit.exact)
    return {
      text: `A draft in ${ctx.host}'s default format. Leave it unchanged and ${ctx.host} writes its own default.`,
      warn: false,
    };
  if (ctx.local)
    return {
      text: "From the pull request's title and description.",
      warn: false,
    };
  return {
    text: UNCHANGED_FOOTER[commit.kind](hostLead(ctx.host)),
    warn: false,
  };
}

const failedLine = (host: string) =>
  `Couldn't load ${host}'s default message. Without it, ${host} writes its own default.`;
const offlineLine = (host: string) =>
  `You're offline, so ${host}'s default message can't load.`;

const RESET_DONE = "Message reset to the default";

/** The sr-only status line: fixed text per state, so typing never re-announces.
 *  A defaults read that failed or parked offline is announced, not only shown. */
function statusText(s: {
  held: boolean;
  long: boolean;
  resetDone: boolean;
  plan: MergeMessagePlan["state"];
  host: string;
}): string {
  if (s.held) return "The title is empty, so the merge is held";
  // A just-pressed Reset outranks the length line, which an unchanged long
  // default would otherwise hold for good; the next edit brings it back.
  if (s.resetDone) return RESET_DONE;
  if (s.long) return `Title is over ${SUMMARY_BUDGET} characters`;
  if (s.plan === "failed") return failedLine(s.host);
  if (s.plan === "offline") return offlineLine(s.host);
  return "";
}

/** Merge-confirm dialog with the commit message the merge writes. Presentational:
 *  the host keeps the merge mutation, the defaults read and the draft. */
export function MergePrDialog(props: MergePrDialogProps) {
  const { open, onClose, pending, heldReason, onConfirm, draft } = props;
  const messageHold = mergeMessageHold(draft.rows, draft.plan);
  const held = pending || heldReason !== undefined || messageHold !== null;
  const popupRef = useRef<HTMLDivElement | null>(null);
  const { finalFocus } = props;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent
        // A column capped below the viewport: only the body (message, delete
        // option, failure) scrolls, so the title and the buttons stay in view.
        className="flex max-h-[85vh] flex-col sm:max-w-lg"
        ref={popupRef}
        finalFocus={finalFocus && (() => finalFocus(popupRef.current))}
        // The chord merges only from a message field and is swallowed everywhere
        // else in the dialog, so it never reaches the commit action behind it. On
        // DialogContent: the X close is a sibling of the fields. An IME's
        // committing Enter is the composition's, not the chord's (WebKit may end
        // the composition first, so keyCode 229 is checked too): it keeps its
        // native default and is stopped here, before the app listener would
        // prevent it.
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) {
            if (eventToBinding(e) === "mod+enter") e.stopPropagation();
            return;
          }
          if (eventToBinding(e) !== "mod+enter") return;
          e.preventDefault();
          if (e.repeat || held) return;
          if (!(e.target instanceof HTMLElement)) return;
          if (!e.target.hasAttribute(FIELD_ATTR)) return;
          onConfirm();
        }}
      >
        <MergeDialogBody {...props} messageHold={messageHold} held={held} />
      </DialogContent>
    </Dialog>
  );
}

function MergeDialogBody({
  onClose,
  target,
  headRefName,
  baseRefName,
  strategyLabel,
  deleteBranch,
  pending,
  heldReason,
  onConfirm,
  auto = false,
  stackNotice,
  confirmLabel,
  draft,
  failure,
  messageHold,
  held,
}: MergePrDialogProps & {
  messageHold: MergeCommitKind | null;
  held: boolean;
}) {
  const { plan } = draft;
  const local = target.kind === "local";
  const host = target.kind === "remote" ? target.host : "";
  // The row whose Title takes focus when it mounts: the first open row of a plan
  // ready at the open (a read that lands later never pulls focus), else the row
  // an Edit press opens. Any Title's focus clears it, so a row that leaves the
  // plan and comes back never pulls focus from where the user is typing. Lives
  // with the popup's mount, so each open after the close animation starts
  // afresh; a reopen during it keeps the state.
  const [autoFocusKind, setAutoFocusKind] = useState<MergeCommitKind | null>(
    () =>
      plan.state === "ready"
        ? (plan.defaults.commits.find((c) => draft.rows[c.kind] !== undefined)
            ?.kind ?? null)
        : null,
  );
  const [resetDone, setResetDone] = useState(false);
  // Keys the status line's text node (RESET_DONE after a Reset), so a second
  // Reset with no edit between re-inserts it and the live region announces it
  // again.
  const [resetCount, setResetCount] = useState(0);
  const titleInputs = useRef<TitleInputs>({});
  // The region never remounts across plan states: it is where focus lands when
  // Retry leaves, pressed or swept away by a refetch.
  const region = useRef<HTMLDivElement | null>(null);
  const { hostRef, retryRef } = useRetryFocusRescue(plan.state === "failed");
  const regionRef = useCallback(
    (node: HTMLDivElement | null) => {
      region.current = node;
      hostRef(node);
    },
    [hostRef],
  );
  // A failure lands at the scroller's end, below the message rows: bring it
  // into view when its text changes after the body mounted, never for one it
  // mounted with (a reopen or a re-shown tab keeps Title in view). jsdom has no
  // scrollIntoView, hence the guard.
  const failureRef = useRef<HTMLDivElement | null>(null);
  const seenFailure = useRef(failure);
  useEffect(() => {
    if (failure === seenFailure.current) return;
    seenFailure.current = failure;
    if (failure === undefined) return;
    const node = failureRef.current;
    if (typeof node?.scrollIntoView === "function") {
      node.scrollIntoView({ block: "nearest" });
    }
  }, [failure]);

  const commits = plan.state === "ready" ? plan.defaults.commits : [];
  const two = commits.length > 1;
  const firstOpen = commits.find((c) => draft.rows[c.kind] !== undefined)?.kind;
  // A branch rule's native disable outranks the pending hold.
  const deleteHold = useDisabledReason({
    disabled: pending && deleteBranch?.blocked !== true,
    reason: ACT_PENDING_REASON,
  });
  // The failure's "still here" line is true only while an open row still
  // differs from its default: a Reset makes it false.
  const anyEdited = commits.some((c) => {
    const row = draft.rows[c.kind];
    return row !== undefined && rowChanged(row);
  });
  const anyLong = commits.some((c) => {
    const row = draft.rows[c.kind];
    return row !== undefined && titleLength(row.title) > SUMMARY_BUDGET;
  });

  const holdNames =
    messageHold !== null && two ? TWO_ROWS[messageHold] : ONE_ROW;
  const messageReason = messageHold !== null ? holdNames.hold : undefined;
  const reason = pending ? ACT_PENDING_REASON : (heldReason ?? messageReason);
  const statusLine = statusText({
    held: messageHold !== null,
    long: anyLong,
    resetDone,
    plan: plan.state,
    host,
  });
  const verb = auto ? "Auto-merge" : "Merge";
  const title =
    target.kind === "local"
      ? "Merge local pull request?"
      : `${verb} ${target.prNoun} #${target.number}?`;
  const head = <span className="font-mono break-all">{headRefName}</span>;
  const base = <span className="font-mono break-all">{baseRefName}</span>;

  const description = (() => {
    if (local)
      return (
        <>
          {strategyLabel} — merges {head} into {base} in this repository.
        </>
      );
    if (auto)
      return (
        <>
          {strategyLabel} when the pipeline passes — merges {head} into {base}{" "}
          on {host} once the running pipeline succeeds. This cannot be easily
          undone once it merges.
        </>
      );
    return (
      <>
        {strategyLabel} — merges {head} into {base} on {host}. This cannot be
        easily undone.
      </>
    );
  })();

  const messageContent = (() => {
    switch (plan.state) {
      case "loading":
        return (
          <LabeledGroup label={ONE_ROW.caption} actions={<CaptionActions />}>
            <Skeleton className="h-6 w-full" />
            <p className="text-xs text-muted-foreground">
              Loading {host}'s default…
            </p>
          </LabeledGroup>
        );
      case "offline":
        return (
          <LabeledGroup label={ONE_ROW.caption} actions={<CaptionActions />}>
            <p className="text-xs text-muted-foreground">{offlineLine(host)}</p>
          </LabeledGroup>
        );
      case "failed":
        return (
          <LabeledGroup label={ONE_ROW.caption} actions={<CaptionActions />}>
            <div className="flex items-center gap-2">
              <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                {failedLine(host)}
              </p>
              <DisabledReasonButton
                ref={retryRef}
                variant="outline"
                size="xs"
                disabled={pending}
                reason={ACT_PENDING_REASON}
                onClick={() => {
                  // Focus moves before the read restarts, so a press never
                  // depends on the button's unmount.
                  region.current?.focus({ preventScroll: true });
                  plan.onRetry();
                }}
              >
                Retry
              </DisabledReasonButton>
            </div>
          </LabeledGroup>
        );
      case "ready": {
        if (commits.length === 0) {
          const why = plan.defaults.reason;
          return (
            <LabeledGroup label={ONE_ROW.caption} actions={<CaptionActions />}>
              <p className="text-xs text-muted-foreground">
                {why !== null
                  ? NO_MESSAGE_LINE[why](headRefName, baseRefName)
                  : null}
              </p>
            </LabeledGroup>
          );
        }
        return commits.map((commit) => (
          <MessageRow
            key={commit.kind}
            commit={commit}
            row={draft.rows[commit.kind]}
            names={two ? TWO_ROWS[commit.kind] : ONE_ROW}
            twoRows={two}
            host={host}
            local={local}
            auto={auto}
            autoFocus={commit.kind === autoFocusKind}
            pending={pending}
            titleRef={(node) => {
              titleInputs.current[commit.kind] = node;
            }}
            onTitleFocus={() => setAutoFocusKind(null)}
            onEdit={() => {
              setAutoFocusKind(commit.kind);
              setResetDone(false);
              draft.edit(commit.kind);
            }}
            onChange={(patch) => {
              setResetDone(false);
              draft.change(commit.kind, patch);
            }}
            onReset={() => {
              // The Reset button unmounts with the change, so focus moves first.
              titleInputs.current[commit.kind]?.focus();
              setResetDone(true);
              setResetCount((n) => n + 1);
              draft.resetRow(commit.kind);
            }}
          />
        ));
      }
    }
  })();

  return (
    <>
      <DialogHeader>
        <DialogTitle className="pr-8">{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      {/* A stacked merge lands more than the PR on screen: say so above the
          options, never only on the confirm button. */}
      {stackNotice && <p className="text-xs text-warning">{stackNotice}</p>}
      {/* The one scroller: message, delete option and failure scroll together,
          with no nested scroller. The vertical inset keeps a focus ring flush
          with its top or bottom edge unclipped. */}
      <div
        className={cn(
          DIALOG_SCROLL,
          "-my-1 min-h-0 min-w-0 flex-1 space-y-4 py-1",
        )}
      >
        <div
          ref={regionRef}
          tabIndex={-1}
          aria-busy={plan.state === "loading" ? true : undefined}
          className="ph-no-capture space-y-4 outline-none"
        >
          {messageContent}
        </div>
        {/* Deleting the head after merge is offered only when it's actually
          possible: never for the default branch (hidden: the forge refuses),
          and disabled with a reason when a branch rule blocks its deletion.
          While the merge runs it is held readOnly, so focus and its reason
          stay. */}
        {deleteBranch !== undefined && !deleteBranch.headIsDefault && (
          <label
            className={cn(
              "flex items-start gap-2 text-xs text-muted-foreground",
              deleteBranch.blocked && "opacity-70",
              deleteBranch.blocked || deleteHold.blockedReason !== null
                ? "cursor-not-allowed"
                : "cursor-pointer",
            )}
            title={deleteHold.wrapperTitle}
          >
            {deleteHold.blockedReason !== null && (
              <span id={deleteHold.reasonId} hidden>
                {deleteHold.blockedReason}
              </span>
            )}
            <Checkbox
              checked={deleteBranch.checked && !deleteBranch.blocked}
              disabled={deleteBranch.blocked}
              readOnly={deleteHold.blockedReason !== null}
              // Set for both holds: an explicit prop replaces Base UI's own.
              aria-disabled={
                deleteBranch.blocked ||
                deleteHold.blockedReason !== null ||
                undefined
              }
              aria-describedby={deleteHold.describedBy}
              className={ARIA_DISABLED_CLASS}
              onCheckedChange={(checked) =>
                deleteBranch.onChange(checked === true)
              }
            />
            <span className="min-w-0">
              Delete {head} on the remote after merging
              {deleteBranch.blocked && (
                <span className="text-warning">
                  {" "}
                  — protected by a branch rule
                </span>
              )}
            </span>
          </label>
        )}
        {failure !== undefined && (
          <div
            ref={failureRef}
            role="alert"
            className="flex items-start gap-1.5 text-xs text-destructive"
          >
            <WarningIcon aria-hidden className="mt-px size-3.5 shrink-0" />
            <div className="min-w-0 space-y-0.5">
              <p className="break-words">{failure}</p>
              {anyEdited && <p>Your edited message is still here.</p>}
            </div>
          </div>
        )}
      </div>
      <span role="status" className="sr-only" data-merge-message-status="">
        {statusLine === RESET_DONE ? (
          <span key={resetCount}>{statusLine}</span>
        ) : (
          statusLine
        )}
      </span>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        {/* Every hold carries a reason, so the button stays aria-disabled and
            focusable through each flip. */}
        <DisabledReasonButton
          disabled={held}
          reason={reason}
          // The chord works only from an open message field, and a hold's
          // reason tooltip outranks the hint.
          title={held || firstOpen === undefined ? undefined : SUBMIT_HINT}
          onClick={onConfirm}
        >
          {pending && <Spinner data-icon="inline-start" />}
          {auto ? "Enable auto-merge" : (confirmLabel ?? strategyLabel)}
        </DisabledReasonButton>
      </DialogFooter>
    </>
  );
}

/** A row's caption line is 24px in every state, so nothing below it moves when
 *  Reset comes or goes. Always passed: LabeledGroup drops the row when the
 *  actions are falsy. */
function CaptionActions({ children }: { children?: ReactNode }) {
  return <span className="flex h-6 items-center">{children}</span>;
}

function MessageRow({
  commit,
  row,
  names,
  twoRows,
  host,
  local,
  auto,
  autoFocus,
  pending,
  titleRef,
  onTitleFocus,
  onEdit,
  onChange,
  onReset,
}: {
  commit: MergeMessageCommit;
  row: RowDraft | undefined;
  names: RowNames;
  twoRows: boolean;
  host: string;
  local: boolean;
  auto: boolean;
  autoFocus: boolean;
  /** The merge is in flight: the fields go readOnly and the row's buttons are
   *  held with a reason, so focus and the text stay where they are. */
  pending: boolean;
  titleRef: (node: HTMLElement | null) => void;
  onTitleFocus: () => void;
  onEdit: () => void;
  onChange: (patch: Partial<Pick<RowDraft, "title" | "body">>) => void;
  onReset: () => void;
}) {
  const footId = useId();
  const changed = row !== undefined && rowChanged(row);
  // A newer default can make the row unchanged with no press, unmounting Reset
  // under the user's focus: focus then lands on this row's Title.
  const { hostRef, retryRef } = useRetryFocusRescue(changed);
  if (row === undefined) {
    // A draft (Bitbucket) or an unknown default is never shown as the forge's
    // own text.
    const shown = commit.exact ? commit.message : null;
    const lines = shown !== null ? bodyLineCount(shown.body) : 0;
    return (
      <LabeledGroup label={names.caption} actions={<CaptionActions />}>
        <div className="flex min-h-6 min-w-0 items-center gap-2 text-xs">
          {shown !== null ? (
            <span
              className="min-w-0 flex-1 truncate"
              onMouseEnter={clipTitleFromText}
            >
              {shown.title}
            </span>
          ) : (
            <span
              className="min-w-0 flex-1 truncate text-muted-foreground"
              onMouseEnter={clipTitleFromText}
            >
              {hostLead(host)}'s default message
            </span>
          )}
          {lines > 0 && (
            <span className="shrink-0 text-muted-foreground">
              {linesLabel(lines)}
            </span>
          )}
          <DisabledReasonButton
            variant="ghost"
            size="xs"
            aria-label={names.edit}
            disabled={pending}
            reason={ACT_PENDING_REASON}
            onClick={onEdit}
          >
            <PencilSimpleIcon data-icon="inline-start" aria-hidden />
            Edit
          </DisabledReasonButton>
        </div>
      </LabeledGroup>
    );
  }
  const emptyTitle = changed && normalizeTitle(row.title) === "";
  const footer = rowFooter(row, commit, { host, local, auto });
  return (
    <LabeledGroup
      label={names.caption}
      actions={
        <CaptionActions>
          {changed ? (
            <DisabledReasonButton
              ref={retryRef}
              variant="ghost"
              size="xs"
              aria-label={twoRows ? names.reset : undefined}
              disabled={pending}
              reason={ACT_PENDING_REASON}
              onClick={onReset}
            >
              <ArrowCounterClockwiseIcon data-icon="inline-start" aria-hidden />
              Reset to default
            </DisabledReasonButton>
          ) : null}
        </CaptionActions>
      }
    >
      <div className="space-y-1.5">
        <Input
          ref={(node) => {
            titleRef(node);
            hostRef(node);
          }}
          // Mounts in place of the Edit button, which takes focus with it.
          autoFocus={autoFocus}
          onFocus={onTitleFocus}
          value={row.title}
          readOnly={pending}
          placeholder="Title"
          aria-label={names.title}
          aria-invalid={emptyTitle || undefined}
          aria-describedby={footId}
          // An emptied title is a hold the footer explains in amber, so the
          // field shares that one severity instead of the vendored red.
          className="aria-invalid:border-warning aria-invalid:ring-warning/20 dark:aria-invalid:border-warning/50 dark:aria-invalid:ring-warning/40"
          data-merge-message-field=""
          onChange={(e) => onChange({ title: e.target.value })}
        />
        <Textarea
          value={row.body}
          readOnly={pending}
          placeholder="Description (optional)"
          aria-label={names.description}
          className="max-h-32 min-h-16 resize-none overflow-y-auto"
          data-merge-message-field=""
          onChange={(e) => onChange({ body: e.target.value })}
        />
        <p
          id={footId}
          className={cn(
            "flex items-start gap-1.5 text-xs",
            footer.warn ? "text-warning" : "text-muted-foreground",
          )}
        >
          {footer.warn && (
            <WarningIcon aria-hidden className="mt-px size-3.5 shrink-0" />
          )}
          <span>{footer.text}</span>
        </p>
      </div>
    </LabeledGroup>
  );
}
