// Source pins read a file's live code: block and line comments are stripped
// first, so commented-out code never counts. Comment markers inside string,
// template or regex literals are not modelled; they can only strip live text,
// so a miss fails the pin rather than passing it.

export const squash = (s: string) => s.replace(/\s+/g, "");

/** The source's lines with comments and all white space removed, for exact
 *  line pins. */
export const liveLines = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .split(/\r?\n/)
    .map(squash);
