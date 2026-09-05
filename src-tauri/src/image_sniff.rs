//! Image format sniffing and decode caps, shared by every surface that hands bytes to
//! the webview as a `data:` URI.
//!
//! The format is read from the magic bytes rather than from any declared type: a
//! response header and a file extension are both chosen by whoever supplied the bytes,
//! and the format has to be known to bound the decode the webview will perform. The
//! raster comes out of the header alone — nothing here is decoded — because a byte cap
//! bounds only the compressed copy, and a few KB can declare a raster that kills the
//! renderer.

const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

/// Ceilings on the raster an image DECLARES, read from its header before the bytes reach
/// the webview.
const MAX_IMAGE_DIMENSION: u32 = 8192;
/// The area ceiling, which bites where the per-axis one does not. Deliberate headroom at
/// ~20x any ordinary web image: the largest raster it admits peaks near 160 MB of RGBA
/// while the webview decodes it.
const MAX_IMAGE_PIXELS: u64 = 40_000_000;

/// A fixed-width field at `at`, or `None` when the slice ends first. Every dimension read
/// below goes through here, so a header cut short can only ever yield `None`.
fn header_field<const N: usize>(bytes: &[u8], at: usize) -> Option<[u8; N]> {
    bytes.get(at..at.checked_add(N)?)?.try_into().ok()
}

/// A 24-bit little-endian field — WebP's extended-format canvas dimensions.
fn le_u24_at(bytes: &[u8], at: usize) -> Option<u32> {
    let triple: [u8; 3] = header_field(bytes, at)?;
    Some(u32::from_le_bytes([triple[0], triple[1], triple[2], 0]))
}

/// The four raster containers this module reads, named by magic bytes alone.
enum RasterMagic {
    Png,
    Gif,
    Jpeg,
    Webp,
}

/// Which container the bytes OPEN with, before any header is read. The single
/// dispatch [`sniff_image`] and [`has_raster_magic`] share, so the format a caller
/// recognizes and the format the sniffer tries to read can never drift apart.
fn raster_magic(bytes: &[u8]) -> Option<RasterMagic> {
    if bytes.starts_with(PNG_SIGNATURE) {
        return Some(RasterMagic::Png);
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some(RasterMagic::Gif);
    }
    if bytes.starts_with(&[0xff, 0xd8]) {
        return Some(RasterMagic::Jpeg);
    }
    if bytes.starts_with(b"RIFF") && header_field::<4>(bytes, 8) == Some(*b"WEBP") {
        return Some(RasterMagic::Webp);
    }
    None
}

/// Whether the bytes open with a raster container this module dispatches on, whatever
/// its header turns out to say. A caller pairs this with [`sniff_image`] to tell the
/// two reasons that function answers `None` apart: bytes that are no raster at all,
/// and a recognized container whose header the walk refuses — which is a REFUSAL, not
/// a clean bill of health.
pub(crate) fn has_raster_magic(bytes: &[u8]) -> bool {
    raster_magic(bytes).is_some()
}

/// The format some bytes actually are, and the raster their HEADER declares — header
/// fields only, nothing is decoded. `None` when the bytes are not one of the four raster
/// formats this module reads, or when the header they need is truncated or malformed;
/// [`has_raster_magic`] separates those two cases.
pub(crate) fn sniff_image(bytes: &[u8]) -> Option<(&'static str, u32, u32)> {
    match raster_magic(bytes)? {
        RasterMagic::Png => sniff_png(bytes),
        RasterMagic::Gif => sniff_gif(bytes),
        RasterMagic::Jpeg => sniff_jpeg(bytes),
        RasterMagic::Webp => sniff_webp(bytes),
    }
}

/// IHDR carries the dimensions and the spec requires it to be the first chunk, so a PNG
/// whose 12..16 is anything else is malformed rather than merely ordered oddly.
fn sniff_png(bytes: &[u8]) -> Option<(&'static str, u32, u32)> {
    if header_field::<4>(bytes, 12)? != *b"IHDR" {
        return None;
    }
    let width = u32::from_be_bytes(header_field(bytes, 16)?);
    let height = u32::from_be_bytes(header_field(bytes, 20)?);
    Some(("image/png", width, height))
}

