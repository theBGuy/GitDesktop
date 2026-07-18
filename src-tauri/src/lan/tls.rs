//! Persistent self-signed TLS material for the LAN phone-companion server.
//!
//! ## Why HTTPS at all, and why self-signed
//!
//! The companion serves a phone BROWSER over the LAN, and a browser needs a
//! secure context (`https://`) for `crypto.subtle` and to avoid mixed-content
//! blocking. A self-signed certificate is the right (and only workable) fit here:
//!
//! - Phone browsers click through a self-signed interstitial once and then treat
//!   the origin as a normal secure context. (The "phones hard-reject self-signed"
//!   lore was about NATIVE companion apps pinning a CA — not Safari/Chrome, which
//!   let the user grant a per-origin exception.)
//! - Let's-Encrypt-style publicly-trusted certs can't help: an ACME IP cert is
//!   issued only for PUBLIC IPs, and the companion binds RFC1918 LAN addresses.
//! - The realtime channel is Server-Sent Events, NOT a WebSocket, precisely
//!   because iOS Safari does not extend a manually-accepted self-signed exception
//!   to `wss://` (see [`crate::lan::routes::reviews`]). SSE rides the already-
//!   excepted `https://` origin.
//!
//! ## Stability is the point (TOFU)
//!
//! The desktop shows the certificate's SHA-256 fingerprint; the user confirms it
//! matches what the phone reports the first time it connects (trust-on-first-use).
//! For that ceremony to hold, the fingerprint must stay STABLE across restarts and
//! across the churn of the machine's LAN IP (DHCP renewals, Wi-Fi ↔ Ethernet). So
//! the cert is persisted under the app-data dir and REUSED whenever its recorded
//! SAN set still covers the addresses we're about to advertise; it is regenerated
//! only when a required address is missing (with a SAN set that is the UNION of the
//! recorded and required addresses, so an A→B→A DHCP flip-flop doesn't thrash the
//! fingerprint) or when the stored files are missing/corrupt.
//!
//! Long validity is deliberate: browsers cap the lifetime of PUBLICLY-trusted
//! certificates, but a self-signed cert the user manually excepted is exempt, and a
//! long life keeps the TOFU fingerprint stable. rcgen's default validity is used.

use std::net::{IpAddr, Ipv4Addr};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use rcgen::{CertificateParams, DistinguishedName, DnType, KeyPair, SanType};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{AppError, AppResult};
use crate::local_prs::APP_IDENTIFIER;

/// The three persisted filenames under `dirs::data_dir()/<APP_IDENTIFIER>/` — the
/// same app-data root the device store ([`crate::lan::auth`]) uses.
const CERT_FILE: &str = "lan-cert.pem";
const KEY_FILE: &str = "lan-key.pem";
const META_FILE: &str = "lan-cert.json";

/// The certificate common name. Cosmetic (browsers show it in the exception UI);
/// SAN entries are what actually match.
const CERT_CN: &str = "GitDesktop LAN companion";

/// The ready-to-serve TLS material: a rustls server config (wired to serve the
/// persisted cert) and the cert's SHA-256 fingerprint for the TOFU ceremony.
pub struct TlsMaterial {
    pub config: Arc<rustls::ServerConfig>,
    /// Colon-separated UPPERCASE-hex SHA-256 of the certificate DER (95 chars,
    /// `AB:12:…`). The frozen wire format the desktop UI renders.
    pub fingerprint: String,
}

/// The sidecar metadata persisted alongside the cert so a later run can decide
/// whether the stored cert still covers the addresses it's about to advertise.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CertMeta {
    /// Every IP SAN baked into the stored cert (127.0.0.1 ∪ whatever was advertised
    /// when it was minted, accreted as a union across regenerations).
    san_ips: Vec<Ipv4Addr>,
    /// When the stored cert was generated (informational; RFC3339 millis + `Z`).
    created_at: String,
}

// --------------------------------------------------------------------------
// TLS-dir path injection (for tests) — mirrors auth.rs's device-store override
// --------------------------------------------------------------------------

/// Test-only override for the directory the cert/key/meta live in. Production
/// always resolves the real app-data dir via [`tls_dir`]; tests point this at a
/// temp dir so they never touch (or require) the real app-data folder.
static TLS_DIR_OVERRIDE: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();

