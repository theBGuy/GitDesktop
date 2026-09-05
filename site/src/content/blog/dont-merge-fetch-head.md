---
title: "What FETCH_HEAD is, and why you shouldn't merge it"
description: "FETCH_HEAD holds whatever the last fetch brought — any fetch, including your editor's. Merge it by name and the branch can swap between your two commands."
pubDate: 2026-09-09
author: theBGuy
pillar: git-safety
tags: ["git", "merge", "recovery"]
---

Somebody opens a pull request from a fork, and you want to run the
branch before you comment on it. You know the two commands: fetch the
fork's URL, then `git merge FETCH_HEAD`. They've worked since the day
you learned them. Today they merge a branch you didn't name, tell you
it went fine, and the work you wanted stays outside your history.

Below, both ways this goes wrong: a merge that quietly does nothing,
then a retry that quietly merges the wrong thing. The rescue and the
one-refspec fix follow.

## A branch you can only reach by URL

Your clone (Git 2.51, stock configuration) knows one remote, the
project's own repository. The contributor's work lives on their
fork, which you haven't added as a remote; their branch
`retry-backoff` is the one you want to try.

```sh
$ git status -sb
## main...origin/main
$ git log --oneline
f0995ba Document the retry flag
7a1ba22 Add the sync worker
```

Clean tree, in step with upstream. Fetch the fork's branch by URL:

```sh
$ git fetch …/fork.git retry-backoff
From …/fork
 * branch            retry-backoff -> FETCH_HEAD
```

No remote and no local branch are involved, so the commits land in
your repository with exactly one handle: that `FETCH_HEAD` at the end
of the line. It is not a branch. It is a file:

```sh
$ cat .git/FETCH_HEAD
5e65e4da552a78dee284c01a3152fd73441acddf		branch 'retry-backoff' of …/fork
```

One line — the hash the fetch brought, and where it came from. A
receipt for the last fetch, which so far is yours. Git resolves it
like any ref:

```sh
$ git rev-parse FETCH_HEAD
5e65e4da552a78dee284c01a3152fd73441acddf
```

Merge right now and you get exactly that commit. Most days that's
what happens, which is how the habit survives.

## The merge that merges nothing

Today you don't merge right now. You spend a minute reading the pull
request description. While you read, something fetches: a second
terminal, a script, your editor's Git pane, a desktop client keeping
its branch list fresh. To play that part yourself, run the most
ordinary command there is:

```sh
$ git fetch origin
From …/origin
   7a1ba22..a2ebd09  release    -> origin/release
```

Upstream news, and boring news at that: a maintenance branch you
don't care about moved. Now read the receipt again:

```sh
$ cat .git/FETCH_HEAD
f0995ba81d9dd9fca2426b0aa35bad551a9cbcca		branch 'main' of …/origin
a2ebd09ad4d4a846ded331ab98226d6ab8e281b4	not-for-merge	branch 'release' of …/origin
```

Rewritten top to bottom. The fork line is gone; the newer fetch
recorded its own haul — upstream `main`, plus the release branch it
marked `not-for-merge`. FETCH_HEAD describes the last fetch, and
yours stopped being the last fetch while you were reading. Now the
merge you meant to run:

```sh
$ git merge FETCH_HEAD
Already up to date.
$ git log --oneline -3
f0995ba Document the retry flag
7a1ba22 Add the sync worker
```

Git merged the one line not marked `not-for-merge`: upstream `main`,
which you already had. True statement, wrong branch. The backoff
commit sits in your repository attached to nothing, and the screen
gives you no reason to go looking for it. The likeliest human reading
of "Already up to date" is that the fork's work must have landed
some other way.

## The retry that merges the wrong thing

Suppose you do go looking, notice the change you expected is missing
from the log, and decide to redo the dance. The world has moved on a
little: a teammate has pushed a logging tweak to upstream `main`, and
you've made a small commit of your own in the meantime:

```sh
$ git commit -am "Note the retry default in the README"
[main 072bb1f] Note the retry default in the README
 1 file changed, 2 insertions(+)
```

Fetch the fork again:

```sh
$ git fetch …/fork.git retry-backoff
From …/fork
 * branch            retry-backoff -> FETCH_HEAD
```

And again something else fetches before you merge, this time with real news:

```sh
$ git fetch origin
From …/origin
   f0995ba..23af86b  main       -> origin/main
```

```sh
$ cat .git/FETCH_HEAD
23af86bc38666439c01cd3d740f98c0d1edf1581		branch 'main' of …/origin
a2ebd09ad4d4a846ded331ab98226d6ab8e281b4	not-for-merge	branch 'release' of …/origin
```

The same swap as before, except this time the candidate line names a
commit you don't have. The merge goes through:

```sh
$ git merge FETCH_HEAD
Merge made by the 'ort' strategy.
 sync.py | 1 +
 1 file changed, 1 insertion(+)
```

Files changed, a merge commit minted, nothing to complain about.
Then you read the log:

```sh
$ git log --oneline -4
7381c9f Merge branch 'main' of …/origin
072bb1f Note the retry default in the README
23af86b Log a line when sync gives up
f0995ba Document the retry flag
```

You asked for `retry-backoff` and merged upstream `main`. The subject
line of the merge commit is the one place the swap is named, and
only if you read it. The branch you wanted is exactly as unmerged as
when you started.

## Getting back to before

