---
title: "Fix git fetch when two branch names differ only in case"
description: "git fetch fails with \"references that only differ in casing\" or \"cannot lock ref\" on Windows and macOS. What one capital letter did, and two ways out."
pubDate: 2026-11-25
author: theBGuy
pillar: git-safety
tags: ["git", "branches", "windows"]
ogImage: "/og/branch-names-differ-only-in-case.png"
ogImageAlt: "GitDesktop blog card reading “Branch Names That Differ Only in Case”, above a terminal command, $ git rev-parse origin/feature/offline-maps origin/Feature/offline-maps, answered twice with the same hash, 5d95f9ce9c35c61f38f1a6a10df1ed39b1882062. The lowercase f, the capital F and the first seven characters of each hash are lit. Captioned “two names, one file, one hash”."
---

You fetch on your Windows laptop and a teammate's new branch comes in. A few
minutes later you fetch again:

```sh
$ git fetch
From …/trailmap
 * [new branch]      Feature/offline-maps -> origin/Feature/offline-maps
$ git fetch
error: You're on a case-insensitive filesystem, and the remote you are
trying to fetch from has references that only differ in casing. It
is impossible to store such references with the 'files' backend. You
can either accept this as-is, in which case you won't be able to
store all remote references on disk. Or you can alternatively
migrate your repository to use the 'reftable' backend with the
following command:

    git refs migrate --ref-format=reftable

Please keep in mind that not all implementations of Git support this
new format yet. So if you use tools other than Git to access this
repository it may not be an option to migrate to reftables.

From …/trailmap
 * [new branch]      Feature/offline-maps -> origin/Feature/offline-maps
 ! 5d95f9c...ea76618 feature/offline-maps -> origin/feature/offline-maps  (unable to update local ref)
```

The new branch is `Feature/offline-maps`, with a capital F. The branch
you've been tracking is `feature/offline-maps`. On the remote those are two
branches, and on your disk they're one. Fetching again doesn't clear it, and
a Mac gets the same error, since macOS disks also ignore case by default.

## Your clone keeps branch names as file names

Unless you've changed its format, a clone keeps each remote branch it
tracks as a small file under `.git/refs/remotes/origin/`, named after the
branch and holding its commit hash. A fresh clone packs them all into one
file, `.git/packed-refs`, but every fetch that moves a branch writes that
branch's own file. Windows and macOS match file names without regard to case
by default, so `Feature/offline-maps` and `feature/offline-maps` are the
same file there.

The first fetch wrote the new branch's hash into the file that already held
`feature/offline-maps`, and reported success. Compare what your clone says
with what the remote says:

```sh
$ git rev-parse origin/feature/offline-maps origin/Feature/offline-maps
5d95f9ce9c35c61f38f1a6a10df1ed39b1882062
5d95f9ce9c35c61f38f1a6a10df1ed39b1882062
$ git ls-remote --heads origin offline-maps
5d95f9ce9c35c61f38f1a6a10df1ed39b1882062	refs/heads/Feature/offline-maps
ea766187a87070534e082c4755b8f296671dfb45	refs/heads/feature/offline-maps
$ git log -1 --format="%h %an: %s" 5d95f9c
5d95f9c Leo Park: Prefetch tiles along the route
```

Both names in your clone point at Leo's commit, while the remote keeps
`feature/offline-maps` at `ea76618`. The second fetch tried to put that hash
back and store the new branch in the same run, found two updates aimed at
one file, and refused the second one (the `!` line). The last command shows
whose commit the twin holds.

Until one of the names is gone, take hashes from `git ls-remote`,
which asks the remote directly, and don't merge or rebase onto
`origin/feature/offline-maps`, which a bare `git merge` or `git rebase`
on that branch does by default. Either of your clone's copies can hold
the wrong hash, and `git status` counts ahead and behind against it.
With `feature/offline-maps` checked out it gets harder to spot, because
every other fetch, `git pull` included, succeeds quietly and writes Leo's
hash back. Accepting this "as-is", as the message puts it, means living
with all of that.

Git 2.51.1 added the long message, and it appears when one fetch
has to update both names. When only one of them moved and the
shared file holds the other's hash, Git reports the same problem as
`cannot lock ref '…': is at <hash> but expected <hash>`, and folder twins
(below) produce that one too. Before 2.51, a fetch that carried both names
let the later one overwrite the earlier without a word, and 2.51.0 failed
the whole fetch. The cause and the fixes are the same.

