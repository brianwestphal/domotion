// `image-orientation: none` support for embedded raster images.
//
// Blink sizes and paints a bitmap with `image.Size(orientation)`, where the
// orientation is the img's `image-orientation` unless the resource is not
// access-allowed (`LayoutImageResource::ImageOrientation`,
// `core/layout/layout_image_resource.cc:121-153`;
// `ImageResourceContent::ForceOrientationIfNecessary`,
// `core/loader/resource/image_resource_content.cc:338-343`, Chromium 6b5a1b80).
// Capture records the used `none` as `imageOrientationNone`.
//
// Every SVG consumer applies the embedded EXIF orientation itself, so the
// renderer rewrites the orientation tag to 1 (a two-byte in-place patch) and
// swaps the natural axes for the transposing orientations 5-8. Only the
// containers Chromium reads orientation from are patched: JPEG APP1 Exif
// (`ImageDecoder::ApplyExifMetadata`, `platform/image-decoders/
// image_decoder.cc:1006-1012`) and PNG `eXIf` (`SkPngRustCodec`'s
// `GetEncodedOrigin`, Skia fd139e79 `src/codec/SkPngRustCodec.cpp:356-365`).
// Blink's WebP decoder ignores EXIF. AVIF orients through its `irot`/`imir`
// item properties instead (`AVIFImageDecoder`, `platform/image-decoders/avif/
// avif_image_decoder.cc:919-956`); see `avifTransforms` below.

const ORIENTATION_TAG = 0x0112;

// PNG chunk CRC (ISO 3309 / ITU-T V.42), as specified for PNG.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Byte offset of the orientation SHORT value in a TIFF block, or null. */
function tiffOrientationOffset(bytes: Uint8Array, tiff: number, end: number): number | null {
  if (tiff + 8 > end) return null;
  const little = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49;
  const big = bytes[tiff] === 0x4d && bytes[tiff + 1] === 0x4d;
  if (!little && !big) return null;
  const u16 = (at: number): number => (little ? bytes[at] | (bytes[at + 1] << 8) : (bytes[at] << 8) | bytes[at + 1]);
  const u32 = (at: number): number =>
    little
      ? (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0
      : ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
  if (u16(tiff + 2) !== 42) return null;
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > end) return null;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) return null;
    // Type 3 (SHORT), count 1: the value sits in the first two value bytes.
    if (u16(entry) === ORIENTATION_TAG) return u16(entry + 2) === 3 && u32(entry + 4) === 1 ? entry + 8 : null;
  }
  return null;
}

interface OrientationSite {
  /** Offset of the orientation SHORT. */
  at: number;
  littleEndian: boolean;
  /** PNG chunk whose CRC covers the patched bytes. */
  pngChunk?: { typeStart: number; dataEnd: number };
}

function findOrientation(bytes: Uint8Array): OrientationSite | null {
  // JPEG: markers up to SOS; APP1 "Exif\0\0" carries the TIFF block.
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 4 <= bytes.length && bytes[at] === 0xff) {
      const marker = bytes[at + 1];
      if (marker === 0xda || marker === 0xd9) break;
      const length = (bytes[at + 2] << 8) | bytes[at + 3];
      const end = at + 2 + length;
      if (
        marker === 0xe1 &&
        length >= 8 &&
        bytes[at + 4] === 0x45 &&
        bytes[at + 5] === 0x78 &&
        bytes[at + 6] === 0x69 &&
        bytes[at + 7] === 0x66 &&
        bytes[at + 8] === 0 &&
        bytes[at + 9] === 0
      ) {
        const tiff = at + 10;
        const offset = tiffOrientationOffset(bytes, tiff, Math.min(end, bytes.length));
        return offset == null ? null : { at: offset, littleEndian: bytes[tiff] === 0x49 };
      }
      at = end;
    }
    return null;
  }
  // PNG: the eXIf chunk is a bare TIFF block.
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.every((b, i) => bytes[i] === b)) {
    let at = 8;
    while (at + 12 <= bytes.length) {
      const length = ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
      const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
      const data = at + 8;
      const dataEnd = data + length;
      if (dataEnd + 4 > bytes.length) return null;
      if (type === "eXIf") {
        const offset = tiffOrientationOffset(bytes, data, dataEnd);
        return offset == null
          ? null
          : { at: offset, littleEndian: bytes[data] === 0x49, pngChunk: { typeStart: at + 4, dataEnd } };
      }
      if (type === "IDAT" || type === "IEND") return null;
      at = dataEnd + 4;
    }
  }
  return null;
}

/** The EXIF orientation Chromium applies to these bytes (1 when none). */
export function encodedImageOrientation(bytes: Uint8Array): number {
  const site = findOrientation(bytes);
  if (site == null) return 1;
  const value = site.littleEndian
    ? bytes[site.at] | (bytes[site.at + 1] << 8)
    : (bytes[site.at] << 8) | bytes[site.at + 1];
  return value >= 1 && value <= 8 ? value : 1;
}

/**
 * Rewrite the orientation tag to 1 so a consumer paints the stored pixel grid.
 * Returns the original array when there is nothing to change.
 */
