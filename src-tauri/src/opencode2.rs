//! opencode 2.x: everything about a 2.x run that needs no process spawn. The 1.x path in
//! `agent.rs` stays separate and unchanged.
//!
//! The read-only lock rides in `OPENCODE_CONFIG_CONTENT` as an agent defined for one run
//! under a fresh id (`gd` and 32 hex characters), holding a native `permissions` array, and
//! the run selects it with `--agent <id>`. The content document is not the last config
//! layer: a managed-settings config (`/etc/opencode/opencode.json` and its platform twins)
//! loads after it. Two things protect the lock instead. No other document can know the
//! per-run id, so none can attach an agent-level rule to it; and the read-back
//! (`read_back`, over `opencode debug agents` run with the same binary, environment and
//! directory as the run) refuses the run unless every rule after a probe agent's own is a
//! deny over every resource (`*`) or one of opencode's fixed trailing denies: a tool is
//! hidden only while the last rule matching it denies `*`, so a narrower deny after the
//! lock would list a tool the lock hides. The read-back checks that probe, the pin's rules
//! under an id of its own; the lock that runs is built afterwards under a fresh id and is
//! not read back.
//!
//! The rules are default-deny: `* * deny` first, then allows for the tools a pin keeps. A
//! blocklist cannot work: several builtin tools never ask for permission and are stopped
//! only by being hidden, which only a deny over every resource does. No rule is ever `ask`.
//! opencode substitutes `{env:NAME}` and `{file:path}` tokens in a document's raw text
//! before parsing it, so every `{` inside a JSON string is written as its JSON escape.
//!
//! The user's own read rules are mirrored after the lock's allows, read from opencode
//! itself: the resolved list of the builtin `plan` agent when opencode lists it (the agent
//! 1.x read-only runs name, so rules written for it are kept), else the rules ahead of the
//! probe agent's own. A ReadOnly or Research run is refused under an inherited non-empty
//! `OPENCODE_CONFIG_CONTENT`: the lock replaces that variable, so read rules kept there
//! would vanish from both the read-back and the run. A DiffOnly run replaces it too and
//! loses no read rule, since it denies every read.
//!
//! Server allows end in a deny tail of four namespace wildcards (`external_*`,
//! `experimental_*`, `opencode_*`, `console_watch_*`): a server allow `<name>_*` matches
//! only actions holding an underscore, and every builtin key holding one starts with a
//! tail prefix (closed against the tool sources of 2.2.0, 2.2.7 and 2.3.2; MCP and plugin
//! tool ids are dynamic and cannot be closed).
//!
//! Accepted residuals:
//! - plugins are code inside the opencode server, and global ones always load;
//! - grep and glob check only their pattern, so they can reveal lines or names of files
//!   the read rules deny;
//! - the `skill` tool stays listed while loading a skill is denied;
//! - the read tool lists the run directory;
//! - a passed server's `<name>_*` also admits a server from the user's own config whose
//!   sanitized name starts with `<name>_`, and a third-party plugin tool or a future
//!   builtin whose id starts with `<name>_` outside the four tail prefixes;
//! - a passed server whose sanitized name is, or starts with, a tail prefix (`opencode`,
//!   `external`, `experimental`, `console_watch`) gets none of its tools under a lock,
//!   because the tail follows its allow (measured for `opencode`);
//! - rules the user wrote for an agent other than `plan` are not mirrored;
//! - Research's `websearch` provider key replaces the user's own `websearch` setting for
//!   that run, a `false` included;
//! - session rules: opencode evaluates the agent's rules followed by the session's own
//!   (`core/src/permission.ts` around 175-180, the deny check at 199-206). A session's
//!   rules can be set through the server API and child sessions inherit them, and the
//!   read-back lists agent rules only, so a ruleset another client attached to a session
//!   GitDesktop later resumes would land after the lock. `opencode run` has no flag for
//!   it, and reviews and generation never resume a session, so this reaches resumed Plan
//!   and Research sessions only, and only through another client with API access to the
//!   user's opencode;
//! - in a session (project config on), a project `opencode.json` that defines a server
//!   with the same name as one GitDesktop passes replaces it, and that server's tools pass
//!   the lock's `<name>_* * allow`; reviews run with the project layer off and are
//!   unaffected;
//! - `--session <id>` for a session opencode no longer has creates a new, empty session
//!   under the same id and exits 0 (`cli/src/session-target.ts`, 2.3.2), so a resumed turn
//!   can run without the system prompt and without its history, and nothing in the stream
//!   shows it;
//! - a DiffOnly read-back is proven once per binary and opencode version and cached, so it
//!   does not notice a managed-settings layer added afterwards (such a layer still cannot
//!   name the per-run id);
//! - the read tool follows a link inside the run directory, and the rules see only the
//!   link's own path (as on 1.x);
//! - after a read, opencode loads `AGENTS.md` or `CLAUDE.md` from the folders between the
//!   file and the run directory without consulting the read rules (as on 1.x), and follows
//!   a linked one to wherever it points;
//! - `--session` runs in the session's own stored directory, so a session moved by the user
//!   or another client, or a repository relocated in GitDesktop, can run under another
//!   folder's project config than the one the read-back probed;
//! - a rule whose action pattern is anything but the literal `read` (`*`, `r*`, `read*`)
//!   keeps a home-spelled resource (`~`, `$HOME`) literal, while the same rule mirrored onto
//!   `read` is expanded, so the mirrored deny covers the home path instead of the literal one;
//! - passing servers replaces an inherited `OPENCODE_CONFIG`, so a config file named there
//!   (its read rules included) is not loaded for that run, as on 1.x;
//! - the version is read in GitDesktop's own directory, so a per-directory version manager
//!   can run another opencode in the worktree than the one classified.

use std::collections::BTreeMap;

use serde_json::Value;

// ---- version ----

/// An opencode version; a pre-release or build suffix is dropped.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct Version {
    major: u32,
    minor: u32,
    patch: u32,
}

/// The oldest 2.x GitDesktop runs: the tested set starts there, and only from it does 2.x
/// accept `--standalone` in any position.
const MIN_V2: Version = Version {
    major: 2,
    minor: 2,
    patch: 0,
};

/// `opencode run --archived` exists from this release on.
const ARCHIVED_SINCE: Version = Version {
    major: 2,
    minor: 2,
    patch: 6,
};

/// The first non-empty line of `opencode --version` output, trimmed, with ANSI escape
/// sequences removed (a CSI sequence through its final byte; a lone ESC with the next
/// character).
fn version_line(text: &str) -> String {
    let mut clean = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            clean.push(c);
        } else if chars.next() == Some('[') {
            for c in chars.by_ref() {
                if ('\x40'..='\x7e').contains(&c) {
                    break;
                }
            }
        }
    }
    clean
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or_default()
        .to_string()
}

/// The version and its token index: the first non-empty line's token 0 when it reads as a
/// version (1.x), else its token 1 when token 0 is exactly `opencode` (2.x); nothing else
/// is read.
fn parse_version(text: &str) -> Option<(usize, Version)> {
    let line = version_line(text);
    let mut tokens = line.split_whitespace();
    let first = tokens.next()?;
    if let Some(version) = version_token(first) {
        return Some((0, version));
    }
    if first != "opencode" {
        return None;
    }
    Some((1, version_token(tokens.next()?)?))
}

/// `[v|V]MAJOR.MINOR.PATCH`, optionally followed by a `-` or `+` suffix.
fn version_token(token: &str) -> Option<Version> {
    let token = token.strip_prefix(['v', 'V']).unwrap_or(token);
    let mut parts = token.splitn(3, '.');
    let major = version_number(parts.next()?)?;
    let minor = version_number(parts.next()?)?;
    let rest = parts.next()?;
    let end = rest
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(rest.len());
    let patch = version_number(&rest[..end])?;
    match rest[end..].chars().next() {
        None | Some('-' | '+') => Some(Version {
            major,
            minor,
            patch,
        }),
        _ => None,
    }
}

/// One or more ASCII digits that fit a `u32` (`parse` alone would accept a sign).
fn version_number(digits: &str) -> Option<u32> {
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

/// Which command-line generation a resolved opencode binary speaks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Cli {
    V1(Version),
    V2(Version),
}

/// Why a binary is refused before anything else is spawned. `text` is the cleaned first
/// line of its version output, clipped to 80 characters. `Preview` is a version below 2
/// after the word `opencode`: opencode 2's line shape on a preview build.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum VersionRefusal {
    Unparseable { text: String },
    TooNew { text: String },
    TooOld { text: String },
    Preview { text: String },
}

impl VersionRefusal {
    /// The sentence a refused run reports.
    pub(crate) fn message(&self) -> String {
        self.sentence(true)
    }

    /// The same sentence as a standing state (detection, Settings): no "then try again".
    pub(crate) fn standing_message(&self) -> String {
        self.sentence(false)
    }

    fn sentence(&self, run: bool) -> String {
        let end = if run { ", then try again." } else { "." };
        match self {
            Self::Unparseable { text } => {
                let printed = if text.is_empty() {
                    "nothing".to_string()
                } else {
                    format!("\"{text}\"")
                };
                format!(
                    "GitDesktop could not read this opencode's version (it printed {printed}). Update opencode or pick another binary in Settings{end}"
                )
            }
            Self::TooNew { text } => format!(
                "This opencode reports version \"{text}\", which is newer than GitDesktop supports. GitDesktop works with opencode 1.x and 2.x (tested with 2.2.0 to 2.3.2). Update GitDesktop, or pick an opencode 2.x binary in Settings."
            ),
            Self::TooOld { text } => format!(
                "This opencode reports version \"{text}\", which is older than GitDesktop's opencode 2 support needs. Update opencode to 2.2.0 or later (run \"opencode upgrade\"){end}"
            ),
            Self::Preview { text } => format!(
                "This opencode reports version \"{text}\", a preview build GitDesktop can't check. Install a released opencode (1.x, or 2.2.0 or later) or pick another binary in Settings{end}"
            ),
        }
    }
}

/// Classifies `opencode --version` output: 1.x keeps the 1.x path, 2.x from `MIN_V2` takes
/// this module, and anything else is refused. Read is the first non-empty line's token 0
/// when it reads as a version (1.x), else its token 1 when token 0 is exactly `opencode`
/// (2.x); nothing else is read. A version below 2 after `opencode` is a 2.x preview build
/// (versioned `0.0.0-<channel>-<n>`), never 1.x.
pub(crate) fn classify_version(text: &str) -> Result<Cli, VersionRefusal> {
    let shown = || version_line(text).chars().take(80).collect::<String>();
    let Some((index, version)) = parse_version(text) else {
        return Err(VersionRefusal::Unparseable { text: shown() });
    };
    if version.major < 2 && index > 0 {
        Err(VersionRefusal::Preview { text: shown() })
    } else if version.major < 2 {
        Ok(Cli::V1(version))
    } else if version.major >= 3 {
        Err(VersionRefusal::TooNew { text: shown() })
    } else if version >= MIN_V2 {
        Ok(Cli::V2(version))
    } else {
        Err(VersionRefusal::TooOld { text: shown() })
    }
}

// ---- lock ----

/// The id of the agent one pinned spawn defines: `gd` and 32 lowercase hex characters.
/// No constructor takes a string, so every id is freshly minted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AgentId(String);

impl AgentId {
    /// A fresh id. The `uuid` crate's v4 draws its bits from the operating system's random
    /// source (122 of the 128 bits are random), so no other config can know the id.
    fn mint() -> Self {
        Self::from_bits(uuid::Uuid::new_v4().as_u128())
    }

    fn from_bits(bits: u128) -> Self {
        Self(format!("gd{bits:032x}"))
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Effect {
    Allow,
    Deny,
    Ask,
}

impl Effect {
    fn as_str(self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::Deny => "deny",
            Self::Ask => "ask",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        match text {
            "allow" => Some(Self::Allow),
            "deny" => Some(Self::Deny),
            "ask" => Some(Self::Ask),
            _ => None,
        }
    }
}

/// One opencode permission rule; `action` and `resource` are wildcard patterns.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Rule {
    pub(crate) action: String,
    pub(crate) resource: String,
    pub(crate) effect: Effect,
}

fn rule(action: &str, resource: &str, effect: Effect) -> Rule {
    Rule {
        action: action.to_string(),
        resource: resource.to_string(),
        effect,
    }
}

/// The lock kinds. DiffOnly: commit-message, PR-description and branch-name generation and
/// diff-only reviews. ReadOnly: repo-aware reviews, Debug with AI, AI conflict resolve
/// under an agentic review, Plan sessions. Research: the web-enabled read-only session.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Pin {
    DiffOnly,
    ReadOnly,
    Research,
}

/// How opencode compares patterns: case-insensitively when the opencode process runs on
/// Windows (its matcher adds the regex `i` flag there), exactly otherwise.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MatchCase {
    Sensitive,
    Insensitive,
}

/// The user's own rules for the mirrored actions, projected from a read-back. Only
/// `read_back` builds a non-empty one, so a ReadOnly or Research lock cannot skip it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Mirror {
    /// Each rule's `action` is one of `MIRRORED_ACTIONS`, grouped in that order.
    rules: Vec<Rule>,
}

impl Mirror {
    fn empty() -> Self {
        Self { rules: Vec::new() }
    }

    fn group<'a>(&'a self, action: &'a str) -> impl Iterator<Item = &'a Rule> + 'a {
        self.rules.iter().filter(move |rule| rule.action == action)
    }
}

