---
title: "Git says your branch is not fully merged. Is it?"
description: "When a squash-merged branch is gone from the remote and pruned, git branch -d refuses it. What -d compares, how to check main has your changes, when -D is safe."
pubDate: 2026-10-21
author: theBGuy
pillar: git-safety
tags: ["git", "branches", "merge"]
ogImage: "/og/branch-not-fully-merged.png"
ogImageAlt: "GitDesktop blog card reading “‘Not Fully Merged.’ Is It?” — a graph of main and a branch: two branch commits, f8e9356 and b3e4656, fold by dashed lines into main's squash commit ecf45cf (#41), while the third, 15a12e8, stays lit on the branch marked “only here”, captioned “main has the changes from two of them. the third is yours alone”."
---

Your pull request adding cursor pagination to `GET /orders` was
squash-merged yesterday, and the forge deleted its branch afterward, as
the repository is set up to do. Now you tidy up, in a clone running Git
2.51 with its default settings. A fetch with `--prune` brings down
both changes at once:

```sh
$ git fetch --prune
From …/orders-api
 - [deleted]         (none)     -> origin/orders-pagination
   f641800..ecf45cf  main       -> origin/main
```

You move to `main` and take the merge:

```sh
$ git switch main
Switched to branch 'main'
Your branch is behind 'origin/main' by 1 commit, and can be fast-forwarded.
  (use "git pull" to update your local branch)
$ git pull
Updating f641800..ecf45cf
Fast-forward
 orders.py | 7 ++++---
 1 file changed, 4 insertions(+), 3 deletions(-)
```

Then the local branches go. Two look safe to drop: `orders-pagination`,
now merged, and `fix-total-rounding`, whose commits are all on the
remote while its pull request waits on a reviewer. You reach for `-d`,
the delete that checks before it acts:

```sh
$ git branch -d orders-pagination fix-total-rounding
error: the branch 'orders-pagination' is not fully merged
hint: If you are sure you want to delete it, run 'git branch -D orders-pagination'
hint: Disable this message with "git config set advice.forceDeleteBranch false"
warning: deleting branch 'fix-total-rounding' that has been merged to
         'refs/remotes/origin/fix-total-rounding', but not yet merged to HEAD
Deleted branch fix-total-rounding (was 3ae8a46).
```

Git deleted the branch that `main` has never seen and refused the one
you watched merge. The hint has the next command typed out for you,
and after enough squash merges you would run it without a second look.
This time the refusal is right, and seeing why takes one more minute.

## What -d compared

`git branch -d` deletes only a branch it considers fully merged, and
merged is a question about ancestry: walking back from a reference
commit, does Git reach the branch's tip? The reference is the branch's
upstream while that remote-tracking branch exists, and `HEAD` otherwise:
the upstream was never set, or your copy of it has been pruned.

That rule accounts for both results. `fix-total-rounding` still
tracks `origin/fix-total-rounding`, which holds every commit the
branch has, so Git deleted it and warned that `HEAD` doesn't have
those commits yet. They sit in your copy of the remote as of the last
fetch, and `-d` checked nothing else.

`orders-pagination` was set to track a remote branch too, but the forge
deleted that branch and the prune removed your copy of it (the
`[deleted]` line in the fetch). With nothing left to check against, Git
fell back to `HEAD`, which is `main`, and `main` can't reach the
branch tip, as the log shows:

```sh
$ git log --oneline -3
ecf45cf Paginate GET /orders with a cursor (#41)
f641800 Log slow order queries
203f8e5 Add order totals
$ git log --oneline main..orders-pagination
15a12e8 Cap page size at 100
b3e4656 Return a next-page cursor
f8e9356 Accept a cursor on GET /orders
```

`main..orders-pagination` lists the commits on the branch that `main`
can't reach: all three of them.

## Why a squash merge leads here

A squash merge takes the combined change of a pull request and records
it as one new commit on the target branch. ecf45cf carries the content
of the commits under review without being their descendant, so their
hashes appear nowhere in `main`'s history. A rebase merge does the same
thing another way, copying each commit under a new hash.

