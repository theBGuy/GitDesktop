- **See a GitHub Project as a board, without leaving the app.** The new **Projects** tab
  (More ▾, or the command palette) draws any open board this repository or its owner has
  as a live kanban: pick which of the board's single-select fields makes the columns
  (**Status** to start with), and anything that field doesn't cover collects in a column
  of its own so nothing is hidden. Cards carry their state, number, owning repository
  (when a board spans several) and assignees; **draft** items open their notes in place,
  dated with when the note was written and when it last changed; issues and pull requests
  from this repository open on their own tab (cards from elsewhere open on GitHub), and
  the whole board answers to the arrow keys. **Space** on an issue or pull request card,
  or **Show details** from its menu, peeks at its title, what it is, and when it was
  opened, joined the board and last changed, without leaving the columns. Large boards
  page in with **Load more**. **Add item** fills the board from the toolbar: search this
  repository's issues and pull requests and add several in a row, or write a **draft** —
  a Markdown note that lives on the board until it earns an issue (**Ctrl/Cmd+Enter**
  creates it). Either way the card is there as the write lands, drawn from GitHub's own
  answer to it. Right-click a card (Shift+F10 on Windows and Linux) to **move it to
  another column**: the board re-draws where it lands and your keyboard place goes with
  it while the write reaches GitHub behind you. **Order a column from the keyboard**,
  too: **Alt/Option+↑ / ↓** move the card you're on one place, **Alt/Option+Home / End**
  send it to the column's top or bottom, and the card's menu and the command palette
  carry the same four. That's the **project's own order**, the one GitHub shows
  everyone, and holding the keys down is fine: the board keeps up and writes where the
  card finally lands. The same menu **edits a draft** (its
  title, its Markdown notes and its assignees, saved with **Ctrl/Cmd+Enter**),
  **converts a draft into a real issue**, **archives** a card (GitHub's archived items
  hold it for you), and **removes** one from the project, the last three confirming
  first. Creating an issue can put it on its boards in the same step: the **New issue**
  dialog gained a **Projects** picker. The board's **saved views** come along as lenses:
  pick one under **View options** and GitHub filters the read for you, its sort
  orders the cards in each column (by **Title**, or by a text, number, date,
  single-select or iteration field), its visible fields show as chips on the cards, and
  its grouping seeds **Group by** while you stay free to regroup. Views saved as a table or
  roadmap are drawn as a board, **Clear view** (or **Clear project view** in the command
  palette) brings the whole item set back in the board's own order with the chips off,
  leaving the grouping wherever you last put it, and nothing here writes to the view.
  GitHub only; reading a board needs the same `project` or `read:project` sign-in scope
  the Projects picker already asks for, and every write here needs the `project` scope
  plus write access to the board.
