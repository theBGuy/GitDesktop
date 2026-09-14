---
title: "Is it safe to delete .git/index.lock?"
description: "Git says another process seems to be running. What .git/index.lock is, the one check to run before deleting it, and what a hard kill leaves behind."
pubDate: 2026-09-16
author: theBGuy
pillar: git-safety
tags: ["git", "recovery"]
---

You ran an ordinary Git command and got a refusal with a file path
in it: `Unable to create '.git/index.lock': File exists.` Half the
advice online says delete the file and get on with your day. The
other half warns that deleting lock files is how repositories get
corrupted. The short answer: confirm no Git process is alive in that
repository, then delete the file. Your work is not inside it.

The rest of this post is why that answer holds and what the check
protects you from, measured on Git 2.51 (Windows build, stock
configuration, driven from Git Bash; platform spellings that differ
are called out in place). The demos below are one continuous session;
every command shows its complete output; only machine paths are shortened.

## The lock is a draft of your index

A small repository, one change pending:

```sh
$ git status -sb
## main
 M parser.js
$ git log --oneline
74f695c Add the parser
```

To look at the lock while it exists, hold Git open mid-commit. A
`git commit -a` keeps `.git/index.lock` for as long as its editor is
up, so a stand-in editor that just waits gives us all the time we
need. The `&` and `echo $!` are the one-terminal version of a
story you know: the editor window is open, and you are doing
something else in the foreground.

```sh
$ printf '%s\n' '#!/bin/sh' 'sleep 60' > slow-editor
$ chmod +x slow-editor
$ GIT_EDITOR=./slow-editor git commit -a &
$ echo $!
3232059
$ ls -l .git/index .git/index.lock
-rw-r--r-- 1 Evan 197121 137 Sep 14 01:14 .git/index
-rw-r--r-- 1 Evan 197121 137 Sep 14 01:14 .git/index.lock
```

Two files, side by side. `.git/index` is the staging area you know:
the table Git consults to answer `git status` and to build the next
commit. `index.lock` is the replacement table, being written in
full beside the original. When the operation succeeds, Git renames
the finished replacement over the original in one atomic step, and
the lock name disappears. Until then, the lock file's existence is
the lock: creating it is how a writer claims the index, and a
second writer's attempt to create it fails, which is the refusal
that brought you here.

That layout is the whole safety argument. The file under the lock
name is a half-built copy of a bookkeeping table. Your commits live
in the object store, your edits live in the working tree, and the
original index is still right there, untouched. Deleting a stale
`index.lock` discards a draft.

One scoping note, because it changes where you meet this error:
`git commit -a` holds the lock across the editor because it has to
refresh the index before it can commit it. A plain `git commit` of
work you already staged shows no lock at all while its editor is
open (measured separately, same stand-in editor). The long-lived
lock belongs to the operations that rewrite the index.

## Endings Git can see, and endings it can't

End it politely. In this one-terminal setup the signal lands on the
waiting editor, and Git is still alive to see its editor die:

```sh
$ kill 3232059
Aborting commit due to empty commit message.
$ ls .git/index.lock
ls: cannot access '.git/index.lock': No such file or directory
$ git status --short
 M parser.js
?? slow-editor
```

The editor died; Git woke to an empty message, aborted the commit,
and removed its lock on the way out. A crashed editor is an ending
Git attends — so is a finish, a failure, or a signal Git itself can
catch (Ctrl-C included; its signal handlers run the same cleanup).
Every ending Git sees, it sweeps up after.

Now the ending Git cannot attend. `kill -9` is the reproducible
stand-in for the power cut, the out-of-memory killer, Task Manager's
End task, the laptop that went to sleep with a hook half-run:

```sh
$ GIT_EDITOR=./slow-editor git commit -a &
$ echo $!
3232071
$ kill -9 3232071
$ ls -l .git/index.lock
-rw-r--r-- 1 Evan 197121 137 Sep 14 01:14 .git/index.lock
```

No process, but the claim file is still on disk. That is the entire
phenomenon: a lock on disk means either a Git process is alive and
using it right now, or one died without the chance to clean up. The
safety question is telling those two apart, and nothing in the file
itself will tell you — it's the same 137 bytes either way.

## What still works under a stale lock

The next write meets the claim file and refuses:

