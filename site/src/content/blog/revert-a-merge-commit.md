---
title: "How to revert a merge commit (and re-merge the branch later)"
description: "git revert refuses a merge commit until -m picks a parent. What the numbers mean, why re-merging the branch brings nothing back, and the Reapply escape."
pubDate: 2026-10-07
author: theBGuy
pillar: git-safety
tags: ["git", "merge", "recovery"]
ogImage: "/og/revert-a-merge-commit.png"
ogImageAlt: "GitDesktop blog card reading “Revert a Merge Commit. Survive the Re-merge.” — a terminal where git merge feature-notify answers “Already up to date.”, captioned “the reverted merge still counts as merged: ancestry says so”."
---

The notification feature merged on Friday. By Monday morning it has
been emailing customers on every status poll instead of every status
change, and your support inbox is paying for it. The merge sits on
`main`, and `main` is pushed: teammates have pulled it, CI has built
it. Deleting the merge from history would mean [rewriting a branch
other people stand on](/blog/force-push-without-overwriting-work/),
which is a worse incident than the one you have. (Caught before
anyone pulled it, a local merge can simply be [reset
away](/blog/dont-merge-fetch-head/); this one is published.)

Git's undo for published history moves forward instead: `git revert`
writes a new commit that does the opposite of an old one. Nothing
already recorded changes, so there is nothing for your teammates to
trip over. Here is the history as Monday finds it:

```sh
$ git log --oneline --graph
*   e1c284b Merge branch 'feature-notify'
|\  
| * 413cd96 Send order status emails
* | a137798 Lower request timeout
|/  
* 9ca49dd Initial order flow
```

So: revert the merge at the top.

```sh
$ git revert e1c284b
error: commit e1c284b384600dfae455e4076fc55cea987de0e1 is a merge but no -m option was given.
fatal: revert failed
```

Reverting an ordinary commit never asks a question like this. An
ordinary commit has one parent, so "undo what it changed" has one
meaning: the difference between the commit and that parent, applied
in reverse. A merge commit has at least two, and the difference
depends on which one you measure from. Git refuses to pick for you.

## One commit, two parents

```sh
$ git log -1 e1c284b
commit e1c284b384600dfae455e4076fc55cea987de0e1
Merge: a137798 413cd96
Author: Dev <dev@example.com>
Date:   Fri Sep 11 16:40:00 2026 -0400

    Merge branch 'feature-notify'
```

The `Merge:` line names the parents in order. `a137798` is parent 1:
where `HEAD` stood when you ran `git merge`, the tip of `main` just
before the feature came in. `413cd96` is parent 2, the tip of the
branch you merged. A forge's merge button assigns the same roles,
since it merges your branch into the target: the target branch's tip
is parent 1 there too. (A squash or rebase merge is different: it
writes no merge commit, its single-parent commits revert without any
`-m`, and because the branch's own commits never entered `main`'s
ancestry, the re-merge trap below is not yours either.)

`-m` answers Git's question by number. `git revert -m 1` says: treat
parent 1 as the line to keep, and undo what the merge brought in
from the other side. On `main`, that is almost always the answer.

`-m 2` is the other answer, and on `main` it backfires: it keeps the
branch's side and undoes what came in from parent 1, stripping out
your own mainline's work since the two lines split. In this history
it would put the timeout back to its old value and leave the
notification code in place, the exact opposite of the goal. (Already
ran it? That bad revert is an ordinary commit — revert it and the
tree is back where you started.)

## What -m 1 undoes

Revert refuses to start if the index is dirty or the files it will
touch carry unstaged edits, so commit or stash anything in flight
first (and `git stash pop` once the revert lands). Then:

```sh
$ git revert --no-edit -m 1 e1c284b
[main 1141f0a] Revert "Merge branch 'feature-notify'"
 Date: Mon Sep 14 09:12:00 2026 -0400
 2 files changed, 1 insertion(+), 9 deletions(-)
 delete mode 100644 notify.js
```

One new commit, and the merge's contribution is gone: the file the
branch added is deleted outright, the file it edited is restored.
What the revert left alone is just as deliberate:

```sh
$ cat app.js
export function placeOrder(cart) {
  return submit(cart);
}
$ cat config.js
export const TIMEOUT_MS = 3000;
```

`app.js` is back to calling `submit` directly, and `config.js` still
carries the timeout work `main` did on its own after the branches
split. Reverting with `-m 1` undoes one side of one merge and leaves
everything around it alone. And since it is ordinary new history,
you can push it to the shared branch without ceremony.

A revert can also conflict, exactly like a merge, when later
commits touch the lines it is taking out. It pauses the repository
mid-operation ("You are currently reverting commit …" in
`git status`) and ends with `git revert --continue` or
`git revert --abort`. (There is also `--skip`; with a single
commit being reverted it is just `--abort` by another name.)