While the branch's upstream survives in your clone, `-d` checks against
it, and a refusal then means something: you have commits the upstream
doesn't. Once the forge deletes the branch and your prune follows, the
check falls back to `HEAD` (here `main`). After either kind of merge,
`HEAD` can't reach the branch tip, so `-d` refuses whether or not
anything on the branch is missing from `main`. In a repository that
deletes merged branches, and a clone that prunes, every squash-merged
branch draws that refusal, most with nothing at risk, and the one that
matters looks like all the rest.

Look at the list again. The pull request had two commits. You committed
the third, `Cap page size at 100`, the evening before the merge, after
the approval came through. You meant to open it as a follow-up and
never pushed it, so it isn't in ecf45cf. `-D` would have deleted the
only branch that held it.

## Ask about content instead

Memory makes a poor check. You won't always recall what a pull request
carried, and the commit list can't help, because ancestry is the very
thing the squash took away. Content can: does `main` already hold every
change the branch makes?

Git can answer without touching your checkout, using the in-memory
merge from [the merge-preview post](/blog/preview-a-merge-before-you-run-it/)
(Git 2.38 or newer). Merge the branch into `main` on paper, then compare
the result with `main` itself:

```sh
$ git merge-tree --write-tree main orders-pagination
88e375a964674ab963783b7d7d5101deb60c861b
$ git diff main 88e375a964674ab963783b7d7d5101deb60c861b
diff --git a/db.py b/db.py
index abf2921..f580ea8 100644
--- a/db.py
+++ b/db.py
@@ -1,5 +1,8 @@
 from store import query
 
+MAX_PAGE_SIZE = 100
+
 
 def fetch_orders(customer_id, limit, after=None):
+    limit = min(limit, MAX_PAGE_SIZE)
     return query("orders", customer=customer_id, limit=limit, after=after)
```

A single line from `merge-tree` means a clean merge, and that hash is
the tree it produces. The diff against `main` is everything the merge
adds: the page-size cap, and nothing from the other two commits, whose
lines `main` already has. Had the diff come back empty, `-D` would
lose nothing, because `main` would hold every change on the branch.

A plain `git diff main orders-pagination` looks like a shortcut, but on
a busy repository it also shows, in reverse, every later change on
`main` that the branch lacks. The merged tree differs from `main` only
where the branch brings something new. Run the check against a `main`
you have just pulled, as in this story, or against `origin/main` after
a fetch; a stale local `main` reports the whole pull request as missing.

If `merge-tree` reports a conflict, its first line is still the tree,
and the `CONFLICT` lines after it say what kind. For a clash inside a
file, diff the tree against `main` as before: the conflict markers set
both versions side by side and show whether the clash is your new work
or lines `main` has edited since. A binary file, or a file one side
deleted, gets no markers. Git keeps one side's copy whole, so the diff
can show the file as new, or show nothing at all, and after a conflict
an empty diff is not the all-clear.

## Keeping the commit main doesn't have

The cap needs a branch of its own, built on the new `main`. The obvious
move is to rebase the old branch and let Git sort out what `main` has.
On this branch, Git doesn't:

```sh
$ git switch orders-pagination
Switched to branch 'orders-pagination'
Your branch is based on 'origin/orders-pagination', but the upstream is gone.
  (use "git branch --unset-upstream" to fixup)
$ git rebase main
Auto-merging orders.py
CONFLICT (content): Merge conflict in orders.py
error: could not apply f8e9356... Accept a cursor on GET /orders
hint: Resolve all conflicts manually, mark them as resolved with
hint: "git add/rm <conflicted_files>", then run "git rebase --continue".
hint: You can instead skip this commit: run "git rebase --skip".
hint: To abort and get back to the state before "git rebase", run "git rebase --abort".
hint: Disable this message with "git config set advice.mergeConflict false"
Could not apply f8e9356... # Accept a cursor on GET /orders
$ git rebase --abort
```

