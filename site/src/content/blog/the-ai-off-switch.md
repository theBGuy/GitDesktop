---
title: "I use AI every day. My Git client still has an off switch."
description: "GitDesktop is AI-native. One toggle hides all of it. On agency, trust, and the Git client that's left when the AI is gone."
pubDate: 2026-08-05
author: theBGuy
pillar: ai-you-own
tags: ["ai", "workflow"]
---

I use AI constantly. It helps write commit messages, draft pull request
descriptions, and review code before I open a PR. Sometimes it catches
something I missed. Sometimes it just saves me five minutes.

GitDesktop has all of those features.

It also has a setting called **Hide AI features**.

Why build AI into a Git client and then make it disappear?

Because I don't think software should decide how people work.

## AI isn't the product

It's easy to look at developer tools right now and feel like every
application has become an AI application. Sometimes that's useful.
Sometimes it's just another button you have to ignore.

I didn't want GitDesktop to end up as an assistant with a Git client
somewhere underneath it. I wanted a Git client first. The goal was
[the whole loop, one window](/blog/the-whole-loop-one-window/) long
before the first AI feature existed.

## The switch isn't cosmetic

Turn on "Hide AI features" (one checkbox under General) and GitDesktop
doesn't gray out a few buttons. The generate actions disappear from the
commit box and the pull request dialogs. Whole settings sections are
removed. The user guide drops its AI chapters. The Agent tab's code never
even loads. Even [this website](/) has the switch: a "Just Git" view that
hides the AI features from the pitch.

What's left is simply GitDesktop.

You can manage [pull requests](/#pull-requests), issues, discussions,
releases, worktrees, interactive rebases, repository insights, and
[local branch rules](/features/) without opening a browser.

The workflow is still complete.

Only the optional layer disappears.

## Agency matters

I think AI is genuinely useful. I also think people should decide when
it belongs in their workflow. So GitDesktop never calls a model on its
own. The only thing that runs automatically is a rule you created
yourself.

When you do use it, you choose where the requests go. Bring your own API
key. Run Ollama locally, so the calls never leave your machine. Or don't
use AI at all. The software shouldn't make that decision for you.

Optional means optional.

## Software you can trust

Trust is knowing what your tools will do. When you hide a feature, it
should actually disappear. When you don't want AI in your workflow, your
Git client shouldn't keep reminding you that it exists.

I use AI every day.

That's my workflow.

It doesn't have to be yours.

One of the design goals behind GitDesktop is that it never assumes
otherwise.
