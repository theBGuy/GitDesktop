---
title: "Will this merge conflict? Find out without merging"
description: "git merge-tree does the whole merge in memory and names every file that would conflict — without touching your working tree, your index, or your branch."
pubDate: 2026-07-29
author: theBGuy
pillar: git-safety
tags: ["git", "merge", "conflicts"]
---

You're about to merge a long-running branch and you'd like to know, first,
whether it's going to hurt. Not "did it hurt" — *will* it. Ten files or two
hundred, five minutes or an afternoon, safe to do now or better after lunch.

Git has known the answer the whole time. It just isn't the answer you get from
running `git merge` and reading the wreckage.

## The usual answer costs you your working tree

The standard trick is to merge without committing and look:

```sh
$ git merge --no-commit --no-ff feature
Auto-merging shared.txt
CONFLICT (content): Merge conflict in shared.txt
Automatic merge failed; fix conflicts and then commit the result.
```

That did tell you. It also rewrote your working tree to tell you:

```sh
$ git status --porcelain
UU shared.txt
```

Now you're sitting in a conflicted merge state you didn't want, and you have to
back out of it:

```sh
$ git merge --abort
```

For a one-file toy repo that's a nuisance. On a real branch it's worse than a
nuisance, because a branch hasn't been just a branch for years now. Touching the
working tree restarts dev servers, invalidates caches, triggers file watchers,
and re-runs whatever your editor does on change. You asked a question and paid
for it with your environment — [the exact tax I built this client to
stop](/blog/the-whole-loop-one-window/).

And if you're merging into a branch you don't have checked out, this approach
doesn't even apply. You'd have to check it out first.

## Git will do the merge in memory instead

Since version 2.38, `git merge-tree` can perform a complete, real merge —
rename detection, the works — and write the result to the object database
without going near your working tree, your index, or `HEAD`:

```sh
$ git merge-tree --write-tree --name-only main feature
c9cc90770ebb9dee14e212f168dd40059cfb605a
shared.txt

Auto-merging shared.txt
CONFLICT (content): Merge conflict in shared.txt
```

The exit code is the verdict:

| Exit | Meaning |
| --- | --- |
| `0` | Clean. The merge will succeed. |
| `1` | Conflict — **or** Git declined the merge outright. |
| other | Git couldn't start at all (unrelated histories exits `128`). |

When the merge runs at all, line one is the OID of the merged tree. On a
conflict, the lines after it are the conflicted paths, then a blank line, then
the human-readable messages. On a clean merge you get line one and nothing else:

```sh
$ git merge-tree --write-tree --name-only main sidebranch
25f5a925378bfaca7638e006291edcb7374db5bf
$ echo $?
0
```

Parse to the blank line and you have your file list. Which brings us back to
that qualifier on exit `1`: it does **not** mean "conflict" by itself. Ask to
merge a branch that doesn't exist and you get `1` as well — with a completely
empty stdout, the message going to stderr instead. So test stdout, not the code
alone: empty output means Git refused, which is "unknown", not "a conflict in
zero files".

And your working tree never moved:

```sh
$ git status --porcelain
$ git rev-parse --abbrev-ref HEAD
main
```

It's so thoroughly detached from your checkout that it runs fine in a bare repo,
which has no working tree to touch in the first place. That's the property that
makes it useful for a tool: you can preview merging *any* branch into *any*
other, without either one being checked out.

## The merged tree is a real object

That OID on line one isn't a receipt. It's a tree in your object database, and
every read-only command that takes a tree will take it.

Want to see what the conflict actually looks like before deciding? Read the file
straight out of the merge result — conflict markers and all:

```sh
$ TREE=$(git merge-tree --write-tree --name-only main feature | head -1)
$ git cat-file -p "$TREE:shared.txt"
line1
<<<<<<< main
MAIN
=======
FEATURE
>>>>>>> feature
line3
```

Want the diffstat of what merging would do to you?

```sh
$ git diff --stat main "$TREE"
 shared.txt | 4 ++++
 1 file changed, 4 insertions(+)
```

You now know the size of the job, the shape of every conflict, and which files
they're in — and you still haven't run a merge.

## The trap: `-X ours` does less than you think

Here's the part that's worth the whole article, because it's the part that will
quietly lie to you if you build on it.

If a preview says "conflict", the obvious next thought is: fine, I'll merge with
a strategy option and let Git pick a side. So you re-run the preview mentally,
decide `-X ours` will mop it up, and report "3 conflicts, all auto-resolvable".

Sometimes that's true. `-X ours` really does resolve the content conflict above:

```sh
$ git merge-tree --write-tree --name-only -X ours main feature
51c500ddf270e2f1f6bdf80e5af7fb598c95910b
$ echo $?
0
```

