import { withForm } from "@/lib/form";
import type { PR_CHECK_SCOPES } from "@/lib/settings/api";
import { useAiEnabled } from "@/lib/settings/queries";
import { settingsFormOpts } from "./settings-form";

/** Record-typed against PR_CHECK_SCOPES, which `loadSettings` also heals against,
 *  so an added scope can't reach one without the other. */
const CHECK_OPTIONS: Record<(typeof PR_CHECK_SCOPES)[number], string> = {
  off: "Off",
  mine: "My pull requests only",
  all: "All open pull requests",
};

export const NotificationsSection = withForm({
  ...settingsFormOpts,
  render: function NotificationsSectionRender({ form }) {
    const aiEnabled = useAiEnabled();
    return (
      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-medium">Notifications</h2>
          <p className="text-xs text-muted-foreground">
            OS notifications fire only while GitDesktop is unfocused — in-app
            toasts cover the rest. Pull request events are polled about once a
            minute while a hosted repository (GitHub, GitLab, or Bitbucket) is
            open.
          </p>
        </div>
        <form.AppField name="notifications.prChecks">
          {(field) => (
            <field.SelectField
              label="CI checks finish (pass or fail)"
              items={CHECK_OPTIONS}
            />
          )}
        </form.AppField>
        <form.AppField name="notifications.prActivity">
          {(field) => (
            <field.CheckboxField
              label="Pull requests opened, merged, or closed"
              className="flex cursor-pointer items-center gap-2 text-xs"
            />
          )}
        </form.AppField>
        <form.AppField name="notifications.prReviews">
          {(field) => (
            <field.CheckboxField
              label="Reviews on my pull requests"
              className="flex cursor-pointer items-center gap-2 text-xs"
            />
          )}
        </form.AppField>
        <form.AppField name="notifications.actionRuns">
          {(field) => (
            <field.CheckboxField
              label="Workflow runs finish on the current branch"
              className="flex cursor-pointer items-center gap-2 text-xs"
            />
          )}
        </form.AppField>
        {aiEnabled && (
          <>
            <form.AppField name="notifications.reviews">
              {(field) => (
                <field.CheckboxField
                  label="An AI review you started finishes in the background"
                  className="flex cursor-pointer items-center gap-2 text-xs"
                />
              )}
            </form.AppField>
            <form.AppField name="notifications.automations">
              {(field) => (
                <field.CheckboxField
                  label="Automation results (AI reviews posted or failed)"
                  className="flex cursor-pointer items-center gap-2 text-xs"
                />
              )}
            </form.AppField>
          </>
        )}
      </section>
    );
  },
});