What landed isn't damage in the usual sense; it's your own project's
`main`. But it's an integration you didn't choose, and pushed
upstream it becomes a merge commit you'd have to explain. Wind it
back. One early exit: if your merge stopped on a conflict instead of
completing, `git merge --abort` is the entire rescue, since nothing
was committed. For the merge that completed, see what Git recorded:

```sh
$ git reflog -3
7381c9f HEAD@{0}: merge 23af86bc38666439c01cd3d740f98c0d1edf1581: Merge made by the 'ort' strategy.
072bb1f HEAD@{1}: commit: Note the retry default in the README
f0995ba HEAD@{2}: clone: from …/origin.git
```

The newest entry is the merge, logged against a raw hash — there was
no branch name for it to record. The line under it is where you
stood, and ORIG_HEAD points at the same place (Git set it just
before the merge moved you). With a clean tree, straight after the
merge, returning is one command:

```sh
$ git reset --hard ORIG_HEAD
HEAD is now at 072bb1f Note the retry default in the README
$ git log --oneline -2
072bb1f Note the retry default in the README
f0995ba Document the retry flag
```

Back where you stood, with the wrong merge gone. A fast-forward sets
ORIG_HEAD too, so the same command covers the variant where the bad
merge arrived as one.

When the tree is dirty, order matters: saving a stash performs a
hard reset of its own, and that repoints ORIG_HEAD at the bad merge,
turning the reset above into a no-op. So copy the hash from the
reflog line under the merge first, then `git stash --include-untracked`,
then `git reset --hard` to the copied hash, then `git stash pop`
once you're back. The copied-hash form is also the fallback whenever
ORIG_HEAD has been repointed by anything else that ran in between (a
rebase, a reset, that stash); the reflog keeps answering after
ORIG_HEAD has moved on.

One more exit: if you'd already built commits on top of the bad
merge, a hard reset discards those as well. Write down their hashes
before resetting and `git cherry-pick` them back, oldest first — or
skip the reset entirely and merge the branch you actually meant on
top; the next section gives it a name.

## One file, last writer wins

All of it is one mechanism. `.git/FETCH_HEAD` is a single file, and
every fetch in the clone rewrites the whole thing; you've already
met the cast that might run one. Each line is one ref the fetch
brought, and the second column marks it either as a merge candidate
(the empty slot you saw) or `not-for-merge`. Name a branch in the
fetch command and that branch is the candidate. Run a bare
`git fetch origin` and the candidate is whatever your current
branch's configured upstream is. `git merge FETCH_HEAD` merges the
candidate lines and nothing else; on a branch with no upstream,
where a bare fetch marks every line `not-for-merge`, it merges
nothing at all and still prints "Already up to date".

So the old two-command pattern decodes as: merge whatever the most
recent fetch, run by anyone, was told to bring. When those
instructions were first written, you were usually the only fetcher
on the machine. What changed isn't the file; it's how much software
now fetches on your behalf.

## Give the fetch a destination

The fix is to stop treating the note as a name. Tell the fetch where
to put what it brings, with the same colon refspec that
[updates a branch you're not on](/blog/update-a-branch-without-checking-it-out/):

```sh
$ git fetch …/fork.git retry-backoff:pr-retry-backoff
From …/fork
 * [new branch]      retry-backoff -> pr-retry-backoff
```

Their `retry-backoff`, written to a local branch of yours named
`pr-retry-backoff`. It's a real ref in your repository now; no
background fetch will move it. Look it over on your own schedule:

```sh
$ git log --oneline main..pr-retry-backoff
5e65e4d Add exponential backoff between retries
```

and merge the name:

```sh
$ git merge pr-retry-backoff
Merge made by the 'ort' strategy.
 sync.py | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
$ git log --oneline -3
b047cfa Merge branch 'pr-retry-backoff'
072bb1f Note the retry default in the README
5e65e4d Add exponential backoff between retries
```

The backoff commit is in your history at last, under a subject line
that names what you merged. Delete `pr-retry-backoff` with
`git branch -d` when the review is done; if you decided against
merging, `-d` will refuse, and that refusal is Git guarding unmerged
commits (`-D` deletes them once you mean it). If you'd rather not
make a branch at all, the narrower fix is to read the receipt before
anything else rewrites it: `cat .git/FETCH_HEAD` right after the
fetch, confirm the line shows their branch, then merge the hash on
it. That narrows the race without closing it, and a merge by bare
hash records a subject with no branch name in it; the refspec keeps
the name. Both fixes are one idea: merge against something the next
fetch can't rewrite.

```sh
$ git status -sb
## main...origin/main [ahead 3, behind 1]
```

The 1 you're behind is the teammate's logging commit; take it in
with an ordinary pull whenever you choose, on purpose this time.

## Or don't do any of this

The villain here is a feature. Background fetching is why a client's
branch list is current and why divergence shows up before push time
instead of after. Turning it off to protect a two-command habit would
be backwards. The race lives in the habit: two commands, one shared
file, and no claim on the gap between them.

[GitDesktop](/features/) fetches in the background as a matter of
course, so it treats an operation in flight as something a fetch must
not be able to steer. When you pull, the tips produced by one fetch
are read once and pinned; the fast-forward check, the merge or
rebase, and the [dropped-commit guard](/blog/pull-rebase-deleted-your-commit/)
from the previous post all run against those pinned hashes. Its own
background fetch can rewrite FETCH_HEAD and advance every tracking
ref mid-operation without changing the outcome, because the operation
stopped consulting them the moment it decided what to do.

Git merges exactly what you point at. Point at something you own.
