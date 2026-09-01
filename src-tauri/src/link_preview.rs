//! Open Graph previews for links in third-party text (PR and issue bodies), for the
//! frontend's hover card. The URL comes from content the user did not write, so this
//! is a hardened surface: no credentials, no cookies, every redirect hop re-validated
//! against a private-network blocklist, a 3-hop redirect cap, and a 512 KiB body cap
//! parsed by a bounded hand-rolled scan rather than a full HTML parser.
//!
//! The `og:image` is fetched HERE, through the same client and the same per-hop
//! validation, and crosses IPC as a `data:` URI rather than a URL. Handing the webview
//! a URL is not enough: `<img>` follows redirects with no validation of its own, so a
//! page could point its `og:image` at a host that passes the blocklist and 302 the
//! webview into the user's LAN. Delivering bytes means the webview issues no
//! third-party request at all, which also closes that redirect gap and the `Referer`
//! leak, and leaves no DNS-rebinding window for images.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::OnceLock;
use std::time::Duration;

use tauri_plugin_http::reqwest::{header, redirect, Client, Response, Url};

use crate::error::{AppError, AppResult};

/// An unreachable host must fail fast, and a hover preview that outlives the hover is
/// wasted work — both budgets are far tighter than the forge clients'.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// A hostile authoritative nameserver can stall `getaddrinfo` for the resolver's own
/// timeout (~30s), once per hop, so the wait is bounded here; [`PREVIEW_DEADLINE`]
/// then bounds the page half and [`IMAGE_DEADLINE`] the image step, so hops cannot
/// stack their budgets past those two ceilings.
const DNS_TIMEOUT: Duration = Duration::from_secs(5);
const PREVIEW_DEADLINE: Duration = Duration::from_secs(15);

/// The image's own best-effort budget, outside [`PREVIEW_DEADLINE`]. Deliberately tight —
/// below its own constituent timeouts ([`DNS_TIMEOUT`] alone can consume it): exceeding
/// it costs the card its picture, never its text.
const IMAGE_DEADLINE: Duration = Duration::from_secs(5);

/// Redirects followed manually (see [`next_hop`]); the 4th is an error.
const MAX_REDIRECTS: usize = 3;

/// How much response body is read before parsing stops. Metadata lives in `<head>`,
/// so this is generous, and the cap is what keeps a hostile page from exhausting memory.
const MAX_BODY_BYTES: usize = 512 * 1024;

/// Ceiling on a proxied `og:image`. Over it the image is dropped rather than cut: a
/// truncated image is a corrupt one, and the encoded copy also has to cross IPC.
const MAX_IMAGE_BYTES: usize = 2 * 1024 * 1024;

/// Ceilings on the raster an image DECLARES, read from its header before the bytes reach
/// the webview: [`MAX_IMAGE_BYTES`] bounds the compressed copy and says nothing about the
/// decoded one, and a few KB of PNG can declare a raster that kills the renderer.
const MAX_IMAGE_DIMENSION: u32 = 8192;
/// The area ceiling, which bites where the per-axis one does not: comfortably above any
/// real og image (those run ~2 MP) and far below decompression-bomb territory.
const MAX_IMAGE_PIXELS: u64 = 40_000_000;

/// How far [`tag_end`] scans for a tag's `>`, and how many `<meta` occurrences are
/// examined at all. Together they bound the harvest at ~4 MB of scanning whatever the
/// body contains: the window alone is not enough, because a document ending in a single
/// `>` makes every earlier occurrence scan its full window. Real pages sit orders of
/// magnitude under both.
const MAX_TAG_BYTES: usize = 4 * 1024;
const MAX_META_TAGS: usize = 1024;

const MAX_TITLE_CHARS: usize = 300;
const MAX_DESCRIPTION_CHARS: usize = 500;
/// The conventional URL ceiling. An over-long image URL is dropped rather than cut —
/// a truncated URL is a different URL, and would be a request to somewhere else.
const MAX_IMAGE_URL_CHARS: usize = 2048;

/// The Open Graph summary a hover card renders. Every field is optional: a page with
/// no metadata is a valid answer, not an error.
///
/// `image_data` is a complete `data:<content-type>;base64,<payload>` URI, not a URL —
/// see the module doc for why the bytes travel instead of a link.
#[derive(Debug, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkPreview {
    pub title: Option<String>,
    pub description: Option<String>,
    pub image_data: Option<String>,
}

/// What the HTML scan produced. Separate from [`LinkPreview`] because its image is
/// still a URL at this stage — the type the frontend receives can only ever hold the
/// fetched bytes, so the two states cannot be confused.
#[derive(Debug, Default, PartialEq, Eq)]
struct ParsedPreview {
    title: Option<String>,
    description: Option<String>,
    image_url: Option<String>,
}

/// The preview client, deliberately separate from [`crate::forge::http`]'s: it sends no
/// credentials and installs no cookie store, and its redirect policy is NONE so no hop
/// can be requested before [`guard_hop`] has cleared it. `None` when the TLS backend is
/// unavailable — never falls back to `Client::new()`, whose default policy would follow
/// redirects past that check.
static CLIENT: OnceLock<Option<Client>> = OnceLock::new();

fn client() -> AppResult<&'static Client> {
    CLIENT
        .get_or_init(|| {
            Client::builder()
                .user_agent(concat!("GitDesktop/", env!("CARGO_PKG_VERSION")))
                .connect_timeout(CONNECT_TIMEOUT)
                .timeout(REQUEST_TIMEOUT)
                .redirect(redirect::Policy::none())
                .build()
                .ok()
        })
        .as_ref()
        .ok_or_else(|| AppError::Command("link preview: HTTP client unavailable".into()))
}

// ---------------------------------------------------------------------------
// Address blocklist
// ---------------------------------------------------------------------------

/// Whether `ip` is anything other than a publicly routable address. Hand-rolled
/// because `IpAddr::is_global` is nightly-only, and deliberately over-broad: a hovered
/// link must never become a probe of the user's own network.
fn ip_is_blocked(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => ipv4_is_blocked(v4),
        IpAddr::V6(v6) => ipv6_is_blocked(v6),
    }
}

fn ipv4_is_blocked(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    ip.is_loopback()            // 127.0.0.0/8
        || ip.is_private()      // 10/8, 172.16/12, 192.168/16
        || ip.is_link_local()   // 169.254.0.0/16
        || ip.is_unspecified()  // 0.0.0.0
        || ip.is_broadcast()    // 255.255.255.255
        || ip.is_multicast()    // 224.0.0.0/4
        // 100.64.0.0/10 — carrier-grade NAT, routable inside an ISP but never public.
        || (octets[0] == 100 && (64..128).contains(&octets[1]))
}

/// The IPv4 address an IPv6 address carries, for every form that reaches a v4 network.
/// Judging these as ordinary v6 addresses would wave the embedded target straight
/// through the v4 arms, so each is unwrapped and re-checked.
fn embedded_ipv4(ip: Ipv6Addr) -> Option<Ipv4Addr> {
    let seg = ip.segments();
    let from_halves = |hi: u16, lo: u16| Ipv4Addr::from(((hi as u32) << 16) | lo as u32);
    // ::ffff:a.b.c.d — IPv4-mapped.
    if let Some(v4) = ip.to_ipv4_mapped() {
        return Some(v4);
    }
    // ::a.b.c.d — IPv4-compatible: deprecated, but still translated by some stacks.
    // `::` and `::1` are their own arms below, not embeddings.
    if seg[..6] == [0, 0, 0, 0, 0, 0] && !(seg[6] == 0 && seg[7] <= 1) {
        return Some(from_halves(seg[6], seg[7]));
    }
    // 64:ff9b::/96 — the NAT64 well-known prefix.
    if seg[0] == 0x0064 && seg[1] == 0xff9b && seg[2..6] == [0, 0, 0, 0] {
        return Some(from_halves(seg[6], seg[7]));
    }
    // 2002:a.b.c.d::/48 — 6to4 carries its v4 endpoint in the second and third groups.
    if seg[0] == 0x2002 {
        return Some(from_halves(seg[1], seg[2]));
    }
    None
}

fn ipv6_is_blocked(ip: Ipv6Addr) -> bool {
    if let Some(v4) = embedded_ipv4(ip) {
        return ipv4_is_blocked(v4);
    }
    let first = ip.segments()[0];
    ip.is_loopback()                  // ::1
        || ip.is_unspecified()        // ::
        || ip.is_multicast()          // ff00::/8
        || (first & 0xfe00) == 0xfc00 // fc00::/7 unique-local
        || (first & 0xffc0) == 0xfe80 // fe80::/10 link-local
        || (first & 0xffc0) == 0xfec0 // fec0::/10 deprecated site-local
}

// ---------------------------------------------------------------------------
// Per-hop validation
// ---------------------------------------------------------------------------

/// What a validated URL still needs before it can be requested.
#[derive(Debug, PartialEq, Eq)]
enum FetchTarget {
    /// The host is an IP literal that already cleared [`ip_is_blocked`].
    Literal,
    /// The host is a name; every address it resolves to must clear the blocklist too.
    Resolve { host: String, port: u16 },
}

fn blocked(host: &str) -> AppError {
    AppError::InvalidArgument(format!("link preview refused: {host} is not a public host"))
}

/// Validate one hop's URL — scheme, host presence, and the name/IP blocklist — before
/// it is requested. Pure: DNS is the caller's half (see [`guard_hop`]).
fn validate_url(url: &Url) -> AppResult<FetchTarget> {
    let scheme = url.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(AppError::InvalidArgument(format!(
            "link preview supports http and https only, not {scheme}"
        )));
    }
    let host = url
        .host_str()
        .filter(|h| !h.is_empty())
        .ok_or_else(|| AppError::InvalidArgument("link preview: URL has no host".into()))?;
    // `host_str` brackets IPv6 literals; strip them before parsing.
    let bare = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host);
    if let Ok(ip) = bare.parse::<IpAddr>() {
        return if ip_is_blocked(ip) {
            Err(blocked(host))
        } else {
            Ok(FetchTarget::Literal)
        };
    }
    let lower = host.to_ascii_lowercase();
    // The trailing root dot resolves identically, so it is stripped before matching.
    let name = lower.trim_end_matches('.');
    if name == "localhost" || name.ends_with(".localhost") || name.ends_with(".local") {
        return Err(blocked(host));
    }
    // `port()` is `None` exactly when the URL uses the scheme's default, which the
    // scheme check above has already narrowed to these two.
    let port = url
        .port()
        .unwrap_or(if scheme == "https" { 443 } else { 80 });
    Ok(FetchTarget::Resolve { host: lower, port })
}

