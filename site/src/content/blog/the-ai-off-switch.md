---
title: "I use AI every day. My Git client still has an off switch."
description: "GitDesktop is AI-native. One toggle hides all of it. On agency, trust, and the Git client that's left when the AI is gone."
pubDate: 2026-08-05
pillar: ai-you-own
tags: ["ai", "workflow"]
---

I don't keep AI out of my own workflow. I use it every day, and I build
GitDesktop with it. And "Hide AI features" was in the plan from day one.

## They should have that option

Not every user wants AI, and not every user needs it. And I think there's a
growing portion of people who just don't want to see it, because it's
semi-controversial. I really think every app should have the ability to turn
off AI. People don't want to use it, don't need to use it, and don't want to
see it. They should have that agency, that option.

For me it comes down to simple agency. Additional features like this should
be configurable, and I don't think it's right to force things on people when
they're not necessary.

## The whole list

Why do people push back on AI in their tools? There's a lack of trust in AI
products. There's the energy use around it. And there's a general feeling
that it's being put in everyone's face when it just doesn't need to be.

I spend time on Reddit, and the general sentiment there is that AI is being
stuffed into everything, whether it's necessary to the product or not.
Everyone's trying to force this AI-native flow, and not everything needs it.

And I build an AI-native Git client.

## What the switch actually does

GitDesktop's settings have a toggle under General called "Hide AI features."
Turn it on and the AI is gone. The generate buttons leave the commit box and
the pull request dialogs. Whole settings sections disappear. The user guide
drops its AI chapters. The Agent tab's code never even loads.

Underneath the toggle there's a rule: GitDesktop never calls AI on its own,
without you explicitly invoking a feature. That's very important. The
closest thing to an exception is automations — rules you write yourself
that can, say, review a pull request when it opens. Those run without a
fresh click, but only because you wrote the rule.

And when you do ask, the model is your choice — your own API key, or a
local Ollama where the calls never leave your machine. Even
[this website](/) has the switch: a "Just Git" view that hides the AI
features from the pitch.

## The Git client that's left

So what's left when you turn it all off? A whole lot. This is a
full-featured Git client, and even without the AI-native side it lets you
do far more than any other client currently on the market. What I'd
highlight first is not having to jump back and forth between your Git
client and GitHub.

You can open, view, and completely manage [pull requests](/#pull-requests)
from your local Git client. The same thing applies for issues and
discussions. Go further and you can handle your tags and releases, or your
[repository insights](/integrations/). And further still:
[local branch protection](/features/) — the kind of branch rules GitHub
doesn't offer on a private repository unless you're on a paid plan. Here
they work offline, on any repository.

It still stays true to the name, **the whole loop, one window**: your whole
development workflow, all within one application.

## Not everything needs it

I don't keep AI out of my own workflow. But that's my workflow. Not
everything needs it, and not everyone wants it. They should have that
agency, that option. So it's one checkbox, first thing under General.
