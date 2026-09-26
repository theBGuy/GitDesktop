---
title: "Recover uncommitted changes after git reset --hard"
description: "git reset --hard took work you never committed. If you ever staged it, Git kept a blob: how to dig it back out with git fsck and git show."
pubDate: 2026-09-30
author: theBGuy
pillar: git-safety
tags: ["git", "recovery"]
ogImage: "/og/recover-uncommitted-changes.png"
ogImageAlt: "GitDesktop blog card reading “Recover Uncommitted Changes. What git add Already Saved.” — a terminal where git reset --hard is followed by git fsck listing three dangling blobs, one highlighted as “← the fix you staged”."
---

The little loader that reads `.env` files ate your morning. First a
real bug: a value carrying its own `=` (a token, a URL with a query)
split wrong and crashed the parse. That fix went in and you staged it.
Then a rework of the loop, staged once at a decent midpoint, pushed
further, and slowly abandoned. By noon the tree held staged
work, unstaged work on top, a staged defaults file, and one
untracked scratch script:

```sh
$ git status
On branch main
Changes to be committed:
  (use "git restore --staged <file>..." to unstage)
	new file:   defaults.env
	modified:   env.py

Changes not staged for commit:
  (use "git add <file>..." to update what will be committed)
  (use "git restore <file>..." to discard changes in working directory)
	modified:   env.py

Untracked files:
  (use "git add <file>..." to include in what will be committed)
	try.py

$ git reset --hard
HEAD is now at 8db09dc add env loader
```

A bare `git reset --hard` means "make everything match the commit I'm
on." It's the standard-issue clean slate, and it worked: the abandoned
rework is gone. So is the fix, which was the one part of the morning
you had meant to keep.

```sh
$ git status
On branch main
Untracked files:
  (use "git add <file>..." to include in what will be committed)
	try.py

nothing added to commit but untracked files present (use "git add" to track)
$ ls
env.py
try.py
$ cat env.py
def load_env(text):
    pairs = [line.split("=") for line in text.splitlines()]
    return dict(pairs)
```

Take stock. `env.py` is back to the committed version. `defaults.env`
is not just unstaged, it's gone from disk: staging a new file makes it
a tracked file, and `--hard` rewrites tracked files to match the
commit, which doesn't have it. And `try.py` survived, because a
reset rewrites only the paths the target commit or the index tracks,
and `try.py` is on neither list. (An untracked file that is at such
a path gets overwritten without a word.) The command with the
fiercest reputation in Git deleted your staged defaults file and
politely stepped around your scratch script.

[Last time](/blog/undo-a-hard-reset/) this series hit a hard reset,
the reflog was the whole answer. Try it:

```sh
$ git reflog
8db09dc HEAD@{0}: reset: moving to HEAD
8db09dc HEAD@{1}: commit (initial): add env loader
```

The reset was recorded. Both lines name the same commit, because the
reflog tracks where HEAD points, and a reset to HEAD moves it from
8db09dc to 8db09dc. There is no earlier position to return to. Your
morning's work was never a commit, so no ref ever pointed at it, and
the reflog records nothing but refs. This is the incident none of
that machinery can see.

## What `git add` writes down

Different machinery can see it. `git add` does not put your file on a
to-do list. It compresses the file's content into `.git/objects` right
then, as a blob, and records the blob's hash in the index. Stage the
same file again after more edits and Git writes a second blob; the
index points at the new one and the old one just stays on disk. That's
what the index is: a table of pointers into an object store that
staging only ever adds to.

`git reset --hard` replaced the index and the working tree. It didn't
reach into the object store, and `git fsck` can prove it:

```sh
$ git fsck
dangling blob c3c5a5708ebb2258dc763c326ee5b40de99e2081
dangling blob 2865c08644dde4cee755214ae6bdb9bcfb775efc
dangling blob fb3598d186d0c49d0d9b0612c5aa850a49362b04
```

A dangling object is one the database still holds though nothing
claims it anymore. Nothing claims these three: no commit contains
them, no ref resolves to them, and the index no longer lists them.
One blob for each piece of content this repository ever staged and
never committed: the fix, the rework midpoint, and the defaults
file, all still in `.git/objects`. The second `git add` orphaned the
fix before the reset ever ran; the reset orphaned the other two;
neither one deleted a blob.

## Content with no name

A blob is the file's bytes and nothing else. When the [dropped-stash
post](/blog/recover-a-dropped-git-stash/) fished commits out of this
same store, each one carried a message, a date, and parents to tell it
apart by. A blob carries no filename, no timestamp, no author. Three
hashes, and the only way to learn which is which is to look:

```sh
$ git show fb3598d
API_URL=https://api.example.com
DEBUG=false
$ git show c3c5a57
def load_env(text):
    env = {}
    for line in text.splitlines():
        key, value = line.split("=", 1)
        env[key] = value
    return env
$ git show 2865c08
def load_env(text):
    pairs = [line.split("=", 1) for line in text.splitlines()]
    return dict(pairs)
```

