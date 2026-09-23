---
title: "Undo a hard reset: how far the reflog reaches"
description: "git reset --hard didn't destroy your commits. How to read the reflog, point a branch back at lost work, and know where the journal has holes."
pubDate: 2026-09-23
author: theBGuy
pillar: git-safety
tags: ["git", "recovery", "reflog"]
ogImage: "/og/undo-a-hard-reset.png"
ogImageAlt: "GitDesktop blog card reading “Undo a Hard Reset. How Far the Reflog Reaches.” — git log's answer with the two lost commits struck out, beside git reflog's answer where the same commits are still listed: the history that won next to the history that happened."
---

You ran `git reset --hard HEAD~2` because the last two commits looked
disposable. They weren't.

```sh
$ git log --oneline
30b6dbc add cli flags
2333eb4 add parser
8afb88a init
$ git reset --hard HEAD~2
HEAD is now at 8afb88a init
$ git log --oneline
8afb88a init
```

The branch is two commits shorter, the working tree matches it, and
`git log` reports the new state as if the old one had been a rumor.
That's because log answers one question: what is reachable, walking
parents back from this tip? 30b6dbc has no place in that walk anymore.
The commit itself still exists — nothing that removes reachability
removes objects; that job belongs to garbage collection, much later.

The problem isn't recovery, it's addressing: you need the hash of a
commit that no ref and no log will show you. Git wrote it down. (All
of this is Git 2.51, stock configuration.)

## The reflog

Every time a ref that keeps a reflog moves (your branches and HEAD
all do, by default), Git appends a line: the new position and the
action that caused it. The list runs on wall-clock order, not
ancestry, and it keeps growing whether or not the old position
stays reachable:

```sh
$ git reflog
8afb88a HEAD@{0}: reset: moving to HEAD~2
30b6dbc HEAD@{1}: commit: add cli flags
2333eb4 HEAD@{2}: commit: add parser
8afb88a HEAD@{3}: commit (initial): init
```

`HEAD@{0}` is where HEAD stands now and the move that put it there.
`HEAD@{1}` is one move earlier — and there is the "lost" commit, hash
and all. The rescue is itself a hard reset, so a few cautions first.
`--hard` replaces your working tree: if you've made uncommitted
changes since the incident, run `git stash --include-untracked` and
pop it after. Stashing writes a reset entry of its own into HEAD's
reflog, which slides the lost commit one slot down: after a stash,
re-read `git reflog`, or skip the counting entirely with
`git reset --hard 30b6dbc`, which names the commit and can't drift.
(`--include-untracked` still leaves ignored files out, so if one
shares a path with the commits you're restoring, move it aside
first or reach for `git stash --all`.) And if you'd rather not move
the branch at all, `git branch rescue 30b6dbc` hangs a new branch
on the lost commit and leaves everything else where it is.
Otherwise, the undo is one more move:

```sh
$ git reset --hard HEAD@{1}
HEAD is now at 30b6dbc add cli flags
$ git log --oneline
30b6dbc add cli flags
2333eb4 add parser
8afb88a init
```

## HEAD's reflog and the branch's

There is no single reflog. Every branch keeps its own, and so does
HEAD, and they record different things. A branch's reflog gains a
line only when the branch itself moves:

```sh
$ git reflog show main
30b6dbc main@{0}: reset: moving to HEAD@{1}
8afb88a main@{1}: reset: moving to HEAD~2
30b6dbc main@{2}: commit: add cli flags
2333eb4 main@{3}: commit: add parser
8afb88a main@{4}: commit (initial): init
```

Commits and both resets are here: a hard reset on a checked-out branch
moves the branch and HEAD together, and each reflog records it. What
`main`'s reflog will not contain is a checkout, because switching
branches moves HEAD alone. A new branch's reflog opens by naming
where it came from, and an amend, which moves the tip, records like
any other move:

```sh
$ git switch -c feature
Switched to a new branch 'feature'
$ git reflog show feature
30b6dbc feature@{0}: branch: Created from HEAD
$ git commit -am "wip"
[feature 3dee353] wip
 1 file changed, 1 insertion(+)
$ git commit --amend -m "add search"
[feature db4f742] add search
 Date: Wed Sep 23 11:48:25 2026 -0400
 1 file changed, 1 insertion(+)
$ git reflog show feature
db4f742 feature@{0}: commit (amend): add search
3dee353 feature@{1}: commit: wip
30b6dbc feature@{2}: branch: Created from HEAD
```

The pre-amend state is addressable right there: 3dee353, one line
below the amend that replaced it.

## A deleted branch takes its reflog with it

The reflog belongs to the ref. Delete one and you delete the other:

```sh
$ git switch main
Switched to branch 'main'
$ git branch -D feature
Deleted branch feature (was db4f742).
$ git reflog show feature
fatal: ambiguous argument 'feature': unknown revision or path not in the working tree.
Use '--' to separate paths from revisions, like this:
'git <command> [<revision>...] -- [<file>...]'
```

Notice `(was db4f742)`: Git hands you the undo in the delete receipt.
And the branch's reflog dying doesn't orphan its story, because
HEAD's watched every move you made while you sat on that branch:

```sh
$ git reflog -6
30b6dbc HEAD@{0}: checkout: moving from feature to main
db4f742 HEAD@{1}: commit (amend): add search
3dee353 HEAD@{2}: commit: wip
30b6dbc HEAD@{3}: checkout: moving from main to feature
30b6dbc HEAD@{4}: reset: moving to HEAD@{1}
8afb88a HEAD@{5}: reset: moving to HEAD~2
```

The delete only removed the name, so only the name needs remaking:

```sh
$ git branch feature db4f742
$ git reflog show feature
db4f742 feature@{0}: branch: Created from db4f742
```

