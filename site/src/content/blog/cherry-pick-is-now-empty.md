---
title: "Why your cherry-pick is 'now empty' when nothing conflicted"
description: "Git calls your cherry-pick \"now empty, possibly due to conflict resolution\" when nothing conflicted. Why it stops, and whose name your next commit picks up."
pubDate: 2026-10-28
author: theBGuy
pillar: git-safety
tags: ["git", "cherry-pick", "branches"]
ogImage: "/og/cherry-pick-is-now-empty.png"
ogImageAlt: "GitDesktop blog card reading “Why Your Cherry-Pick Is Now Empty” — a large mint equals sign beside three git log --cherry-mark rows, where the middle one, “= 45118be Fix EXIF rotation for portrait thumbnails”, is lit and the two marked “+” stay dim, captioned “the = row is the pick that will come up empty”."
---

You're backporting a fix. Dana fixed portrait thumbnails coming out
sideways on main this week, the fix belongs in the next 1.8 patch release
too, and you cherry-pick her commit onto the release branch. Nothing
conflicts. Git stops anyway:

```sh
$ git switch release/1.8
Switched to branch 'release/1.8'
$ git cherry-pick 45118be
On branch release/1.8
You are currently cherry-picking commit 45118be.
  (all conflicts fixed: run "git cherry-pick --continue")
  (use "git cherry-pick --skip" to skip this patch)
  (use "git cherry-pick --abort" to cancel the cherry-pick operation)

nothing to commit, working tree clean
The previous cherry-pick is now empty, possibly due to conflict resolution.
If you wish to commit it anyway, use:

    git commit --allow-empty

Otherwise, please use 'git cherry-pick --skip'
```

"Possibly due to conflict resolution" is an odd thing to read when you
resolved nothing. The status lines above it read like a conflict too,
saying you're "currently cherry-picking" with every conflict fixed, when
there was no conflict to fix.

These transcripts come from Git 2.51, out of the box.

## The change is already there

A cherry-pick works from the change a commit made (its diff against its
parent). Git applies that change to your branch and records the result as
a new commit. When applying it leaves every file untouched, your branch
already has the change and there is nothing to record. `git commit` won't
make a commit that changes nothing unless you ask, so the pick stops.

Dana backported her own fix on Tuesday with `git cherry-pick -x`,
which adds a line to the message that a search can find:

```sh
$ git log --grep=45118be --format=fuller
commit dac94f8f227827e37a9b3616751a28a15d336316
Author:     Dana Okafor <dana@example.com>
AuthorDate: Mon Oct 19 10:14:00 2026 -0400
Commit:     Dana Okafor <dana@example.com>
CommitDate: Tue Oct 20 09:05:00 2026 -0400

    Fix EXIF rotation for portrait thumbnails
    
    (cherry picked from commit 45118bedb023c6b8d12c2d1145bf9dd7d1431436)
```

