//! Allow only the app's own origin (plus devUrl in dev), because a foreign
//! top-level page would inherit the app's IPC.
//!
//! Out of reach: tauri-runtime-wry allows URL strings that fail to parse before
//! this hook runs. `window.open` uses a separate new-window path, denied by wry
//! when no new-window handler is set. Production allows only the custom-protocol
//! origin, so a `build.frontendDist` URL would be refused on its first load.
//!
//! The hook also fires for subframes on macOS/Linux, but only the main frame on
//! Windows: a future foreign-origin iframe is refused on macOS/Linux only.
//! The CSP step must account for that platform difference.

use std::io::Write;

use tauri::{Manager, Url};

pub(crate) fn init<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("nav-guard")
        // Tauri holds its plugin-store lock on the UI thread here: keep this
        // lock-free and non-blocking, and never re-enter plugins.
        .on_navigation(|webview, url| {
            let config = webview.config();
            // This lookup covers config-declared windows only: a Rust-built
            // window with use_https_scheme(true) would derive http and be refused.
            let use_https = config
                .app
                .windows
                .iter()
                .find(|w| w.label == webview.label())
                .is_some_and(|w| w.use_https_scheme);
            let app = app_origin(cfg!(any(windows, target_os = "android")), use_https);
            let dev = dev_origin(tauri::is_dev(), config.build.dev_url.as_ref());
            if is_allowed_navigation(url, &app, dev) {
                true
            } else {
                // A failed write (a closed stderr pipe) must never panic in this callback.
                let _ = writeln!(
                    std::io::stderr().lock(),
                    "gitdesktop: nav-guard blocked {}",
                    log_form(url)
                );
                false
            }
        })
        .build()
}

fn app_origin(http_host_form: bool, use_https: bool) -> Url {
    let origin = if http_host_form {
        if use_https {
            "https://tauri.localhost/"
        } else {
            "http://tauri.localhost/"
        }
    } else {
        "tauri://localhost/"
    };
    Url::parse(origin).expect("static origin parses")
}

/// The dev server origin, admitted only under `is_dev()`. Gated on is_dev(), not
/// debug_assertions: tauri build --debug serves the production origin and must not
/// admit the dev server.
fn dev_origin(is_dev: bool, dev_url: Option<&Url>) -> Option<&Url> {
    dev_url.filter(|_| is_dev)
}