The inbox calms down. The duplicates stop. Weeks pass.

## Already up to date

The notification feature is wanted again, batched behind a digest
this time. The branch still exists, so the first instinct is to
merge it back:

```sh
$ git merge feature-notify
Already up to date.
```

Git is answering a different question than the one you asked. Merge
decides what to bring over by ancestry: the commits reachable from
the branch but not from `main`. And `413cd96` *is* reachable from
`main`, through the merge you reverted. The revert undid that
merge's changes; it did not un-happen the merge. As far as ancestry
is concerned, the notification commit already arrived, and there is
nothing left to bring.

## Half a feature arrives

It gets quieter than that. The branch's author keeps working and
adds a digest helper, one new commit touching one new file. Time to
merge once more:

```sh
$ git merge --no-edit feature-notify
Merge made by the 'ort' strategy.
 digest.js | 3 +++
 1 file changed, 3 insertions(+)
 create mode 100644 digest.js
```

A clean merge, no conflicts. Look at what it built:

```sh
$ ls
app.js
config.js
digest.js
$ cat app.js
export function placeOrder(cart) {
  return submit(cart);
}
```

The new commit came over; nothing the revert removed came back.
`notify.js` is still missing and `placeOrder` still calls `submit`
bare, so `main` now holds a digest helper for a notification feature
that is not there. A re-merge brings only the commits added since
the first merge. Everything the revert took out stays out, and no
conflict warns you about any of it. (If the branch's new commits had
edited `notify.js` itself, you would have hit a modify/delete
conflict instead — louder, but the same cause.)

## Reverting the revert

The changes need a way back in, and ancestry has closed the normal
door. Two moves work; one popular one does not.

The move that keeps the story in history: revert the revert.

```sh
$ git revert --no-edit 1141f0a
[main 32151ae] Reapply "Merge branch 'feature-notify'"
 Date: Fri Oct 2 15:25:00 2026 -0400
 2 files changed, 9 insertions(+), 1 deletion(-)
 create mode 100644 notify.js
```

Git titles it for you: a revert of a revert is a `Reapply`. The tree
is whole again:

```sh
$ cat app.js
import { sendStatusEmail } from "./notify.js";

export function placeOrder(cart) {
  const order = submit(cart);
  sendStatusEmail(order);
  return order;
}
$ ls
app.js
config.js
digest.js
notify.js
```

And the log now reads as what actually happened: merged, reverted,
re-merged for the digest, reapplied.

```sh
$ git log --oneline --graph
* 32151ae Reapply "Merge branch 'feature-notify'"
*   b2cde5f Merge branch 'feature-notify'
|\  
| * 26bf5d2 Add a daily digest option
* | 1141f0a Revert "Merge branch 'feature-notify'"
* | e1c284b Merge branch 'feature-notify'
|\| 
| * 413cd96 Send order status emails
* | a137798 Lower request timeout
|/  
* 9ca49dd Initial order flow
```

The order is flexible here: reverting the revert first and merging
the branch after lands the same tree. What a plain merge cannot do
is resurrect content ancestry already counts as delivered; the
reapply commit is what puts it back.

The second move that works is giving the changes a new identity.
`git cherry-pick 413cd96` onto a fresh branch copies the change as a
new commit with a new hash. Ancestry has never seen that hash, so it
merges like any other new work. A branch that carried several
commits needs the whole run copied (`git cherry-pick <oldest>^..<tip>`),
or the commits you skip stay exactly as gone as they were.

The move that does not work is the one that looks most natural:
rebase the branch and merge again. `git rebase main` selects what to
replay with the same ancestry test the merge used, commits reachable
from the branch but not from `main`. That set is empty here, so the
rebase has nothing to replay and simply fast-forwards the branch.
You get the same "Already up to date" you started with.

## Or don't do any of this

A revert that conflicts pauses the whole repository, and that pause
is the part [GitDesktop](/features/) is built to pick up. It reads
the paused state from the repository itself (the same `REVERT_HEAD`
and sequencer records `git status` reads), so it does not need to
have started the operation to manage it. Run your `-m 1` revert in
whatever terminal you like; if it stops on conflicts, the Changes
view grows a warning strip reading "Reverting · 2 conflicts" and
counts down as you resolve, "Continue revert" stays unavailable
until every conflict is resolved and staged, and Abort sits behind a
confirm that spells out exactly what it abandons. Because Git
records which operation is paused, the strip calls a revert a revert
rather than a generic conflict.

For ordinary commits the app starts the revert itself: right-click a
commit in History, "Revert changes in commit", and a confirm that is
this post in one sentence — "history keeps both and nothing already
recorded is rewritten." A merge commit keeps you in the terminal
with `-m`, and the strip meets you there if it goes sideways.

Undo, in Git, is more history. The next merge will read all of it.
