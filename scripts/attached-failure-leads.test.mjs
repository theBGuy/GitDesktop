// Pins the app sentences Rust writes for a failed or timed-out forge write to the
// rules that read them in src/lib/error-summary.ts. `attached_run_failure`'s line
// (src-tauri/src/github/pr.rs) must start with one of NOTHING_EXISTS_DISCLOSURES or
// BRANCH_PUSHED_DISCLOSURE, or the summary rewrites it as a network failure;
// `edit_body_dropped_text`'s must start with SAVED_DISCLOSURE_LEAD and carry the
// saved-changes marker `otherChangesSaved` keys on; and every `write_timed_out`
// sentence (src-tauri/src/forge/mod.rs) must read as `mayHaveLanded` while a bare
// `Timeout` (src-tauri/src/error.rs) must not. A one-sided rewording would
// silently lose any of them.
//
// A source-shape pin, so each case also runs the check over in-memory mutants
// to prove it can fail. The TS module loads through the shared src hooks, as in
// error-summary.test.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { installSrcHooks } from "./lib/src-import-hooks.mjs";

const hooks = installSrcHooks();
after(() => hooks.deregister());

const {
  BRANCH_PUSHED_DISCLOSURE,
  mayHaveLanded,
  NOTHING_EXISTS_DISCLOSURES,
  otherChangesSaved,
  presentError,
  SAVED_DISCLOSURE_LEAD,
} = await import("@/lib/error-summary");

const RUST = new URL("../src-tauri/src/github/pr.rs", import.meta.url);
const FORGE = new URL("../src-tauri/src/forge/mod.rs", import.meta.url);
const ERROR = new URL("../src-tauri/src/error.rs", import.meta.url);
const read = (url) => readFileSync(url, "utf8");

/** A gh transport line the summary rewrites unless line one outranks it. */
const TRANSPORT_TAIL =
  'Post "https://uploads.github.com/": dial tcp 140.82.112.6:443: i/o timeout';

/** The body of the file's ONE `fn <name>(`, up to its closing column-0 brace, or
 *  null when there isn't exactly one. */
function fnBody(src, name) {
  const heads = [...src.matchAll(new RegExp(`\\bfn ${name}\\(`, "g"))];
  if (heads.length !== 1) return null;
  const start = heads[0].index;
  // A CRLF checkout puts a CR before each newline.
  const close = src.slice(start).search(/\n\}\r?\n/);
  return close === -1 ? null : src.slice(start, start + close);
}

/** The first `format!` string literal in a body, or null. */
function formatLiteral(body) {
  const m = body.match(/format!\(\s*"((?:[^"\\]|\\.)*)"/);
  return m ? m[1] : null;
}

/** The lead each kind's sentence must start with in the TS rule. */
const TS_LEADS = {
  Create: NOTHING_EXISTS_DISCLOSURES[0],
  PrCreate: BRANCH_PUSHED_DISCLOSURE,
  Post: NOTHING_EXISTS_DISCLOSURES[1],
};

/** `[kind, line]` for each sentence `attached_run_failure` can build, or the
 *  reason the source can't be read. */
function attachedLines(src) {
  const body = fnBody(src, "attached_run_failure");
  if (body === null) return "attached_run_failure not found exactly once";
  const leads = [
    ...body.matchAll(/AttachedWrite::(\w+) => \{?\s*"((?:[^"\\]|\\.)*)"/g),
  ].map((m) => [m[1], m[2]]);
  if (leads.length !== 3) return `expected three leads, read ${leads.length}`;
  const literal = formatLiteral(body);
  if (literal === null) return "no format! literal";
  const lines = leads.map(([kind, lead]) => [
    kind,
    literal.replace("{lead}", lead).replace("{}", "image-1.png"),
  ]);
  if (lines.some(([, l]) => /[{}\\]/.test(l)))
    return "the literal holds a placeholder or escape this pin can't fill";
  return lines;
}

/** Null when every attached line leads with its kind's TS lead and the summary
 *  keeps it over a transport tail; otherwise the reason the pin fails. */
