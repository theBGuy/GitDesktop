import type { FileBytes } from "@/lib/git/api";
import { invoke } from "@/lib/tauri/invoke";

/** Why the backend returned no bytes for a GitHub-hosted image. A kind only:
 *  the backend never ships a message, so no text can carry a credential. */
export type HostedImageUnavailable =
  | "refused"
  | "signedOut"
  | "missing"
  | "failed";

/** Exactly one field is non-null. `bytes.base64` is set only beside a sniffed
 *  raster `mime`; a refused preview keeps `tooLarge`/`size` as its reason. */
export interface HostedImage {
  bytes: FileBytes | null;
  unavailable: HostedImageUnavailable | null;
}

/** Loads a `user-attachments` image through the user's GitHub CLI sign-in.
 *  Never rejects except for a signal already aborted at call time: every
 *  refusal and failure resolves as an
 *  `unavailable` kind (a rejection means the IPC itself failed). Named in the
 *  `gh` family on purpose: the networkMode guard reads `get…`/`read…`/`load…`
 *  callees as local reads.
 *  An abort while the read is pending withdraws it on the backend once, by its
 *  per-call request id, and still settles with the backend's answer (`failed`
 *  for a withdrawn read); a signal already aborted rejects without invoking. */
export const ghHostedImage = async (
  repoPath: string,
  url: string,
  signal?: AbortSignal,
): Promise<HostedImage> => {
  signal?.throwIfAborted();
  // Never reused, so a backend tombstone can only be adopted by its own read.
  const requestId = crypto.randomUUID();
  const read = invoke<HostedImage>("github_hosted_image", {
    repoPath,
    url,
    requestId,
  });
  if (signal === undefined) return read;
  const withdraw = () => {
    invoke<void>("github_hosted_image_cancel", { requestId }).catch(
      () => undefined,
    );
  };
  signal.addEventListener("abort", withdraw, { once: true });
  try {
    return await read;
  } finally {
    signal.removeEventListener("abort", withdraw);
  }
};
