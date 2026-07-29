import { withForm } from "@/lib/form";
import { settingsFormOpts } from "./settings-form";

export const InstructionsSection = withForm({
  ...settingsFormOpts,
  render: function InstructionsSectionRender({ form }) {
    return (
      <section className="space-y-4 border-t pt-4">
        <div>
          <h2 className="text-sm font-medium">Instructions</h2>
          <p className="text-xs text-muted-foreground">
            Applied to every AI generation. Use instructions for team
            conventions, e.g. "Follow Conventional Commits" or "Explain intent,
            not implementation."
          </p>
        </div>
        <form.AppField name="globalInstructions">
          {(field) => (
            <field.TextareaField
              label="Global instructions"
              rows={6}
              className="max-h-64"
              placeholder={
                "You must follow Conventional Commits.\nAlways explain the business context in the body."
              }
            />
          )}
        </form.AppField>
        <div className="space-y-2">
          <form.AppField name="aiIgnorePatterns">
            {(field) => (
              <field.TextareaField
                label="Excluded files"
                rows={4}
                className="max-h-48 font-mono"
                placeholder={".agents\n*.lock\ndocs/generated"}
              />
            )}
          </form.AppField>
          <p className="text-xs text-muted-foreground">
            gitignore-style patterns, one per line:{" "}
            <code className="rounded bg-muted px-1 py-0.5">secrets.env</code>{" "}
            matches that file at any depth,{" "}
            <code className="rounded bg-muted px-1 py-0.5">/secrets.env</code>{" "}
            only the copy at the repo root, and{" "}
            <code className="rounded bg-muted px-1 py-0.5">vendor/</code> a
            folder wherever it sits.{" "}
            <code className="rounded bg-muted px-1 py-0.5">!</code> re-include
            lines aren't supported. Matching files stay staged and committed as
            usual, but their diffs are left out of what the AI sees, so noisy
            folders don't dominate the message.
          </p>
        </div>
        <p className="text-xs text-muted-foreground">
          Per-repository overrides: create{" "}
          <code className="rounded bg-muted px-1 py-0.5">
            .gitdesktop/instructions.md
          </code>{" "}
          for project-specific rules and{" "}
          <code className="rounded bg-muted px-1 py-0.5">
            .gitdesktop/aiignore
          </code>{" "}
          for project-specific exclusions. Both combine with the global settings
          above.
        </p>
      </section>
    );
  },
});
