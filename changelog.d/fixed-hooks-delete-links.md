- **Deleting a git hook** handles a copy that is a link: the link is removed
  and a file it points to elsewhere stays, a link that points nowhere is
  cleared along with the hook's other copy, and a delete that can't finish
  says which file stayed and why.
