#!/usr/bin/env python3
"""Canonicalize Rust source for CI comment/format-equivalence checks.

Used by .github/workflows/rust-tests.yml's `gate` job: when no byte-identical
green `src-tauri` tree exists, the gate may still skip the expensive 3-OS matrix
if the delta vs a proven-green run is comment-or-formatting-only in `.rs` files.
This script reduces a `.rs` file to a canonical form so that two files differing
only by comments and whitespace/reflow produce byte-identical output.

Contract (load-bearing — the workflow depends on exactly this):
  * default mode: read UTF-8 Rust from stdin, write canonical form to stdout,
    exit 0; on a UTF-8 decode error print to stderr and exit 2; on any lexical
    anomaly (unterminated block comment / string / raw string / char literal)
    print a one-line reason to stderr and exit 2.
  * --self-test: run the embedded fixture suite, print pass/fail per case, exit
    0 if all pass else 1.

Canonical form:
  * Code characters are emitted verbatim.
  * Any maximal run of whitespace (Rust's Pattern_White_Space minus CR — see
    _WHITESPACE; deliberately NOT str.isspace()) and/or dropped (non-doc)
    comments collapses to exactly one '\n'. This makes the form insensitive to
    comments, reflow, and CRLF-vs-LF. A comment with no surrounding whitespace
    still contributes the separator: `a/*x*/b` -> `a\nb` (correctly != `ab`).
  * Doc comments are emitted byte-verbatim (entire span): line `///` / `//!`,
    block `/**` / `/*!` (whole nested span). Doc text is semantically live — the
    crate's rlib target runs doc tests and clippy has doc lints.
    NOTE: this deliberately OVER-preserves the corner cases the Rust reference
    excludes from doc-hood (`////...`, `/***...`, `/**/`): preserving too much is
    sound (worst case: the matrix runs unnecessarily); stripping too much is not.
  * String-ish literals are emitted byte-verbatim so `//`, `/*`, blank lines,
    `\r` etc. inside them never look like comments/whitespace.

The output need not be valid Rust — it is only ever compared for byte equality
against another canonical form produced by this same script.
"""

import sys

# Identifier characters, for prefix-vs-identifier-tail detection.
_IDENT = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_")

# Rust's exact whitespace set (Rust Reference, "Whitespace" — the
# Pattern_White_Space code points rustc's lexer accepts), MINUS carriage return:
# CR is normalized away before lexing (see canon()), and a BARE \r that somehow
# survives must be treated as CODE, not whitespace — rustc hard-errors on a bare
# CR, so we must NOT let one collapse into the separator (that would canonicalize
# a non-compiling tree equal to a green one). str.isspace() is a SUPERSET of this
# (it accepts NBSP U+00A0, U+3000, U+001C-001F, etc.) which rustc rejects with
# "unknown start of token"; using isspace() would collapse those into the
# separator and skip a tree that does not compile. Sound direction: any other
# Unicode space-ish char is emitted as CODE (over-preserve — worst case the
# matrix runs; rustc rejects most of them anyway).
# Written as chr() escapes so the invisible/bidi code points can't be corrupted
# by an editor or an EOL conversion — the literal glyphs would be indistinguishable.
_WHITESPACE = frozenset(
    {
        chr(0x09),  # tab
        chr(0x0A),  # line feed
        chr(0x0B),  # vertical tab
        chr(0x0C),  # form feed
        " ",  # U+0020 space
        chr(0x85),  # next line
        chr(0x200E),  # left-to-right mark
        chr(0x200F),  # right-to-left mark
        chr(0x2028),  # line separator
        chr(0x2029),  # paragraph separator
    }
)


class Anomaly(Exception):
    """A lexical anomaly that must fail open (exit 2): unterminated span."""


