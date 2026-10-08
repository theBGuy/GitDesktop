import { toast } from "sonner";
import { confirmDiscardParkedWrites } from "@/lib/parked-writes";
import { toastError } from "@/lib/toast";
import { installUpdate, type Update } from "@/lib/updater";

/**
 * Installs an update behind a live progress toast, then relaunches. Shared by
 * the launch check and the Settings "Check for updates" button so the install
 * UX is identical wherever the user starts it. `onProceed` runs once the install
 * is going ahead, and never when the user declines the parked-writes confirm.
 */
export async function installUpdateWithToast(
  update: Update,
  onProceed?: () => void,
): Promise<void> {
  // Asked before the download: the Windows installer exits the process from
  // inside the install, past any later chance to keep parked writes.
  if (!(await confirmDiscardParkedWrites("update"))) return;
  onProceed?.();
  const id = toast.loading(`Downloading v${update.version}…`);
  try {
    await installUpdate(update, ({ downloaded, total }) => {
      const pct = total ? Math.round((downloaded / total) * 100) : null;
      toast.loading(
        pct !== null
          ? `Downloading v${update.version}… ${pct}%`
          : `Downloading v${update.version}…`,
        { id },
      );
    });
    // relaunch() restarts the app, so this rarely shows.
    toast.success("Update installed — restarting…", { id });
  } catch (e) {
    toast.dismiss(id);
    toastError(e);
  }
}
