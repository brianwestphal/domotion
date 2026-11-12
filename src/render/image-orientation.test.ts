import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { encodedImageOrientation, unorientedImageSource, withoutEncodedOrientation } from "./image-orientation.js";

const grid = () => sharp({ create: { width: 40, height: 20, channels: 3, background: "red" } });

// Minimal JPEG: SOI, APP1 Exif with one IFD0 orientation entry, EOI.
function jpegWithOrientation(orientation: number, littleEndian: boolean): Uint8Array {
  const u16 = (n: number) => (littleEndian ? [n & 0xff, n >> 8] : [n >> 8, n & 0xff]);
  const u32 = (n: number) => (littleEndian ? [n, 0, 0, 0] : [0, 0, 0, n]);
  const tiff = [
    ...(littleEndian ? [0x49, 0x49] : [0x4d, 0x4d]),
    ...u16(42),
    ...u32(8),
    ...u16(1),
    ...u16(0x0112),
    ...u16(3),
    ...u32(1),
    ...u16(orientation),
    0,
    0,
    ...u32(0),
  ];
  const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const length = payload.length + 2;
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, length >> 8, length & 0xff, ...payload, 0xff, 0xd9]);
}

function pngChunkCrcValid(bytes: Uint8Array, type: string): boolean {
  let at = 8;
  while (at + 12 <= bytes.length) {
    const view = Buffer.from(bytes);
    const length = view.readUInt32BE(at);
    if (view.toString("latin1", at + 4, at + 8) === type) {
      let c = 0xffffffff;
      for (const byte of bytes.subarray(at + 4, at + 8 + length)) {
        c ^= byte;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      return ((c ^ 0xffffffff) >>> 0) === view.readUInt32BE(at + 8 + length);
    }
    at += 12 + length;
  }
  return false;
}

describe("embedded image orientation (DM-JPDMRD)", () => {
  it("reads and neutralizes the orientation in both TIFF byte orders", () => {
    for (const littleEndian of [true, false]) {
      const bytes = jpegWithOrientation(6, littleEndian);
      expect(encodedImageOrientation(bytes)).toBe(6);
      const patched = withoutEncodedOrientation(bytes);
      expect(encodedImageOrientation(patched)).toBe(1);
      expect(patched.length).toBe(bytes.length);
      // Only the two value bytes change.
      expect(Array.from(patched).filter((b, i) => b !== bytes[i]).length).toBeLessThanOrEqual(2);
    }
  });

  it("patches encoder-written JPEG APP1 and PNG eXIf orientation losslessly", async () => {
    for (const format of ["jpeg", "png"] as const) {
      const bytes = await grid().toFormat(format).withMetadata({ orientation: 6 }).toBuffer();
      expect(encodedImageOrientation(bytes)).toBe(6);
      const patched = Buffer.from(withoutEncodedOrientation(bytes));
      expect((await sharp(patched).metadata()).orientation ?? 1).toBe(1);
      expect(await sharp(patched).raw().toBuffer()).toEqual(await sharp(bytes).raw().toBuffer());
      if (format === "png") expect(pngChunkCrcValid(patched, "eXIf")).toBe(true);
    }
  });

  it("leaves containers Chromium does not orient from EXIF, and unoriented images, unchanged", async () => {
    const webp = await grid().webp().withMetadata({ orientation: 6 }).toBuffer();
    expect(encodedImageOrientation(webp)).toBe(1);
    const plain = await grid().jpeg().toBuffer();
    expect(withoutEncodedOrientation(plain)).toBe(plain);
    expect(encodedImageOrientation(jpegWithOrientation(1, true))).toBe(1);
    expect(encodedImageOrientation(jpegWithOrientation(9, true))).toBe(1);
  });

  it("rewrites base64 data URIs and reports whether the natural axes transpose", () => {
    const uri = (orientation: number) =>
      `data:image/jpeg;base64,${Buffer.from(jpegWithOrientation(orientation, false)).toString("base64")}`;
    for (const [orientation, transposed] of [
      [3, false],
      [5, true],
      [6, true],
      [8, true],
    ] as const) {
      const out = unorientedImageSource(uri(orientation));
      expect(out.transposed).toBe(transposed);
      expect(out.src.startsWith("data:image/jpeg;base64,")).toBe(true);
      expect(encodedImageOrientation(Buffer.from(out.src.split(",")[1], "base64"))).toBe(1);
    }
    expect(unorientedImageSource(uri(1))).toEqual({ src: uri(1), transposed: false });
    expect(unorientedImageSource("https://example.test/a.jpg")).toEqual({
      src: "https://example.test/a.jpg",
      transposed: false,
    });
  });
});
