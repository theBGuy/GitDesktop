---
title: "git status shows every file as modified? It's usually line endings"
description: "git status lists files you never edited. git diff shows why, from CRLF line endings to the executable bit, and each cause has its own lasting fix."
pubDate: 2026-11-04
author: theBGuy
pillar: git-safety
tags: ["git", "line-endings", "windows"]
ogImage: "/og/every-file-shows-as-modified.png"
ogImageAlt: "GitDesktop blog card reading “Every File Shows As Modified”, above the output of git ls-files --eol for six files. Five rows pair a dim i/lf with a mint w/crlf; the scripts/release.sh row reads i/crlf and w/crlf, both in white. Captioned “i/ is the repository's copy, w/ is the file on your disk”."
---

`git status` in your WSL terminal lists nearly every file in the project
as modified. You cloned it on Windows a few minutes ago, opened the folder
from WSL to run the tests, and haven't edited anything:

```sh
$ git status --short
 M README.md
 M package.json
 M src/index.ts
 M src/parse.ts
 M src/total.ts
$ git diff src/total.ts
diff --git a/src/total.ts b/src/total.ts
index b61f008..5172e2c 100644
--- a/src/total.ts
+++ b/src/total.ts
@@ -1,3 +1,3 @@
-export function total(amounts: number[]): number {
-  return amounts.reduce((sum, n) => sum + n, 0);
-}
+export function total(amounts: number[]): number {^M
+  return amounts.reduce((sum, n) => sum + n, 0);^M
+}^M
```

Every line comes out and goes back in unchanged, apart from a `^M` on the
end of the new ones. "Modified" covers several unrelated situations, and
`git diff` shows each one differently, so read it before you restore
anything. If yours shows only `old mode` and `new mode` lines, skip to the
"old mode, new mode" section near the end; the rest is about line endings.

## Two Gits disagree about one folder

`^M` is a carriage return (CR), the first byte of a Windows line ending
(CRLF); Unix-style endings are a bare line feed (LF). In a terminal, where
Git colors its output by default, it highlights a CR at the end of an
added line as trailing whitespace, and `less`, the usual pager, displays
the highlighted CR as `^M`. The repository stores this file with LF
endings and the copy on disk has CRLF, which is why the `^M` sits on the
`+` lines: they come from the working file.

The CRs are Git for Windows' doing. Its installer preselects the
line-ending choice that sets `core.autocrlf=true` in Git's system config,
and with it Git writes CRLF when it checks a text file out and strips the
CRs again when you `git add` it. WSL's Git never reads that config file.
It compares the CRLF files on disk with the LF copies in the repository
and finds every line changed. The Windows side of this post runs Git
2.51.1 in Git Bash with the installer's line-ending default, and the WSL
side runs Ubuntu's Git 2.34.1. A few more commands in WSL:

```sh
$ git diff --ignore-cr-at-eol
$ git config core.autocrlf
$ git ls-files --eol
i/lf    w/crlf  attr/                 	README.md
i/lf    w/crlf  attr/                 	package.json
i/crlf  w/crlf  attr/                 	scripts/release.sh
i/lf    w/crlf  attr/                 	src/index.ts
i/lf    w/crlf  attr/                 	src/parse.ts
i/lf    w/crlf  attr/                 	src/total.ts
```

