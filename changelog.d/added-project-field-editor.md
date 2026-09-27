- **Set an issue or pull request's GitHub Projects fields without leaving it.** The
  **Project fields** row is now a trigger: it opens one popup holding every field you can
  set on every board the item is on (**Status**, **Priority**, **Iteration**, plus date,
  text, number, and multi-select fields), filled in or not, and any that already holds a
  value carries a **Clear** to empty it again. Like the Projects and Labels pickers, it
  drafts your edits and writes them when it closes, one write per board. It works on
  closed and merged pull requests too, so a card can still move to *Done* after the
  merge. **Edit project fields…** in the command palette opens it without the mouse.
  Your organization's issue fields are there too, and anywhere a board lets you edit a
  field (its table cells, the bulk fields editor, a move between columns, the roadmap's
  date keys) they set the value on the issue itself, so every board showing that field
  agrees. GitHub only; a board's own fields use the same `project` sign-in scope the
  Projects picker already needs.
