// Pins the image-attachment gate (src/lib/attachments/support-gate.ts): the
// order provider, host, CLI version, write access; every row of the version
// table (Rust pins the same rows); the printed `{version}` and `{host}`;
// and that a pending or failed read never closes the gate. Stdlib only, under
// Node's type stripping.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  attachmentGateReason,
  cliVerdict,
  GH_ATTACH_FLOOR,
  GLAB_ATTACH_FLOOR,
  gateHost,
  readCliVersion,
} from "../src/lib/attachments/support-gate.ts";

const GH_ROWS = [
  ["gh version 2.103.3 (2026-10-26)", "2.103.3", "pass"],
  ["gh version 2.99.0 (2026-01-01)", "2.99.0", "pass"],
  ["gh version 2.98.9 (2026-01-01)", "2.98.9", "tooOld"],
  ["gh version 2.100.0", "2.100.0", "pass"],
  ["gh version 3.0.0", "3.0.0", "pass"],
  ["gh version 2.99", "2.99", "pass"],
];
const GLAB_ROWS = [
  ["glab 1.105.0 (45c9976)", "1.105.0", "pass"],
  ["glab version 1.36.0 (2023-12-01)", "1.36.0", "tooOld"],
  ["glab version v1.91.0", "1.91.0", "pass"],
  ["glab 1.90.9", "1.90.9", "tooOld"],
  ["glab version 1.90", "1.90", "tooOld"],
];
const UNREADABLE = ["gh version DEV", "", null, undefined];

const github = { provider: "github", host: "github.com" };
const gitlab = { provider: "gitlab", host: "gitlab.com" };
const tools = (id, version, found = true) => [{ id, found, version }];

test("every version row: the token and the verdict per CLI", () => {
  for (const [line, token, verdict] of GH_ROWS) {
    assert.equal(readCliVersion(line)?.printed, token, line);
    assert.equal(cliVerdict(line, GH_ATTACH_FLOOR), verdict, line);
  }
  for (const [line, token, verdict] of GLAB_ROWS) {
    assert.equal(readCliVersion(line)?.printed, token, line);
    assert.equal(cliVerdict(line, GLAB_ATTACH_FLOOR), verdict, line);
  }
  for (const line of UNREADABLE) {
    assert.equal(readCliVersion(line), null, String(line));
    assert.equal(cliVerdict(line, GH_ATTACH_FLOOR), "unreadable");
    assert.equal(cliVerdict(line, GLAB_ATTACH_FLOOR), "unreadable");
  }
  assert.equal(
    readCliVersion("git version 2.45.1.windows.1")?.printed,
    "2.45.1",
  );
});

test("gh floor: both arms and the printed version", () => {
  assert.equal(
    attachmentGateReason({
      forge: github,
      tools: tools("gh", "gh version 2.98.9"),
      access: null,
    }),
    "Attaching images needs GitHub CLI 2.99 or newer (you have 2.98.9).",
  );
  assert.equal(
    attachmentGateReason({
      forge: github,
      tools: tools("gh", "gh version 2.99.0"),
      access: null,
    }),
    null,
  );
  assert.equal(
    attachmentGateReason({
      forge: github,
      tools: tools("gh", "gh version 2.100.0"),
      access: null,
    }),
    null,
  );
});

test("glab floor: both arms and the printed version", () => {
  assert.equal(
    attachmentGateReason({
      forge: gitlab,
      tools: tools("glab", "glab 1.90.9"),
      access: null,
    }),
    "Attaching images needs GitLab CLI 1.91 or newer (you have 1.90.9).",
  );
  assert.equal(
    attachmentGateReason({
      forge: gitlab,
      tools: tools("glab", "glab version 1.90"),
      access: null,
    }),
    "Attaching images needs GitLab CLI 1.91 or newer (you have 1.90).",
  );
  assert.equal(
    attachmentGateReason({
      forge: gitlab,
      tools: tools("glab", "glab version v1.91.0"),
      access: null,
    }),
    null,
  );
});

test("a loaded answer without a readable version closes with the unreadable sentence", () => {
  const gh = "Attaching images needs GitHub CLI 2.99 or newer.";
  const glab = "Attaching images needs GitLab CLI 1.91 or newer.";
  for (const t of [
    [],
    tools("gh", "gh version 2.103.3", false),
    tools("gh", null),
    tools("gh", "gh version DEV"),
    tools("gh", ""),
    tools("glab", "glab 1.105.0"),
  ])
    assert.equal(
      attachmentGateReason({ forge: github, tools: t, access: null }),
      gh,
    );
  assert.equal(
    attachmentGateReason({ forge: gitlab, tools: [], access: null }),
    glab,
  );
});

test("a pending or failed health, forge or access read never closes the gate", () => {
  assert.equal(
    attachmentGateReason({
      forge: undefined,
      tools: undefined,
      access: undefined,
    }),
    null,
  );
  assert.equal(
    attachmentGateReason({
      forge: github,
      tools: undefined,
      access: undefined,
    }),
    null,
  );
  assert.equal(
    attachmentGateReason({
      forge: { provider: null, host: null },
      tools: [],
      access: null,
    }),
    null,
  );
  assert.equal(
    attachmentGateReason({
      forge: { provider: "github", host: null },
      tools: undefined,
      access: null,
    }),
    null,
  );
});

