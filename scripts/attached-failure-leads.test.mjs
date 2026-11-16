// Pins the app sentences Rust writes for a failed or timed-out forge write to the
// rules that read them in src/lib/error-summary.ts. `attached_run_failure`'s line
// (src-tauri/src/github/pr.rs) must start with one of NOTHING_EXISTS_DISCLOSURES or
// BRANCH_PUSHED_DISCLOSURE, or the summary rewrites it as a network failure;
// `edit_body_dropped_text`'s must start with SAVED_DISCLOSURE_LEAD and carry the
// saved-changes marker `otherChangesSaved` keys on; and every `landed_lead`
// sentence (src-tauri/src/forge/mod.rs), under `write_timed_out`'s CLI line and
// `request_timed_out`'s transport line, must read as `mayHaveLanded` while a bare
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
  BRANCH_PUSHED_FAILED_LEAD,
  isTransportError,
  mayHaveLanded,
  NOTHING_EXISTS_DISCLOSURES,
  otherChangesSaved,
  presentError,
  SAVED_DISCLOSURE_LEAD,
} = await import("@/lib/error-summary");

const RUST = new URL("../src-tauri/src/github/pr.rs", import.meta.url);
const FORGE = new URL("../src-tauri/src/forge/mod.rs", import.meta.url);
const ERROR = new URL("../src-tauri/src/error.rs", import.meta.url);
const GITLAB = new URL("../src-tauri/src/forge/gitlab.rs", import.meta.url);
const BITBUCKET = new URL(
  "../src-tauri/src/forge/bitbucket.rs",
  import.meta.url,
);
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

const NOUNS = ["issue", "pull request", "merge request", "repository"];
const TIMEOUT_HOSTS = ["GitHub", "GitLab", "Bitbucket", "Jira"];
/** A transport line 2, as `request_timed_out` receives it from a Bitbucket or Jira send. */
const SENT_TIMEOUT = (host) =>
  `${host} request failed: error sending request for url (https://api.example.test/x): request timed out`;

/** Every two-line message `landed_lead`'s arms can lead, under `write_timed_out`'s
 *  CLI line (or, with `builder` "request_timed_out", that twin's transport line),
 *  filled for every host and noun; or the reason the source can't be read. */
function timedOutMessages(src, builder = "write_timed_out") {
  const enumBody = src.match(/enum LandedWrite \{([^}]*)\}/);
  if (enumBody === null) return "enum LandedWrite not found";
  const variants = [...enumBody[1].matchAll(/^\s*(\w+)(?:\(|,)/gm)].map(
    (m) => m[1],
  );
  if (variants.length === 0) return "no LandedWrite variants read";
  const body = fnBody(src, "landed_lead");
  if (body === null) return "landed_lead not found exactly once";
  const twin = fnBody(src, builder);
  if (twin === null) return `${builder} not found exactly once`;
  if (!twin.includes("landed_lead(host, write)"))
    return `${builder} doesn't lead with landed_lead`;
  const arms = [
    ...body.matchAll(
      /LandedWrite::(\w+)(?:\(\w+\))? => format!\(\s*"((?:[^"\\]|\\.)*)"/g,
    ),
  ].map((m) => [m[1], m[2]]);
  if (arms.length !== variants.length)
    return `read ${arms.length} sentences for ${variants.length} variants`;
  const joined = twin.match(
    /WriteTimedOut\(format!\(\s*"((?:[^"\\]|\\.)*)"\)\)/,
  );
  if (joined === null) return "no two-line WriteTimedOut literal";
  const messages = [];
  for (const [variant, sentence] of arms) {
    for (const host of TIMEOUT_HOSTS) {
      for (const noun of NOUNS) {
        const line1 = sentence
          .replaceAll("{host}", host)
          .replaceAll("{noun}", noun);
        const message = joined[1]
          .replace("{lead}", line1)
          .replaceAll("{host}", host)
          .replace("{seconds}", "150")
          .replace("{detail}", SENT_TIMEOUT(host))
          .replace("\\n", "\n");
        if (/[{}\\]/.test(message))
          return `${variant}: a placeholder or escape this pin can't fill`;
        messages.push([variant, line1, message]);
      }
    }
  }
  return messages;
}

