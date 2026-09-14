- **See a GitHub Project as a board, without leaving the app.** The new **Projects** tab
  (More ▾, or the command palette) draws any open board this repository or its owner has
  as a live kanban: pick which of the board's single-select fields makes the columns
  (**Status** to start with), and anything that field doesn't cover collects in a column
  of its own so nothing is hidden. Cards carry their state, number, owning repository
  (when a board spans several) and assignees; **draft** items open their notes in place,
  issues and pull requests from this repository open on their own tab (cards from
  elsewhere open on GitHub), and the whole board answers to the arrow keys. Large boards
  page in with **Load more**. Right-click a card (Shift+F10 on Windows and Linux) to
  **move it to another column**: the board re-draws where it lands and your keyboard place
  goes with it, while the write reaches GitHub behind you. GitHub only; reading a board
  needs the same `project` or `read:project` sign-in scope the Projects picker already asks
  for, and moving a card needs the `project` scope plus write access to the board.
