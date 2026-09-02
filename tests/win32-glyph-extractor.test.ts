import { describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, openSync, readSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as fontkit from "fontkit";

// DM-837: validates the Windows DirectWrite glyph extractor
// (tools/win32-glyph-extractor). Mirrors the macOS / Linux helper tests.
// Skipped automatically unless we're on Windows with the binary built, so it is
// inert on macOS/Linux CI and on a clean Windows checkout. Runs in CI on a
// windows-latest runner (the glyph-extractor-build job in windows-fidelity.yml).
//
// The helper emits outlines in font design units, y-UP (DirectWrite's emSize is
// the font's designUnitsPerEm, and the Direct2D y-down geometry is negated) —
// fontkit's `glyph.path.commands` convention. Unlike the FreeType helper (which
// shares fontkit's exact contour ordering), DirectWrite may start a contour at a
// different point, so we assert the *robust* invariants — id, advance, the
// command-type histogram (curve mapping), and the bounding box (which pins the
// y-flip sign: a wrong negation flips the cap-height bbox below the baseline) —
// rather than an exact command-for-command match.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.resolve(HERE, "..", "tools", "win32-glyph-extractor", "domotion-glyph-paths.exe");

const helperAvailable = process.platform === "win32" && existsSync(HELPER);
const describeHelper = helperAvailable ? describe : describe.skip;

function resolveFontFile(candidates: string[]): string | null {
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}
const ARIAL = resolveFontFile(["C:/Windows/Fonts/arial.ttf", "C:\\Windows\\Fonts\\arial.ttf"]);
const GEORGIA = resolveFontFile(["C:/Windows/Fonts/georgia.ttf", "C:\\Windows\\Fonts\\georgia.ttf"]);
const CAMBRIA = resolveFontFile(["C:/Windows/Fonts/cambria.ttc", "C:\\Windows\\Fonts\\cambria.ttc"]);
const SEGOE_UI_EMOJI = resolveFontFile(["C:/Windows/Fonts/seguiemj.ttf", "C:\\Windows\\Fonts\\seguiemj.ttf"]);

interface GlyphResult {
  id: number;
  advance: number;
  bbox: { x: number; y: number; w: number; h: number };
  d: string;
  rasterRepresentation?: "sbix" | "colr" | "bitmap" | "svg";
}

function callHelper(request: unknown): { results: any[] } {
  const proc = spawnSync(HELPER, [], {
    input: JSON.stringify(request),
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (proc.status !== 0) throw new Error(`helper exit ${proc.status}: ${proc.stderr}`);
  return JSON.parse(proc.stdout);
}

function helperGlyph(fontPath: string, cp: number): GlyphResult {
  const resp = callHelper({
    fonts: [{ ref: "f", fontPath, size: 2048 }],
    queries: [{ type: "glyphs", fontRef: "f", glyphs: [{ cp }] }],
  });
  return (resp.results[0] as { glyphs: GlyphResult[] }).glyphs[0];
}

const FK_TO_LETTER: Record<string, string> = {
  moveTo: "M",
  lineTo: "L",
  quadraticCurveTo: "Q",
  bezierCurveTo: "C",
  closePath: "Z",
};
function histogram(types: string[]): Record<string, number> {
  const h: Record<string, number> = {};
  for (const t of types) h[t] = (h[t] ?? 0) + 1;
  return h;
}
function fontkitTypes(cmds: Array<{ command: string }>): string[] {
  return cmds.map((c) => FK_TO_LETTER[c.command]);
}
function dPoints(d: string): Array<[number, number]> {
  const tokens = d.match(/[MLQCZ]|-?\d+(?:\.\d+)?/g) ?? [];
  const argCount: Record<string, number> = { M: 2, L: 2, Q: 4, C: 6, Z: 0 };
  const pts: Array<[number, number]> = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i++];
    const n = argCount[t];
    for (let k = 0; k < n; k += 2) pts.push([Number(tokens[i + k]), Number(tokens[i + k + 1])]);
    i += n;
  }
  return pts;
}
function dTypes(d: string): string[] {
  return (d.match(/[MLQCZ]/g) ?? []) as string[];
}
function bbox(pts: Array<[number, number]>): [number, number, number, number] {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
function fontkitPoints(cmds: Array<{ args: number[] }>): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (const c of cmds) for (let i = 0; i + 1 < c.args.length; i += 2) pts.push([c.args[i], c.args[i + 1]]);
  return pts;
}

describeHelper("Windows DirectWrite glyph extractor", () => {
  const describeArial = ARIAL ? describe : describe.skip;
  const describeGeorgia = GEORGIA ? describe : describe.skip;
  const describeCambria = CAMBRIA ? describe : describe.skip;
  const describeSegoeEmoji = SEGOE_UI_EMOJI ? describe : describe.skip;

  describeArial("Arial", () => {
    it("reports font metadata in design units", () => {
      const resp = callHelper({
        fonts: [{ ref: "f", fontPath: ARIAL, size: 2048 }],
        queries: [{ type: "meta", fontRef: "f" }],
      });
      const meta = resp.results[0] as { unitsPerEm: number; ascent: number; descent: number; traitItalic?: boolean; postscriptName: string; faceIndex: number };
      expect(meta.unitsPerEm).toBe(2048);
      expect(meta.ascent).toBeGreaterThan(0);
      expect(meta.descent).toBeLessThan(0); // negative-below-baseline convention
      expect(meta.traitItalic).toBe(false);
      expect(meta.postscriptName).toBe("ArialMT");
      expect(meta.faceIndex).toBe(0);
    });

    it("extracts the H outline matching fontkit (validates y-up + line mapping)", () => {
      const font = fontkit.openSync(ARIAL!) as any;
      const fk = font.glyphForCodePoint(0x48);
      const H = helperGlyph(ARIAL!, 0x48);

      expect(H.id).toBe(fk.id);
      expect(H.d).toMatch(/^M /);
      expect(H.d).toMatch(/Z$/);
      expect(H.d).not.toMatch(/[QC]/); // H is straight lines only
      expect(Math.abs(H.advance - fk.advanceWidth)).toBeLessThan(2);

      // y-up: cap-height extent is positive (above baseline). A wrong y negation
      // would make the bbox y-range negative — this is the sign pin.
      const [fkMinX, fkMinY, fkMaxX, fkMaxY] = bbox(fontkitPoints(fk.path.commands));
      const [heMinX, heMinY, heMaxX, heMaxY] = bbox(dPoints(H.d));
      expect(heMaxY).toBeGreaterThan(0);
      for (const [a, b] of [
        [fkMinX, heMinX],
        [fkMinY, heMinY],
        [fkMaxX, heMaxX],
        [fkMaxY, heMaxY],
      ]) {
        expect(Math.abs(a - b)).toBeLessThan(2);
      }

      // Same command-type histogram (curve mapping; robust to start-point order).
      expect(histogram(dTypes(H.d))).toEqual(histogram(fontkitTypes(fk.path.commands)));
    });

    it("returns id=0 / empty path for a codepoint the font lacks", () => {
      const han = helperGlyph(ARIAL!, 0x6f22); // 漢 — not in Arial
      expect(han.id).toBe(0);
      expect(han.d).toBe("");
    });
  });

  describeGeorgia("Georgia", () => {
    it("reports the real small-cap GSUB features used by Blink", () => {
      const resp = callHelper({
        fonts: [{ ref: "f", fontPath: GEORGIA, size: 2048 }],
        queries: [{ type: "meta", fontRef: "f" }],
      });
      const meta = resp.results[0] as { availableFeatures?: string[] };
      expect(meta.availableFeatures).toEqual(expect.arrayContaining(["smcp", "c2sc"]));
    });
  });

  describeCambria("Cambria Math", () => {
    it("extracts a Math-Alphanumeric glyph (U+1D400 𝐀) via the .ttc face", () => {
      const resp = callHelper({
        fonts: [{ ref: "f", fontPath: CAMBRIA, postscriptName: "CambriaMath", size: 2048 }],
        queries: [{ type: "glyphs", fontRef: "f", glyphs: [{ cp: 0x1d400 }] }],
      });
      const a = (resp.results[0] as { glyphs: GlyphResult[] }).glyphs[0];
      expect(a.id).toBeGreaterThan(0);
      expect(a.d.length).toBeGreaterThan(0);
      expect(a.d).toMatch(/C/); // DirectWrite emits cubic curves
    });
  });

  // DM-2403: Segoe UI Emoji is a MIXED face. DirectWrite exposes a base
  // outline for a COLR emoji, but Chromium's pinned Skia asks the selected
  // glyph id's color APIs first and never requests that outline on success.
  // Querying the same id both by cmap and by id pins the helper wire field to
  // the selected shaped gid; '#' is the same face's ordinary-outline control.
  describeSegoeEmoji("Segoe UI Emoji selected-glyph paint ownership", () => {
    it("reports COLR for the exact emoji gid while keeping an ordinary glyph unmarked", () => {
      const first = callHelper({
        fonts: [{ ref: "f", fontPath: SEGOE_UI_EMOJI, size: 2048 }],
        queries: [{ type: "glyphs", fontRef: "f", glyphs: [{ cp: 0x1f600 }, { cp: 0x23 }] }],
      });
      const [grinning, hash] = (first.results[0] as { glyphs: GlyphResult[] }).glyphs;
      expect(grinning.id).toBeGreaterThan(0);
      expect(grinning.d.length).toBeGreaterThan(0); // base outline exists but Skia owns color paint
      expect(grinning.rasterRepresentation).toBe("colr");
      expect(hash.id).toBeGreaterThan(0);
      expect(hash.d.length).toBeGreaterThan(0);
      expect(hash.rasterRepresentation).toBeUndefined();

      const byId = callHelper({
        fonts: [{ ref: "f", fontPath: SEGOE_UI_EMOJI, size: 2048 }],
        queries: [{ type: "glyphs", fontRef: "f", glyphs: [{ id: grinning.id }] }],
      });
      expect((byId.results[0] as { glyphs: GlyphResult[] }).glyphs[0]).toMatchObject({
        id: grinning.id,
        rasterRepresentation: "colr",
      });
    });
  });
});

// DM-1035: the Windows DirectWrite helper's persistent `--serve` loop — the
// Windows analogue of the macOS / Linux serve tests. Spawn the binary once,
// stream newline-delimited request envelopes on stdin, read one response per
// line on stdout; faces opened once are reused across requests. This is what
// `callHelper` now uses on Windows (the gate was lifted for win32), so we
// exercise the wire protocol directly and assert each serve response is
// BYTE-IDENTICAL to the one-shot response for the same envelope (the acceptance
// contract). Runs only on Windows with the binary built (skipped elsewhere).
describeHelper("persistent --serve protocol on Windows (DM-1035)", () => {
  const describeArial = ARIAL ? describe : describe.skip;
  describeArial("reuses faces across requests and matches one-shot byte-for-byte", () => {
    it("serve responses equal one-shot responses", async () => {
      const FONT = { ref: "f", fontPath: ARIAL!, size: 2048 };
      const envA = { fonts: [FONT], queries: [
        { type: "meta", fontRef: "f" },
        { type: "glyphs", fontRef: "f", glyphs: [{ cp: 0x48 }, { cp: 0x65 }, { cp: 0x21 }] }
      ] };
      // Second envelope reuses the SAME font ref to exercise the face cache.
      const envB = { fonts: [FONT], queries: [
        { type: "glyphs", fontRef: "f", glyphs: [{ cp: 0x57 }, { cp: 0x6f }] }
      ] };

      const oneShot = (req: unknown): string => {
        const p = spawnSync(HELPER, [], { input: JSON.stringify(req), encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
        expect(p.status).toBe(0);
        return p.stdout.trim();
      };
      const refA = oneShot(envA);
      const refB = oneShot(envB);

      // DM-1421: drive the serve channel over ASYNC streams, not synchronous
      // writeSync/readSync on the pipe fd. On Windows a spawned pipe's fd is
      // `-1` (no real OS fd), so `writeSync(-1)` threw "fd out of range". Async
      // stream I/O works on every platform and verifies the SAME property — the
      // helper's `--serve` loop emits output byte-identical to one-shot, with
      // faces reused across requests.
      //
      // DM-1889 UPDATE: production no longer falls back to one-shot on Windows.
      // The fd `-1` limitation is real but specific to *spawned stdio*; a NAMED
      // pipe opened with `fs.openSync` yields a real fd, so Windows now drives
      // the same protocol over `--serve-pipe` (exercised by the test below).
      // This case still covers plain `--serve`, which macOS/Linux use.
      const child = spawn(HELPER, ["--serve"], { stdio: ["pipe", "pipe", "inherit"] });
      child.stdout!.setEncoding("utf-8");
      let leftover = "";
      const waiters: Array<(line: string) => void> = [];
      child.stdout!.on("data", (chunk: string) => {
        leftover += chunk;
        let nl: number;
        while ((nl = leftover.indexOf("\n")) >= 0) {
          const line = leftover.slice(0, nl);
          leftover = leftover.slice(nl + 1);
          waiters.shift()?.(line);
        }
      });
      const call = (req: unknown): Promise<string> => new Promise((resolve, reject) => {
        waiters.push(resolve);
        child.stdin!.write(JSON.stringify(req) + "\n", (e) => { if (e) reject(e); });
      });
      try {
        expect(await call(envA)).toBe(refA); // first request opens the face
        expect(await call(envB)).toBe(refB); // second reuses the cached face
      } finally {
        child.stdin!.end();
        child.kill();
      }
    }, 30_000);
  });
});

// DM-1889: the named-pipe serve transport — the one Windows production actually
// uses. The `--serve` case above drives ASYNC streams because a spawned pipe has
// no usable fd on Windows; this case drives SYNCHRONOUS writeSync/readSync
// exactly as `src/render/glyph-helper.ts` does, which is the whole point. A
// named pipe opened by path yields a real fd where spawned stdio does not, and
// that is what let Windows have a persistent channel at all.
//
// Before this, Windows spawned the binary once per helper call — ~42 ms measured
// against ~0.5 ms over the pipe. It also meant one-shot was the only path, which
// is how an unopenable declared base font silently disabled the entire live
// fallback resolver on the platform (see src/render/win32-fallback-envelope.test.ts).
describeHelper("persistent --serve-pipe transport on Windows (DM-1889)", () => {
  it("answers over a named pipe, byte-identically to one-shot, driven synchronously", () => {
    // No base font declared: DirectWrite's MapCharacters takes none, and
    // declaring an unopenable one is fatal in one-shot mode. This envelope is
    // the shape production sends.
    const env = {
      fonts: [],
      queries: [{
        type: "fallback", fontRef: "base", cps: [0x4e00, 0x0600, 0x0e01],
        cssWeight: 400, bold: false, italic: false,
      }],
    };
    const body = JSON.stringify(env);

    const oneShot = spawnSync(HELPER, [], { input: body + "\n", encoding: "utf-8", maxBuffer: 1 << 26 });
    // The one-shot path must SUCCEED on this envelope. It did not before
    // DM-1889, and that failure was invisible because the caller read the
    // resulting error envelope as an ordinary "no fallback font" answer.
    expect(oneShot.status, oneShot.stderr).toBe(0);
    const reference = oneShot.stdout.trim();
    expect(reference).toContain("\"type\":\"fallback\"");

    const name = String.raw`\\.\pipe\domotion-test-` + process.pid;
    const child = spawn(HELPER, ["--serve-pipe", name], { stdio: ["ignore", "ignore", "inherit"] });
    let fd: number | undefined;
    try {
      const deadline = Date.now() + 10_000;
      for (;;) {
        try { fd = openSync(name, "r+"); break; }
        catch {
          if (Date.now() > deadline) throw new Error("helper never created the named pipe");
          // Synchronous sleep: the connect loop cannot yield, by design.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
      }

      const roundTrip = (payload: string): string => {
        const line = Buffer.from(payload + "\n", "utf-8");
        let off = 0;
        while (off < line.length) off += writeSync(fd!, line, off, line.length - off);
        const tmp = Buffer.allocUnsafe(1 << 20);
        let acc = "";
        while (!acc.includes("\n")) {
          const n = readSync(fd!, tmp, 0, tmp.length, null);
          if (n <= 0) throw new Error("helper closed the pipe");
          acc += tmp.toString("utf-8", 0, n);
        }
        return acc.slice(0, acc.indexOf("\n"));
      };

      expect(roundTrip(body)).toBe(reference);
      // A second round-trip on the same channel: this is the property the whole
      // transport exists for — the process is reused rather than respawned.
      expect(roundTrip(body)).toBe(reference);
    } finally {
      child.kill();
    }
  }, 30_000);
});

// Skia does not hand DirectWrite's answers straight through, and both of the
// things it does in between were missing here until they were transcribed.
describeHelper("Skia's MapCharacters arguments and simulation stripping", () => {
  function fallback(cps: number[], extra: Record<string, unknown> = {}): any {
    return callHelper({ fonts: [], queries: [{ type: "fallback", cps, ...extra }] }).results[0];
  }
  function family(name: string, extra: Record<string, unknown> = {}): any {
    return callHelper({ fonts: [], queries: [{ type: "family", name, ...extra }] }).results[0];
  }

  it("exposes the raw DirectWrite style and simulation tuple only when requested", () => {
    const plain = fallback([0x41]).fonts[0];
    expect(plain.diagnostics).toBeUndefined();
    const traced = fallback([0x41], { diagnostics: true }).fonts[0];
    if (!traced.found) return;
    expect(traced.diagnostics).toEqual(expect.objectContaining({
      mappedWeight: expect.any(Number), mappedStretch: expect.any(Number),
      mappedStyle: expect.any(Number), mappedSimulations: expect.any(Number),
    }));
  });

  it("reopens an italic MapCharacters nomination with Blink's converted style", () => {
    // DirectWrite nominates real italic cuts for these two probes on the stock
    // Windows runner. Blink's UpdateFromSkiaFontStyle treats Skia ITALIC (as
    // opposed to OBLIQUE) as normal before reopening the family, so Chrome's
    // final painted cuts are regular. Diagnostics retain the raw nomination to
    // prove the test crosses that conversion rather than merely asking regular.
    const calibri = fallback([0x1df00], {
      baseFamilyName: "Segoe UI", cssWeight: 400, italic: true, cssSlant: 1,
      diagnostics: true,
    }).fonts[0];
    const segoe = fallback([0xa700], {
      baseFamilyName: "Calibri", cssWeight: 400, italic: true, cssSlant: 1,
      diagnostics: true,
    }).fonts[0];
    expect(calibri).toEqual(expect.objectContaining({
      found: true, postscriptName: "Calibri", diagnostics: expect.objectContaining({ mappedStyle: 2 }),
    }));
    expect(segoe).toEqual(expect.objectContaining({
      found: true, postscriptName: "SegoeUI", diagnostics: expect.objectContaining({ mappedStyle: 2 }),
    }));
  });

  // Skia builds an IDWriteNumberSubstitution from the same bcp47 tag it reports
  // as the locale (method NONE, ignoreUserOverride TRUE) and returns it from the
  // analysis source; passing null asked DirectWrite a question Chrome never
  // asks. When DirectWrite rejects the tag Skia abandons the whole match, which
  // this protocol reports as found:false plus a "numberSubstitution":"failed"
  // marker — a hard, silent zeroing of fallback for a whole run. The bail was
  // measured unreachable across every tag shape the resolver can emit, and this
  // pins that: if a future Windows build starts rejecting one of them, the
  // marker fires here instead of surfacing as universal non-coverage.
  it("accepts every locale tag shape the fallback resolver can emit", () => {
    const tags = [
      "en-us", "und-Zsye", "und-Zsym", "zh-Hans", "zh-Hant", "ja", "ko",
      "ar", "he", "th", "hi", "sr-Latn", "mn-Mong", "und", "zh",
    ];
    for (const locale of tags) {
      const r = fallback([0x41, 0x30, 0x660], { locale });
      expect(r.numberSubstitution, `locale ${locale}`).toBeUndefined();
    }
  });

  // The number substitution is the same call Chrome makes, but it is also
  // measured answer-neutral — worth pinning, because a future change that made
  // it non-neutral (a different method, or dropping ignoreUserOverride) would
  // otherwise pass every fixture silently. Digits are where it could bite.
  it("resolves digit codepoints identically under every numeral-shaping locale", () => {
    const digits = [0x30, 0x39, 0x660, 0x669, 0x6f0, 0x6f9, 0x966, 0x96f, 0xe50, 0xe59];
    const reference = fallback(digits, { locale: "en-us" }).fonts.map((f: any) => f.postscriptName ?? null);
    for (const locale of ["ar", "hi", "th", "und-Zsye"]) {
      const got = fallback(digits, { locale }).fonts.map((f: any) => f.postscriptName ?? null);
      expect(got, `locale ${locale}`).toEqual(reference);
    }
  });

  // `onMatchFamilyStyleCharacter` allows the simulated Light nomination, but
  // Blink does not render that raw typeface: it copies its style and reopens
  // Segoe UI through the simulation-free family matcher. The resulting regular
  // cut lacks U+2758, so GetDWriteFallbackFamily returns null. This pins both
  // halves of the pipeline; returning SegoeUI-Light here stops one stage early.
  it("rejects a simulated nomination whose Blink-reopened cut lacks the glyph", () => {
    const light = family("Segoe UI", { cssWeight: 300 });
    if (!light.found || !/Light/i.test(light.postscriptName)) return;
    const r = fallback([0x2758], { locale: "en-us", cssWeight: 700 }).fonts[0];
    expect(r.found).toBe(false);
  });

  // The family query runs the same loop (Skia's FirstMatchingFontWithoutSimulations,
  // which is what matchFamilyStyle bottoms out in on Windows). A family with a
  // real bold cut must still reach it — the loop must not strip weight from a
  // request DirectWrite answered honestly.
  it("keeps a family's real bold cut rather than stripping the request", () => {
    const bold = family("Segoe UI", { cssWeight: 700 });
    if (!bold.found) return;
    expect(bold.postscriptName).toBe("SegoeUI-Bold");
    const italic = family("Segoe UI", { cssWeight: 700, italic: true });
    if (italic.found) expect(italic.postscriptName).toBe("SegoeUI-BoldItalic");
  });
});
