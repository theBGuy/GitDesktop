# Product

## Register

product

## Users

Software developers working in a desktop Git client all day, usually alongside an editor and a terminal. They range from devs who prefer a GUI over the git CLI to power users who just want faster review/commit/PR loops. Context: mid-flow on real work — staging changes, switching branches, reviewing diffs and PRs — often with uncommitted state they care about. The job to be done is "move my work through git/GitHub with less friction and better commit/PR/review quality than the CLI or GitHub Desktop give me."

## Product Purpose

GitDesktop is an AI-native Git client: GitHub Desktop-style fundamentals (status, staging, branches, history, diffs, sync) plus first-class AI assistance — generated commit messages, PR titles/descriptions, and code/security review — with a bring-your-own-model setup (Anthropic, OpenAI, Google AI Studio, OpenRouter, local Ollama, Ollama Cloud, any OpenAI-compatible endpoint, plus keyless CLI agents — Claude Code, Codex, GitHub Copilot, opencode). It also covers the full pull-request loop (PRs and issues across GitHub, GitLab, and Bitbucket, plus private local PRs, with issues extending to linked Jira projects) without leaving the app. Success looks like: a developer keeps GitDesktop open all day, trusts it with destructive operations, and ships better-described commits and PRs with less typing.

## Brand Personality

Calm developer tool. Quiet, precise, trustworthy — the work (diffs, branches, PRs) is always the visual focus; the chrome stays out of the way. Three words: **calm, precise, dependable**. Reference feel: Linear's restraint and GitHub Desktop's familiarity, with JetBrains Mono giving it a technical backbone. AI features should feel like a capable assistant built into the workflow, not a spectacle.

## Anti-references

- **GitKraken-style flash**: loud gradients, mascots, gamified visuals, decorative color.
- **Generic AI-SaaS aesthetic**: purple gradients, glassmorphism, gradient text, hero metrics, identical icon-card grids.
- **Enterprise-dense (SourceTree)**: cramped toolbars, dated chrome, every option visible at once.

## Design Principles

1. **The repo is the interface** — diffs, branches, and commits get the space and contrast; app chrome is muted and minimal.
2. **Never surprise on destructive paths** — anything that can lose work (discard, reset, force-push, merge) confirms clearly and offers a way back; state changes always give feedback.
3. **Fast loops over feature tours** — the daily stage→commit→push and review→merge loops take minimal clicks; accelerators (filters, switchers, keyboard) over wizards.
4. **AI is an assistant, not a spectacle** — generated content streams into the same inputs the user would type in; it's editable, attributable, and never blocks the manual path.
5. **One quiet system** — a single restrained palette and component set (shadcn/Base UI) used consistently; emphasis comes from hierarchy and spacing, not new colors per feature.

## Accessibility & Inclusion

WCAG AA: ≥4.5:1 contrast for body text (3:1 for large text), full keyboard operability for primary flows, visible focus indicators, `prefers-reduced-motion` alternatives for any animation, and no meaning conveyed by color alone (diff added/removed states also use +/- markers and position).
