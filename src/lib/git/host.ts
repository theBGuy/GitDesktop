import { useUiStore } from "@/lib/stores/ui";
import { useForgeStatus } from "./queries";

/**
 * Whether a host is safe to interpolate into a copyable `gh`/`glab auth …` command —
 * the same ASCII grammar `forge_reconnect` validates backend-side (alnum, `.`, `-`, or a
 * bracketed IPv6 literal of hex/`:`/`.` carrying at least one `:`, plus an optional
 * numeric port). The port belongs in the grammar: a self-hosted instance on a
 * non-default port registers with the CLIs as `host:8443`, so rejecting it would deny
 * the copyable fallback to the very users who need it. A crafted remote can carry `;`,
 * `$`, or a space through the URL parse; the executed reconnect flow re-validates, but
 * the command string is guarded here so it can never hand the user shell syntax. This
 * must stay byte-equivalent to Rust's `is_safe_authority` — a charset gate, not an IPv6
 * validator, so `[:]` passes both sides and that's fine; only drift between them matters.
 */
export function isReconnectHostSafe(host: string): boolean {
  return /^([a-zA-Z0-9.-]+|\[[0-9a-fA-F.]*:[0-9a-fA-F:.]*\])(:\d{1,5})?$/.test(
    host,
  );
}

/**
 * A host spelled for a copy-pasteable command. A bracketed IPv6 literal is quoted:
 * zsh (the macOS default) and fish read `[…]` as a glob character class, so with
 * `nomatch` on the pasted command dies with "no matches found". Bare hosts stay
 * unquoted — cmd.exe passes single quotes through literally, which would break the
 * common case. No escaping is needed: {@link isReconnectHostSafe} has already banned
 * `'` from every host that reaches a command string.
 */
export function reconnectHostArg(host: string): string {
  return host.includes("[") ? `'${host}'` : host;
}

/**
 * The hosting host of the open repo — "github.com" or an Enterprise server like
 * "github.acme.com" — defaulting to github.com until it's known. Lets avatar
 * URLs, profile links, and gh-command hints resolve on the right host without
 * threading the host through every component. Reads the provider-neutral
 * `forge_status`, which carries the same host gh reports for a GitHub repo.
 */
export function useActiveGhHost(): string {
  const repoPath = useUiStore((s) => s.repoPath);
  const forge = useForgeStatus(repoPath ?? "");
  return forge.data?.host ?? "github.com";
}

/**
 * The GitHub host to derive login-based avatars from for a given repo, or `null`
 * when the repo isn't a GitHub one. GitHub serves avatars at `<host>/<login>.png`,
 * so a login is enough there; GitLab/Bitbucket have no login-derivable avatar URL,
 * so their users must carry a real `avatarUrl` (returning `null` here makes the
 * avatar fall back to the initial rather than a wrong github.com URL). Used by the
 * reviewer/assignee pickers and any `ForgeUserRef` avatar surface.
 */
export function useForgeGhHost(repoPath: string): string | null {
  const forge = useForgeStatus(repoPath);
  return forge.data?.provider === "github"
    ? forge.data.host || "github.com"
    : null;
}

/** Like {@link useForgeGhHost} but for the currently-open repo (the ui-store
 *  `repoPath`) — for surfaces like `AuthorAvatar` that carry only a login, not a
 *  repo path. `null` off GitHub so a login-derived avatar is only attempted where it
 *  resolves. */
export function useActiveForgeGhHost(): string | null {
  const repoPath = useUiStore((s) => s.repoPath);
  const forge = useForgeStatus(repoPath ?? "");
  return forge.data?.provider === "github"
    ? forge.data.host || "github.com"
    : null;
}