/// The size a GIF is decoded at is NOT its logical screen descriptor. Blink decodes GIFs
/// through Skia's `SkWuffsCodec`, which enables only wuffs' ignore-too-much-pixel-data
/// quirk, leaving the default behaviour — stated in wuffs' own `decode_quirks.wuffs` —
/// of expanding the image bounds to contain the FIRST frame's rect. Both descriptor
/// fields are `u16`, so a 1x1 screen can front a 131070-per-axis allocation, and desktop
/// Blink sets no decoded-size ceiling of its own. Later frames are clipped to those
/// bounds, so gating the union of screen and first frame is the whole exposure. That is
/// the WINDOWS webview (WebView2); macOS ships WKWebView and Linux webkit2gtk, for which
/// the union is a conservative upper bound — no decoder can allocate past it.
///
/// Terminates on any input: every block consumes at least the byte that introduces it,
/// and a zero-length sub-block is the terminator consuming its own length byte, so `i`
/// strictly increases and each read is bounds-checked.
fn sniff_gif(bytes: &[u8]) -> Option<(&'static str, u32, u32)> {
    let screen_width = u32::from(u16::from_le_bytes(header_field(bytes, 6)?));
    let screen_height = u32::from(u16::from_le_bytes(header_field(bytes, 8)?));
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
                let left = u32::from(u16::from_le_bytes(header_field(bytes, i + 1)?));
                let top = u32::from(u16::from_le_bytes(header_field(bytes, i + 3)?));
                let width = u32::from(u16::from_le_bytes(header_field(bytes, i + 5)?));
                let height = u32::from(u16::from_le_bytes(header_field(bytes, i + 7)?));
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
/// DHT (0xC4), the JPEG extensions marker (0xC8), and DAC (0xCC). The walk refuses 0xC8
/// with the fatal-marker classes before asking; its exclusion here is a second layer.
fn is_start_of_frame(marker: u8) -> bool {
    (0xc0..=0xcf).contains(&marker) && !matches!(marker, 0xc4 | 0xc8 | 0xcc)
}

/// Walk the marker chain to the first frame header, where a JPEG states its size.
///
/// The invariant: the walk may never advance past bytes libjpeg would still scan for
/// markers. Every marker this walk length-skips is one libjpeg consumes by the same
/// self-counting arithmetic, or rejects while validating its payload (DRI, DHT, DQT,
/// DAC); the markers libjpeg fatally rejects are refused below; the parameterless ones
/// (TEM, RST) advance by the marker alone as libjpeg does; everything else refuses or
/// returns.
///
/// Over-gating a SOF variant libjpeg cannot decode costs nothing.
///
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
        // `FF 00` is a stuffed pair libjpeg DISCARDS mid-scan (jdmarker.c's next_marker)
        // and keeps scanning, so consuming the two bytes after it as a length jumps clean
        // over the frame header libjpeg still reads; libjpeg refuses a repeated SOI
        // outright (JERR_SOI_DUPLICATE). Neither byte is length-bearing, so both refuse
        // here.
        if marker == 0x00 || marker == 0xd8 {
            return None;
        }
        // TEM and the restart markers stand alone, carrying no length or payload.
        if marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
            continue;
        }
        // The fatally-rejected markers that are NOT frame headers: the reserved range,
        // plus the unsupported JPG, DHP, EXP and JPGn classes. A file carrying one never
        // decodes, so refusing keeps every length-skip below one libjpeg performs too.
        // (The unsupported SOF variants gate instead — over-gating undecodable is free.)
        if matches!(marker, 0x02..=0xbf | 0xc8 | 0xde | 0xdf | 0xf0..=0xfd) {
            return None;
        }
        // A segment's length counts its own two bytes, so anything under 2 is malformed.
        let length = usize::from(u16::from_be_bytes(header_field(bytes, i)?));
        if length < 2 {
            return None;
        }
        if is_start_of_frame(marker) {
            // T.81 fixes a frame header at 8 + 3 * Nf bytes, and libjpeg's get_sof errors
            // on any other length. Slicing the whole segment forces it in-buffer, so a
            // size can never be read out of a frame header the decoder would itself
            // reject — a truncated or inconsistent one is not a size, it is a refusal.
            if length < 8 {
                return None;
            }
            let segment = bytes.get(i..i.checked_add(length)?)?;
            let components = usize::from(segment[7]);
            if components == 0 || length != 8 + 3 * components {
                return None;
            }
            // Segment-relative, like `segment[7]` above: the length fills 0..2, then one
            // precision byte, then height before width.
            let height = u16::from_be_bytes(header_field(segment, 3)?);
            let width = u16::from_be_bytes(header_field(segment, 5)?);
            return Some(("image/jpeg", width.into(), height.into()));
        }
        // Counting its own two bytes makes the length the whole step from here.
        i = i.checked_add(length)?;
    }
}

