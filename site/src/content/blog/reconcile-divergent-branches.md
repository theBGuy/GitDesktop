---
title: "Merge, rebase, or fast-forward only: what git pull is asking you"
description: "git pull stops with \"Need to specify how to reconcile divergent branches.\" What merge, rebase and fast-forward only each do, and which default to set."
pubDate: 2026-11-11
author: theBGuy
pillar: git-safety
tags: ["git", "rebase", "merge"]
ogImage: "/og/reconcile-divergent-branches.png"
ogImageAlt: "GitDesktop blog card reading “Merge, Rebase, or Fast-Forward Only”, above three columns of Git output. Under --no-rebase, a commit graph where the new merge commit 4073b84 joins two lines of work; under --rebase, a straight line of three commits topped by the rebased 3b56cc1; under --ff-only, “fatal: Not possible to fast-forward, aborting.” Captioned “one fork, three answers: git pull wants you to pick”."
---

`git status` said you were one commit ahead of the server. You run
`git pull` to pick up whatever your teammate pushed this morning, and Git
fetches it, then stops:

```sh
$ git status --short --branch
## main...origin/main [ahead 1]
$ git pull
From …/newsletter
   afd2d11..4e21aed  main       -> origin/main
hint: You have divergent branches and need to specify how to reconcile them.
hint: You can do so by running one of the following commands sometime before
hint: your next pull:
hint:
hint:   git config pull.rebase false  # merge
hint:   git config pull.rebase true   # rebase
hint:   git config pull.ff only       # fast-forward only
hint:
hint: You can replace "git config" with "git config --global" to set a default
hint: preference for all repositories. You can also pass --rebase, --no-rebase,
hint: or --ff-only on the command line to override the configured default per
hint: invocation.
fatal: Need to specify how to reconcile divergent branches.
```

The fetch landed and your branch hasn't moved. Git stopped because it knows
three ways to combine your commit with the one it just downloaded, and it
no longer picks one for you. The hint offers all three as settings. Each
leaves a different history behind, so see what each one does before you make
it your default.

## Ahead and behind at the same time

The `[ahead 1]` was accurate when Git printed it. `git status` compares your
branch with `origin/main`, Git's record of the server's branch, and that
record is only as fresh as your last fetch or push. The pull's fetch just
refreshed it, so status now has more to say:

```sh
$ git status
On branch main
Your branch and 'origin/main' have diverged,
and have 1 and 1 different commits each, respectively.
  (use "git pull" if you want to integrate the remote branch with yours)

nothing to commit, working tree clean
$ git log --oneline --left-right HEAD...origin/main
< 4c8689a Require an email address to subscribe
> 4e21aed Add unsubscribe link to footer
```

With three dots and `--left-right`, `git log` lists the commits on each side
of the split: `<` marks commits that are on your branch alone, `>` marks
commits that are on `origin/main` alone (on another branch or remote, use
your upstream, such as `origin/<branch>`). Each side has a commit the other
lacks, and a fast-forward can only move your branch forward to the server's
tip. That's what "divergent" means here. A branch that's merely behind
fast-forwards without a question, and one that's merely ahead has nothing to
pull; the error appears when your branch is both at once.

## Git used to merge without asking

For most of its history, `git pull` answered this question itself by
making a merge commit. Git 2.27 started printing a warning on pulls when
no `pull.rebase` setting existed, 2.31 limited the warning to pulls that
couldn't fast-forward, and 2.33.1 turned it into the error you just hit;
2.34.1 stopped raising it when a branch was ahead with nothing new to
pull. A newer Git, or a new machine, can stop on pulls your old setup
merged without comment. All the captures here use Git 2.51.1. Apart
from the Windows one near the end, none has a pull setting until the
fast-forward-only section adds one.

## Merge keeps both lines

`git pull --no-rebase` is the one-time form of `pull.rebase false`, and it
does what Git did by default before 2.33.1:

