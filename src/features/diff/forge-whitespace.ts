// The whitespace mode for a forge-patch diff: the copy, the proof that two
// file versions are the forge patch's own, and the reducer that picks what a
// slot draws. Its runtime imports are relative .ts ones only, so
// scripts/forge-whitespace.test.mjs loads it under Node's type stripping.
import type { FileBytes } from "../../lib/git/api/workingtree.ts";
import { diffLines } from "../../lib/git/diff-split.ts";
import type { FileDiff } from "../../lib/git/types/workingtree.ts";
import { hasHunk } from "../../lib/git/whitespace-diff.ts";
import { hunksMatchContent } from "./hunk-match.ts";

/** Why one file keeps showing whitespace changes while the setting hides them. */
export type WhitespaceShownKind =
  | "incomparable"
  | "tooLarge"
  | "mismatch"
  | "offline";

export const WHITESPACE_SHOWN_REASON: Record<WhitespaceShownKind, string> = {
  incomparable: "its two versions couldn't be compared",
  tooLarge: "it is over the size limit",
  mismatch: "its two versions don't match this diff",
  offline: "you're offline",
};

export const WHITESPACE_SHOWN_NOTE = (kind: WhitespaceShownKind): string =>
  `Whitespace changes are shown in this file: ${WHITESPACE_SHOWN_REASON[kind]}.`;

/** The revs a slot's two versions are read at. `paused`: the forge read that
 *  names them is parked offline with no answer; `none`: it settled with none. */
export type WhitespaceRevs =
  | { state: "pending" }
  | { state: "paused" }
  | { state: "none" }
  | {
      state: "ready";
      oldRev: string | undefined;
      newRev: string;
      /** `contentSourceKey` of the reads' source. */
      sourceKey: string;
    };

/** One version's read. `absent`: the side has no rev (added / deleted).
 *  `pending`: a first read in flight. `failed`: it errored, or it is enabled
 *  and neither in flight, parked nor answered (a rev the reader refuses). */
export type WhitespaceSide =
  | { kind: "absent" }
  | { kind: "pending" }
  | { kind: "paused" }
  | { kind: "failed" }
  | { kind: "ready"; bytes: FileBytes | null };

/** A read as the hook sees it; `firstRead` is the roster's first-read pend. */
export function whitespaceSide(
  rev: string | undefined,
  read: {
    data: FileBytes | null | undefined;
    firstRead: boolean;
    paused: boolean;
  },
): WhitespaceSide {
  if (rev === undefined) return { kind: "absent" };
  if (read.data !== undefined) return { kind: "ready", bytes: read.data };
  if (read.paused) return { kind: "paused" };
  if (read.firstRead) return { kind: "pending" };
  return { kind: "failed" };
}

/** The `-w` read: `ready` carries the reads' identity it was asked under. */
export type WhitespaceHunksRead =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "failed" }
  | { kind: "ready"; readsKey: string; hunks: string; isBinary: boolean };

/** The `-w` query as the reducer reads it (`wanted`: the query is enabled);
 *  a failed read that refetches stays failed. */
export function whitespaceHunksRead(
  wanted: boolean,
  readsKey: string | null,
  q: {
    data: { hunks: string; isBinary: boolean } | undefined;
    isError: boolean;
    errorUpdateCount: number;
  },
): WhitespaceHunksRead {
  if (!wanted || readsKey === null) return { kind: "idle" };
  if (q.data !== undefined)
    return {
      kind: "ready",
      readsKey,
      hunks: q.data.hunks,
      isBinary: q.data.isBinary,
    };
  if (q.isError || q.errorUpdateCount > 0) return { kind: "failed" };
  return { kind: "pending" };
}

/** The identity of a pair of reads: repo, source and both revs and paths, the
 *  elements `prWhitespaceHunksOptions` keys on. */
export function whitespaceReadsKey(r: {
  repo: string;
  sourceKey: string;
  oldRev: string | undefined;
  oldPath: string;
  newRev: string;
  path: string;
}): string {
  return JSON.stringify([
    r.repo,
    r.sourceKey,
    r.oldRev ?? null,
    r.oldPath,
    r.newRev,
    r.path,
  ]);
}

/** Proof that two versions are the forge patch's own, minted only here. */
export interface WhitespaceProof {
  readonly readsKey: string;
}
const MINTED = new WeakSet<WhitespaceProof>();

/** A side's bytes as a string of one char per byte: "" for an empty side
 *  (null), null for a payload that isn't base64. */
function rawOf(base64: string | null): string | null {
  if (base64 === null) return "";
  try {
    return atob(base64);
  } catch {
    return null;
  }
}