function attachedMismatch(src) {
  const lines = attachedLines(src);
  if (typeof lines === "string") return lines;
  for (const [kind, line] of lines) {
    const lead = TS_LEADS[kind];
    if (lead === undefined) return `no TS lead for ${kind}`;
    if (!line.startsWith(lead))
      return `${JSON.stringify(line)} doesn't start with ${JSON.stringify(lead)}`;
    const message = `${line}\n${TRANSPORT_TAIL}`;
    if (presentError({ kind: "gh", message }).summary !== line)
      return `the summary rewrites ${JSON.stringify(line)}`;
  }
  return null;
}

/** Null when `edit_body_dropped_text`'s sentence starts with the TS lead and
 *  carries the saved marker. */
function droppedMismatch(src) {
  const body = fnBody(src, "edit_body_dropped_text");
  if (body === null) return "edit_body_dropped_text not found exactly once";
  const literal = formatLiteral(body);
  if (literal === null) return "no format! literal";
  const line = literal.replace("{what}", "image-1.png");
  // A Rust escape such as `\n` is two characters here but a line break at
  // runtime, which could move the marker off line one unseen.
  if (/[{}\\]/.test(line))
    return "the literal holds a placeholder or escape this pin can't fill";
  if (!line.startsWith(SAVED_DISCLOSURE_LEAD))
    return `${JSON.stringify(line)} doesn't start with the TS lead`;
  return otherChangesSaved({ kind: "gh", message: line })
    ? null
    : `no saved marker in ${JSON.stringify(line)}`;
}

const NOUNS = ["issue", "pull request", "merge request"];

/** Every two-line message `write_timed_out` can build, filled for both hosts and
 *  every noun, or the reason the source can't be read. */
function timedOutMessages(src) {
  const enumBody = src.match(/enum LandedWrite \{([^}]*)\}/);
  if (enumBody === null) return "enum LandedWrite not found";
  const variants = [...enumBody[1].matchAll(/^\s*(\w+)(?:\(|,)/gm)].map(
    (m) => m[1],
  );
  if (variants.length === 0) return "no LandedWrite variants read";
  const body = fnBody(src, "write_timed_out");
  if (body === null) return "write_timed_out not found exactly once";
  const arms = [
    ...body.matchAll(
      /LandedWrite::(\w+)(?:\(\w+\))? => format!\(\s*"((?:[^"\\]|\\.)*)"/g,
    ),
  ].map((m) => [m[1], m[2]]);
  if (arms.length < variants.length)
    return `read ${arms.length} sentences for ${variants.length} variants`;
  const joined = body.match(
    /WriteTimedOut\(format!\(\s*"((?:[^"\\]|\\.)*)"\)\)/,
  );
  if (joined === null) return "no two-line WriteTimedOut literal";
  const messages = [];
  for (const [variant, sentence] of arms) {
    for (const host of ["GitHub", "GitLab"]) {
      for (const noun of NOUNS) {
        const line1 = sentence
          .replaceAll("{host}", host)
          .replaceAll("{noun}", noun);
        const message = joined[1]
          .replace("{lead}", line1)
          .replaceAll("{host}", host)
          .replace("{seconds}", "150")
          .replace("\\n", "\n");
        if (/[{}\\]/.test(message))
          return `${variant}: a placeholder or escape this pin can't fill`;
        messages.push([variant, line1, message]);
      }
    }
  }
  return messages;
}

/** Null when every `write_timed_out` message reads as may-have-landed under
 *  `predicate` and presents as "Timed out" with line one as its summary. */
function timedOutMismatch(src, predicate = mayHaveLanded) {
  const messages = timedOutMessages(src);
  if (typeof messages === "string") return messages;
  for (const [variant, line1, message] of messages) {
    if (message.split("\n").length !== 2) return `${variant}: not two lines`;
    const error = { kind: "timeout", message };
    if (!predicate(error)) return `${variant}: not may-have-landed`;
    const p = presentError(error);
    if (p.label !== "Timed out") return `${variant}: label ${p.label}`;
    if (p.summary !== line1) return `${variant}: summary ${p.summary}`;
  }
  return null;
}