```sh
$ git add parser.js
fatal: Unable to create '…/notes/.git/index.lock': File exists.

Another git process seems to be running in this repository, e.g.
an editor opened by 'git commit'. Please make sure all processes
are terminated then try again. If it still fails, a git process
may have crashed in this repository earlier:
remove the file manually to continue.
$ git status --short
 M parser.js
?? slow-editor
$ git log --oneline
74f695c Add the parser
```

Read the message again, slowly: it is the correct procedure in two
sentences. Make sure no process is running, and only then remove the
file by hand. Everything below is the evidence for why those two
steps, in that order, are right.

Notice also what still works. `git status`, `git diff`, `git log`
all ran fine against the held lock, and a fetch lands normally —
none of them need to replace the index. The refusals belong to the
commands that rewrite the staging area — `add` above, and `commit`
and `git stash` measured against the same held lock. A stale lock is
a roadblock on one street, not a frozen repository.

## One check, then delete

The check is the first sentence of Git's advice: is any Git
process alive here? From PowerShell or cmd the spelling is
`tasklist /FI "IMAGENAME eq git.exe"`; elsewhere it's `pgrep git`;
the Git Bash session below counts the same thing with a pipeline:

```sh
$ tasklist | grep -c git.exe
0
$ rm .git/index.lock
$ git status --short
 M parser.js
?? slow-editor
$ git fsck --no-progress
dangling tree 777441cdba5ae9f9e6c3b1af0ae7d7bfceef2f45
$ git commit -am "Handle empty input"
[main 757d2dd] Handle empty input
 1 file changed, 1 insertion(+)
```

Zero Git processes on the whole machine, so the owner of that lock
is gone and the file is a leftover. A nonzero count is not the
opposite verdict, because the count is machine-wide while the
question is about one repository: another repo mid-operation, an
fsmonitor daemon (`core.fsmonitor` keeps one alive per watched
repository), or a prompt daemon that happens to match `pgrep git`
will all hold the number above zero on a perfectly quiet setup.
Treat a nonzero answer as a suspect list, and read each survivor's
command line to see what it is: `pgrep -a git` on Linux,
`pgrep -fl git` on macOS, or in PowerShell the one-liner
`gcim Win32_Process -Filter "Name='git.exe'" | fl ProcessId,CommandLine`.
Daemons announce themselves there. The one thing a command line won't
reliably name is the repository (a git launched from inside one
carries no path in its arguments), so close anything you can't
account for before trusting the delete. With the owner provably
gone, delete it (`del .git\index.lock` from PowerShell or cmd) and
take inventory: the pending change is still pending, the history
is intact, and the commit that was interrupted two sections ago
never happened — Git doesn't half-commit.

The one trace the crash left is that dangling tree: a scratch object
the dying commit wrote, referenced by nothing, sitting in the same
unreferenced limbo a [dropped stash](/blog/recover-a-dropped-git-stash/)
sits in until garbage collection sweeps it. That's the complete
damage report for a hard kill plus a hand-deleted lock: one orphan
object and a finished cup of coffee.

When you run the check, remember the suspects that don't look like
Git: the editor window from the error message's own example, an IDE
whose Git integration is mid-refresh, a hook that is still running,
a desktop client doing background work. Desktop clients deserve one
extra suspicion: some embed Git as a library and hold the lock with
no `git` process for the task list to find, so close those outright
rather than counting them. The process you're looking for was
usually started by something you think of as idle.

One path note: everything above says `.git/index.lock` because the
demo is a plain clone. In a linked worktree each checkout keeps its
own index, so its lock lives under the main repository's `.git`
directory instead. There is nothing to memorize: the path in
Git's error message is the real one, and the command
`git rev-parse --git-path index.lock` prints it wherever you stand.

## Why the check comes first

Here is the same delete with the check skipped — the lock's owner is
alive. Nothing pushes back:

```sh
$ printf '// TODO: sort keys before writing\n' >> parser.js
$ printf '%s\n' '#!/bin/sh' 'echo "Sort keys before writing" > "$1"' 'sleep 30' > slow-editor2
$ chmod +x slow-editor2
$ GIT_EDITOR=./slow-editor2 git commit -a &
$ echo $!
3232101
$ rm .git/index.lock
$ printf 'todo\n' > notes.md
$ git add notes.md
$ git status --short
A  notes.md
 M parser.js
?? slow-editor
?? slow-editor2
```

