import { useEffect, useEffectEvent, useState } from "react";
import {
  djb2,
  type HighlightWorkRequest,
  type HighlightWorkResponse,
  type WorkerAsts,
} from "./highlight-worker-shared";

export type { WorkerAsts } from "./highlight-worker-shared";

// One worker shared by every mounted diff on the main thread. Created lazily on
// the first enabled request; if construction throws (a headless/webview quirk
// where module workers aren't available) it's marked permanently unavailable
// and every future request fails open to the interim paint.
let worker: Worker | null = null;
let workerUnavailable = false;
let nextId = 1;

// Per-request handlers, keyed by request id, so multiple mounted hook instances
// share the one worker without leaking listeners: the single onmessage below
// dispatches each response to (and removes) its handler. A response with no
// registered handler (the requester unmounted) is simply dropped.
const handlers = new Map<number, (res: HighlightWorkResponse) => void>();

function getWorker(): Worker | null {
  if (worker) return worker;
  if (workerUnavailable) return null;
  try {
    worker = new Worker(new URL("./highlight-worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (e: MessageEvent<HighlightWorkResponse>) => {
      const handler = handlers.get(e.data.id);
      if (handler) {
        handlers.delete(e.data.id);
        handler(e.data);
      }
    };
    // A worker that dies at module-init (bad import, OOM) or on a malformed
    // message would otherwise leave `worker` non-null and every future request
    // posting into a corpse — interim paint forever, no signal. Mark it
    // unavailable and drain the pending handlers fail-open (result: null keeps
    // each requester on its interim paint, matching the behavior matrix).
    const fail = (kind: string) => (err: unknown) => {
      workerUnavailable = true;
      worker = null;
      console.warn(
        `[diff] highlight worker ${kind}; large Shiki diffs keep their interim paint`,
        err,
      );
      const pending = [...handlers.values()];
      handlers.clear();
      for (const handler of pending) handler({ id: -1, result: null });
    };
    worker.onerror = fail("crashed");
    worker.onmessageerror = fail("message failed to deserialize");
    return worker;
  } catch (err) {
    workerUnavailable = true;
    console.warn(
      "[diff] highlight worker unavailable; large diffs stay plain",
      err,
    );
    return null;
  }
}

interface WorkerHighlightArgs {
  enabled: boolean;
  filePath: string;
  text: string;
  lang: string | null;
  content: { old: string | null; new: string | null } | null;
  tmGrammar: object | null;
}

// Files past this size never engage the worker. The AST payload amplifies the
// text ~37× (measured), so 1.5MB of text ≈ 55MB of ASTs — the prudent ceiling
// for structured-clone transfer + main-thread rebuild until diff virtualization
// lands. The motivating ~1MB-tsx case stays covered; past it, the diff keeps its
// interim paint.
const WORKER_MAX_CHARS = 1_500_000;

function signatureOf(args: WorkerHighlightArgs): string {
  // Fold `content` into the signature too: the whole-file old/new text shapes
  // the worker request (it's what gets tokenized), so a content change on the
  // same path/length must re-request. Content is ≤100KB/side (the content-mode
  // budget), so the extra hashing is negligible. Empty-string forms when null.
  const old = args.content?.old ?? "";
  const nw = args.content?.new ?? "";
  return `${args.filePath}|${args.lang}|${args.text.length}|${djb2(args.text)}|${old.length}|${djb2(old)}|${nw.length}|${djb2(nw)}`;
}

/**
 * Off-thread Shiki highlighting for over-budget Shiki-routed diffs. Returns the
 * per-side tokenized ASTs that become the view's `registerHighlighter` once they
 * land, or null until then (and forever if the worker is unavailable or the
 * tokenize fails) — the caller keeps its interim paint. Latest-wins: a response
 * for a superseded request (rapid file navigation) is discarded, so no
 * stale/wrong-file highlighting flashes in.
 */
export function useWorkerHighlight(
  args: WorkerHighlightArgs,
): WorkerAsts | null {
  // The size ceiling is enforced here, once, folded into engagement.
  const engaged =
    args.enabled && !!args.lang && args.text.length <= WORKER_MAX_CHARS;
  const signature = engaged ? signatureOf(args) : null;

  const [result, setResult] = useState<{
    signature: string;
    asts: WorkerAsts;
  } | null>(null);

  // Post the request for `sig` off the render path. An effect event reads the
  // LATEST `args`/`result` without making them reactive — the effect below
  // re-fires only when the signature (which digests every request-shaping
  // input: path / lang / text + content hashes) or engagement changes, never on
  // unrelated arg identity churn. The app theme is deliberately absent — token
  // colors are CSS variables, so a toggle must NOT re-request (that cost a full
  // rebuild through an unhighlighted flash). Returns the request id for the
  // effect's cleanup to disarm, or null when nothing was posted (result
  // already in hand, or the worker is unavailable → interim paint).
  const postRequest = useEffectEvent((sig: string): number | null => {
    // Already have this exact result — don't re-post.
    if (result?.signature === sig) return null;

    const w = getWorker();
    if (!w) return null; // unavailable → keeps interim paint

    const id = nextId++;
    const req: HighlightWorkRequest = {
      id,
      filePath: args.filePath,
      // `engaged` (checked by the caller) already gated on lang being non-null.
      lang: args.lang as string,
      hunkText: args.text,
      content: args.content,
      tmGrammar: args.tmGrammar,
    };
    handlers.set(id, (res) => {
      // Latest-wins: a superseded request's handler was already deleted by its
      // cleanup (onmessage and the crash-drain both go through the map), so
      // reaching here means this response is for the request we last sent. A
      // null result (tokenize failure) leaves the interim paint.
      if (res.result) setResult({ signature: sig, asts: res.result });
    });
    w.postMessage(req);
    return id;
  });

  useEffect(() => {
    if (!engaged || signature === null) return;
    const id = postRequest(signature);
    if (id === null) return;
    return () => {
      // Disarm the pending handler so a late reply for a superseded/unmounted
      // request is dropped by the onmessage map lookup (and the map doesn't leak).
      handlers.delete(id);
    };
  }, [engaged, signature]);

  return result?.signature === signature ? result.asts : null;
}
