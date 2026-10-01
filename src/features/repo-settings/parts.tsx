import { Fragment, type ReactNode, useMemo, useState } from "react";
import { CopyIconButton } from "@/components/CopyIconButton";
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
import { DegradedListNotice } from "@/features/conversations/ConversationListPanel";
import {
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
 */
export function AsyncErrorCard({
  title,
  error,
  hint,
  children,
}: {
  title: ReactNode;
  error: unknown;
  /** A closing note in the card's own muted style (permissions, next steps). */
  hint?: ReactNode;
  children?: ReactNode;
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
    </div>
  );
}

/**
 * The shared loading / error / empty / list shell for the repo-settings async
 * lists (secrets, collaborators, rulesets, webhooks). Renders skeletons while
 * loading, a destructive error card (optionally with a `gh auth refresh` scope
 * hint or a custom hint) on error, a dashed placeholder when empty, else the rows.
 * Extracting it keeps these sections consistent and stops the error/scope copy
 * from drifting per-section.
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
      <AsyncErrorCard title={errorTitle} error={error} hint={errorHint}>
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
  extraAction,
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
  /** The notice's line for a failure with nothing loaded. */
  loadFailed: string;
  /** A park the list read can't report itself: a read it depends on waiting
   *  for a connection leaves this one idle, not paused. */
  extraPaused?: boolean;
  /** A second recovery action beside the notice's Retry. */
  extraAction?: ReactNode;
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
  return (
    <div className="space-y-2">
      <DegradedListNotice
        noun={noun}
        degraded={noticeMessage !== undefined}
        message={noticeMessage}
        retryLabel={notice?.retryLabel}
        onRetry={
          listState === "rows-degraded" ? () => void query.refetch() : undefined
        }
        extraAction={extraAction}
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
        >
          {children}
        </AsyncListBody>
      )}
    </div>
  );
}

/**
 * A row's role picker, held with a reason while a change saves or the roles
 * are unknown. Labels come from `items` (Base UI's value → label map) or, for
 * a value outside the offered roles, an explicit `valueLabel`.
 */
export function HeldRoleSelect({
  value,
  heldReason,
  onRole,
  options,
  items,
  valueLabel,
}: {
  value: string;
  /** Why the picker is held, as its hover text and accessible description. */
  heldReason?: string;
  onRole: (value: string) => void;
  /** The roles offered, in order. */
  options: readonly { value: string; label: string }[];
  items?: Record<string, string>;
  valueLabel?: ReactNode;
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
          aria-label="Role"
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
      <Button size="sm" variant={cancelVariant} onClick={onCancel}>
        {cancelLabel}
      </Button>
      <Button size="sm" variant={actVariant} disabled={pending} onClick={onAct}>
        {pending && <Spinner data-icon="inline-start" />}
        {actLabel}
      </Button>
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
