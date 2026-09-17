import { invoke } from "@/lib/tauri/invoke";
import type { PrRef, RemoteLens, StackWriteOutcome } from "../types";

/** Create a merge/pull request (pushes the head branch first). Provider-neutral:
 *  GitHub via `gh pr create`, GitLab via `glab` with a one-shot credential-helper
 *  push and draft mapped to the `Draft:` title prefix. */
export const forgePrCreate = (
  repoPath: string,
  base: string,
  head: string,
  title: string,
  body: string,
  draft: boolean,
  reviewers: string[] | undefined,
  labels: string[] | undefined,
  assignees: string[] | undefined,
  lens: RemoteLens,
) =>
  invoke<PrRef>("forge_pr_create", {
    repoPath,
    base,
    head,
    title,
    body,
    draft,
    // Create-time reviewers are Bitbucket-only; omit (null) for other providers so
    // the backend leaves behavior untouched.
    reviewers: reviewers ?? null,
    // Labels (names) + assignees (login/username strings) are GitHub/GitLab; omit
    // (null) for Bitbucket so the backend leaves behavior untouched.
    labels: labels ?? null,
    assignees: assignees ?? null,
    lens,
  });

/** Edits a PR's title/body, and — when `base` is supplied — retargets it. An
 *  omitted `base` reaches the backend as `None` and leaves the base branch
 *  untouched, so an unchanged picker never sends a retarget the forge could
 *  reject (GitHub refuses to move a stacked PR's base). */
export const forgePrEdit = (
  repoPath: string,
  number: number,
  title: string,
  body: string,
  lens: RemoteLens,
  base?: string,
) =>
  invoke<void>("forge_pr_edit", {
    repoPath,
    number,
    title,
    body,
    lens,
    // Explicit null for "no retarget", the same wire shape every other optional
    // arg here uses — an `undefined` value is dropped by IPC serialization.
    base: base ?? null,
  });

/** Create a stack from `pullRequests` (bottom→top; the forge validates that each
 *  targets the one below it). */
export const forgeStackCreate = (
  repoPath: string,
  pullRequests: number[],
  lens: RemoteLens,
) =>
  invoke<StackWriteOutcome>("forge_stack_create", {
    repoPath,
    pullRequests,
    lens,
  });

/** Append `pullRequests` (bottom→top) to an existing stack. GitHub only appends
 *  on top, so the caller must have checked the attach point is the stack's top. */
export const forgeStackAdd = (
  repoPath: string,
  stackNumber: number,
  pullRequests: number[],
  lens: RemoteLens,
) =>
  invoke<StackWriteOutcome>("forge_stack_add", {
    repoPath,
    stackNumber,
    pullRequests,
    lens,
  });

/** Dissolve a stack: its members stay open on their branches, unstacked. */
export const forgeStackDissolve = (
  repoPath: string,
  stackNumber: number,
  lens: RemoteLens,
) => invoke<void>("forge_stack_dissolve", { repoPath, stackNumber, lens });
