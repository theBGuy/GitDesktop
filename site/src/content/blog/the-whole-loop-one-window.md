---
title: "The whole loop, one window: why I built GitDesktop"
description: "Pull requests that start before you push, branch updates without switching, and guardrails that aren't a pricing tier — the assumptions behind GitDesktop."
pubDate: 2026-07-26
author: theBGuy
pillar: review-loop
tags: ["git", "workflow", "pull-requests"]
---

I've spent years working with Git. Not just using it, but living in it — feature
branches, code reviews, releases, hotfixes, open source, side projects, client
work. The rhythm becomes second nature.

And yet, over time, I noticed something strange. The moment I needed to do
anything beyond committing code, I was expected to leave.

Leave the Git client to create a pull request.

Leave it to review changes.

Leave it to check project traffic.

Leave it to manage branches.

Leave it to use AI.

Leave it to enforce the kinds of guardrails that prevent simple mistakes.

It never felt intentional. It was just... accepted. But the more I thought about
it, the more one question kept coming back: **why am I leaving?**

That question became GitDesktop.

## A calm client I could leave open all day

When I first started planning the project, I wasn't trying to build a better
[GitHub Desktop](/compare/github-desktop/), and I wasn't trying to cram every Git
feature imaginable into one application. The original idea was much simpler. I
wanted a calm Git client I could leave open all day.

Somewhere along the way, that idea became five words that ended up guiding every
feature I built: **the whole loop, one window.**

It wasn't a tagline. It was a design constraint. Every time I wanted to add
something, I asked the same question — does this help me stay in the flow, or
does it send me somewhere else?

## Pull requests shouldn't begin after you push

One of the biggest workflow interruptions for me has always been creating pull
requests. The ritual looked something like this: stage changes, commit, open
GitHub, create a pull request, write the title, write the description, maybe ask
AI to help.

Everything about that process felt disconnected. The repository was already on my
machine. The diffs were already on my machine. The commit history was already on
my machine. So why did the workflow suddenly move into a browser?

When GitHub introduced Copilot-powered pull request generation, I actually
thought it was a great feature. But I already preferred Claude, and I didn't want
to switch assistants depending on where I happened to be working. I wanted the
workflow — not the provider.

That eventually led to one of my favorite features in GitDesktop:
[local pull requests](/#pull-requests). Not because they're technically
interesting, but because they challenge an assumption I don't think we've
questioned enough.

We tend to think a pull request begins the moment we push. I don't. To me,
pushing is the moment a pull request graduates from private work to shared work.
Before that, I'm still thinking. I'm still iterating. I'm still rewriting
descriptions. I'm still asking AI to review something. I'm still cleaning up
commits. I'm still deciding whether it's ready for someone else's time.

Why should any of that require a remote repository?

GitDesktop lets me prepare the entire review locally before deciding to publish
it. Not because GitHub can't review code — because I believe the first reviewer
should always be yourself.

## Branches are no longer just branches

Years ago, switching branches was almost free. Today, a branch is an environment.
Switching branches can restart development servers. Hot module replacement kicks
in. Dependencies change. Generated files change. Environment variables change.
Migrations change.

I've had moments where I switched back to an old feature branch just to update it
and suddenly found hundreds of files appearing as untracked, because
`.gitignore` had changed on another branch. Not because I intended to work there.
Simply because Git required me to visit that branch before updating it.

Another time, I interrupted active development just to pull changes into a
long-running epic. Everything restarted. The application reloaded. The context I
was in disappeared. None of that had anything to do with the work I was actually
trying to accomplish. I just wanted to bring another branch up to date.

So GitDesktop lets me do exactly that: update another branch without leaving the
one I'm currently working in. Not because it's impossible otherwise, but because
switching contexts should be a choice — not a requirement.

## Guardrails shouldn't be a pricing tier

Some of my favorite GitDesktop features exist because of incredibly ordinary
mistakes. I've merge committed directly into development branches because muscle
memory took over. I've deleted the wrong branch after promoting a release. None
of these were knowledge problems. They were human problems.

GitHub has branch protections, and they're great. But many of the protections I
wanted either happen remotely or are tied to higher-tier workflows. That always
felt backwards. The best safety features shouldn't only exist after you've
already pushed your code somewhere, and they shouldn't only exist for large
organizations. Sometimes you just want your tools to stop you from making an
obvious mistake.

[Local branch protection](/features/) came from that belief. Good guardrails
should be available wherever you're working — especially when you're working
alone.

## Monitoring shouldn't require hunting

Another habit I've developed over the years is checking on my projects. Not
because I enjoy dashboards, but because I genuinely like seeing whether people are
using the things I've built. How many visitors showed up today? Where did they
come from? Which repositories are getting attention?

That routine usually meant opening GitHub. Then another repository. Then another.
Then another. Eventually I had several browser tabs open just to answer one
simple question: how are my projects doing?

It felt disconnected. The repositories I cared about were already sitting inside
the Git client I had open all day. Why wasn't that information there too?

[Repository insights](/integrations/) wasn't born out of wanting prettier graphs.
It was born out of wanting the projects I care about to stay close.

## Bring your own workflow

AI accelerated this realization. Every company wants you inside their ecosystem.
Use their assistant. Use their models. Use their workflow.

But developers don't work that way. Some people prefer Claude. Some use OpenAI.
Others run local models. Tomorrow there will be something new. The tool shouldn't
force that decision — it should adapt to it.

The same applies beyond AI. Whether it's GitHub, GitLab, Bitbucket, or something
else, I don't think your development workflow should be dictated by whichever
platform happens to host your repository. Your tools should work with you, not
the other way around.

## Questioning assumptions

As I look back over GitDesktop, I notice something. I wasn't really building
features. I was questioning assumptions.

Why does a pull request require a remote? Why do reviews begin after pushing? Why
do I have to leave my Git client to understand my project? Why should switching
AI models change my workflow? Why should updating another branch interrupt the one
I'm actively working in? Why are some of the best guardrails only available after
code leaves my machine?

Every feature traces back to one of those questions.

## The whole loop, one window

If GitHub Desktop adopted every feature I've built tomorrow, I'd be thrilled for
developers. But I don't think we'd be building the same product — because
GitDesktop isn't defined by local pull requests, branch protection, AI
integration, or repository insights. It's defined by a philosophy.

I believe developer tools should adapt to developers, not ask developers to adapt
to them. I believe the best workflows happen as close to the code as possible.
And I believe every unnecessary context switch is an opportunity to ask a simple
question: do I actually need to leave?

That question has shaped every feature in GitDesktop so far, and I suspect it'll
shape every feature I build next. Because for me, the goal has never been to
build another Git client. It's been to build the one I never have to leave.

---

*A version of this essay first appeared
[on LinkedIn](https://www.linkedin.com/pulse/whole-loop-one-window-evan-goldberg-wbmre/).
If there's a part of your workflow that always makes you think "why do I have to
leave?", I'd genuinely like to hear it.*
