- **Edit commit dates.** Change a commit's author and committer dates from
  History. **Edit dates…** on the latest commit changes just its dates, and
  each row in **Edit history** shows its date and edits it in place, alongside
  reword, squash and reorder. Select several commits to give them one date.
  Dates are typed (one pasted from `git log` works) or picked. A commit's
  own date editor keeps its UTC offset unless you type another, and one date
  set on several rows gives them all one offset. A commit that would end up
  dated before its parent is flagged and confirmed first. Changing only dates
  runs no Git hooks, so every commit in the rewrite keeps its message.
