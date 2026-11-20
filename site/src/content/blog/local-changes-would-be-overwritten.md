---
title: "Switch branches when Git says your changes would be overwritten"
description: "git switch stops with \"Your local changes to the following files would be overwritten by checkout.\" Why only some files block it, and the ways past."
pubDate: 2026-11-18
author: theBGuy
pillar: git-safety
tags: ["git", "branches", "stash"]
ogImage: "/og/local-changes-would-be-overwritten.png"
ogImageAlt: "GitDesktop blog card reading “Your Local Changes Would Be Overwritten”, above two terminal listings side by side. Under “$ git status --short”, M config.json and M theme.css; under “$ git diff --name-only HEAD release”, config.json and dark.css. config.json is lit in both lists. Captioned “git switch stops only where the two lists meet”."
---

You need a look at the release branch, but you're partway through a
dark mode on `dark-mode`, with two files edited and nothing committed.
You switch anyway:

```sh
$ git status --short
 M config.json
 M theme.css
$ git switch release
error: Your local changes to the following files would be overwritten by checkout:
	config.json
Please commit your changes or stash them before you switch branches.
Aborting
```

Git names one file, though `git status` lists two, and nothing has moved:
you're still on `dark-mode` with both edits where you left them. The
error suggests committing or stashing, and `git switch` has a third
option it doesn't mention. Which one fits depends on which branch the
edit is meant for.

## Git stops only for files it has to replace

A switch rewrites only the files that differ between your branch's latest
commit and the other branch's. `git diff` lists them:

```sh
$ git diff --name-only HEAD release
config.json
dark.css
```

`dark.css` exists only on your branch, so the switch would delete it, which
is safe because you haven't edited it. `config.json` differs too, and you
have edited it. Writing the release branch's copy would wipe out your edit,
so Git refuses the whole switch. `theme.css` is the same on both branches,
which leaves Git nothing to replace there: your edit stays in the file and
comes along to whichever branch you switch to.

The check covers staged edits as well as unstaged ones, and an edited
file that the other branch deletes. An untracked file in a spot
the other branch tracks gets its own version of the error, about
`untracked working tree files`, which asks you to move or remove the
file instead. A file your `.gitignore` covers gets no warning at all:
the switch replaces it with the other branch's copy, so move a local secrets
or config file out of the way before switching to a branch that tracks one
at the same path.

## Park the edit with a stash

When the edit is meant for your branch and you only need a quick look at
the other one, stash it. Give `git stash push` a path and it sets aside that
file alone, which is all the switch needs:

```sh
$ git stash push config.json
Saved working directory and index state WIP on dark-mode: 4151c8b Add dark palette
$ git switch release
M	theme.css
Switched to branch 'release'
$ git switch dark-mode
M	theme.css
Switched to branch 'dark-mode'
$ git stash pop
On branch dark-mode
Changes not staged for commit:
  (use "git add <file>..." to update what will be committed)
  (use "git restore <file>..." to discard changes in working directory)
	modified:   config.json
	modified:   theme.css

no changes added to commit (use "git add" and/or "git commit -a")
Dropped refs/stash@{0} (632d4cc9e75440de52e1010874f90bf2bdb2de52)
```

Each `M` line is Git reporting a change it carried: the `theme.css` edit sat
in your working tree on `release` and came back with you. Plain `git stash`
takes every tracked change if you'd rather carry nothing. It skips untracked
files, though, so the untracked version of the error needs `git stash -u`.
And `git stash pop` brings staged edits back unstaged, apart from newly
added files, unless you add `--index`.

You can pop a stash on any branch. On one where the same lines changed,
the pop conflicts and Git keeps the entry: fix the file, `git add` it,
then run `git stash drop`.

## Move the edit with `--merge`

Sometimes the edit is meant for the other branch, because you started
it on the wrong one. `git switch --merge` takes it along. Git stashes your
changes, switches, and applies the stash on the other side:

```sh
$ git switch --merge release
Applied autostash.
Switched to branch 'release'
The following paths have local changes:
M	config.json
M	theme.css
$ git diff config.json
diff --git a/config.json b/config.json
index 5f84037..bec7da4 100644
--- a/config.json
+++ b/config.json
@@ -3,5 +3,5 @@
   "refreshSeconds": 30,
   "showUptime": true,
   "region": "eu-west",
-  "theme": "light"
+  "theme": "dark"
 }
$ git switch --merge dark-mode
Applied autostash.
Switched to branch 'dark-mode'
The following paths have local changes:
M	config.json
M	theme.css
```

`config.json` arrived with your theme change on top of the release branch's
30-second refresh, and the second switch shows the move works in the other
direction too. These transcripts come from Git 2.56, and `--merge` is the
one place in this post where your version changes the outcome: it started
stashing in Git 2.55.

