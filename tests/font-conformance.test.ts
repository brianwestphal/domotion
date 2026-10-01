/**
 * Unit coverage for the pure decision logic inside the font conformance
 * oracle (`tools/font-conformance.ts`).
 *
 * The oracle's whole value is that a green run means something, so the parts
 * that can silently turn a real disagreement into a pass — the codepoint
 * universe, the face-identity tiers, the alias escape hatch, and the allowlist
 * loader — are the parts pinned here. Nothing in this file launches a browser;
 * the module only sweeps when invoked as a script.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getFontSourceInfo, resolveFont, resolveFontSpec, resolveInstalledFont } from "@domotion/text-engine/testing";
import {
  allowlisted,
  buildReport,
  buildUniverse,
  faceFor,
  formatSummary,
  identifyFace,
  helperImplementationDigest,
  loadCorpus,
  loadAllowlist,
  mismatchClass,
  needsIsolatedQuery,
  OracleDriftError,
  OracleStabilityGuard,
  oracleScopeKey,
  OracleRegistry,
  parseArgs,
  prepareStack,
  primaryChromeFace,
  probePageHtml,
  slantForStyle,
  shouldResetBatch,
  selectStacksAndUniverse,
  stackKey,
  stacksFileFor,
  sweepStack,
  SweepTally,
  verdictForCodepoint,
  type ChromeFace,
  type OurFace,
  type StackSpec,
  type StackCorpus,
  type SweepOperations,
} from "../tools/font-conformance.js";
import { getFontInstance } from "../src/render/font-resolution.js";

describe("OracleStabilityGuard", () => {
  it("accepts repeated settings and rejects a later face switch", () => {
    const guard = new OracleStabilityGuard();
    const first = ["serif=Times-Roman", "fantasy=Papyrus"];
    guard.observe(first);
    first[0] = "serif=TimesNewRomanPSMT";
    guard.observe(["serif=Times-Roman", "fantasy=Papyrus"]);
    expect(() => guard.observe(["serif=TimesNewRomanPSMT", "fantasy=Papyrus"], "stack 31 batch 1")).toThrow(
      /oracle font settings changed during sweep.*Times-Roman.*TimesNewRomanPSMT/,
    );
    try {
      guard.observe(["serif=TimesNewRomanPSMT", "fantasy=Papyrus"], "stack 31 batch 1");
    } catch (error) {
      expect(error).toBeInstanceOf(OracleDriftError);
      expect((error as OracleDriftError).at).toBe("stack 31 batch 1");
    }
    expect(() => guard.observe(["serif=Times-Roman"])).toThrow(/oracle font settings changed/);
  });
});

describe("helperImplementationDigest", () => {
  it("is stable across rebuilt Windows executable bytes", () => {
    const root = mkdtempSync(join(tmpdir(), "domotion-helper-digest-"));
    const helper = join(root, "packages", "text-engine", "tools", "win32-glyph-extractor");
    mkdirSync(join(helper, "src"), { recursive: true });
    writeFileSync(join(helper, "build-msvc-direct.bat"), "cl src\\main.cpp\n");
    writeFileSync(join(helper, "src", "main.cpp"), "int main() { return 0; }\n");
    writeFileSync(join(helper, "domotion-glyph-paths.exe"), "build-one");

    const first = helperImplementationDigest("win32", root);
    writeFileSync(join(helper, "domotion-glyph-paths.exe"), "build-two");
    expect(helperImplementationDigest("win32", root)).toBe(first);

    writeFileSync(join(helper, "src", "main.cpp"), "int main() { return 1; }\n");
    expect(helperImplementationDigest("win32", root)).not.toBe(first);
  });
});

describe("font conformance command selection", () => {
  const stacks: StackSpec[] = ["A", "B", "C", "D"].map((fontFamily) => ({
    fontFamily,
    fontSize: 16,
    fontWeight: 400,
    fontStyle: "normal",
  }));

  it("guards foreign harvested corpora while accepting portable and explicitly foreign corpora", () => {
    const file = join(mkdtempSync(join(tmpdir(), "domotion-font-corpus-")), "stacks.json");
    const opts = { stacksFile: file, allowForeignCorpus: false };
    expect(loadCorpus(opts, "darwin").message).toContain("no stack corpus");
    writeFileSync(file, JSON.stringify({ generatedAt: "test", platform: "linux", sources: [], stacks }));
    expect(loadCorpus(opts, "darwin").message).toContain("not portable");
    expect(loadCorpus({ ...opts, allowForeignCorpus: true }, "darwin").warning).toContain("WARNING");
    writeFileSync(file, JSON.stringify({ generatedAt: "test", platform: "any", sources: [], stacks }));
    expect(loadCorpus(opts, "darwin").corpus?.stacks).toHaveLength(4);
  });

  it("filters before stack sharding and strides the selected codepoint universe", () => {
    const corpus: StackCorpus = { generatedAt: "test", platform: "any", sources: [], stacks };
    const opts = parseArgs(["--range", "0041-0048", "--stack-shard", "2/2", "--shard", "2/2"]);
    expect(selectStacksAndUniverse(corpus, opts).stacks.map((stack) => stack.fontFamily)).toEqual(["B", "D"]);
    expect(selectStacksAndUniverse(corpus, opts).universe).toEqual([0x42, 0x44, 0x46, 0x48]);
    opts.stackFilter = "C";
    expect(selectStacksAndUniverse(corpus, opts).stacks).toEqual([]);
    opts.stackFilter = "absent";
    expect(() => selectStacksAndUniverse(corpus, opts)).toThrow("matched no stacks");
  });
});

describe("sweepStack orchestration", () => {
  it("keeps Linux locale scope, batch reset cadence, and answer order", async () => {
    const events: string[] = [];
    const spec: StackSpec = { fontFamily: "A", fontSize: 16, fontWeight: 400, fontStyle: "normal", lang: "ja" };
    const opts = parseArgs(["--range", "0041-0043", "--batch", "1", "--reset-every", "2"]);
    const tally = new SweepTally(10, opts.lang, false, { entries: [], hits: [] });
    const operations: SweepOperations = {
      platform: "linux",
      selectScope: (lang) => {
        events.push(`scope:${lang}`);
      },
      prepare: (() => {
        events.push("prepare");
        return { chain: ["A"], primaryKey: "A" };
      }) as SweepOperations["prepare"],
      reset: () => {
        events.push("reset");
      },
      faceFor: ((cp: number) => {
        events.push(`ours:${cp}`);
        return ours({ key: "Arial", postscriptName: "Arial" });
      }) as SweepOperations["faceFor"],
      primeCodepoints: (cps) => {
        events.push(`icu:${cps.join(",")}`);
      },
      memoSize: () => 3,
      rssMb: () => 9,
      write: () => {},
    };
    const oracle = {
      resolvedPrimary: async () => "Arial",
      facesFor: async (cps: number[]) => {
        events.push(`chrome:${cps.join(",")}`);
        return cps.map(() => [chrome({ familyName: "Arial", postScriptName: "Arial" })]);
      },
      assertStable: async (at: string) => {
        events.push(`stable:${at.match(/batch (\d+)/)?.[1]}`);
      },
    };
    await sweepStack(spec, 0, 1, [0x41, 0x42, 0x43], opts, oracle, tally, Date.now(), operations);
    expect(events).toEqual([
      "scope:ja",
      "prepare",
      "chrome:65",
      "stable:1",
      "icu:65",
      "ours:65",
      "chrome:66",
      "stable:2",
      "icu:66",
      "ours:66",
      "reset",
      "prepare",
      "chrome:67",
      "stable:3",
      "icu:67",
      "ours:67",
    ]);
    expect(tally.stackPrimaries[0].chromePrimary).toBe("Arial");
    expect(tally.peakMemoEntries).toBe(3);
    expect(tally.peakRssMb).toBe(9);
    expect(tally.mismatchRowsSeen).toBe(0);
    expect(Object.values(tally.counts).reduce((sum, count) => sum + count, 0)).toBe(3);
  });

  it("primes one sparse low-byte batch before any scalar resolution", async () => {
    const codepoints = Array.from({ length: 20 }, (_, i) => (i + 1) << 8);
    const events: string[] = [];
    const spec: StackSpec = { fontFamily: "A", fontSize: 16, fontWeight: 400, fontStyle: "normal" };
    const opts = parseArgs(["--sample-byte", "00", "--batch", "20"]);
    const tally = new SweepTally(10, opts.lang, false, { entries: [], hits: [] });
    const operations: SweepOperations = {
      platform: "darwin",
      selectScope: () => {},
      prepare: (() => ({ chain: ["A"], primaryKey: "A" })) as SweepOperations["prepare"],
      reset: () => {},
      primeCodepoints: (cps) => events.push(`icu:${cps.join(",")}`),
      faceFor: ((cp: number) => {
        events.push(`ours:${cp}`);
        return ours({ key: "Arial", postscriptName: "Arial" });
      }) as SweepOperations["faceFor"],
      memoSize: () => 0,
      rssMb: () => 0,
      write: () => {},
    };
    const oracle = {
      resolvedPrimary: async () => "Arial",
      facesFor: async (cps: number[]) => {
        events.push(`chrome:${cps.join(",")}`);
        return cps.map(() => [chrome({ familyName: "Arial", postScriptName: "Arial" })]);
      },
    };
    await sweepStack(spec, 0, 1, codepoints, opts, oracle, tally, Date.now(), operations);
    expect(events).toEqual([
      `chrome:${codepoints.join(",")}`,
      `icu:${codepoints.join(",")}`,
      ...codepoints.map((cp) => `ours:${cp}`),
    ]);
    expect(tally.mismatchRowsSeen).toBe(0);
  });

  it("stops before resolving or recording a batch whose oracle donors changed", async () => {
    const events: string[] = [];
    const spec: StackSpec = { fontFamily: "serif", fontSize: 16, fontWeight: 400, fontStyle: "normal" };
    const opts = parseArgs(["--range", "0041-0043", "--batch", "1"]);
    const tally = new SweepTally(10, opts.lang, false, { entries: [], hits: [] });
    const guard = new OracleStabilityGuard();
    const operations: SweepOperations = {
      platform: "darwin",
      selectScope: () => {},
      prepare: (() => ({ chain: ["serif"], primaryKey: "serif" })) as SweepOperations["prepare"],
      reset: () => {},
      faceFor: ((cp: number) => {
        events.push(`ours:${cp}`);
        return ours({ key: "Times", postscriptName: "Times" });
      }) as SweepOperations["faceFor"],
      primeCodepoints: () => {},
      memoSize: () => 0,
      rssMb: () => 0,
      write: () => {},
    };
    const oracle = {
      resolvedPrimary: async () => "Times",
      facesFor: async (cps: number[]) => {
        events.push(`chrome:${cps[0]}`);
        return [[chrome({ familyName: "Times", postScriptName: "Times" })]];
      },
      assertStable: async (at: string) => {
        guard.observe([at.includes("batch 2") ? "serif=Times-Roman" : "serif=TimesNewRomanPSMT"], at);
      },
    };
    await expect(
      sweepStack(spec, 0, 1, [0x41, 0x42, 0x43], opts, oracle, tally, Date.now(), operations),
    ).rejects.toBeInstanceOf(OracleDriftError);
    expect(events).toEqual(["chrome:65", "ours:65", "chrome:66"]);
    expect(Object.values(tally.counts).reduce((sum, count) => sum + count, 0)).toBe(1);
  });
});

const ours = (o: Partial<OurFace>): OurFace => ({ key: "x", path: null, postscriptName: null, covered: true, ...o });
const chrome = (o: Partial<ChromeFace>): ChromeFace => ({ familyName: "", glyphCount: 1, ...o });

describe("sweep state transitions", () => {
  const spec: StackSpec = { fontFamily: "sans-serif", fontSize: 13, fontWeight: 400, fontStyle: "normal" };

  it("keys the full stack and its effective locale", () => {
    expect(stackKey(spec, "en")).not.toBe(stackKey({ ...spec, fontWeight: 700 }, "en"));
    expect(stackKey(spec, "en")).not.toBe(stackKey({ ...spec, lang: "ja" }, "en"));
  });

  it("retains bounded examples while counting an empty, mismatch, allowlisted, and refill sequence", () => {
    const allowlist = { entries: [{ lo: 0x42, hi: 0x42, reason: "accepted test divergence" }], hits: [0] };
    const tally = new SweepTally(1, "en", false, allowlist);
    const wrong = ours({ key: "Other", postscriptName: "OtherFace" });
    const faces = [chrome({ familyName: "ChromeFace", postScriptName: "ChromeFace" })];
    expect(tally.mismatches).toEqual([]);
    tally.record(spec, 0x41, faces, wrong);
    tally.record(spec, 0x42, faces, wrong);
    tally.record(spec, 0x43, faces, wrong);
    expect(tally.counts.mismatch).toBe(2);
    expect(tally.allowlistedCount).toBe(1);
    expect(allowlist.hits).toEqual([1]);
    expect(tally.mismatchRowsSeen).toBe(2);
    expect(tally.mismatches.map((row) => row.cp)).toEqual([0x41]);
    expect(tally.stackCounts.get(stackKey(spec, "en"))).toBe(2);
    expect(tally.chromeFaceTally.get("ChromeFace")).toBe(3);
    const digest = tally.resolverAnswerHash.digest("hex");
    const unbounded = new SweepTally(3, "en", false, { entries: [], hits: [] });
    for (const cp of [0x41, 0x42, 0x43]) unbounded.record(spec, cp, faces, wrong);
    expect(unbounded.resolverAnswerHash.digest("hex")).toBe(digest);
  });

  it("resets on the requested batch cadence and scopes oracles by platform and locale", async () => {
    expect([0, 1, 2, 3, 4].map((batch) => shouldResetBatch(2, batch))).toEqual([false, false, true, false, true]);
    expect(shouldResetBatch(0, 20)).toBe(false);
    expect(oracleScopeKey("linux", "ja")).not.toBe(oracleScopeKey("linux", "en"));
    expect(oracleScopeKey("darwin", "ja")).toBe(oracleScopeKey("darwin", "en"));
    const closed: string[] = [];
    const linux = new OracleRegistry("linux", async (lang) => ({
      lang,
      close: async () => {
        closed.push(lang);
      },
    }));
    const en = await linux.forLang("en");
    const ja = await linux.forLang("ja");
    expect(await linux.forLang("en")).toBe(en);
    expect(ja).not.toBe(en);
    await linux.close();
    expect(closed.sort()).toEqual(["en", "ja"]);
    const shared = new OracleRegistry("darwin", async (lang) => ({ lang, close: async () => undefined }));
    expect(await shared.forLang("en")).toBe(await shared.forLang("ja"));
    await shared.close();
    let attempts = 0;
    const retry = new OracleRegistry("linux", async (lang) => {
      if (attempts++ === 0) throw new Error("context setup failed");
      return { lang, close: async () => undefined };
    });
    await expect(retry.forLang("ja")).rejects.toThrow("context setup failed");
    expect((await retry.forLang("ja")).lang).toBe("ja");
    await retry.close();
  });

  it("builds bounded report and readable summary from the same tally", () => {
    const opts = parseArgs([]);
    const corpus: StackCorpus = { generatedAt: "corpus-digest", platform: "darwin", sources: [], stacks: [spec] };
    const tally = new SweepTally(0, "en", false, { entries: [], hits: [] });
    tally.record(
      spec,
      0x41,
      [chrome({ familyName: "ChromeFace", postScriptName: "ChromeFace" })],
      ours({ key: "Other", postscriptName: "OtherFace" }),
    );
    const report = buildReport({
      opts,
      corpus,
      universeLength: 1,
      stackLength: 1,
      oracleIsolation: "shared-renderer",
      resolverAnswerDigest: tally.resolverAnswerHash.digest("hex"),
      tally,
      wallMs: 100,
      generatedAt: "2026-01-01T00:00:00.000Z",
      platform: "darwin",
      arch: "arm64",
      nodeVersion: "v22",
      unicode: "16.0",
      icu: "76",
      chromiumVersion: "123",
      parityEnv: {},
      rotationRevision: null,
      rotationOrdinal: null,
      rotationStackBucket: null,
      host: { name: "fixture", cpus: 1, arch: "arm64" },
      fontInventory: null,
    });
    expect(report.summary.comparisons).toBe(1);
    expect(report.summary.mismatchTotal).toBe(1);
    expect(report.rowsRetained).toBe(0);
    expect(report.rowsTruncated).toBe(1);
    expect(report.meta.generatedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(formatSummary(report, opts, corpus, tally, 1, 1)).toContain("MISMATCH total     1");
  });
});

describe("oracle resolver question", () => {
  it("passes the raw CSS family stack used by Blink's standard-style retry", () => {
    const source = readFileSync(join(process.cwd(), "tools/font-conformance.ts"), "utf8").replace(/\s+/g, " ");
    expect(source).toMatch(
      /stackPrimaryIsSystemUi\(rs\.spec\.fontFamily, lang\), rs\.stretch, undefined, .* rs\.spec\.fontFamily, \);/,
    );
  });
});

describe("verdictForCodepoint", () => {
  it("does not grade HarfBuzz default-ignorables by CDP's bookkeeping face", () => {
    const c = chrome({ postScriptName: "Times-Roman", familyName: "Times" });
    const o = ours({ postscriptName: "AppleColorEmoji" });
    for (const cp of [0x00ad, 0x061c, 0x180b, 0x2064, 0xfe0f, 0xe0061]) {
      expect(verdictForCodepoint(cp, c, o, false)).toBe("agree-not-painted");
    }
  });

  it("still grades visible codepoints and width-carrying spaces by face", () => {
    const c = chrome({ postScriptName: "Times-Roman", familyName: "Times" });
    const o = ours({ postscriptName: "TimesNewRomanPSMT" });
    expect(verdictForCodepoint(0x41, c, o, false)).toBe("mismatch");
    expect(verdictForCodepoint(0x2000, c, o, false)).toBe("mismatch");
  });
});

describe("buildUniverse", () => {
  it("excludes surrogates, noncharacters and controls, and keeps everything else assigned", () => {
    const u = new Set(buildUniverse({ includePua: true, ranges: null }));
    // Surrogates are gc=Cs — `\p{Assigned}` counts them, so this is a real filter.
    expect(u.has(0xd800)).toBe(false);
    expect(u.has(0xdfff)).toBe(false);
    // Noncharacters, both flavors.
    expect(u.has(0xfdd0)).toBe(false);
    expect(u.has(0xfffe)).toBe(false);
    expect(u.has(0x10ffff)).toBe(false);
    // C0 / C1 controls — the HTML layer mangles these, so their answers would lie.
    expect(u.has(0x0000)).toBe(false);
    expect(u.has(0x000a)).toBe(false);
    expect(u.has(0x009f)).toBe(false);
    // Assigned, ordinary.
    expect(u.has(0x0041)).toBe(true);
    expect(u.has(0x4e2d)).toBe(true);
    expect(u.has(0x1f600)).toBe(true);
    // Space is kept: it is a real codepoint with a real face, and the probe
    // page uses `white-space: pre` so Chrome actually paints it.
    expect(u.has(0x0020)).toBe(true);
  });

  it("excludes unassigned codepoints", () => {
    const u = new Set(buildUniverse({ includePua: true, ranges: [[0x0870, 0x089f]] }));
    expect(u.has(0x0870)).toBe(true); // Arabic Extended-B, assigned
    // Reserved hole in the same block. `buildUniverse` deliberately tracks the
    // RUNTIME's `\p{Assigned}` tables (the baselines record the Unicode version
    // and refuse to compare across a change), so this pin must be a codepoint
    // unassigned in every Unicode version the suite runs under: the previous
    // pin, U+088F, was assigned in Unicode 17.0 (Node 24's data) while a Node
    // 22 host still carries 16.0 — making the test a Unicode-version detector
    // rather than a filter test. U+0892 is reserved in both.
    expect(u.has(0x0892)).toBe(false);
  });

  it("drops private use only when asked, and the drop is large enough to matter", () => {
    const withPua = buildUniverse({ includePua: true, ranges: null });
    const without = buildUniverse({ includePua: false, ranges: null });
    expect(withPua.length - without.length).toBe(137_468);
    expect(without).not.toContain(0xe000);
    expect(withPua).toContain(0xe000);
  });

  it("honors multiple ranges", () => {
    const u = buildUniverse({
      includePua: true,
      ranges: [
        [0x41, 0x43],
        [0x61, 0x62],
      ],
    });
    expect(u).toEqual([0x41, 0x42, 0x43, 0x61, 0x62]);
  });

  it("uses low-byte buckets as disjoint samples spanning Unicode", () => {
    const zero = buildUniverse({ includePua: true, ranges: null, sampleByte: 0x00 });
    const one = buildUniverse({ includePua: true, ranges: null, sampleByte: 0x01 });
    expect(zero.length).toBeGreaterThan(1_000);
    expect(zero.every((cp) => (cp & 0xff) === 0x00)).toBe(true);
    expect(one.every((cp) => (cp & 0xff) === 0x01)).toBe(true);
    const oneSet = new Set(one);
    expect(zero.some((cp) => oneSet.has(cp))).toBe(false);
    // These are separated by many Unicode blocks and planes, proving this is
    // not the contiguous U+0000–U+00FF page.
    expect(zero).toContain(0x0100);
    expect(zero).toContain(0x1f600);
  });
});

describe("needsIsolatedQuery", () => {
  it("flags marks and default-ignorables, which can contribute zero or two glyphs to a cell", () => {
    expect(needsIsolatedQuery(0x0301)).toBe(true); // combining acute
    expect(needsIsolatedQuery(0x200d)).toBe(true); // ZWJ
    expect(needsIsolatedQuery(0xfe0f)).toBe(true); // VS16
    expect(needsIsolatedQuery(0x0041)).toBe(false);
  });
});

describe("identifyFace", () => {
  it("matches on PostScript name", () => {
    expect(
      identifyFace(
        chrome({ postScriptName: "Arimo-Bold", familyName: "Arimo" }),
        ours({ postscriptName: "Arimo-Bold" }),
        false,
      ),
    ).toBe("agree-exact");
  });

  it("does NOT match a different cut of the same family", () => {
    expect(
      identifyFace(
        chrome({ postScriptName: "Arimo-Bold", familyName: "Arimo" }),
        ours({ postscriptName: "Arimo-Regular", path: "/tmp/Arimo-Regular.ttf" }),
        false,
      ),
    ).toBe(null);
  });

  it("does not match on family name alone when the PostScript names disagree", () => {
    expect(
      identifyFace(
        chrome({ postScriptName: "TimesNewRomanPSMT", familyName: "Times New Roman" }),
        ours({ postscriptName: "Times-Roman", path: "/System/Library/Fonts/Times.ttc" }),
        false,
      ),
    ).toBe(null);
  });

  it("does not alias an exact named SF Pro face to the system SFNS face", () => {
    const c = chrome({ postScriptName: "SFProText-Regular", familyName: "SF Pro Text" });
    const o = ours({ key: "sf-pro", path: "/System/Library/Fonts/SFNS.ttf" });
    expect(identifyFace(c, o, false)).toBe(null);
    expect(identifyFace(c, o, true)).toBe(null);
  });

  it("does not let the system-font alias absorb an unrelated face", () => {
    expect(
      identifyFace(
        chrome({ postScriptName: "SFProText-Regular", familyName: "SF Pro Text" }),
        ours({ key: "u-arial-unicode-ms", postscriptName: "ArialUnicodeMS", path: "/x/Arial Unicode.ttf" }),
        false,
      ),
    ).toBe(null);
  });

  it("refuses to identify a face from an unusably short name", () => {
    expect(identifyFace(chrome({ familyName: "" }), ours({ postscriptName: "Helvetica" }), false)).toBe(null);
  });

  it("will not read a shared FILE as a shared face when both sides are named", () => {
    // Helvetica.ttc holds Regular, Bold, Oblique and Bold-Oblique behind ONE
    // path. Accepting the file match here is precisely what let a wrong-cut
    // pick score as agreement, so two differing PostScript names must lose even
    // when the file is identical.
    expect(
      identifyFace(
        chrome({ postScriptName: "Helvetica-Bold", familyName: "Helvetica" }),
        ours({ key: "helvetica", postscriptName: "Helvetica", path: "/System/Library/Fonts/Helvetica.ttc" }),
        false,
      ),
    ).toBe(null);
  });

  // Tier 2 needs the host's font matcher to resolve a real name to a real file,
  // so it can only be exercised where a known-installed face is available.
  const installed = (() => {
    for (const name of ["Arial", "Helvetica", "DejaVu Sans", "Liberation Sans", "Times New Roman"]) {
      try {
        const f = resolveInstalledFont(name);
        if (f != null && f.path !== "") return f;
      } catch {
        /* helper unavailable on this host */
      }
    }
    return null;
  })();

  it.skipIf(installed == null)("still uses the file when our side has no name of its own", () => {
    // Path-table entries that declare no PostScript name are the case tier 2
    // exists for; the guard above must not take that away.
    expect(
      identifyFace(
        chrome({ postScriptName: installed!.postscriptName, familyName: "whatever" }),
        ours({ key: "k", postscriptName: null, path: installed!.path }),
        false,
      ),
    ).toBe("agree-same-file");
  });

  it.skipIf(installed == null)("drops to a mismatch once our side IS named and the names disagree", () => {
    // Same file, same Chrome face as the test above — the only thing that
    // changed is that we can now name our face, and it is a different one.
    expect(
      identifyFace(
        chrome({ postScriptName: installed!.postscriptName, familyName: "whatever" }),
        ours({ key: "k", postscriptName: `${installed!.postscriptName}-SomeOtherCut`, path: installed!.path }),
        false,
      ),
    ).toBe(null);
  });

  it("never file-resolves a hidden `.`-prefixed system name (CoreText answers those with Times New Roman)", () => {
    // If the guard regressed, this would resolve `.SFArabic-Bold` to
    // /System/Library/Fonts/Supplemental/Times New Roman.ttf and agree with a
    // Times pick — inventing parity out of a CoreText quirk.
    expect(
      identifyFace(
        chrome({ postScriptName: ".SFArabic-Bold", familyName: ".SF Arabic" }),
        ours({ key: "times", postscriptName: null, path: "/System/Library/Fonts/Supplemental/Times New Roman.ttf" }),
        false,
      ),
    ).toBe(null);
  });
});

