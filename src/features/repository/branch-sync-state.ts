// What a branch push would do on its remote and what "Update from <default>"
// merges, as pure functions of the branch facts the UI already holds.
// Import-free: scripts/branch-sync-state.test.mjs loads it under Node's type
// stripping, which resolves no bundler aliases.

/** Whether a push of this branch runs with publish (-u) semantics.
 *  `setUpstream` covers the one route that publishes a TRACKED branch by
 *  explicit retrack (the mismatch menu's publish item). Drives ROUTING and the
 *  publish confirm's gate; success toasts claim outcomes through pushOutcome /
 *  pushSuccessCopy, never this flag alone. KEEP IN STEP with the backend's
 *  publish arm (`build_push_args`, git/remote.rs). */
export function willPublish(b: {
  upstream: string | null;
  upstreamGone: boolean;
  setUpstream?: boolean;
}): boolean {
  return b.setUpstream === true || !b.upstream || b.upstreamGone;
}

/** Whether the push would CREATE the branch on the destination, the one
 *  confirm decision. `remoteHasSameName`: whether refs/remotes/<dest>/<name>
 *  exists as of the last fetch; undefined (the list is unknown) reads as a
 *  create, so the prompt shows. */
export function willCreateOnRemote(b: {
  upstream: string | null;
  upstreamGone: boolean;
  setUpstream?: boolean;
  remoteHasSameName: boolean | undefined;
}): boolean {
  return willPublish(b) && b.remoteHasSameName !== true;
}

/** Whether the destination already has `branch`, from the remote-branches list
 *  (last-fetch state). An unloaded or failed list is undefined, never false. */
export function remoteHasBranch(
  list: readonly { remote: string; name: string }[] | undefined,
  remote: string,
  branch: string,
): boolean | undefined {
  return list?.some((r) => r.remote === remote && r.name === branch);
}

// The create decision is out of reach by design for: narrow or remapped fetch
// refspecs and a git without the %(push) atoms (no destination git resolves), a
// push remote with its own push refspecs or a mirror one (git's bare push runs
// as configured, and git refuses an explicit refspec to a mirror), several
// pushurls (the first is named; the push goes to all), force pushes (their own
// confirm), and presence, which is remote-tracking refs as of the last fetch. It
// claims a create only from facts git reports, with no network read.

/** The bare-push create decision. A resolved destination that the remote is
 *  not known to have → true (ask); known present → false; an UNRESOLVED
 *  destination → undefined, and the push goes ahead unasked: only a destination
 *  git resolved can be claimed as created. Unresolved is a loose null check, so
 *  an object that omits the fields never reads as resolved. */
export function pushWouldCreate(dest: {
  pushRemote?: string | null;
  pushBranch?: string | null;
  /** Whether refs/remotes/<pushRemote>/<pushBranch> is known present. */
  presence: boolean | undefined;
}): boolean | undefined {
  if (dest.pushRemote == null || dest.pushBranch == null) return undefined;
  return dest.presence !== true;
}

/** What a branch push did, decided BEFORE the push from last-fetch presence:
 *  the push IPC reports no created-vs-updated signal. */
export type PushOutcome =
  | "created"
  | "updated-and-tracking"
  | "pushed"
  | "unknown";

/** `willPublish`: the push can create or retrack on the destination. `create`:
 *  the route's willCreateOnRemote/pushWouldCreate result; undefined = presence
 *  never read. `presence`: the presenceUnderUrls value that create decision
 *  read; a create decided from undefined presence may NOT claim "created". */
export function pushOutcome(o: {
  willPublish: boolean;
  create: boolean | undefined;
  presence: boolean | undefined;
}): PushOutcome {
  if (!o.willPublish) return "pushed";
  if (o.create === false) return "updated-and-tracking";
  if (o.create === true && o.presence === false) return "created";
  return "unknown";
}

/** The success toast for a branch push; null for "pushed" (the surface keeps
 *  its own behavior). `away` is landedIn(repo).away read AFTER the await.
 *  `remoteBranch` only when the destination name differs from `branch`.
 *  `tracks`: whether this push sets or keeps tracking (false only on the bare
 *  push, which sets no upstream); it gates the unknown row's description. */
export function pushSuccessCopy(o: {
  outcome: PushOutcome;
  branch: string;
  remote: string;
  remoteBranch?: string;
  tracks: boolean;
  away: string;
}): { title: string; description?: string } | null {
  const { branch, remote, away } = o;
  const tracking = `${branch} now tracks ${remote}/${branch}.`;
  switch (o.outcome) {
    case "pushed":
      return null;
    case "created":
      return {
        title:
          o.remoteBranch === undefined
            ? `Published ${branch} to ${remote}${away}`
            : `Published ${branch} to ${remote} as ${o.remoteBranch}${away}`,
      };
    case "updated-and-tracking":
      return {
        title: `Pushed ${branch} to ${remote}/${branch}${away}`,
        description: tracking,
      };
    case "unknown":
      return o.tracks
        ? {
            title: `Pushed ${branch} to ${remote}${away}`,
            description: tracking,
          }
        : {
            title: `Pushed ${branch} to ${remote}/${o.remoteBranch ?? branch}${away}`,
          };
  }
}