/** Null when every landed message, under both builders, reads as may-have-landed
 *  under `predicate` and presents as "Timed out" with line one as its summary; a
 *  transport line 2 also stays a transport error. */
function timedOutMismatch(src, predicate = mayHaveLanded) {
  for (const builder of ["write_timed_out", "request_timed_out"]) {
    const messages = timedOutMessages(src, builder);
    if (typeof messages === "string") return messages;
    for (const [variant, line1, message] of messages) {
      if (message.split("\n").length !== 2)
        return `${builder} ${variant}: not two lines`;
      const error = { kind: "timeout", message };
      if (!predicate(error))
        return `${builder} ${variant}: not may-have-landed`;
      const p = presentError(error);
      if (p.label !== "Timed out") return `${variant}: label ${p.label}`;
      if (p.summary !== line1) return `${variant}: summary ${p.summary}`;
      if (builder === "request_timed_out" && !isTransportError(error))
        return `${variant}: the transport line 2 isn't a transport error`;
    }
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
  const literal = formatLiteral(body);
  if (literal === null) return "no format! literal";
  // The text after `{host}` is a const every unread-reply builder shares; fill it from
  // its one definition.
  const consts = [
    ...forgeSrc.matchAll(
      /const UNREAD_REPLY_LEAD: &str =\s*"((?:[^"\\]|\\.)*)";/g,
    ),
  ];
  if (consts.length !== 1)
    return `read ${consts.length} UNREAD_REPLY_LEAD, want 1`;
  const template = literal.replaceAll("{UNREAD_REPLY_LEAD}", consts[0][1]);
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

const JIRA_NOUNS = ["issue", "comment", "worklog"];

/** Null when `jira_reply_unreadable`'s literal is `created_reply_unreadable`'s
 *  template with no push lead and host Jira, rides kind `jira`, and each noun's
 *  sentence reads as may-have-landed only under that kind (labelled "Jira error",
 *  the whole sentence its summary). */
