import { useSyncExternalStore } from "react";
import {
  appAnnouncementSnapshot,
  subscribeAppAnnouncement,
} from "@/lib/app-announce";

const ZWSP = String.fromCharCode(0x200b);

/** The app-level polite live region. Mounted unconditionally and empty until
 *  used, because a live region announces only changes to an element already
 *  present. A zero-width space toggled by the announce seq keeps the
 *  textContent changing when the same text is announced twice. */
export function AppAnnouncer() {
  const { text, seq } = useSyncExternalStore(
    subscribeAppAnnouncement,
    appAnnouncementSnapshot,
  );
  return (
    <span role="status" aria-live="polite" className="sr-only">
      {text}
      {ZWSP.repeat(seq % 2)}
    </span>
  );
}