const DEFAULT_PORTS: Readonly<Record<string, string>> = {
  http: "80",
  https: "443",
  ssh: "22",
};

/** A parsed remote URL: its repository identity, plus the scheme and port that
 *  decide whether two same-scheme URLs reach the same server. */
interface RepoUrl {
  identity: string;
  scheme: string;
  /** The effective port (defaults filled in); null for scp-like URLs, whose
   *  port ssh config may remap. */
  port: string | null;
}

function parseRepoUrl(url: string): RepoUrl | null {
  const u = url.trim();
  const full = u.match(
    /^(https?|ssh):\/\/(?:[^@/]+@)?([^/:]+)(?::(\d*))?\/(.+)$/i,
  );
  const scp = full ? null : u.match(/^[^@/\\]+@([^:/\\]+):(.+)$/);
  let scheme: string;
  let host: string;
  let port: string | null;
  let rawPath: string;
  if (full) {
    [scheme, host, port, rawPath] = [
      full[1].toLowerCase(),
      full[2],
      full[3] || null,
      full[4],
    ];
  } else if (scp) {
    [scheme, host, port, rawPath] = ["scp", scp[1], null, scp[2]];
  } else {
    return null;
  }
  const path = rawPath
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  if (path === "") return null;
  return {
    identity: `${host.toLowerCase()}/${path}`,
    scheme,
    port: port ?? DEFAULT_PORTS[scheme] ?? null,
  };
}

/** A remote URL's repository identity (lowercased host + path, no trailing
 *  `.git` or `/`; the user ignored) for http(s)://, ssh:// and scp-like
 *  `user@host:path`; null for anything else (a local path, file://). git
 *  expands insteadOf and pushInsteadOf in `get-url`, so one repository commonly
 *  reads as https for fetch and ssh for push. Ports are compared by
 *  {@link sameRepository}, not carried here. */
export function repoIdentity(url: string): string | null {
  return parseRepoUrl(url)?.identity ?? null;
}

/** Whether two URLs name the same repository: by identity when both parse,
 *  else (a local path, file://) by exact text. Two URLs of the SAME scheme must
 *  also share a port (defaults filled in), since that can be another server;
 *  across schemes ports say nothing, and scp-like URLs carry none. */
export function sameRepository(a: string, b: string): boolean {
  const pa = parseRepoUrl(a);
  const pb = parseRepoUrl(b);
  if (pa === null || pb === null) return a === b;
  return (
    pa.identity === pb.identity &&
    (pa.scheme !== pb.scheme || pa.port === pb.port)
  );
}

/** The remote-tracking list mirrors a remote's FETCH side, so when its push URL
 *  names another repository the list says nothing about the push destination:
 *  presence becomes unknown, as it does when only one of the two could be read.
 *  Both URLs are the push remote's own (`get-url` and `--push`). */
export function presenceUnderUrls(
  presence: boolean | undefined,
  fetchUrl: string | null,
  pushUrl: string | null,
): boolean | undefined {
  if (fetchUrl === null && pushUrl === null) return presence;
  if (fetchUrl === null || pushUrl === null) return undefined;
  return sameRepository(fetchUrl, pushUrl) ? presence : undefined;
}

/** Whether the visibility recorded for origin describes this push: the probe
 *  that records it reads origin's fetch URL, so only an origin push to that
 *  same repository may show it. */
export function visibilityApplies(
  remote: string,
  fetchUrl: string | null,
  pushUrl: string | null,
): boolean {
  return (
    remote === "origin" &&
    fetchUrl !== null &&
    pushUrl !== null &&
    sameRepository(fetchUrl, pushUrl)
  );
}

export interface UpdateSource {
  base: string;
  label: string;
}
export interface UpdateSources {
  primary: UpdateSource;
  secondary: UpdateSource | null;
}

/** Whether a branch's upstream remote names THIS repository: git's
 *  `%(upstream:remotename)` reads `.` for a branch tracking a local branch, and
 *  null stands for no remote at all. Only meaningful beside a set upstream. */
export function isLocalUpstream(remote: string | null): remote is "." | null {
  return remote === null || remote === ".";
}

/** Resolve what "Update from <default>" merges, from the DEFAULT branch's row
 *  facts as of the last fetch. `row` undefined = no local default row listed.
 *  Bases use the row's `%(upstream:short)` verbatim: git disambiguates it
 *  (`remotes/origin/main`) when a local branch would capture the short form,
 *  which a composed `origin/<default>` would not. A default tracking a LOCAL
 *  branch resolves as having no upstream. */
