import { useQuery } from "@tanstack/react-query";
import { useSelector } from "@tanstack/react-store";
import { Fragment, useLayoutEffect, useRef, useState } from "react";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { ListRowSkeletons } from "@/components/list-row-skeleton";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  MatrixCell,
  MatrixTable,
  RowLabelCell,
  WatchRow,
} from "@/features/notifications/RepoNotificationsDialog";
import { clipTitleFromText } from "@/lib/clip-title";
import { withForm } from "@/lib/form";
import { useRepoIdentity } from "@/lib/git/queries";
import { repoIdentity } from "@/lib/git/repo-identity";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import {
  CHANNELS,
  CHECKS_OFF_WATCH_REASON,
  type Channel,
  channelAriaLabel,
  notificationRows,
  notificationsDraftOutOfSync,
  notificationsSignature,
  overrideCount,
  SOURCE_DESCRIPTIONS,
  SOURCE_LABELS,
  useRepoNotificationsDialog,
} from "@/lib/notifications/matrix";
import type { RepoNotificationOverride } from "@/lib/notifications/overrides";
import {
  useClearNotificationOverride,
  useNotificationOverrides,
  useRepoNotificationOverride,
} from "@/lib/notifications/queries";
import { type RecentRepo, repoDisplayName } from "@/lib/settings/api";
import { useAiEnabled, useSettings } from "@/lib/settings/queries";
import { useConfirm } from "@/lib/stores/confirm";
import { repoNameFromPath } from "@/lib/stores/notifications";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";
import { settingsFormOpts } from "./settings-form";

/** Master-cell state for one column: every visible row on, every one off, or a
 *  mix — which the checkbox renders as its indeterminate state. */
type MasterState = boolean | "mixed";

/** Indeterminate styling for the master cells: Base UI renders its indicator for
 *  the mixed state too, so the call site hides the tick, draws a dash, and keeps
 *  the filled box — the state reads from the glyph and `aria-checked="mixed"`,
 *  never from color. */
const MIXED_CLASS =
  "data-indeterminate:border-primary data-indeterminate:bg-primary! data-indeterminate:text-primary-foreground data-indeterminate:*:hidden data-indeterminate:before:h-0.5 data-indeterminate:before:w-2 data-indeterminate:before:bg-current";