def canon(src: str) -> str:
    """Return the canonical form of Rust source `src`. Raise Anomaly on an
    unterminated block comment / string / raw string / char literal."""
    # Normalize CRLF -> LF up front, matching rustc's own source-file
    # normalization: rustc replaces every CRLF with LF at load time, INCLUDING
    # inside string/char literals and doc comments. Doing it here makes the
    # canonical form genuinely insensitive to CRLF-vs-LF — in particular a
    # verbatim-emitted line-doc comment no longer keeps a trailing '\r', so a
    # CRLF file with `///` now matches its LF twin (it did not before). A bare
    # '\r' not part of a CRLF is left intact: rustc hard-errors on it, so it must
    # NOT be treated as whitespace (see _WHITESPACE) — it falls through to code.
    src = src.replace("\r\n", "\n")
    out = []  # list of emitted chunks
    n = len(src)
    i = 0
    # `pending_sep` marks that we are inside a run of whitespace / dropped
    # comments; we emit a single '\n' the first time the run starts and swallow
    # the rest until a non-collapsing character is seen.
    pending_sep = False

    def start_sep():
        nonlocal pending_sep
        if not pending_sep:
            out.append("\n")
            pending_sep = True

    def emit(s: str):
        nonlocal pending_sep
        out.append(s)
        pending_sep = False

    while i < n:
        c = src[i]

        # --- whitespace ---
        # Use Rust's exact whitespace set, NOT str.isspace() (a superset that
        # would wrongly collapse rustc-rejected chars like NBSP into the
        # separator — see _WHITESPACE). CR is already gone via normalization.
        if c in _WHITESPACE:
            start_sep()
            i += 1
            continue

        # --- comments ---
        if c == "/" and i + 1 < n and src[i + 1] == "/":
            # line comment; doc if `///` or `//!` (but NOT `////...` — that is a
            # non-doc line comment per the reference; we still preserve `////`
            # here on purpose, see module docstring).
            third = src[i + 2] if i + 2 < n else ""
            is_doc = third == "/" or third == "!"
            # scan to end of line (not including the newline)
            j = i + 2
            while j < n and src[j] != "\n":
                j += 1
            if is_doc:
                emit(src[i:j])
            else:
                start_sep()
            i = j
            continue

        if c == "/" and i + 1 < n and src[i + 1] == "*":
            # block comment; doc if `/**` or `/*!`. Nested block comments must be
            # tracked to depth. NOTE: `/**/` lexes as a non-doc block comment
            # here (third char is `/`, not doc), which matches over-preservation
            # intent either way (it is dropped as an empty comment — sound).
            third = src[i + 2] if i + 2 < n else ""
            is_doc = third == "*" or third == "!"
            j = i + 2
            depth = 1
            while j < n and depth > 0:
                if src[j] == "/" and j + 1 < n and src[j + 1] == "*":
                    depth += 1
                    j += 2
                elif src[j] == "*" and j + 1 < n and src[j + 1] == "/":
                    depth -= 1
                    j += 2
                else:
                    j += 1
            if depth != 0:
                raise Anomaly("EOF inside block comment")
            if is_doc:
                emit(src[i:j])
            else:
                start_sep()
            i = j
            continue

        # --- string-ish literals with a b/r/c/br/cr prefix ---
        # A prefix starts a literal only when the char immediately BEFORE it is
        # not an identifier char — otherwise it's the tail of an identifier.
        if c in ("b", "r", "c") and (i == 0 or src[i - 1] not in _IDENT):
            consumed = _try_prefixed_literal(src, i, n, out, emit)
            if consumed is not None:
                i = consumed
                pending_sep = False
                continue

        # --- plain string ---
        if c == '"':
            i = _scan_plain_string(src, i, n, out, emit)
            pending_sep = False
            continue

        # --- char literal vs lifetime ---
        if c == "'":
            nxt = src[i + 1] if i + 1 < n else ""
            after = src[i + 2] if i + 2 < n else ""
            if nxt == "\\":
                # char literal with an escape: consume escape + to closing '
                i = _scan_char_literal(src, i, n, out, emit)
                pending_sep = False
                continue
            elif after == "'":
                # char literal `'X'` (covers `'"'` — the inner " must not open a
                # string). Emit `'X'` verbatim.
                emit(src[i : i + 3])
                i += 3
                pending_sep = False
                continue
            else:
                # lifetime / loop label (`'a`, `'static`): NOT a char literal.
                # Consume the ENTIRE identifier run after the `'` (maximal munch,
                # matching rustc's lexer) and emit it as one chunk. This is
                # load-bearing: if we emitted only `'` and let the loop re-read
                # the next char, a lifetime like `'r` / `'b` / `'br` followed by a
                # quote (e.g. `'r"..."`) would be misread at the top of the loop
                # as a raw/byte STRING prefix, silently changing the lexing of
                # the rest of the line — rustc sees `'r` + a plain string, we'd
                # see a raw string that ends early. Munching the whole label here
                # guarantees the following r/b/c is consumed as label text, never
                # re-dispatched as a literal prefix. (The char-literal checks
                # above run first, so `'r'` is still a char literal.)
                j = i + 1
                while j < n and src[j] in _IDENT:
                    j += 1
                emit(src[i:j])
                i = j
                continue

        # --- ordinary code character ---
        emit(c)
        i += 1

    # A leading/trailing collapse-separator is an artifact of surrounding
    # whitespace or a boundary comment (e.g. a file ending in `// note`, or one
    # that does not). Real `.rs` files always end in a newline, so whether the
    # last token is a trailing comment must not change equivalence — strip a
    # single leading and trailing '\n' so `code // note` == `code`.
    result = "".join(out)
    if result.startswith("\n"):
        result = result[1:]
    if result.endswith("\n"):
        result = result[:-1]
    return result


