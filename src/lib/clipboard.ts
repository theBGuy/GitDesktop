import { isTauri } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { toast } from "sonner";
import { isWindows } from "@/lib/hotkeys/binding";

export const COPY_FAILED = "Could not copy to clipboard";

/**
 * On Windows inside Tauri the native plugin writes, since WebView2's web
 * clipboard turns each LF into CRLF; a native failure rejects, never falls back
 * to the web API. Everywhere else the web API writes. The plugin and its
 * permission exist on Windows only (src-tauri: the Cargo.toml target table,
 * lib.rs, capabilities/windows-clipboard.json), so widening this branch means
 * widening all three.
 */
export async function writeClipboard(text: string): Promise<void> {
  if (isTauri() && isWindows) {
    await writeText(text);
    return;
  }
  await navigator.clipboard.writeText(text);
}

export async function copyText(
  text: string,
  message = "Copied",
): Promise<boolean> {
  try {
    await writeClipboard(text);
    toast.success(message);
    return true;
  } catch {
    toast.error(COPY_FAILED);
    return false;
  }
}