test("Bitbucket closes first, whatever else is known", () => {
  assert.equal(
    attachmentGateReason({
      forge: { provider: "bitbucket", host: "bitbucket.org" },
      tools: [],
      access: { canPush: false, repo: "o/r" },
    }),
    "Image attachments aren't available on Bitbucket.",
  );
});

test("hosts: github.com and *.ghe.com pass, Enterprise Server is named", () => {
  assert.equal(gateHost("GHE.Example.COM:8443"), "ghe.example.com");
  assert.equal(
    attachmentGateReason({
      forge: { provider: "github", host: "GHE.Example.COM:8443" },
      tools: tools("gh", "gh version 2.0.0"),
      access: { canPush: false, repo: "o/r" },
    }),
    "Image attachments need GitHub.com or GitHub Enterprise Cloud. ghe.example.com is GitHub Enterprise Server.",
  );
  for (const host of [
    "github.com",
    "X.GHE.COM",
    "Tenant.GHE.com:443",
    "GitHub.com",
  ])
    assert.equal(
      attachmentGateReason({
        forge: { provider: "github", host },
        tools: tools("gh", "gh version 2.103.3"),
        access: null,
      }),
      null,
      host,
    );
});

test("host edges match Rust's host_label and cloud rule", () => {
  // A port is stripped only when it is one or more digits.
  assert.equal(gateHost("example.com:"), "example.com:");
  assert.equal(gateHost("GitHub.Acme.com:8443"), "github.acme.com");
  const reason = (host) =>
    attachmentGateReason({
      forge: { provider: "github", host },
      tools: tools("gh", "gh version 2.103.3"),
      access: null,
    });
  assert.equal(
    reason("example.com:"),
    "Image attachments need GitHub.com or GitHub Enterprise Cloud. example.com: is GitHub Enterprise Server.",
  );
  // `.ghe.com` needs a non-empty label before it.
  assert.equal(
    reason(".ghe.com"),
    "Image attachments need GitHub.com or GitHub Enterprise Cloud. .ghe.com is GitHub Enterprise Server.",
  );
  assert.equal(reason("x.ghe.com"), null);
  assert.equal(
    reason("GitHub.Acme.com:8443"),
    "Image attachments need GitHub.com or GitHub Enterprise Cloud. github.acme.com is GitHub Enterprise Server.",
  );
});

test("a version component is readable exactly when it fits Rust's u64", () => {
  const line = "gh version 2.99999999999999999999.0";
  assert.equal(readCliVersion(line), null);
  assert.equal(cliVerdict(line, GH_ATTACH_FLOOR), "unreadable");
  // Past 2^53 but within u64: Rust reads it, and so does this side, exactly.
  assert.equal(cliVerdict("gh version 9007199254740993.0.0", "2.99"), "pass");
  assert.deepEqual(readCliVersion("gh version 2.9007199254740993.1")?.parts, [
    2n,
    9007199254740993n,
    1n,
  ]);
  assert.equal(
    cliVerdict("gh version 2.18446744073709551615.0", GH_ATTACH_FLOOR),
    "pass",
  );
  // 2^64 is one past u64.
  assert.equal(readCliVersion("gh version 18446744073709551616.0.0"), null);
  assert.equal(
    cliVerdict("gh version 18446744073709551616.0.0", GH_ATTACH_FLOOR),
    "unreadable",
  );
});

test("a host lowercases ASCII only, as Rust's to_ascii_lowercase does", () => {
  // U+0130 (capital I with dot above) stays: only A-Z fold.
  const host = `G${String.fromCharCode(0x130)}THUB.EXAMPLE`;
  assert.equal(gateHost(host), `g${String.fromCharCode(0x130)}thub.example`);
  assert.equal(
    attachmentGateReason({
      forge: { provider: "github", host },
      tools: tools("gh", "gh version 2.103.3"),
      access: null,
    }),
    `Image attachments need GitHub.com or GitHub Enterprise Cloud. g${String.fromCharCode(0x130)}thub.example is GitHub Enterprise Server.`,
  );
});

test("write access closes only on canPush === false, naming the lens repo", () => {
  const gh = tools("gh", "gh version 2.103.3");
  assert.equal(
    attachmentGateReason({
      forge: github,
      tools: gh,
      access: { canPush: false, repo: "up/stream" },
    }),
    "GitHub CLI only attaches images where you have write access, and you don't on up/stream.",
  );
  assert.equal(
    attachmentGateReason({
      forge: github,
      tools: gh,
      access: { canPush: false, repo: null },
    }),
    "GitHub CLI only attaches images where you have write access, and you don't on this repository.",
  );
  for (const access of [
    { canPush: null, repo: "o/r" },
    { canPush: true, repo: "o/r" },
    null,
    undefined,
  ])
    assert.equal(
      attachmentGateReason({ forge: github, tools: gh, access }),
      null,
    );
  // GitLab has no write-access gate.
  assert.equal(
    attachmentGateReason({
      forge: gitlab,
      tools: tools("glab", "glab 1.105.0"),
      access: { canPush: false, repo: "o/r" },
    }),
    null,
  );
});