def _scan_plain_string(src, i, n, out, emit):
    """Scan a plain `"..."` string starting at src[i]=='"'. Emit verbatim.
    Return index past the closing quote. Raise Anomaly on EOF."""
    j = i + 1
    while j < n:
        ch = src[j]
        if ch == "\\":
            j += 2  # backslash consumes the following char
            continue
        if ch == '"':
            j += 1
            emit(src[i:j])
            return j
        j += 1
    raise Anomaly("EOF inside string literal")


def _scan_char_literal(src, i, n, out, emit):
    """Scan a char literal starting at src[i]=='\'' where src[i+1]=='\\'.
    Emit verbatim. Return index past the closing '. Raise Anomaly on EOF."""
    j = i + 1
    while j < n:
        ch = src[j]
        if ch == "\\":
            j += 2  # escape consumes following char
            continue
        if ch == "'":
            j += 1
            emit(src[i:j])
            return j
        j += 1
    raise Anomaly("EOF inside char literal")


def _try_prefixed_literal(src, i, n, out, emit):
    """Try to scan a prefixed string/char literal at src[i] (c in b/r/c).
    Handles: r"...", r#"..."#, b"...", br#"..."#, c"...", cr#"..."#, b'...'.
    Emit verbatim and return index past the literal, or return None if the
    prefix is not actually followed by an opener (so it's just an identifier
    start and should be treated as code)."""
    c = src[i]

    # Determine the raw-string opener position, if any: optional leading b/c,
    # then r, then #* then ".
    # Cases:
    #   r  ...  -> raw
    #   br ...  -> byte raw
    #   cr ...  -> C raw
    #   b" / c" -> byte/C string (plain-escape semantics)
    #   b'      -> byte char
    if c == "r":
        raw_at = i
    elif c in ("b", "c") and i + 1 < n and src[i + 1] == "r":
        raw_at = i + 1
    else:
        raw_at = None

    if raw_at is not None:
        # expect: 'r' then k '#' then '"'
        k = raw_at + 1
        hashes = 0
        while k < n and src[k] == "#":
            hashes += 1
            k += 1
        if k < n and src[k] == '"':
            # raw string: closer is '"' + hashes '#', no escapes inside.
            closer = '"' + ("#" * hashes)
            body = k + 1
            end = src.find(closer, body)
            if end == -1:
                raise Anomaly("EOF inside raw string literal")
            j = end + len(closer)
            emit(src[i:j])
            return j
        # `r` (or br/cr) not followed by a raw opener -> not a literal here.
        return None

    # Non-raw prefixed forms: b" c" (plain strings) or b' (byte char).
    if c in ("b", "c") and i + 1 < n and src[i + 1] == '"':
        # scan like a plain string but starting after the prefix; emit the
        # prefix + string verbatim.
        j = i + 1  # points at the opening quote
        j = _scan_plain_string(src, j, n, out, lambda s: None)
        emit(src[i:j])
        return j

    if c == "b" and i + 1 < n and src[i + 1] == "'":
        # byte char literal b'...': consume like a char literal.
        j = i + 1  # points at the opening '
        # reuse char-literal scanning (handles escapes)
        k = j + 1
        while k < n:
            ch = src[k]
            if ch == "\\":
                k += 2
                continue
            if ch == "'":
                k += 1
                emit(src[i:k])
                return k
            k += 1
        raise Anomaly("EOF inside byte char literal")

    return None