describe("mismatchClass", () => {
  it("separates a routing defect from a cut-selection defect", () => {
    expect(mismatchClass("Arimo-Bold", "Arimo-Regular")).toBe("same-family-different-cut");
    expect(mismatchClass(".SFArabic-Bold", ".SFArabic-Regular")).toBe("same-family-different-cut");
    expect(mismatchClass(".SFDevanagari-Regular", "KohinoorDevanagari-Regular")).toBe("different-family");
    expect(mismatchClass("Kokonor", "Kailasa")).toBe("different-family");
  });
});

describe("primaryChromeFace", () => {
  it("takes the highest glyph count rather than trusting array order", () => {
    const faces = [chrome({ familyName: "A", glyphCount: 1 }), chrome({ familyName: "B", glyphCount: 5 })];
    expect(primaryChromeFace(faces)?.familyName).toBe("B");
  });

  it("returns null for a cell Chrome painted nothing in", () => {
    expect(primaryChromeFace([])).toBe(null);
  });
});

describe("slantForStyle", () => {
  it("mirrors the renderer's italic slant", () => {
    expect(slantForStyle("normal")).toBe(0);
    expect(slantForStyle("italic")).toBeLessThan(0);
    expect(slantForStyle("oblique 14deg")).toBeLessThan(0);
  });
});

