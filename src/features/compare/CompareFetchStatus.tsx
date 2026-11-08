import { WarningIcon } from "@phosphor-icons/react";
import { type RefObject, useCallback, useLayoutEffect, useRef } from "react";
import { Spinner } from "@/components/ui/spinner";
import { useRetryFocusRescue } from "@/features/conversations/ConversationListPanel";
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
  | "remote-gone"
  | "missing"
  | "upstream-fetching"
  | "upstream-failed"
  | "upstream-offline";

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
  "remote-gone": GONE_PICK_COPY["remote-gone"],
  missing: GONE_PICK_COPY.missing,
  "upstream-fetching": (remote) => `Fetching ${remote}…`,
  "upstream-failed": (remote) => `Couldn't fetch ${remote}.`,
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
  "remote-gone": "warning",
  missing: "warning",
  "upstream-fetching": "spinner",
  "upstream-failed": "warning",
  "upstream-offline": "warning",
};

const STATUS_ACTION: Partial<
  Record<CompareFetchStatusState, "retry" | "pick-another">
> = {
  failed: "retry",
  "upstream-failed": "retry",
  pruned: "pick-another",
  "remote-gone": "pick-another",
  missing: "pick-another",
};

/**
 * The Compare picker's fetch line: full width, in layout flow under the picker
 * row, so it pushes the buttons down rather than covering anything. Always
 * mounted, empty and sr-only when idle, so its polite live region announces
 * the text that arrives; idle, it carries no margin. Retry unmounts when
 * pressed and "Pick another branch" once the pick changes; the box is the
 * focus landing that keeps focus off `<body>`, and it hands focus to
 * `idleFocusRef` when it goes idle while holding it.
 */
export function CompareFetchStatus({
  state,
  remote,
  name,
  onRetry,
  onPickAnother,
  idleFocusRef,
}: {
  state: CompareFetchStatusState | null;
  remote: string;
  name: string;
  onRetry: () => void;
  onPickAnother: () => void;
  idleFocusRef: RefObject<HTMLElement | null>;
}) {
  const action = state === null ? undefined : STATUS_ACTION[state];
  const { hostRef, retryRef } = useRetryFocusRescue(action !== undefined);
  const box = useRef<HTMLDivElement | null>(null);
  const setBox = useCallback(
    (node: HTMLDivElement | null) => {
      box.current = node;
      hostRef(node);
    },
    [hostRef],
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
      {action && (
        <span ref={retryRef} className="contents">
          {action === "retry" && (
            <StatusAction onClick={onRetry}>Retry</StatusAction>
          )}
          {action === "pick-another" && (
            <StatusAction onClick={onPickAnother}>
              Pick another branch
            </StatusAction>
          )}
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
  children,
}: {
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "cursor-pointer text-foreground underline underline-offset-2 outline-none",
        "focus-visible:ring-1 focus-visible:ring-ring/50",
      )}
    >
      {children}
    </button>
  );
}