fn tls_dir_override() -> &'static Mutex<Option<PathBuf>> {
    TLS_DIR_OVERRIDE.get_or_init(|| Mutex::new(None))
}

/// Point the TLS material dir at `path` for the current process (test-only).
/// Returns the previous override so a test can restore it. Hold
/// [`crate::lan::auth::store_test_lock`] across any test that sets this — the
/// override is a single process-global slot, exactly like the device store's.
#[cfg(test)]
pub(crate) fn set_tls_dir_for_test(path: Option<PathBuf>) -> Option<PathBuf> {
    let mut guard = tls_dir_override().lock().unwrap_or_else(|p| p.into_inner());
    std::mem::replace(&mut *guard, path)
}

/// Resolve the directory the cert/key/meta files live in — the app-data dir
/// `dirs::data_dir()/<APP_IDENTIFIER>/`, the same root the device store uses. A
/// test override (if set) wins.
fn tls_dir() -> AppResult<PathBuf> {
    if let Some(over) = tls_dir_override()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
    {
        return Ok(over);
    }
    let data = dirs::data_dir()
        .ok_or_else(|| AppError::Command("could not resolve the app-data directory".to_string()))?;
    Ok(data.join(APP_IDENTIFIER))
}

/// Ensure a usable self-signed cert exists for `ips` and return ready-to-serve TLS
/// material. Reuses the persisted cert when its recorded SAN set already covers the
/// required addresses (so the TOFU fingerprint survives IP churn); regenerates —
/// never errors out of enabling the server — when a required address is missing or
/// the stored files are missing/corrupt/unparseable.
pub fn ensure_tls(ips: &[Ipv4Addr]) -> AppResult<TlsMaterial> {
    let dir = tls_dir()?;
    let cert_path = dir.join(CERT_FILE);
    let key_path = dir.join(KEY_FILE);
    let meta_path = dir.join(META_FILE);

    // The SANs we REQUIRE this run: loopback plus every advertised address, deduped
    // and ordered deterministically.
    let required = required_san_ips(ips);

    // Try to reuse: all three files must load AND the recorded SANs must cover the
    // required set. Any failure (missing/corrupt/uncovered) falls through to regen.
    if let Some(material) = try_reuse(&cert_path, &key_path, &meta_path, &required) {
        return Ok(material);
    }

    // Regenerate. The new SAN set is the UNION of whatever the (possibly stale) meta
    // recorded and the required set, so a DHCP flip-flop A→B→A keeps A covered and
    // doesn't churn the fingerprint back and forth.
    let recorded = read_meta(&meta_path).map(|m| m.san_ips).unwrap_or_default();
    let san_ips = union_ips(&recorded, &required);
    generate_and_persist(&dir, &cert_path, &key_path, &meta_path, &san_ips)
}

/// The IP SANs required for `ips`: always loopback, plus every advertised IP,
/// deduped preserving order (loopback first).
fn required_san_ips(ips: &[Ipv4Addr]) -> Vec<Ipv4Addr> {
    let mut out = vec![Ipv4Addr::LOCALHOST];
    for ip in ips {
        if !out.contains(ip) {
            out.push(*ip);
        }
    }
    out
}

/// The union of two IP lists, preserving `a`'s order then appending `b`'s new
/// entries. Used so a regenerated cert never DROPS an address a prior cert covered.
fn union_ips(a: &[Ipv4Addr], b: &[Ipv4Addr]) -> Vec<Ipv4Addr> {
    let mut out: Vec<Ipv4Addr> = a.to_vec();
    for ip in b {
        if !out.contains(ip) {
            out.push(*ip);
        }
    }
    out
}

/// Attempt to load and reuse the persisted cert. Returns `Some` only when all three
/// files load, the key/cert parse into a rustls config, and the recorded SANs cover
/// every required address. Any miss returns `None` (→ regenerate).
fn try_reuse(
    cert_path: &Path,
    key_path: &Path,
    meta_path: &Path,
    required: &[Ipv4Addr],
) -> Option<TlsMaterial> {
    let meta = read_meta(meta_path)?;
    // Coverage: every required IP must already be a recorded SAN.
    if !required.iter().all(|ip| meta.san_ips.contains(ip)) {
        return None;
    }
    let cert_pem = std::fs::read(cert_path).ok()?;
    let key_pem = std::fs::read(key_path).ok()?;
    build_material(&cert_pem, &key_pem).ok()
}