describe("allowlist", () => {
  const write = (body: unknown): string => {
    const dir = mkdtempSync(join(tmpdir(), "fc-allow-"));
    const f = join(dir, "allowlist.json");
    writeFileSync(f, JSON.stringify(body));
    return f;
  };

  it("ships empty — a pre-populated allowlist would destroy the measurement", () => {
    const al = loadAllowlist("tools/font-conformance-allowlist.json");
    expect(al.entries).toEqual([]);
  });

  it("rejects an entry with no reason", () => {
    expect(() => loadAllowlist(write({ entries: [{ cp: "0x20BF" }] }))).toThrow(/reason/);
  });

  it("rejects a perfunctory reason", () => {
    expect(() => loadAllowlist(write({ entries: [{ cp: "0x20BF", reason: "known" }] }))).toThrow(/reason/);
  });

  it("rejects a malformed codepoint", () => {
    expect(() => loadAllowlist(write({ entries: [{ cp: "U+20BF", reason: "a properly worded reason" }] }))).toThrow(
      /0xNNNN/,
    );
  });

  it("matches single codepoints, ranges and stack scoping, and counts hits", () => {
    const al = loadAllowlist(
      write({
        entries: [
          { cp: "0x20BF", reason: "a properly worded reason for this one codepoint" },
          { cp: "0x1F000-0x1F00F", stack: "Times", reason: "a properly worded reason for this range" },
        ],
      }),
    );
    expect(allowlisted(al, 0x20bf, "anything")).toBe(true);
    expect(allowlisted(al, 0x20c0, "anything")).toBe(false);
    expect(allowlisted(al, 0x1f005, "Times")).toBe(true);
    expect(allowlisted(al, 0x1f005, "Menlo")).toBe(false); // stack-scoped
    expect(allowlisted(al, 0x1f010, "Times")).toBe(false); // past the range end
    expect(al.hits).toEqual([1, 1]);
  });

  it("treats a missing file as an empty allowlist", () => {
    expect(loadAllowlist("/nonexistent/allowlist.json").entries).toEqual([]);
  });
});