/// Clear one hop for fetching: [`validate_url`], then DNS when the host is a name. Used
/// for the page's hops and for the proxied `og:image` fetch.
///
/// Accepted residual: reqwest re-resolves the name when it connects afterwards, so a
/// DNS-rebinding TOCTOU between this check and that connection remains open. Tolerable
/// for a hover preview in a desktop app, where the attacker already needs the user to
/// hover a link they control.
async fn guard_hop(url: &Url) -> AppResult<()> {
    let (host, port) = match validate_url(url)? {
        FetchTarget::Literal => return Ok(()),
        FetchTarget::Resolve { host, port } => (host, port),
    };
    // The timeout bounds OUR wait, not the OS resolver's thread: tokio runs the blocking
    // `getaddrinfo` on its blocking pool, and that task runs on to its own completion.
    let addrs = tokio::time::timeout(DNS_TIMEOUT, tokio::net::lookup_host((host.as_str(), port)))
        .await
        .map_err(|_| AppError::Command(format!("link preview: DNS timed out for {host}")))?
        .map_err(|_| AppError::Command(format!("link preview: could not resolve {host}")))?;
    let mut resolved_any = false;
    for addr in addrs {
        resolved_any = true;
        if ip_is_blocked(addr.ip()) {
            return Err(blocked(&host));
        }
    }
    if !resolved_any {
        return Err(AppError::Command(format!(
            "link preview: could not resolve {host}"
        )));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Redirect loop
// ---------------------------------------------------------------------------

/// Decide one step of the redirect loop from a hop's status and `Location`: `Ok(None)`
/// for a terminal status, `Ok(Some(next))` for the hop to take, `Err` past the cap or
/// on an unusable `Location`. Pure, so hop counting and `Location` resolution are
/// testable without a server.
fn next_hop(
    current: &Url,
    status: u16,
    location: Option<&str>,
    hops_taken: usize,
) -> AppResult<Option<Url>> {
    if !matches!(status, 301 | 302 | 303 | 307 | 308) {
        return Ok(None);
    }
    if hops_taken >= MAX_REDIRECTS {
        return Err(AppError::Command("link preview: too many redirects".into()));
    }
    let location = location
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .ok_or_else(|| {
            AppError::Command(format!("link preview: HTTP {status} without a Location"))
        })?;
    // Relative and protocol-relative Locations are both real, so joining against the
    // URL that produced the redirect is the only correct resolution.
    let next = current
        .join(location)
        .map_err(|_| AppError::Command("link preview: redirect target is not a URL".into()))?;
    Ok(Some(next))
}

/// Accumulates a response body under a byte cap. One byte past `cap` is read so a body
/// sitting exactly ON the cap is distinguishable from one exceeding it — the page path
/// parses a truncated body, but an oversized image has to be dropped. Split from the
/// async read so tests drive the same accumulator the reader does.
struct CappedBody {
    buf: Vec<u8>,
    cap: usize,
}

impl CappedBody {
    fn new(cap: usize) -> Self {
        Self {
            buf: Vec::new(),
            cap,
        }
    }

    /// `false` once enough has been read that no further chunk can change the outcome.
    fn push(&mut self, chunk: &[u8]) -> bool {
        let room = self.cap.saturating_add(1) - self.buf.len();
        if chunk.len() >= room {
            self.buf.extend_from_slice(&chunk[..room]);
            return false;
        }
        self.buf.extend_from_slice(chunk);
        true
    }

    /// The bytes trimmed to `cap`, plus whether the source ran past it.
    fn finish(mut self) -> (Vec<u8>, bool) {
        let over_cap = self.buf.len() > self.cap;
        self.buf.truncate(self.cap);
        (self.buf, over_cap)
    }
}

/// Read at most `cap` bytes of the body, chunk by chunk — `.text()` on an
/// attacker-chosen response would be unbounded.
async fn read_body_capped(mut resp: Response, cap: usize) -> AppResult<(Vec<u8>, bool)> {
    let mut body = CappedBody::new(cap);
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| AppError::Command(format!("link preview: could not read response: {e}")))?
    {
        if !body.push(&chunk) {
            break;
        }
    }
    Ok(body.finish())
}

/// XHTML carries og tags as routinely as HTML does, so both types are parsed; an absent
/// or any other content type is not.
fn is_html(headers: &header::HeaderMap) -> bool {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| {
            let v = v.to_ascii_lowercase();
            v.contains("text/html") || v.contains("application/xhtml+xml")
        })
}

/// Whether a response is worth reading as an image at all — the cheap early filter that
/// spares the [`MAX_IMAGE_BYTES`] body read for everything else. The type that ships is
/// NOT this one: [`checked_image_type`] sniffs it from the bytes. Pure, so both halves of
/// the split are testable without a response.
///
/// The header is attacker-chosen — the page names the `og:image` host — so the match is
/// against a closed set rather than an `image/<token>` grammar: an exact compare refuses
/// the decorated spellings (`image/png,x`, `image/png#`) on its own, and those matter
/// because a data URI's media type ends at its first comma or `#`, which would strip the
/// `;base64` flag off the URI the frontend receives. SVG is deliberately absent: it is an
/// active document (script, external references), and og images are raster in practice.
fn image_media_type(content_type: &str) -> Option<String> {
    let media_type = content_type.split(';').next()?.trim().to_ascii_lowercase();
    let carried = match media_type.as_str() {
        // `image/jpg` is not a registered type, but misconfigured hosts serve it.
        "image/jpeg" | "image/jpg" => "image/jpeg",
        "image/png" => "image/png",
        "image/gif" => "image/gif",
        "image/webp" => "image/webp",
        _ => return None,
    };
    Some(carried.to_string())
}

// ---------------------------------------------------------------------------
// Image header sniffing
// ---------------------------------------------------------------------------

const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

/// A fixed-width field at `at`, or `None` when the slice ends first. Every dimension read
/// below goes through here, so a header cut short can only ever yield `None`.
fn field<const N: usize>(bytes: &[u8], at: usize) -> Option<[u8; N]> {
    bytes.get(at..at.checked_add(N)?)?.try_into().ok()
}

/// A 24-bit little-endian field — WebP's extended-format canvas dimensions.
fn le_u24(bytes: &[u8], at: usize) -> Option<u32> {
    let triple: [u8; 3] = field(bytes, at)?;
    Some(u32::from_le_bytes([triple[0], triple[1], triple[2], 0]))
}

/// The format fetched bytes actually are, and the raster their HEADER declares — header
/// fields only, nothing is decoded. `None` when the bytes are not one of the four raster
/// formats this preview carries, or when the header they need is truncated.
///
/// The magic bytes decide, not the response header: the format has to be known to bound
/// the decode the webview will perform, and a hostile host names the header freely.
fn sniff_image(bytes: &[u8]) -> Option<(&'static str, u32, u32)> {
    if bytes.starts_with(PNG_SIGNATURE) {
        return sniff_png(bytes);
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return sniff_gif(bytes);
    }
    if bytes.starts_with(&[0xff, 0xd8]) {
        return sniff_jpeg(bytes);
    }
    if bytes.starts_with(b"RIFF") && field::<4>(bytes, 8)? == *b"WEBP" {
        return sniff_webp(bytes);
    }
    None
}

/// IHDR carries the dimensions and the spec requires it to be the first chunk, so a PNG
/// whose 12..16 is anything else is malformed rather than merely ordered oddly.
fn sniff_png(bytes: &[u8]) -> Option<(&'static str, u32, u32)> {
    if field::<4>(bytes, 12)? != *b"IHDR" {
        return None;
    }
    let width = u32::from_be_bytes(field(bytes, 16)?);
    let height = u32::from_be_bytes(field(bytes, 20)?);
    Some(("image/png", width, height))
}

/// The size a GIF is decoded at is NOT its logical screen descriptor. Blink decodes GIFs
/// through Skia's `SkWuffsCodec`, which enables only wuffs' ignore-too-much-pixel-data
/// quirk, leaving the default behaviour — stated in wuffs' own `decode_quirks.wuffs` —
/// of expanding the image bounds to contain the FIRST frame's rect. Both descriptor
/// fields are `u16`, so a 1x1 screen can front a 131070-per-axis allocation, and desktop
/// Blink sets no decoded-size ceiling of its own. Later frames are clipped to those
/// bounds, so gating the union of screen and first frame is the whole exposure.
///
/// Terminates on any input: every block consumes at least the byte that introduces it,
/// and a zero-length sub-block is the terminator consuming its own length byte, so `i`
/// strictly increases and each read is bounds-checked.
fn sniff_gif(bytes: &[u8]) -> Option<(&'static str, u32, u32)> {
    let screen_width = u32::from(u16::from_le_bytes(field(bytes, 6)?));
    let screen_height = u32::from(u16::from_le_bytes(field(bytes, 8)?));
    let flags = *bytes.get(10)?;
    // The header runs to 13. A global colour table, when the flag bit says one is there,
    // sits between it and the first block, sized 3 * 2^(N+1) by the low three bits.
    let mut i = 13usize;
    if flags & 0x80 != 0 {
        i += 3 * (1usize << ((flags & 0x07) + 1));
    }
    loop {
        match *bytes.get(i)? {
            // An extension: a label byte, then length-prefixed sub-blocks to a 0 length.
            0x21 => {
                i += 2;
                loop {
                    let sub_block = usize::from(*bytes.get(i)?);
                    i += 1;
                    if sub_block == 0 {
                        break;
                    }
                    i += sub_block;
                }
            }
            0x2c => {
                let left = u32::from(u16::from_le_bytes(field(bytes, i + 1)?));
                let top = u32::from(u16::from_le_bytes(field(bytes, i + 3)?));
                let width = u32::from(u16::from_le_bytes(field(bytes, i + 5)?));
                let height = u32::from(u16::from_le_bytes(field(bytes, i + 7)?));
                // u16 + u16 cannot overflow u32, so the union needs no saturation.
                return Some((
                    "image/gif",
                    screen_width.max(left + width),
                    screen_height.max(top + height),
                ));
            }
            // The trailer, or any byte that starts no block: fail closed rather than fall
            // back to the screen size, the same answer a truncated header gets.
            _ => return None,
        }
    }
}

/// SOF0..SOF15, less the three markers that share the range without being frame headers:
/// DHT (0xC4), the JPEG extensions marker (0xC8), and DAC (0xCC).
fn is_start_of_frame(marker: u8) -> bool {
    (0xc0..=0xcf).contains(&marker) && !matches!(marker, 0xc4 | 0xc8 | 0xcc)
}

/// Walk the marker chain to the first frame header, where a JPEG states its size.
/// Terminates on any input: every iteration consumes a fill byte and a marker before the
/// segment length is added, so `i` strictly increases, and each read is bounds-checked.
fn sniff_jpeg(bytes: &[u8]) -> Option<(&'static str, u32, u32)> {
    let mut i = 2usize;
    loop {
        if *bytes.get(i)? != 0xff {
            return None;
        }
        // Any number of 0xFF fill bytes may precede a marker.
        while *bytes.get(i)? == 0xff {
            i += 1;
        }
        let marker = *bytes.get(i)?;
        i += 1;
        // EOI, or entropy-coded scan data: no frame header can follow either.
        if marker == 0xd9 || marker == 0xda {
            return None;
        }
        // TEM and the restart markers stand alone, carrying no length or payload.
        if marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
            continue;
        }
        // A segment's length counts its own two bytes, so anything under 2 is malformed.
        let length = usize::from(u16::from_be_bytes(field(bytes, i)?));
        if length < 2 {
            return None;
        }
        if is_start_of_frame(marker) {
            // Length, one precision byte, then height before width.
            let height = u16::from_be_bytes(field(bytes, i + 3)?);
            let width = u16::from_be_bytes(field(bytes, i + 5)?);
            return Some(("image/jpeg", width.into(), height.into()));
        }
        // Counting its own two bytes makes the length the whole step from here.
        i = i.checked_add(length)?;
    }
}

