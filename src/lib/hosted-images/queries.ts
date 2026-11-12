import {
  hashKey,
  onlineManager,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import type { FileBytes } from "@/lib/git/api";
import { ghHostedImage, type HostedImage } from "./api";

/** A read's answer plus the source key it was asked under (client-only, never
 *  from Rust): the key of the walk whose query function ran it, so a joined or
 *  cached answer names the source that produced it. Null on a seed, which
 *  carries bytes and so is never asked again. */
export type HostedImageRead = HostedImage & { askedUnder: string | null };

/** How long a verdict without bytes stays settled: a body walked again within
 *  this window (a StrictMode re-run, a second body, a quick reopen) takes it
 *  as is, and a later walk asks again. */
export const HOSTED_VERDICT_FRESH_MS = 10_000;

/** The memory bound: an entry holds up to 10 MiB of base64. */
const HOSTED_IMAGE_GC_MS = 60_000;

/** The one key builder the loader and the post's seed share. */
export function hostedImageKey(host: string, url: string) {
  return ["hosted-image", host, url] as const;
}

/** Pauses before each re-ask of a `missing` verdict: a freshly uploaded asset
 *  can be unreadable for a moment, and the image stays in its loading state
 *  meanwhile. Every other verdict is final for this fetch; `failed` (a 403, a
 *  5xx, a transport error) is asked once, since a quick retry adds requests
 *  while GitHub is limiting, and a reconnect or sign-in change re-asks it, as
 *  does a walk once the verdict is HOSTED_VERDICT_FRESH_MS old. */
export const HOSTED_IMAGE_RETRY_DELAYS_MS: readonly number[] = [1000, 3000];

const RETRIED = new Set(["missing"]);

// Counted from react-query's own connectivity verdict, the one whose park a
// hosted read rides, so "parked, then resumed" and "re-walked" agree.
let reconnects = 0;
let lastOnline = onlineManager.isOnline();
/** Brings the count up to react-query's live verdict and returns it; a resumed
 *  read calls it too, so its stamp never depends on listener order. */
function syncReconnects(): number {
  const online = onlineManager.isOnline();
  if (online && !lastOnline) reconnects += 1;
  lastOnline = online;
  return reconnects;
}
onlineManager.subscribe(() => {
  syncReconnects();
});

/** Store for useSyncExternalStore: the snapshot is how many offline -> online
 *  transitions the app has seen. */
export const reconnectStore = {
  subscribe: (notify: () => void) => onlineManager.subscribe(notify),
  getSnapshot: () => reconnects,
};

/** Waits `ms`, or less once `signal` aborts. */
const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });

async function fetchHostedImage(
  repoPath: string,
  url: string,
  signal: AbortSignal,
): Promise<HostedImage> {
  let result = await ghHostedImage(repoPath, url, signal);
  for (const ms of HOSTED_IMAGE_RETRY_DELAYS_MS) {
    if (result.unavailable === null || !RETRIED.has(result.unavailable))
      return result;
    await pause(ms, signal);
    // A cancelled fetch's answer is discarded, so it asks nothing more.
    if (signal.aborted) return result;
    result = await ghHostedImage(repoPath, url, signal);
  }
  return result;
}

/** How many walks hold each hosted key, per client (tests build one each). */
const holders = new WeakMap<QueryClient, Map<string, number>>();

/**
 * Marks a walk as wanting `url`'s read until the returned release (idempotent)
 * runs. When a key's last holder releases, its in-flight or parked fetch is
 * cancelled with revert, so a read nobody waits for caches nothing and is
 * withdrawn on the backend. The check runs a microtask later, so a re-walk in
 * the same commit (StrictMode, a re-parse) that holds the key again keeps it.
 */
export function holdHostedRead(
  client: QueryClient,
  host: string,
  url: string,
): () => void {
  const queryKey = hostedImageKey(host, url);
  const hash = hashKey(queryKey);
  let counts = holders.get(client);
  if (counts === undefined) {
    counts = new Map();
    holders.set(client, counts);
  }
  const held = counts;
  held.set(hash, (held.get(hash) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (held.get(hash) ?? 1) - 1;
    if (left > 0) held.set(hash, left);
    else held.delete(hash);
    queueMicrotask(() => {
      if (held.has(hash)) return;
      const status = client.getQueryState(queryKey)?.fetchStatus;
      if (status === undefined || status === "idle") return;
      void client.cancelQueries({ queryKey, exact: true }, { revert: true });
    });
  };
}

/**
 * One GitHub-hosted image, keyed per host and URL (assets are immutable by
 * uuid), outside `["repo", …]` so a write's settle never re-reads it. Bytes are
 * settled for as long as the entry lives; any other verdict stays settled for
 * HOSTED_VERDICT_FRESH_MS. The key holds no repo or sign-in, so the answer
 * records `askedUnder`, the source key the read RAN under: `sourceAt` (the
 * starting walk's repo, host and sign-in) over the reconnect count read when
 * the query function starts, so a read parked offline and resumed after the
 * reconnect names the post-reconnect source. A walk takes a verdict asked
 * under its own source key and asks once more, fresh, when it was asked under
 * another (an older sign-in, another repo, before a reconnect).
 * An entry holds up to 10 MiB of base64, so `gcTime` is the memory bound: the
 * cache holds the images of the bodies viewed in the last minute. The default
 * networkMode parks a read that STARTS offline and resumes it on reconnect; one
 * that ran while the link was dying settles `failed`, which a body re-asks
 * through its reconnect axis (reconnectStore). A dead link that still reports
 * online is not detected. An IPC rejection is not retried.
 */
export function hostedImageOptions(
  repoPath: string,
  host: string,
  url: string,
  sourceAt: (reconnects: number) => string,
) {
  return queryOptions({
    queryKey: hostedImageKey(host, url),
    queryFn: async ({ signal }): Promise<HostedImageRead> => {
      const askedUnder = sourceAt(syncReconnects());
      return { ...(await fetchHostedImage(repoPath, url, signal)), askedUnder };
    },
    staleTime: (query) =>
      query.state.data?.bytes ? Infinity : HOSTED_VERDICT_FRESH_MS,
    gcTime: HOSTED_IMAGE_GC_MS,
    retry: false,
  });
}

/**
 * Caches bytes this app already holds for `url` (a post's own uploaded file),
 * so the first walk of the server copy reads them instead of asking GitHub.
 * Built with the loader's `gcTime`, so a seed no body reads leaves within the
 * same minute. Never replaces an entry that already holds bytes.
 */
export function seedHostedImage(
  client: QueryClient,
  host: string,
  url: string,
  bytes: FileBytes,
) {
  const queryKey = hostedImageKey(host, url);
  if (client.getQueryData<HostedImageRead>(queryKey)?.bytes) return;
  client
    .getQueryCache()
    .build(client, { queryKey, gcTime: HOSTED_IMAGE_GC_MS });
  client.setQueryData<HostedImageRead>(queryKey, {
    bytes,
    unavailable: null,
    askedUnder: null,
  });
}
