//! Static serving of the embedded companion frontend bundle for the LAN server.
//!
//! The phone UI is a hash-routed SPA built by the sibling `pnpm build:companion`
//! into `src-tauri/companion-dist/`, which [`rust_embed`] bakes into the binary.
//! Two routes serve it — `GET /` → `index.html`, `GET /assets/{*path}` → an asset
//! — and BOTH sit OUTSIDE the bearer-auth subtree (the pairing page must load
//! unauthenticated) but INSIDE the outer [`crate::lan::auth::host_guard`], so the
//! DNS-rebind defense and the hardening headers still apply.
//!
//! Because the app is hash-routed (`/#pair`, `/#…`), there is NO history-API
//! fallback: unknown asset paths 404 rather than re-serving `index.html`.
//!
//! ## Dev loop
//!
//! In DEBUG builds `rust-embed` reads `companion-dist/` from disk at request time,
//! so a fresh `pnpm build:companion` is picked up WITHOUT recompiling the Rust
//! side. RELEASE builds bake the files into the binary at compile time.
//!
//! ## CI / not-yet-built state
//!
//! CI never runs the frontend build, so the embed folder holds only `.gitkeep` and
//! there is no `index.html`. In that case `/` returns a 503 whose body carries the
//! literal marker `companion bundle not built` plus a hint — tests key on that
//! marker, and a developer who forgot the build sees an actionable message.
//!
//! ## Page CSP
//!
//! HTML/asset responses carry a fuller [`PAGE_CSP`] (self-only scripts/styles;
//! `connect-src 'self'` covers same-origin fetch/SSE/WebSockets; framing locked
//! down). The outer
//! [`crate::lan::auth::harden_headers`] is insert-if-absent for the CSP, so this
//! page CSP survives while API responses keep their bare one.

use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};

use rust_embed::RustEmbed;

/// The embedded companion bundle. `#[folder]` is resolved relative to
/// `CARGO_MANIFEST_DIR` (`src-tauri/`), so `companion-dist/` is the build output the
/// sibling frontend package's vite build writes. Debug builds read it from disk at
/// runtime (the dev loop); release builds bake it in.
#[derive(RustEmbed)]
#[folder = "companion-dist/"]
struct Companion;

/// The page Content-Security-Policy stamped on served HTML/asset responses. Locks
/// scripts/styles to self, allows `data:` images, and denies framing / external
/// base & form targets. `connect-src 'self'` covers same-origin fetch, SSE, AND
/// same-origin WebSockets in modern browsers — a bare `ws:` scheme-source would
/// permit sockets to ANY host, so it is deliberately absent.
pub const PAGE_CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/// The 503 body shown when the companion bundle hasn't been built (CI, or a dev who
/// skipped `pnpm build:companion`). Carries the literal `companion bundle not built`
/// marker tests assert on, plus an actionable hint.
const NOT_BUILT_HTML: &str = "<!doctype html><html><head><meta charset=\"utf-8\"><title>Companion not built</title></head><body><h1>companion bundle not built</h1><p>Run <code>pnpm build:companion</code> to build the phone-companion frontend, then reload.</p></body></html>";

/// `Cache-Control` for `index.html`: `no-cache` = the browser may store it but MUST
/// revalidate every load. The entry document is NOT content-hashed, so a
/// heuristically-cached stale `index.html` would keep referencing hashed asset
/// filenames the NEXT build deletes → a white page. Revalidating every load avoids that.
const INDEX_CACHE_CONTROL: &str = "no-cache";

/// `Cache-Control` for `/assets/*`: `public, max-age=31536000, immutable` — safe to
/// cache for a year and never revalidate, because vite emits content-HASHED asset
/// filenames (a changed file gets a new name, so the URL itself busts the cache).
const ASSET_CACHE_CONTROL: &str = "public, max-age=31536000, immutable";

/// `GET /` → the embedded `index.html`. When the bundle hasn't been built the embed
/// has no `index.html`, so we return a 503 carrying the `companion bundle not built`
/// marker instead of a bare 404.
pub async fn index() -> Response {
    match Companion::get("index.html") {
        Some(file) => embedded_response(file, INDEX_CACHE_CONTROL),
        None => not_built_response(),
    }
}

/// `GET /assets/{*path}` → the embedded asset under `assets/<path>`. An unknown
/// asset path 404s (no SPA fallback — the app is hash-routed).
pub async fn asset(axum::extract::Path(path): axum::extract::Path<String>) -> Response {
    let full = format!("assets/{path}");
    match Companion::get(&full) {
        Some(file) => embedded_response(file, ASSET_CACHE_CONTROL),
        None => not_found_response(),
    }
}