/// The three bitstream headers a WebP file can open with, each stating the size its own
/// way. The chunk header sits at 12 (fourcc plus size) and its payload at 20.
fn sniff_webp(bytes: &[u8]) -> Option<(&'static str, u32, u32)> {
    let fourcc: [u8; 4] = field(bytes, 12)?;
    let payload = bytes.get(20..)?;
    let (width, height) = match &fourcc {
        b"VP8 " => {
            // A 3-byte frame tag, the sync code, then two dimensions whose top 2 bits are
            // a scaling hint rather than size.
            if field::<3>(payload, 3)? != [0x9d, 0x01, 0x2a] {
                return None;
            }
            let width = u16::from_le_bytes(field(payload, 6)?) & 0x3fff;
            let height = u16::from_le_bytes(field(payload, 8)?) & 0x3fff;
            (u32::from(width), u32::from(height))
        }
        b"VP8L" => {
            if *payload.first()? != 0x2f {
                return None;
            }
            // 14 bits each, stored one less than the real dimension.
            let bits = u32::from_le_bytes(field(payload, 1)?);
            ((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1)
        }
        // A flags byte and 3 reserved, then the canvas size as two 24-bit fields, also
        // stored one less.
        b"VP8X" => (le_u24(payload, 4)? + 1, le_u24(payload, 7)? + 1),
        _ => return None,
    };
    Some(("image/webp", width, height))
}

/// Whether a declared raster is safe to hand the webview's decoder. Both caps bite: the
/// per-axis one bounds a single enormous edge, the pixel one a raster merely large on
/// both axes.
fn dimensions_within_caps(width: u32, height: u32) -> bool {
    width > 0
        && height > 0
        && width <= MAX_IMAGE_DIMENSION
        && height <= MAX_IMAGE_DIMENSION
        && u64::from(width) * u64::from(height) <= MAX_IMAGE_PIXELS
}

/// The media type to embed for fetched image bytes, or `None` when they are not a
/// carriable image or declare a raster past the caps.
///
/// Deliberate non-goals: nothing is downscaled or re-encoded, so the original bytes ship
/// or none do; and an animated format's frame COUNT is unbounded by design. Each frame's
/// raster is bounded by the gated canvas, which is what bounds per-tick decode cost, and
/// the webview's animated-image cache bounds decoded-frame memory.
fn checked_image_type(bytes: &[u8]) -> Option<&'static str> {
    let (media_type, width, height) = sniff_image(bytes)?;
    dimensions_within_caps(width, height).then_some(media_type)
}

/// Everything between a capped read and the URI that ships: the cap and empty checks, the
/// header sniff, and the encoding. `None` for an over-cap or empty body, bytes that are
/// not a carried image, or a raster past the caps.
///
/// The transport content type is deliberately NOT a parameter. The whole point of sniffing
/// is that the attacker-chosen header must not name the type the frontend receives, and
/// keeping it out of this signature is what makes routing it here impossible rather than
/// merely unintended.
fn encode_checked_image(bytes: &[u8], over_cap: bool) -> Option<String> {
    if over_cap || bytes.is_empty() {
        return None;
    }
    let media_type = checked_image_type(bytes)?;
    Some(image_data_uri(media_type, bytes))
}

/// Compose the `data:` URI the frontend renders as an `<img src>`.
fn image_data_uri(media_type: &str, bytes: &[u8]) -> String {
    use base64::Engine;
    let payload = base64::engine::general_purpose::STANDARD.encode(bytes);
    format!("data:{media_type};base64,{payload}")
}

/// Fetch an `og:image` through this module's client and return it as a complete `data:`
/// URI, so the webview never contacts the third-party host. Every failure — unparseable
/// URL, refused hop, transport failure, non-2xx, a missing or unreadable content type,
/// wrong media type, oversized or empty body, bytes that are not one of the carried image
/// formats, a raster past the dimension caps, or [`IMAGE_DEADLINE`] elapsing — yields
/// `None`: a preview without an image is a valid preview, never an error.
async fn fetch_image_data(candidate: &str) -> Option<String> {
    let url = Url::parse(candidate).ok()?;
    // Its own budget, so a slow image host cannot spend the page's deadline. The first
    // thing the loop does is `guard_hop` this URL, which is the whole private-network
    // refusal — no separate pre-check earns its extra DNS lookup.
    tokio::time::timeout(IMAGE_DEADLINE, load_image_data_uri(url))
        .await
        .ok()
        .flatten()
}

async fn load_image_data_uri(url: Url) -> Option<String> {
    let (_, resp) = fetch_following_redirects(url).await.ok()?;
    if !(200..300).contains(&resp.status().as_u16()) {
        return None;
    }
    // Header first, purely to avoid reading 2 MiB of a non-image; the type that ships is
    // the one sniffed from the bytes below, since this header is attacker-chosen.
    image_media_type(
        resp.headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())?,
    )?;
    let (bytes, over_cap) = read_body_capped(resp, MAX_IMAGE_BYTES).await.ok()?;
    encode_checked_image(&bytes, over_cap)
}

/// Fetch a page's Open Graph metadata for the link hover card.
///
/// A page with no metadata, or one that isn't HTML, is `Ok` with every field
/// `None` — only refused URLs, transport failures, non-2xx pages, and the page
/// half's deadline are `Err`. The image step never is.
#[tauri::command]
pub async fn fetch_link_preview(url: String) -> AppResult<LinkPreview> {
    // The deadline bounds the PAGE fetch, whose hops each carry their own per-request
    // timeouts and would otherwise stack. The image is deliberately outside it: it has
    // its own budget and can only ever be absent, so a slow image host cannot discard a
    // preview whose text already arrived.
    let parsed = tokio::time::timeout(PREVIEW_DEADLINE, fetch_page(url))
        .await
        .map_err(|_| AppError::Command("link preview: timed out".into()))??;
    let image_data = match &parsed.image_url {
        Some(candidate) => fetch_image_data(candidate).await,
        None => None,
    };
    Ok(LinkPreview {
        title: parsed.title,
        description: parsed.description,
        image_data,
    })
}

/// GET `start`, following redirects by hand so [`guard_hop`] clears every hop — the
/// first one included — before it is requested. Returns the URL that finally served the
/// response and the response itself, whatever its status; gating the status is the
/// caller's half.
///
/// The page fetch and the image fetch both go through here, so the hop counting,
/// `Location` resolution, and per-hop validation that [`next_hop`]'s tests cover apply
/// to both paths — there is only one loop to get right.
async fn fetch_following_redirects(start: Url) -> AppResult<(Url, Response)> {
    let mut current = start;
    let mut hops = 0usize;
    loop {
        guard_hop(&current).await?;
        let resp = client()?
            .get(current.clone())
            .send()
            .await
            .map_err(|e| AppError::Command(format!("link preview request failed: {e}")))?;
        let status = resp.status().as_u16();
        let location = resp
            .headers()
            .get(header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        match next_hop(&current, status, location.as_deref(), hops)? {
            Some(next) => {
                hops += 1;
                current = next;
            }
            None => return Ok((current, resp)),
        }
    }
}

/// The page half: everything under [`PREVIEW_DEADLINE`], ending at the parsed metadata.
/// The image it names is fetched separately so its cost is not charged to this budget.
async fn fetch_page(url: String) -> AppResult<ParsedPreview> {
    let start = Url::parse(url.trim())
        .map_err(|_| AppError::InvalidArgument("link preview: not a valid URL".into()))?;
    let (final_url, resp) = fetch_following_redirects(start).await?;
    let status = resp.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(AppError::Command(format!("link preview: HTTP {status}")));
    }
    if !is_html(resp.headers()) {
        return Ok(ParsedPreview::default());
    }
    let (body, _) = read_body_capped(resp, MAX_BODY_BYTES).await?;
    Ok(preview_from_html(
        &String::from_utf8_lossy(&body),
        &final_url,
    ))
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/// The raw (still entity-encoded) values a scan found, one slot per source so
/// precedence is decided once in [`preview_from_html`] rather than by document order.
#[derive(Default)]
struct Harvest {
    og_title: Option<String>,
    og_description: Option<String>,
    og_image: Option<String>,
    og_image_url: Option<String>,
    tw_title: Option<String>,
    tw_description: Option<String>,
    tw_image: Option<String>,
    tw_image_src: Option<String>,
    meta_description: Option<String>,
    title_element: Option<String>,
}

/// Index of the `>` that closes a tag opened at `from`, skipping quoted attribute values
/// (a `>` inside one does not end the tag). `None` when none appears within
/// [`MAX_TAG_BYTES`] — an unwindowed scan is what made a page of unterminated tags cost
/// O(n²), since every one of them would rescan to the end of the document.
fn tag_end(bytes: &[u8], from: usize) -> Option<usize> {
    let limit = bytes.len().min(from.saturating_add(MAX_TAG_BYTES));
    let mut i = from;
    let mut quote: Option<u8> = None;
    while i < limit {
        let c = bytes[i];
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => {}
            None if c == b'"' || c == b'\'' => quote = Some(c),
            None if c == b'>' => return Some(i),
            None => {}
        }
        i += 1;
    }
    None
}

/// Whether [`tag_end`]'s `None` means the document itself ran out (rather than the tag
/// merely being longer than the window).
fn window_reached_end(bytes: &[u8], from: usize) -> bool {
    from.saturating_add(MAX_TAG_BYTES) >= bytes.len()
}

/// Attribute pairs of a tag body, names lowercased and values raw. Handles single-,
/// double-, and un-quoted values in any order, and tolerates valueless attributes.
/// Every index advanced past is ASCII, so the slices stay on char boundaries.
fn parse_attributes(tag: &str) -> Vec<(String, String)> {
    let bytes = tag.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        while i < bytes.len() && (bytes[i].is_ascii_whitespace() || bytes[i] == b'/') {
            i += 1;
        }
        let name_start = i;
        while i < bytes.len()
            && !bytes[i].is_ascii_whitespace()
            && bytes[i] != b'='
            && bytes[i] != b'/'
        {
            i += 1;
        }
        let name = tag[name_start..i].to_ascii_lowercase();
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        let mut value = String::new();
        if i < bytes.len() && bytes[i] == b'=' {
            i += 1;
            while i < bytes.len() && bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            if i < bytes.len() && (bytes[i] == b'"' || bytes[i] == b'\'') {
                let quote = bytes[i];
                i += 1;
                let start = i;
                while i < bytes.len() && bytes[i] != quote {
                    i += 1;
                }
                value.push_str(&tag[start..i]);
                if i < bytes.len() {
                    i += 1;
                }
            } else {
                let start = i;
                while i < bytes.len() && !bytes[i].is_ascii_whitespace() {
                    i += 1;
                }
                value.push_str(&tag[start..i]);
            }
        }
        if name.is_empty() {
            // No name and no progress would spin; the delimiter skip above guarantees
            // one of the two.
            if i < bytes.len() && bytes[i] != b'=' {
                continue;
            }
            i += 1;
            continue;
        }
        out.push((name, value));
    }
    out
}

/// Whether the byte at `at` ends an HTML tag name (so `<metadata>` isn't a `<meta>`).
fn ends_tag_name(bytes: &[u8], at: usize) -> bool {
    matches!(bytes.get(at), Some(c) if c.is_ascii_whitespace() || *c == b'/' || *c == b'>')
}

fn harvest(html: &str) -> Harvest {
    // ASCII-lowercasing preserves byte length, so indices found here slice `html`.
    let lower = html.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut h = Harvest::default();

    let mut examined = 0usize;
    for (start, _) in lower.match_indices("<meta") {
        let after = start + "<meta".len();
        if !ends_tag_name(bytes, after) {
            continue;
        }
        examined += 1;
        if examined > MAX_META_TAGS {
            break;
        }
        let Some(end) = tag_end(bytes, after) else {
            if window_reached_end(bytes, after) {
                // The document ends inside this tag, so everything after it is inside it
                // too and no later `<meta` can close either. Stopping here is what keeps
                // a body of unterminated tags linear instead of quadratic.
                break;
            }
            // Merely absurd rather than unterminated — skip this one and keep scanning.
            continue;
        };
        let attrs = parse_attributes(&html[after..end]);
        let Some(content) = attrs.iter().find(|(n, _)| n == "content").map(|(_, v)| v) else {
            continue;
        };
        // Pages disagree about which attribute names a key (`property` for og, `name`
        // for twitter — but both spellings occur for both), so either one is read.
        for (attr, key) in &attrs {
            if attr != "property" && attr != "name" {
                continue;
            }
            let slot = match key.trim().to_ascii_lowercase().as_str() {
                "og:title" => &mut h.og_title,
                "og:description" => &mut h.og_description,
                "og:image" => &mut h.og_image,
                "og:image:url" => &mut h.og_image_url,
                "twitter:title" => &mut h.tw_title,
                "twitter:description" => &mut h.tw_description,
                "twitter:image" => &mut h.tw_image,
                "twitter:image:src" => &mut h.tw_image_src,
                "description" => &mut h.meta_description,
                _ => continue,
            };
            if slot.is_none() {
                *slot = Some(content.clone());
            }
        }
    }

    h.title_element = lower
        .match_indices("<title")
        .find(|(i, _)| ends_tag_name(bytes, i + "<title".len()))
        .and_then(|(start, _)| {
            let open_end = tag_end(bytes, start + "<title".len())?;
            let text_start = open_end.checked_add(1).filter(|s| *s <= bytes.len())?;
            let rel = lower[text_start..].find("</title")?;
            Some(html[text_start..text_start + rel].to_string())
        });

    h
}

