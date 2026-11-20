#!/usr/bin/env node
// A drift guard for ordinary workflow YAML, not a YAML or shell parser: every
// job that runs steps carries a literal job-level timeout-minutes, and a job
// that runs Node first sets it up from .node-version (an unbounded job hangs
// for GitHub's 6-hour default; the image's Node drifts from .node-version). A
// node step that may run without setup-node succeeding (after a setup under
// continue-on-error, or under an `if:` calling a status function with no bare
// top-level success() conjunct, which in a string template rather than a
// whole `${{ }}` expression is any call) must be continue-on-error itself or
// have a top-level `&&` conjunct `steps.<setup id>.outcome == 'success'`; a
// template never meets that conjunct. A setup run with `background:` is
// unreadable. Stdlib only: the guards job runs it before any install.
//
// Reading fails closed. parseWorkflow reads one document of block mappings
// and sequences holding plain, quoted, block and balanced flow scalars
// (block scalars keep YAML's chomping, so a clipped or kept `|` ends in a
// line break, even on a file's unterminated last line as yaml reads it, and
// a `${{ }}` condition there is a template); any other shape
// (multi-document files, anchors and aliases among them) is `unreadable`,
// as is a carriage return outside a CRLF line ending (YAML breaks a line
// there), and a flow value whose quotes or brackets it can't pair (an
// apostrophe in a plain scalar inside one: use a block mapping). The remedy
// is to spell it plainly, as for a local action spelled with backslashes
// (`.\...`): spell it `./...`. An `if:` holding a quoted `}}` reads as a
// template and is flagged: spell the condition without one. A node run is a
// node-family word or a word ending in .js, .mjs or .cjs anywhere in a run's
// text (comments included; each `${{ }}` reads as a blank), or a node shell.
// False positives by design: any mention counts, as an argument
// (`cp dist/app.js out/`, `command -v node`), in a comment
// (`# npm ci runs later`), a string (`echo see node docs`, `"node: $NODE"`)
// or a glob (`git diff -- '*.js'`), as an array element or a here-document
// line, and as `$env:NODE`, `file.node`, `App.tsx` or a path component
// (`C:\tools\node\bin`), as does a STATUS_CALL word in a string literal
// (`contains(x, 'failure()')`); set up Node before the step, or reword it.
// Out of reach: a command supplied by an expression (`${{ matrix.cmd }}`),
// wherever it appears; a command word the shell assembles from other text:
// an escape, quotes, a glob or brace expansion inside it (`n\ode`,
// `no""de`, `nod[e]`, `n{o,}de`), or one glued to an option
// (`env -Snode`, `cmd /cnode`); a command behind a variable (`$NODE`),
// alias, function, sourced script or third-party action; a script with no
// Node extension (a shebang `./tool`); a runtime version switch after
// setup-node; a checkout of another repository or path that supplies the
// `.node-version` setup-node reads (this guard reads the repository's own
// file and takes any checkout as its source); a same-repository action
// spelled `$/...` (it reads as a third-party action); a checkout run with
// `background:`; and a reusable-workflow caller job, which skips both rules
// as GitHub refuses timeout-minutes there (its callee is checked on its own).
// Sync steps (`wait`, `wait-all`, `cancel`) and `parallel` blocks are
// unreadable: they carry neither uses nor run. Not checked: setup-node's own
// version (any ref counts, as Dependabot moves it; an `@v1` predating
// node-version-file is out of reach). The 1..360 range
// follows hosted runners, so a self-hosted job's longer bound is refused.
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// Site (`<file>#<job>` or a composite's path) -> why its Node may come from a
// container or the caller. Waives only composite-node and container-node, and
// goes stale once its site no longer fails one of them.
export const EXEMPT = new Map();

const WAIVABLE = new Set(["composite-node", "container-node"]);
const LITERAL = new Set(["plain", "single", "double"]);
// Scalar styles whose text an `if:` condition is read from.
const CONDITION_STYLES = new Set([...LITERAL, "folded", "literal"]);
const WORKFLOW_PATH = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const ACTION_PATH = /^\.github\/actions\/[^/]+\/action\.ya?ml$/;
const TIMEOUT_FIX =
  "add a job-level `timeout-minutes: <minutes>` beside runs-on, bounded from measured durations";
const SUBSET_FIX =
  "keep the file readable UTF-8 inside the YAML subset this guard reads (see its header)";
const setupFix = (step) =>
  `add \`uses: actions/setup-node@<ref>\` with \`node-version-file: .node-version\` after checkout and before step ${step}`;
const GATE_FIX =
  "gate it with `if: steps.<setup-node id>.outcome == 'success'`, or make it non-gating with `continue-on-error: true`";

