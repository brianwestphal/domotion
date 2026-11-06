/**
 * Keep committed example outputs stable across regenerations when the only
 * change is Chromium raster jitter.
 *
 * A `backdrop-filter` is embedded as Chromium's own raster (an `<image
 * data-domotion-no-hoist="effect-surface">` PNG). That raster carries real,
 * unseeded 1-level anti-aliasing jitter: the lower-third templates' rounded
 * backdrop clip differs by 1–6 pixels, each by one channel level, between runs
 * of identical code, even with a fresh browser per example and a single raster
 * thread (measured for DM-MWWAEE). Both variants are faithful Chromium paint, so
 * the library emits whatever Chromium painted. Only the examples script keeps
 * the committed bytes when nothing else changed, so a regeneration shows no
 * spurious diff.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

const EFFECT_SURFACE_PNG = /(data-domotion-no-hoist="effect-surface" href="data:image\/png;base64,)([^"]+)(")/g;

interface DecodedPng {
  width: number;
  height: number;
  channels: number;
  data: Uint8Array;
}

/** Decode an 8-bit, non-interlaced PNG (gray, gray+alpha, RGB or RGBA).
 *  Returns null for any other format, so callers treat it as "different". */
export function decodePng(bytes: Uint8Array): DecodedPng | null {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.length < 8 || view.readUInt32BE(0) !== 0x89504e47) return null;
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  while (offset + 8 <= view.length) {
    const length = view.readUInt32BE(offset);
    const type = view.toString("latin1", offset + 4, offset + 8);
    const body = view.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const bitDepth = body[8];
      const colorType = body[9];
      const interlace = body[12];
      const byType: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };
      if (bitDepth !== 8 || interlace !== 0 || byType[colorType] == null) return null;
      channels = byType[colorType];
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (width === 0 || height === 0 || channels === 0) return null;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) return null;
  const data = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? data[y * stride + x - channels] : 0;
      const b = y > 0 ? data[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? data[(y - 1) * stride + x - channels] : 0;
      let predictor: number;
      switch (filter) {
        case 0:
          predictor = 0;
          break;
        case 1:
          predictor = a;
          break;
        case 2:
          predictor = b;
          break;
        case 3:
          predictor = (a + b) >> 1;
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default:
          return null;
      }
      data[y * stride + x] = (line[x] + predictor) & 0xff;
    }
  }
  return { width, height, channels, data };
}

/** Whether two base64 PNGs have the same size and format and differ by at most
 *  `tolerance` levels in every channel of every pixel. */
export function pngsWithinTolerance(aBase64: string, bBase64: string, tolerance = 1): boolean {
  const a = decodePng(Buffer.from(aBase64, "base64"));
  const b = decodePng(Buffer.from(bBase64, "base64"));
  if (a == null || b == null) return false;
  if (a.width !== b.width || a.height !== b.height || a.channels !== b.channels) return false;
  for (let i = 0; i < a.data.length; i++) {
    if (Math.abs(a.data[i] - b.data[i]) > tolerance) return false;
  }
  return true;
}

/** True when `next` equals `previous` except for effect-surface PNGs that differ
 *  only by Chromium raster jitter (≤ 1 level per channel). */
export function differsOnlyByEffectSurfaceJitter(previous: string, next: string): boolean {
  if (previous === next) return false;
  const prevPngs = [...previous.matchAll(EFFECT_SURFACE_PNG)].map((m) => m[2]);
  const nextPngs = [...next.matchAll(EFFECT_SURFACE_PNG)].map((m) => m[2]);
  if (prevPngs.length === 0 || prevPngs.length !== nextPngs.length) return false;
  const mask = (svg: string) => svg.replace(EFFECT_SURFACE_PNG, "$1$3");
  if (mask(previous) !== mask(next)) return false;
  return prevPngs.every((png, i) => png === nextPngs[i] || pngsWithinTolerance(png, nextPngs[i]));
}

/**
 * Write an example SVG, keeping the existing file when the only change is
 * effect-surface raster jitter. Returns `"kept"` or `"written"`.
 */
export function writeStableSvg(path: string, svg: string): "kept" | "written" {
  if (existsSync(path) && differsOnlyByEffectSurfaceJitter(readFileSync(path, "utf8"), svg)) return "kept";
  writeFileSync(path, svg);
  return "written";
}