/// The three bitstream headers a WebP file can open with, each stating the size its own
/// way. The chunk header sits at 12 (fourcc plus size) and its payload at 20.
///
/// The chunk SIZE at 16..20 is deliberately unread: the fields read below sit at fixed
/// payload offsets whatever it says, and libwebp's demuxer refuses a VP8X declaring less
/// than its 10 payload bytes — so a disagreement here can only over-refuse.
fn sniff_webp(bytes: &[u8]) -> Option<(&'static str, u32, u32)> {
    let fourcc: [u8; 4] = header_field(bytes, 12)?;
    let payload = bytes.get(20..)?;
    let (width, height) = match &fourcc {
        b"VP8 " => {
            // A 3-byte frame tag, the sync code, then two dimensions whose top 2 bits are
            // a scaling hint rather than size.
            if header_field::<3>(payload, 3)? != [0x9d, 0x01, 0x2a] {
                return None;
            }
            let width = u16::from_le_bytes(header_field(payload, 6)?) & 0x3fff;
            let height = u16::from_le_bytes(header_field(payload, 8)?) & 0x3fff;
            (u32::from(width), u32::from(height))
        }
        b"VP8L" => {
            if *payload.first()? != 0x2f {
                return None;
            }
            // 14 bits each, stored one less than the real dimension.
            let bits = u32::from_le_bytes(header_field(payload, 1)?);
            ((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1)
        }
        // A flags byte and 3 reserved, then the canvas size as two 24-bit fields, also
        // stored one less.
        b"VP8X" => (le_u24_at(payload, 4)? + 1, le_u24_at(payload, 7)? + 1),
        _ => return None,
    };
    Some(("image/webp", width, height))
}

/// Whether a declared raster is safe to hand the webview's decoder. Both caps bite: the
/// per-axis one bounds a single enormous edge, the pixel one a raster merely large on
/// both axes.
pub(crate) fn dimensions_within_caps(width: u32, height: u32) -> bool {
    width > 0
        && height > 0
        && width <= MAX_IMAGE_DIMENSION
        && height <= MAX_IMAGE_DIMENSION
        && u64::from(width) * u64::from(height) <= MAX_IMAGE_PIXELS
}

// ---------------------------------------------------------------------------
// Test fixtures
//
// Module-level rather than inside `mod tests` because callers of the sniffer test
// against them too; each builds only the header bytes its reader looks at, so no
// fixture is anything a decoder could act on.
// ---------------------------------------------------------------------------

/// The signature plus an IHDR chunk header — everything [`sniff_png`] reads, and
/// nothing a decoder could act on.
#[cfg(test)]
pub(crate) fn png_fixture(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = PNG_SIGNATURE.to_vec();
    bytes.extend_from_slice(&13u32.to_be_bytes());
    bytes.extend_from_slice(b"IHDR");
    bytes.extend_from_slice(&width.to_be_bytes());
    bytes.extend_from_slice(&height.to_be_bytes());
    bytes
}

/// Signature, logical screen descriptor, then the packed flags byte (bit 7 = a global
/// colour table follows, low three bits its size), background index, aspect ratio.
#[cfg(test)]
fn gif_header(version: &[u8], width: u16, height: u16, flags: u8) -> Vec<u8> {
    let mut bytes = version.to_vec();
    bytes.extend_from_slice(&width.to_le_bytes());
    bytes.extend_from_slice(&height.to_le_bytes());
    bytes.extend_from_slice(&[flags, 0, 0]);
    bytes
}

/// An image descriptor — the rect Blink expands its decode bounds to contain.
#[cfg(test)]
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
#[cfg(test)]
pub(crate) fn gif_fixture(version: &[u8], width: u16, height: u16) -> Vec<u8> {
    let mut bytes = gif_header(version, width, height, 0x00);
    bytes.extend_from_slice(&gif_descriptor(0, 0, width, height));
    bytes
}

/// One JPEG marker segment: `0xFF`, the marker, then a length counting its own bytes.
#[cfg(test)]
fn jpeg_segment(marker: u8, payload: &[u8]) -> Vec<u8> {
    let mut segment = vec![0xff, marker];
    let length = u16::try_from(payload.len() + 2).expect("fixture payloads are small");
    segment.extend_from_slice(&length.to_be_bytes());
    segment.extend_from_slice(payload);
    segment
}

/// A complete, self-consistent frame payload: precision, dimensions, and one
/// component, so `Lf` comes to 8 + 3 * 1 = 11 exactly as T.81 requires.
#[cfg(test)]
fn sof_payload(width: u16, height: u16) -> Vec<u8> {
    let mut payload = vec![8u8]; // sample precision
    payload.extend_from_slice(&height.to_be_bytes());
    payload.extend_from_slice(&width.to_be_bytes());
    payload.extend_from_slice(&[1, 1, 0x11, 0]); // a single component
    payload
}

/// SOI, whatever `leading` bytes the walk has to step over, then a frame header.
#[cfg(test)]
pub(crate) fn jpeg_fixture(sof_marker: u8, leading: &[u8], width: u16, height: u16) -> Vec<u8> {
    let mut bytes = vec![0xff, 0xd8];
    bytes.extend_from_slice(leading);
    bytes.extend_from_slice(&jpeg_segment(sof_marker, &sof_payload(width, height)));
    bytes
}

/// SOI, a stuffed `FF 00` pair, then a frame header declaring a raster past the caps.
/// The pair is not length-bearing, so the walk stops on it and reads no size — while
/// libjpeg's `next_marker` discards the pair and reads the frame header behind it.
/// The exact shape a caller's fail-closed arm has to refuse.
#[cfg(test)]
pub(crate) fn stuffed_pair_jpeg() -> Vec<u8> {
    let mut bytes = vec![0xffu8, 0xd8, 0xff, 0x00];
    bytes.extend_from_slice(&jpeg_fixture(0xc0, &[], 9000, 9000)[2..]);
    bytes
}

/// The desync layout, hand-rolled because the byte placement IS the test: a non
/// length-bearing pair whose following two bytes read as a length only if the walk is
/// wrong, sized to jump it over the real frame header and land it exactly on a decoy
/// hidden inside an APP0 payload.
#[cfg(test)]
fn jpeg_desync_fixture(pair: u8) -> Vec<u8> {
    let real = jpeg_segment(0xc0, &sof_payload(20000, 20000));
    let decoy = jpeg_segment(0xc0, &sof_payload(100, 100));
    let hiding_app0 = jpeg_segment(0xe0, &decoy);
    // A desynced walk resumes just past the fake length, so the jump has to cover the
    // length itself, the real frame header, and the APP0's own marker and length.
    let app0_header = hiding_app0.len() - decoy.len();
    let skip = u16::try_from(2 + real.len() + app0_header).expect("the fixture is small");

    let mut bytes = vec![0xff, 0xd8]; // SOI
    bytes.extend_from_slice(&[0xff, pair]);
    bytes.extend_from_slice(&skip.to_be_bytes());
    bytes.extend_from_slice(&real);
    bytes.extend_from_slice(&hiding_app0);
    bytes.extend_from_slice(&jpeg_segment(0xda, &[0u8; 6])); // SOS
    bytes
}

/// A RIFF/WEBP container around one chunk, which is all the sniffer looks at.
#[cfg(test)]
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

#[cfg(test)]
fn webp_lossy_fixture(width: u16, height: u16) -> Vec<u8> {
    let mut payload = vec![0x00, 0x00, 0x00, 0x9d, 0x01, 0x2a];
    payload.extend_from_slice(&width.to_le_bytes());
    payload.extend_from_slice(&height.to_le_bytes());
    webp_fixture(b"VP8 ", &payload)
}

#[cfg(test)]
fn webp_lossless_fixture(width: u32, height: u32) -> Vec<u8> {
    let mut payload = vec![0x2f];
    payload.extend_from_slice(&((width - 1) | ((height - 1) << 14)).to_le_bytes());
    webp_fixture(b"VP8L", &payload)
}

#[cfg(test)]
fn webp_extended_fixture(width: u32, height: u32) -> Vec<u8> {
    let mut payload = vec![0x00, 0x00, 0x00, 0x00]; // flags plus 3 reserved bytes
    payload.extend_from_slice(&(width - 1).to_le_bytes()[..3]);
    payload.extend_from_slice(&(height - 1).to_le_bytes()[..3]);
    webp_fixture(b"VP8X", &payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// The composition every caller applies: sniff, then gate on the declared raster.
    /// `None` for bytes that are not a sniffable raster OR declare one past the caps —
    /// which is why each arm below also asserts what [`sniff_image`] read.
    fn gated(bytes: &[u8]) -> Option<&'static str> {
        let (media_type, width, height) = sniff_image(bytes)?;
        dimensions_within_caps(width, height).then_some(media_type)
    }

    /// A caller's fail-closed arm keys on [`has_raster_magic`] while the type comes from
    /// [`sniff_image`], so the two must dispatch on exactly the same prefixes — a drift
    /// between them is a bypass, not a cosmetic mismatch. The middle group is the class
    /// that matters: magic present, header unreadable.
    #[test]
    fn has_raster_magic_covers_exactly_the_sniffer_dispatch() {
        for readable in [
            png_fixture(10, 10),
            gif_fixture(b"GIF89a", 10, 10),
            jpeg_fixture(0xc0, &[], 10, 10),
            webp_lossy_fixture(10, 10),
        ] {
            assert!(has_raster_magic(&readable));
            assert!(sniff_image(&readable).is_some());
        }

        let mut wrong_chunk = png_fixture(10, 10);
        wrong_chunk[12..16].copy_from_slice(b"iCCP");
        for unreadable in [
            // A stuffed `FF 00` pair stops the marker walk; the decoder skips it.
            stuffed_pair_jpeg(),
            wrong_chunk,
            // A GIF header with no image descriptor after it.
            gif_header(b"GIF89a", 10, 10, 0x00),
            // A WebP container whose first chunk this module cannot read.
            webp_fixture(b"ANIM", &[0u8; 16]),
        ] {
            assert!(
                has_raster_magic(&unreadable),
                "the magic still names a container"
            );
            assert_eq!(sniff_image(&unreadable), None);
        }

        for plain in [
            b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>".to_vec(),
            b"BM\x36\x00\x00\x00".to_vec(),
            // RIFF is not WebP on its own, and a form type that never arrives is not
            // one either — both must answer the same way here as in the dispatch.
            b"RIFF\x00\x00\x00\x00AVI ".to_vec(),
            b"RIFF".to_vec(),
            Vec::new(),
        ] {
            assert!(
                !has_raster_magic(&plain),
                "{plain:?} names no raster container"
            );
            assert_eq!(sniff_image(&plain), None);
        }
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
        assert_eq!(gated(&bomb), None);

        // The same hiding place reached through the frame's position instead of its size.
        let mut placed = gif_header(b"GIF89a", 1, 1, 0x00);
        placed.extend_from_slice(&gif_descriptor(65000, 65000, 1000, 1000));
        assert_eq!(sniff_image(&placed), Some(("image/gif", 66000, 66000)));
        assert_eq!(gated(&placed), None);

        // Every descriptor field is u16, so this is the largest raster the format can
        // ask for — and the union arithmetic must not wrap on it.
        let mut worst = gif_header(b"GIF89a", 1, 1, 0x00);
        worst.extend_from_slice(&gif_descriptor(65535, 65535, 65535, 65535));
        assert_eq!(sniff_image(&worst), Some(("image/gif", 131070, 131070)));
        assert_eq!(gated(&worst), None);
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
        // DHT sits inside the SOF byte range and is skipped by length, not refused:
        // libjpeg consumes a DHT by its declared length too (validating the payload as
        // it goes — the class keeps the walk in step, whatever these filler bytes are).
        assert_eq!(
            sniff_image(&jpeg_fixture(
                0xc0,
                &jpeg_segment(0xc4, &[0u8; 20]),
                320,
                240
            )),
            Some(("image/jpeg", 320, 240))
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
            assert_eq!(
                sniff_image(&bytes),
                None,
                "{bytes:?} is not a sniffed image"
            );
        }
        // A well-formed container whose first chunk is one this module cannot read is
        // still a refusal, not a guess.
        assert_eq!(sniff_image(&webp_fixture(b"ANIM", &[0u8; 16])), None);
        assert_eq!(sniff_image(&webp_fixture(b"VP8L", &[0x00; 5])), None);
    }

    /// Every format's header can be cut mid-field by a hostile source or a byte cap. Each
    /// reader must answer `None` rather than read past its slice, so every prefix short of
    /// the bytes it needs is checked — which pins each reader's MINIMUM. Only the GIF row
    /// also pins where a reader stops, its descriptor's trailing flags byte going unread.
    #[test]
    fn sniff_image_refuses_a_header_cut_short() {
        let fixtures = [
            (png_fixture(100, 100), 24),
            // 13 header bytes, the image separator, and its four dimension fields — the
            // descriptor's own trailing flags byte is never read.
            (gif_fixture(b"GIF89a", 100, 100), 22),
            // SOI, the marker, and the whole Lf=11 frame header — the completeness check
            // slices the entire segment, so a partial one is never read.
            (jpeg_fixture(0xc0, &[], 100, 100), 15),
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
    /// own length field. The `length < 2` guard is redundant: with it removed, another
    /// gate still refuses each arm below, so what this pins is the VERDICT rather than any
    /// one gate. The wall-clock bound only detects a hang.
    #[test]
    fn sniff_image_refuses_a_jpeg_segment_length_below_two() {
        let started = std::time::Instant::now();
        for length in [0u16, 1] {
            // On an APP0, a marker check refuses: any length under 2 leaves `i` on one of
            // the length field's own bytes — 0x00 for a length of 0, 0x01 for 1, never
            // 0xFF — so no marker is read there.
            let mut app0 = vec![0xffu8, 0xd8, 0xff, 0xe0];
            app0.extend_from_slice(&length.to_be_bytes());
            app0.extend_from_slice(&[0u8; 4096]);
            assert_eq!(sniff_image(&app0), None, "APP0 length {length} is refused");

            // On a frame header the completeness check also refuses it — T.81's smallest
            // `Lf` is 11, so anything under 8 is not a frame header at all.
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

    /// The gate is only worth anything where it agrees with the decoder about which bytes
    /// are a frame header. libjpeg's `next_marker` DISCARDS a stuffed `FF 00` and resumes
    /// scanning, so reading the two bytes after one as a segment length jumps the walk
    /// clean over the frame header libjpeg still finds. A repeated `FF D8` desyncs the
    /// same way here (libjpeg refuses it outright as a duplicate SOI). Neither is
    /// length-bearing, which is why both refuse.
    #[test]
    fn a_jpeg_that_desyncs_the_marker_walk_is_refused() {
        for pair in [0x00u8, 0xd8] {
            let bytes = jpeg_desync_fixture(pair);
            assert_eq!(sniff_image(&bytes), None, "FF {pair:02X} must be refused");
        }

        // The decoy is complete and self-consistent on its own, so the refusals above are
        // the marker arm rather than the completeness check firing by coincidence.
        assert_eq!(
            sniff_image(&jpeg_fixture(0xc0, &[], 100, 100)),
            Some(("image/jpeg", 100, 100))
        );

        // And the raster the decoder actually allocates for is the one the fixture hides:
        // reachable only with the walk in step, and far over the caps.
        let honest = jpeg_fixture(0xc0, &[], 20000, 20000);
        assert_eq!(sniff_image(&honest), Some(("image/jpeg", 20000, 20000)));
        assert_eq!(gated(&honest), None);
    }

    /// A marker libjpeg treats as a fatal error is not something to skip past: the file
    /// never decodes, so any frame header behind it gates a raster nothing allocates.
    /// Each fixture puts one such marker — followed by `00 02`, a length only a walk
    /// with the refusal deleted would read — ahead of a complete, valid SOF0: skipping
    /// would land exactly on that header and report its size.
    #[test]
    fn sniff_image_refuses_markers_the_decoder_fatally_rejects() {
        // The reserved range's ends, JPG, DHP, EXP, and the JPGn range's ends.
        for marker in [0x02u8, 0xbf, 0xc8, 0xde, 0xdf, 0xf0, 0xfd] {
            let leading = [0xff, marker, 0x00, 0x02];
            assert_eq!(
                sniff_image(&jpeg_fixture(0xc0, &leading, 640, 480)),
                None,
                "FF {marker:02X} must be refused, not skipped"
            );
        }
        // The frame header behind them is well-formed and within the caps, so the
        // refusals above are the marker arm and not some other gate.
        assert_eq!(
            sniff_image(&jpeg_fixture(0xc0, &[], 640, 480)),
            Some(("image/jpeg", 640, 480))
        );
        assert_eq!(
            gated(&jpeg_fixture(0xc0, &[], 640, 480)),
            Some("image/jpeg")
        );
    }

    /// T.81 fixes `Lf` at 8 + 3 * Nf, so a frame header that disagrees with its own
    /// component count is one libjpeg's `get_sof` rejects — reading a size out of it would
    /// cap a raster nothing decodes.
    #[test]
    fn sniff_image_refuses_an_inconsistent_frame_header() {
        // Nf = 0, and Nf = 2 against a length that only fits one component.
        for components in [0u8, 2] {
            let mut payload = sof_payload(100, 100);
            payload[5] = components;
            let bytes = [vec![0xffu8, 0xd8], jpeg_segment(0xc0, &payload)].concat();
            assert_eq!(sniff_image(&bytes), None, "Nf {components} must be refused");
        }

        // A length under the 8 bytes a frame header always has, and a segment whose
        // declared length runs past the buffer.
        let mut short = vec![0xffu8, 0xd8, 0xff, 0xc0, 0x00, 0x07];
        short.extend_from_slice(&[0x08, 0x00, 0x64, 0x00, 0x64]);
        assert_eq!(sniff_image(&short), None);
        let mut overrun = vec![0xffu8, 0xd8, 0xff, 0xc0, 0x00, 0x20];
        overrun.extend_from_slice(&sof_payload(100, 100));
        assert_eq!(sniff_image(&overrun), None);

        // Nf = 2 with the length that matches it (Lf = 14) is accepted.
        let mut two = sof_payload(640, 480);
        two[5] = 2;
        two.extend_from_slice(&[2, 0x11, 0]);
        let bytes = [vec![0xffu8, 0xd8], jpeg_segment(0xc0, &two)].concat();
        assert_eq!(sniff_image(&bytes), Some(("image/jpeg", 640, 480)));
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
                gated(&png_fixture(width, height)),
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
            gated(&png_fixture(MAX_IMAGE_DIMENSION, 4000)),
            Some("image/png")
        );
        // Exactly at the area ceiling, with both axes inside the per-axis one.
        assert_eq!(u64::from(8000u32) * 5000, MAX_IMAGE_PIXELS);
        assert_eq!(
            gated(&webp_extended_fixture(8000, 5000)),
            Some("image/webp")
        );
        // One pixel past it is not.
        assert!(!dimensions_within_caps(8000, 5001));
    }
}
