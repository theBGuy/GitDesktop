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
 *  Never rejects by design: every refusal and failure resolves as an
 *  `unavailable` kind (a rejection means the IPC itself failed). Named in the
 *  `gh` family on purpose: the networkMode guard reads `get…`/`read…`/`load…`
 *  callees as local reads. */
export const ghHostedImage = (repoPath: string, url: string) =>
  invoke<HostedImage>("github_hosted_image", { repoPath, url });