# --------------------------------------------------------------------------
# Embedded self-test suite.
# Each case is one of:
#   ("eq", input, expected)        canon(input) == expected
#   ("equiv", a, b)                canon(a) == canon(b)
#   ("distinct", a, b)             canon(a) != canon(b)
#   ("anomaly", input)             canon(input) raises Anomaly
#   ("ok", input)                  canon(input) does not raise (exit 0)
# --------------------------------------------------------------------------
_CASES = [
    # 1. Trailing // comment removed -> equivalent.
    ("equiv", 'let url = "x";  // note', 'let url = "x";'),
    # 2. String containing // is code -> DISTINCT (the naive-stripper killer).
    ("distinct", 'let u = "https://a.example";', 'let u = "https://b.example";'),
    # 3. Raw string containing comment-lookalikes.
    ("equiv", 'let s = r#"/* not */ // nope"#;', 'let s = r#"/* not */ // nope"#; // c'),
    ("distinct", 'let s = r#"/* not */ // nope"#;', 'let s = r#"/* NOT */ // nope"#;'),
    # 4. Nested block comment fully dropped.
    ("equiv", "a /* x /* y */ z */ b", "a b"),
    ("distinct", "a/*x*/b", "ab"),
    # 5. Doc comments load-bearing; regular comment change is equivalent.
    ("distinct", "/// v1", "/// v2"),
    ("distinct", "//! a", "//! b"),
    ("distinct", "/** a */", "/** b */"),
    ("equiv", "x // regular v1", "x // regular v2"),
    # 6. Lifetimes don't open char state.
    (
        "equiv",
        "fn f<'a>(x: &'a str) -> &'a str { x } // c",
        "fn f<'a>(x: &'a str) -> &'a str { x }",
    ),
    # 7. Char-literal quotes.
    (
        "equiv",
        "let q = '\"'; let t = '\\''; let b = b'\\''; // x",
        "let q = '\"'; let t = '\\''; let b = b'\\'';",
    ),
    # 8. Byte string verbatim.
    ("distinct", 'let b = b"// not a comment";', 'let b = b"// not A comment";'),
    # 9. Whitespace reformat equivalent; blank lines inside a string distinct.
    ("equiv", "fn a() {}\n\n\nfn b() {}", "fn a() {}\nfn b() {}"),
    ("distinct", 'let s = "line1\n\nline2";', 'let s = "line1\nline2";'),
    # 10. \u{...} escape + multi-line plain string survive verbatim, exit 0.
    ("ok", 'let s = "a\\u{1F600}b";'),
    ("ok", 'let s = "multi\nline\nstring";'),
    # Code whitespace collapses to '\n'; the string body (incl. \u{...}) is
    # emitted byte-verbatim inside.
    ("eq", 'let s = "a\\u{1F600}";', 'let\ns\n=\n"a\\u{1F600}";'),
    # 11. Anomalies + benign corner inputs.
    ("anomaly", "a /* unterminated"),
    ("anomaly", 'let s = "unterminated'),
    ("anomaly", 'let s = r#"unterminated"'),
    ("ok", "/**/"),
    ("ok", "////"),
    # 12. CRLF-vs-LF same source equivalent.
    ("equiv", "fn a() {\r\n    let x = 1;\r\n}\r\n", "fn a() {\n    let x = 1;\n}\n"),
    # 13. Blocker 1 — lifetime `'r` before a string must NOT be misread as a raw
    # string prefix. The attack: `m!('r"..." // one");` — rustc lexes `'r` (label)
    # + a PLAIN string spanning the `// one` text; a naive lexer that re-reads `r`
    # as a raw-string prefix closes early at the interior `\"` and drops the rest
    # as a line comment, making the // one and // two variants canonicalize equal.
    (
        "distinct",
        r'm!('
        "'"
        r'r"a\" // one");',
        r'm!('
        "'"
        r'r"a\" // two");',
    ),
    # 13b. A named lifetime `'r` with a trailing comment stays equivalent to the
    # comment-free form (the label is munched, not treated as a literal opener).
    ("equiv", "let x: &'r str = y; // c", "let x: &'r str = y;"),
    # 13c. `'r` followed by a plain string keeps escape-aware plain-string
    # semantics: changing content inside that string is a real change.
    (
        "distinct",
        r'foo('
        "'"
        r'r, "a\" b");',
        r'foo('
        "'"
        r'r, "a\" c");',
    ),
    # 13d. Loop-label munch regression guard.
    ("equiv", "break 'outer; // c", "break 'outer;"),
    # 14. Blocker 2 — U+00A0 (NBSP) is NOT Rust whitespace (rustc rejects it), so
    # it must be treated as code and NOT collapse equal to a normal space.
    ("distinct", "fn f() { }", "fn f() {" + chr(0xA0) + "}"),
    # 14b. CRLF normalization reaches doc comments too: a `///` line no longer
    # keeps a trailing '\r', so a CRLF doc-commented file matches its LF twin.
    ("equiv", "/// a\r\nfn f() {}\r\n", "/// a\nfn f() {}\n"),
]