export const NotificationsSection = withForm({
  ...settingsFormOpts,
  render: function NotificationsSectionRender({ form }) {
    const aiEnabled = useAiEnabled();
    const rows = notificationRows(aiEnabled);
    const sources = useSelector(
      form.store,
      (s) => s.values.notifications.sources,
    );
    const checksOff = !sources.prChecks.inApp && !sources.prChecks.os;

    // Only the notifications slice matters — the dialog reads no other field —
    // so the selector narrows to it and a keystroke elsewhere in the form can't
    // re-render this panel. SettingsScreen publishes the same value for the
    // routes that reach the dialog from outside this form.
    const savedNotifications = useSettings().data?.notifications;
    const draftSignature = useSelector(form.store, (s) =>
      notificationsSignature(s.values.notifications),
    );

    const overrideReason = notificationsDraftOutOfSync(
      draftSignature,
      savedNotifications,
    )
      ? "Save or discard your changes first — repository overrides start from the saved defaults."
      : null;

    function masterState(channel: Channel): MasterState {
      const on = rows.filter((source) => sources[source][channel]).length;
      if (on === 0) return false;
      return on === rows.length ? true : "mixed";
    }

    // UI sugar with no stored field of its own: it writes the VISIBLE rows'
    // cells, so a hidden AI row keeps whatever the draft holds, and Discard
    // reverts it like any other draft edit.
    function setColumn(channel: Channel, checked: boolean) {
      form.setFieldValue("notifications.sources", (prev) => {
        const next = { ...prev };
        for (const source of rows) {
          next[source] = { ...next[source], [channel]: checked };
        }
        return next;
      });
    }

    return (
      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-medium">Notifications</h2>
          {/* The agent-tasks clause names a row that Hide AI removes, so it is
              gated exactly like the same sentence in the user guide. */}
          <p className="text-xs text-muted-foreground">
            Choose where each event lands: a row in the activity inbox (In-app),
            an OS notification, or both. A source with both channels off records
            nothing. OS notifications fire only while GitDesktop is unfocused
            {aiEnabled
              ? " — agent tasks also ping while you work elsewhere in the app."
              : "."}{" "}
            Pull request events are polled about once a minute while a hosted
            repository (GitHub, GitLab, or Bitbucket) is open.
          </p>
        </div>

        <MatrixTable caption="Global notification channels">
          <tr>
            <RowLabelCell label="All notifications" className="font-medium" />
            {CHANNELS.map((channel) => {
              const state = masterState(channel);
              return (
                <MatrixCell key={channel}>
                  <Checkbox
                    checked={state === true}
                    indeterminate={state === "mixed"}
                    aria-label={channelAriaLabel("All notifications", channel)}
                    className={MIXED_CLASS}
                    onCheckedChange={(checked) =>
                      setColumn(channel, checked === true)
                    }
                  />
                </MatrixCell>
              );
            })}
          </tr>
          {rows.map((source) => {
            const label = SOURCE_LABELS[source];
            return (
              <Fragment key={source}>
                <tr>
                  <RowLabelCell
                    label={label}
                    description={SOURCE_DESCRIPTIONS[source]}
                  />
                  {CHANNELS.map((channel) => (
                    <MatrixCell key={channel}>
                      <form.AppField
                        name={`notifications.sources.${source}.${channel}`}
                      >
                        {(field) => (
                          <Checkbox
                            checked={field.state.value}
                            aria-label={channelAriaLabel(label, channel)}
                            onCheckedChange={(checked) =>
                              field.handleChange(checked === true)
                            }
                            onBlur={field.handleBlur}
                          />
                        )}
                      </form.AppField>
                    </MatrixCell>
                  ))}
                </tr>
                {/* The scope qualifies the CI-checks row alone, so it sits
                    under it rather than below the whole matrix. */}
                {source === "prChecks" && (
                  <form.AppField name="notifications.prChecksScope">
                    {(field) => (
                      <WatchRow
                        value={field.state.value}
                        onValueChange={field.handleChange}
                        disabledReason={
                          checksOff ? CHECKS_OFF_WATCH_REASON : null
                        }
                      />
                    )}
                  </form.AppField>
                )}
              </Fragment>
            );
          })}
        </MatrixTable>

        <RepoOverridesBlock reason={overrideReason} />
      </section>
    );
  },
});

/** What to call a repo whose path is known: its recent-list display name when it
 *  has a row there, else the folder basename. */
function displayNameFor(path: string, recents: RecentRepo[]): string {
  const row = recents.find((r) => r.path.toLowerCase() === path.toLowerCase());
  return row ? repoDisplayName(row) : repoNameFromPath(path);
}

/** Display fallback for an override key naming no recent repo. The key is a git
 *  common dir (`…/repo/.git`) or a legacy checkout path, so a bare ".git"
 *  basename means the repo folder is one level up. */
function keyBasename(key: string): string {
  const trimmed = key.replace(/[/\\]+$/, "");
  const base = repoNameFromPath(trimmed);
  return base === ".git"
    ? repoNameFromPath(trimmed.slice(0, -".git".length))
    : base;
}

function statusLine(
  name: string,
  override: RepoNotificationOverride | undefined,
): string {
  if (override?.muted) return `${name} is muted.`;
  const count = overrideCount(override);
  if (count === 0) return `${name} follows these defaults.`;
  return `${name} overrides ${count} ${count === 1 ? "setting" : "settings"}.`;
}

interface OverrideRow {
  key: string;
  /** Resolved checkout path, or null when no recent repo matches the key. */
  path: string | null;
  name: string;
  muted: boolean;
}

/**
 * The per-repo layer of the same settings: what the open repository does with
 * these defaults, plus every other repository that has been customized. Both
 * lead to the same {@link useRepoNotificationsDialog} surface.
 */