fn same_origin(a: &Url, b: &Url) -> bool {
    // Compare scheme, host and port explicitly: Url::origin() is opaque for
    // tauri://, and string prefixes admit hostile hosts.
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

fn is_allowed_navigation(url: &Url, app_origin: &Url, dev_url: Option<&Url>) -> bool {
    same_origin(url, app_origin) || dev_url.is_some_and(|d| same_origin(url, d))
}

fn log_form(url: &Url) -> String {
    // Path, query, fragment and userinfo can carry tokens (reset or magic links):
    // only scheme, host and port reach stderr, as `scheme://host[:port]/`. An
    // opaque URL's path is its whole payload (data:, javascript:): scheme only.
    if url.cannot_be_a_base() {
        return format!("{}:", url.scheme());
    }
    let mut url = url.clone();
    url.set_path("/");
    url.set_query(None);
    url.set_fragment(None);
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const WIN: (bool, bool) = (true, false);
    const WIN_S: (bool, bool) = (true, true);
    const UNIX: (bool, bool) = (false, false);
    const D1420: Option<&str> = Some("http://localhost:1420/");
    const D1430: Option<&str> = Some("http://localhost:1430/");
    type NavigationCase = (&'static str, (bool, bool), Option<&'static str>);

    #[test]
    fn app_origin_matches_platform_and_https() {
        const CASES: &[((bool, bool), &str)] = &[
            (WIN, "http://tauri.localhost/"),
            (WIN_S, "https://tauri.localhost/"),
            (UNIX, "tauri://localhost/"),
            ((false, true), "tauri://localhost/"),
        ];
        for &(params, expected) in CASES {
            assert_eq!(
                app_origin(params.0, params.1).as_str(),
                expected,
                "{params:?}"
            );
        }
    }

    #[test]
    fn allows_app_and_configured_dev_origins() {
        const CASES: &[NavigationCase] = &[
            ("http://tauri.localhost/", WIN, None),
            ("http://tauri.localhost/index.html?x=1#frag", WIN, None),
            ("http://tauri.localhost:80/", WIN, None),
            ("http://user@tauri.localhost/", WIN, None),
            ("https://tauri.localhost/", WIN_S, None),
            ("tauri://localhost/", UNIX, None),
            ("tauri://localhost/some/path#x", UNIX, None),
            ("http://localhost:1420/", WIN, D1420),
            ("http://localhost:1420/src/main.tsx?t=1#x", UNIX, D1420),
            ("http://localhost:1430/", WIN, D1430),
            ("http://tauri.localhost/", WIN, D1420),
            ("HTTP://TAURI.LOCALHOST/", WIN, None),
            ("http://tauri%2Elocalhost/", WIN, None),
            ("https://tauri.localhost:443/", WIN_S, None),
        ];
        for &(input, params, dev) in CASES {
            let url = Url::parse(input).unwrap();
            let app = app_origin(params.0, params.1);
            let dev_url = dev.map(|d| Url::parse(d).unwrap());
            assert!(
                is_allowed_navigation(&url, &app, dev_url.as_ref()),
                "allow row: {input}, app={app}, dev={dev:?}"
            );
        }
    }

    #[test]
    fn denies_other_origins() {
        const CASES: &[NavigationCase] = &[
            ("http://localhost:1420/", WIN, None),
            ("http://localhost:1420/", UNIX, None),
            ("http://localhost:1420/", WIN, D1430),
            ("http://localhost:1421/", WIN, D1420),
            ("http://localhost/", WIN, D1420),
            ("http://127.0.0.1:1420/", WIN, D1420),
            ("https://localhost:1420/", WIN, D1420),
            ("http://localhost.evil.com:1420/", WIN, D1420),
            ("http://localhost:1420@evil.com/", WIN, D1420),
            ("http://tauri.localhost@evil.com/", WIN, None),
            ("http://tauri.localhost.evil.com/", WIN, None),
            ("http://tauri.localhost:8080/", WIN, None),
            ("https://tauri.localhost/", WIN, None),
            ("http://tauri.localhost/", WIN_S, None),
            ("tauri://localhost/", WIN, None),
            ("http://tauri.localhost/", UNIX, None),
            ("tauri://evil/", UNIX, None),
            ("tauri://localhost:9/", UNIX, None),
            ("https://example.com/", WIN, D1420),
            ("file:///C:/Windows/", UNIX, D1420),
            ("data:text/html,x", WIN, None),
            ("about:blank", UNIX, None),
            ("javascript:alert(1)", WIN, D1420),
            ("http://localhost.:1420/", WIN, D1420),
            ("http://tauri.localhost./", WIN, None),
            ("http://[::1]:1420/", WIN, D1420),
            ("tauri://LOCALHOST/", UNIX, None),
            ("tauri://local%68ost/", UNIX, None),
            ("blob:http://tauri.localhost/x", WIN, None),
        ];
        for &(input, params, dev) in CASES {
            let url = Url::parse(input).unwrap();
            let app = app_origin(params.0, params.1);
            let dev_url = dev.map(|d| Url::parse(d).unwrap());
            assert!(
                !is_allowed_navigation(&url, &app, dev_url.as_ref()),
                "deny row: {input}, app={app}, dev={dev:?}"
            );
        }
    }

    #[test]
    fn dev_origin_admits_the_dev_url_only_under_is_dev() {
        let dev_url = Url::parse(D1420.unwrap()).unwrap();
        let app = app_origin(WIN.0, WIN.1);
        assert_eq!(dev_origin(true, Some(&dev_url)), Some(&dev_url));
        assert_eq!(dev_origin(true, None), None);
        assert_eq!(dev_origin(false, None), None);
        // A non-dev build (tauri build --debug included) refuses the dev server.
        let dev = dev_origin(false, Some(&dev_url));
        assert_eq!(dev, None);
        assert!(!is_allowed_navigation(&dev_url, &app, dev));
        assert!(is_allowed_navigation(
            &dev_url,
            &app,
            dev_origin(true, Some(&dev_url))
        ));
    }

    #[test]
    fn invalid_port_cannot_reach_hook() {
        let input = "http://localhost:1420.evil.com/";
        assert!(Url::parse(input).is_err(), "parse-premise row: {input}");
    }

    #[test]
    fn log_form_keeps_only_scheme_host_and_port() {
        const CASES: &[(&str, &str)] = &[
            (
                "https://evil.example/cb?code=abc123#x",
                "https://evil.example/",
            ),
            (
                "https://u:p@evil.example:8443/a/b?x=1",
                "https://evil.example:8443/",
            ),
            ("https://example.com/", "https://example.com/"),
            ("https://example.com", "https://example.com/"),
            (
                "https://example.com/reset/tok_abc123/confirm",
                "https://example.com/",
            ),
            (
                "https://example.com/magic%2Flink%3Ftok%3Dabc",
                "https://example.com/",
            ),
            ("http://[::1]:1420/login/abc123", "http://[::1]:1420/"),
            ("https://example.com:443/x", "https://example.com/"),
            ("file:///C:/Users/me/secret.txt", "file:///"),
            ("file://server/share/secret.txt", "file://server/"),
            ("data:text/html,x#f", "data:"),
            ("javascript:alert(document.cookie)", "javascript:"),
        ];
        for &(input, expected) in CASES {
            assert_eq!(
                log_form(&Url::parse(input).unwrap()),
                expected,
                "log row: {input}"
            );
        }
    }
}