```sh
$ git pull --no-rebase
Merge made by the 'ort' strategy.
 footer.html | 1 +
 1 file changed, 1 insertion(+)
$ git log --oneline --graph -4
*   4073b84 Merge branch 'main' of …/newsletter
|\  
| * 4e21aed Add unsubscribe link to footer
* | 4c8689a Require an email address to subscribe
|/  
* afd2d11 Add signup form
```

Both commits keep their hashes, and a new merge commit joins them. Its
message names the remote by its path or URL, and on a busy branch you get
one of these for every pull that found new work on both sides. Some teams
want that record of where work met; others read it as clutter in `git log`.

To undo a mistaken merge, run `git reset --keep ORIG_HEAD` right after
the pull, before anything else. `ORIG_HEAD` records where your branch was
before the pull, until the next stash, reset, merge, rebase or pull moves
it. `--keep` holds on to uncommitted edits in files the merge didn't change
(staged ones come back unstaged), and if the merge changed one of them, it
refuses without touching anything:

```sh
$ git reset --keep ORIG_HEAD
$ git status --short --branch
## main...origin/main [ahead 1, behind 1]
```

The branch is back to one commit on each side, and `origin/main` keeps
what the fetch brought in. Once you've pushed the merge, a reset no longer
helps, because the next pull brings the merge straight back; [revert
it](/blog/revert-a-merge-commit/) or leave it in.

## Rebase puts your commits on top

`git pull --rebase`, the one-time form of `pull.rebase true`, sets
your commits aside, moves the branch to the server's tip, and replays
yours on top of it:

```sh
$ git pull --rebase
Successfully rebased and updated refs/heads/main.
$ git log --oneline --graph -3
* 3b56cc1 Require an email address to subscribe
* 4e21aed Add unsubscribe link to footer
* afd2d11 Add signup form
$ git log --oneline -1 ORIG_HEAD
4c8689a Require an email address to subscribe
```

The history is a straight line, and your commit has a new hash. Its changes
are the same, but its parent isn't, and the parent is part of what a
commit's hash is computed from. `ORIG_HEAD` still points at the original
`4c8689a`. That rewrite costs nothing for commits that exist only in your
clone, which is why rebasing is the usual choice for local work. If you
also pushed them to a branch for review, that branch keeps the old copies,
and updating it afterward takes a force push. And if someone force-pushed
the branch you're pulling, [a rebasing pull can drop a commit you'd
already pushed there](/blog/pull-rebase-deleted-your-commit/).

## Fast-forward only says no

The hint's third setting, `pull.ff only`, never makes a merge or a rebase
on its own. When the branches have diverged, the pull refuses and leaves
your branch where it was. As a default, it stops just the pulls that
need a decision:

```sh
$ git config --global pull.ff only
$ git pull
From …/newsletter
   3b56cc1..13a2f31  main       -> origin/main
hint: Diverging branches can't be fast-forwarded, you need to either:
hint:
hint: 	git merge --no-ff
hint:
hint: or:
hint:
hint: 	git rebase
hint:
hint: Disable this message with "git config set advice.diverging false"
fatal: Not possible to fast-forward, aborting.
$ git pull --rebase
Successfully rebased and updated refs/heads/main.
```

The refusal comes with its own hint, written for `git merge` and
`git rebase` as separate commands. You can stay with pull: `--rebase`
and `--no-rebase` on the command line override the config, so with
`pull.ff only` set, `git pull --rebase` goes straight through. Pulls that
can fast-forward still do. A global `pull.ff only` also outranks rebase
settings in config. A repository that should rebase by default needs two
local settings: `pull.ff true` to lift the refusal, then `pull.rebase true`.

## When the pull can't finish

A rebasing pull checks your working tree before it fetches anything, and
uncommitted changes to tracked files stop it. `--autostash` stashes them for
the length of the pull and puts them back afterward:

