import { WarningIcon } from "@phosphor-icons/react";
import { useSelector } from "@tanstack/react-store";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { PRIVACY_POLICY_URL, resetAnalyticsId } from "@/lib/analytics";
import { useAutomations } from "@/lib/automations/queries";
import { anyAutomationEnabled } from "@/lib/automations/types";
import { withForm } from "@/lib/form";
import { settingsFormOpts } from "./settings-form";

const FETCH_INTERVAL_OPTIONS: Record<string, string> = {
  "5": "Every 5 minutes",
  "10": "Every 10 minutes",
  "15": "Every 15 minutes",
  "30": "Every 30 minutes",
  "60": "Every hour",
};

export const GeneralSection = withForm({
  ...settingsFormOpts,
  render: function GeneralSectionRender({ form }) {
    const autoFetchOn = useSelector(form.store, (s) => s.values.autoFetch);
    // Keyed off the DRAFT value so the consequence shows before Save commits it, and
    // stands as the standing explanation once hiding AI is saved on.
    const hideAiOn = useSelector(form.store, (s) => s.values.hideAi);
    const automations = useAutomations();
    const automationsPaused =
      hideAiOn &&
      Boolean(automations.data && anyAutomationEnabled(automations.data));
    return (
      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-medium">General</h2>
          <p className="text-xs text-muted-foreground">App-wide preferences.</p>
        </div>
        {/* Each toggle is grouped with its own description (tight spacing) so
            the helper text reads as belonging to the control above it, not the
            next one down. */}
        <div className="space-y-1.5">
          <form.AppField name="hideAi">
            {(field) => (
              <field.CheckboxField
                label="Hide AI features"
                className="flex cursor-pointer items-center gap-2 text-xs"
              />
            )}
          </form.AppField>
          <p className="text-xs text-muted-foreground">
            Hides the AI commit-message and pull-request helpers, the AI review
            panel, the AI-related settings sections, and finished AI activity in
            the dock and notification inbox, mutes AI desktop notifications, and
            pauses your automations. Your provider, API keys, and rules are
            kept — automations run again once you turn AI features back on.
          </p>
          {automationsPaused && (
            <p
              role="status"
              className="flex items-start gap-1.5 text-xs text-warning"
            >
              <WarningIcon className="size-4 shrink-0" />
              <span>
                You have automations turned on — they won't run while AI
                features are hidden.
              </span>
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <form.AppField name="closeToTray">
            {(field) => (
              <field.CheckboxField
                label="Keep running in the tray when the window is closed"
                className="flex cursor-pointer items-center gap-2 text-xs"
              />
            )}
          </form.AppField>
          <p className="text-xs text-muted-foreground">
            Closing the window hides GitDesktop to the system tray instead of
            quitting, so background work keeps running. Reopen from the tray
            icon, or use its Quit menu to exit. Turn this off to make closing
            quit the app.
          </p>
        </div>
        <div className="space-y-1.5">
          <form.AppField name="autoFetch">
            {(field) => (
              <field.CheckboxField
                label="Automatically fetch from your remotes"
                className="flex cursor-pointer items-center gap-2 text-xs"
              />
            )}
          </form.AppField>
          <p className="text-xs text-muted-foreground">
            Periodically runs a background{" "}
            <span className="font-mono">git fetch</span> while the window is
            focused, so the behind-count and incoming commits stay current. It
            never pulls, merges, or changes files — pulling and pushing stay
            manual.
          </p>
          {autoFetchOn && (
            <div className="max-w-xs pt-1">
              <form.AppField name="autoFetchInterval">
                {(field) => (
                  <field.SelectField items={FETCH_INTERVAL_OPTIONS} />
                )}
              </form.AppField>
            </div>
          )}
        </div>
        <div className="space-y-1.5">
          <form.AppField name="autoStashOnPull">
            {(field) => (
              <field.CheckboxField
                label="Automatically stash and reapply on pull, merge, rebase, and branch updates"
                className="flex cursor-pointer items-center gap-2 text-xs"
              />
            )}
          </form.AppField>
          <p className="text-xs text-muted-foreground">
            When a pull, merge, rebase, or branch update would overwrite
            uncommitted changes, stash them, run it, then reapply.
          </p>
        </div>
        <div className="space-y-1.5">
          <form.AppField name="reapplyStashOnSwitch">
            {(field) => (
              <field.CheckboxField
                label="Reapply stashed changes after switching branches"
                className="flex cursor-pointer items-center gap-2 text-xs"
              />
            )}
          </form.AppField>
          <p className="text-xs text-muted-foreground">
            Applies when you choose Stash and switch.
          </p>
        </div>
        <div className="space-y-1.5">
          <form.AppField name="createPrsAsDraft">
            {(field) => (
              <field.CheckboxField
                label="Create pull requests as drafts"
                className="flex cursor-pointer items-center gap-2 text-xs"
              />
            )}
          </form.AppField>
          <p className="text-xs text-muted-foreground">
            New pull requests start as drafts. Automated first reviews then wait
            until a PR is marked ready for review (unless review of drafts is
            enabled). You can still change the draft toggle per pull request.
          </p>
        </div>
        <div className="space-y-1.5">
          <form.AppField name="analyticsEnabled">
            {(field) => (
              <field.CheckboxField
                label="Send anonymous usage data"
                className="flex cursor-pointer items-center gap-2 text-xs"
              />
            )}
          </form.AppField>
          <p className="text-xs text-muted-foreground">
            Sends anonymous, content-free usage events to PostHog (EU region) to
            help improve the app. No code, file names, repo paths, or secrets
            are ever captured. Takes effect after saving.
          </p>
        </div>
        <div className="space-y-1.5">
          <form.AppField name="recordReplay">
            {(field) => (
              <field.CheckboxField
                label="Allow masked session recordings"
                className="flex cursor-pointer items-center gap-2 text-xs"
              />
            )}
          </form.AppField>
          <p className="text-xs text-muted-foreground">
            Off by default. Records your interactions to help diagnose issues —
            all text is masked and diffs, file content, and editors are blocked,
            so recordings never reveal what you're working on. Requires usage
            data above.
          </p>
        </div>
        <div className="flex items-center gap-4 pt-1">
          {PRIVACY_POLICY_URL && (
            <button
              type="button"
              className="cursor-pointer text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
              onClick={() => openUrl(PRIVACY_POLICY_URL)}
            >
              Privacy policy
            </button>
          )}
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={async () => {
              await resetAnalyticsId();
              toast.success("Analytics identity reset", {
                description:
                  "Future events use a new anonymous id, unlinkable from past ones.",
              });
            }}
          >
            Reset analytics identity
          </Button>
        </div>
      </section>
    );
  },
});
