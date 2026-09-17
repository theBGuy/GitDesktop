// Barrel for the git queries package. `export *` over core plus every domain module
// keeps the import path and the public symbol set identical to the single-file module
// this replaced. internal.ts is intentionally absent — see its header.

export * from "./accounts";
export * from "./branches";
export * from "./commit-ops";
export * from "./compare";
export * from "./config";
export * from "./core";
export * from "./discussions";
export * from "./forge-repos";
export * from "./git-hooks";
export * from "./history";
export * from "./insights";
export * from "./issues";
export * from "./pr-actions";
export * from "./pr-resolve";
export * from "./pr-write";
export * from "./projects";
export * from "./prs";
export * from "./remotes";
export * from "./repo-access";
export * from "./repo-config";
export * from "./repo-settings";
export * from "./stashes";
export * from "./status";
export * from "./sync";
export * from "./tags-releases";
export * from "./webhooks";
export * from "./workingtree";
export * from "./worktrees";
