---
layout: ../layouts/LegalLayout.astro
title: "Privacy Policy — GitDesktop"
description: "The limited, anonymous data GitDesktop collects, what the gitdesktop.app website measures, the third-party services your activity can reach, and your choices."
---

# Privacy Policy

_Last updated: 2026-07-25_

GitDesktop is a desktop Git client. This policy explains the limited, anonymous
data it collects to improve the app, the third-party services your activity can
reach, what the gitdesktop.app website measures, and your choices. It is not
legal advice.

## Who we are

GitDesktop's maintainer, theBGuy ("we"), is the data controller for the analytics described here.
Contact: thebguy.github@gmail.com.

## What we collect

GitDesktop is built to **never** collect your code, file contents, file names,
repository paths, branch names, commit message text, secrets, or environment
variables. It does not read or transmit the contents of your repositories to us.

When usage analytics is enabled (see Your choices and rights), we collect:

- **Anonymous usage events** — content-free signals such as which screen you
  viewed, that a commit or pull request was created (counts and booleans only,
  no text), and which features were used.
- **Crash / error reports** — the error type and a scrubbed, length-capped
  message, with absolute paths and secret-shaped strings redacted.
- **A random device identifier** — a UUID generated on your device. It is not
  linked to your name, email, GitHub account, or any personal identifier.
- **Technical metadata** added by our processor, including your **IP address**
  (used for coarse, country-level context and abuse prevention) and the app
  version.

When **session recording** is enabled (off by default — opt-in), we additionally
collect a recording of your interactions in which **all text is masked** and the
diff viewer, file content, blame view, AI review output, and text editors are
**fully blocked** (recorded as blank regions). Recordings are designed so they
never reveal the content you are working on.

We do **not** build user profiles and do **not** capture network request
contents.

## How we use it and our legal basis

We use this data solely to understand usage and fix problems, in order to improve
GitDesktop. Our legal basis is our **legitimate interest** in improving the
product for anonymous usage analytics, and your **consent** for session recording
(which is why it is off until you opt in).

## Analytics processor

We use **PostHog** as our analytics processor. Data is stored in PostHog's **EU**
region under a Data Processing Agreement.

## Third-party services your activity reaches

Some features connect directly to services you choose. These receive data under
their own privacy policies, not ours:

- **GitHub.** All GitHub features — pull requests, issues, Actions, releases, and
  so on — run through the GitHub CLI (`gh`) using your own GitHub authentication;
  the corresponding API requests, and your IP address, reach GitHub. Update
  checks and downloads are fetched from GitHub Releases.
- **AI providers (only if you enable AI features).** When you use an AI feature,
  GitDesktop sends the context needed for that action — for example a diff or an
  issue's text — to the AI provider you have configured (such as Anthropic,
  OpenAI, or OpenRouter). With a local **Ollama** model or the local **Claude
  Code / Codex CLI** agents, this stays on your machine. We never receive or
  store this content; it is governed by your chosen provider's terms.

## The gitdesktop.app website

This site is static. It has no accounts, sets no cookies, and runs no
advertising or cross-site tracking.

<!-- Web Analytics is enabled account-side (Cloudflare dashboard → Web
     Analytics, "Automatic setup" on the proxied zone). It is EDGE-derived: no
     beacon script is injected into the served HTML, which is what keeps the
     "no other third-party scripts" claim below literally true. If collection
     is ever switched to beacon-based, update both claims. -->

- **Traffic measurement.** The site uses **Cloudflare Web Analytics** —
  cookie-free, aggregate measurement (page views, referrers, performance
  timings) with no cookies, no client-side state, and no cross-site profiles.
  It is processed by Cloudflare under
  [Cloudflare's privacy policy](https://www.cloudflare.com/privacypolicy/).
- **Hosting.** The site is served by Cloudflare Pages; like any host, Cloudflare
  processes standard request data (your IP address, user agent) to deliver the
  pages.
- **Release lookups.** The homepage and download page ask GitHub's public API
  for the latest release, from your browser, so the version badge and download
  buttons stay current — that request (and your IP) goes to GitHub, and the
  installers themselves download from GitHub Releases.

Fonts and every other asset are served from gitdesktop.app itself — there are no
other third-party scripts or embeds.

## Retention

Analytics data is retained for **12 months**, after which it is deleted or
further anonymized.

## Your choices and rights

- **Opt out of analytics** at any time in **Settings → General** ("Send anonymous
  usage data").
- **Session recording is off by default** ("Allow masked session recordings");
  enable it only if you choose to.
- **Reset your identifier** with **"Reset analytics identity"** in Settings, so
  future data can't be linked to past data.
- You may request access to or deletion of the data associated with your device
  identifier by emailing thebguy.github@gmail.com. Because the data is anonymous,
  we may need that device identifier to locate it.

## Children

GitDesktop is not directed to children under 16.

## Changes

We may update this policy; material changes will be noted in-app or in the
release notes.
