- Publishing a branch from the sync bar or the branch list now asks first: a
  push that would create the branch on a remote names the branch and its
  destination before anything is sent, with **Cancel** focused so a stray
  Enter backs out. A branch the remote already has (as of the last fetch)
  just pushes, as before. When a push goes somewhere other than the branch
  it tracks, the **Push** button's tooltip names where it goes. The toast
  afterwards says **Published** only when the last fetch showed the branch
  was new to the remote, and **Pushed** otherwise; publishing from the sync
  bar now shows it too. The confirmation opens as soon as the local checks
  finish, while the fork pull-request check runs alongside: **Publish** is
  held for up to 10 seconds with the reason shown, then becomes available
  with a note when the check hasn't finished, and a match still swaps in the
  fork option.