The defaults file, the abandoned rework, and there, in the last one,
the fix: `split("=", 1)`, so a value that contains its own `=` stops
crashing the loader. Three blobs take three looks. A long-lived
repository can cough up hundreds, and reading them one hash at a time
stops being a plan. For that, `git fsck --lost-found` copies every
dangling blob into a real file named after its hash, which turns the
search into a grep for any line you remember typing:

```sh
$ git fsck --lost-found
dangling blob c3c5a5708ebb2258dc763c326ee5b40de99e2081
dangling blob 2865c08644dde4cee755214ae6bdb9bcfb775efc
dangling blob fb3598d186d0c49d0d9b0612c5aa850a49362b04
$ grep -r "dict(pairs)" .git/lost-found/other
.git/lost-found/other/2865c08644dde4cee755214ae6bdb9bcfb775efc:    return dict(pairs)
```

(In a linked worktree, `.git` is a file and that literal path won't
resolve; ask `git rev-parse --git-path lost-found/other` for the real
location of the copies.)

## The redirect

You know the hash, and the blob is the file's exact content, so
recovery is one redirect away. A caution before you run it: the
redirect replaces the working copy, and if you've re-typed anything
into the file since the reset, that copy is those edits' only home —
move it aside first. And run the redirect from a shell that passes
bytes through raw: Windows PowerShell re-encodes what `>` writes,
which corrupts the blob on the way to disk. Git Bash and PowerShell
7.4 or later both leave it alone.

```sh
$ git show 2865c08 > env.py
$ git add env.py
$ git ls-files -s env.py
100644 2865c08644dde4cee755214ae6bdb9bcfb775efc 0	env.py
```

Look at the hash the index now records. It's `2865c08` again — the
object store is addressed by content, so staging the recovered file
didn't store a second copy; it pointed the index back at the blob that
was there all along. (That check is also your tripwire: a different
hash there means your shell rewrote the bytes on the way through.) As
far as Git is concerned, the reset has now been undone more precisely
than you could have typed it. Commit, this time.

## What was never stored

The `git fsck` listing above was complete: three blobs, and none of
them contains the comment-skipping you were typing when the rework
lost you. That code was never staged, so Git never stored a byte of
it. No plumbing command gets it back, because there is nothing for
plumbing to reach. If a copy exists anywhere, it's in your editor's
local history, which is a different tool's safety net.

The same boundary runs through untracked files, and you can watch it
happen. One instinct after a reset is to finish the job:

```sh
$ git clean
fatal: clean.requireForce is true and -f not given: refusing to clean
$ git clean -n
Would remove try.py
$ git clean -f
Removing try.py
$ git fsck
dangling blob c3c5a5708ebb2258dc763c326ee5b40de99e2081
dangling blob fb3598d186d0c49d0d9b0612c5aa850a49362b04
```

Bare `git clean` refuses to run — of all Git's destructive commands,
this is the one that ships with the safety engaged, and `-n` will
name its targets first. And after `-f`, read the fsck listing again:
`try.py` does not join the dangling list. It was never staged, so the
object store holds no copy to orphan. A cleaned untracked file leaves
nothing behind inside `.git` at all. (The fix's blob has left the
list too, for the opposite reason: the index claims it again, so it
no longer dangles.)

One more edge: dangling blobs wait on a clock. Garbage collection
eventually sweeps unreachable objects (two weeks old by default), and
[the dropped-stash post](/blog/recover-a-dropped-git-stash/) covers
when a sweep can start on its own. Run your `fsck` first.

## Or don't do any of this

A Git client has to pick a policy for the working tree, because it's
the one place Git's own undo machinery doesn't cover. One distinction
drives [GitDesktop](/features/)'s policy: refuse when losing tracked
edits would be a side effect of something else you asked for, and
when discarding is the thing you asked for, save what can be saved
and confirm the rest.

Ask the app for a hard reset to a commit and it refuses while any
tracked change is outstanding, staged or not: *"the working tree has
uncommitted changes — commit or stash them first"*. A confirm dialog
wasn't enough there because the loss would be collateral: you asked
to move a branch, and what sits past that dialog is the one kind of
damage Git cannot walk back — no reflog entry, no dangling blob for
whatever never got staged.

Discarding is allowed, but routed. Discard an untracked file and the
app moves it to the OS recycle bin rather than deleting it, because of
what the clean demo showed: Git holds no copy of untracked content, so
the app borrows a safety net from the operating system. (Files whose
names the recycle bin refuses, Windows-reserved ones like `nul`, are
deleted outright, and the app's confirm says so.) Discarding
selected tracked files runs `git restore` from the index: what you
staged survives, what you never staged is gone for good. *Discard
all changes* instead resets to the last commit, staged work
included; its staged blobs join the dangling list above. Every
discard asks first.

Stage like it's a save button. Some days it is.