When your edit and the other branch changed the same lines, the stash
doesn't apply cleanly. Say you'd also tried a 15-second refresh:

```sh
$ git switch --merge release
Your local changes are stashed, however applying them
resulted in conflicts.  You can either resolve the conflicts
and then discard the stash with "git stash drop", or, if you
do not want to resolve them now, run "git reset --hard" and
apply the local changes later by running "git stash pop".

Switched to branch 'release'
The following paths have local changes:
M	config.json
M	theme.css
$ git status --short
UU config.json
M  theme.css
$ git stash list
stash@{0}: autostash while switching to 'release'
```

The switch went through and left `config.json` with conflict markers.
Your other change was applied and staged, and the complete set is still in
the stash list. To finish the move, fix the markers, `git add config.json`,
and `git stash drop` the stash. To call it off, follow the second half
of Git's message:

```sh
$ git reset --hard
HEAD is now at 11cccd5 Refresh the status every 30 seconds
$ git switch dark-mode
Switched to branch 'dark-mode'
$ git stash pop
On branch dark-mode
Changes not staged for commit:
  (use "git add <file>..." to update what will be committed)
  (use "git restore <file>..." to discard changes in working directory)
	modified:   config.json
	modified:   theme.css

no changes added to commit (use "git add" and/or "git commit -a")
Dropped refs/stash@{0} (76c5caa4fbe40568cd7e798818263db76e2743cf)
```

`git reset --hard` throws away the half-applied changes on `release`, which
is safe here because the stash holds them. Back on `dark-mode`, the pop
restores both edits, the 15-second refresh included.

The drop and the reset both depend on that stash, so check that your
Git printed the message about stashing before you run either. Before 2.55,
`--merge` made the same merge with no stash behind it: `git stash drop`
would delete whatever older entry sat at the top of your stash list, and
a reset would wipe the edit from your files. On those versions a conflicting
`--merge` prints just the usual switch lines, and `git status` shows the
`UU`. The switch back and `git stash` both refuse until you resolve the file
where you are, and anything staged stops `--merge` before it starts.

## Commit it, or go around it

The error's other suggestion, committing, is right when the edit is
finished or close to it. An unfinished one can ride in a temporary commit:
`git commit -am "WIP"` (`-a` picks up tracked files only, so `git add` new
ones first), switch away and back, then `git reset HEAD~1` turns the commit
back into uncommitted changes: your edits unstaged, and the files you added
untracked again. Do this only with a commit you haven't pushed.

If you need the other branch for more than a quick look, `git worktree add`
checks it out in a second folder and leaves your edits alone; [the worktree
post](/blog/work-on-two-branches-at-once/) walks through it. And if the edit
should start a new branch, `git switch -c <name>` with no starting point
can't hit this error, since the new branch starts at the commit you're on
and no file needs replacing.

One option gets past the check by giving up your work.
`git switch --discard-changes` resets every tracked file to the other
branch, including edits Git would have carried, deletes files you've added
but never committed, and reports only that it switched. `git checkout -f`
goes further: it also overwrites untracked files at paths the other branch
tracks, where `--discard-changes` stops with an error.

## Merge and pull refuse too

`git merge` runs a similar check and words it for itself:
`would be overwritten by merge`, then "Please commit your changes
or stash them before you merge." A merge that creates a merge commit
is stricter: anything staged stops it, even in a file the merge
doesn't touch, and that refusal leaves out the please-commit line.
A pull that merges or fast-forwards stops the same way after its
fetch, and a rebasing pull refuses before fetching if any tracked
file has uncommitted changes. [The post on pull's divergent-branches
error](/blog/reconcile-divergent-branches/) covers stashing through a
pull with `--autostash`.

## Or don't do any of this

In [GitDesktop](/features/), switching branches with uncommitted changes
opens a prompt, **You have changes in progress**, offering two choices.
**Bring changes** runs a plain `git switch`, which carries whatever Git can
carry. **Stash and switch** stashes every change, untracked files included,
then switches, and with **Reapply after switching** ticked it applies the
stash on the new branch. When **Bring changes** hits this error, the prompt
reopens pointed at the other path, with a note that opens "Bringing changes
didn't work — git would overwrite them. Stash and switch instead." **Stash
and switch** is now the primary button, and **Reapply after switching**
comes ticked unless you'd unticked it yourself, so the retry still brings
your changes along. If the reapply conflicts, the files wait in **Changes**
to be resolved and the stash is kept as a backup until you drop it. If
a file on the new branch is in the way, Git puts back what it can and keeps
the stash, which then holds the only copy of the rest.

Git carries an uncommitted edit to any branch where it fits. Where it
doesn't, a stash gets it there in one piece.