AuthorDate and CommitDate are a day apart. A cherry-pick keeps the
original author and author date, and it records whoever ran it as the
committer: Monday is when Dana wrote the fix, Tuesday when it reached
this branch. (If your team doesn't use `-x`, the search finds nothing,
but the `--cherry-mark` check further down doesn't need it.)

## Why it blames a conflict

The pick did its part and found an unchanged tree. Instead of saying so
itself, it hands the result to `git commit`, and a comment in Git's source
gives the reason, "run 'git commit' to display error message". Everything
the pick printed came from `git commit`, which has one message for a
cherry-pick with nothing to commit. The comment beside its emptiness
check says what that message was written for: in the cherry-pick case,
the commit "may be empty due to conflict resolution, which the user
should okay". A conflict you resolved by keeping your own side leaves the
same unchanged tree, and by then Git can't tell the two apart, so both
get the conflict wording.

The status lines are the ones `git status` prints for any stopped pick
with nothing unmerged, which is why their first hint says all conflicts
are fixed. Run `git cherry-pick --continue`, as that hint suggests, and
you get the whole block again, since the tree is still unchanged.

## The pick is still in progress

Whatever the message says about the cause, the cherry-pick hasn't ended.
Git's bundled prompt script now shows `release/1.8|CHERRY-PICKING`, and
some commands won't run until the pick is finished:

```sh
$ git switch main
fatal: cannot switch branch while cherry-picking
Consider "git cherry-pick --quit" or "git worktree add".
```

`git merge` refuses too, and tells you to commit your changes before you
merge, though you have none. `git commit` doesn't refuse. Here is the
next commit if you leave the pick where it is and move on with the release:

```sh
$ echo 1.8.4 > VERSION
$ git commit -am "Bump version to 1.8.4"
[release/1.8 77d5b74] Bump version to 1.8.4
 Author: Dana Okafor <dana@example.com>
 Date: Mon Oct 19 10:14:00 2026 -0400
 1 file changed, 1 insertion(+), 1 deletion(-)
```

That's your version bump, filed under Dana's name and dated Monday.
While a cherry-pick is in progress, `git commit` assumes it is finishing
that pick, so it copies the author and author date from the commit being
picked, the same rule that dated Dana's backport. Your `-m` kept the
message yours and skipped the warning Git had ready: without it, the
editor opens on Dana's message with a comment noting that you may be
committing a cherry-pick. The commit also ended the pause. If it's still
your latest commit and you haven't pushed it, put your own name back:

```sh
$ git commit --amend --reset-author --no-edit
[release/1.8 2d03b2c] Bump version to 1.8.4
 1 file changed, 1 insertion(+), 1 deletion(-)
```

Leave off `--no-edit` if the editor gave you Dana's message too. If the
commit has been pushed, the amend rewrites shared history and needs a
force push; [the force-push post](/blog/force-push-without-overwriting-work/)
covers doing that safely. If newer commits sit on top of it, reaching it
takes an interactive rebase.

## Which exit to take

Git's message offers two ways out, and the status lines add a third. For a
pick that came up empty with nothing conflicted:

- `git cherry-pick --skip` drops the pick and ends the pause. The change
  is already on the branch, so this is usually the exit you want. It
  prints nothing, and afterward `git status` reports a plain "nothing to
  commit, working tree clean".
- `git commit --allow-empty` records the pick anyway, as a commit with no
  changes and Dana's name, date, and message on it. That suits a team
  that wants every backport in the release log, including the ones that
  were already there.
- `git cherry-pick --abort` returns to where you were before the pick.
  For one empty commit, `--skip` leaves you in the same place.

`--skip` and `--abort` share a catch, because both reset the index.
Unstaged edits survive, but anything you staged after the pick stopped
disappears from the index and the working tree. (If one file has both
staged and unstaged edits, Git refuses the reset instead and nothing
changes.) If you've staged work since, use the exit the block leaves
out: `git cherry-pick --quit` forgets the pick and leaves your files and
index alone. Staged work you've already lost this way is still in the
repository as a dangling blob that `git fsck` lists, and the [uncommitted-changes
post](/blog/recover-uncommitted-changes/) walks you through getting it back.

If you reached the block from `git cherry-pick --continue` after resolving
a conflict, the empty result means your resolution kept none of the
incoming change. Make sure that's what you meant before you skip. While
the pick is still paused, `git checkout -m -- <file>` puts the conflict
markers back so you can resolve it again.

During `git rebase -i`, the same block can appear with a different last line,
`Otherwise, please use 'git rebase --skip'`. That stop belongs to the rebase,
and its exits behave differently: `git rebase --skip` drops the commit and,
unlike the cherry-pick version, throws away unstaged edits too.

## Ranges, and letting Git skip for you

A stretch of main usually includes something somebody already backported,
so range picks run into this often. A plain range pick applies commits
until it reaches the one the branch already has, then stops with the same
block and waits. `--skip` drops that commit and keeps going. `--abort`
rewinds the whole range, including the picks it already made, and
`--quit` keeps those and forgets the remainder. Committing during the pause
takes the picked commit's author in a range too, but it ends only the
current pick; the rest stays queued for `git cherry-pick --continue`.

To see beforehand which of main's commits the release branch has:

```sh
$ git log --oneline --cherry-mark --right-only release/1.8...main
+ a2746ef Keep PNG transparency when resizing
= 45118be Fix EXIF rotation for portrait thumbnails
+ f556cc3 Cap thumbnail width at 4096 px
```

`--cherry-mark` compares commits by patch ID, a hash of the change itself
that ignores line numbers and whitespace, and marks a match with `=`. The
diff behind that hash includes a few lines of surrounding context, though,
so a backport onto a branch where the neighboring lines differ gets a
different ID. Read `=` as "an equivalent commit is on the branch" and `+`
as "not found by this check".

Since Git 2.45, a cherry-pick can drop already-applied commits on its own.
The range here is the three commits that list showed:

```sh
$ git cherry-pick --empty=drop main~3..main
[release/1.8 effbfe6] Cap thumbnail width at 4096 px
 Author: Lee Park <lee@example.com>
 Date: Thu Oct 15 11:02:00 2026 -0400
 1 file changed, 1 insertion(+), 1 deletion(-)
dropping 45118bedb023c6b8d12c2d1145bf9dd7d1431436 Fix EXIF rotation for portrait thumbnails -- patch contents already upstream
[release/1.8 b8828cb] Keep PNG transparency when resizing
 Author: Lee Park <lee@example.com>
 Date: Wed Oct 21 16:30:00 2026 -0400
 1 file changed, 2 insertions(+), 1 deletion(-)
```

`--empty=drop` drops picks that come up empty and keeps going; "already
upstream" in its notice means already on the branch you're picking onto.
A commit that was empty to begin with still stops the range, and that's
the only kind cherry-pick's own `--allow-empty` keeps. Despite the name,
it does nothing for a pick that becomes empty on your branch. It's also a
different switch from the `git commit --allow-empty` exit above. You may
see `--keep-redundant-commits` in older advice; it's now a deprecated
spelling of `--empty=keep`.

## Or don't do any of this

[GitDesktop](/features/) takes the `--skip` itself when a cherry-pick from
**History** comes up empty, and says what happened in one line, such as
"Nothing to cherry-pick — these changes are already on this branch." In
the **Cherry-pick to branch** dialog, already-present commits are skipped
one at a time and counted, as in "Copied 2 commits onto release/1.8
(1 already present)". Neither leaves the pick paused behind it.

An empty pick that comes from resolving a conflict in favor of your own
side gets its own wording: **Continue cherry-pick** takes the `--skip` there
too and says "Commit skipped — your resolution left nothing to commit."
For a pick it started, the app knows which kind of empty pick it has,
because it knows which button you pressed.

When nothing conflicted, an empty pick usually means the change already landed.
Until you end it, the pause holds the original author for your next commit.