## Give the twin its own name on the remote

There are two fixes. The one that also clears every other Windows and Mac
clone is to stop the remote from having two spellings. Here the capital F
was a typo (more on that below), so Leo's commit moves to a separate branch
name and the misspelled one goes. Anyone with push access can do it, from a
clone that has fetched since the twin appeared: the push needs Leo's commit.
Work from the hash `ls-remote` printed, because your clone's two copies
share one file and either can hold the other's hash:

```sh
$ git push --atomic --force-with-lease=Feature/offline-maps:5d95f9c --force-with-lease=feature/offline-maps-prefetch: origin 5d95f9c:refs/heads/feature/offline-maps-prefetch :Feature/offline-maps
To …/trailmap.git
 - [deleted]         Feature/offline-maps
 * [new branch]      5d95f9c -> feature/offline-maps-prefetch
$ git fetch --prune
From …/trailmap
   8e0e7fb..ea76618  feature/offline-maps -> origin/feature/offline-maps
$ git fetch
```

The one push creates `feature/offline-maps-prefetch` at Leo's commit and
deletes `Feature/offline-maps`, and `--atomic` makes the two land together
or not at all. The first [lease](/blog/force-push-without-overwriting-work/)
makes the delete conditional: if Leo pushed to the twin after your
`ls-remote`, the remote no longer holds `5d95f9c`, and the whole push is
rejected before the delete can drop his new commit. Spell the lease's branch
name exactly as the branch you delete: a lease on `feature/offline-maps`
doesn't guard `Feature/offline-maps`, and Git doesn't warn you. The
second lease, with nothing after the colon, requires the new name to
be free; without it, an existing branch by that name would be fast-forwarded
to Leo's commit. If the push fails, the new name may be taken (pick
another), or someone may have moved the twin or already removed it. Run
`git fetch origin`, which still downloads new commits while it reports the
error, then `git ls-remote origin`, and rerun the push with the new hash if
the twin is still there.

Deleting the twin also removed the shared file in your clone, so
`git fetch --prune` brings `origin/feature/offline-maps` from its hash
at clone time, `8e0e7fb`, to the remote's `ea76618`, and the next fetch has
nothing to report. If the twin had an open pull request, deleting the branch
closed it on GitHub, as renaming it in GitHub's own interface would have,
so open a new one from the new name. Otherwise Leo can merge the new branch
when he's ready.

## Or keep both names: move the clone to reftable

The other way out is the command the message suggests.
`git refs migrate --ref-format=reftable` moves the clone's branch names out
of files and into reftable, a format that stores them in a table where case
is part of the name:

```sh
$ git refs migrate --ref-format=reftable
$ git fetch
From …/trailmap
 * [new branch]      Feature/offline-maps -> origin/Feature/offline-maps
 + 5d95f9c...ea76618 feature/offline-maps -> origin/feature/offline-maps  (forced update)
$ git rev-parse origin/feature/offline-maps origin/Feature/offline-maps
ea766187a87070534e082c4755b8f296671dfb45
5d95f9ce9c35c61f38f1a6a10df1ed39b1882062
```

The migration prints nothing. The first fetch after it
records `Feature/offline-maps` as its own branch and corrects
`feature/offline-maps`, and from then on each name tracks its own commit.

That fixes this one clone, though. Every teammate on Windows or macOS keeps
running into it until the remote drops a spelling. And before you migrate:

- Check your Git version. The command arrived in 2.46, but an everyday clone
  needs 2.49 or later: 2.46 and 2.47 refuse any repository that has reflogs,
  and 2.48 doesn't carry the stash list across.
- It won't run while the repository has [linked
  worktrees](/blog/work-on-two-branches-at-once/). Git answers
  `migrating repositories with worktrees is not supported yet`. In
  each one, commit and push any work inside its submodules first, then
  commit on a branch (if the worktree's HEAD is detached, create one
  with `git switch -c` first, or the commit is lost with the worktree),
  or stash with `git stash -u` so untracked files go too, and copy out
  any ignored files you still need (a `.env`, local settings), since
  `git worktree remove` deletes them with the folder. Then remove each
  worktree (one with submodules checked out takes `--force`), and run
  `git worktree prune` for any folder you deleted by hand. A fresh clone
  made with `git clone --ref-format=reftable` avoids all of this, but your
  local branches, stashes and unpushed commits stay behind in the old one.
