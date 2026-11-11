import { invoke } from "@/lib/tauri/invoke";

/** A staged image as Rust returns it (camelCase wire). */
export interface StagedImage {
  session: string;
  name: string;
  mime: string;
  size: number;
  width: number;
  height: number;
}

/** Stages one image's bytes; a null session mints a new one. */
export function attachmentStage(
  session: string | null,
  nameHint: string | null,
  dataBase64: string,
): Promise<StagedImage> {
  return invoke<StagedImage>("attachment_stage", {
    session,
    nameHint,
    dataBase64,
  });
}

/** Removes staged files (null names: the whole session). Idempotent. */
export function attachmentDiscard(
  session: string,
  names: string[] | null,
): Promise<void> {
  return invoke<void>("attachment_discard", { session, names });
}