const UNREAD_NOUNS = [
  "issue",
  "pull request",
  "merge request",
  "discussion",
  "release",
];

/** Every one-line message `created_reply_unreadable` can build, filled for each
 *  provider arm, noun and push lead with the kind error.rs serializes its variant
 *  as, plus the template and lead read; or the reason the source can't be read. */
function unreadReplyMessages(forgeSrc, errorSrc) {
  const body = fnBody(forgeSrc, "created_reply_unreadable");
  if (body === null) return "created_reply_unreadable not found exactly once";
  const hosts = [...body.matchAll(/Provider::(\w+) => "((?:[^"\\]|\\.)*)"/g)];
  if (hosts.length !== 3) return `read ${hosts.length} host arms, want 3`;
  const variants = new Map();
  for (const m of body.matchAll(
    /Provider::(\w+) => AppError::(\w+)\(message\)/g,
  )) {
    if (variants.has(m[1])) return `${m[1]}: two variant arms`;
    variants.set(m[1], m[2]);
  }
  if (variants.size !== 3) return `read ${variants.size} variant arms, want 3`;
  const leads = [
    ...body.matchAll(
      /if after_push \{\s*"((?:[^"\\]|\\.)*)"\s*\} else \{\s*""\s*\}/g,
    ),
  ];
  if (leads.length !== 1) return `read ${leads.length} push leads, want 1`;
  const lead = leads[0][1];
  if (body.match(/format!\(/g)?.length !== 1) return "want one format! call";
  const template = formatLiteral(body);
  if (template === null) return "no format! literal";
  const messages = [];
  for (const [, provider, host] of hosts) {
    const variant = variants.get(provider);
    if (variant === undefined) return `${provider}: no variant arm`;
    const kinds = [
      ...errorSrc.matchAll(
        new RegExp(`AppError::${variant}\\(_\\) => "(\\w+)"`, "g"),
      ),
    ];
    if (kinds.length !== 1) return `${variant}: ${kinds.length} kind arms`;
    const kind = kinds[0][1];
    for (const noun of UNREAD_NOUNS) {
      for (const pushed of [false, true]) {
        const message = template
          .replaceAll("{pushed}", pushed ? lead : "")
          .replaceAll("{host}", host)
          .replaceAll("{noun}", noun);
        if (/[{}\\]/.test(message))
          return `${provider}: a placeholder or escape this pin can't fill`;
        messages.push({ host, kind, message });
      }
    }
  }
  return { template, lead, messages };
}

/** Null when every `created_reply_unreadable` message is one line, reads as
 *  may-have-landed under `predicate`, and presents under its forge's own label
 *  with the whole sentence as its summary. */
function unreadReplyMismatch(forgeSrc, errorSrc, predicate = mayHaveLanded) {
  const read = unreadReplyMessages(forgeSrc, errorSrc);
  if (typeof read === "string") return read;
  if (read.messages.length !== 30)
    return `read ${read.messages.length} messages, want 30`;
  for (const { host, kind, message } of read.messages) {
    if (message.includes("\n")) return `${host}: not one line`;
    const error = { kind, message };
    if (!predicate(error)) return `${kind}: not may-have-landed: ${message}`;
    const p = presentError(error);
    if (p.label !== `${host} error` || p.label === "Timed out")
      return `${kind}: label ${p.label}`;
    if (p.summary !== message) return `${kind}: summary ${p.summary}`;
  }
  return null;
}

const HEDGE = (host, noun = "issue") =>
  `${host} accepted the request but its reply couldn't be read, so the ${noun} may already exist. Check before creating it again.`;
const EMPTY_TIMEOUT = { kind: "timeout", message: "" };
const CAPITAL_TIMEOUT = {
  kind: "timeout",
  message: "Git operation timed out after 120s",
};
const GITHUB_HEDGE_AS_GLAB = { kind: "glab", message: HEDGE("GitHub") };

