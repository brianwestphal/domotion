// Linux generic-family resolution through the transcribed nomination walk,
// replayed on any host via the recorded helper cassette (same rig as
// `linux-routing-crossplatform.test.ts`).
//
// The mechanism under test: Blink resolves a settings-mapped generic keyword
// by swapping in the browser-side settings value
// (`FontSelector::FamilyNameFromSettings`, `font_selector.cc:73-91`, rev
// 7d859f27). In the capture session those settings come from PLAYWRIGHT, which
// applies its vendored Linux table via CDP `Page.setFontFamilies` on every
// non-headful launch (`playwright-core/lib/server/chromium/crPage.js:436-437`
// + `defaultFontFamilies.js`, playwright-core 1.59.1) — cursive →
// "Comic Sans MS", fantasy → "Impact", serif → "Times New Roman", sans-serif
// → "Arial", monospace → "Monospace" — key-for-key equal to Chrome's own
// `chrome/app/resources/locale_settings_linux.grd` defaults (rev 7d859f27),
// the table's upstream provenance. `math` has no Playwright key, so the
// `blink::web_pref::WebPreferences` constructor default "Latin Modern Math"
// survives (`web_preferences.cc:41`, rev 7d859f27). The nominated name then
// runs through the SAME fontconfig family lookup as any declared
// name, INCLUDING the acceptance filter (`SkFontConfigInterfaceDirect::
// MatchFont`, Skia rev 62efacd3:553-590, the revision `external/chromium`
// DEPS:330 pins at rev 7d859f27): take the FIRST valid pattern of one
// `FcFontSort(trim=0)`, and unless the request is a bare fallback name
// (`IsFallbackFontAllowed`, 62efacd3:342-348 — empty / "sans" / "serif" /
// "monospace" only), accept it ONLY when its family list matches the
// post-substitution name, the requested name, or a metric-compatible
// equivalence class (`kFontEquivMap`, 62efacd3:214-313). Rejection makes the
// family UNAVAILABLE: the declared stack walks on and terminates at the
// standard family — never at "no font at all".
//
// The cassette entries for "Comic Sans MS" / "Impact" / "Times New Roman" /
// "Monospace" / "Latin Modern Math" were recorded from the real helper inside
// the pinned noble container (mcr.microsoft.com/playwright:v1.59.1-noble), so
// this file proves the Node-side LOGIC given those answers; the container
// conformance sweep remains the parity instrument.
//
// Every assertion below DISCRIMINATES against the pre-fix code (which
// excluded the generics from the walk and pinned them to static keys:
// cursive → "apple-chancery", fantasy → "papyrus", serif → "times",
// sans-serif → "helvetica", monospace → "courier"), except where noted.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { describe, expect, it, beforeAll, beforeEach } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const CASSETTE = resolve(HERE, "..", "..", "tests", "cassettes", "linux.json");
const REPLAYER = resolve(HERE, "..", "..", "tools", "font-env-cassette.mjs");

// Must be set BEFORE the glyph helper module is imported (its availability
// probe memoizes for the life of the process).
process.env.DOMOTION_HELPER_PATH = REPLAYER;
process.env.FONT_CASSETTE = CASSETTE;
process.env.FONT_CASSETTE_MODE = "replay";

type FontResolutionMod = typeof import("./font-resolution.js");
type HostPlatformMod = typeof import("./host-platform.js");
let fr: FontResolutionMod;
let host: HostPlatformMod;

beforeAll(async () => {
  fr = await import("./font-resolution.js");
  host = await import("./host-platform.js");
});

beforeEach(() => {
  // The family→key walk memoizes per document; a stale macOS-shaped answer
  // must not leak between the overridden and non-overridden assertions.
  fr.clearFontResolutionCaches();
});