A plain rebase replays all three commits, including the two that
`main` holds in squashed form. Replayed one at a time against their own
combined result, the first runs into lines the squash changed further,
and Git stops to ask. Whether it stops depends on how the squashed
commits overlap, so a stop says nothing about new work. (A rebase
merge, or the squash of a one-commit pull request, is different: plain
rebase sees that those copies match their originals and skips them.)

`--abort` puts everything back. You want to replay only the commits
after the ones the squash carried, and `--onto` does just that: take
what comes after b3e4656, the last commit the pull request had, and set
it on top of `main`. If you don't remember which commit that was, the
pull request's commit list on the forge shows the hashes; take the
newest one your own branch has.

```sh
$ git rebase --onto main b3e4656
Successfully rebased and updated refs/heads/orders-pagination.
$ git log --oneline -3
e3f013f Cap page size at 100
ecf45cf Paginate GET /orders with a cursor (#41)
f641800 Log slow order queries
```

The log shows the cap alone on top of the squash merge. Hand `--onto`
the wrong base, the tip itself for instance, and it still reports
success, with nothing on top. `git reset --hard ORIG_HEAD` restores the
branch as it was before the rebase. Then give the branch a name for
what it holds, and publish it under that name:

```sh
$ git branch -m cap-page-size
$ git push -u origin cap-page-size
To …/orders-api.git
 * [new branch]      cap-page-size -> cap-page-size
branch 'cap-page-size' set up to track 'origin/cap-page-size'.
```

The branch you came to delete now carries the follow-up, ready for its
own pull request, and nothing on it is at risk.

## If -D already ran

`git branch -d` and `-D` print the tip they remove, `(was <hash>)`, as
the `fix-total-rounding` line above shows, and `git branch <name> <hash>`
brings the branch back. [The hard-reset post](/blog/undo-a-hard-reset/)
covers finding the hash without that line: HEAD's reflog, and what to
do when HEAD never stood on the branch.

A branch remade from a hash comes back without its upstream. Deleting a
branch also deletes its `branch.<name>` section from your repository's
config, so the remade branch tracks nothing until you push with `-u` or
name an upstream with `git branch -u`. When the remote still has every
commit the deleted branch had, one switch rebuilds the branch from the
remote, tracking included. `fix-total-rounding` qualifies, since its
`-d` went through; for any other branch, check first that the command
`git log --oneline origin/<name>..<hash>` prints nothing:

```sh
$ git switch fix-total-rounding
branch 'fix-total-rounding' set up to track 'origin/fix-total-rounding'.
Switched to a new branch 'fix-total-rounding'
```

The switch builds from the remote's copy. For a branch that was ahead
of its remote, it restores the name and leaves out the commits you
never pushed, so remake that kind from the hash.

Git keeps a deleted branch's commits for a while, but its grace periods
count from the last time HEAD moved onto or off the branch's tip,
usually the switch away from it, and from when its objects were last
written, not from when you deleted it. By default garbage collection
drops HEAD reflog lines pointing at unreachable commits once they are a
month old, and it prunes unreachable objects by how long ago they were
last written. A branch you last touched in the spring can be past both
limits already, so the next `git gc`, including one Git starts on its
own, may take it.

## Or don't do any of this

[GitDesktop](/features/)'s **Clean up branches** keeps two answers to
the merged question side by side and lets neither stand in for the
other. A branch the default branch has reached and moved past (the
ancestry test `-d` makes) starts out checked. One that a recent pull
request merged, which is how squash and rebase merges show up when the
app is connected to your forge, gets a badge naming that pull request
("merged #41"). In the guide's words, the match "goes by branch name, so
it never pre-checks a row on its own — it badges one for you to confirm."

Archive is the dialog's default, with Delete beside it. Archiving folds
branches into a collapsed "Archived" section of the switcher and leaves
every commit where it is. It is one setting per branch in your
repository's local config, and Unarchive deletes it. Most cleanups only
need a shorter list, and an archived branch still points at its
commits, so garbage collection leaves them alone.

A squash merge lands your changes and strands your commits.
