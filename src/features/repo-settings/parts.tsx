import {
  type ComponentProps,
  Fragment,
  type ReactNode,
  type Ref,
  useMemo,
  useState,
} from "react";
import { CopyIconButton } from "@/components/CopyIconButton";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  DegradedListNotice,
  useRetryFocusRescue,
} from "@/features/conversations/ConversationListPanel";
import {
  isPermanentListError,
  offlinePendingMessage,
  parkedUnlessPermanent,
  resolveRemoteSection,
  sectionReadNotice,
} from "@/features/conversations/remote-section-state";
import { highlightJson } from "@/features/diff/shiki-highlighter";
import { presentError } from "@/lib/error-summary";
import {
  isReconnectHostSafe,
  reconnectHostArg,
  useActiveGhHost,
} from "@/lib/git/host";
import { useGhScopes } from "@/lib/git/queries";
import { useUiStore } from "@/lib/stores/ui";
import {
  ARIA_DISABLED_CLASS,
  useDisabledReason,
} from "@/lib/use-disabled-reason";
import { cn } from "@/lib/utils";

/**
 * The destructive error card the repo-settings surfaces share: a title, the
 * failure as one humanized line, then any hint. `presentError` is what makes the
 * line humanized, and it reads the plain `AppError` object every `invoke`
 * rejection carries, which is not an `Error` instance.
 * `children` render between message and hint — the slot the scope note takes,
 * which needs hooks this card shouldn't own.
 * A Retry press resets a never-loaded read to pending, which unmounts this card:
 * the caller owns the `useRetryFocusRescue` host that `retryRef` reports to.
 */
export function AsyncErrorCard({
  title,
  error,
  hint,
  children,
  onRetry,
  retryLabel,
  retryRef,
}: {
  title: ReactNode;
  error: unknown;
  /** A closing note in the card's own muted style (permissions, next steps). */
  hint?: ReactNode;
  children?: ReactNode;
  /** Omitted for a failure a retry can't change. */
  onRetry?: () => void;
  /** The Retry button's accessible name ("Retry loading webhooks"). */
  retryLabel?: string;
  retryRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
      <p className="font-medium text-destructive">{title}</p>
      {error != null && (
        <p className="mt-1 text-muted-foreground">
          {presentError(error).summary}
        </p>
      )}
      {children}
      {hint && <div className="mt-2 text-muted-foreground">{hint}</div>}
      {onRetry && (
        <Button
          ref={retryRef}
          variant="outline"
          size="xs"
          className="mt-2"
          aria-label={retryLabel}
          onClick={onRetry}
        >
          Retry
        </Button>
      )}
    </div>
  );
}

/** The one reason every remote-write control in repo settings gives while
 *  offline: a mutation pressed then parks silently and fires on reconnect. */
export const OFFLINE_WRITE_REASON =
  "You're offline — this will be available once you're back online.";

/** The hold reason while a row's last change is still saving. */
export const SAVING_REASON = "Saving your last change…";

/** What a {@link RemoteFormSection} with loaded fields says over them. */
function formNoticeMessage(noun: string, failed: boolean): string {
  return failed
    ? `Couldn't refresh ${noun} — showing the last loaded version.`
    : "You're offline — showing the last loaded version.";
}

/**
 * A repo-settings form over one read. Gated on absent data, not on `isError`:
 * react-query keeps the last good data beside a failed refetch, and swapping the
 * form for the error card there would discard the user's draft, so a loaded form
 * stays under a refresh notice instead. With nothing loaded, a parked read says
 * it's offline where a skeleton would spin forever. Settled by omission, like
 * {@link RemoteListSection}: no `fetching`, so a Retry survives its own press.
 */