/// Read + parse the meta sidecar. `None` on any error (missing/corrupt/unparseable),
/// which the callers treat as "regenerate".
fn read_meta(meta_path: &Path) -> Option<CertMeta> {
    let bytes = std::fs::read(meta_path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Generate a fresh self-signed cert covering `san_ips`, persist the cert/key/meta,
/// and return the serving material. On unix the key file is `chmod 600` (Windows
/// app-data is already user-scoped by ACL).
fn generate_and_persist(
    dir: &Path,
    cert_path: &Path,
    key_path: &Path,
    meta_path: &Path,
    san_ips: &[Ipv4Addr],
) -> AppResult<TlsMaterial> {
    std::fs::create_dir_all(dir).map_err(AppError::Io)?;

    let mut params = CertificateParams::default();
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, CERT_CN);
    params.distinguished_name = dn;
    // SANs: DNS "localhost" first, then every IP.
    params.subject_alt_names = std::iter::once(SanType::DnsName(
        "localhost"
            .to_string()
            .try_into()
            .map_err(|e| AppError::Command(format!("build localhost SAN: {e}")))?,
    ))
    .chain(san_ips.iter().map(|ip| SanType::IpAddress(IpAddr::V4(*ip))))
    .collect();

    let key_pair = KeyPair::generate()
        .map_err(|e| AppError::Command(format!("generate LAN companion key pair: {e}")))?;
    let cert = params
        .self_signed(&key_pair)
        .map_err(|e| AppError::Command(format!("self-sign LAN companion cert: {e}")))?;

    let cert_pem = cert.pem();
    let key_pem = key_pair.serialize_pem();

    // Persist before building the config — a serve failure shouldn't lose the cert,
    // and a build failure below still leaves the files for the next run to reuse.
    // The cert + meta are public, so a plain atomic write is fine; the KEY is written
    // owner-only-from-the-first-byte (see [`write_key_file`]) so no world-readable
    // window ever exists on a shared unix host.
    crate::fsops::atomic_write(cert_path, cert_pem.as_bytes())?;
    write_key_file(key_path, key_pem.as_bytes())?;
    // Belt-and-braces: also chmod the final file (a no-op on the fresh-write path
    // above, but it tightens an old world-readable key left by a prior version whose
    // reuse path we're about to hit).
    restrict_key_file_perms(key_path);
    let meta = CertMeta {
        san_ips: san_ips.to_vec(),
        created_at: now_iso(),
    };
    let meta_json = serde_json::to_string_pretty(&meta)
        .map_err(|e| AppError::Command(format!("serialize lan-cert meta: {e}")))?;
    crate::fsops::atomic_write(meta_path, meta_json.as_bytes())?;

    build_material(cert_pem.as_bytes(), key_pem.as_bytes())
}

/// Build the rustls `ServerConfig` (explicit ring provider, no client auth, single
/// cert, ALPN `h2` + `http/1.1`) and the fingerprint from PEM cert + key bytes.
fn build_material(cert_pem: &[u8], key_pem: &[u8]) -> AppResult<TlsMaterial> {
    let certs: Vec<CertificateDer<'static>> = CertificateDer::pem_slice_iter(cert_pem)
        .collect::<Result<_, _>>()
        .map_err(|e| AppError::Command(format!("parse LAN companion cert PEM: {e}")))?;
    let leaf = certs.first().ok_or_else(|| {
        AppError::Command("LAN companion cert PEM had no certificate".to_string())
    })?;
    let fingerprint = fingerprint_of(leaf);

    let key = PrivateKeyDer::from_pem_slice(key_pem)
        .map_err(|e| AppError::Command(format!("parse LAN companion key PEM: {e}")))?;

    // An EXPLICIT ring provider (not the process-global default) so future feature
    // unification in the dependency graph can't silently flip us onto a different
    // crypto backend.
    let mut config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|e| AppError::Command(format!("build LAN companion TLS config: {e}")))?
    .with_no_client_auth()
    .with_single_cert(certs, key)
    .map_err(|e| AppError::Command(format!("install LAN companion cert: {e}")))?;
    // h2 lets a phone multiplex parallel SSE + fetches over one connection.
    config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];

    Ok(TlsMaterial {
        config: Arc::new(config),
        fingerprint,
    })
}

