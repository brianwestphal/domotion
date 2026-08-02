// HarfBuzz applies AAT tracking to a face carrying BOTH `trak` and `STAT`, and
// that pair is what decides whether a face's shaping has to come from HarfBuzz
// rather than from the platform helper (which opens every face at
// size = unitsPerEm and so tracks as though every run were 1000 px).
//
// The gate is transcribed from `hb-ot-shape.cc:216-220` (rev 4de187d):
//
//     plan.apply_trak = hb_aat_layout_has_tracking (face) && face->table.STAT->has_data ();
//
// Built out of synthetic sfnt bytes rather than real system fonts on purpose.
// The faces this fires for are macOS-only (SF Pro, SF Compact, SF Hebrew, the
// PingFang cuts), so a test that asked a real font would silently assert
// nothing on the Linux and Windows runners — and the reader it covers is a
// hand-written parse of the table directory, i.e. exactly the kind of code that
// wants checking everywhere rather than in one place.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { faceHasTrakAndStat, _clearTrakStatCache } from "./harfbuzz-shaper.js";

/** A minimal single-face sfnt: a real table directory, no table bodies. Only
 *  the directory is read, so the bodies never have to exist. */
function sfnt(tables: Array<{ tag: string; length?: number }>): Buffer {
  const buf = Buffer.alloc(12 + tables.length * 16);
  buf.writeUInt32BE(0x00010000, 0);
  buf.writeUInt16BE(tables.length, 4);
  tables.forEach((t, i) => {
    const at = 12 + i * 16;
    buf.write(t.tag, at, 4, "ascii");
    buf.writeUInt32BE(0, at + 4);           // checksum
    buf.writeUInt32BE(0x10000, at + 8);     // offset — never followed
    buf.writeUInt32BE(t.length ?? 64, at + 12);
  });
  return buf;
}

/** A collection whose members are the given faces, laid out back to back. */
function ttc(faces: Buffer[]): Buffer {
  const header = 12 + faces.length * 4;
  const out = Buffer.alloc(header + faces.reduce((n, f) => n + f.length, 0));
  out.write("ttcf", 0, 4, "ascii");
  out.writeUInt32BE(0x00010000, 4);
  out.writeUInt32BE(faces.length, 8);
  let at = header;
  faces.forEach((f, i) => {
    out.writeUInt32BE(at, 12 + i * 4);
    f.copy(out, at);
    at += f.length;
  });
  return out;
}

let dir: string;
let n = 0;
const write = (bytes: Buffer): string => {
  const p = join(dir, `f${n++}.ttf`);
  writeFileSync(p, bytes);
  return p;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "domotion-trak-"));
  _clearTrakStatCache();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  _clearTrakStatCache();
});

describe("the trak + STAT gate", () => {
  it("holds only when BOTH tables are present", () => {
    // Each half alone must fail, or the gate is really a one-table gate that
    // happens to pass the both-present case.
    expect(faceHasTrakAndStat(write(sfnt([{ tag: "glyf" }, { tag: "trak" }, { tag: "STAT" }])), 0)).toBe(true);
    expect(faceHasTrakAndStat(write(sfnt([{ tag: "glyf" }, { tag: "trak" }])), 0)).toBe(false);
    expect(faceHasTrakAndStat(write(sfnt([{ tag: "glyf" }, { tag: "STAT" }])), 0)).toBe(false);
    expect(faceHasTrakAndStat(write(sfnt([{ tag: "glyf" }, { tag: "GSUB" }])), 0)).toBe(false);
  });

  it("treats a zero-length table as absent", () => {
    // `has_data()` is `version.to_int()` on both tables
    // (`hb-aat-layout-trak-table.hh:192`, `hb-ot-stat-table.hh:479`), which
    // reads the Null instance — all zeros — for a table with no bytes. A
    // directory entry alone is not data.
    expect(faceHasTrakAndStat(write(sfnt([{ tag: "trak", length: 0 }, { tag: "STAT" }])), 0)).toBe(false);
    expect(faceHasTrakAndStat(write(sfnt([{ tag: "trak" }, { tag: "STAT", length: 0 }])), 0)).toBe(false);
  });

  it("answers per collection member, not per file", () => {
    // The case that matters in practice: `PingFangUI.ttc` carries 20-odd
    // members and the cuts routed here are members 20 through 23. A reader
    // that answered for member 0 would answer for a different font.
    const path = write(ttc([
      sfnt([{ tag: "glyf" }, { tag: "GSUB" }]),
      sfnt([{ tag: "glyf" }, { tag: "trak" }, { tag: "STAT" }]),
    ]));
    expect(faceHasTrakAndStat(path, 0)).toBe(false);
    expect(faceHasTrakAndStat(path, 1)).toBe(true);
    // Past the end is not member 0.
    expect(faceHasTrakAndStat(path, 2)).toBe(false);
  });

  it("refuses a face it cannot identify", () => {
    // `null` means the caller could not resolve the index. Answering for face 0
    // is the defect this mirrors elsewhere in the module: same file, wrong face,
    // and no way to see it went wrong.
    const path = write(sfnt([{ tag: "trak" }, { tag: "STAT" }]));
    expect(faceHasTrakAndStat(path, null)).toBe(false);
    // A non-zero index into a single-face file describes a face that isn't there.
    expect(faceHasTrakAndStat(path, 1)).toBe(false);
    expect(faceHasTrakAndStat("", 0)).toBe(false);
  });

  it("says no for a file it cannot read", () => {
    // Unreadable must mean "leave the caller's shaping alone", never "route it".
    expect(faceHasTrakAndStat(join(dir, "absent.ttf"), 0)).toBe(false);
    expect(faceHasTrakAndStat(write(Buffer.alloc(6)), 0)).toBe(false);
    // A directory claiming more tables than the file holds.
    const truncated = sfnt([{ tag: "trak" }, { tag: "STAT" }]).subarray(0, 20);
    expect(faceHasTrakAndStat(write(Buffer.from(truncated)), 0)).toBe(false);
  });

  it("is memoised per (path, face index)", () => {
    // The verdict decides whether a 58 MB face gets opened by HarfBuzz, so it
    // is asked often and must be answered from memory. Rewriting the file
    // underneath is the only way to observe that from outside.
    const p = join(dir, "swap.ttf");
    writeFileSync(p, sfnt([{ tag: "trak" }, { tag: "STAT" }]));
    expect(faceHasTrakAndStat(p, 0)).toBe(true);
    writeFileSync(p, sfnt([{ tag: "glyf" }]));
    expect(faceHasTrakAndStat(p, 0)).toBe(true);   // memoised, not re-read
    _clearTrakStatCache();
    expect(faceHasTrakAndStat(p, 0)).toBe(false);  // the control
  });
});