def _self_test() -> int:
    failures = 0
    for idx, case in enumerate(_CASES, 1):
        kind = case[0]
        try:
            if kind == "eq":
                _, inp, exp = case
                got = canon(inp)
                ok = got == exp
                detail = "" if ok else f"got {got!r} != exp {exp!r}"
            elif kind == "equiv":
                _, a, b = case
                ok = canon(a) == canon(b)
                detail = "" if ok else f"canon(a)={canon(a)!r} != canon(b)={canon(b)!r}"
            elif kind == "distinct":
                _, a, b = case
                ok = canon(a) != canon(b)
                detail = "" if ok else f"both canon to {canon(a)!r}"
            elif kind == "anomaly":
                _, inp = case
                try:
                    canon(inp)
                    ok = False
                    detail = "expected Anomaly, none raised"
                except Anomaly:
                    ok = True
                    detail = ""
            elif kind == "ok":
                _, inp = case
                canon(inp)
                ok = True
                detail = ""
            else:
                ok = False
                detail = f"unknown case kind {kind!r}"
        except Anomaly as e:
            ok = False
            detail = f"unexpected Anomaly: {e}"
        status = "PASS" if ok else "FAIL"
        if not ok:
            failures += 1
        print(f"[{status}] case {idx} ({kind}) {detail}".rstrip())
    print(f"{len(_CASES) - failures}/{len(_CASES)} passed")
    return 0 if failures == 0 else 1


def main(argv) -> int:
    if len(argv) > 1 and argv[1] == "--self-test":
        return _self_test()
    if len(argv) > 1:
        print(f"unknown argument: {argv[1]}", file=sys.stderr)
        return 2
    raw = sys.stdin.buffer.read()
    try:
        src = raw.decode("utf-8")
    except UnicodeDecodeError as e:
        print(f"UTF-8 decode error: {e}", file=sys.stderr)
        return 2
    try:
        result = canon(src)
    except Anomaly as e:
        print(f"lexical anomaly: {e}", file=sys.stderr)
        return 2
    # Write UTF-8 bytes directly: the canonical form may contain non-ASCII (doc
    # comments, string literals), and Windows' default console encoding (cp1252)
    # would otherwise crash on it. The bytes are only ever byte-compared against
    # another run of this script, so encoding must be fixed, not locale-dependent.
    sys.stdout.buffer.write(result.encode("utf-8"))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