describe("parseArgs", () => {
  it("accepts a targeted stack-signature filter", () => {
    expect(parseArgs(["--stack-filter", "lang=ja"]).stackFilter).toBe("lang=ja");
  });
  it("defaults to the whole universe and THIS PLATFORM's committed corpus", () => {
    const o = parseArgs([]);
    expect(o.ranges).toBe(null);
    expect(o.sampleByte).toBe(null);
    expect(o.includePua).toBe(true);
    expect(o.shard).toBe(null);
    expect(o.stackShard).toBe(null);
    // Per-platform, not shared: an element that declares no font-family
    // computes to Chrome's per-platform default-font preference, so the
    // corpus's largest stack is `Times` on macOS and `"Times New Roman"` on
    // Linux. Defaulting to one shared file would sweep stacks the host's
    // Chrome never computes.
    expect(o.stacksFile).toBe(`tools/font-conformance-stacks.${process.platform}.json`);
    expect(o.allowlistFile).toBe("tools/font-conformance-allowlist.json");
    expect(o.allowForeignCorpus).toBe(false);
  });

  it("names the corpus file after the platform's own spelling", () => {
    expect(stacksFileFor("darwin")).toBe("tools/font-conformance-stacks.darwin.json");
    expect(stacksFileFor("linux")).toBe("tools/font-conformance-stacks.linux.json");
    expect(stacksFileFor("win32")).toBe("tools/font-conformance-stacks.win32.json");
  });

  it("parses ranges, shards and flags", () => {
    const o = parseArgs([
      "--range",
      "0000-00FF,1F600",
      "--shard",
      "2/8",
      "--stack-shard",
      "3/16",
      "--no-pua",
      "--strict-alias",
    ]);
    expect(o.ranges).toEqual([
      [0x0, 0xff],
      [0x1f600, 0x1f600],
    ]);
    expect(o.shard).toEqual([2, 8]);
    expect(o.stackShard).toEqual([3, 16]);
    expect(o.includePua).toBe(false);
    expect(o.strictAlias).toBe(true);
  });

  it("parses a two-digit low-byte sample and rejects ambiguous selectors", () => {
    expect(parseArgs(["--sample-byte", "aF"]).sampleByte).toBe(0xaf);
    expect(() => parseArgs(["--sample-byte", "0"])).toThrow(/two hex digits/);
    expect(() => parseArgs(["--sample-byte", "100"])).toThrow(/two hex digits/);
    expect(() => parseArgs(["--sample-byte", "00", "--range", "0000-00FF"])).toThrow(/use only one/);
  });

  it("caps retained rows by default, because one wrong route makes ~200k of them", () => {
    expect(parseArgs([]).maxRows).toBe(20_000);
    expect(parseArgs(["--max-rows", "5"]).maxRows).toBe(5);
  });

  it("rejects an unknown option rather than silently sweeping something else", () => {
    expect(() => parseArgs(["--reange", "0000"])).toThrow(/unknown option/);
    expect(() => parseArgs(["--shard", "2"])).toThrow(/i\/N/);
  });

  it("rejects empty and out-of-range shards before starting the oracle", () => {
    for (const flag of ["--shard", "--stack-shard"]) {
      expect(() => parseArgs([flag, "0/8"])).toThrow(/out of range/);
      expect(() => parseArgs([flag, "9/8"])).toThrow(/out of range/);
      expect(() => parseArgs([flag, "1/0"])).toThrow(/out of range/);
      expect(() => parseArgs([flag, "9007199254740993/9007199254740993"])).toThrow(/out of range/);
    }
  });

  it("rejects malformed numeric flags while retaining reset-every zero", () => {
    for (const flag of ["--batch", "--concurrency", "--max-stacks", "--max-rows"]) {
      expect(() => parseArgs([flag, "abc"])).toThrow(/needs an integer/);
      expect(() => parseArgs([flag, "0"])).toThrow(/needs an integer/);
      expect(() => parseArgs([flag, "2x"])).toThrow(/needs an integer/);
    }
    expect(() => parseArgs(["--reset-every", "abc"])).toThrow(/needs an integer/);
    expect(parseArgs(["--reset-every", "0"]).resetEvery).toBe(0);
  });
});

