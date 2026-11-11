// Whether this repository can take image attachments, as the disabled reason
// the Attach control shows. Import-free for `scripts/attachment-gate.test.mjs`.
// Rust refuses in the same order with byte-identical sentences, so a gate that
// is open here (pending reads) still meets the same refusal at post time.

export const GH_ATTACH_FLOOR = "2.99.0";
export const GLAB_ATTACH_FLOOR = "1.91.0";

export const ATTACHMENT_GATE_COPY = {
  bitbucket: "Image attachments aren't available on Bitbucket.",
  enterpriseServer: (host: string) =>
    `Image attachments need GitHub.com or GitHub Enterprise Cloud. ${host} is GitHub Enterprise Server.`,
  ghTooOld: (version: string) =>
    `Attaching images needs GitHub CLI 2.99 or newer (you have ${version}).`,
  ghUnreadable: "Attaching images needs GitHub CLI 2.99 or newer.",
  glabTooOld: (version: string) =>
    `Attaching images needs GitLab CLI 1.91 or newer (you have ${version}).`,
  glabUnreadable: "Attaching images needs GitLab CLI 1.91 or newer.",
  noWriteAccess: (slug: string) =>
    `GitHub CLI only attaches images where you have write access, and you don't on ${slug}.`,
} as const;

/** The first dotted numeric run in a `--version` line (health.ts reads the
 *  same token). */
const VERSION_TOKEN = /\d+(?:\.\d+)+/;

/** Rust parses each component as u64; one past it reads unreadable there. */
const U64_MAX = 18446744073709551615n;

export interface CliVersionRead {
  /** (major, minor, patch), a missing patch counting as 0; exact past 2^53. */
  parts: [bigint, bigint, bigint];
  /** The token's first three components, as the sentence prints them. */
  printed: string;
}

export function readCliVersion(
  line: string | null | undefined,
): CliVersionRead | null {
  const token = line?.match(VERSION_TOKEN)?.[0];
  if (!token) return null;
  const printed = token.split(".").slice(0, 3);
  const numbers = printed.map(BigInt);
  if (numbers.some((n) => n > U64_MAX)) return null;
  const [major = 0n, minor = 0n, patch = 0n] = numbers;
  return { parts: [major, minor, patch], printed: printed.join(".") };
}

export type CliVerdict = "pass" | "tooOld" | "unreadable";

/** One CLI's verdict against a floor such as `GH_ATTACH_FLOOR`. */
export function cliVerdict(
  line: string | null | undefined,
  floor: string,
): CliVerdict {
  const read = readCliVersion(line);
  const min = readCliVersion(floor);
  if (read === null || min === null) return "unreadable";
  for (let i = 0; i < 3; i++) {
    if (read.parts[i] !== min.parts[i])
      return read.parts[i] > min.parts[i] ? "pass" : "tooOld";
  }
  return "pass";
}

/** A host as the Enterprise Server sentence prints it and the host test reads
 *  it: ASCII-lowercased as Rust's `to_ascii_lowercase` is, without a `:port`. */
export function gateHost(host: string): string {
  return host.replace(/[A-Z]/g, (c) => c.toLowerCase()).replace(/:\d+$/, "");
}

export interface GateForge {
  provider: "github" | "gitlab" | "bitbucket" | null;
  host: string | null;
}

export interface GateTool {
  id: string;
  found: boolean;
  version: string | null;
}

export interface GateAccess {
  canPush: boolean | null;
  repo: string | null;
}

const CLI_GATES = {
  github: {
    id: "gh",
    floor: GH_ATTACH_FLOOR,
    tooOld: ATTACHMENT_GATE_COPY.ghTooOld,
    unreadable: ATTACHMENT_GATE_COPY.ghUnreadable,
  },
  gitlab: {
    id: "glab",
    floor: GLAB_ATTACH_FLOOR,
    tooOld: ATTACHMENT_GATE_COPY.glabTooOld,
    unreadable: ATTACHMENT_GATE_COPY.glabUnreadable,
  },
} as const;

/**
 * The reason attaching is closed, or null when it is open. First match wins:
 * provider, host (GitHub), CLI version, write access (GitHub). Each step closes
 * only on an answer: a pending or failed read (undefined) skips its step.
 */
export function attachmentGateReason({
  forge,
  tools,
  access,
}: {
  forge: GateForge | null | undefined;
  /** A LOADED health answer's tools; undefined while pending or failed. */
  tools: readonly GateTool[] | null | undefined;
  access: GateAccess | null | undefined;
}): string | null {
  const provider = forge?.provider;
  if (provider === "bitbucket") return ATTACHMENT_GATE_COPY.bitbucket;
  if (provider !== "github" && provider !== "gitlab") return null;
  if (provider === "github" && forge?.host) {
    const host = gateHost(forge.host);
    const cloud = host.length > ".ghe.com".length && host.endsWith(".ghe.com");
    if (host !== "" && host !== "github.com" && !cloud)
      return ATTACHMENT_GATE_COPY.enterpriseServer(host);
  }
  if (tools) {
    const gate = CLI_GATES[provider];
    const row = tools.find((t) => t.id === gate.id);
    const line = row?.found ? row.version : null;
    const verdict = cliVerdict(line, gate.floor);
    if (verdict === "unreadable") return gate.unreadable;
    if (verdict === "tooOld") {
      const printed = readCliVersion(line)?.printed ?? "";
      return gate.tooOld(printed);
    }
  }
  if (provider === "github" && access?.canPush === false)
    return ATTACHMENT_GATE_COPY.noWriteAccess(access.repo ?? "this repository");
  return null;
}
