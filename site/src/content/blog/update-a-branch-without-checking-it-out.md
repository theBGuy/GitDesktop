---
title: "Update a Git branch without checking it out"
description: "git fetch origin main:main moves a branch while you stay on another. The refspec that does it, the refusals that protect you, and the diverged case."
pubDate: 2026-08-12
author: theBGuy
pillar: git-safety
tags: ["git", "branches", "workflow"]
---

Your pull request just merged. You're already on the next branch, and
now your local `main` is stale: the merge landed on the remote, not in
your clone. Sooner or later you'll cut a branch from `main`, rebase onto
it, or just read it, and you'd rather all of that see today's history
instead of last week's.

The move everyone knows is to go visit: `git switch main`, `git pull`,
`git switch -`. It works. It also checks out `main` for the privilege of
running one fast-forward, and [a checkout stopped being free
years ago](/blog/the-whole-loop-one-window/): dev servers restart, watchers
refire, generated files churn, and if `.gitignore` changed in the meantime
you come back to a wall of untracked files. Two context switches
to move one pointer.

Git can move a branch you're not standing on. It has been able to all along.

## The colon in the refspec

`git fetch` takes refspecs: `<source>:<destination>`. The source names a
ref on the remote; the destination names the ref in your repository that
the fetched history lands in. The everyday `git fetch origin` gets its
refspec from your config: `+refs/heads/*:refs/remotes/origin/*`, remote
branches in, tracking refs out. Write a refspec by hand and the
destination can be a local branch:

```sh
$ git branch --show-current
feature
$ git log --oneline -1 main
e7d9e76 init
$ git fetch origin main:main
From …/origin
   e7d9e76..114c7a5  main       -> main
   e7d9e76..114c7a5  main       -> origin/main
```

Two updates from one fetch: `main:main` moved your local branch, and
because its source is covered by the configured refspec, Git updated the
matching tracking ref `origin/main` too. And nothing else moved at all:

```sh
$ git log --oneline -1 main
114c7a5 Add lexer (#13)
$ git branch --show-current
feature
$ git status --porcelain
$
```

Fetch never touches your index or your working tree. No checkout, nothing
restarted, and `main` is current: `git switch -c next main` now starts
from today's history, and `git rebase main` picks up the fresh base.

The destination doesn't have to exist yet, and it doesn't have to match
the source's name:

```sh
$ git fetch origin main:hotfix-base
From …/origin
 * [new branch]      main       -> hotfix-base
```

A single fetch also takes as many refspecs as you care to give it, so
several branches can come current in one trip.

## The remote is optional

If a plain `git fetch origin` has already run (your hand, your editor, a
background sync), the new commits are sitting in your repository with
only the tracking ref pointing at them, and your local branch is the one
thing still stale. No second network trip needed: a repository can fetch
from itself.

```sh
$ git fetch origin
From …/origin
   114c7a5..c21574c  main       -> origin/main
$ git fetch . origin/main:main
From .
   114c7a5..c21574c  origin/main -> main
$ git log --oneline -1 main
c21574c Add tests (#14)
```

`.` is the repository you're in, treated as its own remote. The first
command moved the tracking ref over the network; the second copied it
onto the branch without any. The ref update is the same either way, so
everything that follows (the refusals, the fast-forward rule) applies to
a fetch from `.` exactly as it does to one from `origin`.

## The branch you're standing on is off limits

The exception is the branch that's checked out. Switch to `main` and
try to update it the same way:

```sh
$ git fetch origin main:main
fatal: refusing to fetch into branch 'refs/heads/main' checked out at '…/repo'
```

Note the `fatal`: this aborts the whole fetch before anything transfers,
tracking ref included.

The refusal protects an agreement. A checkout is three things in
sync: the branch ref, the index, and the working tree. Fetch moves refs
and reconciles nothing, so aiming it at the checked-out branch would
move one of the three and leave the other two describing a commit that
is no longer `HEAD`. There's a flag that overrides the refusal, and it
makes a tidy demonstration of why you shouldn't:

```sh
$ git fetch --update-head-ok origin main:main   # demo only — clean tree required
From …/origin
   c21574c..0538f6b  main       -> main
   c21574c..0538f6b  main       -> origin/main
$ git status
On branch main
Your branch is up to date with 'origin/main'.

Changes to be committed:
  (use "git restore --staged <file>..." to unstage)
	deleted:    docs.md
```

That is a staged deletion you never made. The fetched commit added
`docs.md`; your index still describes the tree from before it;
`git status` reports the difference as your doing. Commit from here
and you revert the change you just pulled. Provided the working tree
is clean, `git reset --hard` puts the three back in agreement by
rebuilding the index and working tree to match the moved branch; with
uncommitted work present it would destroy that work too. Then
`git switch -` back to `feature`.

The flag exists for `git pull`, which passes it on every fetch it runs.
A stock pull doesn't need it: its fetch half only writes `origin/*`, and
the merge or rebase half is what moves your branch. But a pull carrying
a refspec (`git pull origin main:main`, for instance) does fetch
straight into the checked-out branch. What makes that safe is that pull
reconciles the index and working tree immediately afterward (its output
even says "fast-forwarding your working tree"); that reconciliation is
the step `--update-head-ok` alone skips.