/**
 * The oracle's answer must be the face the RENDERER would load, which is the
 * weight/slant-selected CUT — not the family's base entry in the path table.
 *
 * These assert an INVARIANT rather than a hardcoded face name: which families
 * ship which cuts is a property of the host's installed fonts (macOS
 * Helvetica.ttc vs Linux Liberation vs Windows Arial), so the fixed expectation
 * is "whatever `getFontInstance` loaded", which is true everywhere. Where the
 * host has no cut-routed family at all, the walk simply finds nothing and the
 * test says so instead of silently passing on zero cases.
 */
describe("faceFor reports the cut the renderer would load", () => {
  const stack = (o: Partial<StackSpec>): StackSpec => ({
    fontFamily: "sans-serif",
    fontSize: 32,
    fontWeight: 400,
    fontStyle: "normal",
    fixtures: 1,
    example: "x.html",
    ...o,
  });

  /** Faces that route to a different cut somewhere on this host, if any. */
  const CUT_FAMILIES = [
    "sans-serif",
    "serif",
    "monospace",
    "Helvetica",
    "Arial",
    "Times",
    "Georgia",
    "Courier",
    "Menlo",
  ];

  const cutCases = CUT_FAMILIES.flatMap((fontFamily) =>
    [
      { fontWeight: 700, fontStyle: "normal" },
      { fontWeight: 400, fontStyle: "italic" },
      { fontWeight: 100, fontStyle: "normal" },
    ].map((v) => stack({ fontFamily, ...v })),
  )
    .map((spec) => ({ spec, rs: prepareStack(spec) }))
    .filter((c): c is { spec: StackSpec; rs: NonNullable<ReturnType<typeof prepareStack>> } => c.rs != null)
    .filter((c) => {
      const base = resolveFontSpec(c.rs.primaryKey);
      const real = getFontSourceInfo(c.rs.primary);
      return (
        (base?.path ?? null) !== (real?.path ?? null) ||
        (base?.postscriptName ?? null) !== (real?.postscriptName ?? null) ||
        c.rs.primary.postscriptName != null
      );
    });

  it("finds at least one cut-routed family on this host to assert against", () => {
    expect(cutCases.length).toBeGreaterThan(0);
  });

  it.each(cutCases.map((c) => [`${c.spec.fontFamily} ${c.spec.fontWeight}/${c.spec.fontStyle}`, c] as const))(
    "%s names the loaded face, not the family base entry",
    (_label, c) => {
      const face = faceFor(c.rs, c.rs.primaryKey, true, null);
      const loaded = getFontSourceInfo(c.rs.primary);
      // The path is the file the instance came from…
      if (loaded?.path != null) expect(face.path).toBe(loaded.path);
      // …and the name is the face fontkit actually opened, when it has one.
      if (c.rs.primary.postscriptName != null) expect(face.postscriptName).toBe(c.rs.primary.postscriptName);
    },
  );

  it("does not serve one stack's cut to another — the cache is per stack, and weight decides", () => {
    // Two stacks over the SAME family that differ only in weight. A cache keyed
    // on the font key alone (which is what the oracle used to have, at module
    // scope) would answer the second from the first and hide every cut defect
    // in every stack after the first.
    const light = prepareStack(stack({ fontWeight: 100 }));
    const bold = prepareStack(stack({ fontWeight: 900 }));
    if (light == null || bold == null) return; // no sans-serif on this host
    expect(light.faceCache).not.toBe(bold.faceCache);
    const lightFace = faceFor(light, light.primaryKey, true, null);
    const boldFace = faceFor(bold, bold.primaryKey, true, null);
    // Same key, and yet the answers track the instances rather than the key.
    expect(light.primaryKey).toBe(bold.primaryKey);
    expect(lightFace.postscriptName ?? lightFace.path).toBe(
      getFontSourceInfo(light.primary)?.postscriptName ??
        light.primary.postscriptName ??
        getFontSourceInfo(light.primary)?.path,
    );
    expect(boldFace.postscriptName ?? boldFace.path).toBe(
      getFontSourceInfo(bold.primary)?.postscriptName ??
        bold.primary.postscriptName ??
        getFontSourceInfo(bold.primary)?.path,
    );
    // On any host whose sans-serif ships a bold sibling these are two faces.
    const differentInstances = light.primary !== bold.primary;
    if (differentInstances && light.primary.postscriptName !== bold.primary.postscriptName) {
      expect(lightFace.postscriptName).not.toBe(boldFace.postscriptName);
    }
  });

  it("opens system-ui through the renderer's primary route on every platform", () => {
    const family = "system-ui, -apple-system, sans-serif";
    const at400 = prepareStack(stack({ fontFamily: family, fontWeight: 400, fontSize: 20 }));
    const at700 = prepareStack(stack({ fontFamily: family, fontWeight: 700, fontSize: 20 }));
    expect(at400).not.toBeNull();
    expect(at700).not.toBeNull();
    for (const [weight, run] of [
      [400, at400],
      [700, at700],
    ] as const) {
      const rendered = resolveFont(family, weight, 20);
      const axes = (font: typeof rendered) =>
        (font as typeof font & { _appliedVariationAxes?: Record<string, number> })?._appliedVariationAxes;
      expect(axes(run!.primary)).toEqual(axes(rendered));
      expect(faceFor(run!, run!.primaryKey, true, null).postscriptName).toBe(
        rendered?.instantiatedPostscriptName ?? rendered?.postscriptName,
      );
      if (process.platform === "darwin") expect(axes(run!.primary)?.wght).toBe(weight);
    }
    if (process.platform === "darwin") {
      expect(faceFor(at400!, at400!.primaryKey, true, null).postscriptName).toBe(".SFNS-Regular");
      expect(faceFor(at700!, at700!.primaryKey, true, null).postscriptName).toBe(".SFNS-Bold");
    }
  });

  it("hands an uncovered codepoint the primary's CUT as the tofu donor", () => {
    const rs = prepareStack(stack({ fontWeight: 700 }));
    if (rs == null) return;
    // The renderer draws the primary INSTANCE's `.notdef` for anything nothing
    // covers, and that instance is the bold cut — reporting the family's
    // regular face here would disagree with Chrome on most of Unicode, since
    // the uncovered bucket is the largest one in any sweep.
    expect(rs.notdefDonor.covered).toBe(false);
    expect(rs.notdefDonor.path).toBe(getFontSourceInfo(rs.primary)?.path ?? rs.notdefDonor.path);
    if (rs.primary.postscriptName != null) {
      expect(rs.notdefDonor.postscriptName).toBe(rs.primary.postscriptName);
    }
  });

  it("falls back to the path table for a key with no loadable instance", () => {
    const rs = prepareStack(stack({}));
    if (rs == null) return;
    // An unknown key resolves to no instance at all; the oracle must still say
    // what it can rather than crash mid-sweep.
    const face = faceFor(rs, "no-such-font-key", true, null);
    expect(face.key).toBe("no-such-font-key");
    expect(face.path).toBe(null);
    expect(face.postscriptName).toBe(null);
  });

  it("reads a `sysfb:` key's embedded PostScript name when nothing else names the face", () => {
    const rs = prepareStack(stack({}));
    if (rs == null) return;
    const face = faceFor(rs, "sysfb:NoSuchInstalledFace-Regular", true, null);
    expect(face.postscriptName).toBe("NoSuchInstalledFace-Regular");
  });

  it("prefers a per-codepoint override's own face over the key's", () => {
    const rs = prepareStack(stack({}));
    if (rs == null) return;
    const other = getFontInstance("times", 400, 32, 0);
    if (other == null || getFontSourceInfo(other) == null) return;
    const face = faceFor(rs, rs.primaryKey, true, other);
    expect(face.path).toBe(getFontSourceInfo(other)!.path);
    // …and an override must never be written into the per-key cache, or the
    // next codepoint on the same key inherits it.
    expect(faceFor(rs, rs.primaryKey, true, null).path).toBe(getFontSourceInfo(rs.primary)?.path ?? null);
  });
});

