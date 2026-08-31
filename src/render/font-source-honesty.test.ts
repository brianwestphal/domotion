// The reported-source honesty contract.
//
// `FontSourceInfo` / `FileFaceInfo` describe WHICH face a set of outlines came
// from. When the requested PostScript name is not a member of the container, the
// resolver used to answer `faceIndex: 0` plus member zero's variation axes —
// describing a face nobody asked for, in a shape indistinguishable from a real
// match. Two separate investigations read that as evidence of which member had
// been opened and drew the wrong conclusion from it.
//
// So the contract is: a name that is not in the file yields `faceIndex: null` /
// `nameMatched: false` / `fileAxes: null`, and downstream consumers that need a
// real index refuse to run rather than defaulting to member zero.
//
// Synthetic collections rather than system fonts: the assertions need exact
// knowledge of the member order and names, and must hold on every platform's CI.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  __resolveFaceInfoForFileForTest as faceInfo,
  clearFontResolutionCaches,
} from "./font-resolution.js";
import { buildStaticHintedFont, buildVariableHintedFont, wrapInTtc } from "./synth-test-fonts.js";

let dir: string;
/** 3-member collection: SynthAlpha (static), SynthBeta (VARIABLE, wght axis),
 *  SynthGamma (static). Member zero is deliberately the static one so a
 *  member-zero leak shows up as "axes absent" and a variable-member leak shows
 *  up as "axes present". */
let ttcPath: string;
/** Single-face file whose PostScript name is SynthSolo. */
let sfntPath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "domotion-face-info-"));
  ttcPath = path.join(dir, "collection.ttc");
  writeFileSync(ttcPath, wrapInTtc([
    buildStaticHintedFont({ family: "SynthAlpha" }),
    // SynthBeta declares two fvar named instances that are NOT members — the
    // shape Apple system faces have (PingFangSC-Regular is instance 0 of member
    // 20; .ThonburiUI-Bold is instance 2 of member 0).
    buildVariableHintedFont({
      family: "SynthBeta",
      namedInstances: [
        { postscriptName: "SynthBetaLight", wght: 200, subfamily: "Light" },
        { postscriptName: "SynthBetaBold", wght: 800, subfamily: "Bold" },
      ],
    }),
    buildStaticHintedFont({ family: "SynthGamma" }),
  ]));
  sfntPath = path.join(dir, "solo.ttf");
  writeFileSync(sfntPath, buildStaticHintedFont({ family: "SynthSolo" }));
  clearFontResolutionCaches();
});

afterEach(() => {
  clearFontResolutionCaches();
  rmSync(dir, { recursive: true, force: true });
});

