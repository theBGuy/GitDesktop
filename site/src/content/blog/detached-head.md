---
title: "You are in 'detached HEAD' state: what it means and what to do"
description: "Git's detached HEAD paragraph is advice, not an alarm. What HEAD names while detached, where commits land, and the one command that keeps them."
pubDate: 2026-10-14
author: theBGuy
pillar: git-safety
tags: ["git", "recovery"]
ogImage: "/og/detached-head.png"
ogImageAlt: "GitDesktop blog card reading “Detached HEAD: a Place, Not an Error.” — a diagram where on a branch HEAD points to main and main points to a commit, while detached HEAD points straight at commit 86c9c4d past a dashed “no name” box, captioned “on a branch, HEAD goes through a name. detached, it holds the commit itself”."
---

The bug report names a release: v1.3.0 writes export timestamps in
local time, so the same CSV reads differently on every machine that
opens it. Your `main` has moved on since that tag went out three
weeks ago. To see exactly what customers are running, you decide to
check out the tag itself. Here is the repository the
morning this starts:

```sh
$ git log --oneline --decorate -4
f56f091 (HEAD -> main, origin/main, origin/HEAD) feat: json export target
d6d32d7 (tag: v1.3.0) feat: timestamp column for exported rows
6af6ae3 fix: quote fields containing the delimiter
05cafe3 feat: csv export with column mapping
```

One checkout from here, Git is going to print the most quoted
paragraph it ships. To read that paragraph calmly, start with the
thing it is about.

## Where HEAD points on a normal day

Git keeps your position in a file. On a branch, that file holds a
branch name, and the branch holds the commit:

```sh
$ git symbolic-ref HEAD
refs/heads/main
$ cat .git/HEAD
ref: refs/heads/main
```

When you commit, `main` advances and `HEAD` rides along by name.
(`cat .git/HEAD` assumes the main checkout; a linked
[worktree](/blog/work-on-two-branches-at-once/) keeps its own HEAD
elsewhere, at the path `git rev-parse --git-path HEAD` prints.)
Everything Git does with the word "branch" runs through that one
level of indirection, and that indirection is exactly what you are
about to remove.

## What the paragraph actually says

```sh
$ git checkout v1.3.0
Note: switching to 'v1.3.0'.

You are in 'detached HEAD' state. You can look around, make experimental
changes and commit them, and you can discard any commits you make in this
state without impacting any branches by switching back to a branch.

If you want to create a new branch to retain commits you create, you may
do so (now or later) by using -c with the switch command. Example:

  git switch -c <new-branch-name>

Or undo this operation with:

  git switch -

Turn off this advice by setting config variable advice.detachedHead to false

HEAD is now at d6d32d7 feat: timestamp column for exported rows
```

Read it in the order Git wrote it: permission first. You can look
around, you can make experimental changes, you can commit them.
Nothing here is damaged and nothing needs rescuing; the paragraph
even tells you how to turn it off. It exists because of one
mechanical change, and `git status` names where that change happened:

```sh
$ git status
HEAD detached at v1.3.0
nothing to commit, working tree clean
```

Status keeps naming the thing you checked out, a tag here, a short
hash or a remote-tracking ref when that is what you typed. The
mechanical change itself is in the file from the previous section:

```sh
$ cat .git/HEAD
d6d32d74f99e436d40b659ba94715a5688a1fa0d
$ git symbolic-ref HEAD
fatal: ref HEAD is not a symbolic ref
```

`HEAD` no longer holds a branch name. It holds a commit directly,
and `git symbolic-ref` states the definition in the negative: there
is no symbolic ref to resolve. That is all "detached" means. The
file that normally points at a name now points at a hash.

The first consequence shows up in commands that orient themselves by
your current branch. A pull merges into the branch you are on; with
no branch, it refuses to guess:

```sh
$ git pull
You are not currently on a branch.
Please specify which branch you want to merge with.
See git-pull(1) for details.

    git pull <remote> <branch>

```

(`git push` refuses in the same spirit.)

## Committing with no branch under you

The timestamp bug turns out to be one line in `exporter.js`, and you
fix it right there, standing on the release. Git takes the commit
without complaint; look at the label it prints where a branch
name usually goes:

```sh
$ git commit -am "fix: write export timestamps in UTC"
[detached HEAD 86c9c4d] fix: write export timestamps in UTC
 1 file changed, 1 insertion(+), 1 deletion(-)
```

`[detached HEAD 86c9c4d]` where `[main 86c9c4d]` would normally be.
The commit is real and stored like any other. What changed is the
bookkeeping: no branch advanced to include it.

```sh
$ git status
HEAD detached from v1.3.0
nothing to commit, working tree clean
```

