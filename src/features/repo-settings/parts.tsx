import { CopyIcon } from "@phosphor-icons/react";
import { Fragment, type ReactNode, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { highlightJson } from "@/features/diff/shiki-highlighter";
import { copyText } from "@/lib/clipboard";
import {
  isReconnectHostSafe,
  reconnectHostArg,
  useActiveGhHost,
} from "@/lib/git/host";
import { useGhScopes } from "@/lib/git/queries";
import { useUiStore } from "@/lib/stores/ui";
import { cn } from "@/lib/utils";

/**
 * The destructive error card the repo-settings surfaces share: a title, the
 * rejection's message when it carries one (a Tauri IPC rejection is often a bare
 * string), then any hint. `children` render between the two — the slot the scope
 * note takes, which needs hooks the card itself has no business owning.
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
      {error instanceof Error && (
        <p className="mt-1 text-muted-foreground">{error.message}</p>
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
export function AsyncListBody({
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
          <button
            type="button"
            className="text-muted-foreground transition-colors hover:text-foreground"
            title={`Copy ${label.toLowerCase()}`}
            onClick={() => copyText(body, `${label} copied`)}
          >
            <CopyIcon className="size-3.5" />
          </button>
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