export function RemoteFormSection<T>({
  query,
  noun,
  skeleton,
  errorTitle,
  errorHint,
  children,
}: {
  query: {
    data: T | undefined;
    error: unknown;
    isError: boolean;
    isPaused: boolean;
    refetch: () => unknown;
  };
  /** What the section loads, as its notices read it ("Pages settings"). */
  noun: string;
  skeleton: ReactNode;
  errorTitle: string;
  errorHint?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  const data = query.data;
  const parked = parkedUnlessPermanent(query);
  const failed = query.isError && !parked;
  const coldRetry =
    failed && data === undefined && !isPermanentListError(query.error);
  const { hostRef, retryRef } = useRetryFocusRescue(coldRetry);
  const retry = () => void query.refetch();
  const retryLabel = `Retry loading ${noun}`;
  const noticeMessage = (() => {
    if (data === undefined)
      return parked ? offlinePendingMessage(noun) : undefined;
    return failed || parked ? formNoticeMessage(noun, failed) : undefined;
  })();
  const body = (() => {
    if (data !== undefined) return children(data);
    if (parked) return null;
    return query.isError ? (
      <AsyncErrorCard
        title={errorTitle}
        error={query.error}
        hint={errorHint}
        onRetry={coldRetry ? retry : undefined}
        retryLabel={retryLabel}
        retryRef={retryRef}
      />
    ) : (
      skeleton
    );
  })();
  return (
    <div ref={hostRef} tabIndex={-1} className="min-w-0 space-y-3 outline-none">
      <DegradedListNotice
        noun={noun}
        degraded={noticeMessage !== undefined}
        message={noticeMessage}
        retryLabel={retryLabel}
        onRetry={data !== undefined && failed ? retry : undefined}
        className="px-0 pb-0"
      />
      {body}
    </div>
  );
}

/**
 * {@link RemoteListSection}'s body: skeletons while loading, a destructive error
 * card (optionally with a `gh auth refresh` scope hint or a custom hint) on
 * error, a dashed placeholder when empty, else the rows. Module-private on
 * purpose: a section handing it a raw query error would swap retained rows for
 * the error card, so sections reach it only through the ladder.
 */
function AsyncListBody({
  loading,
  error,
  empty,
  emptyLabel,
  children,
  skeletonClassName = "h-10 w-full",
  errorTitle = "Couldn't load these.",
  errorScope,
  errorHint,
  onRetry,
  retryLabel,
  retryRef,
}: {
  loading: boolean;
  error: unknown;
  empty: boolean;
  emptyLabel: string;
  children: ReactNode;
  /** Skeleton size, sized to roughly match each section's row height. */
  skeletonClassName?: string;
  errorTitle?: string;
  /** Renders the standard "needs a broader scope" note in the error card — with a
   *  reconnect button when the sign-in is a refreshable classic token. */
  errorScope?: string;
  /** A custom hint node in the error card, for sections without a single scope. */
  errorHint?: ReactNode;
  /** The error card's Retry, per {@link AsyncErrorCard}. */
  onRetry?: () => void;
  retryLabel?: string;
  retryRef?: Ref<HTMLButtonElement>;
}) {
  if (loading) {
    return (
      <div className="space-y-2">
        <Skeleton className={skeletonClassName} />
        <Skeleton className={skeletonClassName} />
      </div>
    );
  }
  if (error) {
    return (
      <AsyncErrorCard
        title={errorTitle}
        error={error}
        hint={errorHint}
        onRetry={onRetry}
        retryLabel={retryLabel}
        retryRef={retryRef}
      >
        {errorScope && <ScopeErrorHint scope={errorScope} />}
      </AsyncErrorCard>
    );
  }
  if (empty) {
    return (
      <p className="rounded-md border border-dashed py-8 text-center text-xs text-muted-foreground">
        {emptyLabel}
      </p>
    );
  }
  return <div className="space-y-2">{children}</div>;
}

/**
 * A repo-settings list over one read, on the remote-section ladder: a failed or
 * parked refresh keeps the loaded rows under a notice, and only a read with
 * nothing loaded falls back to the error card or the offline line. Settled by
 * omission: the resolvers get no `fetching`, so the notice and its Retry stay
 * mounted through an in-flight retry rather than unmounting under the press.
 */
export function RemoteListSection({
  query,
  rowCount,
  noun,
  loadFailed,
  extraPaused = false,
  emptyLabel,
  skeletonClassName,
  errorTitle,
  errorScope,
  errorHint,
  children,
}: {
  query: {
    data: unknown;
    error: unknown;
    isPending: boolean;
    isError: boolean;
    isPaused: boolean;
    refetch: () => unknown;
  };
  /** The rows drawn, which the notice reads only once data has loaded. */
  rowCount: number;
  /** Plural, as the notice reads it ("webhooks"). */
  noun: string;
  /** `sectionReadNotice`'s line for a failure with nothing loaded. Never shown
   *  here: that failure draws the error card, and the notice stays silent. */
  loadFailed: string;
  /** A park the list read can't report itself: a read it depends on waiting
   *  for a connection leaves this one idle, not paused. */
  extraPaused?: boolean;
  emptyLabel: string;
  skeletonClassName?: string;
  errorTitle?: string;
  errorScope?: string;
  errorHint?: ReactNode;
  children: ReactNode;
}) {
  const parked = parkedUnlessPermanent(query) || extraPaused;
  const listState = resolveRemoteSection({
    ghPending: false,
    ghReady: true,
    listPending: query.isPending,
    error: query.isError,
    rowCount,
    paused: parked,
  });
  const notice = sectionReadNotice({
    noun,
    loadFailed,
    rowCount: query.data === undefined ? undefined : rowCount,
    isError: query.isError,
    isPaused: parked,
  });
  const noticeMessage = (() => {
    switch (listState) {
      case "offline":
        return offlinePendingMessage(noun);
      case "rows-degraded":
      case "rows-offline":
        return notice?.message;
      default:
        return undefined;
    }
  })();
  // The error card's Retry resets a never-loaded read to pending, swapping the
  // card for skeletons; the always-mounted wrapper takes focus as it goes.
  const coldRetry =
    listState === "error" &&
    notice?.retry === true &&
    !isPermanentListError(query.error);
  const { hostRef, retryRef } = useRetryFocusRescue(coldRetry);
  return (
    <div ref={hostRef} tabIndex={-1} className="space-y-2 outline-none">
      <DegradedListNotice
        noun={noun}
        degraded={noticeMessage !== undefined}
        message={noticeMessage}
        retryLabel={notice?.retryLabel}
        onRetry={
          listState === "rows-degraded" ? () => void query.refetch() : undefined
        }
        className="px-0 pb-0"
      />
      {listState !== "offline" && (
        <AsyncListBody
          loading={listState === "list-skeleton"}
          error={listState === "error" ? query.error : null}
          empty={listState === "empty"}
          emptyLabel={emptyLabel}
          skeletonClassName={skeletonClassName}
          errorTitle={errorTitle}
          errorScope={errorScope}
          errorHint={errorHint}
          onRetry={coldRetry ? () => void query.refetch() : undefined}
          retryLabel={notice?.retryLabel}
          retryRef={retryRef}
        >
          {children}
        </AsyncListBody>
      )}
    </div>
  );
}

/**
 * A row's picker (a role, a ruleset's enforcement), held with a reason while
 * saving, offline, or with its options unknown. Labels come from `items` or,
 * for a value outside the offered options, an explicit `valueLabel`.
 */
export function HeldRoleSelect({
  value,
  heldReason,
  onRole,
  options,
  items,
  valueLabel,
  label = "Role",
}: {
  value: string;
  /** Why the picker is held, as its hover text and accessible description. */
  heldReason?: string;
  onRole: (value: string) => void;
  /** The options offered, in order. */
  options: readonly { value: string; label: string }[];
  items?: Record<string, string>;
  valueLabel?: ReactNode;
  /** The trigger's accessible name. */
  label?: string;
}) {
  const held = heldReason !== undefined;
  const reason = useDisabledReason({ disabled: held, reason: heldReason });
  // Held by readOnly + a gated open state, never Base UI's `disabled`: that sets
  // the trigger's tabIndex to -1, taking the picker and its reason out of reach.
  const [open, setOpen] = useState(false);
  if (held && open) setOpen(false);
  return (
    <span
      className={cn(
        "inline-flex shrink-0",
        reason.blockedReason !== null && "cursor-not-allowed",
      )}
      title={reason.wrapperTitle}
    >
      <Select
        items={items}
        value={value}
        onValueChange={(v) => v && onRole(v)}
        readOnly={held}
        open={open}
        onOpenChange={(next) => {
          if (!held) setOpen(next);
        }}
      >
        <SelectTrigger
          size="sm"
          className={cn("w-28", ARIA_DISABLED_CLASS)}
          aria-label={label}
          aria-disabled={held || undefined}
          aria-describedby={reason.describedBy}
        >
          <SelectValue>{valueLabel}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((r) => (
            <SelectItem key={r.value} value={r.value}>
              {r.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {/* `hidden` rather than sr-only: a description may point at hidden text, and
          an sr-only sibling would be read again as page text after the trigger. */}
      {reason.blockedReason !== null && (
        <span id={reason.reasonId} hidden>
          {reason.blockedReason}
        </span>
      )}
    </span>
  );
}

/** Why a {@link HeldSwitch} is held. The site reason (offline, inherited, a
 *  dependency, a pending certificate) outranks `saving`, as the row pickers'
 *  `offlineReason ?? SAVING_REASON` does: a save parked offline lands only on
 *  reconnect, which is what that reason says. */
export function heldSwitchReason(
  heldReason: string | undefined,
  saving: boolean,
): string | undefined {
  return heldReason ?? (saving ? SAVING_REASON : undefined);
}

/**
 * A switch held with a reason ({@link heldSwitchReason}). Held by `readOnly`,
 * never Base UI's `disabled`, which sets tabIndex -1: the switch stays one
 * mounted, focusable node across every hold edge, Space and Enter flip
 * nothing, and the reason reaches hover, keyboard, and AT alike.
 */
export function HeldSwitch({
  heldReason,
  saving = false,
  inLabel = false,
  className,
  ...props
}: Omit<ComponentProps<typeof Switch>, "disabled" | "readOnly"> & {
  heldReason?: string;
  /** The switch's own change is still saving. */
  saving?: boolean;
  /** Named by a wrapping `<label>`, which then carries the hover title itself:
   *  Chromium reads a titled descendant's title into the label's text, and so
   *  into the switch's name. */
  inLabel?: boolean;
}) {
  const reason = heldSwitchReason(heldReason, saving);
  const held = reason !== undefined;
  const hold = useDisabledReason({
    disabled: held,
    reason,
    describedBy: props["aria-describedby"],
  });
  return (
    <span
      className={cn(
        "inline-flex shrink-0",
        hold.blockedReason !== null && "cursor-not-allowed",
      )}
      title={inLabel ? undefined : hold.wrapperTitle}
    >
      {/* `hidden`, as in HeldRoleSelect: a wrapping <label> names the switch
          from its content, which skips hidden text but would read sr-only. */}
      {hold.blockedReason !== null && (
        <span id={hold.reasonId} hidden>
          {hold.blockedReason}
        </span>
      )}
      <Switch
        {...props}
        readOnly={held}
        aria-disabled={held || undefined}
        aria-describedby={hold.describedBy}
        className={cn(ARIA_DISABLED_CLASS, className)}
      />
    </span>
  );
}

/**
 * The scope note inside an async list's error card, in `ScopeRefreshHint`'s
 * grammar. The reconnect button only appears for a classic OAuth/PAT sign-in
 * actually missing `scope` (the same gate that hint applies): this card also
 * renders for "not signed in" and for failures that aren't about permissions at
 * all, where a refresh is the wrong move — those keep the command text alone.
 * The lead names the scope because one open dialog can show several of these
 * cards, each wanting a different one. Lives in its own component so the
 * token-scopes probe runs on the error path only, not from every healthy list.
 */
function ScopeErrorHint({ scope }: { scope: string }) {
  const host = useActiveGhHost();
  const scopes = useGhScopes(host);
  const openReconnect = useUiStore((s) => s.openReconnect);
  const canRefresh =
    scopes.data?.classic === true && !scopes.data.scopes.includes(scope);
  // A host outside the reconnect grammar never reaches a copyable command string
  // (shell-syntax injection via a crafted remote) — only the command sentence is
  // suppressed, matching ScopeRefreshHint: the explanation and button stay, and
  // the button's flow re-validates the host backend-side, failing loudly.
  const hostSafe = isReconnectHostSafe(host);
  return (
    <div className="mt-2 text-muted-foreground">
      <p>
        If this is a permissions error, your GitHub sign-in may be missing the{" "}
        <span className="font-mono">{scope}</span> scope.
      </p>
      {canRefresh && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="xs"
            onClick={() =>
              openReconnect({
                provider: "github",
                host,
                mode: "refresh",
                scopes: [scope],
              })
            }
          >
            Reconnect GitHub…
          </Button>
        </div>
      )}
      {/* The reopen only applies to the copied command: the button's flow
          invalidates this list itself, so its card refetches in place. */}
      {hostSafe && (
        <p className="mt-2">
          {canRefresh ? "Or run" : "Run"}{" "}
          <span className="font-mono">
            gh auth refresh --hostname {reconnectHostArg(host)} -s {scope}
          </span>{" "}
          in a terminal, then reopen this dialog.
        </p>
      )}
    </div>
  );
}

type SwapFocusRef = (node: HTMLElement | null) => (() => void) | undefined;

function onBody(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body;
}

function createConfirmSwapFocus() {
  let armed: string | number | null = null;
  // A node whose focus went nowhere: the act button disabled while pending
  // drops focus to <body> with no landing, and still owns it until it leaves.
  let stranded: HTMLElement | null = null;
  const refs = new Map<string | number, SwapFocusRef>();
  return (key: string | number = ""): SwapFocusRef => {
    let ref = refs.get(key);
    if (ref === undefined) {
      ref = (node) => {
        if (node === null) return;
        if (armed === key) {
          armed = null;
          if (onBody()) node.focus({ preventScroll: true });
        }
        const onFocusOut = (e: FocusEvent) => {
          if (e.relatedTarget === null) stranded = node;
        };
        // A window blur also leaves with no target, but focus comes back here.
        const onFocusIn = () => {
          if (stranded === node) stranded = null;
        };
        node.addEventListener("focusout", onFocusOut);
        node.addEventListener("focusin", onFocusIn);
        // Ref cleanup runs before React removes the node, while focus is still
        // readable; the microtask disarms a leave nothing in this commit claimed.
        return () => {
          node.removeEventListener("focusout", onFocusOut);
          node.removeEventListener("focusin", onFocusIn);
          const owned =
            node.contains(document.activeElement) ||
            (stranded === node && onBody());
          if (stranded === node) stranded = null;
          if (!owned) return;
          armed = key;
          queueMicrotask(() => {
            if (armed === key) armed = null;
          });
        };
      };
      refs.set(key, ref);
    }
    return ref;
  };
}

/**
 * Keeps focus across a `confirming ? <InlineConfirm/> : <trigger/>` swap: the
 * trigger leaving with focus hands it to the confirm's Cancel, and the confirm
 * leaving with focus hands it back to the returning trigger. Pass the same
 * `swapFocus(key)` to both sides (`ref` on the trigger, `swapFocusRef` on
 * InlineConfirm); one hook can serve a whole list keyed per row. It moves focus
 * only when the leaving side held it (or lost it to `<body>` and nothing took
 * it since) and focus sits on `<body>`, within the swap's own commit, before
 * Base UI's dialog fallback (a microtask) parks it on the popup; a pointer user
 * who clicked elsewhere is never pulled back.
 */
export function useConfirmSwapFocus() {
  const [swapFocus] = useState(createConfirmSwapFocus);
  return swapFocus;
}

/**
 * The confirm half of an inline confirm-delete affordance: a `Cancel` button and
 * a (usually destructive) action button with a pending spinner, optionally
 * preceded by a prompt. The parent owns the `confirming` state and renders this in
 * the confirming branch in place of its normal trigger — so the reset-on-cancel /
 * on-success and the row layout stay with the parent, but the repeated button
 * markup lives in one place.
 */
export function InlineConfirm({
  prompt,
  promptClassName,
  cancelLabel = "Cancel",
  cancelVariant = "ghost",
  actLabel,
  actVariant = "destructive",
  pending = false,
  heldReason,
  swapFocusRef,
  onCancel,
  onAct,
}: {
  prompt?: ReactNode;
  /** e.g. `mr-auto` to push the buttons to the right in a footer layout. */
  promptClassName?: string;
  cancelLabel?: ReactNode;
  cancelVariant?: "ghost" | "outline";
  actLabel: ReactNode;
  actVariant?: "destructive" | "default";
  pending?: boolean;
  /** Why the act button is held, as its hover text and accessible description.
   *  Unset leaves it held only while `pending`. */
  heldReason?: string;
  /** The `useConfirmSwapFocus` ref this confirm swaps with its trigger under. */
  swapFocusRef?: Ref<HTMLButtonElement>;
  onCancel: () => void;
  onAct: () => void;
}) {
  return (
    <>
      {prompt != null && (
        <span className={cn("text-muted-foreground", promptClassName)}>
          {prompt}
        </span>
      )}
      {/* Both buttons report a leave; Cancel attaches first in tree order, so
          it is the one that claims an incoming hand-off. */}
      <Button
        ref={swapFocusRef}
        size="sm"
        variant={cancelVariant}
        onClick={onCancel}
      >
        {cancelLabel}
      </Button>
      {/* One node whether or not a reason holds it, so a focused act button
          survives the reason coming and going. */}
      <DisabledReasonButton
        ref={swapFocusRef}
        size="sm"
        variant={actVariant}
        disabled={pending || heldReason !== undefined}
        reason={heldReason}
        onClick={onAct}
      >
        {pending && <Spinner data-icon="inline-start" />}
        {actLabel}
      </DisabledReasonButton>
    </>
  );
}

/** A webhook delivery's request/response body: labeled, copyable, highlighted
 *  as JSON when it looks like JSON and isn't huge (tokenizing a big blob would
 *  block). Shared by both providers' delivery-debugging views. */
export function DeliveryPayload({
  label,
  body,
}: {
  label: string;
  body: string;
}) {
  const trimmed = body.trim();
  const lines = useMemo(
    () =>
      trimmed.length > 0 &&
      trimmed.length < 50_000 &&
      (trimmed.startsWith("{") || trimmed.startsWith("["))
        ? highlightJson(body)
        : null,
    [body, trimmed],
  );

  return (
    <div>
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-medium text-muted-foreground">{label}</p>
        {trimmed.length > 0 && (
          <CopyIconButton
            text={body}
            label={`Copy ${label.toLowerCase()}`}
            toast={`${label} copied`}
          />
        )}
      </div>
      {trimmed.length > 0 ? (
        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/50 p-2 font-mono text-[11px]">
          {lines
            ? lines.map((line, i) => (
                <Fragment key={i}>
                  {i > 0 && "\n"}
                  {line.map((t, j) => (
                    <span
                      key={j}
                      style={t.color ? { color: t.color } : undefined}
                    >
                      {t.content}
                    </span>
                  ))}
                </Fragment>
              ))
            : body}
        </pre>
      ) : (
        <p className="mt-1 text-[11px] text-muted-foreground">(empty)</p>
      )}
    </div>
  );
}
