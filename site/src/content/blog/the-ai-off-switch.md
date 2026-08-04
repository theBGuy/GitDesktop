---
title: "I use AI every day. My Git client still has an off switch."
description: "GitDesktop is AI-native. One toggle hides all of it. On agency, trust, and the Git client that's left when the AI is gone."
pubDate: 2026-08-05
author: theBGuy
pillar: ai-you-own
tags: ["ai", "workflow"]
---

I don't keep AI out of my own workflow. I use it every day, and I build
GitDesktop with it. The switch that hides every AI feature in the app was
still in the plan from day one.

## Stuffed into everything

People don't trust AI products. The energy use bothers them. The general
feeling is that AI keeps being put in everyone's face when it just doesn't
need to be.

That feeling is all over Reddit: AI stuffed into everything, whether it's
necessary to the product or not. Everyone's trying to force this AI-native
flow, and not everything needs it.

And I build an AI-native Git client.

## What the switch actually does

GitDesktop's settings have a checkbox under General: "Hide AI features."
Turn it on and the AI is gone. The generate buttons leave the commit box
and the pull request dialogs. Whole settings sections disappear. The user
guide drops its AI chapters. The Agent tab's code never even loads.

Even [this website](/) has the switch — a "Just Git" view that hides the
AI features from the pitch.

## The Git client that's left

So what's left when you turn it all off? A full-featured Git client,
without the jumping back and forth to GitHub.

You can open, view, and completely manage
[pull requests](/#pull-requests) from your local client — issues and
discussions the same way. You can cut tags and publish releases. You can
check [repository insights](/integrations/) without opening a browser. And
you can protect branches locally: the kind of [branch rules](/features/)
GitHub doesn't offer on a private repository unless you're on a paid plan.
In GitDesktop they work offline, on any repository.

[**The whole loop, one window**](/blog/the-whole-loop-one-window/) was
never about the AI.

## When you leave it on

The switch isn't the only boundary. GitDesktop never calls AI on its own —
nothing runs unless you invoke it. The only thing that runs unattended is
an automation: a rule you wrote yourself, maybe to review each pull
request when it opens. Even then, nothing happens that you didn't set up.

When you do use the AI, the model is your choice: your own API key, or a
local Ollama where the calls never leave your machine.

## Not everything needs it

I don't keep AI out of my own workflow. But that's my workflow, not yours.
Everyone should have that agency, that option.
