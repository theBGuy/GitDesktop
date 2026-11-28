/// A push-remote value with its login replaced by `***`, to keep a user name or password
/// written into a URL or scp-style address out of messages. The mask ends at the last `@`
/// (after a scheme, `%40` too) before the first `/` that can end the host, so it can also
/// take part of a path, of a `?` or `#` part, or of a name that holds `@` and `:`; a value
/// with no `:`, and a `X:\` drive path with no `@[`, come back as they are.
pub(crate) fn redact_url_userinfo(value: &str) -> String {
    if !value.contains(':') {
        return value.to_string();
    }
    let scheme = value.find("://").map(|i| i + 3);
    // A `X:\` value with no `@[` holds no login: git reads it as a drive path or as the
    // scp-style host `X`.
    let bytes = value.as_bytes();
    if scheme.is_none()
        && bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && bytes[2] == b'\\'
        && !value.contains("@[")
    {
        return value.to_string();
    }
    let start = scheme.unwrap_or(0);
    let host = &value[start..];
    // The search runs to the first `/`, counted from the `]` when the host starts with `[`
    // or follows `@[` (git's `host_end`): read without url-decoding, git's ssh, scp-style
    // and http readers each end the host there or sooner. After a scheme git's ssh reader
    // decodes first; of the encoded marks only `%40` is followed, as `@`.
    let open = [
        host.find("@[").map(|i| (i, i + 1)),
        scheme.and(host.find("%40[")).map(|i| (i, i + 3)),
    ]
    .into_iter()
    .flatten()
    .min()
    .map_or(0, |(_, after)| after);
    let from = host[open..]
        .strip_prefix('[')
        .and_then(|rest| rest.find(']'))
        .map_or(0, |i| open + 1 + i);
    let end = host[from..].find('/').map_or(host.len(), |i| from + i);
    let part = &host[..end];
    match part.rfind('@').max(scheme.and(part.rfind("%40"))) {
        Some(at) => format!("{}***{}", &value[..start], &host[at..]),
        None => value.to_string(),
    }
}

#[cfg(test)]
mod tests {
    /// Where the host part ends (the first `/`, counted from a bracket's `]`), which mark ends
    /// the login (the last `@`, or after a scheme a later `%40`), and what comes back
    /// untouched: a value with no `:`, a `X:\` path with no `@[`, and a host part with no
    /// login mark.
    #[test]
    fn redact_url_userinfo_masks_through_the_last_at_of_the_host_part() {
        let rows = [
            ("origin", "origin"),
            ("me@work", "me@work"),
            ("git@host:o/r.git", "***@host:o/r.git"),
            ("https://user@host/o/r", "https://***@host/o/r"),
            ("https://user:pw@host/o/r", "https://***@host/o/r"),
            ("ssh://git@h:22/r", "ssh://***@h:22/r"),
            (r"C:\repos\x.git", r"C:\repos\x.git"),
            (r"C:\d@v\r", r"C:\d@v\r"),
            ("file:///C:/r.git", "file:///C:/r.git"),
            (r"https://host/a\b@c", r"https://host/a\b@c"),
            (r"https://host\x@evil/p", "https://***@evil/p"),
            (
                r"https://user:p\w@example.invalid/o/r",
                "https://***@example.invalid/o/r",
            ),
            (
                r"CORP\jdoe@example.invalid:o/r.git",
                "***@example.invalid:o/r.git",
            ),
            (
                r"[CORP\jdoe@example.invalid]:o/r.git",
                "***@example.invalid]:o/r.git",
            ),
            ("[a:b/c@example.invalid]:p", "***@example.invalid]:p"),
            (
                "ssh://[a/b@example.invalid]/p",
                "ssh://***@example.invalid]/p",
            ),
            (
                "ssh://ho%40example.invalid/p",
                "ssh://***%40example.invalid/p",
            ),
            (
                "ssh://user@ho%40example.invalid/p",
                "ssh://***%40example.invalid/p",
            ),
            ("ssh://a@b@example.invalid/r", "ssh://***@example.invalid/r"),
            (
                "ssh://us?er@example.invalid/r",
                "ssh://***@example.invalid/r",
            ),
            (
                "https://user:pw@example.invalid/p?u=ssh://x",
                "https://***@example.invalid/p?u=ssh://x",
            ),
            ("https://user:pw@[::1]:8080/r", "https://***@[::1]:8080/r"),
            ("https::user:pw@example.invalid/r", "***@example.invalid/r"),
            ("u:pw@example.invalid/r", "***@example.invalid/r"),
            ("://", "://"),
            ("https://user@", "https://***@"),
            ("x:@[", "***@["),
            (r"C:\u@[example.invalid]:p", "***@[example.invalid]:p"),
            (
                "ssh://user%40[x/y@example.invalid]/p",
                "ssh://***@example.invalid]/p",
            ),
            (
                "ssh://u@h/x@[example.invalid]/z",
                "ssh://***@[example.invalid]/z",
            ),
            (
                "ssh://ho%40x%40example.invalid/p",
                "ssh://***%40example.invalid/p",
            ),
        ];
        let wrong: Vec<String> = rows
            .iter()
            .filter_map(|(value, want)| {
                let got = super::redact_url_userinfo(value);
                (got != *want).then(|| format!("{value}: {got}"))
            })
            .collect();
        assert!(wrong.is_empty(), "{wrong:#?}");
    }
}
