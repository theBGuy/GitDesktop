---
title: "git pull --rebase deleted your commit: the rescue and the reason"
description: "A force-pushed branch plus git pull --rebase silently drops commits you pushed. The reflog rescue, the fork-point mechanism, and why no flag prevents it."
pubDate: 2026-09-02
author: theBGuy
pillar: git-safety
tags: ["git", "rebase", "recovery"]
---

This morning `git pull --rebase` printed a success line and deleted the
commit you pushed yesterday. No conflict, no error, no prompt. The
working tree is clean, the branch says up to date, and the commit is on
no branch anywhere: not yours, not the remote's.

Nothing in that story fails, which is what makes it dangerous.
Reproducing it takes two clones and four commits. Watch it happen, get
the commit back, then meet the rule that decided your pushed work was
disposable. Git 2.51, stock configuration, throughout.

## Two clones, one branch

Your teammate started the branch `search` and pushed two commits; you
cloned and joined. Your contribution is a ranking fix:

```sh
$ git log --oneline
97d747a Index file paths
5d48fd5 Add search command
$ git add ranking.js
$ git commit -m "Rank exact matches first"
[search 5a818d0] Rank exact matches first
 1 file changed, 1 insertion(+)
 create mode 100644 ranking.js
$ git push
To …/origin.git
   97d747a..5a818d0  search -> search
```

5a818d0 is on the remote now; anyone who fetches gets it. The push
also did one other thing, quietly, in your own clone. It comes back
when we get to the why.

## The force push you never saw

Your teammate's clone hasn't fetched since before your push, so their
branch still ends at 97d747a, and they've just committed a filter:

```sh
$ git add filters.js
$ git commit -m "Match on file type"
[search d5c109a] Match on file type
 1 file changed, 1 insertion(+)
 create mode 100644 filters.js
$ git push
To …/origin.git
 ! [rejected]        search -> search (fetch first)
error: failed to push some refs to '…/origin.git'
hint: Updates were rejected because the remote contains work that you do not
hint: have locally. This is usually caused by another repository pushing to
hint: the same ref. If you want to integrate the remote changes, use
hint: 'git pull' before pushing again.
hint: See the 'Note about fast-forwards' in 'git push --help' for details.
```

The work the remote contains that they do not have is your commit. The
refusal is Git protecting it, and the hint says how to take it in. They
read the refusal as friction:

```sh
$ git push --force
To …/origin.git
 + 5a818d0...d5c109a search -> search (forced update)
```

[The last post](/blog/force-push-without-overwriting-work/) was about
this moment from the pusher's side, and about the flags that would have
refused it. Today the interest is on your side of the wire, because
nothing so far has touched your clone. The remote lost its copy of
5a818d0; yours is intact, checked out, one `git log` away. The deletion
that sticks is going to be yours.

## The pull

```sh
$ git pull --rebase
From …/origin
 + 5a818d0...d5c109a search     -> origin/search  (forced update)
Successfully rebased and updated refs/heads/search.
$ git log --oneline
d5c109a Match on file type
97d747a Index file paths
5d48fd5 Add search command
$ git status
On branch search
Your branch is up to date with 'origin/search'.

nothing to commit, working tree clean
```

Your commit is gone, and every signal reads as routine. The fetch did
disclose what it saw: one `(forced update)` line, the same dialect the
last post decoded. The rebase then proceeded as if that line settled
things. "Up to date" here means agreeing with a remote that was
force-pushed a minute ago.

## The rescue

Reason later; rescue the commit first. The branch's reflog (the local diary of
the positions `search` has held in your clone) still lists it:

```sh
$ git reflog search
d5c109a search@{0}: pull --rebase (finish): refs/heads/search onto d5c109ab3f4881e4f58b8de14947c0cb23a202ee
5a818d0 search@{1}: commit: Rank exact matches first
97d747a search@{2}: clone: from …/origin.git
```

`search@{1}` is the branch as it stood before the pull rewrote it. If
your tree isn't clean, `git stash --include-untracked` first —
`--hard` throws away uncommitted changes. Then move back:

```sh
$ git reset --hard search@{1}
HEAD is now at 5a818d0 Rank exact matches first
$ git log --oneline
5a818d0 Rank exact matches first
97d747a Index file paths
5d48fd5 Add search command
$ git status -sb
## search...origin/search [ahead 1, behind 1]
```

If you'd already committed new work on top of the pulled branch
before noticing, reset would take it down with the pull's result; in
that case `git cherry-pick 5a818d0` brings the lost commit onto the
current state instead.

Ahead 1, behind 1 is the divergence the pull was supposed to resolve,
now out in the open: you have a commit missing from the remote, the
remote has one you haven't integrated. It still needs resolving; that
happens in *Integrating it properly*, below. First, the reason.

## Why the rebase threw it away

A rebase pull is a fetch, then a rebase of your branch onto the updated
`origin/search`. The rebase's first job is drawing a boundary: which
commits are yours to replay onto the new tip, and which belonged to the
old upstream, where replaying would only resurrect discarded history.
Git has two ways to draw that boundary, and they disagree about you:

```sh
$ git merge-base origin/search search
97d747a8a37a3b4cf5d3032ff2504761c898646e
$ git merge-base --fork-point origin/search search
5a818d0272d94df7a2b447d349402105f8df8c0a
```

