---
title: "Work on two branches at once with git worktree"
description: "git worktree gives a second branch its own folder — one repository, two working trees, no stash dance. The rules that keep it safe, and the cleanup."
pubDate: 2026-08-19
author: theBGuy
pillar: git-safety
tags: ["git", "worktrees", "workflow"]
---

You're an hour into a parser rework. Half the call sites are on the new
signature, the tests are red on purpose, and there's an untracked file
of notes you'd rather not explain. Then a bug report lands: production
crashes on a null payload. The fix belongs on `main`, and it can't wait
for your rework.

So you do the stash dance: `git stash`, switch, fix, push, switch back,
`git stash pop`, and hope the pop applies. Usually it does. The times
it doesn't, you're resolving conflicts inside work that was
half-finished on purpose, the one place where you have no idea what
"correct" looks like.

Underneath the dance sits an assumption: a repository has one working
tree, so branches take turns using it. That assumption became optional
in 2015, when Git 2.5 shipped `git worktree`.

## A second folder, same repository

Leave the mess exactly where it is:

```sh
$ git branch --show-current
feature
$ git status --short
 M src/parser.js
?? notes.md
$ git worktree add -b fix-crash ../hotfix origin/main
Preparing worktree (new branch 'fix-crash')
branch 'fix-crash' set up to track 'origin/main'.
HEAD is now at 812aeba Expand usage docs (#12)
```

That created a *linked worktree*: a second working tree in its own
folder, attached to the repository you ran the command from.
`-b fix-crash` cuts the branch, `../hotfix` is where the checkout
goes, and `origin/main` is the base (fetch first, so the fix starts
from the `main` the remote has, not your clone's stale copy). The
tracking line is ordinary branching-from-a-remote behavior; nothing
about it is worktree-specific.

"Attached" is the key word. This is not a second clone. There is one
object database, one set of branches, one config, one list of
remotes; the new folder holds a checkout and nothing else:

```sh
$ git worktree list
…/app     542eaf6 [feature]
…/hotfix  812aeba [fix-crash]
$ cat ../hotfix/.git
gitdir: …/app/.git/worktrees/hotfix
```

The `.git` in a linked worktree is a file, not a directory: a pointer
back to the real repository, which keeps the linked checkout's
bookkeeping under `.git/worktrees/`. What each worktree does own is a
HEAD, an index, and its working files. The split runs along one line:
the things that make up "where I'm standing" are per-worktree, and the
things that make up "the repository" exist once.

## The fix, without the dance

Open `../hotfix` in a second editor window, make the fix, and commit
it over there. A fresh worktree checks out tracked files only, so
ignored things like `node_modules` and build output start absent;
this one-line fix doesn't miss them:

```sh
$ git -C ../hotfix commit -am "fix: guard null payload"
[fix-crash 0a21336] fix: guard null payload
 1 file changed, 1 insertion(+)
$ git log --oneline -1 fix-crash
0a21336 fix: guard null payload
$ git push origin fix-crash
To …/origin.git
 * [new branch]      fix-crash -> fix-crash
$ git status --short
 M src/parser.js
?? notes.md
```

Look where the last three commands ran: in your original checkout, the
seat you never left. The commit was made in `../hotfix`, yet from the
`feature` seat it was already there: not fetched, not copied, just
there, because there is only one repository. The push works from
either folder for the same reason. And your own working tree sat out
the whole thing: the same modified file, the same untracked notes,
the dev server still warm. Open a PR for `fix-crash` and get back
to the rework.

## One branch, one checkout

If both folders share the branches, can they share a branch?

```sh
$ git switch fix-crash
fatal: 'fix-crash' is already used by worktree at '…/hotfix'
```

No, and the refusal is the design. A branch is one shared pointer, but
each worktree built its index and working files against wherever its
own HEAD stood. If two worktrees stood on `fix-crash` and one of them
committed, the other would be standing on history that had moved under
it. Git refuses up front instead.

You've met this guard before if you've read [the branch-updating
post](/blog/update-a-branch-without-checking-it-out/): it's the same
rule that stops `git fetch origin main:main` while `main` is checked
out anywhere, and the same reason `git branch -D` declines to delete
a branch a worktree is using; in every case the error names the
folder to go look at. When you want the files without any branch
question at all, add the worktree with `--detach` — a checkout
pinned to a commit, no branch involved.

## The stash is shared too

The stash list is a ref, and it belongs to the repository, not to
any one checkout:

```sh
$ git stash push -m "parser rework, half done"
Saved working directory and index state On feature: parser rework, half done
$ git -C ../hotfix stash list
stash@{0}: On feature: parser rework, half done
```

One list, visible from every seat. Pop it back from the seat that
pushed it. Nothing enforces that: a stash applies to whichever
working tree runs the pop. If you use worktrees and stashes together,
the "On feature" prefix and a real message are what tell you, later,
where a stash came from and where it belongs.

## Folders are disposable, the bookkeeping isn't

The fix is pushed and the PR is open, so the hotfix worktree has
done its job:

```sh
$ git worktree remove ../hotfix
$ git branch --list fix-crash
  fix-crash
```

`remove` succeeds without a word: the folder and the repository's
record of it are gone, and nothing else; the branch survives. If the
worktree still had modified or untracked files, the same command
refuses: `contains modified or untracked files, use --force to delete it`.

What you shouldn't do is delete the folder by hand. Git copes with
that too, though:

```sh
$ git worktree add --detach ../scratch
Preparing worktree (detached HEAD 542eaf6)
HEAD is now at 542eaf6 wip: extract tokenizer
$ rm -rf ../scratch
$ git worktree list
…/app      542eaf6 [feature]
…/scratch  542eaf6 (detached HEAD) prunable
$ git worktree prune
$ git worktree list
…/app  542eaf6 [feature]
```

The folder died; the record remained, flagged `prunable`, until
`git worktree prune` collected it.

One more state you'll meet eventually: a worktree on a USB stick or a
network share isn't always mounted, and from the repository's side an
unmounted folder looks exactly like a deleted one; a prune would sever
it. `git worktree lock --reason "on the USB drive" ../usb` protects
it: a locked worktree can't be pruned, and `remove` refuses, quoting
your reason back at you.

Moving is allowed, with one asymmetry. `git worktree move` relocates a
linked worktree cleanly, while moving the main repository folder by
hand breaks every link; `git worktree repair`, run from the new
location, mends them.

## Or don't do any of this

The post you're reading was written in a worktree. GitDesktop's
repository has a website lane, and on my machine that lane lives in a
linked worktree, so drafting a post never touches the branch the app
work is standing on. The client managing those worktrees is
[GitDesktop](/features/), which I build. Its **Worktrees…** dialog
carries the whole lifecycle (add, open, rename, lock, promote,
delete), with the guards built in: deleting a dirty or locked
worktree asks first, and a moved repository folder gets re-connected
by its **Repair links** button.

Two of its choices map straight onto the rules above. Switch to a
branch that lives in another worktree and you don't get the
`already used by worktree` error: the branch is badged, and choosing
it offers to open that worktree instead. And **Promote to main
workspace** collapses the sequence the one-checkout rule forces
(remove the worktree first, then check its branch out in the main
workspace) into one action, once the worktree is clean.

Branches take turns only when you give them one folder to take turns
in. The habit outlived the constraint by a decade.