`--ignore-cr-at-eol` prints nothing: the CRs are the whole difference.
WSL's Git has no `core.autocrlf` setting at all. `git ls-files --eol`
reports both sides of every tracked file. `i/` is the repository's copy
(strictly, the copy in the index, Git's staging area), `w/` is the working
file, and `attr/` shows any line-ending rule from `.gitattributes`. There
are none yet. One file breaks the pattern. `scripts/release.sh` was
committed with CRLF endings, its working copy matches byte for byte, and
WSL leaves it off the list.

In a Windows terminal, the same folder is clean:

```sh
$ git config core.autocrlf
true
$ git status --short
```

The files and the index are identical on both sides; only the setting
differs. No system or global config file reaches both Gits, so each Git
would need its own setting. The clone's own `.git/config` is shared, and
running `git config core.autocrlf true` inside it makes WSL agree for this
one checkout. A rule committed to the repository reaches every clone.

## Modified in `git status`, empty in `git diff`

Still in Windows, you run the project's formatter, which writes LF line
endings. The code was already formatted, so all it changes is the CRs that
Git put there. Now Windows lists the same five files:

```sh
$ git status --short
 M README.md
 M package.json
 M src/index.ts
 M src/parse.ts
 M src/total.ts
$ git diff
warning: in the working copy of 'README.md', LF will be replaced by CRLF the next time Git touches it
warning: in the working copy of 'package.json', LF will be replaced by CRLF the next time Git touches it
warning: in the working copy of 'src/index.ts', LF will be replaced by CRLF the next time Git touches it
warning: in the working copy of 'src/parse.ts', LF will be replaced by CRLF the next time Git touches it
warning: in the working copy of 'src/total.ts', LF will be replaced by CRLF the next time Git touches it
```

This time the diff is empty apart from one warning per file. Status and
diff check different things. To decide whether a file is modified,
`git status` starts with the size and timestamp the index recorded the
last time Git wrote or read the file. When the size no longer matches,
status reports the file as modified without reading it. The shortcut
lives in `ie_modified()` in Git's `read-cache.c`. Removing one byte from
every line changed every file's size. `git diff` goes further for a file
whose recorded size or timestamp is out of date: it runs the file
through the conversion `git add` would apply and compares the result
with the repository's copy, and here the two are identical. The
[index.lock post](/blog/is-it-safe-to-delete-index-lock/) shows status
refreshing that record after a `touch`.

The warning, "LF will be replaced by CRLF the next time Git touches it",
is about the next checkout. The file on disk now has LF endings, and with
`core.autocrlf=true` Git will write it out with CRLF when it next checks
the file out. It isn't an error, and the stored content is unchanged.

Running `git add` clears the list. Name the files if you have other work
in progress, because `-A` stages everything, untracked files included:

```sh
$ git add -A
warning: in the working copy of 'README.md', LF will be replaced by CRLF the next time Git touches it
warning: in the working copy of 'package.json', LF will be replaced by CRLF the next time Git touches it
warning: in the working copy of 'src/index.ts', LF will be replaced by CRLF the next time Git touches it
warning: in the working copy of 'src/parse.ts', LF will be replaced by CRLF the next time Git touches it
warning: in the working copy of 'src/total.ts', LF will be replaced by CRLF the next time Git touches it
$ git status --short
$ git diff --cached
```

`git add` hashed each file, found content the repository already had, and
recorded the new sizes in the index. That's why `git diff --cached` shows
nothing staged. The formatter can run again without the list coming back,
since the files already have LF endings. A branch switch that rewrites a
file with CRLF puts that file back on the list after the next format.

## A file `git restore` can't clear

Your teammate Mira pushes a one-line `.gitattributes`, `*.sh text eol=lf`,
meant to give shell scripts LF endings. It covers the release script, the
one file in the repository committed with CRLF. You pull:

```sh
$ git pull
From …/receipts
   6c09e8a..5fa0a0f  main       -> origin/main
Updating 6c09e8a..5fa0a0f
Fast-forward
 .gitattributes | 1 +
 1 file changed, 1 insertion(+)
 create mode 100644 .gitattributes
$ git status --short
$ touch scripts/release.sh
$ git status --short
 M scripts/release.sh
$ git diff --ws-error-highlight=all
warning: in the working copy of 'scripts/release.sh', CRLF will be replaced by LF the next time Git touches it
diff --git a/scripts/release.sh b/scripts/release.sh
index 0003b37..b29d6e2 100644
--- a/scripts/release.sh
+++ b/scripts/release.sh
@@ -1,4 +1,4 @@
-#!/bin/sh^M
-set -e^M
-npm test^M
-npm run build^M
+#!/bin/sh
+set -e
+npm test
+npm run build
```

Nothing shows right after the pull. The file hasn't been read since, and
status still trusts its recorded size and timestamp. `touch` stands in for
whatever changes the timestamp first, such as an editor saving the file. A
fresh clone usually lists the file straight away: Git writes the files and
the index within the same second, doesn't trust a timestamp that ties with
the index's own, and reads the file to be sure.

A plain `git diff` would show the removed and added lines with identical
text here: by default Git highlights a trailing CR only on added lines,
and `less` deletes a CR that comes straight before the newline.
`--ws-error-highlight=all` marks the removed lines too, and the `^M` on
the `-` side shows the CRs are in the repository's copy. The `text`
attribute tells Git to convert CRLF to LF whenever the file goes into
the index. Your copy converts to LF and stops matching the CRLF copy in
the repository. The warning describes that conversion: once you commit
the LF version, every checkout writes the script with LF. Restoring the
file doesn't help:

```sh
$ git restore scripts/release.sh
$ git status --short
 M scripts/release.sh
```

`git restore` writes the repository's CRLF copy back to disk, which is the
file you already had, and it converts to LF again when status compares it.
`git reset --hard` puts the same bytes back too, and throws away any real
edits along the way ([recovering them](/blog/recover-uncommitted-changes/)
has its own post). Every status rereads the file and finds the same
difference, so it stays on the list. Your copy is fine. The repository's
copy has to change, and committing it with LF endings does that.

## One .gitattributes line for every clone

Mira's rule handles one file type and leaves everything else to each
machine's config. A rule for every file covers all three cases above.
Renormalizing restages every tracked file, so start with no real
uncommitted edits; the phantom `release.sh` entry is fine, since this is
what clears it. Add a line above hers and renormalize:

```sh
$ cat .gitattributes
* text=auto eol=lf
*.sh text eol=lf
$ git add --renormalize .
$ git status --short
M  .gitattributes
M  scripts/release.sh
$ git commit -m "Normalize line endings"
[main b340c0a] Normalize line endings
 2 files changed, 5 insertions(+), 4 deletions(-)
$ git status --short
$ git ls-files --eol
i/lf    w/lf    attr/text=auto eol=lf 	.gitattributes
i/lf    w/lf    attr/text=auto eol=lf 	README.md
i/lf    w/lf    attr/text=auto eol=lf 	package.json
i/lf    w/crlf  attr/text eol=lf      	scripts/release.sh
i/lf    w/lf    attr/text=auto eol=lf 	src/index.ts
i/lf    w/lf    attr/text=auto eol=lf 	src/parse.ts
i/lf    w/lf    attr/text=auto eol=lf 	src/total.ts
```

`text=auto` lets Git decide which files are text and leave images and
other binaries alone, and `eol=lf` gives text files LF endings in every
working tree. The catch-all goes first because later lines in
`.gitattributes` override earlier ones. A repository that ships Windows
batch files would add `*.bat text eol=crlf` below it. With an `eol` on
every path, `core.autocrlf` no longer decides how these files are written,
and the installer's default stops applying here.

`git add --renormalize .` runs every tracked file through the conversion
again and stages whatever comes out different. Here it staged the release
script, whose stored copy becomes LF. A brand-new `.gitattributes` needs
its own `git add`, since renormalizing only touches tracked files. The
`w/crlf` left on `release.sh` is your working copy, which keeps its CRs
until Git next writes the file. The rule converts them as the file goes
in, and it doesn't show as modified.

New clones get LF endings on disk, matching what the formatter writes.
WSL's Git applies the same rule, and in the next section its first
`git status` comes up clean with the CRLF release script still on disk.
Existing checkouts keep their CRLF files until Git rewrites them, so the
next format there lists them once more, and one `git add` of those files
settles it for good.

Teammates hit one snag when they pull the commit. Anyone whose
`release.sh` already shows as modified gets "Your local changes to the
following files would be overwritten by merge" from `git pull`. Stashing,
as the message suggests, doesn't clear it: any other edits go into the
stash, the script stays listed, and the pull refuses again. Staging the
script works if they haven't edited it. `git add scripts/release.sh`
stores the converted copy, which matches the new commit, and the pull goes
through. Anyone who stashed first gets their other edits back with
`git stash pop`.

If your team wants CRLF in Windows working trees, swap the first line for
`* text=auto` and keep Mira's line for the scripts. The repository still
stores LF, and Windows checkouts get CRLF unless a machine sets
`core.autocrlf=input`. On those CRLF checkouts, the formatter's LF output
keeps showing up in `git status` until you stage it.

## One more shape: old mode, new mode

Back in WSL, the line endings agree now, but a checkout can still list
every file for a reason that has nothing to do with them. The demo turns
`core.fileMode` on to show it, then off again:

```sh
$ git status --short
$ git config core.fileMode true
$ git status --short
 M .gitattributes
 M README.md
 M package.json
 M scripts/release.sh
 M src/index.ts
 M src/parse.ts
 M src/total.ts
$ git diff README.md
diff --git a/README.md b/README.md
old mode 100644
new mode 100755
$ git config core.fileMode false
$ git status --short
```

WSL's default mount reports every file on a Windows drive as executable.
Git compares that bit with the mode it recorded only when `core.fileMode`
is true, and `git clone` and `git init` test the filesystem and set it to
false where the bit can't be trusted. Git for Windows did that when it
made this clone, and WSL's Git does the same for a repository it creates
on the Windows drive. A repository created on Linux keeps `true` in its
config when you copy it across, the situation the demo stands in for.
`git config core.fileMode false` in that repository clears the list; after
that, `git update-index --chmod=+x` records a mode change you want.

## Or don't do any of this

The `.gitattributes` line is still yours to write, since
[GitDesktop](/features/) has no control for it. Its Git runner does
cut the noise: it drops Git's per-file line-ending warnings from the
output it captures, so when a command fails, its error isn't buried
under one warning for every file it touched. The diff pane also
names a mode-only change in words, "File is now executable", and a
list of files that all say so points straight at `core.fileMode`.

The line-ending setting is under **Settings → Git → Line endings**. It
writes your global `core.autocrlf`, which still decides line endings for
any file that `.gitattributes` gives no `eol`.

Git leaves line endings to each machine unless the repository says otherwise.
