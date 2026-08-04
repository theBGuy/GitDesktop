---
title: "I use AI every day. My Git client still has an off switch."
description: "GitDesktop is AI-native. One toggle hides all of it. On agency, trust, and the Git client that's left when the AI is gone."
pubDate: 2026-08-05
author: theBGuy
pillar: ai-you-own
tags: ["ai", "workflow"]
---

I use AI constantly. It writes commit messages I would have typed myself.
It drafts pull request descriptions. It reviews my code before I open a
pull request — sometimes it catches something I missed, sometimes it just
saves me five minutes. GitDesktop has all of those features. It also has
a setting called "Hide AI features."

Why build AI into a Git client and then make it disappear? Because I
don't think software should decide how people work.

## AI isn't the product

It's easy to look at developer tools right now and feel like every
application has become an AI application. Sometimes that's useful.
Sometimes it's just another button you have to ignore. Everyone's trying
to force this AI-native flow, and not everything needs it.

I didn't want GitDesktop to end up as an assistant with a Git client
somewhere underneath it. I wanted a Git client first. The goal was
[**the whole loop, one window**](/blog/the-whole-loop-one-window/) long
before the first AI feature existed.

## The switch isn't cosmetic

Turn on "Hide AI features" (one checkbox under General) and GitDesktop
doesn't gray out a few buttons. The generate actions disappear from the
commit box and the pull request dialogs. Whole settings sections are
removed. The user guide drops its AI chapters. The Agent tab's code never
even loads. Even [this website](/) has the switch: a "Just Git" view that
hides the AI features from the pitch.

What's left is simply GitDesktop. You can open, view, and completely
manage [pull requests](/#pull-requests) from your local client — issues
and discussions the same way. You can cut tags, publish releases, manage
your worktrees, edit your unpushed history, and check your
[repository insights](/integrations/) without opening a browser. You can
recover lost work from the operation history, and protect branches
locally with the kind of [branch rules](/features/) GitHub doesn't offer
on a private repository unless you're on a paid plan. The workflow stays
complete. Only the optional layer disappears.

## Agency matters

I think AI is genuinely useful — I use it every day. I also think people should
decide when it belongs in their workflow. So GitDesktop never calls a
model on its own. Nothing happens unless you ask for it; the one
exception is an automation you wrote yourself, and even that only runs
the rule you gave it.

When you do use it, you choose where the requests go. Bring your own API
key. Run Ollama locally, so the calls never leave your machine. Or don't
use AI at all. The software shouldn't make that decision for you.

## Software you can trust

Trust isn't only about security or privacy. It's about knowing what your
tools will do. When you disable a feature, it should actually disappear.
When you don't want AI in your workflow, your Git client shouldn't keep
reminding you that it exists.

I use AI every day. But that's my workflow. One of the design goals
behind GitDesktop is that you never have to make it yours.
