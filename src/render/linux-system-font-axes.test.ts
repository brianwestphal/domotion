// Linux system fonts take NO variation coordinates — the fontconfig-matched
// face is the face.
//
// Blink's Linux system-font path (`FontCache::CreateFontPlatformData` on
// !IS_WIN, `skia/font_cache_skia.cc:299-358`, rev 7d859f27) constructs the
// FontPlatformData straight from the typeface `matchFamilyStyle` returned. No
// `makeClone` runs anywhere on that path — the only clone sites in
// platform/fonts are the webfont path (`font_custom_platform_data.cc:233`)
// and mac (`font_platform_data_mac.mm:199`) — so neither the CSS weight, nor
// opsz-from-font-size, nor wdth, nor slnt, nor author font-variation-settings
// ever reaches a Linux system typeface. The shaping side only READS the
// typeface's existing design position (`harfbuzz_face.cc:571-584`). For a
// variable file, the face is the fvar named instance fontconfig's FC_INDEX
// tells FreeType to load, at that instance's own coordinates.
//
// Measured in the noble container (Lexend VF, wght [100..900], 100px
// 'Hamburgefonstiv'): CSS 450 paints the Regular instance (847.000px),
// byte-identical to CSS 400 — NOT the wght=450 interpolation (853.969px) the
// CSS pin previously produced — and every weight lands on a named instance
// (Thin 776.313 … Black 915.406), never between two.
//
// Linux-gated: the branch under test dispatches on process.platform, so these
// run in the container (`npm run test:linux-docker`) and CI's Linux job, and
// skip elsewhere. The variable font is written from the committed
// variable-axis fixture (OpenSans VF, wght [300, 800], wdth [75, 100]) so the
// test does not depend on the host's font inventory.
import { describe, expect, it, beforeAll } from "vitest";
import { existsSync, readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFontInstance, __registerDynamicSystemFontForTest } from "./font-resolution.js";

const fixture = "tests/fixtures/variable-axis/variable-axis.html";
const buf = (() => {
  if (!existsSync(fixture)) return null;
  const m = /url\(data:font\/[a-z0-9-]+;base64,([A-Za-z0-9+/=]+)\)/.exec(readFileSync(fixture, "utf8"));
  return m != null ? Buffer.from(m[1], "base64") : null;
})();

const describeLinux = process.platform === "linux" && buf != null ? describe : describe.skip;

type InstanceView = {
  _appliedVariationAxes?: Record<string, number>;
  hasWeightAxis?: boolean;
} | null;

describeLinux("Linux system-font axis rule (no CSS-derived variation coordinates)", () => {
  let key: string;

  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), "dm-vf-"));
    const path = join(dir, "TestVF.ttf");
    writeFileSync(path, buf!);
    key = "sysfb:DomotionTestVF";
    __registerDynamicSystemFontForTest(key, path, "OpenSans-Regular");
  });

  it("does not pin wght to the CSS weight — CSS 450 shapes the matched face, not an interpolation", () => {
    const inst = getFontInstance(key, 450, 24, 0) as InstanceView;
    expect(inst).not.toBeNull();
    // The resolved PostScript name IS the file's base face, so the honest
    // instance is the default master: no variation applied at all.
    expect(inst?._appliedVariationAxes).toBeUndefined();
  });

  it("does not pin opsz from the font size, wdth from stretch, or author font-variation-settings", () => {
    const at12 = getFontInstance(key, 400, 12, 0, { wght: 650 }, 75) as InstanceView;
    expect(at12).not.toBeNull();
    // Blink applies no coordinates on this path — a 12px condensed run with
    // author fvs still shapes the matched face as-is.
    expect(at12?._appliedVariationAxes).toBeUndefined();
  });

  it("reports hasWeightAxis false so the synthetic-bold delta consults the matched face", () => {
    const inst = getFontInstance(key, 700, 24, 0) as InstanceView;
    expect(inst?.hasWeightAxis).toBe(false);
  });
});