- It can't lock out other writers while it runs, so close editors and
  anything else that fetches in the background, and if the repository
  is registered for scheduled maintenance, run `git maintenance unregister`
  first and `git maintenance register` after.
- Git releases before 2.45 can't open a reftable repository at all, and
  as the message warns, tools that read `.git` without running Git may not
  support the format yet.

## When only the folder differs

The capitals don't have to cover a whole branch name. Suppose Leo had
pushed `Feature/route-export` instead. No two names are equal ignoring case,
but the folders `Feature` and `feature` are one folder on your disk, and Git
names each branch after the folder it finds it in:

```sh
$ git fetch
From …/trailmap
   2903282..992e0c0  feature/offline-maps -> origin/feature/offline-maps
$ git branch -r
  origin/Feature/offline-maps
  origin/Feature/route-export
  origin/HEAD -> origin/main
  origin/feature/offline-maps
  origin/main
$ git fetch
error: cannot lock ref 'refs/remotes/origin/feature/offline-maps': is at 992e0c0bb077f9698cb6e3965cd62a4889b5b1a4 but expected 2903282724b31a3a6bdb7337f54f4f9c1e3c7c88
From …/trailmap
 ! 2903282..992e0c0  feature/offline-maps -> origin/feature/offline-maps  (unable to update local ref)
```

The first fetch worked. Then `git branch -r` lists a branch the remote
doesn't have, `origin/Feature/offline-maps`. Priya's update was written
into the folder Leo's branch had created first, and Git reads that folder's
spelling back. From there every fetch fails with `cannot lock ref`, the
one above included, though nothing new had arrived, and `git pull` stops on
the same error. The fixes carry over. Rename every branch under `Feature/`
to `feature/` with the same kind of push (here only `Feature/route-export`,
but `git ls-remote --heads origin` lists them all, and one left behind
keeps the folder clash alive), then run `git fetch --prune`, which deletes
the phantom. Moving the clone to reftable works too, followed by the same
`git fetch --prune`, since the migration keeps the phantom.

## How the twin got there

Leo had checked out `feature/offline-maps` earlier in the week. Back on
`main`, he typed it with a capital F:

```sh
$ git switch Feature/offline-maps
Switched to branch 'Feature/offline-maps'
$ git branch
  feature/offline-maps
  main
$ git commit -am "Prefetch tiles along the route"
[Feature/offline-maps 5d95f9c] Prefetch tiles along the route
 1 file changed, 4 insertions(+)
$ git push origin HEAD
To …/trailmap.git
 * [new branch]      HEAD -> Feature/offline-maps
```

Git looked for a branch file called `Feature/offline-maps`, the disk returned
`feature/offline-maps`, and the switch went through under the spelling
Leo typed. `git branch` gives it away: no branch carries the `*` that
marks the current one, because no stored name matches. The commit landed on
`feature/offline-maps` as usual, but `git push origin HEAD` publishes under
the name HEAD carries, and to the remote, which keeps case, that's a new
branch. A plain `git push` does the same when `push.autoSetupRemote` is on.

If the typo is yours, `git switch feature/offline-maps` with
the stored spelling brings the `*` back, and your commit is
already on the branch. Push it there, delete the twin with
`git push --force-with-lease=<twin>:<hash> origin :<twin>`, where `<twin>`
is `Feature/offline-maps` and `<hash>` is what `git ls-remote` shows for it,
and run `git fetch --prune` so your own copies catch up.

## Or don't do any of this

In [GitDesktop](/features/) you switch by picking a branch from the branch
list, so the spelling comes from your clone. On a disk that ignores case,
the app also checks a new name against the branch names your clone stores
before it creates or renames a branch, checks out a remote branch from
that list, or adds a worktree on a new branch. A name that differs from an
existing branch only in capitals stops there:

> Feature/offline-maps differs from the existing branch feature/offline-maps
> only in letter case, which this disk can't keep apart. Use a different
> name, or rename feature/offline-maps first.

In a reftable clone, where the two names can't collide, it
lets you have both.

On the server, a capital letter starts a new branch. On your laptop, it
opens the same file.
