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
  goes with it, while the write reaches GitHub behind you. The board's **saved views** come
  along as lenses: pick one under **View options** and GitHub filters the read for you, its
  sort orders the cards in each column (by **Title**, or by a text, number, date,
  single-select or iteration field), its visible fields show as chips on the cards, and
  its grouping seeds **Group by** while you stay free to regroup. Views saved as a table or
  roadmap are drawn as a board, **Clear view** (or **Clear project view** in the command
  palette) brings the whole item set back in the board's own order with the chips off,
  leaving the grouping wherever you last put it, and nothing here writes to the view.
  GitHub only; reading a board needs the same `project` or `read:project` sign-in scope
  the Projects picker already asks for, and moving a card needs the `project` scope plus
  write access to the board.
