// A platform-table entry with no `postscriptName` does not mean "the file's
// face" — it means "whatever opening the file by path gives you", and those are
// different requests in two ways that both reached paint:
//
//  - On a COLLECTION it selects member 0, which need not be the regular cut.
//    `NotoSansMyanmar.ttc` has 18 members and member 0 is Black, so every
//    Myanmar run painted at weight 900 whatever the CSS asked for. Chrome
//    answers `NotoSansMyanmar-Regular` at weight 400.
//  - On a single-face VARIABLE file CoreText reports different metrics than the
//    face HarfBuzz indexes — measured 3870 units by path against 4122 by name
//    on SF Arabic, with identical glyph ids throughout.
//
// The collection case is the one worth a standing guard, because it is silent:
// the wrong cut renders perfectly well, just heavier, and nothing downstream can
// notice (`postscriptName` and `naturalWeight` both come back undefined).
import { describe, expect, it } from "vitest";
import { existsSync, openSync, readSync, closeSync } from "node:fs";
import { getFontInstance, platformFontKeys, resolveFontSpec } from "./font-resolution.js";

const onDarwin = process.platform === "darwin";
const describeMac = onDarwin ? describe : describe.skip;

/** Is this file an sfnt COLLECTION, and how many members? Reads the 12-byte
 *  header rather than opening the font — this runs over the whole table. */
function collectionMemberCount(path: string): number {
  let fd = -1;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(12);
    if (readSync(fd, buf, 0, 12, 0) < 12) return 0;
    if (buf.readUInt32BE(0) !== 0x74746366 /* 'ttcf' */) return 0;
    return buf.readUInt32BE(8);
  } catch {
    return 0;
  } finally {
    if (fd >= 0) { try { closeSync(fd); } catch { /* already gone */ } }
  }
}

describeMac("platform table: collections must name the face they mean", () => {
  it("no key resolves to a multi-member collection without a PostScript name", () => {
    // The invariant, swept over the whole table rather than over the entries
    // someone remembered to check. Member order in a `.ttc` is the vendor's
    // business — alphabetical in Noto's case, which puts Black first — so
    // "member 0" is never a face a routing table can have meant.
    const offenders: string[] = [];
    for (const key of platformFontKeys()) {
      const spec = resolveFontSpec(key);
      if (spec?.path == null || spec.path === "" || !existsSync(spec.path)) continue;
      if (spec.postscriptName != null && spec.postscriptName !== "") continue;
      const members = collectionMemberCount(spec.path);
      if (members > 1) offenders.push(`${key} → ${spec.path.split("/").pop()} (${members} members)`);
    }
    expect(offenders).toEqual([]);
  });

  it("Myanmar resolves to Regular, not the container's first member", () => {
    // The specific defect, pinned by the number rather than the name: Chrome
    // answers `NotoSansMyanmar-Regular` at weight 400 (asked over CDP), whose
    // U+1000 advance is 1124. Black — member 0, and what we used to render —
    // measures 1121. Asserting the advance as well as the name is what makes
    // this fail if the name is right but the face somehow is not.
    const spec = resolveFontSpec("u-noto-sans-myanmar");
    if (spec?.path == null || !existsSync(spec.path)) return; // font absent on this host
    expect(spec.postscriptName).toBe("NotoSansMyanmar-Regular");
    const inst = getFontInstance("u-noto-sans-myanmar", 400, 16, 0);
    expect(inst).not.toBeNull();
    expect(inst!.glyphForCodePoint(0x1000).advanceWidth).toBe(1124);
  });
});