/** The errors that must never read as may-have-landed. */
const NOT_LANDED = [
  { kind: "timeout", message: "git operation timed out after 120s" },
  ...["gh", "glab"].map((kind) => ({
    kind,
    message:
      "GitHub didn't answer in time, so your comment may still have been posted. Check the conversation before posting again.\nGitHub CLI timed out after 150s.",
  })),
  new Error("boom"),
  null,
  "GitHub didn't answer in time",
  EMPTY_TIMEOUT,
  { kind: "timeout", message: "   " },
  CAPITAL_TIMEOUT,
  GITHUB_HEDGE_AS_GLAB,
  { kind: "gh", message: HEDGE("GitLab") },
  { kind: "jira", message: HEDGE("Jira") },
  { kind: "git", message: HEDGE("GitHub") },
  { kind: "gh", message: `Error: ${HEDGE("GitHub")}` },
  { kind: "bitbucket", message: "The branch was pushed. " },
  {
    kind: "bitbucket",
    message:
      "The branch was pushed, but creating the pull request failed: Bitbucket API error (400): source branch not found",
  },
  {
    kind: "gh",
    message:
      "GitHub didn't answer in time, so the project may still have been created. Check for it before trying again.\ngit operation timed out after 120s",
  },
];

/** Null when `predicate` rejects every NOT_LANDED row. */
function falseRowsMismatch(predicate = mayHaveLanded) {
  const hit = NOT_LANDED.findIndex((e) => predicate(e));
  return hit === -1 ? null : `row ${hit} read as may-have-landed`;
}

/** Null when `Timeout`'s own Display text, read from error.rs, is NOT
 *  may-have-landed under `predicate`. */