export function resolveUpdateFromDefault(
  defaultName: string,
  row:
    | {
        upstream: string | null;
        upstreamGone: boolean;
        upstreamRemote: string | null;
        upstreamAhead: number;
        upstreamBehind: number;
      }
    | undefined,
): UpdateSources {
  const local: UpdateSource = {
    base: defaultName,
    label: `Update from ${defaultName}`,
  };
  if (!row?.upstream || row.upstreamGone || isLocalUpstream(row.upstreamRemote))
    return { primary: local, secondary: null };
  const remote: UpdateSource = {
    base: row.upstream,
    label: `Update from ${row.upstream}`,
  };
  if (row.upstreamAhead > 0) {
    const n = row.upstreamAhead;
    return {
      primary: {
        base: defaultName,
        label: `Update from ${defaultName} (${n} commit${n === 1 ? "" : "s"} not on ${row.upstreamRemote})`,
      },
      secondary: remote,
    };
  }
  if (row.upstreamBehind > 0) return { primary: remote, secondary: null };
  return { primary: local, secondary: null };
}

/** Whether a remote URL names a host (http(s)://, ssh://, or scp-like
 *  `user@host:path`), so its last two path segments are an owner/repo slug. A
 *  local path or file:// remote has no slug worth showing. */
export function forgeShapedUrl(url: string): boolean {
  const u = url.trim();
  return (
    /^(?:https?|ssh):\/\/[^/]+\/./i.test(u) || /^[^@/\\]+@[^:/\\]+:./.test(u)
  );
}

/** The owner/repo slug the prompt names, only for a forge-shaped URL. The slug
 *  parser arrives as a parameter to keep this module import-free. */
export function destinationSlug(
  url: string | null,
  slugOf: (url: string) => string | null,
): string | null {
  return url !== null && forgeShapedUrl(url) ? slugOf(url) : null;
}

/** One run of prompt text; `mono` marks a ref, remote or slug. */
export interface CopySegment {
  text: string;
  mono?: boolean;
}

export function segmentsText(segments: readonly CopySegment[]): string {
  return segments.map((s) => s.text).join("");
}

/** `<remote>` plus ` (<slug>, <visibility>)`: the visibility only for origin
 *  (the probe that records it reads origin) and only when known, since absent
 *  never means public; no parenthetical when neither is known. */
export function destinationPhrase(
  remote: string,
  slug: string | null,
  visibility: string | null,
): CopySegment[] {
  const vis = remote === "origin" ? visibility : null;
  const out: CopySegment[] = [{ text: remote, mono: true }];
  if (slug !== null && vis !== null)
    out.push({ text: " (" }, { text: slug, mono: true }, { text: `, ${vis})` });
  else if (slug !== null)
    out.push({ text: " (" }, { text: slug, mono: true }, { text: ")" });
  else if (vis !== null) out.push({ text: ` (${vis})` });
  return out;
}

const EXPOSURE =
  " Anyone who can see the repository can see it, and CI may run on it.";

/** The publish prompt's body. The re-create wording only when the GONE
 *  upstream was this same name on the destination itself: a push to another
 *  remote, or of a branch that tracked a differently named one, creates a new
 *  branch, and nothing of that name was deleted there. */
export function publishConfirmBody(o: {
  branch: string;
  remote: string;
  slug: string | null;
  visibility: string | null;
  goneUpstream: boolean;
  /** The gone upstream's remote; null when there is none. */
  upstreamRemote: string | null;
  /** The gone upstream's branch name on that remote (its merge ref without
   *  `refs/heads/`); null when unknown or not a branch. */
  upstreamBranch: string | null;
  /** The name the push creates on the remote when it differs from `branch` (a
   *  bare push to a configured destination); absent = the same name. */
  createdBranch?: string;
}): CopySegment[] {
  const dest = destinationPhrase(o.remote, o.slug, o.visibility);
  const branch: CopySegment = { text: o.branch, mono: true };
  if (
    o.goneUpstream &&
    o.upstreamRemote === o.remote &&
    o.upstreamBranch === o.branch
  )
    return [
      branch,
      { text: " was deleted on " },
      ...dest,
      {
        text: `, likely after a merge. Publishing creates it again.${EXPOSURE}`,
      },
    ];
  return [
    { text: "Creates " },
    { text: o.createdBranch ?? o.branch, mono: true },
    { text: " on " },
    ...dest,
    { text: `.${EXPOSURE}` },
  ];
}

/** The prompt's title, plain text so a repo-switch cancel notice can name the
 *  action ("Didn't publish <branch> …"). */
export function publishConfirmTitle(branch: string): string {
  return `Publish ${branch}?`;
}

/** Whether one of `pushes` is sending `branch`. A HEAD push names no branch
 *  (push-writes.ts BranchPushState.branch null), so it counts as the current
 *  branch, and as ANY branch while the current name is unknown, failing
 *  toward refusal: the hold costs one toast, a miss moves the ref mid-send. */
export function pushesBranch(
  pushes: readonly { branch: string | null }[],
  branch: string,
  currentName: string | null,
): boolean {
  return pushes.some(
    (p) =>
      p.branch === branch ||
      (p.branch === null && (currentName === null || currentName === branch)),
  );
}