Plain `merge-base` answers from the commit graph: the two histories
part ways after 97d747a, so everything past it on your branch is yours
to replay — one commit, 5a818d0. That is the boundary an explicit
`git rebase origin/search` would use.

`--fork-point` is what `git pull` uses, and it consults something the
graph doesn't have: the reflog of your remote-tracking ref.
`origin/search` is your clone's private record of the remote branch,
and it keeps a diary of its own:

```sh
$ git reflog origin/search
d5c109a refs/remotes/origin/search@{0}: pull --rebase: forced-update
5a818d0 refs/remotes/origin/search@{1}: update by push
```

`update by push`. Your push didn't just send the commit; it recorded,
in your own clone, that the upstream branch has stood at 5a818d0. The
fork-point rule treats every position in that diary as upstream
history — and the upstream has since moved off 5a818d0, so by its
reading, the upstream considered your commit and threw it away. The
boundary lands on the commit itself, the replay set is empty, and the
rebase does exactly what it was asked, for the branch it believed it
was looking at.

The rule exists for a real case. If a maintainer rewrites a branch
under commits you have *not* pushed, fork-point is what stops the
rebase from replaying the abandoned upstream commits underneath your
work: no duplicates, no phantom conflicts from history the rewrite
meant to delete. It guards unpushed work sitting on rewritten history.
The trap is that the diary records positions, never ownership. A commit
you pushed and a commit the upstream abandoned are indistinguishable in
it, and your own push is what put yours on the list. That is the quiet
other thing the push did back in the first block.

## The flag that doesn't exist

`git rebase` can be told not to do this: `--no-fork-point`, or
`rebase.forkPoint=false` in config. Neither survives contact with
`git pull`. The flag first:

```sh
$ git pull --rebase --no-fork-point 2>&1 | head -2
error: unknown option `no-fork-point'
usage: git pull [<options>] [<repository> [<refspec>...]]
```

The config setting looks like it should reach the rebase that pull
runs underneath. Watch it not do that: this next run has
`rebase.forkPoint=false` set, and `GIT_TRACE` prints what pull executes:

```sh
$ GIT_TRACE=1 git -c rebase.forkPoint=false pull --rebase 2>&1 | grep -oE "run_command: git (merge-base|rebase).*"
run_command: git merge-base --fork-point refs/remotes/origin/search search
run_command: git rebase --no-autostash --onto d5c109ab3f4881e4f58b8de14947c0cb23a202ee 5a818d0272d94df7a2b447d349402105f8df8c0a
$ git log --oneline
d5c109a Match on file type
97d747a Index file paths
5d48fd5 Add search command
```

Gone again, config and all. The trace is the explanation. Pull computes
the fork point itself (the first line) and hands the verdict to rebase
as an explicit `--onto`: rebase onto d5c109a, replaying whatever
follows 5a818d0. By the time rebase would consult `rebase.forkPoint`,
the decision is already spelled out in its arguments, and a setting
can't override an argument. As of Git 2.51 there is no pull-side flag
and no config that reaches this: every rebase pull across a rewritten
upstream gets the fork-point verdict whenever the reflog can supply
one — and your own push made sure it can.

## Integrating it properly

So the fix has to happen outside the pull. First, back to the rescued
commit — by hash this time: if you skipped the traced demonstration,
your reflog positions differ from mine, and the hash is correct on
either path. Then rebase onto the explicit name — naming the upstream
is what makes rebase use the plain merge-base boundary:

```sh
$ git reset --hard 5a818d0
HEAD is now at 5a818d0 Rank exact matches first
$ git rebase origin/search
Successfully rebased and updated refs/heads/search.
$ git log --oneline
aeae0fd Rank exact matches first
d5c109a Match on file type
97d747a Index file paths
5d48fd5 Add search command
$ git push
To …/origin.git
   d5c109a..aeae0fd  search -> search
```

Your change is back on the branch: aeae0fd, a new hash because the
parent changed, same message and content, sitting on top of your
teammate's work, published with an ordinary fast-forward push. Both
commits survive. This is what the pull would have done had it drawn the
boundary from the graph instead of the diary. (A bare `git rebase` with
no upstream argument defaults to the same fork-point rule as pull, so
name the upstream when it matters.) If you stashed at the start,
`git stash pop` brings that work back; the incident is over.

A `(forced update)` line in any fetch or pull output is the only
warning you get. When you see it, stop pulling by reflex. Read what moved
(`git log --oneline origin/search`), check whether your own pushed
commits are still part of it, and integrate with an explicit
`git rebase origin/<branch>` so the boundary comes from the graph.

## Or don't do any of this

The check you just ran by hand is two read-only commands: fork point
against merge base, with the at-risk commits sitting between them. A
Git client can afford to run that check before every rebase pull.

[GitDesktop](/features/) runs it as a pre-flight check. When the two
answers agree, the pull proceeds as normal. When they disagree, it
stops before the rebase and asks "Keep or drop these commits?", with
each at-risk commit listed by id, subject, and date. Keeping them
replays them on top of the rewritten upstream, the same move as the
explicit rebase above, and it's the focused default. Dropping them is
allowed too (sometimes the rewrite really did mean to take your commit
with it), and a drop is recorded in Operation history rather than
trusted to memory. The transcript above, with its one success line,
becomes a question with the evidence attached.

A success message tells you the plan worked. It never tells you the
plan was right.