function bareTimeoutMismatch(src, predicate = mayHaveLanded) {
  const m = src.match(/#\[error\("((?:[^"\\]|\\.)*)"\)\]\s*Timeout\(u64\)/);
  if (m === null) return "Timeout's #[error] text not found";
  const message = m[1].replace("{0}", "120");
  if (/[{}\\]/.test(message)) return "a placeholder this pin can't fill";
  return predicate({ kind: "timeout", message })
    ? `${JSON.stringify(message)} read as may-have-landed`
    : null;
}

test("attached_run_failure's lines lead with the TS rule's leads", () => {
  const src = read(RUST);
  assert.equal(attachedMismatch(src), null);
  assert.deepEqual(attachedLines(src), [
    [
      "Create",
      "Nothing was created because image-1.png didn't upload. Try again.",
    ],
    [
      "PrCreate",
      "The branch was pushed, but the pull request wasn't created because image-1.png didn't upload. Try again.",
    ],
    [
      "Post",
      "Nothing was posted because image-1.png didn't upload. Try again.",
    ],
  ]);
});

test("the branch-pushed headline is gh's alone", () => {
  const line = `${BRANCH_PUSHED_DISCLOSURE}image-1.png didn't upload. Try again.`;
  const message = `${line}\n${TRANSPORT_TAIL}`;
  assert.equal(presentError({ kind: "gh", message }).summary, line);
  // Bitbucket keeps any app sentence on line one by its own rule, so only glab
  // shows the gh rule not claiming it.
  assert.notEqual(presentError({ kind: "glab", message }).summary, line);
});

test("edit_body_dropped_text's sentence leads with the TS lead and carries the saved-changes marker", () => {
  assert.equal(droppedMismatch(read(RUST)), null);
});

test("every write_timed_out sentence reads as may-have-landed and presents as Timed out", () => {
  const src = read(FORGE);
  assert.equal(timedOutMismatch(src), null);
  const messages = timedOutMessages(src);
  assert.ok(Array.isArray(messages) && messages.length >= 4 * 2 * 3);
  assert.equal(falseRowsMismatch(), null);
  assert.equal(bareTimeoutMismatch(read(ERROR)), null);
});

test("both pins fail on a reworded, renamed or duplicated Rust source", () => {
  const src = read(RUST);
  const lead = '=> "Nothing was created because"';
  const pushed = '"The branch was pushed, but the pull request';
  const marker = "Your other changes were saved.";
  const droppedLead = "\"The description wasn't saved because";
  assert.ok(
    src.includes(lead) &&
      src.includes(pushed) &&
      src.includes(marker) &&
      src.includes(droppedLead),
  );
  const swap = (from, to) => src.replace(from, () => to);
  const attachedMutants = [
    ["a reworded lead", swap(lead, '=> "Nothing got created because"')],
    ["a dropped because", swap(lead, '=> "Nothing was created."')],
    [
      "a reworded push lead",
      swap(pushed, '"The branch was pushed but the pull request'),
    ],
    ["a dropped arm", swap('=> "Nothing was posted because",', "=> return x,")],
    ["a renamed fn", swap("fn attached_run_failure(", "fn run_failure(")],
    ["a duplicated fn", `${src}\nfn attached_run_failure() {\n}\n`],
  ];
  for (const [name, mutant] of attachedMutants)
    assert.notEqual(attachedMismatch(mutant), null, `mutant passed: ${name}`);
  const droppedMutants = [
    ["a reworded marker", swap(marker, "The rest was saved.")],
    [
      "a reworded lead",
      swap(droppedLead, '"The description was not saved because'),
    ],
    [
      "a lead moved off the start",
      swap(droppedLead, `"Edit: ${droppedLead.slice(1)}`),
    ],
    ["a line break before the marker", swap(marker, `\\n${marker}`)],
    ["a renamed fn", swap("fn edit_body_dropped_text(", "fn dropped_text(")],
  ];
  for (const [name, mutant] of droppedMutants)
    assert.notEqual(droppedMismatch(mutant), null, `mutant passed: ${name}`);
});

test("the may-have-landed pins fail on a mutated sentence or predicate", () => {
  const forge = read(FORGE);
  const sentence = "\"{host} didn't answer in time, so the {noun}";
  assert.ok(forge.includes(sentence));
  const sourceMutants = [
    [
      "a sentence with the bare lead",
      forge.replace(
        sentence,
        () => `"git operation timed out; ${sentence.slice(1)}`,
      ),
    ],
    [
      "a renamed fn",
      forge.replace("fn write_timed_out(", () => "fn timed_out("),
    ],
    [
      "an arm the reader can't see",
      forge.replace(
        "LandedWrite::Posted => format!(",
        () => "LandedWrite::Posted => fmt!(",
      ),
    ],
  ];
  for (const [name, mutant] of sourceMutants)
    assert.notEqual(timedOutMismatch(mutant), null, `mutant passed: ${name}`);
  const errorSrc = read(ERROR);
  const noLead = (e) =>
    typeof e === "object" && e !== null && e.kind === "timeout";
  assert.notEqual(falseRowsMismatch(noLead), null, "ignoring the lead");
  assert.notEqual(
    bareTimeoutMismatch(errorSrc, noLead),
    null,
    "ignoring the lead",
  );
  const noKind = (e) =>
    typeof e === "object" &&
    e !== null &&
    typeof e.message === "string" &&
    !e.message.startsWith("git operation timed out");
  assert.notEqual(falseRowsMismatch(noKind), null, "ignoring the kind");
});

test("every created_reply_unreadable sentence reads as may-have-landed under its forge's label", () => {
  const forge = read(FORGE);
  const errorSrc = read(ERROR);
  assert.equal(unreadReplyMismatch(forge, errorSrc), null);
  const got = unreadReplyMessages(forge, errorSrc);
  assert.deepEqual(
    [got.template, got.lead],
    [
      "{pushed}{host} accepted the request but its reply couldn't be read, so the {noun} may already exist. Check before creating it again.",
      "The branch was pushed. ",
    ],
  );
  assert.deepEqual(
    [...new Set(got.messages.map(({ host, kind }) => `${kind}:${host}`))],
    ["gh:GitHub", "glab:GitLab", "bitbucket:Bitbucket"],
  );
  assert.equal(falseRowsMismatch(), null);
});

test("the unread-reply pin fails on a mutated sentence, source or predicate", () => {
  const forge = read(FORGE);
  const errorSrc = read(ERROR);
  const swap = (from, to) => {
    assert.ok(forge.includes(from), `missing: ${from}`);
    return forge.replace(from, () => to);
  };
  const fnHead = "fn created_reply_unreadable(";
  const sourceMutants = [
    [
      "a reworded sentence",
      swap(
        "couldn't be read, so the {noun}",
        "could not be read, so the {noun}",
      ),
    ],
    [
      "a reworded lead",
      swap('"The branch was pushed. "', '"The branch was pushed, "'),
    ],
    ["a renamed fn", swap(fnHead, "fn reply_unreadable(")],
    [
      "a duplicated fn",
      `${forge}\npub(crate) fn created_reply_unreadable() {\n}\n`,
    ],
    ["a dropped provider arm", swap('Provider::Bitbucket => "Bitbucket",', "")],
    [
      "an added provider arm",
      swap(
        'Provider::Bitbucket => "Bitbucket",',
        'Provider::Bitbucket => "Bitbucket",\n        Provider::Gitea => "Gitea",',
      ),
    ],
    [
      "a swapped variant",
      swap(
        "Provider::GitLab => AppError::Glab(message)",
        "Provider::GitLab => AppError::Gh(message)",
      ),
    ],
    [
      "the literal moved off format!",
      swap("let message = format!(", "let message = concat!("),
    ],
  ];
  for (const [name, mutant] of sourceMutants) {
    assert.notEqual(mutant, forge, `${name}: changed nothing`);
    assert.notEqual(
      unreadReplyMismatch(mutant, errorSrc),
      null,
      `mutant passed: ${name}`,
    );
  }
  const isError = (e) => typeof e === "object" && e !== null;
  const hosts = { gh: "GitHub", glab: "GitLab", bitbucket: "Bitbucket" };
  const lead = " accepted the request but its reply couldn't be read, so the ";
  // Accepts any forge host under any forge kind.
  const anyHost = (e) =>
    mayHaveLanded(e) ||
    (isError(e) &&
      e.kind in hosts &&
      Object.values(hosts).some((h) =>
        e.message.replace(/^The branch was pushed\. /, "").startsWith(h + lead),
      ));
  assert.equal(
    falseRowsMismatch(anyHost),
    `row ${NOT_LANDED.indexOf(GITHUB_HEDGE_AS_GLAB)} read as may-have-landed`,
  );
  // Reads the sentence without stripping the push lead.
  const noPushLead = (e) =>
    isError(e) && e.kind in hosts
      ? e.message.startsWith(hosts[e.kind] + lead)
      : mayHaveLanded(e);
  assert.match(
    unreadReplyMismatch(forge, errorSrc, noPushLead) ?? "",
    /not may-have-landed: The branch was pushed\. /,
  );
  const timeoutLeads = ["git operation timed out", "Git operation timed out"];
  // A timeout arm without the emptiness check.
  const noEmptyCheck = (e) =>
    isError(e) && e.kind === "timeout"
      ? !timeoutLeads.some((l) => e.message.startsWith(l))
      : mayHaveLanded(e);
  assert.equal(
    falseRowsMismatch(noEmptyCheck),
    `row ${NOT_LANDED.indexOf(EMPTY_TIMEOUT)} read as may-have-landed`,
  );
  // A timeout arm checking only the first lead.
  const firstLeadOnly = (e) =>
    isError(e) && e.kind === "timeout"
      ? e.message.trim() !== "" && !e.message.startsWith(timeoutLeads[0])
      : mayHaveLanded(e);
  assert.equal(
    falseRowsMismatch(firstLeadOnly),
    `row ${NOT_LANDED.indexOf(CAPITAL_TIMEOUT)} read as may-have-landed`,
  );
  // The timed-out messages stay may-have-landed and "Timed out" under the change.
  assert.equal(timedOutMismatch(forge), null);
});