describe("member-index resolution reports honestly", () => {
  it("names the index and axes of a member it actually found", () => {
    expect(faceInfo(ttcPath, "SynthAlpha")).toEqual({ faceIndex: 0, nameMatched: true, fileAxes: null, namedInstances: null, memberPostscriptName: "SynthAlpha" });
    const gamma = faceInfo(ttcPath, "SynthGamma");
    expect(gamma.faceIndex).toBe(2);
    expect(gamma.nameMatched).toBe(true);
  });

  it("honors a platform-supplied collection index even when its family label is not a PostScript name", () => {
    const beta = faceInfo(ttcPath, "Human Readable Family", 1);
    expect(beta.faceIndex).toBe(1);
    expect(beta.nameMatched).toBe(true);
    expect(beta.memberPostscriptName).toBe("SynthBeta");
    expect(Object.keys(beta.fileAxes ?? {})).toContain("wght");
  });

  it("reports the matched member's OWN axes, not member zero's", () => {
    // SynthBeta is the only variable member. Reading axes off member zero would
    // report null here, and reading member zero's axes for a request that
    // matched SynthBeta is the mirror-image bug.
    const beta = faceInfo(ttcPath, "SynthBeta");
    expect(beta.faceIndex).toBe(1);
    expect(beta.nameMatched).toBe(true);
    expect(Object.keys(beta.fileAxes ?? {})).toContain("wght");
    // ...and a static sibling must NOT inherit them.
    expect(faceInfo(ttcPath, "SynthGamma").fileAxes).toBeNull();
  });

  it("resolves a name that is an fvar NAMED INSTANCE to its member plus exact coordinates", () => {
    // The common real shape, and the one the old code answered `faceIndex: 0`
    // for: PingFangSC-Regular and PingFangHK-Regular are named instances of
    // members 20 and 22, and both reported 0 — which read as "SC and HK resolved
    // to the same face".
    const bold = faceInfo(ttcPath, "SynthBetaBold");
    expect(bold.faceIndex).toBe(1);           // the member that OWNS the instance
    expect(bold.nameMatched).toBe(true);
    expect(bold.instanceAxes).toEqual({ wght: 800 });

    const light = faceInfo(ttcPath, "SynthBetaLight");
    expect(light.faceIndex).toBe(1);
    expect(light.instanceAxes).toEqual({ wght: 200 });
  });

  it("distinguishes two named instances of one member", () => {
    // A shared member index is correct here; the axis coordinates are what make
    // the two faces different, so they must not be reported identically.
    expect(faceInfo(ttcPath, "SynthBetaBold").instanceAxes)
      .not.toEqual(faceInfo(ttcPath, "SynthBetaLight").instanceAxes);
  });

  it("reports no instance coordinates for a DIRECT member match", () => {
    // A member is itself, not an instance of something — pinning coordinates
    // here would freeze the face at one location.
    expect(faceInfo(ttcPath, "SynthBeta").instanceAxes ?? null).toBeNull();
    expect(faceInfo(ttcPath, "SynthAlpha").instanceAxes ?? null).toBeNull();
  });

  it("answers null — not member zero — when the name is absent from the collection", () => {
    // The defect this contract exists for: PingFangSC-Regular is not a physical
    // member of PingFangUI.ttc, and every PingFang key reported member zero's
    // index and axes, so SC and HK looked like the same face.
    expect(faceInfo(ttcPath, "SynthNotInHere")).toEqual({
      faceIndex: null, nameMatched: false, fileAxes: null,
    });
  });

  it("does not leak a variable member's axes to an unmatched name", () => {
    // Guards the specific shape of the original lie: `{wght: 400}` reported for
    // a face whose axes were never consulted.
    expect(faceInfo(ttcPath, "SynthNotInHere").fileAxes).toBeNull();
  });

  it("treats member zero as honest when no name was requested", () => {
    // Nothing was asked for, so nothing can mismatch — index 0 IS the request.
    expect(faceInfo(ttcPath)).toEqual({ faceIndex: 0, nameMatched: true, fileAxes: null, namedInstances: null, memberPostscriptName: "SynthAlpha" });
  });

  it("reports index 0 for a single-face file, flagging a name that does not match it", () => {
    expect(faceInfo(sfntPath, "SynthSolo")).toEqual({ faceIndex: 0, nameMatched: true, fileAxes: null, namedInstances: null, memberPostscriptName: "SynthSolo" });
    // A relocated/stub file can hold a different face than the table declared.
    // Index 0 is still truthful (it is the only face), but the name is not.
    expect(faceInfo(sfntPath, "SomethingElse")).toEqual({
      faceIndex: 0, nameMatched: false, fileAxes: null, namedInstances: null, memberPostscriptName: "SynthSolo",
    });
  });

  it("falls back to a single static face for an unreadable file", () => {
    const bogus = path.join(dir, "not-a-font.ttf");
    writeFileSync(bogus, Buffer.from("definitely not an sfnt"));
    expect(faceInfo(bogus, "Whatever")).toEqual({ faceIndex: 0, nameMatched: true, fileAxes: null });
  });
});

describe("the (path, name) cache keeps answers separate", () => {
  // The resolver memoizes per (path, postscriptName). A cache keyed on path
  // alone would let the first query's answer stand in for every later face in
  // the same container — which is how a single wrong index becomes many.
  it("does not let an absent-name miss poison a later matching name", () => {
    expect(faceInfo(ttcPath, "SynthNotInHere").faceIndex).toBeNull();
    expect(faceInfo(ttcPath, "SynthGamma").faceIndex).toBe(2);
    expect(faceInfo(ttcPath, "SynthNotInHere").faceIndex).toBeNull();
  });

  it("does not let a matching name mask a later absent name", () => {
    expect(faceInfo(ttcPath, "SynthBeta").faceIndex).toBe(1);
    const miss = faceInfo(ttcPath, "SynthNotInHere");
    expect(miss.faceIndex).toBeNull();
    expect(miss.fileAxes).toBeNull();
  });

  it("keeps every member distinct across an interleaved, repeated sequence", () => {
    const order = ["SynthGamma", "SynthAlpha", "SynthNope", "SynthBeta", "SynthAlpha", "SynthGamma", "SynthNope", "SynthBeta"];
    const expected: Record<string, number | null> = {
      SynthAlpha: 0, SynthBeta: 1, SynthGamma: 2, SynthNope: null,
    };
    for (const name of order) {
      expect(faceInfo(ttcPath, name).faceIndex, name).toBe(expected[name]);
    }
  });

  it("distinguishes a no-name query from a named one on the same file", () => {
    // Both legitimately answer index 0 here, but for different reasons — the
    // named one because SynthAlpha IS member zero. A cache collision between
    // them would make an absent-name query inherit "nameMatched: true".
    expect(faceInfo(ttcPath).nameMatched).toBe(true);
    expect(faceInfo(ttcPath, "SynthNope").nameMatched).toBe(false);
    expect(faceInfo(ttcPath).nameMatched).toBe(true);
  });

  it("re-resolves after the caches are cleared", () => {
    expect(faceInfo(ttcPath, "SynthBeta").faceIndex).toBe(1);
    clearFontResolutionCaches();
    expect(faceInfo(ttcPath, "SynthBeta").faceIndex).toBe(1);
    expect(faceInfo(ttcPath, "SynthNope").faceIndex).toBeNull();
  });
});
