import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useCommitAvatarUrl } from "@/lib/git/commit-avatar";
import { cn } from "@/lib/utils";

/**
 * A commit author's avatar for the History surfaces (log list, commit detail,
 * file history). Derives the image from the author email (GitHub no-reply login
 * or Gravatar — see `commit-avatar.ts`) and falls back to the author's initial,
 * so an author with no resolvable avatar looks exactly like the initials
 * placeholder that preceded this. Mirrors `ForgeUserAvatar`'s fallback chain.
 */
export function CommitAuthorAvatar({
  name,
  email,
  size = "sm",
  className,
}: {
  name: string;
  email: string;
  size?: "sm" | "default" | "lg";
  className?: string;
}) {
  const src = useCommitAvatarUrl(email);
  return (
    // Decorative: the author name is always shown as adjacent text, so hide the
    // whole avatar (image OR initial fallback) from assistive tech — otherwise a
    // screen reader announces the fallback letter before the name ("A, Alice").
    <Avatar aria-hidden size={size} className={cn("shrink-0", className)}>
      {src && <AvatarImage src={src} alt="" />}
      <AvatarFallback>{(name || "?").charAt(0).toUpperCase()}</AvatarFallback>
    </Avatar>
  );
}