function RepoOverridesBlock({ reason }: { reason: string | null }) {
  const repoPath = useUiStore((s) => s.repoPath);
  const openDialog = useRepoNotificationsDialog((s) => s.open);
  const settings = useSettings();
  const overrides = useNotificationOverrides();
  const clear = useClearNotificationOverride();
  // An empty path reads as "no repo open" all the way down: the identity query
  // is disabled and the override lookup misses, so no branch needs a guard.
  const identity = useRepoIdentity(repoPath ?? "").data;
  const current = useRepoNotificationOverride(repoPath ?? "");
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  // Where focus goes once the cleared row is gone: a row key, or "" for the
  // Customize control when the list emptied. Consumed by the layout effect
  // below — the rows only exist after the invalidation re-render, which a
  // handler-side rAF can land ahead of.
  const pendingFocus = useRef<string | null>(null);

  const recents = settings.data?.recentRepos ?? [];
  const recentPaths = recents.map((r) => r.path);
  // Nothing is claimed about a repo until BOTH the stored overrides and the open
  // repo's identity are in hand: an identity-keyed entry is invisible while that
  // resolves, so an early read would name the open repo as "another repository"
  // and call it unmodified in the same frame.
  const resolved =
    overrides.data !== undefined &&
    (repoPath === null || identity !== undefined);
  // Every key the open repo could be stored under — its identity and, until the
  // next save folds it, its raw checkout path. Compared case-insensitively, in
  // step with `overrideEntry`, which matches both arms through `samePath`: an
  // exact-case test here would count a differently-cased path entry as the open
  // repo's AND list it as another repository's.
  const ownKeys = new Set(
    [repoPath, identity]
      .filter((k): k is string => typeof k === "string")
      .map((k) => k.toLowerCase()),
  );
  const otherKeys = resolved
    ? Object.keys(overrides.data ?? {})
        .filter((key) => !ownKeys.has(key.toLowerCase()))
        .sort()
    : [];

  // Identities resolve over IPC, so the mapping is a query rather than render
  // work; `repoIdentity` memoizes per path, so a repeat costs nothing. Keyed on
  // the RECENT REPOS alone — what it resolves doesn't depend on which overrides
  // exist, and carrying the key set would mint a fresh query on every Clear,
  // flashing the list back to skeletons and unmounting the row focus was headed
  // for. Returns a plain array aligned with `recentPaths`; the lookups are built
  // at render, since structural sharing only recurses plain objects and arrays.
  const recentIdentities = useQuery({
    queryKey: ["notification-override-repo-identities", recentPaths],
    queryFn: () => Promise.all(recentPaths.map((p) => repoIdentity(p))),
    enabled: otherKeys.length > 0,
    staleTime: Number.POSITIVE_INFINITY,
    // Local git reads: the default online mode PARKS the query while the OS
    // reports no connection, leaving this list on skeletons forever.
    networkMode: "always",
  });

  // Keys lowercased on both sides, matching `overrideEntry`. Maps, not objects:
  // an override key is hand-editable, and "__proto__" would resolve up an
  // object's prototype chain to something that is not a path.
  const identities = recentIdentities.data;
  const byIdentity = new Map(
    (identities ?? []).map((id, i) => [id.toLowerCase(), recentPaths[i]]),
  );
  const byPath = new Map(recentPaths.map((p) => [p.toLowerCase(), p]));

  const rows: OverrideRow[] = otherKeys
    .map((key) => {
      const lowerKey = key.toLowerCase();
      const path = identities
        ? (byIdentity.get(lowerKey) ?? byPath.get(lowerKey) ?? null)
        : null;
      return {
        key,
        path,
        name: path ? displayNameFor(path, recents) : keyBasename(key),
        muted: overrides.data?.[key]?.muted === true,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const onListKeyDown = listKeyboardNav({
    items: rows,
    activeIndex: activeKey ? rows.findIndex((r) => r.key === activeKey) : -1,
    onActivate: (row) => setActiveKey(row.key),
    rowKey: (row) => row.key,
  });

  const rowSignature = otherKeys.join("|");
  // Whether a destination can exist in this commit: either the list is gone
  // (footer fallback) or its rows are actually rendered.
  const focusTargetReachable =
    otherKeys.length === 0 || !recentIdentities.isPending;
  // biome-ignore lint/correctness/useExhaustiveDependencies: rowSignature is the commit trigger, not a value the body reads
  useLayoutEffect(() => {
    const target = pendingFocus.current;
    // RETAINED, never consumed, while the list is between renders: focusing a
    // DOM that isn't there drops focus to body, and this effect gets no second
    // chance once the aim is spent.
    if (target === null || !focusTargetReachable) return;
    pendingFocus.current = null;
    const row =
      target === ""
        ? null
        : (listRef.current?.querySelector<HTMLElement>(
            `[data-row="${CSS.escape(target)}"]`,
          ) ?? null);
    // The aimed row can be gone for reasons this component didn't cause (another
    // window's write); the footer control bounds the retention.
    (row ?? footerRef.current?.querySelector("button"))?.focus();
  }, [rowSignature, focusTargetReachable]);

  async function clearRow(row: OverrideRow) {
    const ok = await useConfirm.getState().ask({
      title: `Clear notification overrides for ${row.name}?`,
      body: "Its notifications return to the defaults above.",
      confirmLabel: "Clear overrides",
      confirmVariant: "destructive",
    });
    if (!ok) return;
    // Aim focus before the row disappears: neighbour by position, else the
    // Customize control, so clearing the last row never drops focus to body.
    const index = rows.findIndex((r) => r.key === row.key);
    const next = rows[index + 1] ?? rows[index - 1];
    pendingFocus.current = next?.key ?? "";
    setActiveKey(next?.key ?? null);
    try {
      await clear.mutateAsync(row.key);
    } catch (e) {
      // The row survives a failed clear, so the aimed focus would land on a
      // neighbour the user never asked for.
      pendingFocus.current = null;
      setActiveKey(row.key);
      toastError(e);
    }
  }

  const repoName = repoPath ? displayNameFor(repoPath, recents) : "";

  return (
    <div className="space-y-4 border-t pt-4">
      <div ref={footerRef} className="space-y-2">
        <h3 className="text-xs font-medium">This repository</h3>
        {repoPath === null ? (
          <DisabledReasonButton
            variant="outline"
            size="xs"
            disabled
            reason="Open a repository to customize its notifications"
          >
            Customize…
          </DisabledReasonButton>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 flex-1 text-xs text-muted-foreground">
              {resolved ? statusLine(repoName, current) : ""}
            </p>
            <DisabledReasonButton
              variant="outline"
              size="xs"
              disabled={reason !== null}
              reason={reason}
              onClick={() => openDialog(repoPath)}
            >
              Customize…
            </DisabledReasonButton>
          </div>
        )}
      </div>

      {otherKeys.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-xs font-medium">
            Overrides in other repositories
          </h3>
          {recentIdentities.isPending ? (
            <ListRowSkeletons
              rows={Math.min(otherKeys.length, 4)}
              lines={1}
              name="repositories with overrides"
              indent={false}
            />
          ) : (
            // The container is one tab stop and the arrows move the focused
            // row; each row's own buttons stay natively tabbable, so Tab walks
            // out of the list through them rather than skipping them.
            <div
              ref={listRef}
              role="group"
              tabIndex={0}
              aria-label="Repositories with notification overrides"
              className="border-t outline-none"
              onKeyDown={onListKeyDown}
            >
              {rows.map((row) => {
                const path = row.path;
                return (
                  <div
                    key={row.key}
                    data-row={row.key}
                    tabIndex={-1}
                    className="flex items-center gap-2 border-b px-1 py-1.5 outline-none focus-visible:bg-muted"
                  >
                    <span
                      className="min-w-0 flex-1 truncate text-xs"
                      onMouseEnter={clipTitleFromText}
                    >
                      {row.name}
                      {path === null && (
                        <span className="text-muted-foreground">
                          {" "}
                          (not in recent repositories)
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {row.muted ? "Muted" : "Customized"}
                    </span>
                    {path !== null && (
                      <DisabledReasonButton
                        variant="outline"
                        size="xs"
                        disabled={reason !== null}
                        reason={reason}
                        onClick={() => openDialog(path)}
                      >
                        Edit…
                      </DisabledReasonButton>
                    )}
                    <Button
                      variant="outline"
                      size="xs"
                      onClick={() => clearRow(row)}
                    >
                      Clear
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
