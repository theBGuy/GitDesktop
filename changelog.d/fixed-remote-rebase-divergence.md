- **A remote-rebased branch gets the right remedy.** When the remote rewrote
  your branch (a server-side rebase or force-push, like GitHub's *Update branch
  → rebase*) and every commit here already landed upstream under new ids, the
  Pull menu and the branch's context menu offer a confirmed **Reset to
  _origin/…_** that lines the two up without losing anything, and the
  force-push confirmation warns that pushing would put the old history back.
  With commits of your own on top, the confirmation counts what's at stake and
  points at **Pull with rebase**, and the merge routes that would duplicate the
  rewritten history stand down with the reason.