```sh
$ git pull --rebase
error: cannot pull with rebase: You have unstaged changes.
error: Please commit or stash them.
$ git pull --rebase --autostash
From …/newsletter
   c5ffdca..254ef96  main       -> origin/main
Created autostash: 0904860
Applied autostash.
Successfully rebased and updated refs/heads/main.
$ git status --short --branch
## main...origin/main [ahead 1]
 M signup.html
```

Putting them back can conflict when the pull changed the same lines. The
pull still ends with "Successfully rebased", after a note that "Applying
autostash resulted in conflicts": the file is left with conflict markers,
and the stash stays in `git stash list` until you fix the file, run
`git restore --staged <file>` to leave your edit unstaged again, and then
`git stash drop`. `rebase.autoStash true` makes stashing the default, for
plain `git rebase` as well; Git 2.51 added `pull.autoStash` for pulls alone.

Either kind of pull can also stop on a conflict, when you and your teammate
changed the same lines:

```sh
$ git pull --no-rebase
From …/newsletter
   a194b4b..ba0f53b  main       -> origin/main
Auto-merging footer.html
CONFLICT (content): Merge conflict in footer.html
Automatic merge failed; fix conflicts and then commit the result.
$ git merge --abort
$ git status --short --branch
## main...origin/main [ahead 1, behind 1]
```

`git merge --abort` puts the branch back as it was before the pull, and
the fetched commits stay in `origin/main` for your next try. A rebasing
pull stops the same way, once for each of your commits that conflicts, and
`git rebase --abort` undoes the whole rebase however far it got. To resolve
instead, fix the file and `git add` it, then run `git commit` for a merge or
`git rebase --continue` for a rebase.

## Windows picked an answer at install time

If you've never seen this error in Git Bash or PowerShell, look at where
your pull setting comes from:

```sh
$ git config --show-origin --get-regexp "^pull\."
file:C:/Program Files/Git/etc/gitconfig	pull.rebase false
$ git status --short --branch
## main...origin/main [ahead 1]
$ git pull
From …/newsletter
   afd2d11..4e21aed  main       -> origin/main
Merge made by the 'ort' strategy.
 footer.html | 1 +
 1 file changed, 1 insertion(+)
$ git log --oneline --graph -4
*   ecf441f Merge branch 'main' of …/newsletter
|\  
| * 4e21aed Add unsubscribe link to footer
* | 4c8689a Require an email address to subscribe
|/  
* afd2d11 Add signup form
```

That file is the system config of Git for Windows. Its installer has a page
titled "Choose the default behavior of `git pull`" with Merge preselected,
and Merge writes `pull.rebase false` into that file. Every pull on that
install merges without asking, while a teammate on macOS or Linux with
no pull setting, or you in WSL, gets the error instead. The same file
holds the installer's `core.autocrlf` setting, the one [the line-endings
post](/blog/every-file-shows-as-modified/) traces phantom changes to. A
global `pull.ff only` overrides the installer's pull answer, whichever
one it wrote, so setting that on each machine you use makes them all
behave the same.

## Picking a default

If your team has a rule, such as rebasing before every push, set the value
that matches it. Without one, `pull.ff only` is the default least likely to
surprise you. Every pull either fast-forwards or stops, and when it stops
you choose: `--rebase` for commits that never left your clone, `--no-rebase`
for commits already shared under their current hashes.

## Or don't do any of this

The Pull button in [GitDesktop](/features/) only ever fast-forwards. No pull
setting, including the one the Windows installer writes, makes it merge or
rebase. Once a fetch has shown that your branch diverged, the button is
grayed out, and hovering it reads "Pull — branch has diverged (1 commit
behind origin/main); use Pull with rebase or merge from the menu". Both rows
are in the menu beside it, and Pull with rebase first checks for commits an
upstream force push would make it drop, then asks whether to keep them.

A fetch leaves your branch alone. A pull has to change it,
and Git now asks you how.