export function withoutEncodedOrientation(bytes: Uint8Array): Uint8Array {
  if (encodedImageOrientation(bytes) === 1) return bytes;
  const site = findOrientation(bytes)!;
  const out = Uint8Array.from(bytes);
  out[site.at] = site.littleEndian ? 1 : 0;
  out[site.at + 1] = site.littleEndian ? 0 : 1;
  if (site.pngChunk != null) {
    const crc = crc32(out.subarray(site.pngChunk.typeStart, site.pngChunk.dataEnd));
    const at = site.pngChunk.dataEnd;
    out[at] = crc >>> 24;
    out[at + 1] = (crc >>> 16) & 0xff;
    out[at + 2] = (crc >>> 8) & 0xff;
    out[at + 3] = crc & 0xff;
  }
  return out;
}

interface AvifTransforms {
  /** Offsets of every `irot` angle byte. */
  irotAngleAt: number[];
  /** Quarter turns anticlockwise (0-3) of the first `irot`. */
  angle: number;
  /** The first `imir` axis: 0 exchanges top and bottom, 1 left and right. */
  mirrorAxis: 0 | 1 | null;
}

/**
 * DM-4G5NX9: the `irot` / `imir` item properties of an AVIF (HEIF) file. They
 * live in `meta` > `iprp` > `ipco` (ISO/IEC 23008-12). Blink maps them to the
 * same decoder orientation as EXIF, so `image-orientation: none` suppresses
 * them too. Returns null when the bytes are not an AVIF with either property.
 */
function avifTransforms(bytes: Uint8Array): AvifTransforms | null {
  const u32 = (at: number) => ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
  const type = (at: number) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  if (bytes.length < 12 || type(4) !== "ftyp") return null;
  const brands = Buffer.from(bytes.subarray(8, Math.min(bytes.length, 8 + u32(0)))).toString("latin1");
  if (!/avif|avis/.test(brands)) return null;
  const found: AvifTransforms = { irotAngleAt: [], angle: 0, mirrorAxis: null };
  const walk = (start: number, end: number, depth: number): void => {
    let at = start;
    while (at + 8 <= end) {
      const size = u32(at);
      const boxType = type(at + 4);
      const boxEnd = size === 0 ? end : at + size;
      if (size < 8 && size !== 0) return;
      if (boxEnd > end) return;
      if (boxType === "meta" && depth === 0) walk(at + 12, boxEnd, 1);
      else if (boxType === "iprp" && depth === 1) walk(at + 8, boxEnd, 2);
      else if (boxType === "ipco" && depth === 2) walk(at + 8, boxEnd, 3);
      else if (boxType === "irot" && depth === 3 && at + 8 < boxEnd) {
        if (found.irotAngleAt.length === 0) found.angle = bytes[at + 8] & 3;
        found.irotAngleAt.push(at + 8);
      } else if (boxType === "imir" && depth === 3 && at + 8 < boxEnd && found.mirrorAxis == null) {
        found.mirrorAxis = (bytes[at + 8] & 1) as 0 | 1;
      }
      at = boxEnd;
    }
  };
  walk(0, bytes.length, 0);
  return found.irotAngleAt.length > 0 || found.mirrorAxis != null ? found : null;
}

/**
 * Apply a used `image-orientation: none` to a base64 data URI: the stored
 * pixel grid's bytes, and whether the natural axes swap (orientations 5-8).
 * Other sources are returned unchanged.
 *
 * An AVIF `imir` has no identity value and is an essential property, so it
 * cannot be neutralized in place (DM-FPTFZB). With `irot` zeroed, a decoder
 * applies only the mirror (MIAF 7.3.6.7 orders rotation before mirror, and
 * Blink's avif_image_decoder.cc:922-956 at 6b5a1b80 maps axis 0 to a
 * top/bottom and axis 1 to a left/right exchange), so `mirror` names the flip
 * the painter applies again to restore the stored grid.
 */
export function unorientedImageSource(src: string): {
  src: string;
  transposed: boolean;
  mirror?: "vertical" | "horizontal";
} {
  const match = /^data:([^,;]*)((?:;[^,;]*)*);base64,/i.exec(src);
  if (match == null) return { src, transposed: false };
  const bytes = Buffer.from(src.slice(match[0].length), "base64");
  const avif = avifTransforms(bytes);
  if (avif != null) {
    const mirror =
      avif.mirrorAxis == null ? {} : ({ mirror: avif.mirrorAxis === 0 ? "vertical" : "horizontal" } as const);
    if (avif.angle === 0) return { src, transposed: false, ...mirror };
    const patched = Buffer.from(bytes);
    for (const at of avif.irotAngleAt) patched[at] = patched[at] & ~3;
    return { src: match[0] + patched.toString("base64"), transposed: avif.angle % 2 === 1, ...mirror };
  }
  const orientation = encodedImageOrientation(bytes);
  if (orientation === 1) return { src, transposed: false };
  const patched = Buffer.from(withoutEncodedOrientation(bytes));
  return { src: match[0] + patched.toString("base64"), transposed: orientation >= 5 };
}