function jiraReplyMismatch(forgeSrc, errorSrc, predicate = mayHaveLanded) {
  const read = unreadReplyMessages(forgeSrc, errorSrc);
  if (typeof read === "string") return read;
  const body = fnBody(forgeSrc, "jira_reply_unreadable");
  if (body === null) return "jira_reply_unreadable not found exactly once";
  if (body.match(/format!\(/g)?.length !== 1) return "want one format! call";
  if (body.match(/AppError::\w+\(/g)?.join() !== "AppError::Jira(")
    return "want the one variant AppError::Jira";
  const literal = formatLiteral(body);
  if (literal === null) return "no format! literal";
  const consts = [
    ...forgeSrc.matchAll(
      /const UNREAD_REPLY_LEAD: &str =\s*"((?:[^"\\]|\\.)*)";/g,
    ),
  ];
  if (consts.length !== 1)
    return `read ${consts.length} UNREAD_REPLY_LEAD, want 1`;
  const jira = literal.replaceAll("{UNREAD_REPLY_LEAD}", consts[0][1]);
  const want = read.template
    .replaceAll("{pushed}", "")
    .replaceAll("{host}", "Jira");
  if (jira !== want)
    return `literal ${JSON.stringify(jira)}, want ${JSON.stringify(want)}`;
  const kinds = [...errorSrc.matchAll(/AppError::Jira\(_\) => "(\w+)"/g)];
  if (kinds.length !== 1) return `Jira: ${kinds.length} kind arms`;
  const kind = kinds[0][1];
  for (const noun of JIRA_NOUNS) {
    const message = jira.replaceAll("{noun}", noun);
    if (/[{}\\\n]/.test(message)) return "a placeholder, escape or line break";
    if (!predicate({ kind, message })) return `${noun}: not may-have-landed`;
    const p = presentError({ kind, message });
    if (p.label !== "Jira error") return `${noun}: label ${p.label}`;
    if (p.summary !== message) return `${noun}: summary ${p.summary}`;
    for (const other of ["gh", "glab", "bitbucket", "git"])
      if (predicate({ kind: other, message }))
        return `${noun}: may-have-landed under ${other}`;
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
  { kind: "jira", message: HEDGE("GitHub") },
  { kind: "git", message: HEDGE("GitHub") },
  { kind: "git", message: HEDGE("Jira") },
  { kind: "gh", message: HEDGE("Jira") },
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
  // Five LandedWrite arms, four hosts, four nouns, per builder.
  for (const builder of ["write_timed_out", "request_timed_out"]) {
    const messages = timedOutMessages(src, builder);
    assert.ok(Array.isArray(messages), String(messages));
    assert.equal(messages.length, 5 * 4 * 4);
  }
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
      "a renamed twin",
      forge.replace("fn request_timed_out(", () => "fn request_timeout("),
    ],
    [
      "a twin off the shared lead",
      (() => {
        const b = fnBody(forge, "request_timed_out");
        return forge.replace(b, () =>
          b.replace("landed_lead(host, write)", "other_lead(host, write)"),
        );
      })(),
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
      swap("couldn't be read, so the \";", 'could not be read, so the ";'),
    ],
    [
      "a second shared lead",
      `${forge}\nconst UNREAD_REPLY_LEAD: &str = "x";\n`,
    ],
    [
      "the shared lead dropped from the literal",
      swap("{host}{UNREAD_REPLY_LEAD}{noun}", "{host} {noun}"),
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

/** Each after-push wrap: its kind, source, mapper, the literal's cause
 *  placeholder, the noun, and a transport failure in that route's own shape (gh
 *  and glab put it on line two, Bitbucket's wrap is one line). */
const PUSH_WRAPS = [
  {
    kind: "gh",
    url: RUST,
    name: "after_push_error",
    placeholder: "{detail}",
    noun: "pull request",
    transport: (wrap) => `${wrap("gh: request failed")}\n${TRANSPORT_TAIL}`,
  },
  {
    kind: "glab",
    url: GITLAB,
    name: "mr_post_error",
    placeholder: "{detail}",
    noun: "merge request",
    transport: (wrap) =>
      `${wrap("glab: request failed")}\nPost "https://gitlab.com/api/v4/projects/g%2Fp/merge_requests": dial tcp: lookup gitlab.com: no such host`,
  },
  {
    kind: "bitbucket",
    url: BITBUCKET,
    name: "pr_post_error",
    placeholder: "{detail}",
    noun: "pull request",
    transport: (wrap) =>
      wrap(
        "Bitbucket request failed: error sending request for url (https://api.bitbucket.org/2.0/repositories/w/r/pullrequests): connection failed",
      ),
  },
];

const HOSTS = { gh: "GitHub", glab: "GitLab", bitbucket: "Bitbucket" };

/** Causes the network rewrite must leave alone: an answered status or a limit. */
const VERDICT_CAUSES = [
  "HTTP 401: Bad credentials (https://api.github.com/graphql)",
  "HTTP 403: Resource not accessible by integration",
  "HTTP 429: Too Many Requests",
  "API rate limit exceeded for user ID 1.",
];

/** Per route, a function filling the Rust wrap literal with a cause, or the
 *  reason the source can't be read. */
function pushWraps(sources) {
  const wraps = [];
  for (const route of PUSH_WRAPS) {
    const body = fnBody(sources[route.kind], route.name);
    if (body === null) return `${route.name} not found exactly once`;
    if (body.match(/format!\(/g)?.length !== 1)
      return `${route.name}: want one format! call`;
    const literal = formatLiteral(body);
    if (literal === null) return `${route.name}: no format! literal`;
    if (literal.split(route.placeholder).length !== 2)
      return `${route.name}: want one ${route.placeholder}`;
    const wrap = (cause) => literal.replace(route.placeholder, () => cause);
    if (/[{}\\]/.test(wrap("x")))
      return `${route.name}: a placeholder or escape this pin can't fill`;
    wraps.push({ ...route, wrap });
  }
  return wraps;
}

/** Null when every after-push wrap leads with BRANCH_PUSHED_FAILED_LEAD, stays
 *  the summary over an app-side cause and a verdict cause, composes the lead
 *  with the network sentence over a transport cause, and never reads as
 *  may-have-landed; otherwise the reason the pin fails. */
function pushWrapMismatch(sources) {
  const wraps = pushWraps(sources);
  if (typeof wraps === "string") return wraps;
  for (const { kind, name, noun, transport, wrap } of wraps) {
    const lead = `${BRANCH_PUSHED_FAILED_LEAD}${noun} failed: `;
    const plain = wrap("source branch not found");
    if (plain !== `${lead}source branch not found`)
      return `${name}: ${JSON.stringify(plain)} doesn't lead with the TS lead`;
    const network = `Couldn't reach ${HOSTS[kind]} — check your network connection.`;
    const message = transport(wrap);
    const rows = [
      [plain, plain],
      [message, `${lead}${network}`],
      ...VERDICT_CAUSES.map((cause) => [
        kind === "bitbucket"
          ? wrap(cause)
          : `${wrap(cause)}\n${TRANSPORT_TAIL}`,
        wrap(cause),
      ]),
    ];
    for (const [text, want] of rows) {
      const error = { kind, message: text };
      const p = presentError(error);
      if (p.summary !== want)
        return `${name}: summary ${JSON.stringify(p.summary)} for ${JSON.stringify(text)}`;
      if (p.fullText !== text) return `${name}: fullText ${p.fullText}`;
      if (mayHaveLanded(error)) return `${name}: read as may-have-landed`;
    }
    if (!presentError({ kind, message }).long)
      return `${name}: the raw transport text isn't behind Details`;
    // The same composed line under a kind the rule doesn't own is not claimed.
    for (const other of ["jira", "git"])
      if (
        presentError({ kind: other, message }).summary === `${lead}${network}`
      )
        return `${name}: claimed under kind ${other}`;
  }
  return null;
}

const pushSources = () => ({
  gh: read(RUST),
  glab: read(GITLAB),
  bitbucket: read(BITBUCKET),
});

test("jira_reply_unreadable is the shared template under kind jira, may-have-landed only there", () => {
  const forge = read(FORGE);
  const errorSrc = read(ERROR);
  assert.equal(jiraReplyMismatch(forge, errorSrc), null);
  assert.equal(
    mayHaveLanded({ kind: "jira", message: HEDGE("Jira", "worklog") }),
    true,
  );
  assert.equal(falseRowsMismatch(), null);
});

test("the Jira pin fails on a mutated literal, variant or predicate", () => {
  const forge = read(FORGE);
  const errorSrc = read(ERROR);
  const swap = (from, to) => {
    assert.ok(forge.includes(from), `missing: ${from}`);
    return forge.replace(from, () => to);
  };
  const mutants = [
    [
      "a reworded literal",
      swap('"Jira{UNREAD_REPLY_LEAD}{noun} may', '"Jira {noun} may'),
    ],
    [
      "a push lead",
      swap(
        '"Jira{UNREAD_REPLY_LEAD}',
        '"The branch was pushed. Jira{UNREAD_REPLY_LEAD}',
      ),
    ],
    [
      "a swapped variant",
      swap("AppError::Jira(format!(", "AppError::Gh(format!("),
    ],
    ["a renamed fn", swap("fn jira_reply_unreadable(", "fn jira_unread(")],
    ["a duplicated fn", `${forge}\nfn jira_reply_unreadable() {\n}\n`],
  ];
  for (const [name, mutant] of mutants) {
    assert.notEqual(mutant, forge, `${name}: changed nothing`);
    assert.notEqual(
      jiraReplyMismatch(mutant, errorSrc),
      null,
      `mutant passed: ${name}`,
    );
  }
  // A predicate without the Jira host, and one that ignores the kind.
  const noJira = (e) => mayHaveLanded(e) && e.kind !== "jira";
  assert.match(
    jiraReplyMismatch(forge, errorSrc, noJira) ?? "",
    /not may-have-landed/,
  );
  const anyKind = (e) =>
    mayHaveLanded(e) || mayHaveLanded({ kind: "jira", message: e?.message });
  assert.match(jiraReplyMismatch(forge, errorSrc, anyKind) ?? "", /under gh/);
  assert.notEqual(
    falseRowsMismatch(
      (e) =>
        mayHaveLanded(e) ||
        (e?.kind === "jira" && e.message.includes("so the")),
    ),
    null,
  );
});

test("the after-push wraps lead with the TS lead and compose with the network sentence", () => {
  const sources = pushSources();
  assert.equal(pushWrapMismatch(sources), null);
  const wraps = pushWraps(sources);
  assert.ok(Array.isArray(wraps));
  assert.deepEqual(
    wraps.map(({ kind, wrap }) => [kind, wrap("x")]),
    [
      ["gh", "The branch was pushed, but creating the pull request failed: x"],
      [
        "glab",
        "The branch was pushed, but creating the merge request failed: x",
      ],
      [
        "bitbucket",
        "The branch was pushed, but creating the pull request failed: x",
      ],
    ],
  );
  // No ` failed: ` past the lead leaves nothing to replace, so the line stands.
  const odd = `${BRANCH_PUSHED_FAILED_LEAD}pull request broke`;
  assert.equal(
    presentError({ kind: "gh", message: `${odd}\n${TRANSPORT_TAIL}` }).summary,
    odd,
  );
});

test("the after-push pin fails on a reworded, renamed or duplicated Rust source", () => {
  const sources = pushSources();
  // Each mutation lands inside the mapper's own body, never on a test's copy.
  const mutate = (kind, name, from, to) => {
    const body = fnBody(sources[kind], name);
    assert.ok(body?.includes(from), `missing in ${name}: ${from}`);
    const mutated = body.replace(from, () => to);
    return { ...sources, [kind]: sources[kind].replace(body, () => mutated) };
  };
  const mutants = [
    [
      "a reworded GitHub lead",
      mutate(
        "gh",
        "after_push_error",
        '"The branch was pushed, but',
        '"The branch was pushed but',
      ),
    ],
    [
      "a reworded GitLab noun",
      mutate("glab", "mr_post_error", "the merge request", "the MR"),
    ],
    [
      "a dropped Bitbucket cause separator",
      mutate(
        "bitbucket",
        "pr_post_error",
        "failed: {detail}",
        "failed {detail}",
      ),
    ],
    [
      "a renamed fn",
      mutate("glab", "mr_post_error", "fn mr_post_error(", "fn post_error("),
    ],
    [
      "a duplicated fn",
      {
        ...sources,
        bitbucket: `${sources.bitbucket}\nfn pr_post_error() {\n}\n`,
      },
    ],
    [
      "the literal moved off format!",
      mutate(
        "gh",
        "after_push_error",
        "AppError::Gh(format!(",
        "AppError::Gh(concat!(",
      ),
    ],
  ];
  for (const [label, mutant] of mutants)
    assert.notEqual(pushWrapMismatch(mutant), null, `mutant passed: ${label}`);
});

// Bitbucket's compound review wraps (request_changes_pr, review_submit in
// src-tauri/src/forge/bitbucket.rs) embed a step's error after their partial-state
// line. A timed-out step makes the message two lines, so line one, disclosure
// included, must stay the summary over the transport line beneath it.
const BB_TIMED_OUT =
  "Bitbucket didn't answer in time, so your change may still have gone through. Check before trying again.\nBitbucket request failed: error sending request for url (https://api.bitbucket.org/2.0/repositories/ws/app/pullrequests/1/comments): request timed out";
const BB_UNREAD = (noun) =>
  `Bitbucket accepted the request but its reply couldn't be read, so the ${noun} may already exist. Check before creating it again.`;
/** The one `format!` literal in `body` holding `marker`, its line continuations
 *  joined, or null when not exactly one does. */
function wrapLiteral(body, marker) {
  const all = [...body.matchAll(/format!\(\s*"((?:[^"\\]|\\[\s\S])*)"/g)]
    .map((m) => m[1].replace(/\\\r?\n\s*/g, ""))
    .filter((l) => l.includes(marker));
  return all.length === 1 ? all[0] : null;
}

/** `paren_parts`' split: line one inside the parentheses, the rest after them. */
function parenFill(literal, e) {
  const cut = e.indexOf("\n");
  const [first, rest] = cut === -1 ? [e, ""] : [e.slice(0, cut), e.slice(cut)];
  return literal.replace("({first}){rest}", () => `(${first})${rest}`);
}

/** `[wrap, noun]` per compound wrap, each filling its Rust literal the way the
 *  wrap embeds the error (noun: the create a reply hedge names, null for the
 *  verdict), or the reason the source can't be read. */
function bbWraps(src) {
  const changes = fnBody(src, "request_changes_pr");
  const review = fnBody(src, "review_submit");
  if (changes === null || review === null) return "a wrap fn not found exactly once";
  const rows = [
    [changes, "Changes were requested, but posting the comment failed", "{e}", "comment"],
    [review, "The review summary couldn't be posted", "{e}", "review summary"],
    [review, "review comments before the failure", "({first}){rest}", "review comment"],
    [review, "The review was posted, but the {action} step failed", "({first}){rest}", null],
  ];
  const landed = wrapLiteral(review, "were already posted successfully");
  if (landed === null) return "no landed literal";
  const wraps = [];
  for (const [body, marker, token, noun] of rows) {
    const literal = wrapLiteral(body, marker);
    if (literal === null) return `no single literal holding ${marker}`;
    if (literal.split(token).length !== 2) return `${marker}: want one ${token}`;
    const filled = literal
      .replace("Posted {} of {}", "Posted 2 of 3")
      .replaceAll("{action}", "approve")
      .replace("{landed}", () => landed.replace("{n}", "3"));
    const wrap = (e) =>
      token === "{e}" ? filled.replace(token, () => e) : parenFill(filled, e);
    if (/[{}\\]/.test(wrap("x")))
      return `${marker}: a placeholder or escape this pin can't fill`;
    wraps.push([wrap, noun]);
  }
  return wraps;
}

/** Whether every `(` in `line` closes on it. */
function balanced(line) {
  let depth = 0;
  for (const c of line) {
    depth += c === "(" ? 1 : c === ")" ? -1 : 0;
    if (depth < 0) return false;
  }
  return depth === 0;
}

/** Null when each wrap keeps its partial-state line one as the summary, closes its
 *  parentheses on that line, and embeds every error's first line; otherwise the
 *  reason the pin fails. */
function bbWrapMismatch(src) {
  const wraps = bbWraps(src);
  if (typeof wraps === "string") return wraps;
  for (const [wrap, noun] of wraps) {
    const embedded = noun === null ? [BB_TIMED_OUT] : [BB_TIMED_OUT, BB_UNREAD(noun)];
    for (const e of embedded) {
      const message = wrap(e);
      const line1 = message.split("\n")[0];
      if (!line1.includes(e.split("\n")[0])) return `not embedded: ${message}`;
      if (!balanced(line1)) return `line one leaves a parenthesis open: ${line1}`;
      const summary = presentError({ kind: "bitbucket", message }).summary;
      if (summary !== line1) return `summary ${JSON.stringify(summary)} for ${message}`;
    }
  }
  return null;
}

test("Bitbucket's compound review wraps keep their partial-state line as the summary", () => {
  const src = read(BITBUCKET);
  assert.equal(bbWrapMismatch(src), null);
  const wraps = bbWraps(src);
  // A one-line error sits inside the parentheses, as the wrap always set it.
  assert.ok(wraps[2][0]("boom").endsWith(" retrying. (boom)"), wraps[2][0]("boom"));
  // Controls: a reworded literal, the old in-parentheses shape, a dropped error.
  const mutants = [
    ["close after the rest", src.replace("retrying. ({first}){rest}", "retrying. ({first}{rest})")],
    ["the error inside", src.replace("on Bitbucket. ({first}){rest}", "on Bitbucket. ({e})")],
    ["dropped error", src.replace("posting the comment failed: {e}", "posting the comment failed")],
  ];
  for (const [label, mutant] of mutants) {
    assert.notEqual(mutant, src, label);
    assert.notEqual(bbWrapMismatch(mutant), null, `mutant passed: ${label}`);
  }
  // The rewrite this guards against is live for a one-line transport cause.
  const [wrap] = wraps[0];
  const raw = BB_TIMED_OUT.split("\n")[1];
  assert.equal(
    presentError({ kind: "bitbucket", message: wrap(raw) }).summary,
    "Couldn't reach Bitbucket — check your network connection.",
  );
});
