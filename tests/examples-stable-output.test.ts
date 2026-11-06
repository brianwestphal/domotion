import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  decodePng,
  differsOnlyByEffectSurfaceJitter,
  pngsWithinTolerance,
  writeStableSvg,
} from "../examples/stable-output.js";

// DM-MWWAEE: Chromium's backdrop-filter raster jitters by one channel level at
// the lower-third banner's rounded corner between runs of identical code. These
// two fixtures are real captured variants of `lower-third-dark`'s effect surface
// (1 pixel differs, by 1 level).
const fixture = (name: string) =>
  readFileSync(resolve(import.meta.dirname, "fixtures/effect-surface-jitter", name)).toString("base64");
const A = fixture("a.png");
const B = fixture("b.png");
const svgWith = (png: string, extra = "") =>
  `<svg>${extra}<image data-domotion-no-hoist="effect-surface" href="data:image/png;base64,${png}" x="0"/></svg>`;

function png(width: number, height: number, rgba: number[], filter = 0): string {
  const rows: number[] = [];
  for (let y = 0; y < height; y++) rows.push(filter, ...rgba.slice(y * width * 4, (y + 1) * width * 4));
  const chunk = (type: string, body: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, "latin1");
    return Buffer.concat([head, body, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.from(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}

describe("example output stabilizer (DM-MWWAEE)", () => {
  it("decodes the real Chromium variants and measures their jitter as 1 level", () => {
    const a = decodePng(Buffer.from(A, "base64"))!;
    const b = decodePng(Buffer.from(B, "base64"))!;
    expect([a.width, a.height]).toEqual([b.width, b.height]);
    let differing = 0;
    let max = 0;
    for (let i = 0; i < a.data.length; i++) {
      const d = Math.abs(a.data[i] - b.data[i]);
      if (d > 0) differing++;
      max = Math.max(max, d);
    }
    expect(differing).toBeGreaterThan(0);
    expect(max).toBe(1);
    expect(pngsWithinTolerance(A, B)).toBe(true);
    expect(pngsWithinTolerance(A, B, 0)).toBe(false);
  });

  it("decodes filtered scanlines exactly", () => {
    const pixels = [10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255];
    for (const filter of [0, 1, 2, 3, 4]) {
      // Filter 0 stores raw bytes; for the others, encode a constant image whose
      // filtered bytes are all zero, so decoding must reproduce the predictor.
      if (filter === 0) {
        expect([...decodePng(Buffer.from(png(2, 2, pixels), "base64"))!.data]).toEqual(pixels);
      } else {
        const flat = decodePng(Buffer.from(png(2, 2, new Array(16).fill(0), filter), "base64"))!;
        expect([...flat.data]).toEqual(new Array(16).fill(0));
      }
    }
  });

  it("keeps the committed bytes only for effect-surface jitter", () => {
    expect(differsOnlyByEffectSurfaceJitter(svgWith(A), svgWith(B))).toBe(true);
    expect(differsOnlyByEffectSurfaceJitter(svgWith(A), svgWith(A))).toBe(false); // identical: nothing to keep
    expect(differsOnlyByEffectSurfaceJitter(svgWith(A), svgWith(B, "<rect/>"))).toBe(false); // markup changed
    const big = png(1, 1, [0, 0, 0, 255]);
    const moved = png(1, 1, [2, 0, 0, 255]);
    expect(differsOnlyByEffectSurfaceJitter(svgWith(big), svgWith(moved))).toBe(false); // 2 levels: a real change
    expect(differsOnlyByEffectSurfaceJitter("<svg/>", "<svg></svg>")).toBe(false); // no surfaces
  });

  it("writeStableSvg keeps or writes accordingly", () => {
    const dir = mkdtempSync(join(tmpdir(), "dm-stable-"));
    const path = join(dir, "x.svg");
    expect(writeStableSvg(path, svgWith(A))).toBe("written");
    expect(writeStableSvg(path, svgWith(B))).toBe("kept");
    expect(readFileSync(path, "utf8")).toBe(svgWith(A));
    expect(writeStableSvg(path, svgWith(B, "<rect/>"))).toBe("written");
    writeFileSync(path, "garbage");
    expect(writeStableSvg(path, svgWith(A))).toBe("written");
  });
});
