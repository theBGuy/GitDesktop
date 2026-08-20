- Reverting, cherry-picking, checking out a commit or a tag, taking a whole side
  of a conflicted file, and applying or popping a stash from the **Stashes**
  dialog now confirm first, each naming exactly what changes and what stays
  safe. Undoing a branch's first commit confirms too, since that one deletes the
  branch's ref instead of moving it back. The **Change base of…** and rebase
  dialogs now say up front that the commits they replay get new ids.
