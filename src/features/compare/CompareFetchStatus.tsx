import { WarningIcon } from "@phosphor-icons/react";
import { type RefObject, useCallback, useLayoutEffect, useRef } from "react";
import { Spinner } from "@/components/ui/spinner";
import { useRetryFocusRescue } from "@/features/conversations/ConversationListPanel";
import {
  ARIA_DISABLED_CLASS,
  useDisabledReason,
} from "@/lib/use-disabled-reason";
import { cn } from "@/lib/utils";
import { GONE_PICK_COPY, UPDATING_COMPARISON_COPY } from "./compare-remote-ref";

/** The `upstream-*` arms are the add-upstream follow-up's: it changes no pick,
 *  so they claim nothing about the comparison on screen. */
export type CompareFetchStatusState =
  | "fetching"
  | "updating"
  | "failed"
  | "offline"
  | "pruned"
  | "pruned-fetch-failed"
  | "remote-gone"
  | "missing"
  | "missing-fetch-failed"
  | "upstream-fetching"
  | "upstream-failed"
  | "upstream-offline";

const fetchFailedLead = (remote: string) => `Couldn't fetch ${remote}.`;

const STATUS_COPY: Record<
  CompareFetchStatusState,
  (remote: string, name: string) => string
> = {
  fetching: (remote) => `Fetching ${remote}…`,
  updating: () => UPDATING_COMPARISON_COPY,
  failed: (remote) =>
    `Couldn't fetch ${remote}, so this compares against its last fetch.`,
  offline: (remote) =>
    `You're offline, so this compares against ${remote}'s last fetch.`,
  pruned: GONE_PICK_COPY.pruned,
  "pruned-fetch-failed": (remote, name) =>
    `${fetchFailedLead(remote)} ${GONE_PICK_COPY.pruned(remote, name)}`,
  "remote-gone": GONE_PICK_COPY["remote-gone"],
  missing: GONE_PICK_COPY.missing,
  "missing-fetch-failed": (remote, name) =>
    `${fetchFailedLead(remote)} ${GONE_PICK_COPY.missing(remote, name)}`,
  "upstream-fetching": (remote) => `Fetching ${remote}…`,
  "upstream-failed": fetchFailedLead,
  "upstream-offline": (remote) =>
    `You're offline. ${remote} will be fetched when you reconnect.`,
};

/** Warning arms carry an icon beside the words, never the color alone. */
const STATUS_ICON: Record<CompareFetchStatusState, "spinner" | "warning"> = {
  fetching: "spinner",
  updating: "spinner",
  failed: "warning",
  offline: "warning",
  pruned: "warning",
  "pruned-fetch-failed": "warning",
  "remote-gone": "warning",
  missing: "warning",
  "missing-fetch-failed": "warning",
  "upstream-fetching": "spinner",
  "upstream-failed": "warning",
  "upstream-offline": "warning",
};

type StatusActionKind = "retry" | "fetch" | "pick-another";

const GONE_ACTIONS: readonly StatusActionKind[] = ["fetch", "pick-another"];

const STATUS_ACTIONS: Partial<
  Record<CompareFetchStatusState, readonly StatusActionKind[]>
> = {
  failed: ["retry"],
  "upstream-failed": ["retry"],
  pruned: GONE_ACTIONS,
  "pruned-fetch-failed": GONE_ACTIONS,
  "remote-gone": ["pick-another"],
  missing: GONE_ACTIONS,
  "missing-fetch-failed": GONE_ACTIONS,
};

const NO_ACTIONS: readonly StatusActionKind[] = [];

/**
 * The Compare picker's fetch line: full width, in layout flow under the picker
 * row, so it pushes the buttons down rather than covering anything. Always
 * mounted, empty and sr-only when idle, so its polite live region announces
 * the text that arrives; idle, it carries no margin. Each action keeps one
 * fixed slot and its own rescue: one that leaves while focused lands focus on
 * the box (never `<body>`), and the box hands focus to `idleFocusRef` when it
 * goes idle while holding it.
 */
