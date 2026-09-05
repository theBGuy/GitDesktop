import { isWindows } from "@/lib/hotkeys/binding";

/** Reserved DOS device stems. A frontend copy of the backend's
 *  `is_reserved_device_name` (src-tauri/src/fsops.rs) — the two must not drift.
 *  Only a single COM/LPT ordinal 1–9 is a device, as an ASCII digit or a
 *  Latin-1 superscript; without the `u` flag `i` folds ASCII alone, matching the
 *  Rust side's `to_ascii_uppercase`. */
const RESERVED_STEM = /^(?:con|prn|aux|nul|(?:com|lpt)[1-9¹²³])$/i;

/**
 * The final segment of `path` when Windows resolves it to a device rather than
 * a file, else null. `git add` reads the device and dies, so such a file can
 * never be staged — callers explain rather than offer the action.
 *
 * `path` is a repo-relative git path ("/"-separated); only its last segment
 * decides. Always null off Windows, where these are ordinary stageable files.
 */
export function reservedDeviceName(path: string): string | null {
  if (!isWindows) return null;
  const name = path.slice(path.lastIndexOf("/") + 1);
  // Win32 strips trailing dots and spaces off a final component, so `nul.txt`
  // and `nul ` are the device too: the stem is everything before the first dot,
  // trailing spaces trimmed.
  const stem = name.split(".")[0].replace(/ +$/, "");
  return RESERVED_STEM.test(stem) ? name : null;
}
