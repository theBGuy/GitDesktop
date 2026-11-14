import {
  hashKey,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { hostedAssetHost } from "@/components/markdown/markdown-images";
import { appErrorDetail } from "@/lib/error-summary";
import type { FileBytes } from "@/lib/git/api";
import { seedHostedImage } from "@/lib/hosted-images/queries";
import { errorMessage, isAppError } from "@/lib/tauri/invoke";
import { attachmentDiscard, attachmentStage, type StagedImage } from "./api";
import {
  beginTransition,
  type DraftEntry,
  type DraftStatus,
  endTransition,
  newEntry,
  postCandidates,
  reclaimable,
  type SettleOutcome,
  type StagedRecord,
  settleTransition,
  startGesture,
  withoutRecords,
  withStaged,
} from "./draft-attachments";
import { encodeBase64 } from "./encode";
import {
  type AttachmentRefs,
  type AttachSource,
  isStagedName,
  MAX_IMAGE_BYTES,
  MAX_STAGED_IMAGES,
  referencedNames,
  tooBigRefusal,
} from "./references";

// Staged images live here, keyed by DRAFT KEY (`<surface>|<identity>`), so a
// settle lands by key with no component alive and the optimistic comment,
// rendered outside the editor's tree, can resolve its images through its post
// token. Entries end where the draft text ends, or at the owner sweep (a comment
// view's per surface, Create PR's per host, so a host that never mounts again
// keeps its entry for the session); never on a repo switch, since the key
// already carries the repo.

export type AttachmentSurface =
  | "issue-comment"
  | "pr-comment"
  | "pr-create"
  | "issue-create"
  | "issue-edit"
  | "pr-edit";

/** Whether a surface's landed post keeps its images for the optimistic row.
 *  Creates and edits render no synthetic row, so they hold nothing. */
const HOLDS_POSTED: Record<AttachmentSurface, boolean> = {
  "issue-comment": true,
  "pr-comment": true,
  "pr-create": false,
  "issue-create": false,
  "issue-edit": false,
  "pr-edit": false,
};

export function draftKeyFor(surface: AttachmentSurface, identity: string) {
  return `${surface}|${identity}`;
}

function surfaceOf(draftKey: string): string {
  return draftKey.slice(0, draftKey.indexOf("|"));
}

/** A post's names and the bytes of its files, read once at the post's begin so
 *  the server copy can be seeded into the hosted-image cache. `bytes` fills in
 *  as each file finishes encoding; a name still encoding is simply absent. */
interface PostSeeds {
  names: readonly string[];
  bytes: Map<string, FileBytes>;
}

/** A landed post's images, kept until its thread's data no longer shows them.
 *  Keyed by the post's token, so a later post never overwrites them. */
interface HeldSet {
  owner: object;
  surface: string;
  byName: Map<string, string>;
  urls: Set<string>;
  seeds: PostSeeds | undefined;
}

// Every collection below and where its entries leave:
// - `entries`: an end (endDraftAttachments, the owner sweep), or a settle that
//   ends the draft; a displacement moves a posting entry to `parked`.
// - `parked`: its post's settle, whatever the outcome.
// - `postTokens`, `endedSessions`, `recordFiles`: weak, gone with their gen
//   or record.
// - `postSeeds`: weak; its post's settle moves the seeds onto the held set,
//   which frees them with the held copies.
// - `held`: the thread watcher's release, or the owner sweep.
// - `retired`: added only while its post is in flight; that post's settle
//   removes it on every outcome.
// - `chains`: each tail removes itself once it is the last.
// - `staging`: each stage's own finally.
// - `ownerHosts`: weak, gone with its owner.
// - `listeners`: their unsubscribe.
const entries = new Map<string, DraftEntry>();
/** Posting entries a new owner displaced, by their post's gen: the post's settle
 *  still runs their deferred end, and its images still resolve until then. */
const parked = new Map<object, { draftKey: string; entry: DraftEntry }>();
/** Each post's token, by the gen its begin minted. */
const postTokens = new WeakMap<object, string>();
const held = new Map<string, HeldSet>();
/** In-flight posts whose thread data dropped their row before the settle held
 *  their images: that settle revokes at once instead of holding. */
const retired = new Set<string>();
const listeners = new Set<() => void>();
/** Per-draft serialized chain: stages and the draft's discards, in call order. */
const chains = new Map<string, Promise<unknown>>();
/** The session a stage minted for a draft that ended before it returned, so the
 *  end's queued whole-session discard can still name it. */
const endedSessions = new WeakMap<object, string>();
/** The picked or pasted file behind each record, read only to seed a post. */
const recordFiles = new WeakMap<StagedRecord, Blob>();
/** Each comment post's seeds, by the gen its begin minted. */
const postSeeds = new WeakMap<object, PostSeeds>();
/** Stages in flight per draft key, from the call until its result is known. */
const staging = new Map<string, number>();
/** The host an owner was minted for; its sweep reaches only that host's owners. */
const ownerHosts = new WeakMap<object, string>();

/** A host instance's owner token. With `host`, the surface's sweep from this
 *  owner ends only entries another owner of the same host left behind. */
export function mintAttachmentOwner(host?: string): object {
  const owner = {};
  if (host !== undefined) ownerHosts.set(owner, host);
  return owner;
}

/** How many stages for `draftKey` are still in flight: a post of that draft
 *  holds until none is, so no image lands after the text it belongs to left. */
export function stagesInFlight(draftKey: string): number {
  return staging.get(draftKey) ?? 0;
}

function countStage(draftKey: string, delta: 1 | -1) {
  const next = stagesInFlight(draftKey) + delta;
  if (next > 0) staging.set(draftKey, next);
  else staging.delete(draftKey);
  notify();
}

function notify() {
  for (const listener of listeners) listener();
}

export function subscribeAttachments(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The entry under a key, whoever owns it; callers filter by owner. */
export function draftEntry(draftKey: string): DraftEntry | undefined {
  return entries.get(draftKey);
}

function revokeAll(urls: Iterable<string>) {
  for (const url of urls) URL.revokeObjectURL(url);
}

function enqueue<T>(draftKey: string, task: () => Promise<T>): Promise<T> {
  const run = (chains.get(draftKey) ?? Promise.resolve()).then(task);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(draftKey, tail);
  void tail.then(() => {
    if (chains.get(draftKey) === tail) chains.delete(draftKey);
  });
  return run;
}

function queueDiscard(
  draftKey: string,
  session: string,
  names: string[] | null,
) {
  void enqueue(draftKey, () =>
    attachmentDiscard(session, names).catch(() => undefined),
  );
}

/** The entry this owner holds under the key; a foreign one is ended first, or
 *  parked with its end deferred while its post is in flight. */
function ownEntry(draftKey: string, owner: object): DraftEntry {
  const entry = entries.get(draftKey);
  if (entry?.owner === owner) return entry;
  if (entry && entry.posting.length > 0)
    parked.set(entry.gen, {
      draftKey,
      entry: { ...entry, releaseDeferred: true },
    });
  else if (entry) endDraftAttachments(draftKey);
  const fresh = newEntry(owner);
  entries.set(draftKey, fresh);
  return fresh;
}

function setStatus(
  draftKey: string,
  owner: object,
  status: DraftStatus | null,
) {
  const entry = ownEntry(draftKey, owner);
  entries.set(draftKey, { ...entry, status });
  notify();
}

/** Puts a blocked attach's reason on the draft's status line. */
export function noteAttachBlocked(
  draftKey: string,
  owner: object,
  reason: string,
) {
  setStatus(draftKey, owner, { tone: "info", text: reason, held: true });
}

/** Retires a held attach's reason once the draft's hold is no longer that
 *  reason, so a later hold with the same words never brings it back. */
export function retireHeldNote(
  draftKey: string,
  owner: object,
  reason: string | null,
) {
  const entry = entries.get(draftKey);
  if (entry?.owner !== owner || !entry.status?.held) return;
  if (entry.status.text === reason) return;
  entries.set(draftKey, { ...entry, status: null });
  notify();
}

/** A user edit retires the status line and the partial-failure notice. */
export function noteDraftEdited(draftKey: string, owner: object) {
  const entry = entries.get(draftKey);
  if (entry?.owner !== owner || (!entry.status && !entry.notice)) return;
  entries.set(draftKey, { ...entry, status: null, notice: null });
  notify();
}

/**
 * Starts one attach gesture (one pick, one paste): the status line clears once
 * here, so a refusal for one file survives the files after it. Returns whether
 * the draft is still the one the gesture started on: a Clear, a post or a
 * reseed moves it on, and the rest of the gesture then stages nothing.
 */
export function startAttachGesture(
  draftKey: string,
  owner: object,
): () => boolean {
  const entry = ownEntry(draftKey, owner);
  entries.set(draftKey, startGesture(entry, stagesInFlight(draftKey)));
  notify();
  const { gen } = entry;
  return () => {
    const cur = entries.get(draftKey);
    return cur?.gen === gen && cur.owner === owner;
  };
}

function refusalText(e: unknown): string {
  return isAppError(e) ? appErrorDetail(e.kind, e.message) : errorMessage(e);
}

/**
 * Stages one file into a draft. The image joins the entry only if the draft it
 * started for is still the live one (same gen) and not posting; otherwise its
 * file is discarded and this resolves null. A refusal lands on the started
 * draft's status line.
 */
export async function stageAttachment({
  draftKey,
  owner,
  file,
  source,
  blockedReason,
  text,
}: {
  draftKey: string;
  owner: object;
  file: File;
  source: AttachSource;
  blockedReason: string | null;
  /** The draft's text as it reads right now, or null when the caller can't
   *  read it; a cap reclaim runs only over a text it can read. */
  text?: () => string | null;
}): Promise<StagedImage | null> {
  if (blockedReason !== null) {
    noteAttachBlocked(draftKey, owner, blockedReason);
    return null;
  }
  const hint = source === "picker" ? file.name : null;
  if (file.size > MAX_IMAGE_BYTES) {
    setStatus(draftKey, owner, {
      tone: "warning",
      text: tooBigRefusal(hint, file.size),
    });
    return null;
  }
  // Released before the caller's continuation inserts the reference, which
  // runs in the same task, so no input event lands between the two.
  countStage(draftKey, 1);
  try {
    return await stageCounted(draftKey, owner, file, hint, text);
  } finally {
    countStage(draftKey, -1);
  }
}

/**
 * Frees the cap for one more stage: at MAX_STAGED_IMAGES, the records the text
 * no longer references (fresh ones excepted) are discarded and leave the entry.
 * A failed discard keeps every record in the entry, though Rust tries each name
 * and may have removed some files; Rust's own cap refusal answers.
 */
async function reclaimForStage(
  draftKey: string,
  entry: DraftEntry,
  text: (() => string | null) | undefined,
) {
  const { session } = entry;
  if (session === null || entry.images.length < MAX_STAGED_IMAGES) return;
  if (entry.posting.length > 0) return;
  const body = text?.() ?? null;
  if (body === null) return;
  const live = entry.images.map((i) => i.name);
  const names = reclaimable(entry, referencedNames(body, live));
  if (names.length === 0) return;
  try {
    await attachmentDiscard(session, names);
  } catch {
    return;
  }
  // The files are gone whatever the draft did meanwhile, so their records go
  // from whichever entry still holds that session.
  const cur = entries.get(draftKey);
  if (cur?.session !== session) return;
  const next = withoutRecords(cur, names);
  revokeAll(next.revoke);
  entries.set(draftKey, next.entry);
  notify();
}

async function stageCounted(
  draftKey: string,
  owner: object,
  file: File,
  hint: string | null,
  text: (() => string | null) | undefined,
): Promise<StagedImage | null> {
  const started = ownEntry(draftKey, owner);
  notify();
  const { gen } = started;
  const failOnStarted = (text: string) => {
    const cur = entries.get(draftKey);
    if (cur?.gen !== gen) return;
    entries.set(draftKey, { ...cur, status: { tone: "warning", text } });
    notify();
  };
  let data: string;
  try {
    data = await encodeBase64(file);
  } catch (e) {
    failOnStarted(errorMessage(e));
    return null;
  }
  return enqueue(draftKey, async () => {
    const before = entries.get(draftKey);
    if (before?.gen !== gen) return null;
    await reclaimForStage(draftKey, before, text);
    const live = entries.get(draftKey);
    if (live?.gen !== gen) return null;
    let staged: StagedImage;
    try {
      staged = await attachmentStage(live.session, hint, data);
    } catch (e) {
      failOnStarted(refusalText(e));
      return null;
    }
    const cur = entries.get(draftKey);
    if (cur?.gen !== gen || cur.posting.length > 0) {
      if (cur?.gen !== gen) endedSessions.set(gen, staged.session);
      await attachmentDiscard(staged.session, [staged.name]).catch(
        () => undefined,
      );
      return null;
    }
    const record: StagedRecord = {
      name: staged.name,
      mime: staged.mime,
      size: staged.size,
      width: staged.width,
      height: staged.height,
      url: URL.createObjectURL(file),
    };
    recordFiles.set(record, file);
    const next = withStaged(cur, staged.session, record);
    revokeAll(next.revoke);
    entries.set(draftKey, next.entry);
    notify();
    return staged;
  });
}

/** Ends a draft's attachments: the entry goes, its URLs are revoked and the
 *  session is discarded behind any stage in flight. Deferred to the settle
 *  while a post is in flight. */
export function endDraftAttachments(draftKey: string) {
  const entry = entries.get(draftKey);
  if (!entry) return;
  const result = endTransition(entry);
  if (result.deferred) {
    entries.set(draftKey, result.entry);
    notify();
    return;
  }
  entries.delete(draftKey);
  revokeAll(result.revoke);
  notify();
  const { gen } = entry;
  void enqueue(draftKey, async () => {
    const session = result.session ?? endedSessions.get(gen);
    if (session) await attachmentDiscard(session, null).catch(() => undefined);
  });
}

export interface PostTicket {
  draftKey: string;
  gen: object;
  /** Names this post's images for its optimistic row; never sent to Rust. */
  token: string;
  refs: AttachmentRefs;
}

/** 32 lowercase hex characters from the platform's CSPRNG. */
function mintPostToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Marks the draft posting with the staged names `body` references, in
 *  first-occurrence order; null when it references none. A reclaimed name the
 *  text still references counts, so Rust refuses it. Either way the draft
 *  takes a new gen, so a stage still in flight lands nowhere: its reference was
 *  never in the posted text, and its file is discarded. `seedable` says whether
 *  the post's server copy can show hosted URLs (a GitHub hosted-image source);
 *  only then are its files read for seeds. */
export function beginAttachmentPost(
  draftKey: string,
  body: string,
  seedable: boolean,
): PostTicket | null {
  const entry = entries.get(draftKey);
  if (!entry || entry.posting.length > 0) return null;
  const names =
    entry.session === null ? [] : referencedNames(body, postCandidates(entry));
  const next = beginTransition(entry, names);
  const gen = {};
  entries.set(draftKey, { ...(next ?? entry), gen });
  notify();
  if (next === null || entry.session === null) return null;
  const token = mintPostToken();
  postTokens.set(gen, token);
  if (seedable && HOLDS_POSTED[surfaceOf(draftKey) as AttachmentSurface])
    postSeeds.set(gen, readSeeds(names, entry.images));
  return { draftKey, gen, token, refs: { session: entry.session, names } };
}

/** The raster types the staging grammar allows; a seed carries only these. */
const SEED_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** The hosted loader's raster caps, mirrored from MAX_IMAGE_DIMENSION and
 *  MAX_IMAGE_PIXELS in src-tauri/src/image_sniff.rs (dimensions_within_caps):
 *  a seed the loader would refuse would show until its entry leaves, then turn
 *  into the too-large caption. scripts/hosted-seed-caps.test.mjs keeps the two
 *  equal. */
export const MAX_IMAGE_DIMENSION = 8192;
export const MAX_IMAGE_PIXELS = 40_000_000;

function withinLoaderCaps(width: number, height: number): boolean {
  return (
    width > 0 &&
    height > 0 &&
    width <= MAX_IMAGE_DIMENSION &&
    height <= MAX_IMAGE_DIMENSION &&
    width * height <= MAX_IMAGE_PIXELS
  );
}

/** Starts reading each posted file as base64, off the main thread (FileReader),
 *  so a 10 MiB image never blocks a frame. Mime, size and the staged raster are
 *  the staged record's own (the same header sniff the loader runs). */
function readSeeds(
  names: readonly string[],
  images: readonly StagedRecord[],
): PostSeeds {
  const seeds: PostSeeds = { names: [...names], bytes: new Map() };
  for (const record of images) {
    const file = recordFiles.get(record);
    if (!names.includes(record.name) || file === undefined) continue;
    if (!SEED_MIMES.has(record.mime)) continue;
    if (!withinLoaderCaps(record.width, record.height)) continue;
    void encodeBase64(file).then(
      (base64) => {
        seeds.bytes.set(record.name, {
          base64,
          mime: record.mime,
          tooLarge: false,
          size: record.size,
        });
      },
      () => undefined,
    );
  }
  return seeds;
}

/** Applies a post's outcome to the draft it was begun on, parked or live.
 *  Returns whether failed images stayed attached, so their references belong
 *  back in the draft. */
export function settleAttachmentPost(
  ticket: PostTicket,
  outcome: SettleOutcome,
): boolean {
  const live = entries.get(ticket.draftKey);
  const entry = live?.gen === ticket.gen ? live : parked.get(ticket.gen)?.entry;
  // Consumed on every outcome, so no settled post leaves its token behind.
  const wasRetired = retired.delete(ticket.token);
  const seeds = postSeeds.get(ticket.gen);
  postSeeds.delete(ticket.gen);
  if (entry === undefined) return false;
  const result = settleTransition(entry, ticket.refs.names, outcome);
  if (entry !== live) parked.delete(ticket.gen);
  else if (result.entry === null) entries.delete(ticket.draftKey);
  else entries.set(ticket.draftKey, result.entry);
  const surface = surfaceOf(ticket.draftKey);
  if (HOLDS_POSTED[surface as AttachmentSurface] === true && !wasRetired)
    holdPosted(ticket.token, entry.owner, surface, result.hold, seeds);
  else revokeAll(result.hold.map((i) => i.url));
  revokeAll(result.revoke);
  notify();
  if (entry.session !== null && result.discard !== null)
    queueDiscard(
      ticket.draftKey,
      entry.session,
      result.discard === "session" ? null : result.discard,
    );
  return result.entry !== null && result.entry.notice !== null;
}

function holdPosted(
  token: string,
  owner: object,
  surface: string,
  records: StagedRecord[],
  seeds: PostSeeds | undefined,
) {
  if (records.length === 0) return;
  held.set(token, {
    owner,
    surface,
    byName: new Map(records.map((r) => [r.name, r.url])),
    urls: new Set(records.map((r) => r.url)),
    seeds,
  });
}

/** Revokes a landed post's held copies. */
export function releaseHeldCopies(token: string) {
  const set = held.get(token);
  if (!set) return;
  held.delete(token);
  revokeAll(set.urls);
  notify();
}

/** Whether a landed post still holds its copies (for tests and the watcher). */
export function hasHeldCopies(token: string): boolean {
  return held.has(token);
}

/** How many records each long-lived collection holds, for leak checks. */
export function attachmentStoreSizes() {
  return {
    entries: entries.size,
    parked: parked.size,
    held: held.size,
    retired: retired.size,
    chains: chains.size,
    staging: staging.size,
  };
}

/**
 * Releases every entry and held copy of `surface` another owner tagged: the
 * mount of a host instance stands in for the previous instance's unmount, which
 * an effect cleanup can't tell from an `<Activity>` hide. An owner minted for a
 * host reaches only that host's owners, so two hosts of one surface mounted at
 * once never end each other's drafts. An entry whose post is in flight ends at
 * that post's settle.
 */
export function sweepOtherOwners(surface: AttachmentSurface, owner: object) {
  const host = ownerHosts.get(owner);
  const swept = (other: object) =>
    other !== owner && ownerHosts.get(other) === host;
  for (const [draftKey, entry] of [...entries]) {
    if (surfaceOf(draftKey) === surface && swept(entry.owner))
      endDraftAttachments(draftKey);
  }
  for (const [token, set] of [...held]) {
    if (set.surface === surface && swept(set.owner)) releaseHeldCopies(token);
  }
}

/** Where a render may take staged images from: one draft's live entry (the
 *  editor's Preview), or one post's own images (its optimistic row). */
export type StagedImageSource =
  | { draftKey: string; owner: object }
  | { postToken: string };

/** The posting entry, live or parked, whose post minted `token`. */
function inFlightEntry(token: string): DraftEntry | undefined {
  const candidates = [
    ...entries.values(),
    ...[...parked.values()].map((p) => p.entry),
  ];
  return candidates.find(
    (entry) => entry.posting.length > 0 && postTokens.get(entry.gen) === token,
  );
}

/**
 * The images a source may show, by name. A draft: the entry its owner holds
 * under its key. A post: only the names it is sending, from its entry while in
 * flight (parked included), then its held copies. A session re-issues a posted
 * name after a partial post, so the two never mix.
 */
function sourceImages(source: StagedImageSource): ReadonlyMap<string, string> {
  if ("draftKey" in source) {
    const entry = entries.get(source.draftKey);
    if (entry?.owner !== source.owner) return new Map();
    return new Map(entry.images.map((i) => [i.name, i.url]));
  }
  const copies = held.get(source.postToken)?.byName;
  if (copies !== undefined) return copies;
  const entry = inFlightEntry(source.postToken);
  if (entry === undefined) return new Map();
  return new Map(
    entry.images
      .filter((i) => entry.posting.includes(i.name))
      .map((i) => [i.name, i.url]),
  );
}

/** The local URL `name` has in `source`, or null when the source may show no
 *  such image. */
export function stagedImageUrl(
  source: StagedImageSource,
  name: string,
): string | null {
  if (!isStagedName(name)) return null;
  return sourceImages(source).get(name) ?? null;
}

/** What a source resolves right now, as one string: a render folds it into its
 *  loader key, so a settle, a stage or a release re-walks only that source. */
export function stagedSourceState(source: StagedImageSource): string {
  return [...sourceImages(source)].map(([n, u]) => `${n}=${u}`).join(" ");
}

/** Whether a thread's detail data still shows a row carrying `token`. */
function showsPostRow(data: unknown, token: string): boolean {
  if (typeof data !== "object" || data === null) return false;
  const comments = (data as { comments?: unknown }).comments;
  if (!Array.isArray(comments)) return false;
  return comments.some(
    (row) =>
      typeof row === "object" &&
      row !== null &&
      (row as { postToken?: unknown }).postToken === token,
  );
}

/** Text as a post and its server copy are compared: LF line ends, no edge
 *  whitespace. */
function comparable(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

/**
 * What each posted name became in the server copy of a post. The posted body is
 * a template whose holes are the NAMEs of its counted `](NAME)` references; a
 * hole holds the NAME (that image failed) or one hosted URL, the same NAME the
 * same value, and every other character must agree. Only rows the post could
 * have made count: a row without a string id, or whose id the thread showed
 * before the post began (`before`), is never a candidate, since an older
 * comment can carry the same template. Null unless exactly one candidate
 * matches.
 */
function serverFills(
  data: unknown,
  body: string,
  names: readonly string[],
  before: ReadonlySet<string>,
): Map<string, string> | null {
  if (typeof data !== "object" || data === null) return null;
  const comments = (data as { comments?: unknown }).comments;
  if (!Array.isArray(comments)) return null;
  const text = comparable(body);
  const holes: { at: number; name: string }[] = [];
  for (const name of names) {
    const token = `](${name})`;
    let at = text.indexOf(token);
    while (at !== -1) {
      holes.push({ at: at + 2, name });
      at = text.indexOf(token, at + token.length);
    }
  }
  holes.sort((a, b) => a.at - b.at);
  const literals: string[] = [];
  let cursor = 0;
  for (const hole of holes) {
    literals.push(text.slice(cursor, hole.at));
    cursor = hole.at + hole.name.length;
  }
  const tail = text.slice(cursor);
  const fill = (candidate: string): Map<string, string> | null => {
    const fills = new Map<string, string>();
    let pos = 0;
    for (const [i, hole] of holes.entries()) {
      if (!candidate.startsWith(literals[i], pos)) return null;
      pos += literals[i].length;
      // Neither a NAME nor a hosted URL holds `)`, which closes the hole.
      const end = candidate.indexOf(")", pos);
      if (end === -1) return null;
      const value = candidate.slice(pos, end);
      if (value !== hole.name && hostedAssetHost(value) === null) return null;
      if ((fills.get(hole.name) ?? value) !== value) return null;
      fills.set(hole.name, value);
      pos = end;
    }
    return candidate.slice(pos) === tail ? fills : null;
  };
  let found: Map<string, string> | null = null;
  for (const row of comments) {
    const { id, body: rowBody } = (row ?? {}) as {
      id?: unknown;
      body?: unknown;
    };
    if (typeof id !== "string" || id === "" || before.has(id)) continue;
    if (typeof rowBody !== "string") continue;
    const fills = fill(comparable(rowBody));
    if (fills === null) continue;
    if (found !== null) return null;
    found = fills;
  }
  return found;
}

/** Seeds the hosted-image cache with the post's own bytes for each image its
 *  server copy shows by URL, so that row's first walk asks GitHub nothing. A
 *  file still encoding is skipped: that image loads the normal way. */
function seedServerCopy(
  queryClient: QueryClient,
  token: string,
  body: string,
  before: ReadonlySet<string>,
  data: unknown,
) {
  const entry = held.has(token) ? undefined : inFlightEntry(token);
  const seeds =
    held.get(token)?.seeds ??
    (entry === undefined ? undefined : postSeeds.get(entry.gen));
  if (seeds === undefined || seeds.bytes.size === 0) return;
  const fills = serverFills(data, body, seeds.names, before);
  if (fills === null) return;
  for (const [name, url] of fills) {
    const host = hostedAssetHost(url);
    const bytes = seeds.bytes.get(name);
    if (host !== null && bytes !== undefined)
      seedHostedImage(queryClient, host, url, bytes);
  }
}

/** How long held copies outlive the decision to free them: past the commit that
 *  swaps the optimistic row for the server copy, which react-query notifies on
 *  a later task, so the row never renders without its images. A timer rather
 *  than animation frames, which a hidden window may never run. */
export const HELD_RELEASE_DELAY_MS = 300;

/**
 * Frees a landed post's held copies once its thread's detail data lands with no
 * row carrying the post's token, or leaves the cache. It decides only on a
 * fetch or write landing with data (`success`), never on the synchronous
 * `invalidate` right after its subscribe: the view's settle has not held the
 * copies yet then. A landing first seeds the server copy's images
 * (seedServerCopy) among the rows whose ids were not in `before`, the thread's
 * comment ids taken before the post's optimistic row went in; null (no thread
 * data then) seeds nothing. The release runs HELD_RELEASE_DELAY_MS after the
 * decision, from a module timer, so it still runs if the view unmounts
 * meanwhile. A decision that beats the settle of a post still in flight retires
 * the token at once, so that settle revokes at once. A failed refetch frees
 * nothing.
 */
export function watchPostedCopies(
  queryClient: QueryClient,
  detailKey: QueryKey,
  token: string,
  body: string,
  before: ReadonlySet<string> | null,
): () => void {
  const hash = hashKey(detailKey);
  let stop: () => void = () => undefined;
  const decide = (landed: { data: unknown } | null) => {
    stop();
    if (landed !== null && before !== null)
      seedServerCopy(queryClient, token, body, before, landed.data);
    if (held.has(token))
      setTimeout(() => releaseHeldCopies(token), HELD_RELEASE_DELAY_MS);
    else if (inFlightEntry(token) !== undefined) retired.add(token);
  };
  stop = queryClient.getQueryCache().subscribe((event) => {
    if (event.query.queryHash !== hash) return;
    if (event.type === "removed") {
      decide(null);
      return;
    }
    if (event.type !== "updated" || event.action.type !== "success") return;
    const data = event.query.state.data;
    if (showsPostRow(data, token)) return;
    decide({ data });
  });
  return stop;
}
