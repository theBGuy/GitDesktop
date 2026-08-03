<!--
Thanks for contributing to GitDesktop! Please fill out the sections below.
Keep PRs small and focused — one logical change is easiest to review.
-->

## Summary

<!-- What does this PR do, and why? -->

Closes #

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor / internal change
- [ ] Documentation
- [ ] Chore / tooling

## Screenshots / recording

<!-- Required for UI changes — a screenshot or short screen recording of the new behavior. -->

## AI assistance disclosure

<!--
If you used AI assistance, disclose it here with the extent of the usage (see CONTRIBUTING.md).
Example: "This PR was written primarily by Claude Code." / "I consulted ChatGPT to understand
the codebase but authored the solution manually." Write "None." if no AI was used.
-->

## Checklist

- [ ] PR title follows [Conventional Commits](https://www.conventionalcommits.org/) (e.g. `feat(pulls): ...`).
- [ ] `pnpm lint` passes (Biome).
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` passes (if Rust was touched).
- [ ] Added a `changelog.d/` fragment for any user-facing change (`<added|changed|fixed>-<slug>.md`, human-written — see [`changelog.d/README.md`](../changelog.d/README.md)). Required check: `src/` or `src-tauri/` changes need one, else the `no-changelog` label or `skip-changelog` in the title.
- [ ] New UI supports keyboard navigation and meets WCAG AA; destructive paths confirm clearly.
- [ ] No secrets, tokens, or private paths are committed.
- [ ] Any AI assistance used is disclosed above (or "None.").
