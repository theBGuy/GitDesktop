---
title: "Force push without overwriting your teammate's work"
description: "git push --force-with-lease protects you only until something fetches. The gap, demonstrated live, and the flag that closes it: --force-if-includes."
pubDate: 2026-08-26
author: theBGuy
pillar: git-safety
tags: ["git", "force-push", "workflow"]
---

You pushed a commit, then spotted what it was missing: the config file
that makes the feature work. The repair is muscle memory. Add the file,
amend, push again:

```sh
$ git log --oneline -2
289a64d Add burst allowance
8a66181 Add rate limiter
$ git add limiter.config.json
$ git commit --amend --no-edit
[feature 002ba27] Add burst allowance
 Date: Tue Aug 18 01:53:39 2026 -0400
 2 files changed, 2 insertions(+)
 create mode 100644 limiter.config.json
$ git push
To …/origin.git
 ! [rejected]        feature -> feature (non-fast-forward)
error: failed to push some refs to '…/origin.git'
hint: Updates were rejected because the tip of your current branch is behind
hint: its remote counterpart. If you want to integrate the remote changes,
hint: use 'git pull' before pushing again.
hint: See the 'Note about fast-forwards' in 'git push --help' for details.
```

Git says you're behind. Only by the numbers: the one commit you're
missing is 289a64d, the commit the amend replaced with 002ba27. That
commit no longer appears in your history, so no fast-forward can get
there from here. The hint's advice would bring your own replaced
commit back. What you want is for the remote to take the new version,
and that means some kind of force.

## What `--force` costs

The branch is shared, though, and shared branches have a meanwhile.
While you were staring at that rejection, your teammate pushed
tests. In their clone:

```sh
$ git commit -m "Add limiter tests"
[feature ee31f16] Add limiter tests
 1 file changed, 1 insertion(+)
 create mode 100644 limiter.test.js
$ git push
To …/origin.git
   289a64d..ee31f16  feature -> feature
```

You don't know that. Nothing has told you the remote moved, and
`--force` doesn't ask:

```sh
$ git push --force
To …/origin.git
 + ee31f16...002ba27 feature -> feature (forced update)
```

The `(forced update)` tag, the leading `+`, the three-dot range
where a fast-forward prints two — that one line is all the
acknowledgment Git gives that this push replaced history instead
of adding to it. The tests commit, ee31f16, is no longer on the
branch. On your teammate's side, the disappearance looks like one
marker in their next fetch:

```sh
$ git fetch
From …/origin
 + ee31f16...002ba27 feature    -> origin/feature  (forced update)
$ git status -sb
## feature...origin/feature [ahead 2, behind 1]
```

And their reflex from here makes it worse. "Diverged from the remote"
has a standard answer, and the standard answer eats their commit:

```sh
$ git pull --rebase
Successfully rebased and updated refs/heads/feature.
$ git log --oneline -3
002ba27 Add burst allowance
8a66181 Add rate limiter
```

Their tests are gone from their own branch now. The rebase saw a
rewritten upstream and treated every commit the old upstream contained,
theirs included, as rewritten away on purpose. What's left of the
work is no longer on any branch; only their reflog still names it:

```sh
$ git reflog -4
002ba27 HEAD@{0}: pull --rebase (finish): returning to refs/heads/feature
002ba27 HEAD@{1}: pull --rebase (start): checkout 002ba27923d9a9a79c3dc2437adefeb1a6a754a7
ee31f16 HEAD@{2}: commit: Add limiter tests
289a64d HEAD@{3}: clone: from …/origin.git
```

One cherry-pick in their clone puts it back, and an ordinary push
publishes it again:

```sh
$ git cherry-pick ee31f16
[feature aa305f5] Add limiter tests
 Date: Tue Aug 18 01:53:48 2026 -0400
 1 file changed, 1 insertion(+)
 create mode 100644 limiter.test.js
$ git push
To …/origin.git
   002ba27..aa305f5  feature -> feature
```

Two people's time, one commit that briefly had no name left but a
reflog entry. That is the price of `--force` on a shared branch, in
the *good* case, the one where somebody noticed.

## The lease

`--force-with-lease` is force with a condition. Your repository keeps
a remote-tracking ref for the branch — `origin/feature`, its snapshot
of where the remote stood the last time you looked, the same
bookkeeping that [updating a branch without checking it
out](/blog/update-a-branch-without-checking-it-out/) leaned on. The
lease: replace the remote only if it still matches that snapshot. If
anyone pushed since, it won't match.

A week later the story repeats. A pushed commit, a forgotten file, an
amend, and a teammate's new test commit already on the remote,
unfetched. This time you force carefully:

