import { FileIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";

export function DiffPlaceholder({
  message,
  // Defaults to a file glyph (the diff cases, where a file is the subject); the
  // detail panes pass their own icon so "Select a pull request" etc. reads in
  // that tab's own vocabulary instead of a generic document.
  icon: Icon = FileIcon,
  // Optional affordance rendered under the message (e.g. a Retry button) so an
  // error state isn't a dead end.
  action,
}: {
  message: string;
  icon?: typeof FileIcon;
  action?: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
      <Icon className="size-8" />
      <p className="text-xs">{message}</p>
      {action}
    </div>
  );
}
