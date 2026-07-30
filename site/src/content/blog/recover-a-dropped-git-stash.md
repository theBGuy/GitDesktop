---
title: "Recovering a dropped stash: what git fsck can still find"
description: "A dropped or lost git stash is almost never gone. How to find it with git fsck, tell the real stash commit from its index twin, and get the work back."
pubDate: 2026-07-25
author: theBGuy
pillar: git-safety
tags: ["git", "recovery", "stash"]
---

You stashed something, moved on, and now it's gone. Maybe you ran `git stash
drop` one too many times. Maybe a rebase went sideways and took the stash list
with it. Maybe you ran `git stash pop` into a conflict, cleaned up, and
dropped the entry before noticing the resolution was wrong.

The good news is that Git almost never deletes anything on the spot. A dropped
stash is unlinked, not erased, and it stays in the object database until garbage
collection decides otherwise. Here's how to get it back.

## A stash is just commits

This is the part that makes the recovery make sense. `git stash push` doesn't
write to a special sidecar file — it creates real commits and points a ref at
them. Two commits, in the normal case:

```sh
$ git stash push -m "wip: the thing I care about"
Saved working directory and index state On main: wip: the thing I care about
```

Look at what that actually produced:

```sh
$ git log --format='%h  parents=%p  %s' --all --reflog
45199d0  parents=61bfbab 813b9d5  On main: wip: the thing I care about
813b9d5  parents=61bfbab            index on main: 61bfbab init
61bfbab  parents=                   init
```

The `index on main` commit holds what was staged. The `On main:` commit holds
the working tree, and it has **two parents**: the commit you were sitting on,
and that index commit. `stash@{0}` is just a ref pointing at the second one.

`git stash drop` deletes the ref. The commits are untouched. They're simply
unreachable now — nothing points to them, so nothing walks to them.

## Finding it again

`git fsck` walks the object database and reports anything nothing else points
at:

```sh
$ git fsck --unreachable | grep commit
unreachable commit 813b9d5fb7fef45cc200e7b0f10e5a1e60714c1d
unreachable commit 45199d06525ecbd5658491c9b02a04f73ebbac64
```

Two hits for one stash — which is exactly where most recovery instructions leave
you guessing. They are not interchangeable. Apply the wrong one and you get only
what happened to be staged at the time, which can look convincingly like your
work while quietly missing most of it.

The stash commit is the one with two parents. You can read that straight off the
object:

```sh
$ git cat-file -p 45199d06 | grep '^parent'
parent 61bfbab...
parent 813b9d5...
```

Or let the shell pick it for you:

```sh
git fsck --unreachable | grep commit | awk '{print $3}' |
  while read sha; do
    [ "$(git cat-file -p "$sha" | grep -c '^parent')" -ge 2 ] &&
      echo "$sha  $(git log -1 --format='%s' "$sha")"
  done
```

That prints only real stash commits, each with the message you wrote — which is
usually enough to recognize the one you want.

## Getting the work back

Once you have the SHA, `git stash apply` takes it directly. No ref required:

```sh
$ git stash apply 45199d06525ecbd5658491c9b02a04f73ebbac64
On branch main
Changes not staged for commit:
	modified:   a.txt
```

Your changes are back in the working tree.

If you'd rather look before you leap, inspect it first — a stash commit diffs
against its first parent like anything else:

```sh
git show 45199d06                # the working-tree changes
git show 45199d06^2              # what was staged at stash time
```

And if you want it back in the stash list as a proper entry rather than applied
straight to your tree:

```sh
git stash store -m "recovered" 45199d06
```

## The catch

This works because the objects are still there, and that isn't forever. `git gc`
prunes unreachable objects once they age past `gc.pruneExpire`, which defaults to
two weeks. Garbage collection also runs automatically — `git gc --auto` fires
during ordinary commands once enough loose objects pile up.

So: a stash you dropped this morning is almost certainly recoverable. One from
last quarter probably isn't. If you've just realized something important is
missing, do the `fsck` now and don't run `git gc` first.

One thing that will *not* help: `git reflog`. The stash has its own reflog at
`refs/stash`, and dropping the stash takes that with it. The plain `git reflog`
only covers `HEAD`.

## Or don't do any of this

This is where I mention that I make a Git client. Everything above is a
recipe I'd rather nobody had to run under pressure. Knowing that a stash is two
commits and that the real one has two parents is useful; I'd teach it to
anyone. But at the moment you actually need it, you're stressed, you're
guessing at SHAs, and the failure mode is silently restoring the wrong half
of your work.

In [GitDesktop](/#recover) that same `fsck` walk runs behind a list:
recoverable stashes, each with its message, its date, and a diff you can read
before you commit to anything. Same objects, same operation, minus the shell
pipeline and minus the chance of applying the index twin by mistake.

Either way, remember the part that surprises people: it's still there. Git is
much more reluctant to destroy your work than it looks.