export function CompareFetchStatus({
  state,
  remote,
  name,
  onRetry,
  onFetch,
  fetchHeldReason,
  onPickAnother,
  idleFocusRef,
}: {
  state: CompareFetchStatusState | null;
  remote: string;
  name: string;
  onRetry: () => void;
  onFetch: () => void;
  /** Why Fetch is held (offline), or null while it can run. */
  fetchHeldReason: string | null;
  onPickAnother: () => void;
  idleFocusRef: RefObject<HTMLElement | null>;
}) {
  const actions =
    state === null ? NO_ACTIONS : (STATUS_ACTIONS[state] ?? NO_ACTIONS);
  const retry = useRetryFocusRescue(actions.includes("retry"));
  const fetch = useRetryFocusRescue(actions.includes("fetch"));
  const pickAnother = useRetryFocusRescue(actions.includes("pick-another"));
  const box = useRef<HTMLDivElement | null>(null);
  const retryHost = retry.hostRef;
  const fetchHost = fetch.hostRef;
  const pickAnotherHost = pickAnother.hostRef;
  const setBox = useCallback(
    (node: HTMLDivElement | null) => {
      box.current = node;
      retryHost(node);
      fetchHost(node);
      pickAnotherHost(node);
    },
    [retryHost, fetchHost, pickAnotherHost],
  );
  // An sr-only box would hold focus on an invisible 1px element.
  useLayoutEffect(() => {
    if (state === null && box.current && document.activeElement === box.current)
      idleFocusRef.current?.focus({ preventScroll: true });
  }, [state, idleFocusRef]);
  return (
    <div
      ref={setBox}
      tabIndex={-1}
      className={
        state === null
          ? "sr-only outline-none"
          : "mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 px-1 text-[11px] text-muted-foreground outline-none"
      }
    >
      {state !== null && <StatusIcon kind={STATUS_ICON[state]} />}
      <p role="status" className="min-w-0">
        {state === null ? null : STATUS_COPY[state](remote, name)}
      </p>
      {actions.includes("retry") && (
        <span ref={retry.retryRef} className="contents">
          <StatusAction onClick={onRetry}>Retry</StatusAction>
        </span>
      )}
      {actions.includes("fetch") && (
        <span ref={fetch.retryRef} className="contents">
          <StatusAction onClick={onFetch} heldReason={fetchHeldReason}>
            {`Fetch ${remote}`}
          </StatusAction>
        </span>
      )}
      {actions.includes("pick-another") && (
        <span ref={pickAnother.retryRef} className="contents">
          <StatusAction onClick={onPickAnother}>
            Pick another branch
          </StatusAction>
        </span>
      )}
    </div>
  );
}

function StatusIcon({ kind }: { kind: "spinner" | "warning" }) {
  if (kind === "spinner")
    return <Spinner aria-hidden className="size-3 shrink-0" />;
  return (
    <WarningIcon
      aria-hidden
      weight="fill"
      className="size-3.5 shrink-0 text-warning"
    />
  );
}

function StatusAction({
  onClick,
  heldReason = null,
  children,
}: {
  onClick: () => void;
  /** Held, still focusable, with this reason announced; a press does nothing. */
  heldReason?: string | null;
  children: string;
}) {
  const { blockedReason, reasonId, wrapperTitle, describedBy, nativeProps } =
    useDisabledReason({
      disabled: heldReason !== null,
      reason: heldReason,
      onClick,
    });
  return (
    <span
      className={cn("inline-flex", blockedReason && "cursor-not-allowed")}
      title={wrapperTitle}
    >
      <button
        type="button"
        {...nativeProps}
        aria-describedby={describedBy}
        className={cn(
          "cursor-pointer text-foreground underline underline-offset-2 outline-none",
          "focus-visible:ring-1 focus-visible:ring-ring/50",
          ARIA_DISABLED_CLASS,
        )}
      >
        {children}
      </button>
      {blockedReason ? (
        <span id={reasonId} className="sr-only">
          {blockedReason}
        </span>
      ) : null}
    </span>
  );
}
