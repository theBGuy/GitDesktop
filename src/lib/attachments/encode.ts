/** A file's bytes as standard base64, with no `data:` prefix. FileReader reads
 *  and encodes off the main thread, so a large image costs no JS loop; the app's
 *  `invoke` takes JSON only, which rules out a raw-bytes channel. */
export function encodeBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = typeof reader.result === "string" ? reader.result : "";
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () =>
      reject(reader.error ?? new Error("The image couldn't be read."));
    reader.readAsDataURL(file);
  });
}