Clean. Different tree, no conflicts, exit 0.

Now the same experiment where `feature` edited a file that `main` deleted:

```sh
$ git merge-tree --write-tree --name-only main feature
61eb2660b922022a67457fa4d76a1687b447e0ee
doomed.txt

CONFLICT (modify/delete): doomed.txt deleted in main and modified in feature.

$ git merge-tree --write-tree --name-only -X ours main feature
61eb2660b922022a67457fa4d76a1687b447e0ee
doomed.txt

CONFLICT (modify/delete): doomed.txt deleted in main and modified in feature.
```

Look at the tree OIDs. They're **identical**. `-X ours` didn't resolve it, didn't
change the outcome, didn't change a single byte of the result. `-X theirs`
produces that same OID too.

The reason is that `-X ours` and `-X theirs` only arbitrate **content** conflicts
— cases where one path ends up with two candidate texts and Git needs only to be
told which one wins. They have nothing to say about **structural** ones, where
the disagreement is about whether the file should exist, or where it lives:

- `modify/delete` — one side edited it, the other removed it
- `rename/delete` — one side moved it, the other deleted it
- `rename/rename` — one file moved to two different names
- `file/directory` — one side made it a file, the other a directory

Git cannot pick a side there, because there is no "side" to pick; the question
isn't which text wins, it's what the tree should contain. Those stop the merge
no matter which `-X` you pass.

The boundary isn't "does it look structural", though — it's whether there are
two texts to choose between. `add/add` looks structural, but both sides did
produce a file at one path, so there *is* a text to pick, and `-X ours` resolves
it to exit 0. Test the specific case rather than reasoning from the category
name.

So if you're predicting the result of a merge that will use a strategy option,
**re-run `merge-tree` with that option** and report what it actually says.
Taking a no-strategy conflict list and relabelling it "will auto-resolve" is
wrong for exactly the conflicts a person most needs warning about.

## What it costs

Two honest caveats, because "touches nothing" is a slight overstatement.

**It writes objects.** `--write-tree` means what it says: the merged tree and any
merged blobs get written to the object database. How many depends on the merge.
Back in the `shared.txt` repo from earlier, clear the loose-object count to zero
first so what follows is a clean delta. That content conflict adds two — a tree,
and the blob holding the marked-up file:

```sh
$ git gc --prune=now                   # start from a clean baseline
$ git count-objects -v | grep '^count:'
count: 0
$ git merge-tree --write-tree --name-only main feature >/dev/null
$ git count-objects -v | grep '^count:'
count: 2
```

Run the same thing in the `doomed.txt` repo and the count doesn't move at all.
That merge's tree is byte-identical to one Git already had, so there is nothing
new to write.

The objects that *do* get written are unreachable the moment they land — but
"unreachable" is not "gone". `git gc` will not delete them: `gc.pruneExpire`
defaults to two weeks, so an ordinary gc sweeps them into a cruft pack instead.
The loose count falls back to zero while `git cat-file -t <oid>` still
cheerfully answers `tree` — so on a current Git the `count-objects` snippet
above will tell you they have vanished when they have not. (Before 2.41, when
cruft packs became the default, they simply stayed loose and the count stayed
at two.) Only `git gc --prune=now` actually removes them. The cost is real but
small, and it does clear itself — on Git's schedule, not on yours.

**It needs a reasonably current Git.** Both `--write-tree` and `--name-only`
arrived in Git 2.38, released on 2 October 2022. On anything older, the only
`merge-tree` you get is the one the manual now files under "DEPRECATED
DESCRIPTION" — a trivial merge that, in its own words, cannot "handle content
merges of individual files, rename detection, proper directory/file conflict
handling, etc."

That mode is still reachable today as `--trivial-merge`, and it's worth knowing
why you don't want it: it exits **0** even when it reports a conflict. A tool
that shells out without checking the version doesn't get an error on old Git —
it gets a confidently clean answer about a merge that will not be clean. Check
the version, and degrade to showing nothing rather than showing something wrong.

## Or don't do any of this

I write a Git client, so the pitch is obvious enough that I'd rather just say it
plainly.

Everything above is genuinely worth knowing. Knowing that Git will merge in
memory for free, and that `-X ours` can't rescue a `modify/delete`, makes you
harder to surprise. But it's also a shell pipeline you have to remember, at the
exact moment you're trying to decide something else.

In [GitDesktop](/features/) that same `merge-tree` call runs before the merge
button does anything: fast-forward, clean, or conflicted with the file list
already on screen — and if you change the on-conflict strategy, the preview
re-runs with that strategy instead of guessing on your behalf. Same command,
same object database, no pipeline.

Either way, the thing to take away is that the answer was always available. A
merge is not the only way to find out what a merge would do.
