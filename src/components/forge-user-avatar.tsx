import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import type { ForgeUserRef } from "@/lib/git/types";
import { cn } from "@/lib/utils";

/**
 * The canonical forge-user avatar for picker rows, chips, and read-only lists
 * (reviewers, assignees, collaborators, members, conversation authors). GitLab and
 * Bitbucket supply a real `avatarUrl`, so we use it directly; GitHub doesn't (its
 * user `id`/login IS the handle, and GitHub serves avatars at `<host>/<login>.png`),
 * so we derive it there — pass `ghHost` from `useForgeGhHost(repoPath)` (or the
 * active-repo hooks), which is `null` off GitHub. With neither — no URL and off
 * GitHub — the Avatar primitive falls back to the initial, keeping every provider
 * consistent. This is the single home for the user-avatar initials fallback.
 *
 * Callers with a full `ForgeUserRef` pass `user`; callers with a bare login (plus an
 * optional real avatar URL) pass `login`/`avatarUrl`.
 */
export function ForgeUserAvatar({
  user,
  login,
  avatarUrl,
  ghHost = null,
  size = "sm",
  className,
  decorative = false,
}: {
  /** A full forge user reference (id + label + avatarUrl). */
  user?: ForgeUserRef;
  /** A bare login, when the caller has no `ForgeUserRef`. Ignored if `user` is set. */
  login?: string;
  /** The provider's real avatar URL, when known and no `user` is passed. */
  avatarUrl?: string;
  /** GitHub host for login-derived avatars; `null`/omitted off GitHub. */
  ghHost?: string | null;
  size?: "sm" | "default" | "lg";
  className?: string;
  /** Hide the whole avatar from assistive tech when the login is shown as adjacent
   *  text — otherwise a screen reader announces the fallback letter before the name. */
  decorative?: boolean;
}) {
  // Normalize the two calling shapes into a single handle + label + real URL.
  const handle = user?.id ?? login ?? "";
  const label = user?.label ?? login ?? "";
  const realUrl = user?.avatarUrl ?? avatarUrl ?? "";
  const src = realUrl || (ghHost ? `https://${ghHost}/${handle}.png?size=48` : "");
  return (
    <Avatar
      aria-hidden={decorative || undefined}
      size={size}
      className={cn("shrink-0", className)}
    >
      {src && <AvatarImage src={src} alt={decorative ? "" : label} />}
      <AvatarFallback>{(label || "?").charAt(0).toUpperCase()}</AvatarFallback>
    </Avatar>
  );
}