/**
 * The probe page is where a recorded property becomes a question actually put
 * to Chrome. Extracting a property and then not declaring it here leaves the
 * oracle sweeping as though the property were absent — a silent blind spot that
 * reads as a stable number rather than as a failure.
 */
describe("the probe page declares every property the corpus records", () => {
  const spec = (o: Partial<StackSpec>): StackSpec => ({
    fontFamily: "Georgia, serif",
    fontSize: 24,
    fontWeight: 400,
    fontStyle: "normal",
    fixtures: 1,
    example: "x.html",
    ...o,
  });

  it("declares the full font description, not just family/size/weight/style", () => {
    const html = probePageHtml(
      [0x41],
      spec({
        fontStretch: "75%",
        fontVariationSettings: '"wght" 350',
        fontFeatureSettings: '"smcp" 1',
        fontVariantAlternates: "historical-forms",
        fontVariantEmoji: "emoji",
      }),
      "en",
    );
    expect(html).toContain("font-family:Georgia, serif");
    expect(html).toContain("font-size:24px");
    expect(html).toContain("font-weight:400");
    expect(html).toContain("font-style:normal");
    expect(html).toContain("font-stretch:75%");
    expect(html).toContain('font-variation-settings:"wght" 350');
    expect(html).toContain('font-feature-settings:"smcp" 1');
    expect(html).toContain("font-variant-alternates:historical-forms");
    expect(html).toContain("font-variant-emoji:emoji");
    expect(html).toContain('<html lang="en"');
  });

  it("reads an absent property as `normal`, so a corpus predating it still sweeps", () => {
    // The late additions are optional on `StackSpec` precisely so an older
    // corpus file parses. Absent must mean the CSS initial value and not
    // `undefined` leaking into the stylesheet.
    const html = probePageHtml([0x41], spec({}), "en");
    expect(html).toContain("font-stretch:normal");
    expect(html).toContain("font-variation-settings:normal");
    expect(html).toContain("font-feature-settings:normal");
    expect(html).toContain("font-variant-alternates:normal");
    expect(html).toContain("font-variant-emoji:normal");
    expect(html).not.toContain("undefined");
  });

  it("declares `font-variant-emoji`, the one late addition that really selects a face", () => {
    // Worth its own case rather than folding into the list above, because it is
    // the only one of these properties whose omission changes which FACE Chrome
    // reports — it overrides the run's `FontFallbackPriority`
    // (`platform/fonts/shaping/harfbuzz_shaper.cc:184-198`, Chromium
    // `7d859f27`). Measured on macOS: U+2764 reports `ZapfDingbatsITC` under
    // `normal` and `AppleColorEmoji` under `emoji`; U+1F600 reports
    // `AppleColorEmoji` under `normal` and `.AppleColorEmojiUI` under `text`.
    //
    // No fixture in the corpus declares it today, so the corpus-content guard
    // used for `font-feature-settings` below cannot exist for this one — which
    // makes pinning the DECLARATION the only thing standing between "extracted"
    // and "actually asked".
    for (const v of ["text", "emoji", "unicode"]) {
      expect(probePageHtml([0x2764], spec({ fontVariantEmoji: v }), "en")).toContain(`font-variant-emoji:${v}`);
    }
  });

  it("keeps the cell isolation that makes a per-codepoint answer meaningful", () => {
    const html = probePageHtml([0x41, 0x4e00], spec({}), "ja");
    // One inline-block per codepoint, so shaping cannot cross a cell boundary…
    expect(html.match(/class=c/g)).toHaveLength(2);
    expect(html).toContain("display:inline-block");
    // …`white-space:pre` so a space-only cell still paints…
    expect(html).toContain("white-space:pre");
    // …`font-style:inherit` to undo the UA italic on `<i>`…
    expect(html).toContain("font-style:inherit");
    // …and the locale reaches the page, since Han routing is keyed on it.
    expect(html).toContain('<html lang="ja"');
    expect(html).toContain("&#x4e00;");
  });

  it("lets a per-stack language override the global language on every probe cell", () => {
    const html = probePageHtml([0x41, 0x4e00], spec({ lang: "ja" }), "en");
    expect(html).toContain('<html lang="en"');
    expect(html.match(/class=c lang="ja"/g)).toHaveLength(2);
  });
});