/// The colon-separated UPPERCASE-hex SHA-256 of a certificate's DER encoding
/// (`AB:12:…`, 95 chars) — the frozen fingerprint format.
fn fingerprint_of(cert: &CertificateDer<'_>) -> String {
    let digest = Sha256::digest(cert.as_ref());
    digest
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

/// The current UTC timestamp in JS `Date.prototype.toISOString()` shape, matching
/// every other app-data timestamp we write.
fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Atomically write the private-key file with owner-only permissions from the very
/// first byte. On unix the temp file is created `mode(0o600)` BEFORE any key
/// material is written (so it never briefly inherits the umask's default, commonly
/// 0644, in the write→rename window — the shared-host key-disclosure gap), then
/// renamed over the target to preserve the atomic-rename property. On non-unix we
/// fall back to the shared [`crate::fsops::atomic_write`] (Windows app-data ACLs are
/// already user-scoped). Mirrors `atomic_write`'s temp-name scheme (pid + uuid, same
/// dir) so the rename stays same-filesystem and collision-free.
#[cfg(unix)]
fn write_key_file(key_path: &Path, contents: &[u8]) -> AppResult<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    let dir = key_path.parent().ok_or_else(|| {
        AppError::Command(format!(
            "path {} has no parent directory",
            key_path.display()
        ))
    })?;
    std::fs::create_dir_all(dir).map_err(AppError::Io)?;
    let file_name = key_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "tmp".to_string());
    let tmp = dir.join(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    // Create the temp file 0600 up front — the mode is applied at creation, so the
    // key bytes are never on disk under a looser mode.
    let write_res = (|| -> std::io::Result<()> {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)?;
        f.write_all(contents)?;
        f.sync_all()?;
        Ok(())
    })();
    if let Err(e) = write_res {
        let _ = std::fs::remove_file(&tmp);
        return Err(AppError::Io(e));
    }
    if let Err(e) = std::fs::rename(&tmp, key_path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(AppError::Io(e));
    }
    Ok(())
}

/// Non-unix: no umask, and Windows app-data is user-scoped by ACL, so a plain atomic
/// write is sufficient.
#[cfg(not(unix))]
fn write_key_file(key_path: &Path, contents: &[u8]) -> AppResult<()> {
    crate::fsops::atomic_write(key_path, contents)
}

