import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { installUpdateWithToast } from "./install";
import { useUpdateCheck } from "./useUpdateCheck";

/**
 * Surfaces a pending update as a persistent, install-on-consent toast. Reads the
 * shared background-polled update query (see {@link useUpdateCheck}), which checks
 * on launch and roughly every six hours while the app stays open, so a release
 * published mid-session is noticed without a restart. The toast fires at most once
 * per newly discovered version: a re-poll finding the same pending version does not
 * re-nag, but a newer version published on top of it toasts again. Failures
 * (offline, no release yet, endpoint not configured) stay quiet — the query does
 * not retry and raises no error UI. Never auto-installs. Mount once at app root.
 */
export function UpdateChecker() {
  const update = useUpdateCheck().data;
  const notifiedVersion = useRef<string | null>(null);

  useEffect(() => {
    if (!update || notifiedVersion.current === update.version) return;
    notifiedVersion.current = update.version;
    const id = toast(`Update available: v${update.version}`, {
      description: "A new version of GitDesktop is ready to install.",
      duration: Number.POSITIVE_INFINITY,
      action: {
        label: "Install & restart",
        onClick: (event) => {
          // Kept until the install proceeds: a declined confirm leaves the offer
          // up, since this version is never toasted again.
          event.preventDefault();
          void installUpdateWithToast(update, () => toast.dismiss(id));
        },
      },
    });
  }, [update]);

  return null;
}
