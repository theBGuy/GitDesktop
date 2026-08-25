- **AI excluded files.** A new tab in **Manage files…** (repo ⋮ menu, or the
  **AI excluded files** command) shows every file your AI ignore patterns hide
  right now, each labelled with the rule that hid it and whether that rule came
  from the repo's `.gitdesktop/aiignore` or your global settings. Your rules sit
  above the list in evaluation order with per-rule match counts; click one to see
  just its files. A `!` line that decides nothing is flagged there, with the fix
  where an enclosing folder rule is the cause. Select files and remove the rules
  behind them, from either source. The **Tracked** tab also gained an
  **Exclude … from AI** button that hides a whole selection in one step.