/** A side's text as the patch decodes it, invalid bytes as U+FFFD, with a
 *  leading byte-order mark kept: the `-w` command reads the raw bytes, so a
 *  mark the patch changes must be in the sides, or sides that agree on it
 *  would read as whitespace-only. */
function decodedOf(raw: string): string {
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
}

/** A side's raw lines, split as hunk-match splits its text: a final newline
 *  ends the last line, and CRs stay. A lossy decode never makes or eats a
 *  0x0A byte, so raw line i is the decoded text's line i. */
function rawLines(raw: string): string[] {
  if (raw === "") return [];
  const lines = raw.split("\n");
  if (raw.endsWith("\n")) lines.pop();
  return lines;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Whether the sides' raw bytes say what the patch says where the decoded
 *  texts can't tell: every line the patch leaves unchanged (context lines and
 *  the gaps around hunks) is byte-identical on both sides, CR included, and
 *  each change block's old and new runs differ, terminators included. A
 *  lossy decode maps distinct invalid bytes to one U+FFFD and hunk-match
 *  ignores a line's CR, so without this a raced pair whose change hides there
 *  proves and `-w` over it hides that change. Runs after `hunksMatchContent`,
 *  which has checked the counts and line kinds this walk trusts. */
function rawAgrees(plainText: string, oldRaw: string, newRaw: string): boolean {
  const oldLines = rawLines(oldRaw);
  const newLines = rawLines(newRaw);
  const run = (lines: string[], raw: string, from: number, to: number) => {
    let bytes = "";
    for (let i = from; i < to; i++)
      bytes +=
        i === lines.length - 1 && !raw.endsWith("\n")
          ? lines[i]
          : `${lines[i]}\n`;
    return bytes;
  };
  let oldAt = 0;
  let newAt = 0;
  let oldLeft = 0;
  let newLeft = 0;
  // Where the open change block starts on each side; null outside one.
  let blockOld: number | null = null;
  let blockNew = 0;
  const closeBlock = (): boolean => {
    if (blockOld === null) return true;
    const differ =
      run(oldLines, oldRaw, blockOld, oldAt) !==
      run(newLines, newRaw, blockNew, newAt);
    blockOld = null;
    return differ;
  };
  // The gap up to `oldTo`, which pairs line for line with the new side's.
  const sameGap = (oldTo: number): boolean => {
    for (let k = 0; k < oldTo - oldAt; k++)
      if (oldLines[oldAt + k] !== newLines[newAt + k]) return false;
    return true;
  };
  for (const raw of diffLines(plainText)) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith("\\")) continue;
      // An empty line in a hunk is a blank context line without its space.
      const kind = line === "" ? " " : line[0];
      if (kind === " ") {
        if (!closeBlock() || oldLines[oldAt] !== newLines[newAt]) return false;
        oldAt++;
        newAt++;
        oldLeft--;
        newLeft--;
      } else {
        if (blockOld === null) {
          blockOld = oldAt;
          blockNew = newAt;
        }
        if (kind === "-") {
          oldAt++;
          oldLeft--;
        } else {
          newAt++;
          newLeft--;
        }
      }
      if (oldLeft === 0 && newLeft === 0 && !closeBlock()) return false;
      continue;
    }
    if (!line.startsWith("@@")) continue;
    const m = HUNK_HEADER.exec(line);
    if (!m) return false;
    const oldCount = m[2] === undefined ? 1 : Number(m[2]);
    const newCount = m[4] === undefined ? 1 : Number(m[4]);
    // A zero count names the line before the hunk, so it starts after it.
    const oldFrom = oldCount === 0 ? Number(m[1]) : Number(m[1]) - 1;
    if (!sameGap(oldFrom)) return false;
    newAt = newCount === 0 ? Number(m[3]) : Number(m[3]) - 1;
    oldAt = oldFrom;
    oldLeft = oldCount;
    newLeft = newCount;
  }
  return sameGap(oldLines.length);
}

/** The proof that two versions, as base64 (null: an empty side), are the
 *  forge section's own: a `-w` view of them may replace the section only
 *  behind it. The exact hunk-match guard over their decoded texts, then the
 *  raw-byte check a lossy decode needs (`rawAgrees`). */
export function proveForgeSides(
  readsKey: string,
  plainText: string,
  oldBase64: string | null,
  newBase64: string | null,
): WhitespaceProof | null {
  const oldRaw = rawOf(oldBase64);
  const newRaw = rawOf(newBase64);
  if (oldRaw === null || newRaw === null) return null;
  const match = hunksMatchContent(
    plainText,
    decodedOf(oldRaw),
    decodedOf(newRaw),
    { keepBom: true },
  );
  if (!match || !rawAgrees(plainText, oldRaw, newRaw)) return null;
  const proof: WhitespaceProof = Object.freeze({ readsKey });
  MINTED.add(proof);
  return proof;
}