The branch is back. Its reflog is not: one entry, dated now. Whatever
you want to know about the branch's past, you now ask HEAD — and
HEAD's reflog holds only the moves HEAD itself made. A branch that
was created and deleted without a checkout, or one that was
[moved without one](/blog/update-a-branch-without-checking-it-out/)
by `git fetch origin main:main` or `git branch -f`, or one tended in
a linked worktree (each worktree's HEAD keeps its own reflog, which
leaves when the worktree does) has positions no reflog of yours
remembers. There the delete receipt is the whole rescue, and if it
has scrolled away, `git fsck --unreachable` still knows the hash;
more on that door below.

## Commits no branch ever held

A commit made on a detached HEAD (an experiment, a CI script, a quick
look at an old release) has no branch reflog at all. HEAD's is the
only record there is, and Git knows it, which is why walking away from
one triggers the loudest warning in this post:

```sh
$ git switch --detach main
HEAD is now at 30b6dbc add cli flags
$ git commit -am "try a spike"
[detached HEAD 52dcfb2] try a spike
 1 file changed, 1 insertion(+)
$ git switch main
Warning: you are leaving 1 commit behind, not connected to
any of your branches:

  52dcfb2 try a spike

If you want to keep it by creating a new branch, this may be a good time
to do so with:

 git branch <new-branch-name> 52dcfb2

Switched to branch 'main'
```

The rescue command is printed for you, hash included. If it
scrolled past, HEAD's reflog caught the same hash: `git reflog`
shows `52dcfb2 HEAD@{1}: commit: try a spike`, and
`git branch spike 52dcfb2` makes the commit permanent.

## Where the reflog ends

Everything so far worked because a reflog existed and reached back
far enough. Three ways that assumption fails, in rising order of surprise.

**It clamps at its own beginning.** A reflog answers time queries:
`main@{1.hour.ago}` means "where was main an hour ago". But ask about
a time before its first entry and you get the oldest answer
available, plus a warning:

```sh
$ git log -1 --oneline main@{1.hour.ago}
warning: log for 'main' only goes back to Wed, 23 Sep 2026 11:48:24 -0400
8afb88a init
```

(This demo repo is minutes old, so an hour ago predates its reflog.)
A script that resolves `@{time}` without reading warnings will happily
use the clamped answer as if it were the real one.

**It stays home.** The reflog is not part of history, and no transfer
carries it: push and pull move commits between repositories, while
each side's reflogs record only what happened locally. A clone starts
new ones:

```sh
$ cd ..
$ git clone -q app copy
$ cd copy
$ git reflog
30b6dbc HEAD@{0}: clone: from …/app
```

One line. Your reflog can't help a teammate undo their reset, theirs
can't help you, and a fresh clone of your own repository arrives with
no past. The safety net is strictly local.

**It can be erased while the history stays.** Entries expire on their
own eventually (90 days for reachable positions, 30 for unreachable
ones, by default), and `git reflog expire` will erase a reflog on
request — including entries that point at commits alive on the branch:

```sh
$ git reflog expire --expire=now refs/heads/main
$ git reflog show main
$ git log --oneline
30b6dbc add cli flags
2333eb4 add parser
8afb88a init
```

The history is intact; the record of its moves is gone. And notice
what the emptiness looks like: `git reflog show main` prints nothing,
which is also exactly what it prints for a ref whose logging was
switched off from the start. To every read of the log those two are
the same thing, but `git reflog exists` still tells them apart,
because expiry empties the file where disabling never writes one:

```sh
$ git reflog exists refs/heads/main && echo yes
yes
```

The expiry above was per-ref, too: it named `refs/heads/main`, and
left HEAD's reflog untouched.

Two smaller edges: tags don't get reflogs by default (branches,
remote-tracking refs, notes, and HEAD do), and the stash list is
itself a reflog on one ref — `stash@{0}` is a reflog entry, so
dropping one edits the record.

And when the reflog has failed you (expired, erased, or never
there), one door is left. Garbage collection spares whatever a
reflog still names, but a commit nothing names anymore only waits;
until gc takes it, `git fsck --unreachable` will list it, hash and
all, and a hash is all a rescue needs. That walk, twin trap and all,
is [the dropped-stash post](/blog/recover-a-dropped-git-stash/).

## Or don't do any of this

Two of [GitDesktop](/features/)'s safety checks are reflog readers,
and both had to answer the question this last section raises: what do
you do when the reflog isn't there?

A force push from the app reaches for the strict flag pair,
`--force-with-lease --force-if-includes`. The second of those walks
the reflog to prove the remote work you're about to overwrite was
actually seen and integrated locally, not merely fetched past. A
branch whose reflog was never written has no way to pass that check,
and the app doesn't pretend it did: the push falls back to the lease
alone, and the success toast names the weaker guarantee it ran
under. An expired reflog gets no such grace: `git reflog exists`
still answers yes for the emptied file, and the app leaves Git's
refusal standing rather than trading an evidence problem for a
weaker guard.

The second reader watches for the situation [the fork-point
post](/blog/pull-rebase-deleted-your-commit/) was about: an
upstream rewritten underneath your branch. When a branch and its
upstream have diverged, the app pairs two probes before it offers
the recovery reset: are all of your local commits already upstream
patch-for-patch, and is the upstream's tip a position your branch's
own reflog has ever seen? A rewrite says yes to the first and no
to the second. A branch with no reflog can't answer the second
question at all — and reading no data as "rewritten", or as
"safe", would both be guesses. The verdict stays unknown,
pinned by `rewrite_status_without_a_reflog_refuses_to_guess`.

The reflog is a record with edges, and a tool that reads it has to
treat the edge as an answer of its own, distinct from anything the
record could have said.

`git log` is the history that won. The reflog is the history that happened.