/// Build a 200 response for an embedded file: its bytes, the mime-guessed
/// Content-Type, the given `Cache-Control`, and the page CSP (which survives the
/// insert-if-absent hardening middleware).
fn embedded_response(file: rust_embed::EmbeddedFile, cache_control: &'static str) -> Response {
    let mime = file.metadata.mimetype();
    let mut resp = (StatusCode::OK, file.data.into_owned()).into_response();
    let headers = resp.headers_mut();
    if let Ok(ct) = HeaderValue::from_str(mime) {
        headers.insert(header::CONTENT_TYPE, ct);
    }
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(cache_control),
    );
    stamp_page_csp(headers);
    resp
}

/// The 503 "not built" page (with the marker), carrying the page CSP.
fn not_built_response() -> Response {
    let mut resp = (
        StatusCode::SERVICE_UNAVAILABLE,
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        NOT_BUILT_HTML,
    )
        .into_response();
    stamp_page_csp(resp.headers_mut());
    resp
}

/// A plain 404 for an unknown asset path (matches the router's unknown-route 404).
fn not_found_response() -> Response {
    StatusCode::NOT_FOUND.into_response()
}

/// Whether the companion bundle is embedded (has an `index.html`). In DEBUG builds
/// this reflects the on-disk `companion-dist/` folder at call time, so it's `false`
/// in CI (empty dir) and `true` after `pnpm build:companion`. Test-only: tests
/// branch on the actual embed state rather than assuming one — the served response
/// differs between the two, and both must be asserted correctly. (Gated to
/// `cfg(test)` so it isn't dead code in the non-test lib build.)
#[cfg(test)]
pub(crate) fn bundle_present() -> bool {
    Companion::get("index.html").is_some()
}

/// Set the page CSP on a header map. This runs BEFORE the outer hardening
/// middleware, which is insert-if-absent for the CSP — so this value is what
/// survives on the response (the middleware won't overwrite it with the bare one).
fn stamp_page_csp(headers: &mut axum::http::HeaderMap) {
    headers.insert(
        "Content-Security-Policy",
        HeaderValue::from_static(PAGE_CSP),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn index_serves_bundle_or_reports_not_built() {
        // DEBUG rust-embed reads `companion-dist/` from disk at call time, so this
        // must be green in BOTH states: CI's empty dir (503 + marker) and a dev
        // machine after `pnpm build:companion` (200 + the real index.html). Branch
        // on the actual embed state. The page CSP applies to BOTH responses.
        let resp = index().await;
        assert_eq!(
            resp.headers().get("Content-Security-Policy").unwrap(),
            PAGE_CSP
        );
        if bundle_present() {
            // Bundle built → the real index.html, served as HTML with `no-cache`
            // (the entry document must revalidate every load — see INDEX_CACHE_CONTROL).
            assert_eq!(resp.status(), StatusCode::OK);
            let ct = resp
                .headers()
                .get(header::CONTENT_TYPE)
                .unwrap()
                .to_str()
                .unwrap();
            assert!(ct.starts_with("text/html"), "index Content-Type: {ct}");
            assert_eq!(
                resp.headers().get(header::CACHE_CONTROL).unwrap(),
                INDEX_CACHE_CONTROL
            );
        } else {
            // Bundle absent (CI) → 503 with the marker.
            assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
            let bytes = axum::body::to_bytes(resp.into_body(), 64 * 1024)
                .await
                .unwrap();
            let body = String::from_utf8_lossy(&bytes);
            assert!(
                body.contains("companion bundle not built"),
                "503 body must carry the marker: {body}"
            );
        }
    }

    #[tokio::test]
    async fn served_asset_carries_immutable_cache_control() {
        // Asset filenames are content-hashed, so we can't hardcode one — discover a
        // real embedded asset (present only after `pnpm build:companion`; skip in CI's
        // empty-dir state). A served asset must carry the year-long immutable
        // Cache-Control (the hashed name self-busts).
        let Some(rel) = first_asset_rel_path() else {
            return; // no bundle built (CI) — nothing to serve; the index test covers absent state
        };
        let resp = asset(axum::extract::Path(rel)).await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers().get(header::CACHE_CONTROL).unwrap(),
            ASSET_CACHE_CONTROL
        );
    }

    #[tokio::test]
    async fn unknown_asset_is_404() {
        let resp = asset(axum::extract::Path("nope.js".to_string())).await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    /// The `assets/`-relative path of the first embedded asset, or `None` when the
    /// bundle isn't built (CI). Used to exercise the asset handler with a real,
    /// content-hashed filename we can't hardcode.
    fn first_asset_rel_path() -> Option<String> {
        Companion::iter().find_map(|p| p.strip_prefix("assets/").map(str::to_string))
    }
}