function provenFor(proof: WhitespaceProof | null, readsKey: string): boolean {
  return proof !== null && MINTED.has(proof) && proof.readsKey === readsKey;
}

/** A side's bytes as the `-w` command takes them: base64, or null for an
 *  empty side. `undefined`: not readable as a version. */
function sidePayload(side: WhitespaceSide): string | null | undefined {
  if (side.kind === "absent") return null;
  if (side.kind !== "ready") return undefined;
  if (side.bytes === null) return null;
  return side.bytes.base64 ?? undefined;
}

/** Everything a slot's view is derived from in one render. */
export interface WhitespaceInputs {
  /** The slot's latch identity: repo + entity + path. */
  identity: string;
  hide: boolean;
  plain: FileDiff | undefined;
  placeholder: boolean;
  revs: WhitespaceRevs;
  /** `whitespaceReadsKey` of the ready revs; null otherwise. */
  readsKey: string | null;
  oldSide: WhitespaceSide;
  newSide: WhitespaceSide;
  /** Per-side byte budget. */
  budget: number;
  proof: WhitespaceProof | null;
  hunks: WhitespaceHunksRead;
  /** An editor is open under the slot's diff root. */
  editorOpen: boolean;
}

/** What the slot hands `DiffContent`. */
export interface WhitespaceView {
  data: FileDiff | undefined;
  pending: boolean;
  note: string | null;
}

/** The view last handed down, with the identity and forge text it was for. */
export interface WhitespaceShown {
  identity: string;
  plainText: string;
  data: FileDiff;
  note: string | null;
}

/** `shown`: the view on screen. Its identity is the one identity painted, so
 *  a slot re-targeted to another record starts as never painted, and a head
 *  move within one record keeps it. */
export interface WhitespaceState {
  shown: WhitespaceShown | null;
}

export const WHITESPACE_INITIAL: WhitespaceState = { shown: null };

const stamped = (plain: FileDiff): FileDiff => ({
  ...plain,
  whitespaceHidden: false,
});

/** The forge section's header for a `-w` text: up to its first hunk, or, with
 *  no hunk left, up to its first `--- ` line, so a header-only arm still reads
 *  a rename's From / To. */
function forgeHeader(text: string, hunks: string): string {
  // The offset of the first line starting with `prefix`, or -1 for none: a
  // section may open on its first hunk.
  const lineAt = (prefix: string) => {
    if (text.startsWith(prefix)) return 0;
    const at = text.indexOf(`\n${prefix}`);
    return at < 0 ? -1 : at + 1;
  };
  const hunk = lineAt("@@ ");
  const end = hunk >= 0 ? hunk : text.length;
  if (hunks !== "") return text.slice(0, end);
  const dashes = lineAt("--- ");
  return text.slice(0, dashes >= 0 && dashes < end ? dashes : end);
}

/** The bytes a base64 payload decodes to, read from its length and padding
 *  alone: exact for a well-formed payload. Every size gate that judges a
 *  whole-file read without decoding it reads this one. */