/// Restrict the private-key file to owner-only on unix (`chmod 600`). A no-op on
/// Windows, where the app-data dir is already user-scoped by ACL.
#[cfg(unix)]
fn restrict_key_file_perms(key_path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(key_path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict_key_file_perms(_key_path: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh temp dir for a test's TLS material, unique per test invocation.
    fn temp_dir() -> PathBuf {
        std::env::temp_dir().join(format!(
            "gd-lan-tls-test-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ))
    }

    /// The frozen fingerprint format: 32 uppercase-hex byte pairs joined by colons.
    fn is_fingerprint(s: &str) -> bool {
        let parts: Vec<&str> = s.split(':').collect();
        parts.len() == 32
            && parts.iter().all(|p| {
                p.len() == 2
                    && p.chars()
                        .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_lowercase())
            })
    }

    #[test]
    fn fresh_gen_writes_files_and_valid_fingerprint() {
        let _lock = crate::lan::auth::store_test_lock();
        let dir = temp_dir();
        let prev = set_tls_dir_for_test(Some(dir.clone()));

        let material = ensure_tls(&[Ipv4Addr::new(192, 168, 1, 5)]).unwrap();

        assert!(dir.join(CERT_FILE).exists(), "cert PEM written");
        assert!(dir.join(KEY_FILE).exists(), "key PEM written");
        assert!(dir.join(META_FILE).exists(), "meta json written");
        assert!(
            is_fingerprint(&material.fingerprint),
            "fingerprint format: {}",
            material.fingerprint
        );

        set_tls_dir_for_test(prev);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn covered_ips_reuse_the_same_cert() {
        let _lock = crate::lan::auth::store_test_lock();
        let dir = temp_dir();
        let prev = set_tls_dir_for_test(Some(dir.clone()));

        let first = ensure_tls(&[Ipv4Addr::new(192, 168, 1, 5)]).unwrap();
        // A second call whose required IPs are a SUBSET of the recorded set (here the
        // same set) must reuse — same fingerprint, phones keep their exception.
        let second = ensure_tls(&[Ipv4Addr::new(192, 168, 1, 5)]).unwrap();
        assert_eq!(first.fingerprint, second.fingerprint, "covered ips reuse");
        // Loopback alone is also covered by the recorded set → still a reuse.
        let third = ensure_tls(&[]).unwrap();
        assert_eq!(first.fingerprint, third.fingerprint, "loopback-only reuses");

        set_tls_dir_for_test(prev);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn new_ip_regenerates_and_unions_sans() {
        let _lock = crate::lan::auth::store_test_lock();
        let dir = temp_dir();
        let prev = set_tls_dir_for_test(Some(dir.clone()));

        let first = ensure_tls(&[Ipv4Addr::new(192, 168, 1, 5)]).unwrap();
        // A NEW, uncovered IP forces a regen → different fingerprint.
        let second = ensure_tls(&[Ipv4Addr::new(10, 0, 0, 9)]).unwrap();
        assert_ne!(first.fingerprint, second.fingerprint, "new ip regenerates");

        // The regenerated meta's SANs are the UNION: loopback + both IPs.
        let meta = read_meta(&dir.join(META_FILE)).unwrap();
        assert!(meta.san_ips.contains(&Ipv4Addr::LOCALHOST));
        assert!(meta.san_ips.contains(&Ipv4Addr::new(192, 168, 1, 5)));
        assert!(meta.san_ips.contains(&Ipv4Addr::new(10, 0, 0, 9)));

        // And because A is still covered, going back to A reuses the union cert
        // (a DHCP A→B→A flip-flop must not churn the fingerprint).
        let third = ensure_tls(&[Ipv4Addr::new(192, 168, 1, 5)]).unwrap();
        assert_eq!(second.fingerprint, third.fingerprint, "A→B→A stays stable");

        set_tls_dir_for_test(prev);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn corrupt_cert_regenerates_instead_of_erroring() {
        let _lock = crate::lan::auth::store_test_lock();
        let dir = temp_dir();
        let prev = set_tls_dir_for_test(Some(dir.clone()));

        let _first = ensure_tls(&[Ipv4Addr::new(192, 168, 1, 5)]).unwrap();
        // Corrupt the cert PEM on disk.
        std::fs::write(dir.join(CERT_FILE), b"not a real certificate").unwrap();
        // ensure_tls must recover by regenerating (returning a valid cert), not error
        // out of enabling the server.
        let second = ensure_tls(&[Ipv4Addr::new(192, 168, 1, 5)]).unwrap();
        assert!(is_fingerprint(&second.fingerprint));
        // The regen wrote fresh, parseable files — the next call reuses them.
        let reloaded = ensure_tls(&[Ipv4Addr::new(192, 168, 1, 5)]).unwrap();
        assert_eq!(second.fingerprint, reloaded.fingerprint, "post-regen reuse");

        set_tls_dir_for_test(prev);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn fresh_key_file_is_owner_only_0600() {
        // The private key must land 0600 (owner rw only) — never briefly
        // world/group-readable in the write→rename window on a shared unix host.
        use std::os::unix::fs::PermissionsExt;
        let _lock = crate::lan::auth::store_test_lock();
        let dir = temp_dir();
        let prev = set_tls_dir_for_test(Some(dir.clone()));

        ensure_tls(&[Ipv4Addr::new(192, 168, 1, 5)]).unwrap();
        let mode = std::fs::metadata(dir.join(KEY_FILE))
            .unwrap()
            .permissions()
            .mode();
        // Compare the permission bits only (the file-type bits live above 0o777).
        assert_eq!(mode & 0o777, 0o600, "key file mode: {:o}", mode & 0o777);

        set_tls_dir_for_test(prev);
        std::fs::remove_dir_all(&dir).ok();
    }
}