The same refusal covers a branch checked out *anywhere*. If `main` lives
in a linked worktree, fetching into it fails from the primary checkout
too, and the message names the path holding it:

```sh
$ git worktree add ../wt-main main
Preparing worktree (checking out 'main')
HEAD is now at 0538f6b Add docs (#15)
$ git fetch origin main:main
fatal: refusing to fetch into branch 'refs/heads/main' checked out at '…/wt-main'
$ git worktree remove ../wt-main
```

Nor is the refusal a quirk of fetch: `git branch -f` declines to move a
checked-out branch with the same reasoning. For an idle branch, though,
the two are not interchangeable. `branch -f` repoints the ref wherever
you say, no questions asked; the refspec holds the fast-forward line
you're about to meet. And for the branch you're on, the updater is
the one you already know, `git pull`, for exactly the reconciliation
reason above.

## When the branch has commits of its own

A fast-forward is the only move a plain refspec will make. If `main` has
a commit the remote doesn't, because you committed to it by accident or
you're carrying a local patch, the update is rejected:

```sh
$ git log --oneline -1 main
c540dc1 wip: note to self
$ git rev-parse --short origin/main
0538f6b
$ git fetch origin main:main
From …/origin
 ! [rejected]        main       -> main  (non-fast-forward)
   0538f6b..62fb195  main       -> origin/main
$ git rev-parse --short origin/main
0538f6b
```

A fast-forward discards nothing; anything else could. It's the same
conservatism as the checkout refusal, applied to history instead of the
working tree.

Look at the two `rev-parse` calls, though. The `! [rejected]` line is
truthful; the `origin/main` line under it never took effect — the ref
reads `0538f6b` before and after, whatever the output says about
`62fb195`. On the Git these transcripts ran on (2.51), a rejected
refspec takes the opportunistic tracking update down with it. The
manual doesn't specify which way this goes, so another version may keep
the tracking update; the habit that holds everywhere is to let
`rev-parse` tell you what moved after any rejection, and to run a plain
`git fetch origin` if you want the tracking ref current.

You can insist. A leading `+` on the refspec (or `--force`) permits
the non-fast-forward:

```sh
$ git fetch origin +main:main
From …/origin
 + c540dc1...62fb195 main       -> main  (forced update)
   0538f6b..62fb195  main       -> origin/main
$ git log --oneline -1 'main@{1}'
c540dc1 wip: note to self
```

Notice the tracking line finally sticking: it's the same
`0538f6b..62fb195` the rejection printed and canceled. And notice what
the force is: a reset wearing fetch's clothing. `main` now matches the
remote, and your local commit is off the branch — not destroyed,
`main@{1}` still names it, but off the branch, silently. If the stray
commit should keep a real name rather than a reflog entry, park it
before the force: `git branch rescue main`, then the forced fetch, and
afterward `rescue` points at your commit while `main` matches the remote.

If instead you meant to keep both sides on `main`, you want a merge or
a rebase, and those need a working tree. Any working tree satisfies
them, including one that exists for thirty seconds. Say the local
commit is deliberate this time, and the remote has moved again:

```sh
$ git fetch origin
From …/origin
   62fb195..5a013dc  main       -> origin/main
$ git log --oneline -1 main
687bfb7 fix: local-only patch
$ git worktree add ../tmp main
Preparing worktree (checking out 'main')
HEAD is now at 687bfb7 fix: local-only patch
$ git -C ../tmp merge --no-edit origin/main
Merge made by the 'ort' strategy.
 release.md | 1 +
 1 file changed, 1 insertion(+)
 create mode 100644 release.md
$ git worktree remove ../tmp
$ git log --oneline -2 main
a0ffdc9 Merge remote-tracking branch 'origin/main'
687bfb7 fix: local-only patch
```

Your own checkout never blinked. For the rebase preference,
`git -C ../tmp rebase origin/main` would have served the same way. Two
things about where this leaves you: `main` now carries a commit the
remote lacks, so the next plain `main:main` fetch is a rejection until
you push; and whether a merge like this one will conflict is
[answerable before you run it](/blog/preview-a-merge-before-you-run-it/),
from the same seat.

## Or don't do any of this

The feature this post has been circling ships in [GitDesktop](/features/),
the Git client I work on. After a fetch, every branch row shows how far
it sits ahead or behind its upstream, and a branch with commits to pull
offers **Update from origin/…** in its context menu: no switching, your
checkout stays put. Under that item, in order: an ancestry check to
classify the case, then `git fetch . origin/main:main` when it's a
fast-forward, and for a diverged branch the throwaway-worktree merge
from above — created, merged, removed, a conflicted merge aborted so
the branch is left exactly as it was. Aimed at the branch you're
standing on, it does the one reasonable thing left and merges in place,
conflicts and all, the way a plain pull would.

A branch is a name for a commit, and a name can move without you
standing on it. You check out a branch to work on it; updating it never
required your presence.