/// A lock kind with the mirror it needs; DiffOnly needs none.
#[derive(Clone, Copy, Debug)]
pub(crate) enum Access<'a> {
    DiffOnly,
    ReadOnly(&'a Mirror),
    Research(&'a Mirror),
}

/// A lock agent: its id, its rules, and the `OPENCODE_CONFIG_CONTENT` document defining it.
#[derive(Clone, Debug)]
pub(crate) struct LockDocument {
    agent: AgentId,
    rules: Vec<Rule>,
    json: String,
}

#[cfg(test)]
impl LockDocument {
    pub(crate) fn agent(&self) -> &AgentId {
        &self.agent
    }

    pub(crate) fn rules(&self) -> &[Rule] {
        &self.rules
    }

    pub(crate) fn json(&self) -> &str {
        &self.json
    }
}

/// Ceiling on a lock document, in UTF-16 code units, the unit Windows counts a variable
/// in. Windows allows 32,767 including `OPENCODE_CONFIG_CONTENT=` and the terminator; this
/// leaves about 2,700 units of margin and stays under Linux's 131,072-byte per-string limit
/// at 3 bytes per unit. A 29,946-character document passed to a container by variable
/// name arrives intact (`main/live-findings.md` M23, v2.3.2).
const LOCK_DOCUMENT_CAP: usize = 30_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum LockError {
    TooLarge { units: usize },
    InheritedContent,
}

impl LockError {
    pub(crate) fn message(&self) -> String {
        match self {
            Self::TooLarge { units } => format!(
                "GitDesktop could not start this read-only opencode run: the read rules in your opencode config are too large to pass along ({units} characters, limit {LOCK_DOCUMENT_CAP}). Shorten the permission rules in your opencode config, then try again."
            ),
            Self::InheritedContent => "GitDesktop did not start this read-only opencode run because the OPENCODE_CONFIG_CONTENT environment variable is set. GitDesktop needs that variable for its read-only lock, and replacing yours could drop read rules you keep there. Move those settings into your opencode config file or unset the variable, then try again.".to_string(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ReadbackError {
    NotJson,
    AgentAbsent,
    NotLast,
}

impl ReadbackError {
    pub(crate) fn message(&self) -> String {
        let detail = match self {
            Self::NotJson => " opencode's agent list was not the JSON GitDesktop expected.",
            Self::AgentAbsent => " opencode did not load the lock.",
            Self::NotLast => " Another opencode setting takes effect after the lock.",
        };
        format!(
            "{READBACK_REFUSAL_LEAD}{detail} Check your opencode config with \"opencode debug config\", or update opencode, then try again."
        )
    }
}

/// The one spelling of the read-back refusal's lead; every lock-refusal sentence starts
/// with it.
pub(crate) const READBACK_REFUSAL_LEAD: &str =
    "GitDesktop could not confirm that opencode applied its read-only lock, so it did not start the run.";

/// The variable that carries the lock document.
pub(crate) const CONTENT_ENV: &str = "OPENCODE_CONFIG_CONTENT";

/// The actions a mirror projects, in lock group order. ReadOnly uses the first three.
const MIRRORED_ACTIONS: [&str; 5] = ["read", "grep", "glob", "webfetch", "websearch"];

/// Every builtin key holding an underscore starts with one of these, and a server allow
/// `<name>_*` can match only such a key, so these denies follow every server allow.
const DENY_TAIL: [&str; 4] = [
    "external_*",
    "experimental_*",
    "opencode_*",
    "console_watch_*",
];

/// The denies opencode appends after every agent's own rules, as (action, resource), read
/// back on 2.2.0, 2.2.7 and 2.3.2.
const FIXED_TAIL_DENIES: [(&str, &str); 2] = [("browser", "*"), ("skill", "browser")];

/// The JSON escape for `{`. opencode substitutes `{env:NAME}` and `{file:path}` tokens in a
/// document's raw text before it parses the JSON, so no `{` may appear inside a string.
const LEFT_BRACE_ESCAPE: &str = concat!('\\', "u007b");

/// opencode's permission matcher (`core/src/util/wildcard.ts`), anchored at both ends and
/// working on UTF-16 code units like a JS regex without the `u` flag: `\` reads as `/` on
/// both sides, `*` matches any run of units (newlines included), `?` exactly one, and a
/// pattern ending in a space and `*` also matches the input before that space.
/// `Insensitive` folds ASCII letters only where JS folds every letter, so this is exact for
/// ASCII inputs, which is all this module passes (the literal mirrored actions).
fn wildcard_match(input: &str, pattern: &str, case: MatchCase) -> bool {
    let units = |text: &str| -> Vec<u16> {
        text.encode_utf16()
            .map(|unit| if unit == BACKSLASH { SLASH } else { unit })
            .collect()
    };
    let input = units(input);
    let pattern = units(pattern);
    if glob_units(&input, &pattern, case) {
        return true;
    }
    match pattern.as_slice() {
        [head @ .., SPACE, STAR] => glob_units(&input, head, case),
        _ => false,
    }
}

const BACKSLASH: u16 = b'\\' as u16;
const SLASH: u16 = b'/' as u16;
const SPACE: u16 = b' ' as u16;
const STAR: u16 = b'*' as u16;
const QUESTION: u16 = b'?' as u16;

/// Anchored `*`/`?` glob over code units, backtracking to the last `*`.
fn glob_units(input: &[u16], pattern: &[u16], case: MatchCase) -> bool {
    let (mut i, mut p) = (0, 0);
    let mut last_star: Option<(usize, usize)> = None;
    while i < input.len() {
        if pattern.get(p) == Some(&STAR) {
            last_star = Some((p + 1, i));
            p += 1;
        } else if pattern
            .get(p)
            .is_some_and(|&unit| unit == QUESTION || same_unit(unit, input[i], case))
        {
            p += 1;
            i += 1;
        } else if let Some((after_star, from)) = last_star {
            p = after_star;
            i = from + 1;
            last_star = Some((after_star, from + 1));
        } else {
            return false;
        }
    }
    pattern[p..].iter().all(|&unit| unit == STAR)
}

fn same_unit(a: u16, b: u16, case: MatchCase) -> bool {
    let fold = |unit: u16| {
        if (u16::from(b'A')..=u16::from(b'Z')).contains(&unit) {
            unit + 32
        } else {
            unit
        }
    };
    match case {
        MatchCase::Sensitive => a == b,
        MatchCase::Insensitive => fold(a) == fold(b),
    }
}

/// opencode's rule evaluation: the last rule whose action and resource both match, `Ask`
/// when none does (`core/src/permission.ts`).
#[cfg(test)]
fn evaluate(action: &str, resource: &str, rules: &[Rule], case: MatchCase) -> Effect {
    rules
        .iter()
        .rev()
        .find(|rule| {
            wildcard_match(action, &rule.action, case)
                && wildcard_match(resource, &rule.resource, case)
        })
        .map_or(Effect::Ask, |rule| rule.effect)
}

/// opencode hides a tool when the last rule whose action matches denies every resource
/// (`core/src/tool.ts`).
#[cfg(test)]
fn wholly_disabled(action: &str, rules: &[Rule], case: MatchCase) -> bool {
    rules
        .iter()
        .rev()
        .find(|rule| wildcard_match(action, &rule.action, case))
        .is_some_and(|rule| rule.resource == "*" && rule.effect == Effect::Deny)
}

/// opencode's tool-key sanitizer (every UTF-16 unit outside `[A-Za-z0-9_-]` becomes `_`),
/// the twin of the 1.x one in `agent.rs`.
fn sanitize_server(name: &str) -> String {
    name.encode_utf16()
        .map(|unit| match char::from_u32(u32::from(unit)) {
            Some(c) if c.is_ascii_alphanumeric() || c == '_' || c == '-' => c,
            _ => '_',
        })
        .collect()
}

/// One `<sanitized>_* * allow` per passed server in input order; an empty name and a
/// repeat of an earlier sanitized name add nothing.
fn server_allows(mcp_servers: &[&str]) -> Vec<Rule> {
    let mut seen: Vec<String> = Vec::new();
    let mut allows = Vec::new();
    for name in mcp_servers {
        let sanitized = sanitize_server(name);
        if sanitized.is_empty() || seen.contains(&sanitized) {
            continue;
        }
        allows.push(rule(&format!("{sanitized}_*"), "*", Effect::Allow));
        seen.push(sanitized);
    }
    allows
}

/// The lock's rules, `* * deny` first and never an `ask`. Each kept tool's allow is
/// followed by the mirrored rules for it, rewritten to the literal action. A read group
/// that ends in a deny over every resource gets `read ?* deny`, so the read tool stays
/// listed with every path denied (a run with no tool at all is not relied on). DiffOnly
/// emits the server allows and the tail only when it has a server allow to guard.
fn lock_rules(access: Access<'_>, mcp_servers: &[&str]) -> Vec<Rule> {
    let mut rules = vec![rule("*", "*", Effect::Deny)];
    let servers = server_allows(mcp_servers);
    let tail = DENY_TAIL
        .iter()
        .map(|action| rule(action, "*", Effect::Deny));
    let (mirror, actions) = match access {
        Access::DiffOnly => {
            rules.push(rule("read", "*", Effect::Deny));
            rules.push(rule("read", "?*", Effect::Deny));
            if !servers.is_empty() {
                rules.extend(servers);
                rules.extend(tail);
            }
            return rules;
        }
        Access::ReadOnly(mirror) => (mirror, &MIRRORED_ACTIONS[..3]),
        Access::Research(mirror) => (mirror, &MIRRORED_ACTIONS[..]),
    };
    for &action in actions {
        rules.push(rule(action, "*", Effect::Allow));
        rules.extend(mirror.group(action).cloned());
        let denies_all = |last: &Rule| last.resource == "*" && last.effect == Effect::Deny;
        if action == "read" && rules.last().is_some_and(denies_all) {
            rules.push(rule("read", "?*", Effect::Deny));
        }
    }
    rules.extend(servers);
    rules.extend(tail);
    rules
}

/// Every JSON string of a lock document, keys included: `serde_json` encoding with each
/// `{` escaped.
fn json_string(s: &str) -> String {
    Value::String(s.to_owned())
        .to_string()
        .replace('{', LEFT_BRACE_ESCAPE)
}

/// The document text, assembled by hand because the crate's `serde_json` map sorts keys.
/// Research also carries the `websearch` provider its web search needs: Exa runs without
/// a key, and without a provider the first search raises a form a run cannot answer.
fn document_json(agent: &AgentId, rules: &[Rule], research: bool) -> String {
    let mut json = format!(
        "{{{}:{{{}:{{{}:{},{}:[",
        json_string("agents"),
        json_string(agent.as_str()),
        json_string("mode"),
        json_string("primary"),
        json_string("permissions"),
    );
    for (index, rule) in rules.iter().enumerate() {
        if index > 0 {
            json.push(',');
        }
        json.push_str(&format!(
            "{{{}:{},{}:{},{}:{}}}",
            json_string("action"),
            json_string(&rule.action),
            json_string("resource"),
            json_string(&rule.resource),
            json_string("effect"),
            json_string(rule.effect.as_str()),
        ));
    }
    json.push_str("]}}");
    if research {
        json.push_str(&format!(
            ",{}:{{{}:{}}}",
            json_string("websearch"),
            json_string("provider"),
            json_string("exa"),
        ));
    }
    json.push('}');
    json
}

/// The one builder behind both documents. Over the cap the run is refused; the document is
/// never truncated.
fn document(
    agent: AgentId,
    access: Access<'_>,
    mcp_servers: &[&str],
) -> Result<LockDocument, LockError> {
    let rules = lock_rules(access, mcp_servers);
    let json = document_json(&agent, &rules, matches!(access, Access::Research(_)));
    let units = json.encode_utf16().count();
    if units > LOCK_DOCUMENT_CAP {
        return Err(LockError::TooLarge { units });
    }
    Ok(LockDocument { agent, rules, json })
}

/// Phase 1: the probe a read-back runs under, the pin's rules with an empty mirror under a
/// fresh id. `inherited_content` is the `CONTENT_ENV` value the spawn would inherit; a
/// ReadOnly or Research probe refuses a non-empty one, since the lock replaces it.
pub(crate) fn probe_document(
    pin: Pin,
    mcp_servers: &[&str],
    inherited_content: Option<&str>,
) -> Result<LockDocument, LockError> {
    let empty = Mirror::empty();
    let access = match pin {
        Pin::DiffOnly => Access::DiffOnly,
        Pin::ReadOnly | Pin::Research
            if inherited_content.is_some_and(|value| !value.is_empty()) =>
        {
            return Err(LockError::InheritedContent)
        }
        Pin::ReadOnly => Access::ReadOnly(&empty),
        Pin::Research => Access::Research(&empty),
    };
    document(AgentId::mint(), access, mcp_servers)
}

/// Phase 2: the lock a run carries, under a fresh id of its own.
pub(crate) fn lock_document(
    access: Access<'_>,
    mcp_servers: &[&str],
) -> Result<LockDocument, LockError> {
    document(AgentId::mint(), access, mcp_servers)
}

fn agent_id(agent: &Value) -> Option<&str> {
    agent.get("id")?.as_str()
}

/// An agent entry's `permissions`, `None` unless every element is a well-formed rule.
fn agent_rules(agent: &Value) -> Option<Vec<Rule>> {
    agent
        .get("permissions")?
        .as_array()?
        .iter()
        .map(|item| {
            Some(Rule {
                action: item.get("action")?.as_str()?.to_string(),
                resource: item.get("resource")?.as_str()?.to_string(),
                effect: Effect::parse(item.get("effect")?.as_str()?)?,
            })
        })
        .collect()
}

/// Whether `rule` may follow the probe's rules: a deny over every resource, which keeps
/// hidden every tool it matches, or one of opencode's fixed trailing denies. Exact text,
/// since the read-back lists opencode's own spelling of each rule.
fn may_follow(rule: &Rule) -> bool {
    rule.effect == Effect::Deny
        && (rule.resource == "*"
            || FIXED_TAIL_DENIES
                .iter()
                .any(|(action, resource)| rule.action == *action && rule.resource == *resource))
}

/// The length of the rules ahead of the probe's: the smallest run of trailing rules
/// `may_follow` accepts whose preceding rules are exactly the probe's; `None` when any
/// other rule follows them.
fn landed_last(resolved: &[Rule], probe: &[Rule]) -> Option<usize> {
    let mut end = resolved.len();
    loop {
        let start = end.checked_sub(probe.len())?;
        if resolved[start..end] == *probe {
            return Some(start);
        }
        if end == 0 || !may_follow(&resolved[end - 1]) {
            return None;
        }
        end -= 1;
    }
}

/// The mirror: per mirrored action, in order, every source rule whose action pattern
/// matches it, rewritten to the literal action (the source pattern copied after `* * deny`
/// could open every tool), with `ask` as `deny`. An allow whose resource opencode would
/// home-expand is dropped: opencode expands home only under the path actions, so re-emitted
/// under `read` it would become an allow the user's config never had.
fn project(source: &[Rule], case: MatchCase) -> Mirror {
    let home_spelled = |resource: &str| {
        resource == "~"
            || resource == "$HOME"
            || ["~/", "$HOME/", "$HOME\\"]
                .iter()
                .any(|prefix| resource.starts_with(prefix))
    };
    let mut rules = Vec::new();
    for action in MIRRORED_ACTIONS {
        for source_rule in source {
            if !wildcard_match(action, &source_rule.action, case) {
                continue;
            }
            let effect = match source_rule.effect {
                Effect::Ask => Effect::Deny,
                effect => effect,
            };
            if effect == Effect::Allow && home_spelled(&source_rule.resource) {
                continue;
            }
            rules.push(rule(action, &source_rule.resource, effect));
        }
    }
    Mirror { rules }
}

/// Reads the stdout of `READBACK_ARGS` run under `probe`. The probe agent must be listed
/// and end with exactly the probe's rules followed only by rules `may_follow` accepts; the
/// rules ahead of them are the builtin defaults and the user's config. The mirror comes
/// from `plan`'s whole list when opencode lists `plan`, else from those rules ahead. Only
/// the probe and `plan` entries are validated, `plan` before the order check, so a
/// malformed `plan` reads as `NotJson` whatever the probe entry holds. A DiffOnly lock
/// carries no mirror, so its read-back neither reads `plan` nor projects anything.
pub(crate) fn read_back(
    stdout: &str,
    probe: &LockDocument,
    pin: Pin,
    case: MatchCase,
) -> Result<Mirror, ReadbackError> {
    let Ok(Value::Array(agents)) = serde_json::from_str::<Value>(stdout.trim()) else {
        return Err(ReadbackError::NotJson);
    };
    let entry = agents
        .iter()
        .find(|agent| agent_id(agent) == Some(probe.agent.as_str()))
        .ok_or(ReadbackError::AgentAbsent)?;
    let resolved = agent_rules(entry).ok_or(ReadbackError::NotJson)?;
    if pin == Pin::DiffOnly {
        landed_last(&resolved, &probe.rules).ok_or(ReadbackError::NotLast)?;
        return Ok(Mirror::empty());
    }
    let plan = agents
        .iter()
        .find(|agent| agent_id(agent) == Some("plan"))
        .map(|plan| agent_rules(plan).ok_or(ReadbackError::NotJson))
        .transpose()?;
    let ahead = landed_last(&resolved, &probe.rules).ok_or(ReadbackError::NotLast)?;
    let source = plan.as_deref().unwrap_or(&resolved[..ahead]);
    Ok(project(source, case))
}

// ---- argv ----

/// `opencode models` prints one `provider/model` per line, as on 1.x.
pub(crate) const MODELS_ARGS: &[&str] = &["models", "--standalone"];

/// Prints every agent's resolved rules as a JSON array; the read-back reads it.
pub(crate) const READBACK_ARGS: &[&str] = &["debug", "agents", "--standalone"];

/// Lists models with their declared variants. Exits 0 in 2.3 to 3.1 s with or without
/// network (`main/live-findings.md` M23, v2.3.2).
pub(crate) const CATALOG_ARGS: &[&str] = &["api", "GET", "/api/model", "--standalone"];

/// `-m`'s value, from the trimmed model id: the variant rides as `provider/model#variant`,
/// which allows one `#`, so a model typed with one is passed as typed.
fn model_arg(model: &str, variant: Option<&str>) -> Option<String> {
    let model = model.trim();
    if model.is_empty() {
        return None;
    }
    if model.contains('#') {
        return Some(model.to_string());
    }
    match variant {
        Some(variant) if !variant.is_empty() => Some(format!("{model}#{variant}")),
        _ => Some(model.to_string()),
    }
}

/// Every 2.x run starts here. `--standalone` keeps the run off the user's background
/// service, which ignores this spawn's environment; the prompt goes on stdin, so no
/// message argument is ever built.
fn run_args() -> Vec<String> {
    ["run", "--standalone", "--format", "json"]
        .map(String::from)
        .to_vec()
}

fn push_model(args: &mut Vec<String>, model: &str, variant: Option<&str>) {
    if let Some(model) = model_arg(model, variant) {
        args.push("-m".to_string());
        args.push(model);
    }
}

/// A review or generation run: always locked, never `--auto`.
pub(crate) fn review_args(
    version: Version,
    lock: &LockDocument,
    model: &str,
    variant: Option<&str>,
) -> Vec<String> {
    let mut args = run_args();
    args.push("--agent".to_string());
    args.push(lock.agent.as_str().to_string());
    if version >= ARCHIVED_SINCE {
        args.push("--archived".to_string());
    }
    push_model(&mut args, model, variant);
    args
}

/// The agent of a session turn. A write turn names no agent: a session that never had an
/// explicit agent follows the user's current default each turn, while a named agent is
/// sticky and fails once it is no longer defined.
#[derive(Clone, Copy, Debug)]
pub(crate) enum SessionAgent<'a> {
    Locked(&'a LockDocument),
    Write,
}

/// A session turn. A blank `session_id` starts a new conversation; there is no
/// `--continue`, which could land on a session whose lock agent no longer exists.
pub(crate) fn session_args(
    agent: SessionAgent<'_>,
    model: &str,
    variant: Option<&str>,
    session_id: Option<&str>,
) -> Vec<String> {
    let mut args = run_args();
    match agent {
        SessionAgent::Locked(lock) => {
            args.push("--agent".to_string());
            args.push(lock.agent.as_str().to_string());
        }
        SessionAgent::Write => args.push("--auto".to_string()),
    }
    if let Some(id) = session_id.map(str::trim).filter(|id| !id.is_empty()) {
        args.push("--session".to_string());
        args.push(id.to_string());
    }
    push_model(&mut args, model, variant);
    args
}

// ---- env ----

/// The variables that keep a repository's own opencode config out of a process. Both are
/// set: an inherited empty `OPENCODE_CONFIG_PROJECT_DISABLE` switches the first one off.
pub(crate) fn project_disable_env() -> [(&'static str, String); 2] {
    [
        ("OPENCODE_DISABLE_PROJECT_CONFIG", "1".to_string()),
        ("OPENCODE_CONFIG_PROJECT_DISABLE", "1".to_string()),
    ]
}

/// The env of a review or generation run (and of its read-back), with the repository's
/// opencode config kept out (`project_disable_env`).
pub(crate) fn review_env(
    mcp_config_path: Option<&str>,
    lock: &LockDocument,
) -> Vec<(&'static str, String)> {
    let mut env = Vec::new();
    if let Some(path) = mcp_config_path {
        env.push(("OPENCODE_CONFIG", path.to_string()));
    }
    env.push(("OPENCODE_DISABLE_MODELS_FETCH", "1".to_string()));
    env.push((CONTENT_ENV, lock.json.clone()));
    env.extend(project_disable_env());
    env
}

/// The env of a session turn (and of a locked turn's read-back). Sessions keep the repo's
/// opencode config, so neither project-disable variable is set.
pub(crate) fn session_env(
    config_path: Option<String>,
    lock: Option<&LockDocument>,
) -> Vec<(&'static str, String)> {
    let mut env = Vec::new();
    if let Some(path) = config_path {
        env.push(("OPENCODE_CONFIG", path));
    }
    env.push(("OPENCODE_DISABLE_MODELS_FETCH", "1".to_string()));
    if let Some(lock) = lock {
        env.push((CONTENT_ENV, lock.json.clone()));
    }
    env
}

// ---- stream ----

/// What `finish` reports when an error line names the lock's agent: opencode did not load
/// the lock document, so the run never started.
const LOCK_DROPPED: &str = "opencode did not load GitDesktop's read-only lock, so the run was stopped before it started. Check your opencode config with \"opencode debug config\", then try again.";

/// How many blocks a projected `text` event may skip past a message's last known block.
const PROJECTED_GAP_LIMIT: usize = 1024;

/// Projected `text` events pad a message to at most this many blocks. A projected ordinal
/// at or past it completes its block in place when the message already holds that block;
/// past the last block it reads as live and adds one block, as a live line does. The gap
/// limit bounds each line, not a run of lines that each step the whole gap.
const MESSAGE_BLOCK_CAP: usize = 4096;

/// The text blocks of one assistant message, in ordinal order; `id` is `None` for a
/// message whose events carried no `messageID`.
#[derive(Debug)]
struct Message {
    id: Option<String>,
    blocks: Vec<String>,
}

/// Reads `opencode run --format json` (2.x) line by line. `line` never returns a terminal
/// event: no `step_finish` reason ends a run (an `error` line and a non-zero exit can
/// follow a `stop`, and a run can succeed after a `tool-calls` finish with no `stop`), so
/// only `finish`, given the exit code after EOF, concludes.
///
/// Text blocks are kept per message. A `text` event whose part id has the projected shape
/// `prt_<message id without msg_>_text-<n>` is opencode's end-of-run reconcile and lands
/// on block `n`, completing a block already streamed when it holds only the missed tail;
/// any other `text` event is live and starts the message's next block. A `text` or
/// `tool_use` event for a message not seen yet opens it as `step_start` does: opencode
/// 2.2.0's reconcile sends no `step_start` for a message the live stream missed. A tail on
/// a block other than the latest streamed one is not streamed, and reaches `Done` only
/// when its message is the final one or the final one has no text. ASSUMPTION: no live
/// block of a message is skipped while a later block of that message arrives live, since
/// live events are emitted as blocks end, in order, and opencode's own account of a miss
/// is the session going idle before the LAST live events arrive. Were it broken, a
/// projected tail would join the wrong block of its message.
///
/// Every `step_start` carrying the top-level `sessionID` yields a `NativeSession`, as does
/// the first `text`, `tool_use` or `step_finish` line carrying it while none has been
/// sent; `error`, `retry` and `background_wait` never do, so a turn that fails before any
/// step stores no id.
#[derive(Debug)]
pub(crate) struct StreamParser {
    /// The lock's agent id, matched against an error line's message.
    agent: Option<String>,
    messages: Vec<Message>,
    /// The message `Done` reports: the one the latest `step_start` opened, or the one a
    /// `text` or `tool_use` event for an unseen message opened, or the anonymous one text
    /// before any step lands in.
    final_message: Option<usize>,
    /// (message, block) of the block the latest non-empty `Delta` came from.
    last_streamed: Option<(usize, usize)>,
    /// Whether a non-empty `Delta` was returned, so the next new block leads with "\n\n".
    streamed_any: bool,
    /// Whether a `NativeSession` was returned.
    session_sent: bool,
    seen_event: bool,
    error: Option<String>,
    reason: Option<String>,
    retry: Option<String>,
}

impl StreamParser {
    /// `lock` is the document the run carries, `None` for an unlocked run.
    pub(crate) fn new(lock: Option<&LockDocument>) -> Self {
        Self {
            agent: lock.map(|lock| lock.agent.as_str().to_string()),
            messages: Vec::new(),
            final_message: None,
            last_streamed: None,
            streamed_any: false,
            session_sent: false,
            seen_event: false,
            error: None,
            reason: None,
            retry: None,
        }
    }

    /// One stdout line: slot 0 is the `NativeSession` the line yields (the top-level
    /// `sessionID`, as the struct doc says), slot 1 the line's own event, never a
    /// `NativeSession`, `Done` or `Error`. A line that is not a JSON object with a string
    /// `type` yields neither.
    pub(crate) fn line(&mut self, line: &str) -> [Option<crate::agent::ReviewEvent>; 2] {
        let line = line.trim();
        if line.is_empty() {
            return [None, None];
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return [None, None];
        };
        let Some(kind) = value
            .as_object()
            .and_then(|object| object.get("type"))
            .and_then(Value::as_str)
        else {
            return [None, None];
        };
        self.seen_event = true;
        // Progress, or a background wait (which starts only once the turn is idle), after a
        // retry means the retry is over: a timeout names one only while it is the last
        // thing opencode reported.
        if matches!(
            kind,
            "step_start" | "text" | "tool_use" | "step_finish" | "background_wait"
        ) {
            self.retry = None;
        }
        let native = self.native_session(kind, &value);
        [native, self.event(kind, &value)]
    }

    /// Slot 0 of `line`: every `step_start`, and a `text`, `tool_use` or `step_finish`
    /// line only while no id has been sent. Any id sent stops the latter.
    fn native_session(&mut self, kind: &str, value: &Value) -> Option<crate::agent::ReviewEvent> {
        let sends = match kind {
            "step_start" => true,
            "text" | "tool_use" | "step_finish" => !self.session_sent,
            _ => false,
        };
        if !sends {
            return None;
        }
        let id = value.get("sessionID").and_then(Value::as_str)?;
        self.session_sent = true;
        Some(crate::agent::ReviewEvent::NativeSession { id: id.to_string() })
    }

    /// Slot 1 of `line`: the line's own event.
    fn event(&mut self, kind: &str, value: &Value) -> Option<crate::agent::ReviewEvent> {
        let part = value.get("part");
        let field = |name: &str| part.and_then(|part| part.get(name)).and_then(Value::as_str);
        match kind {
            "step_start" => {
                let index = match field("messageID") {
                    Some(id) => self.message(id),
                    None => self.anonymous(),
                };
                self.final_message = Some(index);
                None
            }
            "text" => {
                let text = field("text")?;
                self.text(field("messageID"), field("id"), text)
            }
            "tool_use" => {
                if let Some(id) = field("messageID") {
                    self.opened(id);
                }
                let name = field("tool").unwrap_or("a tool");
                let tool = if name == "subagent" {
                    "task"
                } else {
                    crate::agent::normalize_tool(name)
                };
                let target = part
                    .and_then(|part| part.get("state"))
                    .and_then(|state| state.get("input"))
                    .and_then(crate::agent::tool_target);
                Some(crate::agent::ReviewEvent::Tool {
                    tool: tool.to_string(),
                    target,
                })
            }
            "step_finish" => {
                self.reason = field("reason").map(str::to_string);
                None
            }
            "error" => {
                if self.error.is_none() {
                    let error = value.get("error");
                    let message = error
                        .and_then(|error| error.get("message"))
                        .and_then(Value::as_str)
                        .or_else(|| error.and_then(Value::as_str))
                        .unwrap_or("opencode reported an error.");
                    self.error = Some(message.to_string());
                }
                None
            }
            "retry" => {
                if let Some(message) = value
                    .get("error")
                    .and_then(|error| error.get("message"))
                    .and_then(Value::as_str)
                {
                    self.retry = Some(message.to_string());
                }
                None
            }
            _ => None,
        }
    }

    /// The message of the latest `retry` event no progress has followed, for a run that
    /// ends without a reason.
    pub(crate) fn last_retry(&self) -> Option<&str> {
        self.retry.as_deref()
    }

    /// The recorded `error` line as the run's outcome reports it: an error naming the
    /// lock's agent reads as `LOCK_DROPPED`.
    pub(crate) fn last_error(&self) -> Option<String> {
        let message = self.error.as_deref()?;
        let dropped = self
            .agent
            .as_deref()
            .is_some_and(|agent| message.contains(agent));
        Some(if dropped {
            LOCK_DROPPED.to_string()
        } else {
            message.to_string()
        })
    }

    /// The terminal event after EOF, given the exit code (`None` when no exit status was
    /// obtained) and the run's first non-empty stderr line, already clipped. `None` when
    /// the stream held no event at all, so the caller's no-output fallback can surface
    /// stderr. stderr joins only a failed exit with no `error` line recorded.
    pub(crate) fn finish(
        self,
        exit_code: Option<i32>,
        stderr_line: Option<&str>,
    ) -> Option<crate::agent::ReviewEvent> {
        if let Some(message) = self.last_error() {
            return Some(crate::agent::ReviewEvent::error(message));
        }
        if !self.seen_event {
            return None;
        }
        if exit_code == Some(0) {
            let joined = |messages: &[Message]| {
                messages
                    .iter()
                    .flat_map(|message| &message.blocks)
                    .filter(|block| !block.is_empty())
                    .map(String::as_str)
                    .collect::<Vec<_>>()
                    .join("\n\n")
            };
            let answer = self
                .final_message
                .map(|index| joined(&self.messages[index..=index]))
                .unwrap_or_default();
            // A final message without text falls back to every message's stored blocks, so
            // a reconciled tail on an earlier block is kept.
            let text = if answer.is_empty() {
                joined(&self.messages)
            } else {
                answer
            };
            return Some(crate::agent::ReviewEvent::Done {
                text,
                is_error: false,
                cost_usd: None,
            });
        }
        let mut message = match exit_code {
            Some(code) => format!("opencode exited with code {code} before it finished."),
            None => "opencode stopped before it finished.".to_string(),
        };
        match self.reason.as_deref() {
            Some("content-filter") => {
                message.push_str(" The model's reply was blocked by a content filter.")
            }
            Some("length") => message.push_str(" The reply hit the model's output limit."),
            _ => {}
        }
        if let Some(line) = stderr_line {
            message.push_str(&format!(" opencode printed: {line}"));
        }
        Some(crate::agent::ReviewEvent::error(message))
    }

    /// The index of the message with this id, added when new.
    fn message(&mut self, id: &str) -> usize {
        if let Some(index) = self
            .messages
            .iter()
            .position(|message| message.id.as_deref() == Some(id))
        {
            return index;
        }
        self.messages.push(Message {
            id: Some(id.to_string()),
            blocks: Vec::new(),
        });
        self.messages.len() - 1
    }

    /// `message`, making a message not seen yet the final one: opencode 2.2.0's reconcile
    /// sends no `step_start` for a message the live stream missed.
    fn opened(&mut self, id: &str) -> usize {
        let known = self.messages.len();
        let index = self.message(id);
        if index == known {
            self.final_message = Some(index);
        }
        index
    }

    /// A fresh message for events that name none, so `Done` never carries an earlier step.
    fn anonymous(&mut self) -> usize {
        self.messages.push(Message {
            id: None,
            blocks: Vec::new(),
        });
        self.messages.len() - 1
    }

    fn text(
        &mut self,
        message_id: Option<&str>,
        part_id: Option<&str>,
        text: &str,
    ) -> Option<crate::agent::ReviewEvent> {
        let index = match message_id {
            Some(id) => self.opened(id),
            None => match self.final_message {
                Some(index) => index,
                None => {
                    let index = self.anonymous();
                    self.final_message = Some(index);
                    index
                }
            },
        };
        let blocks = &mut self.messages[index].blocks;
        // A projected ordinal inside the list completes its block in place, cap or not. One
        // far past the list, or past the last block at or past the message's cap, is read as
        // live: padding up to it would let malformed ids allocate without bound.
        let ordinal = message_id
            .zip(part_id)
            .and_then(|(message_id, part_id)| projected_ordinal(message_id, part_id))
            .filter(|ordinal| {
                *ordinal < blocks.len()
                    || (*ordinal <= blocks.len() + PROJECTED_GAP_LIMIT
                        && *ordinal < MESSAGE_BLOCK_CAP)
            })
            .unwrap_or(blocks.len());
        if blocks.len() <= ordinal {
            blocks.resize(ordinal + 1, String::new());
        }
        let block = &mut blocks[ordinal];
        if text.is_empty() {
            return None;
        }
        if block.is_empty() {
            block.push_str(text);
            let delta = if self.streamed_any {
                format!("\n\n{text}")
            } else {
                text.to_string()
            };
            self.streamed_any = true;
            self.last_streamed = Some((index, ordinal));
            return Some(crate::agent::ReviewEvent::Delta { text: delta });
        }
        block.push_str(text);
        if self.last_streamed != Some((index, ordinal)) {
            return None;
        }
        Some(crate::agent::ReviewEvent::Delta {
            text: text.to_string(),
        })
    }
}

/// `n` when `part_id` is `prt_<message id without its msg_ prefix>_text-<n>`, the id
/// opencode's end-of-run reconcile gives the `n`th text block of a message.
fn projected_ordinal(message_id: &str, part_id: &str) -> Option<usize> {
    let message = message_id.strip_prefix("msg_").unwrap_or(message_id);
    let digits = part_id
        .strip_prefix("prt_")?
        .strip_prefix(message)?
        .strip_prefix("_text-")?;
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

// ---- models and effort ----

/// The variants each model declares, keyed `provider/model`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct ModelCatalog {
    models: BTreeMap<String, Vec<String>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum CatalogError {
    NotJson,
}

/// Reads the stdout of `CATALOG_ARGS`: an object with a `data` array, or a bare array.
/// Entries and variants of another shape are skipped, as is a variant id that could not
/// ride after `#` in `-m` (empty, or holding `#`, whitespace or a control character); a
/// repeated model keeps its first entry.
pub(crate) fn parse_model_catalog(stdout: &str) -> Result<ModelCatalog, CatalogError> {
    let value: Value = serde_json::from_str(stdout.trim()).map_err(|_| CatalogError::NotJson)?;
    let entries = match &value {
        Value::Array(entries) => entries,
        Value::Object(object) => object
            .get("data")
            .and_then(Value::as_array)
            .ok_or(CatalogError::NotJson)?,
        _ => return Err(CatalogError::NotJson),
    };
    let usable = |id: &&str| {
        !id.is_empty()
            && !id
                .chars()
                .any(|c| c == '#' || c.is_whitespace() || c.is_control())
    };
    let mut models = BTreeMap::new();
    for entry in entries {
        let provider = entry.get("providerID").and_then(Value::as_str);
        let (Some(provider), Some(id)) = (provider, entry.get("id").and_then(Value::as_str)) else {
            continue;
        };
        let variants: Vec<String> = entry
            .get("variants")
            .and_then(Value::as_array)
            .map(|variants| {
                variants
                    .iter()
                    .filter_map(|variant| variant.get("id")?.as_str())
                    .filter(usable)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        models.entry(format!("{provider}/{id}")).or_insert(variants);
    }
    Ok(ModelCatalog { models })
}

impl ModelCatalog {
    /// The variants `model` declares (an exact `provider/model` match), empty otherwise.
    pub(crate) fn variants(&self, model: &str) -> &[String] {
        self.models.get(model).map_or(&[], Vec::as_slice)
    }
}

/// GitDesktop's effort levels, lowest first.
pub(crate) const EFFORT_LEVELS: [&str; 4] = ["low", "medium", "high", "xhigh"];

/// The variant to send for an effort level: the first of the level's names that the model
/// declares, `None` when it declares none of them (an undeclared variant fails the run).
/// After the level's own name come the names 1.x sent for it (`low` sent `minimal`,
/// `xhigh` sent `max`); `high` is `xhigh`'s last resort, the nearest level when neither
/// exists. `none` is never picked: it switches reasoning off.
pub(crate) fn pick_variant<'a>(level: &str, declared: &'a [String]) -> Option<&'a str> {
    let names: &[&str] = match level {
        "low" => &["low", "minimal"],
        "medium" => &["medium"],
        "high" => &["high"],
        "xhigh" => &["xhigh", "max", "high"],
        _ => &[],
    };
    names.iter().find_map(|name| {
        declared
            .iter()
            .find(|variant| variant == name)
            .map(String::as_str)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const S: MatchCase = MatchCase::Sensitive;
    const I: MatchCase = MatchCase::Insensitive;
    const PINS: [Pin; 3] = [Pin::DiffOnly, Pin::ReadOnly, Pin::Research];

    // ---- measured lists, in the probe scripts' `action resource=effect ; ...` notation ----

    /// The builtin rules ahead of every agent's own (`probe:probe7.txt:3`).
    const BASELINE_AHEAD: &str =
        "* *=allow ; read *.env=ask ; read *.env.*=ask ; read *.env.example=allow";
    /// The fixed rules after every agent's own (`probe:probe7.txt:3`).
    const FIXED_TAIL: &str = "browser *=deny ; skill browser=deny";
    /// Cold-start read-back under a `* * deny` pin (`probe:probe7.txt:3`).
    const PROBE7_BASELINE: &str = "* *=allow ; read *.env=ask ; read *.env.*=ask ; read *.env.example=allow ; * *=deny ; browser *=deny ; skill browser=deny";
    /// DiffOnly pin resolved (`probe:probe6-enforce.txt:10`).
    const PROBE6_DIFF_ONLY: &str = "* *=allow ; read *.env=ask ; read *.env.*=ask ; read *.env.example=allow ; * *=deny ; read *=deny ; read ?*=deny ; browser *=deny ; skill browser=deny";
    /// The ReadOnly lock and fixed tail read back on 2.2.0, 2.2.7, 2.3.2
    /// (`probe:probe16.txt`, after the four builtin rules).
    const PROBE16_READ_ONLY: &str = "* *=deny ; read *=allow ; read *=allow ; read *.env=deny ; read *.env.*=deny ; read *.env.example=allow ; grep *=allow ; grep *=allow ; glob *=allow ; glob *=allow ; external_* *=deny ; experimental_* *=deny ; opencode_* *=deny ; console_watch_* *=deny ; browser *=deny ; skill browser=deny";
    /// The Research lock and fixed tail read back on the same three (`probe:probe16.txt`).
    const PROBE16_RESEARCH: &str = "* *=deny ; read *=allow ; read *=allow ; read *.env=deny ; read *.env.*=deny ; read *.env.example=allow ; grep *=allow ; grep *=allow ; glob *=allow ; glob *=allow ; webfetch *=allow ; webfetch *=allow ; websearch *=allow ; websearch *=allow ; external_* *=deny ; experimental_* *=deny ; opencode_* *=deny ; console_watch_* *=deny ; browser *=deny ; skill browser=deny";
    /// `plan` with rules written for it (`probe:probe15-plan.txt:8`).
    const PROBE15_PLAN: &str = "* *=allow ; read *.env=ask ; read *.env.*=ask ; read *.env.example=allow ; question *=allow ; edit *=deny ; edit /root/.opencode/plan/*=allow ; read private/*=deny ; read secret/*=deny ; read /root/notes/*=allow ; grep *=deny ; browser *=deny ; skill browser=deny";
    /// The probe agent beside it, pin `* *=deny ; read *=allow` (`probe:probe15-plan.txt:9`).
    const PROBE15_PROBE: &str = "* *=allow ; read *.env=ask ; read *.env.*=ask ; read *.env.example=allow ; read private/*=deny ; * *=deny ; read *=allow ; browser *=deny ; skill browser=deny";
    /// `plan` with no config (`probe:probe3.txt:5`).
    const PROBE3_PLAN: &str = "* *=allow ; read *.env=ask ; read *.env.*=ask ; read *.env.example=allow ; question *=allow ; edit *=deny ; edit /root/.opencode/plan/*=allow ; browser *=deny ; skill browser=deny";
    /// `build` with no config (`probe:probe3.txt:4`).
    const PROBE3_BUILD: &str = "* *=allow ; read *.env=ask ; read *.env.*=ask ; read *.env.example=allow ; question *=allow ; browser *=deny ; skill browser=deny";
    /// Hostile layers ahead of a pin in the content document (`probe:probe5-v2.3.2.txt:8`).
    const PROBE5_AHEAD: &str = "* *=allow ; read *.env=ask ; read *.env.*=ask ; read *.env.example=allow ; shell *=allow ; edit *=allow ; edit *=allow ; shell *=allow ; * *=deny ; read *=allow ; read x{env:HOME}=deny ; browser *=deny ; skill browser=deny";
    /// The pin in the `OPENCODE_CONFIG` file, other rules after it
    /// (`probe:probe5-v2.3.2.txt:4`).
    const PROBE5_AFTER: &str = "* *=allow ; read *.env=ask ; read *.env.*=ask ; read *.env.example=allow ; shell *=allow ; edit *=allow ; edit *=allow ; webfetch *=allow ; edit *=allow ; shell *=allow ; * *=deny ; read *=allow ; read x{env:HOME}=deny ; webfetch *=allow ; shell *=allow ; browser *=deny ; skill browser=deny";
    const PROBE5_PIN: &str = "* *=deny ; read *=allow ; read x{env:HOME}=deny";
    /// The agent listed with its pin rules dropped (`probe:probe5-v2.3.2.txt:18`).
    const PROBE5_DROPPED: &str = "* *=allow ; read *.env=ask ; read *.env.*=ask ; read *.env.example=allow ; shell *=allow ; edit *=allow ; edit *=allow ; webfetch *=allow ; edit *=allow ; shell *=allow ; webfetch *=allow ; shell *=allow ; browser *=deny ; skill browser=deny";
    /// The builtin agents when the probe agent is missing (`probe:probe5b-linux-v2.txt:32`).
    const BUILTIN_AGENTS: [&str; 7] = [
        "build",
        "compaction",
        "explore",
        "general",
        "plan",
        "summary",
        "title",
    ];

    fn list(text: &str) -> Vec<Rule> {
        if text.trim().is_empty() {
            return Vec::new();
        }
        text.split(" ; ")
            .map(|item| {
                let (head, effect) = item.trim().rsplit_once('=').expect("an effect");
                let (action, resource) = head.split_once(' ').expect("a resource");
                rule(
                    action,
                    resource,
                    Effect::parse(effect).expect("a known effect"),
                )
            })
            .collect()
    }

    fn show(rules: &[Rule]) -> String {
        rules
            .iter()
            .map(|r| format!("{} {}={}", r.action, r.resource, r.effect.as_str()))
            .collect::<Vec<_>>()
            .join(" ; ")
    }

    fn concat(parts: &[&[Rule]]) -> Vec<Rule> {
        parts.iter().flat_map(|part| part.iter().cloned()).collect()
    }

    /// A measured resolved list with the module's probe rules standing where the probe's
    /// pin stood.
    fn substituted(measured: &str, pin: &str, probe: &LockDocument) -> Vec<Rule> {
        let measured = list(measured);
        let pin = list(pin);
        let at = (0..=measured.len() - pin.len())
            .find(|&at| measured[at..at + pin.len()] == pin[..])
            .expect("the pin in the measured line");
        concat(&[&measured[..at], probe.rules(), &measured[at + pin.len()..]])
    }

    fn agent_entry(id: &str, rules: &[Rule]) -> Value {
        let permissions: Vec<Value> = rules
            .iter()
            .map(|r| json!({"action": r.action, "resource": r.resource, "effect": r.effect.as_str()}))
            .collect();
        json!({"id": id, "name": id, "mode": "primary", "hidden": false, "permissions": permissions})
    }

    /// Pretty-printed like the `debug agents` handler (`JSON.stringify(.., null, 2)`).
    fn agents_output(agents: Vec<Value>) -> String {
        serde_json::to_string_pretty(&Value::Array(agents)).expect("serializable") + "\n"
    }

    fn probe_output(probe: &LockDocument, resolved: &[Rule]) -> String {
        agents_output(vec![agent_entry(probe.agent().as_str(), resolved)])
    }

    fn baseline_output(probe: &LockDocument) -> String {
        probe_output(probe, &substituted(PROBE7_BASELINE, "* *=deny", probe))
    }

    /// A mirror read back from a probe agent whose rules ahead are `source`.
    fn mirror_of(source: &str, case: MatchCase) -> Mirror {
        let probe = probe_document(Pin::ReadOnly, &[], None).expect("probe");
        let resolved = concat(&[&list(source), probe.rules(), &list(FIXED_TAIL)]);
        read_back(
            &probe_output(&probe, &resolved),
            &probe,
            Pin::ReadOnly,
            case,
        )
        .expect("read-back")
    }

    fn baseline_mirror() -> Mirror {
        mirror_of(BASELINE_AHEAD, S)
    }

    fn access(pin: Pin, mirror: &Mirror) -> Access<'_> {
        match pin {
            Pin::DiffOnly => Access::DiffOnly,
            Pin::ReadOnly => Access::ReadOnly(mirror),
            Pin::Research => Access::Research(mirror),
        }
    }

    fn lock_with(pin: Pin, servers: &[&str], mirror: &Mirror) -> LockDocument {
        document(AgentId::from_bits(0x5eed), access(pin, mirror), servers).expect("under the cap")
    }

    /// The resolved list a run sees: the measured builtin rules, the lock, the fixed tail.
    fn resolved(rules: &[Rule]) -> Vec<Rule> {
        concat(&[&list(BASELINE_AHEAD), rules, &list(FIXED_TAIL)])
    }

    fn group(mirror: &Mirror, action: &str) -> String {
        show(&mirror.group(action).cloned().collect::<Vec<_>>())
    }

    // ---- version ----

    fn version(major: u32, minor: u32, patch: u32) -> Version {
        Version {
            major,
            minor,
            patch,
        }
    }

    #[test]
    fn versions_classify_by_generation() {
        let cases: [(&str, Result<Cli, &str>); 28] = [
            ("1.19.6", Ok(Cli::V1(version(1, 19, 6)))),
            ("opencode v2.3.2", Ok(Cli::V2(version(2, 3, 2)))),
            ("1.19.6\n", Ok(Cli::V1(version(1, 19, 6)))),
            (
                "\x1b[1mopencode\x1b[0m v2.3.2\n",
                Ok(Cli::V2(version(2, 3, 2))),
            ),
            ("opencode v2.2.0", Ok(Cli::V2(version(2, 2, 0)))),
            ("opencode v2.1.9", Err("too old")),
            ("opencode v3.0.0", Err("too new")),
            ("", Err("unparseable")),
            ("opencode", Err("unparseable")),
            ("v2.3", Err("unparseable")),
            ("2.3.x", Err("unparseable")),
            ("opencode v2.4.0-beta.1", Ok(Cli::V2(version(2, 4, 0)))),
            ("opencode v2.4.0+build.7", Ok(Cli::V2(version(2, 4, 0)))),
            ("0.0.0-dev", Ok(Cli::V1(version(0, 0, 0)))),
            ("opencode v2.3.2 (abc123)", Ok(Cli::V2(version(2, 3, 2)))),
            (
                "opencode v2.3.2 built 2026.11.18",
                Ok(Cli::V2(version(2, 3, 2))),
            ),
            ("opencode (abc123)", Err("unparseable")),
            ("opencode build abc", Err("unparseable")),
            ("opencode\nv2.3.2", Err("unparseable")),
            ("\n  \r\n  V2.3.2  \n", Ok(Cli::V2(version(2, 3, 2)))),
            // opencode 2 previews: a version below 2 after the `opencode` word.
            ("opencode v0.0.0-beta-12", Err("preview")),
            ("opencode v0.0.0-dev", Err("preview")),
            ("opencode v1.9.9", Err("preview")),
            // A leading `v` on the first token keeps it the first token.
            ("v1.19.6", Ok(Cli::V1(version(1, 19, 6)))),
            // Only token 0, or token 1 after exactly `opencode`, is read.
            ("opencode local (wrapper 2.3.2 build)", Err("unparseable")),
            ("opencode local 2.3.2", Err("unparseable")),
            ("build v2.3.2", Err("unparseable")),
            ("OpenCode v2.3.2", Err("unparseable")),
        ];
        for (text, expected) in cases {
            let got = classify_version(text);
            match expected {
                Ok(cli) => assert_eq!(got, Ok(cli), "{text:?}"),
                Err(kind) => {
                    let refusal = got.expect_err(text);
                    let actual = match refusal {
                        VersionRefusal::Unparseable { .. } => "unparseable",
                        VersionRefusal::TooNew { .. } => "too new",
                        VersionRefusal::TooOld { .. } => "too old",
                        VersionRefusal::Preview { .. } => "preview",
                    };
                    assert_eq!(actual, kind, "{text:?}");
                }
            }
        }
    }

    #[test]
    fn version_boundaries_are_the_tested_set() {
        // Tested set: 2.1.9, 2.2.0, 2.2.5, 2.2.6, 2.3.2, 2.99.0, 3.0.0.
        let cases = [
            ("2.1.9", Err(())),
            ("2.2.0", Ok(version(2, 2, 0))),
            ("2.2.5", Ok(version(2, 2, 5))),
            ("2.2.6", Ok(version(2, 2, 6))),
            ("2.3.2", Ok(version(2, 3, 2))),
            ("2.99.0", Ok(version(2, 99, 0))),
        ];
        for (text, expected) in cases {
            let got = classify_version(&format!("opencode v{text}"));
            match expected {
                Ok(v) => assert_eq!(got, Ok(Cli::V2(v)), "{text}"),
                Err(()) => assert!(
                    matches!(got, Err(VersionRefusal::TooOld { .. })),
                    "{text}: {got:?}"
                ),
            }
        }
        assert!(matches!(
            classify_version("opencode v3.0.0"),
            Err(VersionRefusal::TooNew { .. })
        ));
        assert!(matches!(
            classify_version("opencode v4294967296.0.0"),
            Err(VersionRefusal::Unparseable { .. })
        ));
    }

    #[test]
    fn refusal_messages_name_the_version_text() {
        let refusal = |text: &str| classify_version(text).expect_err(text);
        let unparseable = refusal("\x1b[32mopencode build abc\x1b[0m\nsecond line");
        assert_eq!(
            unparseable,
            VersionRefusal::Unparseable {
                text: "opencode build abc".to_string()
            }
        );
        assert_eq!(
            unparseable.message(),
            "GitDesktop could not read this opencode's version (it printed \"opencode build abc\"). Update opencode or pick another binary in Settings, then try again."
        );
        assert_eq!(
            refusal(" \n ").message(),
            "GitDesktop could not read this opencode's version (it printed nothing). Update opencode or pick another binary in Settings, then try again."
        );
        assert_eq!(
            refusal("opencode v3.0.0").message(),
            "This opencode reports version \"opencode v3.0.0\", which is newer than GitDesktop supports. GitDesktop works with opencode 1.x and 2.x (tested with 2.2.0 to 2.3.2). Update GitDesktop, or pick an opencode 2.x binary in Settings."
        );
        assert_eq!(
            refusal("opencode v2.1.9").message(),
            "This opencode reports version \"opencode v2.1.9\", which is older than GitDesktop's opencode 2 support needs. Update opencode to 2.2.0 or later (run \"opencode upgrade\"), then try again."
        );
        assert_eq!(
            refusal("opencode v0.0.0-beta-12").message(),
            "This opencode reports version \"opencode v0.0.0-beta-12\", a preview build GitDesktop can't check. Install a released opencode (1.x, or 2.2.0 or later) or pick another binary in Settings, then try again."
        );
        let long = format!("opencode {}", "x".repeat(100));
        let VersionRefusal::Unparseable { text } = refusal(&long) else {
            panic!("unparseable");
        };
        assert_eq!(text.chars().count(), 80);
        assert!(long.starts_with(&text));
    }

    #[test]
    fn standing_refusals_drop_only_the_try_again_clause() {
        let clause = ", then try again.";
        for text in [
            "banana",
            "",
            "opencode v2.1.9",
            "opencode v3.0.0",
            "opencode v0.0.0-dev",
        ] {
            let refusal = classify_version(text).expect_err(text);
            let (run, standing) = (refusal.message(), refusal.standing_message());
            assert!(standing.ends_with('.'), "{standing}");
            match refusal {
                VersionRefusal::TooNew { .. } => assert_eq!(run, standing),
                _ => {
                    assert!(run.ends_with(clause), "{run}");
                    let kept = &run[..run.len() - clause.len()];
                    assert_eq!(standing, format!("{kept}."), "{text:?}");
                }
            }
        }
    }

    // ---- agent id ----

    #[test]
    fn agent_ids_are_gd_and_32_hex() {
        assert_eq!(
            AgentId::from_bits(0xab).as_str(),
            "gd000000000000000000000000000000ab"
        );
        assert_eq!(
            AgentId::from_bits(u128::MAX).as_str(),
            format!("gd{}", "f".repeat(32))
        );
        let grammar = |id: &str| {
            id.len() == 34
                && id.starts_with("gd")
                && id[2..]
                    .chars()
                    .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
        };
        let probe = probe_document(Pin::DiffOnly, &[], None).expect("probe");
        let lock = lock_document(Access::DiffOnly, &[]).expect("lock");
        assert!(grammar(probe.agent().as_str()));
        assert!(grammar(lock.agent().as_str()));
        assert_ne!(
            probe.agent(),
            lock.agent(),
            "every document mints its own id"
        );
    }

    // ---- matcher ----

    #[test]
    fn wildcard_matches_like_opencode() {
        assert!(wildcard_match("read", "r*", S));
        assert!(wildcard_match("read", "re?d", S));
        assert!(wildcard_match("read", "*", S));
        assert!(!wildcard_match("read", "READ", S));
        assert!(wildcard_match("read", "READ", I));
        assert!(!wildcard_match("xread", "read", S), "anchored at the start");
        assert!(!wildcard_match("reads", "read", S), "anchored at the end");
        assert!(wildcard_match("a\nb", "a*b", S), "* crosses newlines");
        assert!(
            wildcard_match("a\\b", "a/b", S),
            "a backslash reads as a slash"
        );
        assert!(wildcard_match("a/b", "a\\b", S));
        assert!(
            wildcard_match("skill", "skill *", S),
            "trailing ' *' is optional"
        );
        assert!(wildcard_match("skill x", "skill *", S));
        assert!(!wildcard_match("skillx", "skill *", S));
        assert!(wildcard_match("", " *", S));
        assert!(!wildcard_match("", "?*", S), "?* needs one unit");
        assert!(wildcard_match("a", "?*", S));
        assert!(
            !wildcard_match("\u{1F600}", "?", S),
            "an astral char is two units"
        );
        assert!(wildcard_match("\u{1F600}", "??", S));
        assert!(
            wildcard_match("a.b+c(d)", "a.b+c(d)", S),
            "regex specials are literal"
        );
        assert!(!wildcard_match("axb", "a.b", S));
        assert!(
            !wildcard_match("\u{e9}", "\u{c9}", I),
            "only ASCII letters fold"
        );
        assert!(wildcard_match("aXbYc", "a*b*c", I));
        assert!(!wildcard_match("abc", "a*b*cd", S));
    }

    #[test]
    fn evaluate_and_wholly_disabled_follow_opencode() {
        let rules = list("* *=allow ; read *=deny ; read a=allow");
        assert_eq!(evaluate("read", "a", &rules, S), Effect::Allow);
        assert_eq!(evaluate("read", "b", &rules, S), Effect::Deny);
        assert_eq!(evaluate("x", "y", &[], S), Effect::Ask);
        assert!(
            !wholly_disabled("read", &rules, S),
            "last action rule is narrow"
        );
        assert!(wholly_disabled("read", &list("read *=deny"), S));
        assert!(!wholly_disabled("grep", &rules, S));
    }

    // ---- lock lists ----

    #[test]
    fn diff_only_lock_is_the_measured_shape() {
        let lock = lock_with(Pin::DiffOnly, &[], &Mirror::empty());
        assert_eq!(show(&resolved(lock.rules())), PROBE6_DIFF_ONLY);
        assert_eq!(show(lock.rules()), "* *=deny ; read *=deny ; read ?*=deny");
    }

    #[test]
    fn read_only_and_research_locks_are_the_measured_lists() {
        let mirror = baseline_mirror();
        let read_only = lock_with(Pin::ReadOnly, &[], &mirror);
        let tail = list(FIXED_TAIL);
        assert_eq!(
            show(&concat(&[read_only.rules(), &tail])),
            PROBE16_READ_ONLY
        );
        let research = lock_with(Pin::Research, &[], &mirror);
        assert_eq!(show(&concat(&[research.rules(), &tail])), PROBE16_RESEARCH);
        assert!(research
            .json()
            .ends_with(r#","websearch":{"provider":"exa"}}"#));
        assert!(!read_only.json().contains("websearch"));
        // A probe (empty mirror) carries the provider key too.
        let probe = probe_document(Pin::Research, &[], None).expect("probe");
        assert!(probe
            .json()
            .ends_with(r#","websearch":{"provider":"exa"}}"#));
    }

    #[test]
    fn plan_and_prefix_sources_give_the_same_baseline_lists() {
        let probe = probe_document(Pin::ReadOnly, &[], None).expect("probe");
        let with_plan = agents_output(vec![
            agent_entry("build", &list(PROBE3_BUILD)),
            agent_entry(
                probe.agent().as_str(),
                &substituted(PROBE7_BASELINE, "* *=deny", &probe),
            ),
            agent_entry("plan", &list(PROBE3_PLAN)),
        ]);
        let from_plan = read_back(&with_plan, &probe, Pin::ReadOnly, S).expect("plan source");
        let from_prefix =
            read_back(&baseline_output(&probe), &probe, Pin::ReadOnly, S).expect("prefix source");
        assert_eq!(from_plan, from_prefix);
        for pin in PINS {
            assert_eq!(
                lock_with(pin, &[], &from_plan).rules(),
                lock_with(pin, &[], &from_prefix).rules()
            );
        }
    }

    #[test]
    fn server_allows_precede_the_deny_tail() {
        let mirror = baseline_mirror();
        let diff_only = lock_with(Pin::DiffOnly, &["gitdesktop"], &mirror);
        assert_eq!(
            show(diff_only.rules()),
            "* *=deny ; read *=deny ; read ?*=deny ; gitdesktop_* *=allow ; external_* *=deny ; experimental_* *=deny ; opencode_* *=deny ; console_watch_* *=deny"
        );
        let read_only = lock_with(Pin::ReadOnly, &["gitdesktop"], &mirror);
        let expected = PROBE16_READ_ONLY.replace(
            "glob *=allow ; glob *=allow ; ",
            "glob *=allow ; glob *=allow ; gitdesktop_* *=allow ; ",
        );
        assert_eq!(
            show(&concat(&[read_only.rules(), &list(FIXED_TAIL)])),
            expected
        );
    }

    #[test]
    fn documents_are_compact_with_keys_in_order() {
        let lock = lock_with(Pin::DiffOnly, &[], &Mirror::empty());
        assert_eq!(
            lock.json(),
            format!(
                r#"{{"agents":{{"{}":{{"mode":"primary","permissions":[{{"action":"*","resource":"*","effect":"deny"}},{{"action":"read","resource":"*","effect":"deny"}},{{"action":"read","resource":"?*","effect":"deny"}}]}}}}}}"#,
                lock.agent().as_str()
            )
        );
        let research = lock_with(Pin::Research, &["gitdesktop"], &baseline_mirror());
        // Raw text: the crate's map sorts keys, so a parsed object cannot show their order.
        assert!(research.json().starts_with(r#"{"agents":{"#));
        assert!(research
            .json()
            .ends_with(r#"]}},"websearch":{"provider":"exa"}}"#));
        let parsed: Value = serde_json::from_str(research.json()).expect("valid JSON");
        let agent = &parsed["agents"][research.agent().as_str()];
        assert_eq!(agent["mode"], "primary");
        let read: Vec<Rule> = agent_rules(agent).expect("rules");
        assert_eq!(read, research.rules());
    }

    // ---- lock controls ----

    /// A rule's control: checks over a resolved list that all hold with the rule and all
    /// fail with it removed.
    struct Control {
        pin: Pin,
        rule: &'static str,
        servers: &'static [&'static str],
        mirror: Option<&'static str>,
        check: fn(Pin, &[Rule]) -> Vec<bool>,
    }

    /// The user denies read outright, so the read group ends in `read * deny`.
    const READ_DENIED_SOURCE: &str =
        "* *=allow ; read *.env=ask ; read *.env.*=ask ; read *.env.example=allow ; read *=deny";

    fn controls() -> Vec<Control> {
        let mut table = Vec::new();
        for pin in PINS {
            table.push(Control {
                pin,
                rule: "* *=deny",
                servers: &[],
                mirror: None,
                check: |pin, rules| {
                    let web = pin == Pin::Research;
                    [
                        "shell",
                        "edit",
                        "webfetch",
                        "websearch",
                        "subagent",
                        "execute",
                        "question",
                        "todowrite",
                    ]
                    .into_iter()
                    .filter(|action| !(web && action.starts_with("web")))
                    .map(|action| wholly_disabled(action, rules, S))
                    .collect()
                },
            });
            table.push(Control {
                pin,
                rule: "gitdesktop_* *=allow",
                servers: &["gitdesktop"],
                mirror: None,
                check: |_, rules| {
                    vec![evaluate("gitdesktop_get_pull_request", "*", rules, S) == Effect::Allow]
                },
            });
            table.push(Control {
                pin,
                rule: "external_* *=deny",
                servers: &["external"],
                mirror: None,
                check: |_, rules| {
                    vec![evaluate("external_directory", "/etc/passwd", rules, S) == Effect::Deny]
                },
            });
            table.push(Control {
                pin,
                rule: "experimental_* *=deny",
                servers: &["experimental"],
                mirror: None,
                check: |_, rules| vec![wholly_disabled("experimental_image_generate", rules, S)],
            });
            table.push(Control {
                pin,
                rule: "opencode_* *=deny",
                servers: &["opencode"],
                mirror: None,
                check: |_, rules| vec![wholly_disabled("opencode_worktree_create", rules, S)],
            });
            for servers in [&["console"][..], &["console_watch"][..]] {
                table.push(Control {
                    pin,
                    rule: "console_watch_* *=deny",
                    servers,
                    mirror: None,
                    check: |_, rules| vec![wholly_disabled("console_watch_watch", rules, S)],
                });
            }
        }
        table.push(Control {
            pin: Pin::DiffOnly,
            rule: "read *=deny",
            servers: &[],
            mirror: None,
            // Redundant for evaluation by design: the exact measured list is its control.
            check: |_, rules| {
                let ahead = list(BASELINE_AHEAD).len();
                vec![rules[ahead..ahead + 3] == list("* *=deny ; read *=deny ; read ?*=deny")[..]]
            },
        });
        table.push(Control {
            pin: Pin::DiffOnly,
            rule: "read ?*=deny",
            servers: &[],
            mirror: None,
            check: |_, rules| vec![!wholly_disabled("read", rules, S)],
        });
        for pin in [Pin::ReadOnly, Pin::Research] {
            table.push(Control {
                pin,
                rule: "read ?*=deny",
                servers: &[],
                mirror: Some(READ_DENIED_SOURCE),
                check: |_, rules| vec![!wholly_disabled("read", rules, S)],
            });
            table.push(Control {
                pin,
                rule: "read *=allow",
                servers: &[],
                mirror: None,
                check: |_, rules| vec![evaluate("read", "x", rules, S) == Effect::Allow],
            });
            table.push(Control {
                pin,
                rule: "grep *=allow",
                servers: &[],
                mirror: None,
                check: |_, rules| vec![evaluate("grep", "x", rules, S) == Effect::Allow],
            });
            table.push(Control {
                pin,
                rule: "glob *=allow",
                servers: &[],
                mirror: None,
                check: |_, rules| vec![evaluate("glob", "x", rules, S) == Effect::Allow],
            });
        }
        table.push(Control {
            pin: Pin::Research,
            rule: "webfetch *=allow",
            servers: &[],
            mirror: None,
            check: |_, rules| vec![evaluate("webfetch", "x", rules, S) == Effect::Allow],
        });
        table.push(Control {
            pin: Pin::Research,
            rule: "websearch *=allow",
            servers: &[],
            mirror: None,
            check: |_, rules| vec![evaluate("websearch", "x", rules, S) == Effect::Allow],
        });
        table
    }

    fn control_mirror(source: Option<&str>) -> Mirror {
        source.map_or_else(Mirror::empty, |source| mirror_of(source, S))
    }

    #[test]
    fn every_lock_rule_flips_its_control_when_removed() {
        for control in controls() {
            let mirror = control_mirror(control.mirror);
            let lock = lock_with(control.pin, control.servers, &mirror);
            let label = format!("{:?} {} {:?}", control.pin, control.rule, control.servers);
            let positions: Vec<usize> = lock
                .rules()
                .iter()
                .enumerate()
                .filter(|(_, rule)| show(std::slice::from_ref(rule)) == control.rule)
                .map(|(index, _)| index)
                .collect();
            assert_eq!(positions.len(), 1, "{label}: one occurrence");
            let full = (control.check)(control.pin, &resolved(lock.rules()));
            assert!(
                !full.is_empty() && full.iter().all(|&ok| ok),
                "{label}: holds"
            );
            let mut without = lock.rules().to_vec();
            without.remove(positions[0]);
            let removed = (control.check)(control.pin, &resolved(&without));
            assert!(removed.iter().all(|&ok| !ok), "{label}: flips {removed:?}");
        }
    }

    #[test]
    fn no_lock_rule_lacks_a_control() {
        let table = controls();
        let configs: [(&[&str], Option<&str>); 3] = [
            (&[], None),
            (&["gitdesktop"], None),
            (&[], Some(READ_DENIED_SOURCE)),
        ];
        for pin in PINS {
            for (servers, source) in configs {
                let mirror = control_mirror(source);
                let lock = lock_with(pin, servers, &mirror);
                // The lock's own rules: its list with the mirror rules this pin used taken
                // out once each.
                let mut owned = lock.rules().to_vec();
                let used: &[&str] = match pin {
                    Pin::DiffOnly => &[],
                    Pin::ReadOnly => &MIRRORED_ACTIONS[..3],
                    Pin::Research => &MIRRORED_ACTIONS[..],
                };
                for mirrored in mirror
                    .rules
                    .iter()
                    .filter(|r| used.contains(&r.action.as_str()))
                {
                    let at = owned
                        .iter()
                        .position(|r| r == mirrored)
                        .expect("mirrored rule");
                    owned.remove(at);
                }
                for rule in &owned {
                    let text = show(std::slice::from_ref(rule));
                    assert!(
                        table.iter().any(|c| c.pin == pin && c.rule == text),
                        "{pin:?} {servers:?} {source:?}: no control claims {text}"
                    );
                }
            }
        }
    }

    #[test]
    fn mirrored_read_rules_carve_the_read_allow() {
        for pin in [Pin::ReadOnly, Pin::Research] {
            let mirrored = resolved(lock_with(pin, &[], &baseline_mirror()).rules());
            assert_eq!(evaluate("read", "a/.env", &mirrored, S), Effect::Deny);
            assert_eq!(
                evaluate("read", "a/.env.example", &mirrored, S),
                Effect::Allow
            );
            let bare = resolved(lock_with(pin, &[], &Mirror::empty()).rules());
            assert_eq!(evaluate("read", "a/.env", &bare, S), Effect::Allow);
            assert_eq!(evaluate("read", "a/.env.example", &bare, S), Effect::Allow);
        }
    }

    #[test]
    fn web_tools_are_listed_under_research_only() {
        let mirror = baseline_mirror();
        let research = resolved(lock_with(Pin::Research, &[], &mirror).rules());
        let read_only = resolved(lock_with(Pin::ReadOnly, &[], &mirror).rules());
        for action in ["webfetch", "websearch"] {
            assert_eq!(evaluate(action, "x", &research, S), Effect::Allow);
            assert!(wholly_disabled(action, &read_only, S));
        }
    }

    #[test]
    fn mirrored_web_rules_narrow_research_only() {
        let web_source = format!(
            "{BASELINE_AHEAD} ; webfetch https://intranet.example/*=deny ; websearch *=deny"
        );
        let mirror = mirror_of(&web_source, S);
        let research = resolved(lock_with(Pin::Research, &[], &mirror).rules());
        assert_eq!(
            evaluate("webfetch", "https://intranet.example/a", &research, S),
            Effect::Deny
        );
        assert_eq!(
            evaluate("webfetch", "https://example.org/a", &research, S),
            Effect::Allow
        );
        assert!(wholly_disabled("websearch", &research, S));
        // Control: without the rules in the mirror the intranet fetch reads Allow.
        let plain = resolved(lock_with(Pin::Research, &[], &baseline_mirror()).rules());
        assert_eq!(
            evaluate("webfetch", "https://intranet.example/a", &plain, S),
            Effect::Allow
        );
        assert!(!wholly_disabled("websearch", &plain, S));
        // An `ask` web rule is mirrored as a deny.
        let ask = mirror_of(&format!("{BASELINE_AHEAD} ; webfetch *.internal/*=ask"), S);
        assert!(group(&ask, "webfetch").ends_with("webfetch *.internal/*=deny"));
        // ReadOnly never reads the web groups.
        assert_eq!(
            lock_with(Pin::ReadOnly, &[], &mirror).rules(),
            lock_with(Pin::ReadOnly, &[], &baseline_mirror()).rules()
        );
    }

    #[test]
    fn a_denied_read_group_keeps_the_tool_listed() {
        for pin in [Pin::ReadOnly, Pin::Research] {
            let lock = lock_with(pin, &[], &mirror_of(READ_DENIED_SOURCE, S));
            let rules = resolved(lock.rules());
            assert!(!wholly_disabled("read", &rules, S));
            assert_eq!(evaluate("read", "src/a.rs", &rules, S), Effect::Deny);
            assert_eq!(evaluate("read", "", &rules, S), Effect::Deny);
        }
        // Nested deny-then-allow keeps its order, and a narrow last rule needs no keeper.
        let nested = mirror_of(
            &format!("{BASELINE_AHEAD} ; read secret/*=deny ; read secret/pub/*=allow"),
            S,
        );
        let lock = lock_with(Pin::ReadOnly, &[], &nested);
        assert!(show(lock.rules())
            .contains("read secret/*=deny ; read secret/pub/*=allow ; grep *=allow"));
        let rules = resolved(lock.rules());
        assert_eq!(evaluate("read", "secret/a", &rules, S), Effect::Deny);
        assert_eq!(evaluate("read", "secret/pub/a", &rules, S), Effect::Allow);
        // A user catch-all `* * deny` denies every mirrored group outright.
        let all_denied = mirror_of("* *=deny", S);
        let lock = lock_with(Pin::ReadOnly, &[], &all_denied);
        let rules = resolved(lock.rules());
        assert!(!wholly_disabled("read", &rules, S));
        assert!(wholly_disabled("grep", &rules, S));
        assert!(wholly_disabled("glob", &rules, S));
    }

    // ---- tail closure ----

    /// Every builtin visibility key and asserted action of the tested sources: v2.3.2 in
    /// full, plus v2.2.7's `opencode_schedule_*` (v2.2.0 adds no other id).
    const BUILTIN_KEYS: &[&str] = &[
        "read",
        "glob",
        "grep",
        "edit",
        "write",
        "patch",
        "opencode_worktree_remove",
        "shell",
        "webfetch",
        "websearch",
        "subagent",
        "skill",
        "question",
        "todowrite",
        "execute",
        "browser",
        "experimental_image_generate",
        "opencode_list_mcp_resources",
        "opencode_read_mcp_resource",
        "opencode_watch_mcp_event",
        "opencode_session_rename",
        "opencode_session_move",
        "opencode_worktree_create",
        "opencode_worktree_list",
        "opencode_models",
        "opencode_artifact_create",
        "opencode_artifact_read",
        "opencode_artifact_update",
        "opencode_artifact_delete",
        "opencode_automation_create",
        "opencode_automation_list",
        "opencode_automation_pause",
        "opencode_automation_resume",
        "opencode_automation_delete",
        "opencode_schedule_create",
        "opencode_schedule_list",
        "opencode_schedule_pause",
        "opencode_schedule_resume",
        "opencode_schedule_delete",
        "console_watch_watch",
        "console_watch_unwatch",
        "console_watch_watches",
        "console_watch_events",
        "external_directory",
    ];

    #[test]
    fn the_deny_tail_closes_every_builtin_key() {
        let mut prefixes: Vec<String> = Vec::new();
        for key in BUILTIN_KEYS {
            for (at, _) in key.match_indices('_') {
                let prefix = key[..at].to_string();
                if !prefixes.contains(&prefix) {
                    prefixes.push(prefix);
                }
            }
        }
        assert!(prefixes.contains(&"console_watch".to_string()));
        for case in [S, I] {
            let mut servers = prefixes.clone();
            if case == I {
                servers.extend(prefixes.iter().map(|p| p.to_uppercase()));
            }
            let servers: Vec<&str> = servers.iter().map(String::as_str).collect();
            let mirror = mirror_of(BASELINE_AHEAD, case);
            for pin in PINS {
                let lock = lock_with(pin, &servers, &mirror);
                let rules = resolved(lock.rules());
                let listed: &[&str] = match pin {
                    Pin::DiffOnly => &["read"],
                    Pin::ReadOnly => &["read", "grep", "glob"],
                    Pin::Research => &["read", "grep", "glob", "webfetch", "websearch"],
                };
                for key in BUILTIN_KEYS {
                    let disabled = wholly_disabled(key, &rules, case);
                    if *key == "skill" {
                        assert!(!disabled, "{pin:?} {case:?}: skill stays listed");
                        assert_eq!(evaluate("skill", "x", &rules, case), Effect::Deny);
                    } else {
                        assert_eq!(disabled, !listed.contains(key), "{pin:?} {case:?}: {key}");
                    }
                }
            }
        }
    }

    // ---- invariants ----

    #[test]
    fn hostile_inputs_keep_the_invariants() {
        let servers = ["gitdesktop", "a b", "", "a_b", "a b"];
        let hostile =
            "* *=allow ; r* x=allow ; READ y=allow ; read ~/z=allow ; read ~/z=deny ; * q=ask";
        for case in [S, I] {
            let mirror = mirror_of(hostile, case);
            for pin in PINS {
                let lock = lock_with(pin, &servers, &mirror);
                let rules = lock.rules();
                let label = format!("{pin:?} {case:?}");
                assert_eq!(rules[0], rule("*", "*", Effect::Deny), "{label}");
                assert!(rules.iter().all(|r| r.effect != Effect::Ask), "{label}");
                assert!(rules[1..].iter().all(|r| r.action != "*"), "{label}");
                let allowed = [
                    "read",
                    "grep",
                    "glob",
                    "webfetch",
                    "websearch",
                    "gitdesktop_*",
                    "a_b_*",
                ];
                for r in rules.iter().filter(|r| r.effect == Effect::Allow) {
                    assert!(allowed.contains(&r.action.as_str()), "{label}: {r:?}");
                }
                let server_allows: Vec<&str> = rules
                    .iter()
                    .filter(|r| r.effect == Effect::Allow && r.action.ends_with("_*"))
                    .map(|r| r.action.as_str())
                    .collect();
                assert_eq!(server_allows, ["gitdesktop_*", "a_b_*"], "{label}");
                let text = show(rules);
                assert!(!text.contains("read ~/z=allow"), "{label}");
                if pin == Pin::DiffOnly {
                    assert_eq!(
                        rules,
                        probe_document(Pin::DiffOnly, &servers, None)
                            .expect("probe")
                            .rules(),
                        "{label}: DiffOnly ignores the mirror"
                    );
                } else {
                    assert!(text.contains("read x=allow"), "{label}");
                    assert!(text.contains("read ~/z=deny"), "{label}");
                    assert!(text.contains("read q=deny"), "{label}");
                    assert_eq!(text.contains("read y=allow"), case == I, "{label}");
                }
            }
        }
    }

    #[test]
    fn server_names_are_sanitized_like_opencode() {
        assert_eq!(sanitize_server("my server"), "my_server");
        assert_eq!(sanitize_server("a-b_c9"), "a-b_c9");
        assert_eq!(sanitize_server("s\u{1F600}"), "s__", "two UTF-16 units");
        assert_eq!(sanitize_server("caf\u{e9}"), "caf_");
        assert_eq!(
            show(&server_allows(&["x", "x", "", "y.z", "y z"])),
            "x_* *=allow ; y_z_* *=allow"
        );
    }

    #[test]
    fn home_spelled_allows_are_dropped_and_denies_kept() {
        let source = "* ~=allow ; * $HOME=allow ; * ~/a=allow ; * $HOME/a=allow ; * $HOME\\a=allow ; * ~/b=deny ; * ~/c=ask ; * /root/d=allow ; re?d w=deny";
        let read = group(&mirror_of(source, S), "read");
        assert_eq!(
            read,
            "read ~/b=deny ; read ~/c=deny ; read /root/d=allow ; read w=deny"
        );
    }

    // ---- escaping and cap ----

    fn no_raw_token(json: &str) -> bool {
        !json.contains("{env:")
            && !json.contains("{file:")
            && json
                .match_indices('{')
                .all(|(at, _)| json[at + 1..].starts_with('"'))
    }

    #[test]
    fn braces_inside_strings_are_escaped() {
        let mirror = mirror_of(&format!("{BASELINE_AHEAD} ; read x{{env:HOME}}=deny"), S);
        let lock = lock_with(Pin::ReadOnly, &["{file:/etc/passwd}"], &mirror);
        assert!(no_raw_token(lock.json()));
        assert!(lock.json().contains(LEFT_BRACE_ESCAPE));
        let parsed: Value = serde_json::from_str(lock.json()).expect("valid JSON");
        let rules = agent_rules(&parsed["agents"][lock.agent().as_str()]).expect("rules");
        assert!(rules.contains(&rule("read", "x{env:HOME}", Effect::Deny)));
        assert_eq!(rules, lock.rules());
        // Control: plain `serde_json` string encoding leaves the token raw.
        let plain = lock.json().replace(LEFT_BRACE_ESCAPE, "{");
        assert!(!no_raw_token(&plain));
        assert_eq!(json_string("a{b"), format!("\"a{LEFT_BRACE_ESCAPE}b\""));
    }

    #[test]
    fn odd_resources_round_trip() {
        let resources = [
            "x{env:HOME}",
            "a\\b",
            "say \"hi\"",
            "two\nlines",
            "caf\u{e9}/\u{1F600}",
        ];
        let mirror = Mirror {
            rules: resources
                .iter()
                .map(|resource| rule("read", resource, Effect::Deny))
                .collect(),
        };
        let lock = lock_with(Pin::ReadOnly, &[], &mirror);
        assert!(no_raw_token(lock.json()));
        let parsed: Value = serde_json::from_str(lock.json()).expect("valid JSON");
        let rules = agent_rules(&parsed["agents"][lock.agent().as_str()]).expect("rules");
        assert_eq!(rules, lock.rules());
    }

    fn sized(resource: &str) -> Result<LockDocument, LockError> {
        let mirror = Mirror {
            rules: vec![rule("read", resource, Effect::Deny)],
        };
        document(AgentId::from_bits(9), Access::ReadOnly(&mirror), &[])
    }

    #[test]
    fn the_cap_counts_utf16_units() {
        let base = sized("").expect("small").json().encode_utf16().count();
        // Tested set: 29,999, 30,000, 30,001 units.
        for units in [29_999, 30_000] {
            let lock = sized(&"a".repeat(units - base)).expect("at or under the cap");
            assert_eq!(lock.json().encode_utf16().count(), units);
        }
        assert_eq!(
            sized(&"a".repeat(30_001 - base)).expect_err("over the cap"),
            LockError::TooLarge { units: 30_001 }
        );
        // An astral char is two units: under the cap in chars, over it in units.
        let count = (30_001 - base).div_ceil(2);
        assert!(base + count <= LOCK_DOCUMENT_CAP);
        assert_eq!(
            sized(&"\u{1F600}".repeat(count)).expect_err("over the cap"),
            LockError::TooLarge {
                units: base + 2 * count
            }
        );
    }

    #[test]
    fn an_oversized_mirror_is_refused_with_its_size() {
        let probe = probe_document(Pin::ReadOnly, &[], None).expect("probe");
        let mut source = list(BASELINE_AHEAD);
        source.extend((0..800).map(|n| rule("read", &format!("secret/{n:04}/**"), Effect::Deny)));
        let resolved = concat(&[&source, probe.rules(), &list(FIXED_TAIL)]);
        let mirror =
            read_back(&probe_output(&probe, &resolved), &probe, Pin::ReadOnly, S).expect("mirror");
        let err = lock_document(Access::ReadOnly(&mirror), &[]).expect_err("too large");
        let LockError::TooLarge { units } = err else {
            panic!("too large");
        };
        let rules = lock_rules(Access::ReadOnly(&mirror), &[]);
        let expected = document_json(&AgentId::from_bits(0), &rules, false)
            .encode_utf16()
            .count();
        assert_eq!(units, expected);
        assert!(units > LOCK_DOCUMENT_CAP);
        let message = err.message();
        assert!(message.contains(&format!("({units} characters, limit 30000)")));
        assert_eq!(
            message,
            format!("GitDesktop could not start this read-only opencode run: the read rules in your opencode config are too large to pass along ({units} characters, limit 30000). Shorten the permission rules in your opencode config, then try again.")
        );
    }

    // ---- read-back ----

    fn readback_of(output: &str, probe: &LockDocument) -> Result<Mirror, ReadbackError> {
        read_back(output, probe, Pin::ReadOnly, S)
    }

    #[test]
    fn plan_is_the_mirror_source_when_listed() {
        let probe = probe_document(Pin::ReadOnly, &[], None).expect("probe");
        let probe_entry = agent_entry(
            probe.agent().as_str(),
            &substituted(PROBE15_PROBE, "* *=deny ; read *=allow", &probe),
        );
        let with_plan = agents_output(vec![
            probe_entry.clone(),
            agent_entry("plan", &list(PROBE15_PLAN)),
        ]);
        let mirror = readback_of(&with_plan, &probe).expect("plan source");
        assert_eq!(
            group(&mirror, "read"),
            "read *=allow ; read *.env=deny ; read *.env.*=deny ; read *.env.example=allow ; read private/*=deny ; read secret/*=deny ; read /root/notes/*=allow"
        );
        assert_eq!(group(&mirror, "grep"), "grep *=allow ; grep *=deny");
        assert_eq!(group(&mirror, "glob"), "glob *=allow");
        assert_eq!(group(&mirror, "webfetch"), "webfetch *=allow");
        assert_eq!(group(&mirror, "websearch"), "websearch *=allow");
        let lock = lock_with(Pin::ReadOnly, &[], &mirror);
        assert!(show(lock.rules()).starts_with(
            "* *=deny ; read *=allow ; read *=allow ; read *.env=deny ; read *.env.*=deny ; read *.env.example=allow ; read private/*=deny ; read secret/*=deny ; read /root/notes/*=allow ; grep *=allow"
        ));
        let rules = resolved(lock.rules());
        assert_eq!(evaluate("read", "secret/a.txt", &rules, S), Effect::Deny);
        assert_eq!(evaluate("read", "private/a.txt", &rules, S), Effect::Deny);
        assert!(wholly_disabled("grep", &rules, S));

        // Control: without `plan` the source is the probe's prefix.
        let without = readback_of(&agents_output(vec![probe_entry]), &probe).expect("prefix");
        assert!(group(&without, "read").ends_with("read private/*=deny"));
        assert_eq!(group(&without, "grep"), "grep *=allow");
        let rules = resolved(lock_with(Pin::ReadOnly, &[], &without).rules());
        assert_eq!(evaluate("read", "secret/a.txt", &rules, S), Effect::Allow);
        assert_eq!(evaluate("read", "private/a.txt", &rules, S), Effect::Deny);
        assert!(!wholly_disabled("grep", &rules, S));
    }

    #[test]
    fn plan_builtin_extras_project_to_nothing() {
        let probe = probe_document(Pin::Research, &[], None).expect("probe");
        let output = agents_output(vec![
            agent_entry(
                probe.agent().as_str(),
                &substituted(PROBE7_BASELINE, "* *=deny", &probe),
            ),
            agent_entry("plan", &list(PROBE3_PLAN)),
        ]);
        let mirror = readback_of(&output, &probe).expect("plan source");
        assert_eq!(mirror, baseline_mirror());
        assert!(mirror
            .rules
            .iter()
            .all(|r| !["edit", "question", "browser", "skill"]
                .iter()
                .any(|word| r.resource.contains(word) || r.action == *word)));
    }

    #[test]
    fn a_malformed_plan_is_not_json() {
        let probe = probe_document(Pin::ReadOnly, &[], None).expect("probe");
        let clean = substituted(PROBE7_BASELINE, "* *=deny", &probe);
        let not_last = concat(&[&clean, &list("shell *=allow")]);
        let bad_effect = json!({"id": "plan", "permissions": [
            {"action": "read", "resource": "*", "effect": "maybe"}
        ]});
        let not_array = json!({"id": "plan", "permissions": {"read": "deny"}});
        for plan in [bad_effect, not_array] {
            for probe_rules in [&clean, &not_last] {
                let output = agents_output(vec![
                    agent_entry(probe.agent().as_str(), probe_rules),
                    plan.clone(),
                ]);
                assert_eq!(readback_of(&output, &probe), Err(ReadbackError::NotJson));
            }
        }
    }

    #[test]
    fn a_diff_only_read_back_ignores_plan() {
        let bad_plan = json!({"id": "plan", "permissions": {"read": "deny"}});
        let probe = probe_document(Pin::DiffOnly, &[], None).expect("probe");
        let clean = substituted(PROBE7_BASELINE, "* *=deny", &probe);
        let output = agents_output(vec![
            agent_entry(probe.agent().as_str(), &clean),
            bad_plan.clone(),
        ]);
        assert_eq!(
            read_back(&output, &probe, Pin::DiffOnly, S),
            Ok(Mirror::empty())
        );
        // The order check still holds for DiffOnly.
        let not_last = concat(&[&clean, &list("shell *=allow")]);
        let output = agents_output(vec![
            agent_entry(probe.agent().as_str(), &not_last),
            bad_plan.clone(),
        ]);
        assert_eq!(
            read_back(&output, &probe, Pin::DiffOnly, S),
            Err(ReadbackError::NotLast)
        );
        // The same listing under ReadOnly still refuses the malformed plan.
        let probe = probe_document(Pin::ReadOnly, &[], None).expect("probe");
        let output = agents_output(vec![
            agent_entry(
                probe.agent().as_str(),
                &substituted(PROBE7_BASELINE, "* *=deny", &probe),
            ),
            bad_plan,
        ]);
        assert_eq!(
            read_back(&output, &probe, Pin::ReadOnly, S),
            Err(ReadbackError::NotJson)
        );
    }

    #[test]
    fn the_landed_last_check_reads_the_probe_agent_only() {
        let probe = probe_document(Pin::ReadOnly, &[], None).expect("probe");
        let clean = substituted(PROBE7_BASELINE, "* *=deny", &probe);
        let plan_opened = format!("{PROBE3_PLAN} ; shell *=allow");
        let output = agents_output(vec![
            agent_entry(probe.agent().as_str(), &clean),
            agent_entry("plan", &list(&plan_opened)),
        ]);
        assert!(readback_of(&output, &probe).is_ok());
        let not_last = concat(&[&clean, &list("shell *=allow")]);
        let output = agents_output(vec![
            agent_entry(probe.agent().as_str(), &not_last),
            agent_entry("plan", &list(PROBE3_PLAN)),
        ]);
        assert_eq!(readback_of(&output, &probe), Err(ReadbackError::NotLast));
    }

    #[test]
    fn measured_read_backs() {
        let probe = probe_document(Pin::ReadOnly, &[], None).expect("probe");
        assert_eq!(
            readback_of(&baseline_output(&probe), &probe),
            Ok(baseline_mirror())
        );
        let hostile_ahead = substituted(PROBE5_AHEAD, PROBE5_PIN, &probe);
        assert_eq!(
            readback_of(&probe_output(&probe, &hostile_ahead), &probe),
            Ok(baseline_mirror()),
            "shell and edit layers ahead reach no projection"
        );
        let after = substituted(PROBE5_AFTER, PROBE5_PIN, &probe);
        assert_eq!(
            readback_of(&probe_output(&probe, &after), &probe),
            Err(ReadbackError::NotLast)
        );
        let builtins: Vec<Value> = BUILTIN_AGENTS
            .iter()
            .map(|id| {
                let rules = match *id {
                    "plan" => PROBE3_PLAN,
                    "build" => PROBE3_BUILD,
                    _ => PROBE7_BASELINE,
                };
                agent_entry(id, &list(rules))
            })
            .collect();
        assert_eq!(
            readback_of(&agents_output(builtins), &probe),
            Err(ReadbackError::AgentAbsent)
        );
        assert_eq!(
            readback_of(&probe_output(&probe, &list(PROBE5_DROPPED)), &probe),
            Err(ReadbackError::NotLast)
        );
    }

    #[test]
    fn unreadable_read_backs_are_not_json() {
        let probe = probe_document(Pin::ReadOnly, &[], None).expect("probe");
        let bad_effect = json!([{"id": probe.agent().as_str(), "permissions": [
            {"action": "*", "resource": "*", "effect": "maybe"}
        ]}]);
        let no_permissions = json!([{"id": probe.agent().as_str()}]);
        let numeric_action = json!([{"id": probe.agent().as_str(), "permissions": [
            {"action": 1, "resource": "*", "effect": "deny"}
        ]}]);
        for output in [
            "Error: not ready".to_string(),
            String::new(),
            "  \n".to_string(),
            r#"{"agents":[]}"#.to_string(),
            "[1, 2".to_string(),
            bad_effect.to_string(),
            no_permissions.to_string(),
            numeric_action.to_string(),
        ] {
            assert_eq!(
                readback_of(&output, &probe),
                Err(ReadbackError::NotJson),
                "{output}"
            );
        }
    }

    #[test]
    fn only_wildcard_denies_or_the_fixed_tail_follow_the_probe() {
        assert_eq!(
            list(FIXED_TAIL),
            FIXED_TAIL_DENIES.map(|(action, resource)| rule(action, resource, Effect::Deny))
        );
        let probe = probe_document(Pin::ReadOnly, &[], None).expect("probe");
        let clean = substituted(PROBE7_BASELINE, "* *=deny", &probe);
        let ok = |rules: &[Rule]| readback_of(&probe_output(&probe, rules), &probe);
        assert!(ok(&clean).is_ok(), "the measured tail");
        assert!(
            ok(&concat(&[&list(BASELINE_AHEAD), probe.rules()])).is_ok(),
            "0 denies"
        );
        for after in [
            "edit *=deny",
            "* *=deny",
            "edit *=deny ; shell *=deny",
            "edit *=deny ; skill browser=deny",
        ] {
            assert!(ok(&concat(&[&clean, &list(after)])).is_ok(), "{after}");
        }
        for after in [
            "x y=deny",
            "edit *=deny ; x y=deny",
            "read secret/*=deny",
            "skill other=deny",
            "skill browser2=deny",
            "browser x=deny",
            "edit *=ask",
            "shell *=ask",
            "shell *=allow",
            "shell *=allow ; edit *=deny",
            // The fixed tail follows only as a deny, and only for its own action.
            "browser *=allow",
            "skill browser=ask",
            "read browser=deny",
        ] {
            assert_eq!(
                ok(&concat(&[&clean, &list(after)])),
                Err(ReadbackError::NotLast),
                "{after}"
            );
        }
        // One probe rule missing, two reordered, one with another effect.
        let own = probe.rules().to_vec();
        let mut missing = own.clone();
        missing.remove(2);
        let mut reordered = own.clone();
        reordered.swap(1, 2);
        let mut flipped = own.clone();
        flipped[1].effect = Effect::Deny;
        for broken in [missing, reordered, flipped] {
            let rules = concat(&[&list(BASELINE_AHEAD), &broken, &list(FIXED_TAIL)]);
            assert_eq!(ok(&rules), Err(ReadbackError::NotLast), "{}", show(&broken));
        }
        // DiffOnly goes through the same check.
        let probe = probe_document(Pin::DiffOnly, &[], None).expect("probe");
        let clean = substituted(PROBE7_BASELINE, "* *=deny", &probe);
        let diff_only =
            |rules: &[Rule]| read_back(&probe_output(&probe, rules), &probe, Pin::DiffOnly, S);
        assert_eq!(diff_only(&clean), Ok(Mirror::empty()));
        assert_eq!(
            diff_only(&concat(&[&clean, &list("x y=deny")])),
            Err(ReadbackError::NotLast)
        );
    }

    #[test]
    fn read_back_tolerates_layout_and_order() {
        let probe = probe_document(Pin::ReadOnly, &[], None).expect("probe");
        let clean = substituted(PROBE7_BASELINE, "* *=deny", &probe);
        let others = || {
            vec![
                agent_entry("build", &list(PROBE3_BUILD)),
                agent_entry(
                    "planner",
                    &list(&format!("{BASELINE_AHEAD} ; read secret/*=deny")),
                ),
                agent_entry(
                    "Plan",
                    &list(&format!("{BASELINE_AHEAD} ; read secret/*=deny")),
                ),
                json!({"id": "broken", "permissions": "not an array"}),
            ]
        };
        let mut first = vec![agent_entry(probe.agent().as_str(), &clean)];
        first.extend(others());
        let mut last = others();
        last.push(agent_entry(probe.agent().as_str(), &clean));
        for agents in [first, last] {
            let lf = agents_output(agents);
            for output in [
                lf.clone(),
                lf.replace('\n', "\r\n"),
                format!("\n\t  {lf}  \r\n"),
            ] {
                assert_eq!(
                    readback_of(&output, &probe),
                    Ok(baseline_mirror()),
                    "`planner` and `Plan` are not `plan`; other entries go unchecked"
                );
            }
        }
    }

    #[test]
    fn readback_messages_share_the_lead() {
        for (error, detail) in [
            (
                ReadbackError::NotJson,
                " opencode's agent list was not the JSON GitDesktop expected.",
            ),
            (
                ReadbackError::AgentAbsent,
                " opencode did not load the lock.",
            ),
            (
                ReadbackError::NotLast,
                " Another opencode setting takes effect after the lock.",
            ),
        ] {
            assert_eq!(
                error.message(),
                format!("{READBACK_REFUSAL_LEAD}{detail} Check your opencode config with \"opencode debug config\", or update opencode, then try again.")
            );
        }
        assert!(ReadbackError::NotJson
            .message()
            .contains("was not the JSON GitDesktop expected"));
        let needle = ["could not confirm", "that opencode applied"].join(" ");
        assert_eq!(include_str!("opencode2.rs").matches(&needle).count(), 1);
        assert!(READBACK_REFUSAL_LEAD.contains(&needle));
    }

    // ---- inherited content ----

    #[test]
    fn inherited_content_refuses_read_only_pins() {
        let read_rules = "{\"permission\":{\"read\":\"deny\"}}";
        for pin in PINS {
            for inherited in [None, Some(""), Some(" "), Some("{}"), Some(read_rules)] {
                let got = probe_document(pin, &[], inherited);
                let refused = pin != Pin::DiffOnly && inherited.is_some_and(|v| !v.is_empty());
                if refused {
                    assert_eq!(
                        got.as_ref().map(|_| ()),
                        Err(&LockError::InheritedContent),
                        "{pin:?} {inherited:?}"
                    );
                    // Control: the builder the check guards accepts the same row.
                    let empty = Mirror::empty();
                    assert!(document(AgentId::mint(), access(pin, &empty), &[]).is_ok());
                } else {
                    assert!(got.is_ok(), "{pin:?} {inherited:?}");
                }
            }
        }
        let message = LockError::InheritedContent.message();
        assert!(message.contains(CONTENT_ENV));
        assert_eq!(
            message,
            "GitDesktop did not start this read-only opencode run because the OPENCODE_CONFIG_CONTENT environment variable is set. GitDesktop needs that variable for its read-only lock, and replacing yours could drop read rules you keep there. Move those settings into your opencode config file or unset the variable, then try again."
        );
    }

    // ---- argv ----

    fn argv(args: &[String]) -> Vec<&str> {
        args.iter().map(String::as_str).collect()
    }

    fn v232() -> Version {
        let Ok(Cli::V2(version)) = classify_version("opencode v2.3.2") else {
            panic!("2.3.2");
        };
        version
    }

    /// The flags no builder may emit, and the arm rules: `--auto` only on a write turn,
    /// `--agent <lock id>` only on a locked one.
    fn argv_violations(args: &[String], lock: Option<&LockDocument>) -> Vec<String> {
        let mut found = Vec::new();
        if args.first().map(String::as_str) != Some("run")
            || !args.iter().any(|a| a == "--standalone")
        {
            found.push("not a standalone run".to_string());
        }
        for banned in [
            "--dir",
            "--variant",
            "--continue",
            "--dangerously-skip-permissions",
            "--yolo",
        ] {
            if args.iter().any(|a| a == banned) {
                found.push(banned.to_string());
            }
        }
        let agent = args
            .iter()
            .position(|a| a == "--agent")
            .map(|at| args.get(at + 1).map(String::as_str));
        match lock {
            Some(lock) => {
                if args.iter().any(|a| a == "--auto") {
                    found.push("--auto on a locked run".to_string());
                }
                if agent != Some(Some(lock.agent().as_str())) {
                    found.push("locked run without its agent".to_string());
                }
            }
            None => {
                if agent.is_some() {
                    found.push("--agent on a write turn".to_string());
                }
                if !args.iter().any(|a| a == "--auto") {
                    found.push("write turn without --auto".to_string());
                }
            }
        }
        found
    }

    #[test]
    fn review_args_are_exact() {
        let lock = lock_with(Pin::ReadOnly, &[], &Mirror::empty());
        let id = lock.agent().as_str();
        let run = ["run", "--standalone", "--format", "json", "--agent", id];
        let model = ["-m", "opencode/big-pickle#high"];
        for typed in ["opencode/big-pickle", "  opencode/big-pickle  "] {
            assert_eq!(
                argv(&review_args(v232(), &lock, typed, Some("high"))),
                [&run[..], &["--archived"], &model].concat(),
                "{typed:?}"
            );
        }
        assert_eq!(
            argv(&review_args(
                version(2, 2, 5),
                &lock,
                "opencode/big-pickle",
                Some("high")
            )),
            [&run[..], &model].concat()
        );
        assert_eq!(
            argv(&review_args(version(2, 2, 6), &lock, "  ", Some("high"))),
            [&run[..], &["--archived"]].concat()
        );
    }

    #[test]
    fn session_args_are_exact() {
        let lock = lock_with(Pin::ReadOnly, &[], &Mirror::empty());
        let id = lock.agent().as_str();
        for typed in ["m/x", " m/x "] {
            assert_eq!(
                argv(&session_args(
                    SessionAgent::Locked(&lock),
                    typed,
                    None,
                    Some("ses_abc")
                )),
                [
                    "run",
                    "--standalone",
                    "--format",
                    "json",
                    "--agent",
                    id,
                    "--session",
                    "ses_abc",
                    "-m",
                    "m/x"
                ],
                "{typed:?}"
            );
        }
        assert_eq!(
            argv(&session_args(
                SessionAgent::Write,
                "",
                None,
                Some(" ses_abc ")
            )),
            [
                "run",
                "--standalone",
                "--format",
                "json",
                "--auto",
                "--session",
                "ses_abc"
            ]
        );
        for session in [None, Some(""), Some("  ")] {
            assert_eq!(
                argv(&session_args(SessionAgent::Write, "m/x", None, session)),
                [
                    "run",
                    "--standalone",
                    "--format",
                    "json",
                    "--auto",
                    "-m",
                    "m/x"
                ],
                "{session:?}"
            );
        }
    }

    #[test]
    fn no_builder_emits_a_banned_flag() {
        let lock = lock_with(Pin::ReadOnly, &[], &Mirror::empty());
        let models = ["", "m/x", "m/x#v"];
        let variants = [None, Some(""), Some("high")];
        let sessions = [None, Some(""), Some("  "), Some("ses_1")];
        for model in models {
            for variant in variants {
                for at in [version(2, 2, 5), version(2, 2, 6), v232()] {
                    let args = review_args(at, &lock, model, variant);
                    assert!(argv_violations(&args, Some(&lock)).is_empty(), "{args:?}");
                    assert_eq!(args.iter().any(|a| a == "--archived"), at >= ARCHIVED_SINCE);
                }
                for session in sessions {
                    let locked = session_args(SessionAgent::Locked(&lock), model, variant, session);
                    assert!(
                        argv_violations(&locked, Some(&lock)).is_empty(),
                        "{locked:?}"
                    );
                    let write = session_args(SessionAgent::Write, model, variant, session);
                    assert!(argv_violations(&write, None).is_empty(), "{write:?}");
                    for args in [&locked, &write] {
                        assert!(!args.iter().any(|a| a == "--archived"));
                    }
                }
            }
        }
        // Controls: a locked run with `--auto` and a write turn naming an agent both fail.
        let mut locked = session_args(SessionAgent::Locked(&lock), "m/x", None, None);
        locked.push("--auto".to_string());
        assert!(!argv_violations(&locked, Some(&lock)).is_empty());
        let mut write = session_args(SessionAgent::Write, "m/x", None, None);
        write.extend(["--agent".to_string(), lock.agent().as_str().to_string()]);
        assert!(!argv_violations(&write, None).is_empty());
    }

    #[test]
    fn model_arg_carries_one_variant() {
        assert_eq!(model_arg("a/b#c", Some("high")).as_deref(), Some("a/b#c"));
        assert_eq!(model_arg("a/b", Some("high")).as_deref(), Some("a/b#high"));
        assert_eq!(model_arg("a/b", Some("")).as_deref(), Some("a/b"));
        assert_eq!(model_arg("a/b", None).as_deref(), Some("a/b"));
        assert_eq!(model_arg(" ", Some("high")), None);
        assert_eq!(
            model_arg(" a/b ", Some("high")).as_deref(),
            Some("a/b#high")
        );
        assert_eq!(
            model_arg("\ta/b#c\n", Some("high")).as_deref(),
            Some("a/b#c")
        );
        assert_eq!(model_arg(" a/b ", None).as_deref(), Some("a/b"));
    }

    #[test]
    fn helper_commands_run_standalone() {
        for args in [MODELS_ARGS, READBACK_ARGS, CATALOG_ARGS] {
            assert_eq!(args.last(), Some(&"--standalone"));
        }
        assert_eq!(MODELS_ARGS, ["models", "--standalone"]);
        assert_eq!(READBACK_ARGS, ["debug", "agents", "--standalone"]);
        assert_eq!(CATALOG_ARGS, ["api", "GET", "/api/model", "--standalone"]);
    }

    // ---- env ----

    fn pairs(env: &[(&'static str, String)]) -> Vec<(String, String)> {
        env.iter()
            .map(|(key, value)| (key.to_string(), value.clone()))
            .collect()
    }

    fn projects_disabled(env: &[(&'static str, String)]) -> bool {
        [
            "OPENCODE_DISABLE_PROJECT_CONFIG",
            "OPENCODE_CONFIG_PROJECT_DISABLE",
        ]
        .iter()
        .all(|key| env.iter().any(|(k, v)| k == key && v == "1"))
    }

    #[test]
    fn review_env_is_exact() {
        let lock = lock_with(Pin::ReadOnly, &[], &Mirror::empty());
        let env = review_env(Some("p"), &lock);
        let expected = [
            ("OPENCODE_CONFIG", "p"),
            ("OPENCODE_DISABLE_MODELS_FETCH", "1"),
            ("OPENCODE_CONFIG_CONTENT", lock.json()),
            ("OPENCODE_DISABLE_PROJECT_CONFIG", "1"),
            ("OPENCODE_CONFIG_PROJECT_DISABLE", "1"),
        ]
        .map(|(key, value)| (key.to_string(), value.to_string()));
        assert_eq!(pairs(&env), expected);
        assert_eq!(review_env(None, &lock).len(), 4);
        assert!(projects_disabled(&env));
        // Control: without the second variable the check fails.
        let dropped: Vec<_> = env
            .iter()
            .filter(|(key, _)| *key != "OPENCODE_CONFIG_PROJECT_DISABLE")
            .cloned()
            .collect();
        assert!(!projects_disabled(&dropped));
    }

    #[test]
    fn session_env_keeps_project_config() {
        let lock = lock_with(Pin::ReadOnly, &[], &Mirror::empty());
        assert_eq!(
            pairs(&session_env(None, None)),
            [("OPENCODE_DISABLE_MODELS_FETCH".to_string(), "1".to_string())]
        );
        let env = session_env(Some("p".to_string()), Some(&lock));
        assert_eq!(
            pairs(&env),
            [
                ("OPENCODE_CONFIG", "p"),
                ("OPENCODE_DISABLE_MODELS_FETCH", "1"),
                ("OPENCODE_CONFIG_CONTENT", lock.json()),
            ]
            .map(|(key, value)| (key.to_string(), value.to_string()))
        );
        assert!(env.iter().all(|(key, _)| !key.contains("PROJECT")));
    }

    #[test]
    fn env_builders_set_the_lock_under_content_env_only() {
        assert_eq!(CONTENT_ENV, "OPENCODE_CONFIG_CONTENT");
        let lock = lock_with(Pin::Research, &[], &Mirror::empty());
        let all = [
            review_env(Some("p"), &lock),
            review_env(None, &lock),
            session_env(Some("p".to_string()), Some(&lock)),
            session_env(None, Some(&lock)),
            session_env(None, None),
        ];
        for env in &all {
            for (key, value) in env {
                assert!(*key != "OPENCODE_PERMISSION" && *key != "OPENCODE_ENABLE_EXA");
                if value == lock.json() {
                    assert_eq!(*key, CONTENT_ENV);
                }
            }
        }
        for env in &all[..4] {
            assert!(env
                .iter()
                .any(|(key, value)| *key == CONTENT_ENV && value == lock.json()));
        }
    }

    // ---- stream ----

    use crate::agent::ReviewEvent;

    const SESSION: &str = "ses_e060db69fffeLmw7shyfP2Dp39";

    /// Line shapes from `cli/src/run/noninteractive.ts` (text :394-403, tool :433-442,
    /// step :458-461, retry :481-487, background_wait :471).
    fn step_start(message: &str) -> String {
        json!({"type": "step_start", "timestamp": 1, "sessionID": SESSION, "part": {
            "id": "prt_1f9f25270001Xa3CImh2pYBpJ4", "sessionID": SESSION, "messageID": message,
            "type": "step-start", "snapshot": "893d1bd04192843749113fb00d9aa70e57207d64"}})
        .to_string()
    }

    fn text_line(message: &str, part_id: &str, text: &str) -> String {
        json!({"type": "text", "timestamp": 2, "sessionID": SESSION, "part": {
            "id": part_id, "sessionID": SESSION, "messageID": message, "type": "text",
            "text": text, "time": {"start": 1, "end": 2}}})
        .to_string()
    }

    /// A live text event: its part id comes from the text-started event.
    fn live(message: &str, text: &str) -> String {
        text_line(message, "prt_1f9f2527a001live", text)
    }

    /// A reconcile text event for block `ordinal` of `message`.
    fn projected(message: &str, ordinal: usize, text: &str) -> String {
        let id = format!(
            "prt_{}_text-{ordinal}",
            message.strip_prefix("msg_").unwrap()
        );
        text_line(message, &id, text)
    }

    fn tool_use(message: &str, tool: &str, status: &str, input: Value) -> String {
        let state = if status == "completed" {
            json!({"status": status, "input": input, "output": "", "title": tool,
                "metadata": {}, "time": {"start": 1, "end": 2}})
        } else {
            json!({"status": status, "input": input, "error": "Permission denied: read",
                "metadata": {}, "time": {"start": 1, "end": 2}})
        };
        json!({"type": "tool_use", "timestamp": 3, "sessionID": SESSION, "part": {
            "partID": "prt_1f9f2527b001tool", "sessionID": SESSION, "messageID": message,
            "type": "tool", "id": "call_1", "tool": tool, "state": state}})
        .to_string()
    }

    fn step_finish(message: &str, reason: Option<&str>) -> String {
        let mut part = json!({"id": "prt_1f9f2527c001fin", "sessionID": SESSION,
            "messageID": message, "type": "step-finish", "snapshot": "abc", "cost": 0,
            "tokens": {"input": 1, "output": 1}});
        if let Some(reason) = reason {
            part["reason"] = json!(reason);
        }
        json!({"type": "step_finish", "timestamp": 4, "sessionID": SESSION, "part": part})
            .to_string()
    }

    fn error_line(message: &str) -> String {
        json!({"type": "error", "timestamp": 5, "sessionID": SESSION,
            "error": {"type": "unknown", "message": message}})
        .to_string()
    }

    /// `probe:probe5-v2.3.2.txt:25`, its message completed past the probe's clip.
    fn retry_line(attempt: u32) -> String {
        json!({"type": "retry", "timestamp": 6, "sessionID": SESSION,
            "messageID": "msg_1f9f251d9001AdTr2YI5Jh7x6u", "attempt": attempt,
            "nextRetryAt": 1795194772172u64, "error": {"type": "provider.transport",
            "message": format!("Can't reach opencode.ai. Check the network connection. (attempt {attempt})")}})
        .to_string()
    }

    fn background_wait() -> String {
        json!({"type": "background_wait", "timestamp": 7, "sessionID": SESSION,
            "jobs": [{"id": "job_1", "kind": "shell", "title": "build"}]})
        .to_string()
    }

    /// Feeds every line and returns both slots' events in order, asserting slot 0 is only
    /// ever a `NativeSession` and slot 1 never one, nor a terminal event.
    fn feed(parser: &mut StreamParser, lines: &[String]) -> Vec<ReviewEvent> {
        let mut events = Vec::new();
        for line in lines {
            let [native, event] = parser.line(line);
            assert!(
                matches!(native, None | Some(ReviewEvent::NativeSession { .. })),
                "slot 0 from line {line}: {native:?}"
            );
            assert!(
                !matches!(
                    event,
                    Some(
                        ReviewEvent::NativeSession { .. }
                            | ReviewEvent::Done { .. }
                            | ReviewEvent::Error { .. }
                    )
                ),
                "slot 1 from line {line}: {event:?}"
            );
            events.extend(native);
            events.extend(event);
        }
        events
    }

    /// How many `NativeSession`s `events` holds, each carrying `SESSION`.
    fn natives(events: &[ReviewEvent]) -> usize {
        events
            .iter()
            .filter(|event| match event {
                ReviewEvent::NativeSession { id } => {
                    assert_eq!(id, SESSION);
                    true
                }
                _ => false,
            })
            .count()
    }

    fn streamed(events: &[ReviewEvent]) -> String {
        events
            .iter()
            .filter_map(|event| match event {
                ReviewEvent::Delta { text } => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    fn done_text(event: Option<ReviewEvent>) -> String {
        match event {
            Some(ReviewEvent::Done {
                text,
                is_error: false,
                cost_usd: None,
            }) => text,
            other => panic!("expected Done, got {other:?}"),
        }
    }

    fn error_message(event: Option<ReviewEvent>) -> String {
        match event {
            Some(ReviewEvent::Error {
                message,
                partial_text: None,
                timed_out: false,
            }) => message,
            other => panic!("expected Error, got {other:?}"),
        }
    }

    /// Runs `lines` through a fresh unlocked parser and finishes with `exit_code`.
    fn outcome(lines: &[String], exit_code: Option<i32>) -> Option<ReviewEvent> {
        let mut parser = StreamParser::new(None);
        feed(&mut parser, lines);
        parser.finish(exit_code, None)
    }

    #[test]
    fn a_successful_run_streams_its_text_and_finishes_done() {
        let m = "msg_1f9f251d9001AdTr2YI5Jh7x6u";
        let lines = [step_start(m), live(m, "pong"), step_finish(m, Some("stop"))];
        let mut parser = StreamParser::new(None);
        let events = feed(&mut parser, &lines);
        assert!(
            matches!(&events[..], [ReviewEvent::NativeSession { id }, ReviewEvent::Delta { text }]
                if id == SESSION && text == "pong"),
            "{events:?}"
        );
        assert_eq!(done_text(parser.finish(Some(0), None)), "pong");
    }

    #[test]
    fn done_carries_the_last_step_and_the_stream_ends_with_it() {
        // `probe:probe6-enforce.txt:20-35`: four steps, the third without text.
        let (a, b, c, d) = ("msg_a1", "msg_b2", "msg_c3", "msg_d4");
        let last = "Here's what happened, in order:\n\n1. **`touch /tmp/owned`** - Not performed.";
        let lines = [
            step_start(a),
            live(a, "I'll work through these in order."),
            tool_use(
                a,
                "glob",
                "completed",
                json!({"pattern": "README.md", "path": "/work/repo"}),
            ),
            tool_use(
                a,
                "glob",
                "completed",
                json!({"pattern": "secret/a.txt", "path": "/work/repo"}),
            ),
            step_finish(a, Some("tool-calls")),
            step_start(b),
            live(
                b,
                "No shell tool is available, so item 1 can't be performed.",
            ),
            tool_use(
                b,
                "read",
                "completed",
                json!({"path": "/work/repo/README.md"}),
            ),
            step_finish(b, Some("tool-calls")),
            step_start(c),
            tool_use(
                c,
                "read",
                "error",
                json!({"path": "/work/repo/secret/a.txt"}),
            ),
            step_finish(c, Some("tool-calls")),
            step_start(d),
            live(d, last),
            step_finish(d, Some("stop")),
        ];
        let mut parser = StreamParser::new(None);
        let events = feed(&mut parser, &lines);
        let tools = events
            .iter()
            .filter(|event| matches!(event, ReviewEvent::Tool { .. }))
            .count();
        assert_eq!(tools, 4, "the failed read still yields a step");
        let text = done_text(parser.finish(Some(0), None));
        assert_eq!(text, last);
        assert!(streamed(&events).ends_with(&text));
        assert!(streamed(&events).starts_with("I'll work through these in order.\n\nNo shell"));
    }

    #[test]
    fn a_failed_step_then_an_error_line_never_reads_as_done() {
        let m = "msg_f1";
        let lines = [
            step_start(m),
            live(m, "Working on it."),
            step_finish(m, Some("error")),
            error_line("Model is overloaded"),
        ];
        assert_eq!(
            error_message(outcome(&lines, Some(1))),
            "Model is overloaded"
        );
    }

    #[test]
    fn an_error_after_a_stop_finish_fails_the_run() {
        // M20, `probe:probe14.txt:7-9`.
        let (a, b, c) = ("msg_m20a", "msg_m20b", "msg_m20c");
        let message = "Cancelled a request for input this run cannot answer: Web Search";
        let lines = [
            step_start(a),
            live(
                a,
                "I'll run both tool calls in parallel since they're independent.",
            ),
            tool_use(a, "websearch", "error", json!({"query": "opencode"})),
            tool_use(
                a,
                "webfetch",
                "completed",
                json!({"url": "https://example.com"}),
            ),
            step_finish(a, Some("tool-calls")),
            step_start(b),
            live(
                b,
                "The search was cancelled and the fetch returned only body text.",
            ),
            tool_use(b, "websearch", "error", json!({"query": "opencode"})),
            tool_use(
                b,
                "webfetch",
                "completed",
                json!({"url": "https://example.com"}),
            ),
            step_finish(b, Some("tool-calls")),
            step_start(c),
            live(c, "Here are the results of each tool call:"),
            step_finish(c, Some("stop")),
            error_line(message),
        ];
        assert_eq!(error_message(outcome(&lines, Some(1))), message);
    }

    #[test]
    fn an_error_line_alone_fails_the_run_whatever_the_exit() {
        let lines = [error_line("Model not found: nosuch/model")];
        for exit in [Some(1), Some(0), None] {
            assert_eq!(
                error_message(outcome(&lines, exit)),
                "Model not found: nosuch/model"
            );
        }
        // Only the first error is kept; a bare string and an odd shape are read too.
        let two = [error_line("first"), error_line("second")];
        assert_eq!(error_message(outcome(&two, Some(1))), "first");
        let bare = [json!({"type": "error", "error": "plain"}).to_string()];
        assert_eq!(error_message(outcome(&bare, Some(1))), "plain");
        let odd = [json!({"type": "error", "error": {"code": 7}}).to_string()];
        assert_eq!(
            error_message(outcome(&odd, Some(1))),
            "opencode reported an error."
        );
    }

    #[test]
    fn an_error_naming_the_lock_agent_reads_as_the_lock_dropped() {
        // `probe:probe5-v2.3.2.txt:21`, the agent named being this lock's.
        let lock = lock_with(Pin::DiffOnly, &[], &Mirror::empty());
        let raw = format!("Agent not found: \"{}\"", lock.agent().as_str());
        let line = json!({"type": "error", "timestamp": 1795194765156u64, "sessionID": SESSION,
            "error": {"type": "unknown", "message": raw}})
        .to_string();
        let mut locked = StreamParser::new(Some(&lock));
        feed(&mut locked, std::slice::from_ref(&line));
        assert_eq!(error_message(locked.finish(Some(1), None)), LOCK_DROPPED);
        assert_eq!(
            LOCK_DROPPED,
            "opencode did not load GitDesktop's read-only lock, so the run was stopped before it started. Check your opencode config with \"opencode debug config\", then try again."
        );
        assert_eq!(error_message(outcome(&[line], Some(1))), raw);
        // Another agent's name is not the lock's.
        let mut locked = StreamParser::new(Some(&lock));
        feed(
            &mut locked,
            &[error_line("Agent not found: \"nosuchagent\"")],
        );
        assert_eq!(
            error_message(locked.finish(Some(1), None)),
            "Agent not found: \"nosuchagent\""
        );
    }

    #[test]
    fn a_non_zero_exit_without_an_error_line_names_the_exit() {
        let m = "msg_x1";
        let base = vec![step_start(m), live(m, "partial answer")];
        let with = |reason: Option<&str>| {
            let mut lines = base.clone();
            lines.push(step_finish(m, reason));
            lines
        };
        assert_eq!(
            error_message(outcome(&base, Some(1))),
            "opencode exited with code 1 before it finished."
        );
        assert_eq!(
            error_message(outcome(&with(Some("content-filter")), Some(1))),
            "opencode exited with code 1 before it finished. The model's reply was blocked by a content filter."
        );
        assert_eq!(
            error_message(outcome(&with(Some("length")), Some(137))),
            "opencode exited with code 137 before it finished. The reply hit the model's output limit."
        );
        assert_eq!(
            error_message(outcome(&with(Some("stop")), Some(1))),
            "opencode exited with code 1 before it finished."
        );
        assert_eq!(
            error_message(outcome(&base, None)),
            "opencode stopped before it finished."
        );
        assert_eq!(
            error_message(outcome(&with(Some("length")), None)),
            "opencode stopped before it finished. The reply hit the model's output limit."
        );
        // The LAST recorded reason counts: a later finish without one clears it.
        let mut lines = with(Some("length"));
        lines.push(step_finish(m, None));
        assert_eq!(
            error_message(outcome(&lines, Some(1))),
            "opencode exited with code 1 before it finished."
        );
    }

    #[test]
    fn a_stream_without_events_finishes_with_nothing() {
        // `probe:probe5-v2.3.2.txt:29`: a flag error prints help on stdout.
        let help: Vec<String> = [
            "DESCRIPTION",
            "  Run OpenCode with a message",
            "",
            "USAGE",
            "  opencode run [flags] [<message...>]",
            "  --model, -m string        Model to use in the format provider/model#variant",
            "[{\"type\": \"text\"}]",
            "{\"type\": 7}",
            "{\"part\": {\"text\": \"x\"}}",
            "   ",
        ]
        .iter()
        .map(|line| line.to_string())
        .collect();
        for lines in [Vec::new(), help] {
            for exit in [Some(0), Some(1), None] {
                assert!(outcome(&lines, exit).is_none(), "{lines:?} exit {exit:?}");
            }
        }
    }

    #[test]
    fn no_step_finish_reason_is_terminal() {
        for reason in [
            Some("stop"),
            Some("tool-calls"),
            Some("length"),
            Some("content-filter"),
            Some("error"),
            Some("unknown"),
            None,
        ] {
            // A fresh parser's first `step_finish` hands back the id it carries, nothing else.
            let mut parser = StreamParser::new(None);
            let [native, event] = parser.line(&step_finish("msg_r", reason));
            assert!(event.is_none(), "{reason:?}: {event:?}");
            assert!(
                matches!(&native, Some(ReviewEvent::NativeSession { id }) if id == SESSION),
                "{reason:?}: {native:?}"
            );
        }
    }

    #[test]
    fn a_run_ending_on_a_tool_calls_finish_succeeds_on_exit_zero() {
        // M22 (v2.2.0): no `stop` at all.
        let (a, b) = ("msg_t1", "msg_t2");
        let lines = [
            step_start(a),
            live(a, "Reading the file."),
            tool_use(a, "read", "completed", json!({"path": "src/main.rs"})),
            step_finish(a, Some("tool-calls")),
            step_start(b),
            live(b, "The file defines main."),
            step_finish(b, Some("tool-calls")),
        ];
        assert_eq!(
            done_text(outcome(&lines, Some(0))),
            "The file defines main."
        );
        assert_eq!(
            error_message(outcome(&lines, Some(1))),
            "opencode exited with code 1 before it finished."
        );
    }

    #[test]
    fn a_reconcile_tail_on_the_last_streamed_block_streams_unseparated() {
        let m = "msg_1f9f251d9001AdTr2YI5Jh7x6u";
        let lines = [
            step_start(m),
            live(m, "Here is the head"),
            projected(m, 0, " and the tail."),
        ];
        let mut parser = StreamParser::new(None);
        let events = feed(&mut parser, &lines);
        assert!(
            matches!(events.last(), Some(ReviewEvent::Delta { text }) if text == " and the tail."),
            "{events:?}"
        );
        let text = done_text(parser.finish(Some(0), None));
        assert_eq!(text, "Here is the head and the tail.");
        assert!(streamed(&events).ends_with(&text));
    }

    #[test]
    fn a_reconcile_tail_on_an_earlier_block_only_completes_it() {
        let m = "msg_e1";
        let mut parser = StreamParser::new(None);
        let events = feed(
            &mut parser,
            &[
                step_start(m),
                live(m, "First block head"),
                live(m, "Second block."),
            ],
        );
        assert!(matches!(
            parser.line(&projected(m, 0, ", first tail.")),
            [None, None]
        ));
        assert_eq!(streamed(&events), "First block head\n\nSecond block.");
        assert_eq!(
            done_text(parser.finish(Some(0), None)),
            "First block head, first tail.\n\nSecond block."
        );
    }

    #[test]
    fn a_reconciled_block_never_streamed_is_a_new_block() {
        let m = "msg_w1";
        let mut parser = StreamParser::new(None);
        let mut events = feed(&mut parser, &[step_start(m), live(m, "Live block.")]);
        events.extend(feed(&mut parser, &[projected(m, 1, "Missed block.")]));
        assert!(
            matches!(events.last(), Some(ReviewEvent::Delta { text }) if text == "\n\nMissed block."),
            "{events:?}"
        );
        assert_eq!(
            done_text(parser.finish(Some(0), None)),
            "Live block.\n\nMissed block."
        );
        // A gap past the list pads with empty blocks; Done skips them.
        let mut parser = StreamParser::new(None);
        feed(
            &mut parser,
            &[step_start(m), live(m, "A."), projected(m, 3, "D.")],
        );
        assert!(parser.line(&live(m, "E."))[1].is_some());
        assert_eq!(done_text(parser.finish(Some(0), None)), "A.\n\nD.\n\nE.");
        // An ordinal far past the list is read as a live block, never padded to.
        let mut parser = StreamParser::new(None);
        feed(&mut parser, &[step_start(m), live(m, "A.")]);
        let far = text_line(m, "prt_w1_text-4294967295000", "Far.");
        assert!(parser.line(&far)[1].is_some());
        let huge = format!("prt_w1_text-{}", PROJECTED_GAP_LIMIT + 3);
        assert!(parser.line(&text_line(m, &huge, "Huge."))[1].is_some());
        assert_eq!(parser.messages[0].blocks.len(), 3);
        assert_eq!(
            done_text(parser.finish(Some(0), None)),
            "A.\n\nFar.\n\nHuge."
        );
    }

    #[test]
    fn an_empty_text_event_still_counts_as_a_block() {
        let m = "msg_z1";
        let mut parser = StreamParser::new(None);
        assert!(feed(&mut parser, &[step_start(m)]).len() == 1);
        assert!(matches!(parser.line(&live(m, "")), [None, None]));
        let [_, event] = parser.line(&projected(m, 1, "Block one."));
        assert!(
            matches!(&event, Some(ReviewEvent::Delta { text }) if text == "Block one."),
            "{event:?}"
        );
        // A projected empty text adds nothing to a filled block.
        assert!(matches!(parser.line(&projected(m, 1, "")), [None, None]));
        assert_eq!(done_text(parser.finish(Some(0), None)), "Block one.");
        // The empty block keeps its ordinal, so the live text after it is block 1 and a
        // projected ordinal 1 is that block's tail.
        let mut parser = StreamParser::new(None);
        feed(&mut parser, &[step_start(m), live(m, ""), live(m, "One")]);
        let [_, event] = parser.line(&projected(m, 1, " and its tail."));
        assert!(
            matches!(&event, Some(ReviewEvent::Delta { text }) if text == " and its tail."),
            "{event:?}"
        );
        assert_eq!(done_text(parser.finish(Some(0), None)), "One and its tail.");
    }

    #[test]
    fn projected_ids_match_only_their_own_message() {
        assert_eq!(projected_ordinal("msg_abc", "prt_abc_text-0"), Some(0));
        assert_eq!(projected_ordinal("msg_abc", "prt_abc_text-12"), Some(12));
        assert_eq!(projected_ordinal("abc", "prt_abc_text-1"), Some(1));
        for id in [
            "prt_abd_text-0",
            "prt_abc_text-",
            "prt_abc_text-x",
            "prt_abc_text--1",
            "prt_abc_text-1a",
            "prt_abc_reasoning-0",
            "prt_msg_abc_text-0",
            "abc_text-0",
            "prt_1f9f2527a001live",
        ] {
            assert_eq!(projected_ordinal("msg_abc", id), None, "{id}");
        }
    }

    #[test]
    fn events_without_a_message_id_join_the_current_message() {
        // A text event with no `messageID` (or no `part`) joins the final message; a
        // `step_start` without one starts a fresh message, so Done never carries an
        // earlier step.
        let no_message = |text: &str| json!({"type": "text", "part": {"text": text}}).to_string();
        let lines = [
            json!({"type": "step_start", "sessionID": SESSION}).to_string(),
            no_message("Step one."),
            json!({"type": "step_start"}).to_string(),
            no_message("Step two."),
            no_message("More of two."),
            json!({"type": "text"}).to_string(),
        ];
        let mut parser = StreamParser::new(None);
        let events = feed(&mut parser, &lines);
        assert!(matches!(&events[0], ReviewEvent::NativeSession { id } if id == SESSION));
        assert_eq!(streamed(&events), "Step one.\n\nStep two.\n\nMore of two.");
        assert_eq!(
            done_text(parser.finish(Some(0), None)),
            "Step two.\n\nMore of two."
        );
        // Text before any step lands in one anonymous message.
        let lines = [no_message("Alone."), no_message("Still alone.")];
        assert_eq!(
            done_text(outcome(&lines, Some(0))),
            "Alone.\n\nStill alone."
        );
        // A run whose final step holds no text falls back to everything streamed.
        let lines = [
            step_start("msg_s1"),
            live("msg_s1", "Only narration."),
            step_start("msg_s2"),
            step_finish("msg_s2", Some("stop")),
        ];
        assert_eq!(done_text(outcome(&lines, Some(0))), "Only narration.");
        // No text at all: an empty answer.
        assert_eq!(done_text(outcome(&[step_start("msg_e")], Some(0))), "");
    }

    #[test]
    fn tool_steps_map_to_timeline_categories() {
        let m = "msg_tool";
        // A fresh parser's first tool line also hands back its top-level id, when it has one.
        let tool = |line: String| {
            let mut parser = StreamParser::new(None);
            let [native, event] = parser.line(&line);
            let top_level = serde_json::from_str::<Value>(&line).expect("JSON")["sessionID"]
                .as_str()
                .is_some();
            assert_eq!(native.is_some(), top_level, "{line}: {native:?}");
            match event {
                Some(ReviewEvent::Tool { tool, target }) => (tool, target),
                other => panic!("expected Tool, got {other:?}"),
            }
        };
        let empty = json!({});
        assert_eq!(
            tool(tool_use(m, "shell", "completed", json!({"command": "ls"}))).0,
            "run"
        );
        assert_eq!(
            tool(tool_use(m, "subagent", "completed", empty.clone())).0,
            "task"
        );
        assert_eq!(
            tool(tool_use(
                m,
                "gitdesktop_get_pull_request",
                "completed",
                empty.clone()
            )),
            ("other".to_string(), None)
        );
        assert_eq!(
            tool(tool_use(
                m,
                "read",
                "completed",
                json!({"path": "/work/repo/README.md"})
            )),
            ("read".to_string(), Some("/work/repo/README.md".to_string()))
        );
        // `probe:probe6-enforce.txt:30`: a call that failed is still a step.
        assert_eq!(
            tool(tool_use(
                m,
                "read",
                "error",
                json!({"path": "/work/repo/secret/a.txt"})
            )),
            (
                "read".to_string(),
                Some("/work/repo/secret/a.txt".to_string())
            )
        );
        assert_eq!(
            tool(json!({"type": "tool_use", "part": {}}).to_string()),
            ("other".to_string(), None)
        );
        assert_eq!(
            tool(json!({"type": "tool_use"}).to_string()),
            ("other".to_string(), None)
        );
    }

    #[test]
    fn retries_and_other_events_return_nothing() {
        let mut parser = StreamParser::new(None);
        assert_eq!(parser.last_retry(), None);
        let storm: Vec<String> = (2..=6).map(retry_line).collect();
        assert!(feed(&mut parser, &storm).is_empty());
        assert_eq!(
            parser.last_retry(),
            Some("Can't reach opencode.ai. Check the network connection. (attempt 6)")
        );
        // A retry without a readable message keeps the last one.
        assert!(matches!(
            parser.line(&json!({"type": "retry", "error": {"type": "x"}}).to_string()),
            [None, None]
        ));
        assert_eq!(
            parser.last_retry(),
            Some("Can't reach opencode.ai. Check the network connection. (attempt 6)")
        );
        let others = [
            background_wait(),
            json!({"type": "reasoning", "part": {"messageID": "msg_q", "text": "hmm"}}).to_string(),
            json!({"type": "something_new"}).to_string(),
        ];
        assert!(feed(&mut parser, &others).is_empty());
        // A retry storm that ends without a terminal line fails on the exit code.
        assert_eq!(
            error_message(parser.finish(Some(1), None)),
            "opencode exited with code 1 before it finished."
        );
    }

    #[test]
    fn progress_after_a_retry_clears_it() {
        let m = "msg_r1";
        let progress = [
            step_start(m),
            live(m, "Back."),
            tool_use(m, "read", "completed", json!({"path": "a"})),
            step_finish(m, Some("tool-calls")),
            background_wait(),
        ];
        for line in progress {
            let mut parser = StreamParser::new(None);
            feed(&mut parser, &[retry_line(2), line.clone()]);
            assert_eq!(parser.last_retry(), None, "{line}");
        }
        // A retry that is the last line still names itself.
        let mut parser = StreamParser::new(None);
        feed(&mut parser, &[step_start(m), live(m, "A."), retry_line(3)]);
        assert_eq!(
            parser.last_retry(),
            Some("Can't reach opencode.ai. Check the network connection. (attempt 3)")
        );
        // An error line or an unknown event is no progress.
        feed(
            &mut parser,
            &[
                error_line("boom"),
                json!({"type": "something_new"}).to_string(),
            ],
        );
        assert!(parser.last_retry().is_some());
    }

    #[test]
    fn projected_lines_never_grow_a_message_past_its_cap() {
        let m = "msg_cap";
        let mut parser = StreamParser::new(None);
        feed(&mut parser, &[step_start(m)]);
        for _ in 0..(2 * MESSAGE_BLOCK_CAP / PROJECTED_GAP_LIMIT) {
            let ordinal = parser.messages[0].blocks.len() + PROJECTED_GAP_LIMIT;
            parser.line(&projected(m, ordinal, "x"));
            assert!(
                parser.messages[0].blocks.len() <= MESSAGE_BLOCK_CAP,
                "{}",
                parser.messages[0].blocks.len()
            );
        }
        // A block already in the list is still completed in place.
        let len = parser.messages[0].blocks.len();
        parser.line(&projected(m, 0, "first"));
        assert_eq!(parser.messages[0].blocks.len(), len);
        assert_eq!(parser.messages[0].blocks[0], "first");

        // The boundary: a message one block short of the cap.
        let filled = || {
            let mut parser = StreamParser::new(None);
            feed(&mut parser, &[step_start(m)]);
            let mut ordinals = Vec::new();
            for _ in 0..4 {
                let ordinal = (parser.messages[0].blocks.len() + PROJECTED_GAP_LIMIT)
                    .min(MESSAGE_BLOCK_CAP - 2);
                parser.line(&projected(m, ordinal, "x"));
                ordinals.push(ordinal);
            }
            assert_eq!(ordinals, [1024, 2049, 3074, 4094]);
            assert_eq!(parser.messages[0].blocks.len(), MESSAGE_BLOCK_CAP - 1);
            parser
        };
        for (ordinal, text) in [(4095, "edge"), (4096, "over")] {
            // 4095 is the last ordinal a projection pads to; 4096 reads as live, which
            // lands on the same block.
            let mut parser = filled();
            parser.line(&projected(m, ordinal, text));
            assert_eq!(parser.messages[0].blocks.len(), MESSAGE_BLOCK_CAP, "{text}");
            assert_eq!(parser.messages[0].blocks[4095], text);
            // Past the cap each line, projected or live, adds exactly one block.
            parser.line(&projected(m, 5000, "far"));
            assert_eq!(parser.messages[0].blocks.len(), 4097, "{text}");
            parser.line(&live(m, "live"));
            assert_eq!(parser.messages[0].blocks.len(), 4098, "{text}");
        }
    }

    #[test]
    fn a_text_for_an_unseen_message_opens_it_as_the_final_one() {
        // The reviewer's sequence: B's only line is opencode 2.2.0's reconcile.
        let (a, b) = ("msg_a1", "msg_b1");
        let mut parser = StreamParser::new(None);
        let events = feed(
            &mut parser,
            &[
                step_start(a),
                live(a, "Reading files"),
                projected(b, 0, "Final answer"),
            ],
        );
        assert!(
            matches!(&events[..], [
                ReviewEvent::NativeSession { id },
                ReviewEvent::Delta { text: first },
                ReviewEvent::Delta { text: second },
            ] if id == SESSION && first == "Reading files" && second == "\n\nFinal answer"),
            "{events:?}"
        );
        assert_eq!(done_text(parser.finish(Some(0), None)), "Final answer");
    }

    #[test]
    fn a_reconcile_only_turn_stores_one_id_and_its_final_text() {
        let (a, b) = ("msg_a1", "msg_b1");
        let mut parser = StreamParser::new(None);
        let events = feed(&mut parser, &[projected(b, 0, "Answer.")]);
        assert!(
            matches!(&events[..], [ReviewEvent::NativeSession { id }, ReviewEvent::Delta { text }]
                if id == SESSION && text == "Answer."),
            "{events:?}"
        );
        assert_eq!(done_text(parser.finish(Some(0), None)), "Answer.");
        // A tool-only first message, then the final one; the id comes from the tool line.
        let mut parser = StreamParser::new(None);
        let lines = [
            tool_use(a, "read", "completed", json!({"path": "a"})),
            projected(a, 0, "Narration."),
            projected(b, 0, "Final."),
        ];
        let [native, _] = parser.line(&lines[0]);
        assert!(matches!(native, Some(ReviewEvent::NativeSession { .. })));
        let events = feed(&mut parser, &lines[1..]);
        assert_eq!(natives(&events), 0);
        assert_eq!(done_text(parser.finish(Some(0), None)), "Final.");
    }

    #[test]
    fn a_tool_use_for_an_unseen_message_opens_it_as_the_final_one() {
        let (a, b, c) = ("msg_a1", "msg_b1", "msg_c1");
        let tool = |message: &str| tool_use(message, "read", "completed", json!({"path": "a"}));
        let mut parser = StreamParser::new(None);
        feed(
            &mut parser,
            &[
                step_start(a),
                live(a, "First."),
                step_start(c),
                live(c, "Second."),
                tool(b),
            ],
        );
        let final_id = |parser: &StreamParser| {
            parser.messages[parser.final_message.expect("a final message")]
                .id
                .clone()
        };
        assert_eq!(final_id(&parser).as_deref(), Some(b));
        // A known message never moves the final one.
        feed(&mut parser, &[tool(a)]);
        assert_eq!(final_id(&parser).as_deref(), Some(b));
        // A fresh parser's first tool line yields the id, then the tool.
        let mut parser = StreamParser::new(None);
        let slots = parser.line(&tool(b));
        assert!(
            matches!(&slots, [
                Some(ReviewEvent::NativeSession { id }),
                Some(ReviewEvent::Tool { .. }),
            ] if id == SESSION),
            "{slots:?}"
        );
    }

    #[test]
    fn a_turn_failing_before_any_step_yields_no_event() {
        let mut parser = StreamParser::new(None);
        let lines = [
            retry_line(2),
            background_wait(),
            error_line("Model not found"),
        ];
        let events = feed(&mut parser, &lines);
        assert!(events.is_empty(), "{events:?}");
        assert_eq!(
            error_message(parser.finish(Some(1), None)),
            "Model not found"
        );
    }

    #[test]
    fn every_step_start_and_only_a_first_other_line_hand_back_the_id() {
        let (a, b, c) = ("msg_a1", "msg_b1", "msg_c1");
        let count = |lines: &[String]| natives(&feed(&mut StreamParser::new(None), lines));
        assert_eq!(count(&[step_start(a), step_start(b)]), 2, "one per step");
        assert_eq!(
            count(&[
                step_start(a),
                live(a, "x"),
                tool_use(a, "read", "completed", json!({"path": "a"})),
                step_finish(a, Some("stop")),
            ]),
            1,
            "a step_start's id stops the other lines"
        );
        assert_eq!(count(&[projected(b, 0, "x"), live(b, "y")]), 1);
        assert_eq!(count(&[projected(b, 0, "x"), step_start(c)]), 2);
        // A step_start without an id leaves the first text line to send it.
        let bare_step = json!({"type": "step_start", "part": {"messageID": a}}).to_string();
        let mut parser = StreamParser::new(None);
        let [native, _] = parser.line(&bare_step);
        assert!(native.is_none());
        let events = feed(&mut parser, &[live(a, "x"), live(a, "y")]);
        assert!(
            matches!(&events[0], ReviewEvent::NativeSession { .. }),
            "{events:?}"
        );
        assert_eq!(natives(&events), 1);
    }

    #[test]
    fn only_a_top_level_string_session_id_is_handed_back() {
        let part = json!({"id": "prt_x", "sessionID": SESSION, "messageID": "msg_f1",
            "type": "text", "text": "t"});
        for line in [
            json!({"type": "text", "part": part}),
            json!({"type": "text", "sessionID": 7, "part": part}),
        ] {
            let mut parser = StreamParser::new(None);
            let [native, event] = parser.line(&line.to_string());
            assert!(native.is_none(), "{line}: {native:?}");
            assert!(event.is_some(), "{line}");
        }
    }

    #[test]
    fn a_known_message_never_moves_the_final_one() {
        let (a, b) = ("msg_a1", "msg_b1");
        let lines = [
            step_start(a),
            step_start(b),
            live(b, "B."),
            projected(a, 0, "late A."),
        ];
        assert_eq!(done_text(outcome(&lines, Some(0))), "B.");
    }

    #[test]
    fn a_text_less_final_message_falls_back_to_the_stored_blocks() {
        let (a, b) = ("msg_a1", "msg_b1");
        let mut parser = StreamParser::new(None);
        let events = feed(
            &mut parser,
            &[
                step_start(a),
                live(a, "a1"),
                live(a, "a2"),
                step_start(b),
                step_finish(b, Some("stop")),
            ],
        );
        assert!(matches!(parser.line(&projected(a, 0, "T")), [None, None]));
        assert_eq!(streamed(&events), "a1\n\na2");
        assert_eq!(done_text(parser.finish(Some(0), None)), "a1T\n\na2");
    }

    #[test]
    fn the_recorded_error_is_readable_before_finish() {
        let mut parser = StreamParser::new(None);
        feed(&mut parser, &[step_start("msg_e1")]);
        assert_eq!(parser.last_error(), None);
        feed(
            &mut parser,
            &[error_line("Model not found"), error_line("later")],
        );
        assert_eq!(parser.last_error().as_deref(), Some("Model not found"));
        let lock = lock_with(Pin::DiffOnly, &[], &Mirror::empty());
        let mut locked = StreamParser::new(Some(&lock));
        feed(
            &mut locked,
            &[error_line(&format!(
                "Agent not found: \"{}\"",
                lock.agent().as_str()
            ))],
        );
        assert_eq!(locked.last_error().as_deref(), Some(LOCK_DROPPED));
    }

    #[test]
    fn a_failed_exit_without_an_error_line_quotes_stderr() {
        let m = "msg_x1";
        let lines = [step_start(m), live(m, "Partial.")];
        let finish = |lines: &[String], code: Option<i32>, stderr: Option<&str>| {
            let mut parser = StreamParser::new(None);
            feed(&mut parser, lines);
            parser.finish(code, stderr)
        };
        assert_eq!(
            error_message(finish(&lines, Some(1), Some("panic: out of memory"))),
            "opencode exited with code 1 before it finished. opencode printed: panic: out of memory"
        );
        assert_eq!(
            error_message(finish(&lines, None, Some("killed"))),
            "opencode stopped before it finished. opencode printed: killed"
        );
        let with_reason = [step_start(m), step_finish(m, Some("length"))];
        assert_eq!(
            error_message(finish(&with_reason, Some(2), Some("bye"))),
            "opencode exited with code 2 before it finished. The reply hit the model's output limit. opencode printed: bye"
        );
        // A recorded error line is the whole message; stderr never joins it.
        let errored = [step_start(m), error_line("Model not found")];
        assert_eq!(
            error_message(finish(&errored, Some(1), Some("stack trace"))),
            "Model not found"
        );
        // A clean exit never reads stderr.
        assert_eq!(
            done_text(finish(&lines, Some(0), Some("warning"))),
            "Partial."
        );
    }

    // ---- catalog and variants ----

    /// Shaped as the measured catalog (`probe:probe8.txt:22-30`), plus odd entries.
    fn catalog_entries() -> Value {
        let variants = |ids: &[&str]| -> Value {
            ids.iter()
                .map(|id| json!({"id": id, "settings": {"reasoningEffort": id}}))
                .collect()
        };
        json!([
            {"id": "big-pickle", "providerID": "opencode", "name": "Big Pickle", "variants": []},
            {"id": "deepseek-v4.1-flash-free", "providerID": "opencode", "variants": variants(&["low", "high", "max"])},
            {"id": "tidepool-alpha-free", "providerID": "opencode", "variants": variants(&["minimal", "low", "medium", "high", "xhigh", "max"])},
            {"id": "hy4-flash-free", "providerID": "opencode", "variants": variants(&["none", "high"])},
            {"id": "anthropic/claude-x", "providerID": "openrouter", "variants": variants(&["high"])},
            {"id": "no-variants", "providerID": "local"},
            {"id": "odd", "providerID": "local", "variants": [
                {"id": "a#b"}, {"id": ""}, {"id": "two words"}, {"id": "tab\tbed"}, {"id": 7}, "low", {"id": "ok"}
            ]},
            {"id": "big-pickle", "providerID": "opencode", "variants": variants(&["max"])},
            {"providerID": "opencode", "variants": variants(&["low"])},
            "not an entry",
        ])
    }

    #[test]
    fn catalog_reads_declared_variants() {
        let wrapped = json!({"location": {"directory": "/work"}, "data": catalog_entries()});
        for text in [wrapped.to_string(), catalog_entries().to_string()] {
            let catalog = parse_model_catalog(&format!("\n{text}\n")).expect("catalog");
            assert!(
                catalog.variants("opencode/big-pickle").is_empty(),
                "first entry wins"
            );
            assert_eq!(
                catalog.variants("opencode/deepseek-v4.1-flash-free"),
                ["low", "high", "max"]
            );
            assert_eq!(catalog.variants("openrouter/anthropic/claude-x"), ["high"]);
            assert!(catalog.variants("local/no-variants").is_empty());
            assert_eq!(catalog.variants("local/odd"), ["ok"]);
            assert!(catalog.variants("deepseek-v4.1-flash-free").is_empty());
            assert!(catalog.variants("nosuch/model").is_empty());
        }
        for text in ["", "not json", r#"{"data":{}}"#, r#"{"location":{}}"#, "42"] {
            assert_eq!(
                parse_model_catalog(text),
                Err(CatalogError::NotJson),
                "{text}"
            );
        }
        assert_eq!(
            parse_model_catalog("[]"),
            Ok(ModelCatalog::default()),
            "an empty list is a catalog with no models"
        );
    }

    #[test]
    fn variant_pick_follows_the_fallback_lists() {
        let set = |ids: &[&str]| ids.iter().map(|id| id.to_string()).collect::<Vec<_>>();
        let sets = [
            set(&["low", "high", "max"]),
            set(&["minimal", "low", "medium", "high", "xhigh", "max"]),
            set(&["none", "high"]),
            set(&[]),
        ];
        // Rows: level, then the pick over each measured set in order and `[]`.
        let table: [(&str, [Option<&str>; 4]); 6] = [
            ("low", [Some("low"), Some("low"), None, None]),
            ("medium", [None, Some("medium"), None, None]),
            ("high", [Some("high"), Some("high"), Some("high"), None]),
            ("xhigh", [Some("max"), Some("xhigh"), Some("high"), None]),
            ("", [None, None, None, None]),
            ("bogus", [None, None, None, None]),
        ];
        for level in EFFORT_LEVELS {
            assert!(
                table.iter().any(|(row, _)| *row == level),
                "{level} has a row"
            );
        }
        for (level, picks) in table {
            for (declared, expected) in sets.iter().zip(picks) {
                let picked = pick_variant(level, declared);
                assert_eq!(picked, expected, "{level} over {declared:?}");
                if let Some(picked) = picked {
                    assert!(declared.iter().any(|d| d == picked));
                }
            }
        }
        assert_eq!(pick_variant("low", &set(&["minimal"])), Some("minimal"));
        assert_eq!(pick_variant("xhigh", &set(&["high", "max"])), Some("max"));
        assert_eq!(
            pick_variant("high", &set(&["none"])),
            None,
            "none is never picked"
        );
    }
}