```sh
$ git log --oneline -2
b798839 Add retry budget
aa305f5 Add limiter tests
$ git push --force-with-lease
To …/origin.git
 ! [rejected]        feature -> feature (stale info)
error: failed to push some refs to '…/origin.git'
```

"Stale info" is all it says (there is no hint block), but it did the
thing `--force` wouldn't: it noticed the remote had moved past your
snapshot and kept your push away from work you haven't seen.

## The fetch that breaks it

The lease guards a comparison, and both sides of the comparison are
yours. Anything that runs `git fetch` refreshes `origin/feature`: a
habitual fetch you ran without reading the result, an editor's Git
integration, a Git client's auto-fetch timer. None of those integrate
your teammate's commit. They only update the snapshot:

```sh
$ git fetch origin
From …/origin
   9f74736..cab8c4e  feature    -> origin/feature
$ git push --force-with-lease --dry-run
To …/origin.git
 + cab8c4e...b798839 feature -> feature (forced update)
```

Forced update. The push that was just refused would now go through,
taking cab8c4e, the tests, with it (the fetch line's other end,
9f74736, is your own pushed commit, the one the amend replaced).
What changed sides was a fetch you may not even have run yourself.
VS Code fetches on a timer if you let it. So does my own Git client.
More on that at the end.

## Close the gap with `--force-if-includes`

One more flag adds the question the lease never asks:

```sh
$ git push --force-with-lease --force-if-includes
To …/origin.git
 ! [rejected]        feature -> feature (remote ref updated since checkout)
error: failed to push some refs to '…/origin.git'
hint: Updates were rejected because the tip of the remote-tracking branch has
hint: been updated since the last checkout. If you want to integrate the
hint: remote changes, use 'git pull' before pushing again.
hint: See the 'Note about fast-forwards' in 'git push --help' for details.
```

The two checks differ in kind. The lease asks whether the remote is
where you last saw it — a question about your bookkeeping, and any
fetch answers it for you. `--force-if-includes` asks whether your
branch has ever contained the remote's tip — a question about the
work, one a fetch can't answer for you. Neither can a cherry-picked
copy of the commit: the check walks your branch's reflog looking
for the remote tip itself, not a lookalike.

The flag is easy to make permanent for a repository:

```sh
git config push.useForceIfIncludes true
```

After that, every `--force-with-lease` there carries the check by
itself, and `--global` widens it to every repository. Three caveats:
`--force-if-includes` needs Git 2.30 (December 2020) or newer; with
no reflog to walk, the check refuses every force push, integrated
or not; and the exact form `--force-with-lease=feature:<sha>` turns
the check off — name a precise expectation and Git assumes you know
something it doesn't.

## When it refuses

A refusal from `--force-if-includes` almost always means one
thing: someone built on the commit you rewrote. Look at the remote
before touching the force flags again:

```sh
$ git log --oneline -1 origin/feature
cab8c4e Test retry budget
$ git rebase origin/feature
Successfully rebased and updated refs/heads/feature.
$ git log --oneline -3
b5b3d0e Add retry budget
cab8c4e Test retry budget
9f74736 Add retry budget
```

The rebase settles the competition. Your amend can't stay a rewrite
(replacing 9f74736 now would pull the foundation out from under
cab8c4e), so its content gets replayed *on top*, as a commit of its
own. The replay kept the amended message, which no longer fits a
commit whose only content is the forgotten file. Nothing here has
been pushed yet, so rewording is free — and then the push needs no
force at all:

```sh
$ git commit --amend -m "Note that retries back off"
[feature c5124e3] Note that retries back off
 Date: Tue Aug 18 01:54:26 2026 -0400
 1 file changed, 1 insertion(+)
 create mode 100644 RETRY.md
$ git push
To …/origin.git
   cab8c4e..c5124e3  feature -> feature
```

A fast-forward. Your fix is on the branch, their tests are on the
branch, and the remote never lost a commit. The force flags exist for
the times you do mean to replace history; the refusals exist to
prove you don't mean it by accident.

## Or don't do any of this

The demo above doubled as a bug report against my own client.
[GitDesktop](/features/) force pushed with `--force-with-lease`
alone, and it auto-fetches every ten minutes by default so your
behind-counts stay current without pressing Fetch. That combination
was the fetch that breaks it, running on a schedule: the app was
refreshing its own lease on a timer, and its confirm dialog promised
more than a bare lease can enforce.

So the fix adds `--force-if-includes` to every force-push path in
the app, including the assistant's; on a Git too old to know the
flag, or a branch with no reflog for the check to read, the push
retries with the lease alone instead of failing. The confirm
dialog's wording changed to match what Git actually enforces:
where the check runs, a force push will not overwrite work your
branch doesn't include.

A force push promises that nobody built on what it deletes. Make Git
check the promise.