The `rm` succeeded without a murmur, and the `git add` right after
it walked straight in and staged a file — with a commit still in
flight in the background. The mutual exclusion is gone; two writers
now hold two different ideas of what the index says. When the first
one finishes, the ideas collide:

```sh
$ wait
fatal: repository has been updated, but unable to write
new index file. Check that disk is not full and quota is
not exceeded, and then "git restore --staged :/" to recover.
$ git log --oneline
72fdf62 Sort keys before writing
757d2dd Handle empty input
74f695c Add the parser
$ git status --short
A  notes.md
MM parser.js
?? slow-editor
?? slow-editor2
$ git restore --staged :/
$ git status --short
?? notes.md
?? slow-editor
?? slow-editor2
```

Take that apart. The commit landed (`git log` shows it), but the
committing process lost the race to write the index it believed
in, so it died pointing at a disk-full that never happened.
`git status` now reports `MM` on a file that was committed one
command ago: staged changes that differ from the commit and a
working tree that differs from the staging. No line of anyone's
work was lost, and Git's own printed recovery put the index back
in one command — though read it before you reuse it: the recovery
runs `git restore --staged :/`, which unstages everything in the
repository, the deliberate `add` included; that is `notes.md`
dropping back to untracked on the last line. What the blind
delete bought was a torn scoreboard, a misleading error, and a
repair step — on a toy repository with one human typing slowly.
The check costs one command; this is what it buys.

## Even `git status` writes through that lock

The second writer above was me, typing. In your repository it is
more often software, and it doesn't have to be doing anything that
looks like a write. Sweep the demo scaffolding out of the way and
watch the index file itself:

```sh
$ rm notes.md slow-editor slow-editor2
$ stat -c '%y' .git/index
2026-09-14 01:15:18.521557500 -0400
$ touch parser.js
$ git status --short
$ stat -c '%y' .git/index
2026-09-14 01:15:18.653266700 -0400
```

A `git status` that printed nothing rewrote the index. (The
`stat -c` spelling is GNU; BSD and macOS spell it `stat -f '%Sm'`.)
The touched file made Git re-check its cached file metadata, and
it saved the refreshed cache the only way it saves anything: new
table under the lock name, atomic rename. Git treats that
particular lock as optional (a status that can't get it just
skips the save) and gives tools a switch to opt out entirely:

```sh
$ touch parser.js
$ GIT_OPTIONAL_LOCKS=0 git status --short
$ stat -c '%y' .git/index
2026-09-14 01:15:18.653266700 -0400
```

Same silent status, index untouched. `GIT_OPTIONAL_LOCKS=0` (or
`git --no-optional-locks`) exists for one audience: software that
runs Git in the background of your repository and has no business
competing with your hands for the index.

## Or don't do any of this

Look at the suspect list in Git's error message one more time:
"another git process seems to be running." A desktop Git client is
"another git process" for a living. It refreshes status every few
seconds; it fetches while you read; it is the thing most likely to
be holding, or meeting, that lock at the moment you get unlucky.
The error message reads as an accusation of exactly my category of
software, so I treat it as a conduct code for [GitDesktop](/features/),
in three clauses.

Every Git command the client itself runs goes through one spawn
path, and that path sets `GIT_OPTIONAL_LOCKS=0`. The background
status refresh you just watched rewrite an index cannot do that in
your repository from my client — reads stay reads.

When a single mutating command it runs on your behalf meets a lock
someone else holds (your terminal, your editor, your hook), it waits
300ms and retries once before showing you Git's message verbatim,
because a lock that exists for the length of an editor's save
usually needs a beat of patience, not an error dialog.

And when it must kill a Git process of its own, say a network
operation past its deadline, on Windows it ties each spawned Git to
a job object, so the `git` shim on PATH and the real `git.exe` it
launches underneath die together instead of leaving an orphan
writer behind. A half-killed Git that keeps writing after the
client reported failure is the "crashed earlier" branch of that
error message, manufactured by tooling; the least a client
can do is make sure that when this post's check says nothing
is running, nothing is.

None of that makes the stale lock impossible. Power still fails,
laptops still sleep at the wrong moment, and some other tool will
eventually die holding the claim. When it happens, you now know
exactly what is in that file: a draft of a table you can regenerate
with any `git add`, guarded by a name whose owner may be long gone.

The delete is safe the moment you can prove the last writer is gone;
the file was always a draft wearing an important-sounding name.