export function base64Bytes(b64: string | null | undefined): number {
  if (!b64) return 0;
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

/** Whether a side is over `budget`, judged from its sizes without decoding
 *  it, so an oversized version is refused before any decode or proof runs. */
function overBudget(side: WhitespaceSide, budget: number): boolean {
  if (side.kind !== "ready" || side.bytes === null) return false;
  const { tooLarge, size, base64 } = side.bytes;
  return tooLarge || (size ?? 0) > budget || base64Bytes(base64) > budget;
}

/** Either side is over `budget`: the hook skips decoding and the proof. */
export function sidesOverBudget(
  oldSide: WhitespaceSide,
  newSide: WhitespaceSide,
  budget: number,
): boolean {
  return overBudget(oldSide, budget) || overBudget(newSide, budget);
}

/** The kind a set of reads falls back to, or null while one is still owed. */
function fallbackKind(
  i: WhitespaceInputs,
): WhitespaceShownKind | "wait" | "go" {
  const sides = [i.oldSide, i.newSide];
  if (sidesOverBudget(i.oldSide, i.newSide, i.budget)) return "tooLarge";
  if (sides.some((s) => s.kind === "failed")) return "incomparable";
  if (sides.some((s) => s.kind === "ready" && sidePayload(s) === undefined))
    return "incomparable";
  if (sides.some((s) => s.kind === "paused")) return "offline";
  if (sides.some((s) => s.kind === "pending")) return "wait";
  if (sidePayload(i.oldSide) === null && sidePayload(i.newSide) === null)
    return "incomparable";
  return "go";
}

/** The two sides' payloads once both are usable versions. */
export function whitespaceSides(
  oldSide: WhitespaceSide,
  newSide: WhitespaceSide,
): { old: string | null; new: string | null } | null {
  const o = sidePayload(oldSide);
  const n = sidePayload(newSide);
  return o === undefined || n === undefined ? null : { old: o, new: n };
}

/** Whether the `-w` command may run for these inputs: proven, both sides
 *  usable and in budget, no fallback owed. */
export function whitespaceCommandWanted(i: WhitespaceInputs): boolean {
  return (
    wantsReads(i.hide, i.plain, i.placeholder) &&
    i.revs.state === "ready" &&
    i.readsKey !== null &&
    fallbackKind(i) === "go" &&
    provenFor(i.proof, i.readsKey)
  );
}

/** Whether a slot reads its two versions at all (rules 1 and 2). */
export function wantsReads(
  hide: boolean,
  plain: FileDiff | undefined,
  placeholder: boolean,
): boolean {
  return (
    hide &&
    plain !== undefined &&
    !plain.isBinary &&
    hasHunk(plain.text) &&
    !placeholder
  );
}

type Candidate = WhitespaceView | "inFlight";

function candidate(i: WhitespaceInputs, plain: FileDiff): Candidate {
  const fallback = (kind: WhitespaceShownKind): WhitespaceView => ({
    data: stamped(plain),
    pending: false,
    note: WHITESPACE_SHOWN_NOTE(kind),
  });
  if (i.revs.state === "paused") return fallback("offline");
  if (i.revs.state === "none") return fallback("incomparable");
  if (i.revs.state === "pending" || i.readsKey === null) return "inFlight";
  const kind = fallbackKind(i);
  if (kind === "wait") return "inFlight";
  if (kind !== "go") return fallback(kind);
  if (!provenFor(i.proof, i.readsKey)) return fallback("mismatch");
  const h = i.hunks;
  if (h.kind === "idle" || h.kind === "pending") return "inFlight";
  if (h.kind === "failed") return fallback("incomparable");
  if (h.readsKey !== i.readsKey) return fallback("mismatch");
  if (h.isBinary) return fallback("incomparable");
  return {
    data: {
      ...plain,
      text: forgeHeader(plain.text, h.hunks) + h.hunks,
      whitespaceHidden: true,
      whitespaceOnly: h.hunks === "",
    },
    pending: false,
    note: null,
  };
}

const sameView = (a: WhitespaceShown, data: FileDiff, note: string | null) =>
  a.data.text === data.text &&
  a.data.whitespaceHidden === data.whitespaceHidden &&
  a.data.whitespaceOnly === data.whitespaceOnly &&
  a.data.filePath === data.filePath &&
  a.note === note;

/** Rules 1-8: the next state and the view a slot draws. */
export function reduceForgeWhitespace(
  state: WhitespaceState,
  i: WhitespaceInputs,
): { state: WhitespaceState; view: WhitespaceView } {
  const plain = i.plain;
  if (plain === undefined)
    return { state, view: { data: undefined, pending: false, note: null } };
  const shown = state.shown;
  const painted = shown !== null && shown.identity === i.identity;
  // The view on screen, when it was derived from this very forge text.
  const sameText = painted && shown.plainText === plain.text ? shown : null;
  let next: Candidate;
  if (!i.hide || plain.isBinary || !hasHunk(plain.text))
    next = { data: stamped(plain), pending: false, note: null };
  else if (i.placeholder)
    next = sameText
      ? { data: sameText.data, pending: false, note: sameText.note }
      : { data: stamped(plain), pending: false, note: null };
  else next = candidate(i, plain);
  if (next === "inFlight") {
    if (!painted)
      return { state, view: { data: undefined, pending: true, note: null } };
    next = sameText
      ? { data: sameText.data, pending: false, note: sameText.note }
      : { data: stamped(plain), pending: false, note: null };
  }
  const data = next.data as FileDiff;
  // A replacement of the view for the same forge text waits while an editor
  // is open in the diff; a changed forge text is never held.
  if (sameText !== null && i.editorOpen && !sameView(sameText, data, next.note))
    return {
      state,
      view: { data: sameText.data, pending: false, note: sameText.note },
    };
  if (
    shown !== null &&
    painted &&
    shown.plainText === plain.text &&
    sameView(shown, data, next.note)
  )
    return {
      state,
      view: { data: shown.data, pending: false, note: shown.note },
    };
  // A placeholder's text is another record's: painting it never marks this
  // identity painted, so the record's own text still waits for its view.
  if (i.placeholder && !painted)
    return { state, view: { data, pending: false, note: next.note } };
  return {
    state: {
      shown: {
        identity: i.identity,
        plainText: plain.text,
        data,
        note: next.note,
      },
    },
    view: { data, pending: false, note: next.note },
  };
}