describe.each(["darwin", "linux", "win32"])("the committed %s stack corpus", (platform) => {
  const corpus = JSON.parse(readFileSync(stacksFileFor(platform), "utf-8")) as {
    platform?: string;
    sources: string[];
    stacks: Array<{
      fontFamily: string;
      fontSize: number;
      fontWeight: number;
      fontStyle: string;
      fontStretch?: string;
      fontVariationSettings?: string;
      fontFeatureSettings?: string;
      fontVariantAlternates?: string;
      fontVariantEmoji?: string;
      fixtures: number;
      example: string;
    }>;
  };

  it("records the platform it was extracted on", () => {
    // Without this the guard in the sweep cannot fire, and a corpus from the
    // wrong platform sweeps stacks the host's Chrome never computes.
    expect(corpus.platform).toBe(platform);
  });

  it("covers the corpus rather than a handful of hand-picked stacks", () => {
    expect(corpus.stacks.length).toBeGreaterThan(100);
    expect(new Set(corpus.stacks.map((s) => s.fontFamily)).size).toBeGreaterThan(50);
  });

  it("carries no absolute paths — it is committed and must not pin one checkout layout", () => {
    for (const s of corpus.stacks) expect(s.example.startsWith("/")).toBe(false);
    for (const src of corpus.sources) expect(src.startsWith("/")).toBe(false);
  });

  it("records a usable spec for every entry", () => {
    for (const s of corpus.stacks) {
      expect(s.fontFamily.length).toBeGreaterThan(0);
      expect(s.fontSize).toBeGreaterThan(0);
      expect(s.fontWeight).toBeGreaterThanOrEqual(1);
      expect(["normal", "italic", "oblique"]).toContain(s.fontStyle.split(" ")[0]);
      expect(s.fixtures).toBeGreaterThan(0);
      expect(s.example).toMatch(/\.html$/);
    }
  });

  it("records the whole font description on every entry, not a subset", () => {
    // A missing property is read as `normal`, which is indistinguishable from a
    // fixture that really declares `normal` — so an entry that simply lacks the
    // field is a stack swept under a weaker question with nothing to say so.
    for (const s of corpus.stacks) {
      expect(typeof s.fontStretch).toBe("string");
      expect(typeof s.fontVariationSettings).toBe("string");
      expect(typeof s.fontFeatureSettings).toBe("string");
      expect(typeof s.fontVariantAlternates).toBe("string");
      expect(typeof s.fontVariantEmoji).toBe("string");
    }
  });

  it("actually captured a non-normal `font-feature-settings` somewhere", () => {
    // The guard against a vacuous extraction: a property can be added to the
    // key, serialized on every entry, and still be `normal` everywhere because
    // it is being read from the wrong place. The fixture corpus declares
    // `liga`/`dlig`/`zero`/`ss01`/`ss02`/`salt`/`tnum`, so a corpus in which
    // every entry is `normal` means the extraction is not seeing them.
    const nonNormal = corpus.stacks.filter((s) => s.fontFeatureSettings != null && s.fontFeatureSettings !== "normal");
    expect(nonNormal.length).toBeGreaterThan(0);
    // …and each such entry must name the fixture it came from, so the claim is
    // reproducible by hand rather than taken on trust.
    for (const s of nonNormal) expect(s.example).toMatch(/\.html$/);
  });

  it("actually captured a non-normal `font-variant-alternates` somewhere", () => {
    // Same anti-vacuity guard, and it applies here for the same reason: the
    // corpus contains a fixture declaring `stylistic()` / `styleset()` /
    // `swash()` / `character-variant()` / `annotation()` / `ornaments()` /
    // `historical-forms`, so an all-`normal` column means the extraction is
    // reading from the wrong place rather than that the fixtures are quiet.
    const nonNormal = corpus.stacks.filter(
      (s) => s.fontVariantAlternates != null && s.fontVariantAlternates !== "normal",
    );
    expect(nonNormal.length).toBeGreaterThan(0);
    for (const s of nonNormal) expect(s.example).toMatch(/\.html$/);
  });

  it("records `font-variant-emoji` on every entry even though no fixture declares one", () => {
    // Deliberately NOT an anti-vacuity guard, and the asymmetry is the point.
    // No fixture in either corpus declares `font-variant-emoji`, so requiring a
    // non-normal value here would be a test that can only fail. What can be
    // required is that the column exists and carries legal values — the
    // discriminating check that the extractor reads the property from the right
    // place lives in the browser-backed extraction test, which supplies its own
    // fixture rather than relying on the corpus to contain one.
    for (const s of corpus.stacks) {
      expect(["normal", "text", "emoji", "unicode"]).toContain(s.fontVariantEmoji);
    }
  });
});