Status flips its preposition. "At v1.3.0" meant you stood exactly
where you detached; "from v1.3.0" means you have moved since. The
anchor stays put so you can always see where you came in. And the
log shows the situation plainly:

```sh
$ git log --oneline --decorate -3
86c9c4d (HEAD) fix: write export timestamps in UTC
d6d32d7 (tag: v1.3.0) feat: timestamp column for exported rows
6af6ae3 fix: quote fields containing the delimiter
```

`HEAD` sits on your fix with no branch name beside it. The tag still
points where it always did. Nothing is following you.

## The warning on the way out

The fix verifies, and you switch back to `main` to turn it into a
proper branch. This is the moment Git gets loud:

```sh
$ git switch main
Warning: you are leaving 1 commit behind, not connected to
any of your branches:

  86c9c4d fix: write export timestamps in UTC

If you want to keep it by creating a new branch, this may be a good time
to do so with:

 git branch <new-branch-name> 86c9c4d

Switched to branch 'main'
Your branch is up to date with 'origin/main'.
```

Look at what the warning actually does: it counts the commits, lists
them by hash and subject, and closes with a ready-to-run `git branch`
line naming the tip. Nothing was deleted in this moment. The commit
simply stopped being listed; no branch or tag names it, so `git log`
on any branch will not show it. And suppose the terminal is gone,
warning and hash with it. HEAD's reflog kept a line for every move
you made, the fix commit included; this is the same machinery that
[undoes a hard reset](/blog/undo-a-hard-reset/):

```sh
$ git reflog -3
f56f091 HEAD@{0}: checkout: moving from 86c9c4dcfba8685a14af31dda9600d5ac7660c5e to main
86c9c4d HEAD@{1}: commit: fix: write export timestamps in UTC
d6d32d7 HEAD@{2}: checkout: moving from main to v1.3.0
```

Three entries is enough here because the exit just happened. Every
move HEAD makes afterward pushes the entry deeper, so on a day-old
mess drop the `-3` and scan for the `commit:` line. Either way, the
rescue is the command Git suggested: a branch created at the hash.

```sh
$ git branch fix-utc-timestamps 86c9c4d
$ git log --oneline --decorate -1 fix-utc-timestamps
86c9c4d (fix-utc-timestamps) fix: write export timestamps in UTC
```

The commit did not move and did not change. It gained a name, and
the logs that walk that name now reach it.

## The commands that ask first

`git checkout` detaches without asking because it has two jobs,
switching branches and restoring files, and pointing it at anything
that is not a branch slides into the detached state as a side
effect. Its newer sibling splits those jobs, and `git switch`
treats detaching as something you have to ask for:

```sh
$ git switch v1.3.0
fatal: a branch is expected, got tag 'v1.3.0'
hint: If you want to detach HEAD at the commit, try again with the --detach option.
$ git switch origin/main
fatal: a branch is expected, got remote branch 'origin/main'
hint: If you want to detach HEAD at the commit, try again with the --detach option.
```

The hint is the famous paragraph compressed to one line: if you want
the detached state, say `--detach`; if you wanted a branch, name
one. The classic accident this catches is `git checkout origin/main`.
A remote-tracking ref is not a branch you can be on, so checkout
detaches you there and prints the same paragraph, while switch stops
the typo at the door.

And when the plan was always to come back and fix something, take
the name with you in one move:

```sh
$ git switch -c hotfix-1.3.1 v1.3.0
Switched to a new branch 'hotfix-1.3.1'
```

A branch born at the tag, no detached state at any point, and every
commit you make lands somewhere listed from the first one. The
escape hatch the paragraph advertises works exactly as printed, too:

```sh
$ git switch -
Switched to branch 'main'
Your branch is up to date with 'origin/main'.
```

## Or don't do any of this

GitDesktop's rule for detached HEAD is to say the name everywhere.
Checking out a commit or a tag asks first: "Check out tag v1.3.0?",
with the move spelled out underneath: "Your files move to that tag
and HEAD detaches, so you won't be on a branch. Switching back to a
branch returns everything to normal, and commits you make while
detached need a new branch to keep them." Git prints its paragraph
after you have arrived; a client gets to ask before you go.

Confirm it and the toast answers in the same vocabulary: "Checked
out v1.3.0 — HEAD is detached". The branch switcher in the header
drops its branch name for "detached @ d6d32d7" and pins a "detached"
badge beside it, so the state stays on screen for as long as you are
in it. Under the hood the checkout runs `git switch --detach` on the
resolved commit, the same opt-in form the terminal uses. And the
branch actions that need a current branch do not disappear while
you are detached; rename, delete, and update each stay visible and
say why they are held: "HEAD is detached — there's no current branch
to rename." The state is fine to work in. The product's job is to
make sure you always know you are in it.

Git will take your commits without a branch. It asks for a name only
when you turn to leave.