// A node-family word counts anywhere it stands alone, so the guard errs only
// toward a false red. A `$`/`${` reference is excluded: a variable is never
// the command itself (a command behind one is out of reach).
const NODE_COMMAND =
  /(?<![\w$-])(?<!\$\{)(?:(?:node|nodejs|npm|npx|pnpm|pnpx|corepack|yarn|tsx|ts-node|vite-node|babel-node)(?:\.(?:exe|cmd|ps1|bat))?(?![\w.-])|node_modules[\\/]\.bin[\\/])/i;
// A call of a GitHub status function in an `if:` expression.
const STATUS_CALL = /\b(?:success|failure|always|cancelled)\s*\(/i;
// Any word ending in a Node script extension counts wherever it appears, so
// the guard errs only toward a false red (no command-position grammar).
const SCRIPT_WORD = /[.](?:mjs|cjs|js)(?![A-Za-z0-9])/i;

// Run text is scanned whole, comments included. Each `${{ ... }}` reads as a
// blank, so a literal command word beside one stands alone. This guard ends
// one at its first `}}` (the runner skips one inside a '...' string) and
// leaves an unclosed one as is. A loop, as a regex retried at every unclosed
// `${{` re-scans the rest.
function plainExpressions(text) {
  let out = "";
  let from = 0;
  for (;;) {
    const open = text.indexOf("${{", from);
    const close = open < 0 ? -1 : text.indexOf("}}", open + 3);
    if (close < 0) return out + text.slice(from);
    out += `${text.slice(from, open)} `;
    from = close + 2;
  }
}

export function runsNode(text) {
  const script = plainExpressions(text);
  return NODE_COMMAND.test(script) || SCRIPT_WORD.test(script);
}

class Unreadable extends Error {
  constructor(line, message, fix) {
    super(message);
    this.line = line;
    this.fix = fix;
  }
}

const codeName = (code) =>
  `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;

// C0 controls but TAB and LF, DEL, C1 controls, the Unicode line and paragraph
// separators, and a byte-order mark past the first character: a YAML reader
// may break lines where this one doesn't, so none of them is read.
function hostile(code) {
  return (
    (code < 0x20 && code !== 0x09 && code !== 0x0a) ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0xfeff
  );
}

// A CR outside a CRLF pair is a line break to YAML but not to this reader, and
// normalizing CRLF first could pair it with the LF after it, so it is refused
// before then; readCorpus leaves such a text unnormalized for this check.
const LONE_CR = /\r(?!\n)/;

function sourceLines(source) {
  const lone = source.search(LONE_CR);
  if (lone >= 0) {
    throw new Unreadable(
      source.slice(0, lone).split("\n").length,
      "a carriage return outside a CRLF line ending is not read",
    );
  }
  const text = (
    source.charCodeAt(0) === 0xfeff ? source.slice(1) : source
  ).replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    for (let i = 0; i < line.length; i++) {
      const code = line.charCodeAt(i);
      if (hostile(code)) {
        throw new Unreadable(
          index + 1,
          `character ${codeName(code)} (a control, line-separator or byte-order character) is not read`,
        );
      }
    }
  }
  return lines;
}

const BLANK = /^[ \t]*$/;
// YAML's white space is space and TAB: trim() would also drop a U+00A0 or
// other Unicode space that YAML keeps as content. The lookbehind starts the
// end trim at a blank run's first blank, so each run is tried once.
const trimEndBlanks = (text) => text.replace(/(?<![ \t])[ \t]+$/, "");
const COMMENT = /^[ \t]*#/;
const MARKER = /^(?:---|\.\.\.)(?:[ \t]+#.*|[ \t]*)$/;
// Blanks before `:` belong to a quoted key's alternative only: a plain key's
// lazy text already takes them (trimmed later), and two quantifiers sharing
// one blank run make the match quadratic.
const PAIR =
  /^(?:"((?:[^"\\]|\\.)*)"[ \t]*|'((?:[^']|'')*)'[ \t]*|((?:[^\s#'"{}[\],&*!|>%@`?:-]|[?:-][^\s#])[^#]*?)):(?:[ \t]+(.*))?$/;
const QUOTED_TAIL = /^(?:[ \t]+#.*|[ \t]*)$/;
const ESCAPES = {
  0: "\0",
  a: "\x07",
  b: "\b",
  t: "\t",
  "\t": "\t",
  n: "\n",
  v: "\v",
  f: "\f",
  r: "\r",
  e: "\x1b",
  " ": " ",
  '"': '"',
  "/": "/",
  "\\": "\\",
};
const HEX_ESCAPES = { x: 2, u: 4, U: 8 };

// Parses the subset named in the header into { kind: "map", entries, keyLines },
// { kind: "seq", items, lines } and { kind: "scalar", value, style } nodes, each
// with the 1-based `line` it starts on; throws on anything outside the subset.
export function parseWorkflow(source, file) {
  if (typeof source !== "string") {
    throw new Unreadable(1, `${file} is not text`);
  }
  const lines = sourceLines(source).map((text, i) => ({
    i,
    n: i + 1,
    text,
    indent: -1,
    body: "",
  }));
  const count = lines.length;
  let pos = 0;
  const fail = (line, message) => {
    throw new Unreadable(line, message);
  };
  const spaces = (text) => text.match(/^ */)[0].length;
  const measure = (line) => {
    if (line.indent < 0) {
      const indent = spaces(line.text);
      if (line.text[indent] === "\t") fail(line.n, "TAB in indentation");
      line.indent = indent;
      line.body = line.text.slice(indent);
    }
    return line.indent;
  };
  const skip = () => {
    while (
      pos < count &&
      (BLANK.test(lines[pos].text) || COMMENT.test(lines[pos].text))
    ) {
      pos++;
    }
  };
  const isDash = (body) =>
    body === "-" || body.startsWith("- ") || body.startsWith("-\t");
  const isMarker = (line) => line.indent === 0 && MARKER.test(line.body);

  function block(indent, parent) {
    const line = lines[pos];
    if (isDash(line.body)) return sequence(indent);
    if (PAIR.test(line.body)) return mapping(indent);
    return scalar(line, line.body, parent);
  }

  function sequence(indent) {
    const node = { kind: "seq", items: [], lines: [], line: lines[pos].n };
    for (;;) {
      skip();
      if (pos >= count) break;
      const line = lines[pos];
      const at = measure(line);
      if (at < indent || isMarker(line)) break;
      if (at > indent) fail(line.n, "unexpected indentation");
      if (!isDash(line.body)) break;
      const after = line.body.slice(1);
      const gap = spaces(after);
      if (after[gap] === "\t") fail(line.n, "TAB after a sequence dash");
      const rest = after.slice(gap);
      node.lines.push(line.n);
      if (rest === "" || rest.startsWith("#")) {
        pos++;
        skip();
        if (pos >= count || measure(lines[pos]) <= indent) {
          fail(line.n, "empty sequence item");
        }
        node.items.push(block(lines[pos].indent, indent));
      } else {
        // The item's content keeps its real column, so `-   name:` nests right.
        line.indent = indent + 1 + gap;
        line.body = rest;
        node.items.push(block(line.indent, indent));
      }
    }
    return node;
  }

  function mapping(indent) {
    const node = {
      kind: "map",
      entries: new Map(),
      keyLines: new Map(),
      line: lines[pos].n,
    };
    for (;;) {
      skip();
      if (pos >= count) break;
      const line = lines[pos];
      const at = measure(line);
      if (at < indent || isMarker(line)) break;
      if (at > indent) fail(line.n, "unexpected indentation");
      if (isDash(line.body)) {
        fail(line.n, "sequence item where a mapping key belongs");
      }
      if (/^[&*!]/.test(line.body)) {
        fail(line.n, "anchors, aliases and tags are not read");
      }
      const pair = line.body.match(PAIR);
      if (!pair) fail(line.n, "expected a mapping key");
      if (pair[1]?.includes("\\")) fail(line.n, "escaped keys are not read");
      const key =
        pair[1] ?? pair[2]?.replace(/''/g, "'") ?? trimEndBlanks(pair[3]);
      if (key === "<<") fail(line.n, "merge keys are not read");
      if (node.entries.has(key)) fail(line.n, `duplicate key ${key}`);
      const rest = pair[4] ?? "";
      let value;
      if (rest === "" || rest.startsWith("#")) {
        pos++;
        skip();
        const next = pos < count ? lines[pos] : null;
        const nextAt = next ? measure(next) : -1;
        if (next && nextAt > indent) value = block(nextAt, indent);
        else if (next && nextAt === indent && isDash(next.body)) {
          value = sequence(indent);
        } else
          value = { kind: "scalar", value: "", style: "empty", line: line.n };
      } else value = scalar(line, rest, indent);
      node.entries.set(key, value);
      node.keyLines.set(key, line.n);
    }
    return node;
  }

  function scalar(line, rest, parent) {
    const head = rest[0];
    if (head === "|" || head === ">") return blockScalar(line, rest, parent);
    if (head === '"' || head === "'") return quoted(line, rest, parent);
    if ("&*!".includes(head)) {
      fail(line.n, "anchors, aliases and tags are not read");
    }
    if ("%@`".includes(head)) {
      fail(line.n, `a value starting with ${head} is reserved YAML`);
    }
    if ("-?:".includes(head) && (rest.length === 1 || /[ \t]/.test(rest[1]))) {
      fail(line.n, `unsupported ${head} indicator in a value`);
    }
    return plain(line, rest, parent);
  }

  // In an unquoted scalar a space or TAB before `#` starts a comment, quotes or not.
  const cut = (text) => {
    const hash = text.search(/[ \t]#/);
    return hash < 0
      ? { text: trimEndBlanks(text), comment: false }
      : { text: trimEndBlanks(text.slice(0, hash)), comment: true };
  };

  // In a flow value a ` #` inside quotes is text, and a comment ends only its
  // line; the open quote and bracket depth a line ends in carry to the next,
  // under the same quote rules as balanced().
  const cutFlow = (text, open, depth) => {
    let quote = open;
    let level = depth;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (quote === "'") {
        if (char === "'" && text[i + 1] === "'") i++;
        else if (char === "'") quote = "";
      } else if (quote === '"') {
        if (char === "\\") i++;
        else if (char === '"') quote = "";
      } else if (char === "'" || char === '"') quote = char;
      else if (char === "{" || char === "[") level++;
      else if (char === "}" || char === "]") level--;
      else if (char === "#" && /[ \t]/.test(text[i - 1] ?? "")) {
        return { text: trimEndBlanks(text.slice(0, i)), quote, depth: level };
      }
    }
    return { text: trimEndBlanks(text), quote, depth: level };
  };

  // A flow value stays opaque only once its brackets, counted outside quotes,
  // close in order and nothing follows the outermost one; YAML would otherwise
  // read on into the next keys, or fail. A token opening with `&`, `*` or `!`
  // (after `{`, `[`, `,` or a `: `) is an anchor, alias or tag, refused as the
  // block forms are: an alias could stand for a node command.
  function balanced(value, n) {
    const open = [];
    let quote = "";
    let token = true;
    for (let i = 0; i < value.length; i++) {
      const char = value[i];
      if (quote === "'") {
        if (char === "'" && value[i + 1] === "'") i++;
        else if (char === "'") quote = "";
      } else if (quote === '"') {
        if (char === "\\") i++;
        else if (char === '"') quote = "";
      } else if (!open.length) {
        if (i > 0 && !/[ \t\n]/.test(char)) {
          fail(n, "content after a flow collection");
        }
        if (i === 0) open.push(char === "{" ? "}" : "]");
      } else if (/[ \t\n]/.test(char)) continue;
      else if (token && "&*!".includes(char)) {
        fail(n, "anchors, aliases and tags are not read");
      } else if (char === "'" || char === '"') quote = char;
      else if (char === "{") open.push("}");
      else if (char === "[") open.push("]");
      else if (char === "}" || char === "]") {
        if (open.pop() !== char) fail(n, "mismatched brackets in a flow value");
      }
      token =
        char === "{" ||
        char === "[" ||
        char === "," ||
        (char === ":" && /^(?:[ \t\n]|$)/.test(value[i + 1] ?? ""));
    }
    if (quote || open.length) fail(n, "unterminated flow collection");
  }

  function plain(line, rest, parent) {
    const flow = rest[0] === "{" || rest[0] === "[";
    let at = line;
    let piece = flow ? cutFlow(rest, "", 0) : cut(rest);
    let value = "";
    let separator = "";
    for (;;) {
      if (!flow && /:(?:[ \t]|$)/.test(piece.text)) {
        fail(at.n, "`: ` inside a plain value (YAML reads a mapping there)");
      }
      value += separator + piece.text;
      pos = at.i + 1;
      // A flow value runs until its brackets close; a plain one, to a comment.
      if (flow ? piece.depth <= 0 && !piece.quote : piece.comment) break;
      // Comment lines sit inside an open flow collection, never inside a quote.
      const comments = flow && !piece.quote;
      let next = pos;
      while (
        next < count &&
        (BLANK.test(lines[next].text) ||
          (comments && COMMENT.test(lines[next].text)))
      ) {
        next++;
      }
      if (
        next >= count ||
        (!flow && COMMENT.test(lines[next].text)) ||
        measure(lines[next]) <= parent
      ) {
        break;
      }
      separator = next > pos ? "\n".repeat(next - pos) : " ";
      at = lines[next];
      piece = flow ? cutFlow(at.body, piece.quote, piece.depth) : cut(at.body);
    }
    if (flow) balanced(value, line.n);
    return {
      kind: "scalar",
      value,
      style: flow ? "flow" : "plain",
      line: line.n,
    };
  }

  function quoted(line, rest, parent) {
    const quote = rest[0];
    let at = line;
    let text = rest.slice(1);
    let i = 0;
    // Each part is one character, an escape's character, `'`, the fold's space
    // or a run of breaks, so popping all-blank parts trims exactly the blanks.
    // A fold trims only literal blanks: `kept` parts end at the last escape,
    // whose blank (`\t`, `\x20`) YAML keeps as content.
    const parts = [];
    let kept = 0;
    let joined = false;
    for (;;) {
      if (i >= text.length) {
        // The value continues on the next line; fold it the way YAML does.
        let next = at.i + 1;
        while (next < count && BLANK.test(lines[next].text)) next++;
        if (next >= count) fail(line.n, "unterminated quoted value");
        const gaps = next - at.i - 1;
        at = lines[next];
        if (spaces(at.text) <= parent || MARKER.test(at.text)) {
          fail(at.n, "a quoted value continues at or left of its key");
        }
        while (
          !joined &&
          parts.length > kept &&
          /^[ \t]+$/.test(parts.at(-1))
        ) {
          parts.pop();
        }
        if (!joined || gaps) parts.push(gaps ? "\n".repeat(gaps) : " ");
        joined = false;
        text = at.text.replace(/^[ \t]+/, "");
        i = 0;
        continue;
      }
      const char = text[i];
      if (quote === "'") {
        if (char !== "'") {
          parts.push(char);
          i++;
        } else if (text[i + 1] === "'") {
          parts.push("'");
          i += 2;
        } else {
          i++;
          break;
        }
        continue;
      }
      if (char === '"') {
        i++;
        break;
      }
      if (char !== "\\") {
        parts.push(char);
        i++;
        continue;
      }
      const code = text[i + 1];
      if (code === undefined) {
        joined = true;
        i++;
      } else if (Object.hasOwn(ESCAPES, code)) {
        kept = parts.push(ESCAPES[code]);
        i += 2;
      } else if (Object.hasOwn(HEX_ESCAPES, code)) {
        const hex = text.slice(i + 2, i + 2 + HEX_ESCAPES[code]);
        const point = Number.parseInt(hex, 16);
        if (
          !/^[0-9a-fA-F]+$/.test(hex) ||
          hex.length !== HEX_ESCAPES[code] ||
          point > 0x10ffff
        ) {
          fail(at.n, `invalid \\${code} escape`);
        }
        kept = parts.push(String.fromCodePoint(point));
        i += 2 + hex.length;
      } else fail(at.n, `escape \\${code} is not read`);
    }
    if (!QUOTED_TAIL.test(text.slice(i))) {
      fail(at.n, "content after a quoted value");
    }
    const value = parts.join("");
    for (const char of value) {
      const code = char.codePointAt(0);
      if (code !== 0x09 && code !== 0x0a && hostile(code)) {
        fail(line.n, `escaped character ${codeName(code)} is not read`);
      }
    }
    pos = at.i + 1;
    return {
      kind: "scalar",
      value,
      style: quote === '"' ? "double" : "single",
      line: line.n,
    };
  }

  // YAML line folding: a break between two plain lines becomes a space, blank
  // lines between them become newlines, and a break beside a more-indented line
  // stays, so a command after a blank or indented line starts its own line.
  function fold(body) {
    let value = "";
    let previous = null;
    let blanks = 0;
    for (const text of body) {
      if (text === "") {
        blanks++;
        continue;
      }
      if (previous === null) value += "\n".repeat(blanks);
      else if (/^[ \t]/.test(previous) || /^[ \t]/.test(text)) {
        value += "\n".repeat(blanks + 1);
      } else value += blanks ? "\n".repeat(blanks) : " ";
      value += text;
      previous = text;
      blanks = 0;
    }
    return value;
  }

  function blockScalar(line, rest, parent) {
    const header = rest.match(
      /^([|>])(?:([1-9])([+-])?|([+-])([1-9])?)?(?:[ \t]+#.*|[ \t]*)$/,
    );
    if (!header) fail(line.n, "unsupported block scalar header");
    const step = header[2] ?? header[5];
    const chomp = header[3] ?? header[4];
    let indent = step ? parent + Number(step) : -1;
    let next = line.i + 1;
    if (indent < 0) {
      let probe = next;
      // Only a space-only line is skipped: YAML takes the first line holding
      // anything else, a TAB included, as content that sets the indent.
      while (probe < count && /^ *$/.test(lines[probe].text)) probe++;
      const first = probe < count ? spaces(lines[probe].text) : 0;
      indent = first > parent ? first : Number.POSITIVE_INFINITY;
    }
    // Content may hold TABs and `#` past its indent; a shorter line ends it. A
    // blank line longer than the indent is content (YAML's empty line holds at
    // most `indent` spaces). The last content line gets its break even when
    // the file ends on it, as yaml reads it (GitHub's reader is unverified, and
    // the break makes a `${{ }}` a template); a trailing empty line adds one
    // only when newline-terminated.
    const body = [];
    while (next < count) {
      const text = lines[next].text;
      const terminated = next < count - 1;
      if (BLANK.test(text)) {
        const deeper = spaces(text) >= indent && text.length > indent;
        body.push({ text: deeper ? text.slice(indent) : "", terminated });
      } else if (spaces(text) < indent) break;
      else body.push({ text: text.slice(indent), terminated });
      next++;
    }
    let end = body.length;
    while (end && body[end - 1].text === "") end--;
    const content = body.slice(0, end).map((entry) => entry.text);
    // YAML chomping: strip (`-`) keeps no final break, clip keeps one, keep
    // (`+`) also keeps the trailing empty lines' breaks.
    const broken = end > 0 ? "\n" : "";
    const kept = body.slice(end).filter((entry) => entry.terminated).length;
    const tail =
      chomp === "-" ? "" : broken + (chomp === "+" ? "\n".repeat(kept) : "");
    pos = next;
    return {
      kind: "scalar",
      value: (header[1] === "|" ? content.join("\n") : fold(content)) + tail,
      style: header[1] === "|" ? "literal" : "folded",
      line: line.n,
    };
  }

  skip();
  if (pos < count && lines[pos].text.startsWith("%")) {
    fail(lines[pos].n, "YAML directives are not read");
  }
  if (pos < count && measure(lines[pos]) === 0 && isMarker(lines[pos])) {
    pos++;
    skip();
  }
  if (pos >= count) fail(1, "empty YAML document");
  const root = block(measure(lines[pos]), -1);
  skip();
  if (pos < count && /^\.\.\.(?:[ \t]+#.*|[ \t]*)$/.test(lines[pos].text)) {
    pos++;
    skip();
  }
  if (pos < count) {
    fail(
      lines[pos].n,
      lines[pos].text.startsWith("---")
        ? "more than one YAML document"
        : "unexpected content",
    );
  }
  return root;
}

const isMap = (node) => node?.kind === "map";

function shapeOf(node) {
  if (node.kind === "seq") return "a sequence";
  if (node.kind === "map") return "a mapping";
  if (node.style === "flow") return "flow-style";
  if (node.style === "empty") return "empty";
  return "a scalar";
}

const oneLine = (text) => String(text).replace(/\s+/g, " ").trim();

const USES = /^([^/@\s]+)\/([^/@\s]+)(\/[^@\s]*)?(?:@(\S*))?$/;

export function verdict(files, nodeVersion, exempt = EXEMPT) {
  const raw = [];
  const nodeJobs = [];
  const actions = new Map();
  const VISITING = Symbol("visiting");
  let timedJobs = 0;
  let setupSteps = 0;
  const add = (file, line, rule, message, fix, site = file) =>
    raw.push({ file, line, rule, message: oneLine(message), fix, site });

  const literal = (node, line, label) => {
    if (
      node.kind !== "scalar" ||
      !LITERAL.has(node.style) ||
      node.value === "" ||
      /\$\{\{/.test(node.value)
    ) {
      throw new Unreadable(
        line,
        `${label} is not a literal command, so its runtime cannot be resolved`,
      );
    }
    return node.value;
  };

  function defaultShell(owner, label) {
    const defaults = owner.entries.get("defaults");
    if (defaults === undefined) return undefined;
    if (!isMap(defaults)) {
      throw new Unreadable(
        owner.keyLines.get("defaults"),
        `${label} defaults is ${shapeOf(defaults)}, not a mapping`,
      );
    }
    const run = defaults.entries.get("run");
    if (run === undefined) return undefined;
    if (!isMap(run)) {
      throw new Unreadable(
        defaults.keyLines.get("run"),
        `${label} defaults.run is ${shapeOf(run)}, not a mapping`,
      );
    }
    const shell = run.entries.get("shell");
    if (shell === undefined) return undefined;
    return literal(shell, run.keyLines.get("shell"), `${label} defaults shell`);
  }

  function setupProblems(target, fields, line) {
    const problems = [];
    if (!target.ref) {
      problems.push([
        "setup-node has no @ref",
        "pin it: `uses: actions/setup-node@<ref>`",
      ]);
    }
    const inputs = new Map();
    const options = fields.get("with");
    if (options !== undefined) {
      for (const [key, value] of options.entries) {
        const name = key.toLowerCase();
        if (inputs.has(name)) {
          throw new Unreadable(
            options.keyLines.get(key),
            `with repeats ${name} in another letter case`,
          );
        }
        inputs.set(name, value);
      }
    }
    if (inputs.has("node-version")) {
      problems.push([
        "setup-node sets node-version",
        "drop `node-version` and read `node-version-file: .node-version`",
      ]);
    }
    const versionFile = inputs.get("node-version-file");
    const path =
      versionFile?.kind === "scalar" && LITERAL.has(versionFile.style)
        ? versionFile.value.replace(/^\.\//, "")
        : undefined;
    if (path !== ".node-version") {
      problems.push([
        versionFile === undefined
          ? "setup-node has no node-version-file"
          : `setup-node reads node-version-file ${path ?? "(not a literal)"}`,
        "set `node-version-file: .node-version`",
      ]);
    }
    if (fields.has("if")) {
      problems.push([
        "setup-node runs under `if:`, so Node is not set up on every run",
        "drop the `if:` from the setup-node step",
      ]);
    }
    return problems.map(([message, fix]) => ({ line, message, fix }));
  }

  // An `if:` is an expression when it holds no `${{` or is wholly one
  // `${{ ... }}`; with `${{` anywhere else GitHub reads a string template,
  // truthy text that gates on nothing, so this returns null for it. Untrimmed:
  // whitespace a quoted value keeps around its `${{ }}` makes it a template,
  // and so does a U+00A0 there, which YAML keeps as content. Inside the
  // expression white space is the runner's (Char.IsWhiteSpace, U+00A0
  // included; \s differs only on characters sourceLines already refuses).
  const expressionOf = (condition) => {
    const value = condition.value;
    const whole = value.includes("${{")
      ? value.match(/^\$\{\{((?:(?!\$\{\{|\}\})[\s\S])*)\}\}$/)?.[1]
      : value;
    return whole === undefined ? null : whole.replace(/\s+/g, " ").trim();
  };

  const CLOSERS = { "(": ")", "[": "]" };

  // The `&&` operands outside parentheses and index brackets and outside
  // '...' strings ('' escapes a quote), so a negated, grouped or indexed
  // conjunction stays one operand. Null when an `||` stands at the top level
  // or the brackets or quotes don't pair, so the caller reads no conjunction.
  function topConjuncts(expression) {
    const parts = [];
    const open = [];
    let quoted = false;
    let start = 0;
    for (let i = 0; i < expression.length; i++) {
      const char = expression[i];
      if (quoted) {
        if (char === "'" && expression[i + 1] === "'") i++;
        else if (char === "'") quoted = false;
      } else if (char === "'") quoted = true;
      else if (char === "(" || char === "[") open.push(CLOSERS[char]);
      else if (char === ")" || char === "]") {
        if (open.pop() !== char) return null;
      } else if (open.length || expression[i + 1] !== char) continue;
      else if (char === "|") return null;
      else if (char === "&") {
        parts.push(expression.slice(start, i));
        start = i + 2;
        i++;
      }
    }
    if (quoted || open.length) return null;
    parts.push(expression.slice(start));
    return parts.map((part) => part.trim());
  }

  // A node step that can run without its setup-node succeeding is covered only
  // when it is non-gating itself or its condition requires a setup's success:
  // a top-level `&&` conjunct `steps.<id>.outcome == 'success'`, and no
  // top-level `||`.
  function gatedOnSetup(fields, ids) {
    const mayFail = fields.get("continue-on-error");
    if (
      mayFail?.kind === "scalar" &&
      mayFail.style === "plain" &&
      /^(?:true|True|TRUE)$/.test(mayFail.value)
    ) {
      return true;
    }
    const condition = fields.get("if");
    if (
      !ids.size ||
      condition?.kind !== "scalar" ||
      !CONDITION_STYLES.has(condition.style)
    ) {
      return false;
    }
    const expression = expressionOf(condition);
    const conjuncts = expression === null ? null : topConjuncts(expression);
    if (conjuncts === null) return false;
    return conjuncts.some((conjunct) => {
      const parts = conjunct.match(
        /^steps\.([A-Za-z0-9_-]+)\.outcome ?== ?'success'$/i,
      );
      return parts !== null && ids.has(parts[1].toLowerCase());
    });
  }

  // Any status function drops the implicit success(), so the step may run
  // after a failed setup-node unless a top-level conjunct is a bare success()
  // and no `||` stands at the top level; a template keeps the implicit
  // success() only without one, and an `if:` that can't be read counts as
  // running past a failure.
  function runsPastFailure(fields) {
    const condition = fields.get("if");
    if (condition === undefined) return false;
    if (condition.kind !== "scalar") return true;
    const expression = expressionOf(condition);
    if (expression === null) return STATUS_CALL.test(condition.value);
    if (!STATUS_CALL.test(expression)) return false;
    const conjuncts = topConjuncts(expression);
    if (conjuncts === null) return true;
    return !conjuncts.some((conjunct) => /^success\s*\(\s*\)$/i.test(conjunct));
  }

  // Walks one job's or composite's steps in order. Returns whether it runs Node
  // before its own setup-node, and whether it ends with Node set up.
  function walk(file, site, label, steps, options) {
    const { composite = false, container = false, shell } = options;
    let checkout = composite;
    let setup = false;
    // Ids of the setups so far, and whether one of them may fail open.
    const setupIds = new Set();
    let failOpen = false;
    let firstNode = 0;
    let firstNodeLine = 0;
    let firstUngated = 0;
    let firstUngatedLine = 0;
    let ungatedWhy = "";
    let setupAfter = 0;
    let anyNode = false;
    for (const [index, step] of steps.items.entries()) {
      const number = index + 1;
      const line = steps.lines[index];
      const where = `${label} step ${number}`;
      if (!isMap(step)) {
        throw new Unreadable(
          line,
          `${where} is ${shapeOf(step)}, not a mapping`,
        );
      }
      const fields = step.entries;
      const uses = fields.get("uses");
      const run = fields.get("run");
      if (uses && run)
        throw new Unreadable(line, `${where} has both uses and run`);
      if (!uses && !run) {
        throw new Unreadable(line, `${where} has neither uses nor run`);
      }
      const inputs = fields.get("with");
      if (inputs !== undefined && !isMap(inputs)) {
        throw new Unreadable(
          inputs.line,
          inputs.style === "flow"
            ? `flow-style with in ${where}`
            : `with in ${where} is ${shapeOf(inputs)}, not a mapping`,
        );
      }
      const conditional = fields.has("if");
      const mayFail = fields.get("continue-on-error");
      const failsClosed =
        mayFail === undefined ||
        (mayFail.kind === "scalar" &&
          mayFail.style === "plain" &&
          /^(?:false|False|FALSE)$/.test(mayFail.value));
      const unconditional = !conditional && failsClosed;
      // A background step's environment lands only after a later wait, so a
      // backgrounded setup is not read as one.
      const background = fields.get("background");
      const foreground =
        background === undefined ||
        (background.kind === "scalar" &&
          background.style === "plain" &&
          /^(?:false|False|FALSE)$/.test(background.value));
      const refuseBackground = () => {
        if (!foreground) {
          throw new Unreadable(
            line,
            `${where} sets Node up in the background`,
            "run setup-node in the foreground (drop `background:`)",
          );
        }
      };
      let nodeRun = false;
      let setsUp = false;
      if (run) {
        if (
          run.kind !== "scalar" ||
          run.style === "flow" ||
          run.style === "empty"
        ) {
          throw new Unreadable(line, `run in ${where} is ${shapeOf(run)}`);
        }
        const stepShell = fields.has("shell")
          ? literal(fields.get("shell"), line, `shell in ${where}`)
          : shell;
        nodeRun =
          runsNode(run.value) ||
          (stepShell !== undefined && runsNode(stepShell));
      } else {
        if (uses.kind !== "scalar" || !LITERAL.has(uses.style) || !uses.value) {
          throw new Unreadable(
            line,
            `uses in ${where} is not a literal action`,
          );
        }
        const target = uses.value;
        if (target.startsWith("./")) {
          const callee = local(target, line);
          if (callee.setsUp) refuseBackground();
          nodeRun = callee.nodeRun;
          setsUp = callee.setsUp && !conditional && checkout;
        } else if (!target.startsWith("docker://")) {
          const parts = target.match(USES);
          if (!parts)
            throw new Unreadable(line, `unparsable uses ${target} in ${where}`);
          const action = `${parts[1]}/${parts[2]}`.toLowerCase();
          const parsed = { ref: parts[4], subpath: parts[3] };
          if (action === "actions/setup-node" && !parsed.subpath) {
            refuseBackground();
            setupSteps++;
            const problems = setupProblems(parsed, fields, line);
            for (const problem of problems) {
              add(
                file,
                line,
                "setup-node-form",
                `${where}: ${problem.message}`,
                problem.fix,
                site,
              );
            }
            if (!checkout) {
              add(
                file,
                line,
                "setup-node-before-checkout",
                `${where} sets up Node before an unconditional checkout`,
                "run `actions/checkout@<ref>` with no `if:` or `continue-on-error` first",
                site,
              );
            }
            setsUp = problems.length === 0 && checkout;
          } else if (
            action === "actions/checkout" &&
            !parsed.subpath &&
            parsed.ref &&
            unconditional
          ) {
            checkout = true;
          }
        }
      }
      if (nodeRun) {
        anyNode = true;
        if (setup || failOpen) {
          // A fail-closed setup covers a later step unless a status function
          // runs that step after the setup failed.
          const why = !setup
            ? "after a setup-node that may fail open"
            : runsPastFailure(fields)
              ? "under a condition that can run it after a failed setup-node"
              : "";
          if (why && !firstUngated && !gatedOnSetup(fields, setupIds)) {
            firstUngated = number;
            firstUngatedLine = line;
            ungatedWhy = why;
          }
        } else if (!firstNode) {
          firstNode = number;
          firstNodeLine = line;
        }
      }
      if (setsUp) {
        if (firstNode && !setupAfter) setupAfter = number;
        if (failsClosed) setup = true;
        else failOpen = true;
        const id = fields.get("id");
        if (id?.kind === "scalar" && LITERAL.has(id.style) && id.value) {
          setupIds.add(id.value.toLowerCase());
        }
      }
    }
    // Reported beside any earlier finding: an exemption that waives the early
    // run must not hide a later step that runs Node past a failed setup.
    if (firstUngated) {
      add(
        file,
        firstUngatedLine,
        "setup-node-missing",
        `${label} runs node at step ${firstUngated} ${ungatedWhy}, without depending on its success`,
        GATE_FIX,
        site,
      );
    }
    if (firstNode) {
      if (composite) {
        add(
          file,
          firstNodeLine,
          "composite-node",
          `${label} runs node at step ${firstNode} without its own setup-node, so it runs on the caller's Node`,
          "set Node up inside the action from .node-version, or give EXEMPT a reason",
          site,
        );
      } else if (container) {
        add(
          file,
          firstNodeLine,
          "container-node",
          `${label} runs node at step ${firstNode} on its container's Node, with no setup-node before it`,
          "set Node up from .node-version first, or give EXEMPT a reason naming why the container's Node is acceptable",
          site,
        );
      } else if (setupAfter) {
        add(
          file,
          firstNodeLine,
          "setup-node-after-node",
          `${label} runs node at step ${firstNode} before its setup-node at step ${setupAfter}`,
          setupFix(firstNode),
          site,
        );
      } else {
        add(
          file,
          firstNodeLine,
          "setup-node-missing",
          `${label} runs node at step ${firstNode} with no setup-node before it`,
          setupFix(firstNode),
          site,
        );
      }
    }
    return { nodeRun: firstNode > 0, setsUp: setup, anyNode };
  }

  function local(target, line) {
    // The lookbehind starts the trim only at a slash run's first slash, so a
    // long run not at the end is tried once, not once per slash.
    const name = target
      .replace(/(?<!\/)\/+$/, "")
      .match(/^\.\/\.github\/actions\/([^/]+)$/);
    if (!name) {
      throw new Unreadable(
        line,
        `local action ${target} is outside .github/actions/<name>, which this guard reads`,
      );
    }
    const path = [".yml", ".yaml"]
      .map((ext) => `.github/actions/${name[1]}/action${ext}`)
      .find((candidate) => files.has(candidate));
    if (!path)
      throw new Unreadable(line, `local action ${target} is not in the corpus`);
    const result = action(path);
    if (result.unreadable) {
      throw new Unreadable(line, `local action ${target} is unreadable`);
    }
    return result;
  }

  function action(path) {
    const cached = actions.get(path);
    if (cached === VISITING)
      throw new Unreadable(1, `local action ${path} calls itself`);
    if (cached) return cached;
    actions.set(path, VISITING);
    let result;
    try {
      const doc = parseWorkflow(text(path), path);
      if (!isMap(doc)) {
        throw new Unreadable(
          doc.line,
          `the action is ${shapeOf(doc)}, not a mapping`,
        );
      }
      const runs = doc.entries.get("runs");
      if (!isMap(runs)) {
        throw new Unreadable(
          doc.keyLines.get("runs") ?? 1,
          runs
            ? `runs is ${shapeOf(runs)}, not a mapping`
            : "the action has no runs",
        );
      }
      const using = runs.entries.get("using");
      if (using?.kind !== "scalar" || !LITERAL.has(using.style)) {
        throw new Unreadable(runs.line, "runs.using is not a literal");
      }
      if (using.value.toLowerCase() !== "composite") {
        // A JavaScript or Docker action brings its own runtime.
        result = { nodeRun: false, setsUp: false };
      } else {
        const steps = runs.entries.get("steps");
        if (steps?.kind !== "seq") {
          throw new Unreadable(
            runs.keyLines.get("steps") ?? runs.line,
            steps
              ? `runs.steps is ${shapeOf(steps)}, not a sequence`
              : "the composite has no steps",
          );
        }
        result = walk(path, path, "the action", steps, { composite: true });
      }
    } catch (error) {
      add(
        path,
        error.line ?? 1,
        "unreadable",
        error.message,
        error.fix ?? SUBSET_FIX,
      );
      result = { unreadable: true };
    }
    actions.set(path, result);
    return result;
  }

  function text(file) {
    const source = files.get(file);
    if (source instanceof Error) {
      throw new Unreadable(1, `cannot read the file: ${source.message}`);
    }
    if (typeof source !== "string")
      throw new Unreadable(1, "the file is not text");
    return source;
  }

  function workflow(file) {
    const doc = parseWorkflow(text(file), file);
    if (!isMap(doc)) {
      throw new Unreadable(
        doc.line,
        `the document is ${shapeOf(doc)}, not a mapping`,
      );
    }
    const jobs = doc.entries.get("jobs");
    if (jobs === undefined) throw new Unreadable(1, "no top-level jobs");
    if (!isMap(jobs)) {
      throw new Unreadable(
        doc.keyLines.get("jobs"),
        `jobs is ${shapeOf(jobs)}, not a mapping`,
      );
    }
    const workflowShell = defaultShell(doc, "workflow");
    for (const [id, job] of jobs.entries) {
      const line = jobs.keyLines.get(id);
      const label = `job ${id}`;
      if (!isMap(job)) {
        throw new Unreadable(
          line,
          `${label} is ${shapeOf(job)}, not a mapping`,
        );
      }
      const fields = job.entries;
      if (fields.has("uses") && fields.has("steps")) {
        throw new Unreadable(line, `${label} has both uses and steps`);
      }
      // A reusable-workflow caller takes no timeout-minutes and runs no steps here.
      if (fields.has("uses")) continue;
      if (!fields.has("steps"))
        throw new Unreadable(line, `${label} has no steps`);
      const bound = fields.get("timeout-minutes");
      if (bound === undefined) {
        add(
          file,
          line,
          "job-timeout",
          `${label} has no timeout-minutes`,
          TIMEOUT_FIX,
        );
      } else if (
        bound.kind !== "scalar" ||
        bound.style !== "plain" ||
        !/^[1-9]\d{0,2}$/.test(bound.value) ||
        Number(bound.value) > 360
      ) {
        add(
          file,
          line,
          "job-timeout",
          `${label} timeout-minutes is not an unquoted integer 1..360, so its bound cannot be verified`,
          TIMEOUT_FIX,
        );
      } else timedJobs++;
      const steps = fields.get("steps");
      if (steps.kind !== "seq") {
        throw new Unreadable(
          job.keyLines.get("steps"),
          steps.style === "flow"
            ? `flow-style steps in ${label}`
            : `steps of ${label} is ${shapeOf(steps)}, not a sequence`,
        );
      }
      const shell = defaultShell(job, label) ?? workflowShell;
      const result = walk(file, `${file}#${id}`, label, steps, {
        container: fields.has("container"),
        shell,
      });
      if (result.anyNode) nodeJobs.push(`${file}#${id}`);
    }
  }

  const version =
    typeof nodeVersion === "string" ? nodeVersion.replace(/\r\n/g, "\n") : "";
  if (!/^v?\d+(?:\.\d+){0,2}\n?$/.test(version)) {
    add(
      ".node-version",
      1,
      "node-version-file",
      nodeVersion instanceof Error
        ? `.node-version cannot be read: ${nodeVersion.message}`
        : ".node-version is not one version line",
      "write one line such as `24` or `v24.1.0` to .node-version",
    );
  }
  if (![...files.keys()].some((file) => WORKFLOW_PATH.test(file))) {
    add(
      ".github/workflows",
      1,
      "empty-corpus",
      "no workflow files were found",
      "run from the repository root, or point GD_WORKFLOW_NODE_ROOT at it",
    );
  }
  for (const file of files.keys()) {
    if (ACTION_PATH.test(file)) {
      action(file);
      continue;
    }
    try {
      if (!WORKFLOW_PATH.test(file)) {
        throw new Unreadable(1, "not a workflow or local action path");
      }
      workflow(file);
    } catch (error) {
      add(
        file,
        error.line ?? 1,
        "unreadable",
        error.message,
        error.fix ?? SUBSET_FIX,
      );
    }
  }

  const waivable = new Set();
  const findings = [];
  for (const { site, ...finding } of raw) {
    if (WAIVABLE.has(finding.rule)) {
      waivable.add(site);
      if (exempt.has(site)) continue;
    }
    findings.push(finding);
  }
  for (const [site, reason] of exempt) {
    const file = String(site).split("#")[0];
    if (typeof reason !== "string" || !reason.trim()) {
      findings.push({
        file,
        line: 1,
        rule: "exempt-reason",
        message: `the exemption for ${site} gives no reason`,
        fix: "say why its Node may come from the container or the caller",
      });
    }
    if (!waivable.has(site)) {
      findings.push({
        file,
        line: 1,
        rule: "exempt-stale",
        message: `the exemption for ${site} waives nothing`,
        fix: "remove the EXEMPT entry",
      });
    }
  }
  findings.sort(
    (a, b) =>
      (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
      a.line - b.line ||
      (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0),
  );
  return {
    ok: findings.length === 0,
    findings,
    failures: findings.map(format),
    nodeJobs: nodeJobs.sort(),
    timedJobs,
    files: files.size,
    setupSteps,
  };
}

export const format = ({ file, line, rule, message, fix }) =>
  `workflow-node-setup: FAIL ${file}:${line}: ${rule}: ${message} (fix: ${fix})`;

// Reads bytes and decodes them strictly, so invalid UTF-8 fails instead of
// turning into U+FFFD. Workflow and action text keeps its byte-order mark, as
// parseWorkflow strips exactly one; `.node-version`'s decoder drops one.
export function readCorpus(root, read = readFileSync) {
  const yamlDecoder = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  });
  const versionDecoder = new TextDecoder("utf-8", { fatal: true });
  const paths = readdirSync(join(root, ".github", "workflows"), {
    withFileTypes: true,
  })
    .filter(
      (entry) =>
        (entry.isFile() || entry.isSymbolicLink()) &&
        /\.ya?ml$/.test(entry.name),
    )
    .map((entry) => `.github/workflows/${entry.name}`);
  let dirs = [];
  try {
    dirs = readdirSync(join(root, ".github", "actions"), {
      withFileTypes: true,
    });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory() && !dir.isSymbolicLink()) continue;
    for (const name of readdirSync(
      join(root, ".github", "actions", dir.name),
    )) {
      if (/^action\.ya?ml$/.test(name)) {
        paths.push(`.github/actions/${dir.name}/${name}`);
      }
    }
  }
  const decode = (path, decoder) => {
    try {
      const bytes = read(join(root, path));
      if (!(bytes instanceof Uint8Array))
        return new Error("the read returned no bytes");
      const text = decoder.decode(bytes);
      return LONE_CR.test(text) ? text : text.replace(/\r\n/g, "\n");
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  };
  return {
    files: new Map(
      paths.sort().map((path) => [path, decode(path, yamlDecoder)]),
    ),
    nodeVersion: decode(".node-version", versionDecoder),
  };
}

function main() {
  const root =
    process.env.GD_WORKFLOW_NODE_ROOT ||
    resolve(dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const { files, nodeVersion } = readCorpus(root);
    const result = verdict(files, nodeVersion);
    if (result.ok) {
      process.stdout.write(
        `workflow-node-setup: OK ${result.nodeJobs.length} jobs run node, each after setup-node from .node-version; ${result.timedJobs} jobs carry timeout-minutes (${result.files} files)\n`,
      );
      return;
    }
    for (const failure of result.failures) process.stderr.write(`${failure}\n`);
  } catch (error) {
    process.stderr.write(
      `${format({
        file: ".github/workflows",
        line: 1,
        rule: "unreadable",
        message: oneLine(
          `cannot read the corpus under ${root}: ${error.message}`,
        ),
        fix: "run from a checkout, or point GD_WORKFLOW_NODE_ROOT at one",
      })}\n`,
    );
  }
  process.exitCode = 1;
}

// Real paths compare through symlinks and junctions without import.meta.main;
// an unresolvable path (a data: URL import, a deleted file) is not main.
function isMain() {
  try {
    return (
      realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (process.argv[1] && isMain()) {
  main();
}