/// Decode the HTML entities that actually appear in page metadata: numeric (`&#123;`,
/// `&#x1f;`) plus the common named set. An unknown or unterminated entity is copied
/// through verbatim — a preview renders text, so a miss is cosmetic.
fn decode_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let after = &rest[amp + 1..];
        // Bounded lookahead so a bare `&` in prose costs a few chars, not a full scan.
        let terminator = after
            .char_indices()
            .take(12)
            .find(|(_, c)| *c == ';')
            .map(|(i, _)| i);
        match terminator.and_then(|end| decode_entity(&after[..end]).map(|d| (d, end))) {
            Some((decoded, end)) => {
                out.push_str(&decoded);
                rest = &after[end + 1..];
            }
            None => {
                out.push('&');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

fn decode_entity(body: &str) -> Option<String> {
    if let Some(digits) = body.strip_prefix('#') {
        let hex = digits
            .strip_prefix('x')
            .or_else(|| digits.strip_prefix('X'));
        let code = match hex {
            Some(h) => u32::from_str_radix(h, 16).ok()?,
            None => digits.parse::<u32>().ok()?,
        };
        return char::from_u32(code).map(String::from);
    }
    let named = match body {
        "amp" => "&",
        "lt" => "<",
        "gt" => ">",
        "quot" => "\"",
        "apos" => "'",
        "nbsp" => "\u{a0}",
        "mdash" => "\u{2014}",
        "ndash" => "\u{2013}",
        "hellip" => "\u{2026}",
        "lsquo" => "\u{2018}",
        "rsquo" => "\u{2019}",
        "ldquo" => "\u{201c}",
        "rdquo" => "\u{201d}",
        "copy" => "\u{a9}",
        "reg" => "\u{ae}",
        "trade" => "\u{2122}",
        "deg" => "\u{b0}",
        "middot" => "\u{b7}",
        "bull" => "\u{2022}",
        _ => return None,
    };
    Some(named.to_string())
}

/// Decode, collapse whitespace runs (control characters counted as whitespace — the
/// card renders text, never markup), trim, and drop an empty result.
fn collapse(raw: &str) -> Option<String> {
    let decoded = decode_entities(raw);
    let mut collapsed = String::with_capacity(decoded.len());
    let mut pending_space = false;
    for c in decoded.chars() {
        if c.is_whitespace() || c.is_control() {
            pending_space = !collapsed.is_empty();
        } else {
            if pending_space {
                collapsed.push(' ');
                pending_space = false;
            }
            collapsed.push(c);
        }
    }
    let trimmed = collapsed.trim_end();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// [`collapse`] plus a `max_chars` cap for prose fields, cut on a char boundary.
fn normalize(raw: &str, max_chars: usize) -> Option<String> {
    let text = collapse(raw)?;
    let capped = if text.chars().count() > max_chars {
        text.chars().take(max_chars).collect::<String>()
    } else {
        text
    };
    let trimmed = capped.trim_end();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// Resolve an `og:image` against the page's FINAL (post-redirect) URL — the value is
/// routinely relative or protocol-relative. A result that isn't http(s) (a `data:` URI,
/// say) or that exceeds [`MAX_IMAGE_URL_CHARS`] is dropped: unlike prose, a URL cannot
/// be truncated without becoming a different URL.
fn resolve_image(base: &Url, raw: &str) -> Option<String> {
    let value = collapse(raw)?;
    let resolved = base.join(&value).ok()?;
    if !matches!(resolved.scheme(), "http" | "https") {
        return None;
    }
    let text = resolved.to_string();
    (text.chars().count() <= MAX_IMAGE_URL_CHARS).then_some(text)
}

/// Build a parse result from a page body and the URL that finally served it. The image
/// is still a URL here; [`fetch_image_data`] turns it into the bytes that ship.
fn preview_from_html(html: &str, final_url: &Url) -> ParsedPreview {
    let h = harvest(html);
    let first = |sources: Vec<Option<String>>| sources.into_iter().flatten().next();
    ParsedPreview {
        title: first(vec![h.og_title, h.tw_title, h.title_element])
            .and_then(|v| normalize(&v, MAX_TITLE_CHARS)),
        description: first(vec![h.og_description, h.tw_description, h.meta_description])
            .and_then(|v| normalize(&v, MAX_DESCRIPTION_CHARS)),
        image_url: first(vec![h.og_image, h.og_image_url, h.tw_image, h.tw_image_src])
            .and_then(|v| resolve_image(final_url, &v)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn url(s: &str) -> Url {
        Url::parse(s).expect("test URL parses")
    }

    fn preview(html: &str) -> ParsedPreview {
        preview_from_html(html, &url("https://example.com/page"))
    }

    /// The frontend reads `imageData` off this record — a data URI, not a URL, and no
    /// `imageUrl` key at all. `rename_all` is a rename trap the repo has been bitten by,
    /// so the wire shape is pinned rather than assumed.
    #[test]
    fn link_preview_serializes_to_the_pinned_wire_shape() {
        let value = serde_json::to_value(LinkPreview {
            title: Some("T".into()),
            description: Some("D".into()),
            image_data: Some("data:image/png;base64,AAAA".into()),
        })
        .unwrap();
        assert_eq!(
            value,
            json!({
                "title": "T",
                "description": "D",
                "imageData": "data:image/png;base64,AAAA",
            })
        );
        assert_eq!(
            serde_json::to_value(LinkPreview::default()).unwrap(),
            json!({ "title": null, "description": null, "imageData": null })
        );
        // The old key is gone, not merely renamed alongside.
        assert!(value.get("imageUrl").is_none());
    }

    #[test]
    fn ip_is_blocked_covers_every_private_range() {
        let blocked = [
            "127.0.0.1",
            "127.255.255.254",
            "10.0.0.1",
            "10.255.255.255",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.0.1",
            "192.168.255.255",
            "169.254.169.254",
            "100.64.0.0",
            "100.127.255.255",
            "0.0.0.0",
            "255.255.255.255",
            "::1",
            "::",
            "fc00::1",
            "fd12:3456::1",
            "fdff:ffff::1",
            "fe80::1",
            "febf::1",
            // Deprecated site-local, and multicast in both families.
            "fec0::1",
            "feff::1",
            "ff02::1",
            "224.0.0.1",
            "239.255.255.250",
        ];
        for raw in blocked {
            let ip: IpAddr = raw.parse().unwrap();
            assert!(ip_is_blocked(ip), "{raw} should be blocked");
        }
    }

    #[test]
    fn ip_is_blocked_allows_the_neighbours_of_each_range() {
        let allowed = [
            "126.255.255.255",
            "128.0.0.1",
            "9.255.255.255",
            "11.0.0.1",
            "172.15.255.255",
            "172.32.0.1",
            "192.167.255.255",
            "192.169.0.1",
            "169.253.255.255",
            "169.255.0.1",
            "100.63.255.255",
            "100.128.0.0",
            "0.0.0.1",
            "255.255.255.254",
            "8.8.8.8",
            "223.255.255.255",
            "240.0.0.1",
            "2606:4700:4700::1111",
            "fbff:ffff::1",
            "fe00::1",
        ];
        for raw in allowed {
            let ip: IpAddr = raw.parse().unwrap();
            assert!(!ip_is_blocked(ip), "{raw} should be allowed");
        }
    }

    /// `::ffff:a.b.c.d` reaches the embedded v4 network, so it must be judged by the v4
    /// arms — treating it as an ordinary v6 address would wave 127.0.0.1 straight through.
    #[test]
    fn ip_is_blocked_unwraps_ipv4_mapped_addresses() {
        for raw in [
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
            "::ffff:169.254.169.254",
        ] {
            let ip: IpAddr = raw.parse().unwrap();
            assert!(ip_is_blocked(ip), "{raw} should be blocked");
        }
        let public: IpAddr = "::ffff:8.8.8.8".parse().unwrap();
        assert!(!ip_is_blocked(public));
    }

    /// Three more v6 spellings reach a v4 network without being IPv4-MAPPED, so each has
    /// to be unwrapped too: IPv4-compatible, NAT64, and 6to4. Every one of them cleared
    /// the blocklist before this arm existed.
    #[test]
    fn ip_is_blocked_unwraps_the_other_v4_embeddings() {
        let blocked = [
            "::127.0.0.1",        // IPv4-compatible (::7f00:1)
            "::192.168.1.1",      // IPv4-compatible
            "64:ff9b::127.0.0.1", // NAT64 well-known prefix
            "64:ff9b::10.0.0.1",  // NAT64
            "2002:7f00:0001::1",  // 6to4 wrapping 127.0.0.1
            "2002:c0a8:0101::1",  // 6to4 wrapping 192.168.1.1
        ];
        for raw in blocked {
            let ip: IpAddr = raw.parse().unwrap();
            assert!(ip_is_blocked(ip), "{raw} should be blocked");
        }
        // Unwrapping re-checks rather than blanket-blocks: the same forms around a
        // public v4 address stay allowed.
        let allowed = ["::8.8.8.8", "64:ff9b::8.8.8.8", "2002:0808:0808::1"];
        for raw in allowed {
            let ip: IpAddr = raw.parse().unwrap();
            assert!(!ip_is_blocked(ip), "{raw} should be allowed");
        }
    }

    #[test]
    fn validate_url_rejects_non_http_schemes() {
        for raw in [
            "file:///etc/passwd",
            "ftp://example.com/x",
            "data:text/html,x",
        ] {
            assert!(validate_url(&url(raw)).is_err(), "{raw} should be refused");
        }
    }

    #[test]
    fn validate_url_rejects_loopback_names() {
        for raw in [
            "http://localhost/x",
            "https://LOCALHOST:8080/x",
            "http://localhost./x",
            "http://api.localhost/x",
            "http://printer.local/x",
        ] {
            assert!(validate_url(&url(raw)).is_err(), "{raw} should be refused");
        }
    }

    #[test]
    fn validate_url_rejects_blocked_ip_literals() {
        for raw in [
            "http://127.0.0.1/x",
            "http://169.254.169.254/latest/meta-data",
            "http://[::1]/x",
            "http://[fe80::1]/x",
            "http://[::ffff:127.0.0.1]/x",
            // The url crate normalizes IPv4 shorthands, so the decimal spelling of
            // 127.0.0.1 is caught by the same literal check.
            "http://2130706433/x",
        ] {
            assert!(validate_url(&url(raw)).is_err(), "{raw} should be refused");
        }
    }

    #[test]
    fn validate_url_defers_names_to_dns_with_the_right_port() {
        assert_eq!(
            validate_url(&url("https://Example.COM/page")).unwrap(),
            FetchTarget::Resolve {
                host: "example.com".into(),
                port: 443
            }
        );
        assert_eq!(
            validate_url(&url("http://example.com/page")).unwrap(),
            FetchTarget::Resolve {
                host: "example.com".into(),
                port: 80
            }
        );
        assert_eq!(
            validate_url(&url("http://example.com:8443/page")).unwrap(),
            FetchTarget::Resolve {
                host: "example.com".into(),
                port: 8443
            }
        );
        assert_eq!(
            validate_url(&url("https://93.184.216.34/page")).unwrap(),
            FetchTarget::Literal
        );
    }

    /// Hrefs reach the command with their author's casing (`HTTPS://…`), so the scheme
    /// comparison rides on the WHATWG parser lowercasing it. Pinned against the crate
    /// rather than the standard.
    #[test]
    fn an_uppercase_scheme_is_lowercased_before_the_scheme_check() {
        let parsed = url("HTTPS://EXAMPLE.COM/p");
        assert_eq!(parsed.scheme(), "https");
        assert_eq!(
            validate_url(&parsed).unwrap(),
            FetchTarget::Resolve {
                host: "example.com".into(),
                port: 443
            }
        );
        assert_eq!(url("HTTP://Example.com/p").scheme(), "http");
        // The same normalization must not rescue a refused scheme.
        assert!(validate_url(&url("FILE:///etc/passwd")).is_err());
    }

    #[test]
    fn next_hop_returns_none_for_a_terminal_status() {
        let current = url("https://example.com/a");
        assert_eq!(next_hop(&current, 200, None, 0).unwrap(), None);
        assert_eq!(next_hop(&current, 404, Some("/b"), 0).unwrap(), None);
        // 304/305 are not redirects we follow.
        assert_eq!(next_hop(&current, 304, Some("/b"), 0).unwrap(), None);
    }

    #[test]
    fn next_hop_resolves_relative_and_protocol_relative_locations() {
        let current = url("https://example.com/dir/page?q=1");
        assert_eq!(
            next_hop(&current, 302, Some("other"), 0).unwrap(),
            Some(url("https://example.com/dir/other"))
        );
        assert_eq!(
            next_hop(&current, 301, Some("/root"), 0).unwrap(),
            Some(url("https://example.com/root"))
        );
        assert_eq!(
            next_hop(&current, 308, Some("//cdn.example.net/x"), 0).unwrap(),
            Some(url("https://cdn.example.net/x"))
        );
        assert_eq!(
            next_hop(&current, 307, Some("  https://other.example/y  "), 0).unwrap(),
            Some(url("https://other.example/y"))
        );
    }

    #[test]
    fn next_hop_follows_three_redirects_and_refuses_the_fourth() {
        let current = url("https://example.com/a");
        for hops_taken in 0..MAX_REDIRECTS {
            assert!(
                next_hop(&current, 302, Some("/next"), hops_taken)
                    .unwrap()
                    .is_some(),
                "hop {hops_taken} should be followed"
            );
        }
        let err = next_hop(&current, 302, Some("/next"), MAX_REDIRECTS).unwrap_err();
        assert!(err.to_string().contains("too many redirects"));
    }

    #[test]
    fn next_hop_errors_on_an_unusable_location() {
        let current = url("https://example.com/a");
        assert!(next_hop(&current, 302, None, 0).is_err());
        assert!(next_hop(&current, 302, Some("   "), 0).is_err());
        assert!(next_hop(&current, 302, Some("http://"), 0).is_err());
    }

    #[test]
    fn meta_parser_reads_both_attribute_orders() {
        let content_last = r#"<meta property="og:title" content="Order A">"#;
        assert_eq!(preview(content_last).title.as_deref(), Some("Order A"));
        let content_first = r#"<meta content="Order B" property="og:title">"#;
        assert_eq!(preview(content_first).title.as_deref(), Some("Order B"));
        // Other attributes on the tag must not confuse the scan.
        let noisy = r#"<meta charset="utf-8" data-x content = 'Order C' property = "og:title" />"#;
        assert_eq!(preview(noisy).title.as_deref(), Some("Order C"));
    }

    #[test]
    fn meta_parser_reads_single_and_double_quoted_values() {
        let single = "<meta property='og:description' content='Single quoted'>";
        assert_eq!(
            preview(single).description.as_deref(),
            Some("Single quoted")
        );
        let double = r#"<meta property="og:description" content="Double quoted">"#;
        assert_eq!(
            preview(double).description.as_deref(),
            Some("Double quoted")
        );
        // A `>` inside a quoted value does not end the tag.
        let angled = r#"<meta property="og:title" content="A > B"><meta property="og:description" content="After">"#;
        let p = preview(angled);
        assert_eq!(p.title.as_deref(), Some("A > B"));
        assert_eq!(p.description.as_deref(), Some("After"));
    }

    #[test]
    fn og_beats_twitter_which_beats_the_title_element() {
        let all = r#"<title>Element</title>
            <meta name="twitter:title" content="Twitter">
            <meta property="og:title" content="OpenGraph">"#;
        assert_eq!(preview(all).title.as_deref(), Some("OpenGraph"));

        let twitter_only = r#"<title>Element</title>
            <meta name="twitter:title" content="Twitter">"#;
        assert_eq!(preview(twitter_only).title.as_deref(), Some("Twitter"));
    }

    #[test]
    fn title_element_is_the_last_title_fallback() {
        let html = "<html><head><title>  Just the element  </title></head></html>";
        assert_eq!(preview(html).title.as_deref(), Some("Just the element"));
        // `<titlebar>` is not `<title>`.
        assert_eq!(preview("<titlebar>nope</titlebar>").title, None);
    }

    #[test]
    fn name_description_is_the_last_description_fallback() {
        let plain = r#"<meta name="description" content="Plain meta">"#;
        assert_eq!(preview(plain).description.as_deref(), Some("Plain meta"));

        let with_twitter = r#"<meta name="description" content="Plain meta">
            <meta name="twitter:description" content="Twitter meta">"#;
        assert_eq!(
            preview(with_twitter).description.as_deref(),
            Some("Twitter meta")
        );
    }

    #[test]
    fn entities_are_decoded_named_and_numeric() {
        let html = r#"<meta property="og:title" content="Tom &amp; Jerry &mdash; &#8220;quoted&#x201d; &hellip;">"#;
        assert_eq!(
            preview(html).title.as_deref(),
            Some("Tom & Jerry \u{2014} \u{201c}quoted\u{201d} \u{2026}")
        );
        // `&nbsp;` decodes to a non-breaking space, which the collapse folds to a plain one.
        let nbsp = r#"<meta property="og:title" content="A&nbsp;B">"#;
        assert_eq!(preview(nbsp).title.as_deref(), Some("A B"));
        // An unterminated or unknown entity is copied through, not dropped.
        let literal = r#"<meta property="og:title" content="Q&A and &notreal; and 5 &lt; 6">"#;
        assert_eq!(
            preview(literal).title.as_deref(),
            Some("Q&A and &notreal; and 5 < 6")
        );
    }

    #[test]
    fn og_image_resolves_against_the_final_url() {
        let base = url("https://example.com/blog/post?x=1");
        let relative = r#"<meta property="og:image" content="cover.png">"#;
        assert_eq!(
            preview_from_html(relative, &base).image_url.as_deref(),
            Some("https://example.com/blog/cover.png")
        );
        let rooted = r#"<meta property="og:image" content="/img/cover.png">"#;
        assert_eq!(
            preview_from_html(rooted, &base).image_url.as_deref(),
            Some("https://example.com/img/cover.png")
        );
        let protocol_relative = r#"<meta property="og:image" content="//cdn.example.net/c.png">"#;
        assert_eq!(
            preview_from_html(protocol_relative, &base)
                .image_url
                .as_deref(),
            Some("https://cdn.example.net/c.png")
        );
        let absolute =
            r#"<meta property="og:image" content="http://other.example/c.png?a=1&amp;b=2">"#;
        assert_eq!(
            preview_from_html(absolute, &base).image_url.as_deref(),
            Some("http://other.example/c.png?a=1&b=2")
        );
    }

    #[test]
    fn a_non_http_og_image_is_dropped() {
        let data_uri = r#"<meta property="og:image" content="data:image/png;base64,AAAA">"#;
        assert_eq!(preview(data_uri).image_url, None);
        let empty = r#"<meta property="og:image" content="   ">"#;
        assert_eq!(preview(empty).image_url, None);
    }

    #[test]
    fn og_image_url_and_twitter_image_are_the_image_fallbacks() {
        let base = url("https://example.com/p");
        let og_url_only = r#"<meta property="og:image:url" content="/a.png">"#;
        assert_eq!(
            preview_from_html(og_url_only, &base).image_url.as_deref(),
            Some("https://example.com/a.png")
        );
        let twitter_src = r#"<meta name="twitter:image:src" content="/b.png">"#;
        assert_eq!(
            preview_from_html(twitter_src, &base).image_url.as_deref(),
            Some("https://example.com/b.png")
        );
        // og:image wins over every fallback regardless of document order.
        let mixed = r#"<meta name="twitter:image" content="/t.png">
            <meta property="og:image:url" content="/u.png">
            <meta property="og:image" content="/o.png">"#;
        assert_eq!(
            preview_from_html(mixed, &base).image_url.as_deref(),
            Some("https://example.com/o.png")
        );
    }

    #[test]
    fn whitespace_runs_collapse_to_single_spaces() {
        let html = "<meta property=\"og:description\" content=\"  lots\n\n of \t\t space  \">";
        assert_eq!(preview(html).description.as_deref(), Some("lots of space"));
    }

    #[test]
    fn title_and_description_are_capped() {
        let long_title = "t".repeat(400);
        let long_description = "d".repeat(700);
        let html = format!(
            r#"<meta property="og:title" content="{long_title}"><meta property="og:description" content="{long_description}">"#
        );
        let p = preview(&html);
        assert_eq!(p.title.unwrap().chars().count(), MAX_TITLE_CHARS);
        assert_eq!(
            p.description.unwrap().chars().count(),
            MAX_DESCRIPTION_CHARS
        );
        // The cut lands on a char boundary, never mid-codepoint.
        let wide = "\u{1f600}".repeat(400);
        let wide_html = format!(r#"<meta property="og:title" content="{wide}">"#);
        assert_eq!(
            preview(&wide_html).title.unwrap().chars().count(),
            MAX_TITLE_CHARS
        );
    }

    #[test]
    fn a_page_without_metadata_yields_all_none() {
        assert_eq!(
            preview("<html><body>Nothing here</body></html>"),
            ParsedPreview::default()
        );
        assert_eq!(preview(""), ParsedPreview::default());
        // A meta tag with no `content` contributes nothing.
        assert_eq!(
            preview(r#"<meta property="og:title">"#),
            ParsedPreview::default()
        );
        // An empty `content` normalizes away rather than becoming an empty string.
        assert_eq!(
            preview(r#"<meta property="og:title" content="  ">"#),
            ParsedPreview::default()
        );
    }

    #[test]
    fn an_over_long_image_url_is_dropped_not_truncated() {
        let base = url("https://example.com/p");
        let long = format!("/{}.png", "a".repeat(MAX_IMAGE_URL_CHARS));
        let html = format!(r#"<meta property="og:image" content="{long}">"#);
        assert_eq!(preview_from_html(&html, &base).image_url, None);
        // One character under the ceiling still comes through whole.
        let fits = "b".repeat(MAX_IMAGE_URL_CHARS - "https://example.com/".len());
        let ok_html = format!(r#"<meta property="og:image" content="/{fits}">"#);
        let got = preview_from_html(&ok_html, &base).image_url.unwrap();
        assert_eq!(got.chars().count(), MAX_IMAGE_URL_CHARS);
        assert!(got.ends_with(&fits), "the URL must not be cut");
    }

    fn headers_with(content_type: Option<&str>) -> header::HeaderMap {
        let mut map = header::HeaderMap::new();
        if let Some(value) = content_type {
            map.insert(
                header::CONTENT_TYPE,
                header::HeaderValue::from_str(value).unwrap(),
            );
        }
        map
    }

    #[test]
    fn is_html_accepts_html_and_xhtml_and_nothing_else() {
        for value in [
            "text/html",
            "TEXT/HTML; charset=utf-8",
            "application/xhtml+xml",
            "Application/XHTML+XML; charset=utf-8",
        ] {
            assert!(is_html(&headers_with(Some(value))), "{value} should parse");
        }
        for value in [
            "application/pdf",
            "image/png",
            "text/plain",
            "application/json",
        ] {
            assert!(
                !is_html(&headers_with(Some(value))),
                "{value} should not parse"
            );
        }
        // An absent header is not an implicit HTML page.
        assert!(!is_html(&headers_with(None)));
    }

    /// Drive the accumulator the async reader uses, over an explicit chunk sequence.
    fn collect_capped(chunks: &[&[u8]], cap: usize) -> (Vec<u8>, bool) {
        let mut body = CappedBody::new(cap);
        for chunk in chunks {
            if !body.push(chunk) {
                break;
            }
        }
        body.finish()
    }

    #[test]
    fn the_body_cap_stops_at_exactly_max_body_bytes() {
        // Well under the cap: everything is kept, and nothing is reported over it.
        let (small, over) = collect_capped(&[b"abc", b"def"], MAX_BODY_BYTES);
        assert_eq!(small, b"abcdef");
        assert!(!over);

        // A body landing exactly ON the cap is complete, not over it — the distinction
        // the image path needs.
        let exact = vec![b'x'; MAX_BODY_BYTES];
        let (filled, over) = collect_capped(&[&exact], MAX_BODY_BYTES);
        assert_eq!(filled.len(), MAX_BODY_BYTES);
        assert!(!over, "a body exactly at the cap is not over it");

        // One byte past the cap is over it, and the bytes come back trimmed to the cap.
        let one_over = vec![b'x'; MAX_BODY_BYTES + 1];
        let (trimmed, over) = collect_capped(&[&one_over], MAX_BODY_BYTES);
        assert_eq!(trimmed.len(), MAX_BODY_BYTES);
        assert!(over, "one byte past the cap is over it");

        // A chunk after the cap is reached is never appended.
        let (filled, _) = collect_capped(&[&exact, b"never"], MAX_BODY_BYTES);
        assert!(!filled.ends_with(b"never"));

        // The cap counts across chunks, not per chunk.
        let half = vec![b'z'; MAX_BODY_BYTES / 2];
        let (all, over) = collect_capped(&[&half, &half, &half], MAX_BODY_BYTES);
        assert_eq!(all.len(), MAX_BODY_BYTES);
        assert!(over);
    }

    /// The image cap is the same accumulator at a different ceiling, and its boundary is
    /// what decides drop-vs-keep rather than truncate-vs-keep.
    #[test]
    fn the_image_cap_separates_exactly_full_from_oversized() {
        let exact = vec![0u8; MAX_IMAGE_BYTES];
        let (bytes, over) = collect_capped(&[&exact], MAX_IMAGE_BYTES);
        assert_eq!(bytes.len(), MAX_IMAGE_BYTES);
        assert!(!over, "a 2 MiB image is at the cap, not over it");

        let too_big = vec![0u8; MAX_IMAGE_BYTES + 1];
        let (_, over) = collect_capped(&[&too_big], MAX_IMAGE_BYTES);
        assert!(over, "2 MiB + 1 byte is over the cap and gets dropped");

        // Split across chunks the verdict is the same.
        let chunk = vec![0u8; MAX_IMAGE_BYTES / 2];
        let (_, over) = collect_capped(&[&chunk, &chunk], MAX_IMAGE_BYTES);
        assert!(!over);
        let (_, over) = collect_capped(&[&chunk, &chunk, b"x"], MAX_IMAGE_BYTES);
        assert!(over);
    }

    #[test]
    fn a_body_cut_mid_utf8_sequence_decodes_lossily() {
        // Cap-1 ASCII bytes then a 2-byte char: the cut lands between its bytes.
        let mut body = vec![b'a'; MAX_BODY_BYTES - 1];
        body.extend_from_slice("é".as_bytes());
        let (truncated, over) = collect_capped(&[&body], MAX_BODY_BYTES);
        assert_eq!(truncated.len(), MAX_BODY_BYTES);
        assert!(over);
        let text = String::from_utf8_lossy(&truncated);
        assert!(text.ends_with('\u{fffd}'), "the split char became U+FFFD");
        assert_eq!(text.chars().count(), MAX_BODY_BYTES);
    }

    /// The accept side is a closed set of five spellings — the four carried formats plus
    /// the `image/jpg` misspelling, which normalizes rather than being carried verbatim.
    #[test]
    fn image_media_type_accepts_raster_images_only() {
        for (raw, expected) in [
            ("image/png", "image/png"),
            ("IMAGE/PNG", "image/png"),
            ("image/jpeg; charset=binary", "image/jpeg"),
            ("  image/webp  ", "image/webp"),
            ("image/gif", "image/gif"),
            ("image/jpg", "image/jpeg"),
            ("IMAGE/JPG; charset=binary", "image/jpeg"),
        ] {
            assert_eq!(image_media_type(raw).as_deref(), Some(expected), "{raw}");
        }
        for raw in [
            "text/html",
            "application/json",
            "application/octet-stream",
            // SVG is an image type but an active document — refused deliberately.
            "image/svg+xml",
            "IMAGE/SVG+XML; charset=utf-8",
            // Image types the sniffer cannot read a raster out of, so the filter refuses
            // them here rather than letting the body read happen for nothing.
            "image/bmp",
            "image/tiff",
            "image/avif",
            "image/x-icon",
            "image/heic",
            "",
            "notimage/png",
            "image",
            "image/",
            "/png",
        ] {
            assert_eq!(image_media_type(raw), None, "{raw} must not be carried");
        }
    }

    /// The header comes from the attacker-chosen image host. A comma ends the media type
    /// when a data URI is parsed and a `#` starts its fragment, so either one both
    /// dodges the exact-match SVG refusal and strips the `;base64` flag off the URI the
    /// frontend receives — the whole reason the subtype is token-validated.
    #[test]
    fn image_media_type_rejects_decorated_subtypes() {
        for raw in [
            "image/svg+xml,x",
            "image/svg+xml,",
            "image/png,x",
            "image/svg+xml#x",
            "image/png#",
            "image/png x",
            "image/pn g",
            "image/svg/x",
            "image/png\"",
            "image/png\\x",
        ] {
            assert_eq!(
                image_media_type(raw),
                None,
                "{raw} must not reach a data URI"
            );
        }
    }

    /// The frontend renders this string directly as an `<img src>`, so both halves of
    /// the URI have to be exactly right.
    #[test]
    fn an_image_data_uri_carries_the_type_and_round_trips_the_bytes() {
        use base64::Engine;

        let bytes: Vec<u8> = (0u8..=255).collect();
        let uri = image_data_uri("image/png", &bytes);
        let payload = uri
            .strip_prefix("data:image/png;base64,")
            .expect("the prefix names the media type and the encoding");
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(payload)
                .expect("the payload is valid base64"),
            bytes,
            "every byte survives the round trip"
        );
        // Empty input still produces a well-formed (empty-payload) URI; the fetch path
        // rejects empty bodies before reaching here.
        assert_eq!(image_data_uri("image/gif", &[]), "data:image/gif;base64,");
    }

    /// The signature plus an IHDR chunk header — everything [`sniff_png`] reads, and
    /// nothing a decoder could act on.
    fn png_fixture(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = PNG_SIGNATURE.to_vec();
        bytes.extend_from_slice(&13u32.to_be_bytes());
        bytes.extend_from_slice(b"IHDR");
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes
    }

    /// Signature, logical screen descriptor, then the packed flags byte (bit 7 = a global
    /// colour table follows, low three bits its size), background index, aspect ratio.
    fn gif_header(version: &[u8], width: u16, height: u16, flags: u8) -> Vec<u8> {
        let mut bytes = version.to_vec();
        bytes.extend_from_slice(&width.to_le_bytes());
        bytes.extend_from_slice(&height.to_le_bytes());
        bytes.extend_from_slice(&[flags, 0, 0]);
        bytes
    }

    /// An image descriptor — the rect Blink expands its decode bounds to contain.
    fn gif_descriptor(left: u16, top: u16, width: u16, height: u16) -> Vec<u8> {
        let mut bytes = vec![0x2c];
        for value in [left, top, width, height] {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        bytes.push(0); // packed fields: no local colour table
        bytes
    }

    /// A GIF whose first frame exactly fills its logical screen — the ordinary case, and
    /// the only one where the screen descriptor alone would have been the right answer.
    fn gif_fixture(version: &[u8], width: u16, height: u16) -> Vec<u8> {
        let mut bytes = gif_header(version, width, height, 0x00);
        bytes.extend_from_slice(&gif_descriptor(0, 0, width, height));
        bytes
    }

    /// One JPEG marker segment: `0xFF`, the marker, then a length counting its own bytes.
    fn jpeg_segment(marker: u8, payload: &[u8]) -> Vec<u8> {
        let mut segment = vec![0xff, marker];
        let length = u16::try_from(payload.len() + 2).expect("fixture payloads are small");
        segment.extend_from_slice(&length.to_be_bytes());
        segment.extend_from_slice(payload);
        segment
    }

    /// SOI, whatever `leading` bytes the walk has to step over, then a frame header.
    fn jpeg_fixture(sof_marker: u8, leading: &[u8], width: u16, height: u16) -> Vec<u8> {
        let mut frame = vec![8u8]; // sample precision
        frame.extend_from_slice(&height.to_be_bytes());
        frame.extend_from_slice(&width.to_be_bytes());
        frame.extend_from_slice(&[1, 1, 0x11, 0]); // a single component
        let mut bytes = vec![0xff, 0xd8];
        bytes.extend_from_slice(leading);
        bytes.extend_from_slice(&jpeg_segment(sof_marker, &frame));
        bytes
    }

    /// A RIFF/WEBP container around one chunk, which is all the sniffer looks at.
    fn webp_fixture(fourcc: &[u8], payload: &[u8]) -> Vec<u8> {
        let chunk_size = u32::try_from(payload.len()).expect("fixture payloads are small");
        let mut bytes = b"RIFF".to_vec();
        bytes.extend_from_slice(&(chunk_size + 12).to_le_bytes());
        bytes.extend_from_slice(b"WEBP");
        bytes.extend_from_slice(fourcc);
        bytes.extend_from_slice(&chunk_size.to_le_bytes());
        bytes.extend_from_slice(payload);
        bytes
    }

    fn webp_lossy_fixture(width: u16, height: u16) -> Vec<u8> {
        let mut payload = vec![0x00, 0x00, 0x00, 0x9d, 0x01, 0x2a];
        payload.extend_from_slice(&width.to_le_bytes());
        payload.extend_from_slice(&height.to_le_bytes());
        webp_fixture(b"VP8 ", &payload)
    }

    fn webp_lossless_fixture(width: u32, height: u32) -> Vec<u8> {
        let mut payload = vec![0x2f];
        payload.extend_from_slice(&((width - 1) | ((height - 1) << 14)).to_le_bytes());
        webp_fixture(b"VP8L", &payload)
    }

    fn webp_extended_fixture(width: u32, height: u32) -> Vec<u8> {
        let mut payload = vec![0x00, 0x00, 0x00, 0x00]; // flags plus 3 reserved bytes
        payload.extend_from_slice(&(width - 1).to_le_bytes()[..3]);
        payload.extend_from_slice(&(height - 1).to_le_bytes()[..3]);
        webp_fixture(b"VP8X", &payload)
    }

    #[test]
    fn sniff_image_reads_a_png_ihdr_header() {
        assert_eq!(
            sniff_image(&png_fixture(1200, 630)),
            Some(("image/png", 1200, 630))
        );
        // The chunk type is checked, not assumed: IHDR must come first.
        let mut wrong_chunk = png_fixture(1200, 630);
        wrong_chunk[12..16].copy_from_slice(b"iCCP");
        assert_eq!(sniff_image(&wrong_chunk), None);
    }

    /// Both GIF versions share the header the dimensions sit in, and only those two
    /// spellings are a GIF at all.
    #[test]
    fn sniff_image_reads_both_gif_versions() {
        assert_eq!(
            sniff_image(&gif_fixture(b"GIF87a", 640, 480)),
            Some(("image/gif", 640, 480))
        );
        assert_eq!(
            sniff_image(&gif_fixture(b"GIF89a", 16, 16)),
            Some(("image/gif", 16, 16))
        );
        assert_eq!(sniff_image(&gif_fixture(b"GIF88a", 16, 16)), None);
    }

    /// Blink does not decode into the logical screen size: Skia's `SkWuffsCodec` leaves
    /// wuffs' default bounds-expansion behaviour on, so the decoder allocates for the
    /// union of the screen and the first frame's rect. The union is what must come back.
    #[test]
    fn sniff_image_expands_a_gif_to_contain_its_first_frame() {
        // A frame larger than its screen: neither the screen size nor the frame size
        // alone is the answer.
        let mut grown = gif_header(b"GIF89a", 1, 1, 0x00);
        grown.extend_from_slice(&gif_descriptor(0, 0, 600, 400));
        assert_eq!(sniff_image(&grown), Some(("image/gif", 600, 400)));

        // The frame's POSITION extends the bounds too, not only its size.
        let mut offset = gif_header(b"GIF89a", 10, 10, 0x00);
        offset.extend_from_slice(&gif_descriptor(100, 50, 200, 100));
        assert_eq!(sniff_image(&offset), Some(("image/gif", 300, 150)));

        // A screen larger than the frame keeps the screen — a union, never a swap.
        let mut roomy = gif_header(b"GIF89a", 800, 600, 0x00);
        roomy.extend_from_slice(&gif_descriptor(0, 0, 10, 10));
        assert_eq!(sniff_image(&roomy), Some(("image/gif", 800, 600)));
    }

    /// The bypass this closes: a GIF reading as 1x1 by its screen descriptor while its
    /// first frame declares the raster the decoder actually allocates.
    #[test]
    fn a_gif_hiding_a_huge_frame_behind_a_tiny_screen_is_refused() {
        let mut bomb = gif_header(b"GIF89a", 1, 1, 0x00);
        bomb.extend_from_slice(&gif_descriptor(0, 0, 60000, 60000));
        assert_eq!(sniff_image(&bomb), Some(("image/gif", 60000, 60000)));
        assert_eq!(checked_image_type(&bomb), None);

        // The same hiding place reached through the frame's position instead of its size.
        let mut placed = gif_header(b"GIF89a", 1, 1, 0x00);
        placed.extend_from_slice(&gif_descriptor(65000, 65000, 1000, 1000));
        assert_eq!(sniff_image(&placed), Some(("image/gif", 66000, 66000)));
        assert_eq!(checked_image_type(&placed), None);

        // Every descriptor field is u16, so this is the largest raster the format can
        // ask for — and the union arithmetic must not wrap on it.
        let mut worst = gif_header(b"GIF89a", 1, 1, 0x00);
        worst.extend_from_slice(&gif_descriptor(65535, 65535, 65535, 65535));
        assert_eq!(sniff_image(&worst), Some(("image/gif", 131070, 131070)));
        assert_eq!(checked_image_type(&worst), None);
    }

    /// Real GIFs put a colour table and extension blocks between the header and the first
    /// descriptor, so reaching it means walking them rather than assuming offset 13.
    #[test]
    fn sniff_image_walks_a_gif_past_its_colour_table_and_extensions() {
        // A global colour table, size code 1 — 3 * 2^2 = 12 bytes to step over.
        let mut with_table = gif_header(b"GIF89a", 40, 30, 0x80 | 0x01);
        with_table.extend_from_slice(&[0u8; 12]);
        with_table.extend_from_slice(&gif_descriptor(0, 0, 40, 30));
        assert_eq!(sniff_image(&with_table), Some(("image/gif", 40, 30)));

        // The animated layout: a graphic control extension ahead of the frame, then a
        // comment extension with two sub-blocks, which is what exercises the inner loop.
        let mut animated = gif_header(b"GIF89a", 40, 30, 0x00);
        animated.extend_from_slice(&[0x21, 0xf9, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00]);
        animated.extend_from_slice(&[0x21, 0xfe, 0x03, b'a', b'b', b'c', 0x02, b'd', b'e', 0x00]);
        animated.extend_from_slice(&gif_descriptor(0, 0, 40, 30));
        assert_eq!(sniff_image(&animated), Some(("image/gif", 40, 30)));

        // A maximal colour table and an extension together, with the frame still growing
        // the bounds past the screen.
        let mut both = gif_header(b"GIF89a", 1, 1, 0x80 | 0x07);
        both.extend_from_slice(&[0u8; 768]);
        both.extend_from_slice(&[0x21, 0xf9, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00]);
        both.extend_from_slice(&gif_descriptor(0, 0, 500, 500));
        assert_eq!(sniff_image(&both), Some(("image/gif", 500, 500)));
    }

    /// A GIF whose first block is the trailer, or anything the walk does not recognize,
    /// never reaches a descriptor. Refused rather than gated on the screen size alone,
    /// which is exactly the field a hostile file controls independently of the frame.
    #[test]
    fn sniff_image_refuses_a_gif_with_no_image_descriptor() {
        let mut trailer = gif_header(b"GIF89a", 100, 100, 0x00);
        trailer.push(0x3b);
        assert_eq!(sniff_image(&trailer), None);

        // A header with nothing after it, and a byte that starts no block at all.
        assert_eq!(sniff_image(&gif_header(b"GIF89a", 100, 100, 0x00)), None);
        let mut junk = gif_header(b"GIF89a", 100, 100, 0x00);
        junk.push(0x5a);
        assert_eq!(sniff_image(&junk), None);

        // A colour table the file does not actually contain swallows the descriptor.
        let mut lying = gif_header(b"GIF89a", 100, 100, 0x80 | 0x07);
        lying.extend_from_slice(&gif_descriptor(0, 0, 100, 100));
        assert_eq!(sniff_image(&lying), None);

        // A body of nothing but empty extensions is walked to its end, not spun on: each
        // block consumes at least the byte that introduces it.
        let mut endless = gif_header(b"GIF89a", 100, 100, 0x00);
        for _ in 0..100_000 {
            endless.extend_from_slice(&[0x21, 0xfe, 0x00]);
        }
        let started = std::time::Instant::now();
        assert_eq!(sniff_image(&endless), None);
        let elapsed = started.elapsed();
        assert!(
            elapsed < Duration::from_secs(5),
            "the block walk took {elapsed:?} — it does not terminate"
        );
    }

    #[test]
    fn sniff_image_reads_a_jpeg_frame_header_right_after_the_soi() {
        assert_eq!(
            sniff_image(&jpeg_fixture(0xc0, &[], 800, 400)),
            Some(("image/jpeg", 800, 400))
        );
    }

    /// A real JPEG opens with segments the walk must step over, and each states a length
    /// rather than a terminator — reading the frame at a fixed offset would read noise.
    #[test]
    fn sniff_image_walks_past_leading_segments_to_the_frame_header() {
        let mut leading = jpeg_segment(0xe0, b"JFIF\0\x01\x02\0\0\x01\0\x01\0\0");
        leading.extend_from_slice(&jpeg_segment(0xe1, &[0u8; 64]));
        leading.extend_from_slice(&jpeg_segment(0xdb, &[0u8; 65]));
        // A restart marker stands alone — no length follows it.
        leading.extend_from_slice(&[0xff, 0xd0]);
        assert_eq!(
            sniff_image(&jpeg_fixture(0xc0, &leading, 1024, 768)),
            Some(("image/jpeg", 1024, 768))
        );
        // Fill bytes before a marker are legal and must not be read as the marker.
        let mut padded = vec![0xffu8, 0xff, 0xff];
        padded.extend_from_slice(&jpeg_segment(0xe0, b"JFIF\0"));
        assert_eq!(
            sniff_image(&jpeg_fixture(0xc0, &padded, 20, 30)),
            Some(("image/jpeg", 20, 30))
        );
    }

    /// Progressive JPEGs open SOF2, and every frame header in the SOF range states its
    /// size identically — the range is what is matched, not SOF0 alone.
    #[test]
    fn sniff_image_accepts_a_progressive_jpeg_frame_header() {
        assert_eq!(
            sniff_image(&jpeg_fixture(0xc2, &[], 1920, 1080)),
            Some(("image/jpeg", 1920, 1080))
        );
        // DHT, the JPEG extensions marker, and DAC sit inside the SOF byte range without
        // being frame headers; reading one as a frame would take its payload for a size.
        for marker in [0xc4u8, 0xc8, 0xcc] {
            assert!(!is_start_of_frame(marker), "{marker:#x} is not a frame");
        }
    }

    /// WebP states its size in whichever of three bitstreams the file opens with, each
    /// encoding it differently — one reader would be right for at most one of them.
    #[test]
    fn sniff_image_reads_all_three_webp_bitstreams() {
        assert_eq!(
            sniff_image(&webp_lossy_fixture(1200, 630)),
            Some(("image/webp", 1200, 630))
        );
        assert_eq!(
            sniff_image(&webp_lossless_fixture(300, 200)),
            Some(("image/webp", 300, 200))
        );
        assert_eq!(
            sniff_image(&webp_extended_fixture(4000, 2000)),
            Some(("image/webp", 4000, 2000))
        );
    }

    #[test]
    fn sniff_image_refuses_unknown_magic_bytes() {
        for bytes in [
            // Inert fixtures: headers only, nothing any decoder would act on.
            b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>".to_vec(),
            b"BM\x36\x00\x00\x00".to_vec(),
            b"\x00\x00\x01\x00\x01\x00".to_vec(),
            b"II*\x00".to_vec(),
            b"%PDF-1.7".to_vec(),
            Vec::new(),
            vec![0u8; 64],
        ] {
            assert_eq!(sniff_image(&bytes), None, "{bytes:?} is not a carried image");
        }
        // A well-formed container whose first chunk is one this module cannot read is
        // still a refusal, not a guess.
        assert_eq!(sniff_image(&webp_fixture(b"ANIM", &[0u8; 16])), None);
        assert_eq!(sniff_image(&webp_fixture(b"VP8L", &[0x00; 5])), None);
    }

    /// Every format's header can be cut mid-field by a hostile host or the byte cap. Each
    /// reader must answer `None` rather than read past its slice, so every prefix short of
    /// the bytes it needs is checked — which also pins how far each one reads.
    #[test]
    fn sniff_image_refuses_a_header_cut_short() {
        let fixtures = [
            (png_fixture(100, 100), 24),
            // 13 header bytes, the image separator, and its four dimension fields — the
            // descriptor's own trailing flags byte is never read.
            (gif_fixture(b"GIF89a", 100, 100), 22),
            (jpeg_fixture(0xc0, &[], 100, 100), 11),
            (webp_lossy_fixture(100, 100), 30),
            (webp_lossless_fixture(100, 100), 25),
            (webp_extended_fixture(100, 100), 30),
        ];
        for (full, needed) in fixtures {
            assert!(
                sniff_image(&full[..needed]).is_some(),
                "{needed} bytes is the whole header"
            );
            for cut in 0..needed {
                assert_eq!(
                    sniff_image(&full[..cut]),
                    None,
                    "a {cut}-byte prefix must not parse"
                );
            }
        }
    }

    /// A segment length below 2 is malformed — it would claim a payload shorter than its
    /// own length field. The guard is a validity check, not the walk's termination proof:
    /// `i` is already past the marker when a length is read. The bound only detects a hang.
    #[test]
    fn sniff_image_refuses_a_jpeg_segment_length_below_two() {
        let started = std::time::Instant::now();
        for length in [0u16, 1] {
            // On an APP0 the next iteration's marker check would refuse anyway, so this
            // arm alone cannot tell whether the guard is present.
            let mut app0 = vec![0xffu8, 0xd8, 0xff, 0xe0];
            app0.extend_from_slice(&length.to_be_bytes());
            app0.extend_from_slice(&[0u8; 4096]);
            assert_eq!(sniff_image(&app0), None, "APP0 length {length} is refused");

            // On a frame header it is verdict-relevant: the dimensions are read straight
            // out of the segment, so without the guard these bytes return a size.
            let mut frame = vec![0xffu8, 0xd8, 0xff, 0xc0];
            frame.extend_from_slice(&length.to_be_bytes());
            frame.extend_from_slice(&[0x08, 0x00, 0x64, 0x00, 0x64, 0x01, 0x01, 0x11, 0x00]);
            assert_eq!(sniff_image(&frame), None, "SOF length {length} is refused");
        }
        let elapsed = started.elapsed();
        assert!(
            elapsed < Duration::from_secs(5),
            "the marker walk took {elapsed:?} — it does not terminate"
        );
    }

    /// A JPEG that reaches the scan data or the end of the image without a frame header
    /// never declares a size, so there is nothing to gate and nothing to carry.
    ///
    /// Both fixtures carry a frame-shaped byte run past the marker that ends the chain,
    /// so each arm has to do the refusing — bytes after an EOI, and entropy-coded scan
    /// data, are both attacker-controlled and can spell anything.
    #[test]
    fn sniff_image_refuses_a_jpeg_with_no_frame_header() {
        let mut ended = vec![0xffu8, 0xd8];
        ended.extend_from_slice(&jpeg_segment(0xe0, b"JFIF\0"));
        ended.extend_from_slice(&[0xff, 0xd9]); // EOI
        // Length-shaped bytes, then a frame header the walk would reach if EOI did not
        // stop it. (The SOI is stripped: what follows is the segment alone.)
        ended.extend_from_slice(&[0x00, 0x02]);
        ended.extend_from_slice(&jpeg_fixture(0xc0, &[], 3000, 3000)[2..]);
        assert_eq!(sniff_image(&ended), None);

        let mut scanned = vec![0xffu8, 0xd8];
        scanned.extend_from_slice(&jpeg_segment(0xe0, b"JFIF\0"));
        scanned.extend_from_slice(&jpeg_segment(0xda, &[0u8; 8])); // SOS
        scanned.extend_from_slice(&jpeg_fixture(0xc0, &[], 4000, 4000)[2..]);
        assert_eq!(sniff_image(&scanned), None);

        // Running out of bytes mid-chain is the same answer, and a marker byte that never
        // arrives is too.
        assert_eq!(sniff_image(&[0xff, 0xd8, 0xff, 0xe0, 0x00, 0x40]), None);
        assert_eq!(sniff_image(&[0xff, 0xd8, 0x00, 0xe0]), None);
    }

    /// Zero and over-cap rasters are refused whatever format declares them. The 8000x8000
    /// case is the one that proves the pixel cap is independently live: both of its axes
    /// clear the per-axis cap, and only the area check refuses it.
    #[test]
    fn the_dimension_caps_refuse_zero_and_oversized_rasters() {
        // An 8000-pixel axis clears the per-axis cap on its own, so nothing but the area
        // check can refuse 8000x8000.
        assert!(dimensions_within_caps(8000, 1));
        assert!(dimensions_within_caps(1, 8000));
        for (width, height) in [
            (0, 100),
            (100, 0),
            (0, 0),
            (MAX_IMAGE_DIMENSION + 1, 10),
            (10, MAX_IMAGE_DIMENSION + 1),
            (8000, 8000),
        ] {
            assert!(
                !dimensions_within_caps(width, height),
                "{width}x{height} must be refused"
            );
            assert_eq!(
                checked_image_type(&png_fixture(width, height)),
                None,
                "{width}x{height} must not reach a data URI"
            );
        }
    }

    /// The stated ceilings are accepts: a cap biting one short of its value would drop
    /// legitimate images with nothing to show for it.
    #[test]
    fn the_dimension_caps_accept_their_exact_boundaries() {
        assert!(dimensions_within_caps(1, 1));
        assert!(dimensions_within_caps(MAX_IMAGE_DIMENSION, 4000));
        assert!(dimensions_within_caps(4000, MAX_IMAGE_DIMENSION));
        assert_eq!(
            checked_image_type(&png_fixture(MAX_IMAGE_DIMENSION, 4000)),
            Some("image/png")
        );
        // Exactly at the area ceiling, with both axes inside the per-axis one.
        assert_eq!(u64::from(8000u32) * 5000, MAX_IMAGE_PIXELS);
        assert_eq!(
            checked_image_type(&webp_extended_fixture(8000, 5000)),
            Some("image/webp")
        );
        // One pixel past it is not.
        assert!(!dimensions_within_caps(8000, 5001));
    }

    /// The transport header decides only whether the body is read at all; the type the
    /// data URI carries comes from the bytes. [`encode_checked_image`] is the whole
    /// post-read path `load_image_data_uri` runs, and it takes no content type — so the
    /// header cannot reach the URI without that signature changing, which no edit does by
    /// accident. Only the pre-read header filter needs a live response and stays untested.
    #[test]
    fn the_sniffed_type_wins_over_the_transport_header() {
        let gif = gif_fixture(b"GIF89a", 8, 8);
        // The header a hostile host would send, and what the bytes actually are.
        assert_eq!(image_media_type("image/png").as_deref(), Some("image/png"));
        assert_eq!(sniff_image(&gif), Some(("image/gif", 8, 8)));
        assert!(encode_checked_image(&gif, false)
            .expect("a tiny GIF clears the caps")
            .starts_with("data:image/gif;base64,"));

        // The same seam carries the read's verdict and both refusals it owns.
        assert_eq!(encode_checked_image(&gif, true), None);
        assert_eq!(encode_checked_image(&[], false), None);
        assert_eq!(encode_checked_image(&png_fixture(9000, 9000), false), None);
        assert_eq!(encode_checked_image(b"not an image at all", false), None);
    }

    #[test]
    fn an_unterminated_tag_or_quote_does_not_lose_earlier_metadata() {
        let cut_mid_tag = r#"<meta property="og:title" content="Good"><meta property="og:desc"#;
        assert_eq!(preview(cut_mid_tag).title.as_deref(), Some("Good"));

        let unclosed_quote = r#"<meta property="og:title" content="never closed"#;
        assert_eq!(preview(unclosed_quote), ParsedPreview::default());

        // A bare `<meta` at the very end is not a tag and must not panic.
        assert_eq!(preview("<meta"), ParsedPreview::default());
        assert_eq!(preview("<title"), ParsedPreview::default());
        // A `<title>` with no `</title>` has no determinate text, so it yields nothing
        // rather than swallowing the rest of the document.
        assert_eq!(preview("<title>unterminated element").title, None);
    }

    /// A 512 KiB body of open tags made every occurrence rescan to EOF — quadratic, and
    /// minutes of a tokio worker at the body cap. The wall-clock bound is a hang
    /// detector with three orders of magnitude of headroom, not a performance assertion:
    /// the pre-fix code needs minutes here, the fixed code microseconds.
    #[test]
    fn a_pathological_body_of_open_tags_parses_promptly() {
        let base = url("https://example.com/p");
        let cases = [
            "<meta ".repeat(MAX_BODY_BYTES / "<meta ".len()),
            "<meta a=\"".repeat(MAX_BODY_BYTES / "<meta a=\"".len()),
            // Terminated, but every occurrence would scan to that single closing `>`.
            format!("{}>", "<meta ".repeat(MAX_BODY_BYTES / "<meta ".len())),
            "<title".repeat(MAX_BODY_BYTES / "<title".len()),
        ];
        for body in cases {
            assert!(body.len() >= MAX_BODY_BYTES - 16, "the case fills the cap");
            let started = std::time::Instant::now();
            let got = preview_from_html(&body, &base);
            let elapsed = started.elapsed();
            assert_eq!(got, ParsedPreview::default());
            assert!(
                elapsed < Duration::from_secs(5),
                "harvest took {elapsed:?} — the scan is not linear"
            );
        }
    }

    /// Three layers, because the outer two can each pass for the wrong reason. The
    /// `guard_hop` arm is the precise "why". The shared loop must then fail with a
    /// REFUSAL (`InvalidArgument`) and not a transport error (`Command`) — that is what
    /// distinguishes "the guard rejected it" from "the request was attempted and
    /// failed", and it is the arm that catches a guard moved after the send. The public
    /// entry's `None` pins the chain the command actually calls, but a bypass would
    /// still yield `None` once the doomed request errored, so the elapsed bound below is
    /// what gives that arm teeth.
    ///
    /// Every arm resolves offline: a blocked literal never reaches DNS, `localhost` is
    /// name-blocked before the lookup, `file://` fails the scheme check, and an
    /// unparseable candidate is dropped before any of it.
    #[tokio::test]
    async fn a_private_network_image_url_is_refused_before_any_request() {
        let started = std::time::Instant::now();
        for candidate in [
            // Inert paths on purpose: if a regression ever lets one of these through,
            // the suite must not be the thing that acts on the developer's own LAN.
            "http://192.168.1.1/cover.png",
            "http://127.0.0.1:8080/x.png",
            "http://169.254.169.254/latest/meta-data",
            "http://[::1]/x.png",
            "http://[::ffff:10.0.0.1]/x.png",
            "http://localhost/x.png",
            "file:///etc/passwd",
        ] {
            let target = Url::parse(candidate).expect("the candidate is a parseable URL");
            assert!(
                guard_hop(&target).await.is_err(),
                "{candidate} must be refused before any request"
            );
            match fetch_following_redirects(target).await {
                Err(AppError::InvalidArgument(_)) => {}
                Err(other) => panic!("{candidate} failed in transit, not at the guard: {other}"),
                Ok(_) => panic!("{candidate} must never be requested"),
            }
            assert!(
                fetch_image_data(candidate).await.is_none(),
                "{candidate} must not be fetched"
            );
        }
        // A public literal clears the guard, again without touching DNS.
        assert!(guard_hop(&url("https://93.184.216.34/cover.png"))
            .await
            .is_ok());
        // An unparseable candidate is dropped before the guard is ever consulted.
        assert!(Url::parse("not a url").is_err());
        assert!(fetch_image_data("not a url").await.is_none());

        // Refusals are decided in memory, so the whole loop is sub-millisecond work. A
        // path that reached the network would spend seconds here failing to connect
        // (6.64s measured with the guard removed), which is the only way the `None`
        // assertions above can be caught passing for the wrong reason.
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "refusals took {:?} — something attempted a connection",
            started.elapsed()
        );
    }

    /// The examined-tag bound is what makes the scan linear regardless of body shape;
    /// a page under it is unaffected.
    #[test]
    fn metadata_before_the_examined_tag_bound_is_still_read() {
        let filler = r#"<meta name="x" content="y">"#.repeat(MAX_META_TAGS - 1);
        let html = format!(r#"{filler}<meta property="og:title" content="Found">"#);
        assert_eq!(preview(&html).title.as_deref(), Some("Found"));
    }

    /// The mirror of the arm above, pinning the boundary from the far side: without it
    /// nothing fails if the bound stops biting, since the pathological bodies stay
    /// inside the hang bound on the tag window alone.
    #[test]
    fn metadata_past_the_examined_tag_bound_is_dropped() {
        let filler = r#"<meta name="x" content="y">"#.repeat(MAX_META_TAGS);
        let html = format!(r#"{filler}<meta property="og:title" content="Too late">"#);
        assert_eq!(preview(&html).title, None);
    }
}