describe("Linux settings-mapped generics run the transcribed nomination walk (grd defaults + acceptance filter)", () => {
  it("cursive: 'Comic Sans MS' is REJECTED, so the stack terminates at the standard family — not at the fontconfig substitute", () => {
    host.withHostPlatform("linux", () => {
      // Pre-fix: the static route pinned `cursive` → "apple-chancery".
      // Mechanism: nominate the grd default "Comic Sans MS"; fontconfig can
      // only offer WenQuanYi Zen Hei, the acceptance filter refuses it, the
      // family is unavailable, the (one-name) stack exhausts, and
      // `resolveFontKey` lands on the live standard-family face.
      expect(fr.resolveFontKey("cursive")).toBe("sysfb:LiberationSerif");
    });
  });

  it("fantasy: 'Impact' is REJECTED the same way", () => {
    host.withHostPlatform("linux", () => {
      // Pre-fix: "papyrus".
      expect(fr.resolveFontKey("fantasy")).toBe("sysfb:LiberationSerif");
    });
  });

  it("rejection means the stack CONTINUES — a later declared family still wins", () => {
    host.withHostPlatform("linux", () => {
      // The riskiest semantic: a rejected generic must read as "family
      // unavailable", never "no font". With cursive rejected, the next name
      // in the stack must be nominated and accepted.
      expect(fr.resolveFontKey('cursive, "Liberation Sans"')).toBe("sysfb:LiberationSans");
    });
  });

  it("serif: 'Times New Roman' is ACCEPTED via fontconfig's metric-alias substitution onto Liberation Serif", () => {
    host.withHostPlatform("linux", () => {
      // Pre-fix: the static "times" key. Mechanism: the settings value goes
      // through the walk and registers the matched face.
      expect(fr.resolveFontKey("serif")).toBe("sysfb:LiberationSerif");
    });
  });

  it("sans-serif: 'Arial' is ACCEPTED onto Liberation Sans", () => {
    host.withHostPlatform("linux", () => {
      // Pre-fix: "helvetica".
      expect(fr.resolveFontKey("sans-serif")).toBe("sysfb:LiberationSans");
    });
  });

  it("monospace: 'Monospace' is fallback-allowed, so fontconfig's first valid face is accepted (WenQuanYi Zen Hei Mono on the noble image)", () => {
    host.withHostPlatform("linux", () => {
      // Pre-fix: "courier". "Monospace" strcasecmp-matches
      // `IsFallbackFontAllowed`'s "monospace", so ANY first valid pattern is
      // a good answer — which on the noble image is WenQuanYi Zen Hei Mono,
      // the face Chrome's own paint reports for bare-monospace runs there.
      expect(fr.resolveFontKey("monospace")).toBe("sysfb:WenQuanYiZenHeiMono");
    });
  });

  it("math: 'Latin Modern Math' is not installed → rejected → standard-family terminal (same terminal as before, now via the mechanism)", () => {
    host.withHostPlatform("linux", () => {
      // Pinned so an installed Latin Modern Math later flips this to an
      // acceptance rather than silently changing routes.
      expect(fr.resolveFontKey("math")).toBe("sysfb:LiberationSerif");
    });
  });

  it("system-ui stays OFF the walk — its family comes from FontCache::SystemFontFamily(), not a grd setting", () => {
    host.withHostPlatform("linux", () => {
      // If system-ui were (wrongly) nominated through the walk, the cassette
      // has no familyMatch entry for it, the replayer would miss, the walk
      // would read that as a rejection, and the key would collapse to the
      // "times" terminal. Its real route is the raw fontconfig default
      // (`fcMatch("sans-serif")` → a host-dependent `sysfb:` key) or the
      // `sf-pro` static when fc-match is unavailable on the host.
      expect(fr.resolveFontKey("system-ui")).toMatch(/^(sysfb:.+|sf-pro)$/);
    });
  });

  it("answers revert to the macOS-calibrated statics outside the override — the platform seam is doing the work", () => {
    if (process.platform === "linux") return; // meaningful off-Linux only
    expect(fr.resolveFontKey("cursive")).toBe("apple-chancery");
    expect(fr.resolveFontKey("fantasy")).toBe("papyrus");
    expect(fr.resolveFontKey("serif")).toBe("times");
  });
});
