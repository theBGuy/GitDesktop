import { invoke } from "@/lib/tauri/invoke";

/** Whether container isolation for agent sessions is usable on this machine. */
export interface ContainerStatus {
  /** "docker" | "podman", or null if neither is installed. */
  runtime: "docker" | "podman" | null;
  /** The runtime is installed AND its engine is reachable. */
  ready: boolean;
  /** The managed agent image has been built (any config). */
  imagePresent: boolean;
  /** The built image matches the current Node version + providers; `false` while
   *  `imagePresent` is true means a rebuild is needed to apply the change. */
  imageMatches: boolean;
  /** The built image holds an opencode older than this build installs (a rebuild
   *  is needed to run opencode in a container); `false` when the label is unread. */
  opencodeOutdated: boolean;
}

/** The composer's isolation caveat when `opencodeOutdated` and the session runs opencode. */
export const OPENCODE_IMAGE_OUTDATED_NOTE =
  "The agent image holds an older opencode. Rebuild it in Settings to run opencode in a container (about 1 GB more to download).";

/** Settings' image row when `opencodeOutdated` and opencode is among the image agents;
 *  it replaces the generic "doesn't match" row, since one rebuild fixes both. */
export const OPENCODE_IMAGE_OUTDATED_DETAIL =
  "The built image holds an older opencode. Rebuild to run opencode sessions in a container; the rebuild downloads about 1 GB more.";

/** Detects Docker/Podman availability + whether the agent image (for this Node
 *  version + provider set) needs building or rebuilding. */
export const detectContainerSandbox = (
  nodeVersion: string,
  providers: string[],
) =>
  invoke<ContainerStatus>("agent_container_detect", { nodeVersion, providers });

/** Builds (or, with `force`, rebuilds from scratch — `--no-cache --pull`, to pick
 *  up newer CLI/Node releases) the managed agent image for the given config. */
export const prepareContainerSandbox = (
  nodeVersion: string,
  providers: string[],
  force: boolean,
) => invoke<void>("agent_container_prepare", { nodeVersion, providers, force });

/** Removes a session's container claude-home + any lingering container. */
export const cleanupContainerSandbox = (sessionId: string) =>
  invoke<void>("agent_sandbox_cleanup", { sessionId });

/** The state of a repo's per-repo custom agent image, built from its
 *  `.gitdesktop/agent.Dockerfile` (layered on the managed base). */
export interface CustomImageStatus {
  /** "none" (no Dockerfile), "invalid" (bad FROM), "needsBuild", or "built". */
  state: "none" | "invalid" | "needsBuild" | "built";
  /** The Dockerfile's contents, for the review affordance (present for every state
   *  except "none"). */
  dockerfile: string | null;
  /** Why the Dockerfile was rejected — only set for "invalid". */
  error: string | null;
}

/** Reports whether the active repo ships a `.gitdesktop/agent.Dockerfile` and whether its
 *  derived image is built, invalid, or missing. `none` = the repo uses the base image. */
export const customImageStatus = (worktreePath: string) =>
  invoke<CustomImageStatus>("agent_custom_image_status", { worktreePath });

/** Builds (or, with `force`, rebuilds without cache) a repo's custom agent image from its
 *  `.gitdesktop/agent.Dockerfile`. User-initiated only — the build runs the Dockerfile's
 *  arbitrary commands, so call this only after the user has reviewed the file. Pass the
 *  reviewed contents as `expectedDockerfile`: the backend refuses to build if the file changed
 *  on disk since it was shown, so it only ever builds exactly what the user saw. */
export const buildCustomImage = (
  worktreePath: string,
  expectedDockerfile: string,
  force: boolean,
) =>
  invoke<void>("agent_build_custom_image", {
    worktreePath,
    expectedDockerfile,
    force,
  });

/** Writes a starter `.gitdesktop/agent.Dockerfile` into the repo for the user to edit +
 *  commit (never auto-committed). Resolves `false` without writing if one already exists. */
export const scaffoldCustomDockerfile = (repoPath: string) =>
  invoke<boolean>("agent_scaffold_custom_dockerfile", { repoPath });

/** Opens an interactive shell in a container with the session's worktree mounted,
 *  so a container session can be tested in its matching Linux env. `ports` are the
 *  dev-server ports to publish to the host loopback — each a bare `"5173"` or a
 *  `"host:container"` remap (e.g. `"5174:5173"`) when a host port is busy. Empty =
 *  publish nothing. If a container for this worktree is **already running** (its
 *  terminal was closed without exiting), this reconnects a new shell into it and
 *  `ports` are ignored (they belong to the original run). */
export const openContainerShell = (worktreePath: string, ports: string[]) =>
  invoke<void>("agent_open_container_shell", { worktreePath, ports });

/** Whether this worktree's test-shell container is currently running — so the UI
 *  can offer to reconnect to it or stop it instead of starting a new one. */
export const testContainerRunning = (worktreePath: string) =>
  invoke<boolean>("agent_test_container_running", { worktreePath });

/** Force-stops + removes this worktree's test-shell container, freeing its
 *  published ports. Best-effort (a no-op if it isn't running). */
export const stopTestContainer = (worktreePath: string) =>
  invoke<void>("agent_stop_test_container", { worktreePath });
