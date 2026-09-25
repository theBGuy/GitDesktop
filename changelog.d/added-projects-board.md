- **See a GitHub Project as a board, without leaving the app.** The new **Projects** tab
  (More ▾, or the command palette) draws any board this repository or its owner has
  as a live kanban: pick which of the board's **single-select or iteration** fields makes
  the columns (**Status** to start with), and anything that field doesn't cover collects
  in a column of its own so nothing is hidden. Group by an iteration field and the board
  is a sprint board: a column per iteration the field defines, plus any finished one that
  still holds a card. Cards carry their state, number, owning repository (when a board
  spans several) and assignees; **draft** items open their notes in place, dated with
  when the note was written and when it last changed; issues and pull requests from
  this repository open on their own tab (cards from elsewhere open on GitHub), and
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
  card finally lands. The same menu **edits a draft** (its title, its Markdown notes
  and its assignees, saved with **Ctrl/Cmd+Enter**), **converts a draft into a real
  issue**, **archives** a card, and **removes** one from the project, the last three
  confirming first. **Archived cards are one switch away**: turn on **Show archived
  cards** under **View options** and they're back in their columns, marked **Archived**
  and drawn quietly, with **Restore card** on each one putting it straight back on the
  board. (The command palette carries the switch as **Show or hide archived cards**.)
  **Take several cards at once**: **Ctrl/Cmd+click** picks cards out individually,
  **Shift+click** (or **Shift** with the arrow keys) takes a range down a column, and
  from two cards up a bar above the board **moves**, **archives**, **restores**,
  **removes** or **sets the fields of** the cards each verb can reach. **Edit fields
  of N cards…** lists the board's own fields with every row on **Leave as is**: draft
  only the ones you mean, set or clear them, and one **Apply** writes exactly those to
  every eligible card, with each row reporting what the selection holds today: the
  value where the cards agree, **(mixed)** where they don't. Every count on the bar
  shows exactly what that verb will reach (archived cards sit out a field edit, for
  instance), and the prompts say where the cards go, drafts included.
  The card menu speaks for the selection too, the palette carries Edit fields,
  Archive, Restore, Remove and Clear, and **Esc** drops the whole thing. Cards that
  leave the board leave the selection with them.
  Creating an issue can put it on its boards in the same step: the **New issue** dialog
  gained a **Projects** picker. The board's **saved views** come along as lenses: pick
  one under **View options** and GitHub filters the read for you, its sort orders the
  cards in each column (by **Title**, or by a text, number, date, single-select or
  iteration field), its visible fields show as chips on the cards, and its grouping
  seeds **Group by** while you stay free to regroup. **Clear view** (or **Clear
  project view** in the command palette) brings the whole item set back in the board's
  own order with the chips off, leaving the grouping wherever you last put it. Picking
  a view and regrouping never change what GitHub has saved.
  GitHub only; reading a board needs the same `project` or `read:project` sign-in scope
  the Projects picker already asks for, and every write here needs the `project` scope
  plus write access to the board.
