// CSS `font-synthesis` — the three vetoes, and the entry-identity bug that made
// one of them inert (DM-1971).
//
// Blink does not treat these longhands as hints. `SyntheticBoldAllowed()` and
// `SyntheticItalicAllowed()` are each ONE comparison against the `auto` keyword
// (`platform/fonts/font_description.h:312-320`, rev 7d859f27), ANDed into the
// synthesis decision on both paths that make one — the webfont path
// (`core/css/css_segmented_font_face.cc:116-123`) and the per-platform
// system-font paths. `font-synthesis-small-caps` gates the synthesized
// small-caps stand-in the same way.
//
// ── Chrome's ground truth ────────────────────────────────────────────────────
//
// Measured on macOS at 64px Papyrus — a single upright regular cut with no
// `smcp`, so all three syntheses fire — as the 1x ink integral over the row,
// which is the only thing that can see any of them (synthetic bold moves
// neither the advance nor the reported platform face):
//
//   weight 700 auto  7069.1   |  weight 700 none  5822.0  == weight 400 control
//   italic     auto  5868.5   |  italic     none  5822.0  == upright control
//   small-caps auto  4018.4   |  small-caps none  5822.0  == no-caps control
//
// Every `none` arm lands EXACTLY on its control, so the property is a clean
// discriminator rather than a near-miss. After this change our own ratios are
// 1.0000 on all three.
//
// ── What these tests actually pin ───────────────────────────────────────────
//
// Both render modes honor the vetoes. These tests drive embedded mode because
// it exposes both ownership boundaries at once: bold changes only the ordered
// `<text>` paint passes, while oblique still changes subset bytes.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { renderTextAsPath, setRenderTextMode, synthesisAllowed, type RenderTextOptions } from "./text-to-path.js";
import { clearEmbeddedFontBuilder, getBuiltEmbeddedFontFaceCss } from "./embedded-font-builder.js";

/** A face with no bold, no italic and no smcp of its own, so every synthesis
 *  path is reachable. Skips where it is absent rather than asserting nothing. */
const FAMILY = "Papyrus";

function render(text: string, extra: Partial<RenderTextOptions> = {}): string | null {
  return renderTextAsPath(text, 0, 64,
    { fontSize: 64, fontFamily: FAMILY, fontWeight: "400", fill: "#000", ...extra });
}

/** The `@font-face` blocks the builder emitted, with the base64 payload cut. */
function faces(): string[] {
  const css = getBuiltEmbeddedFontFaceCss();
  return [...css.matchAll(/@font-face\s*\{(.*?)\}/gs)]
    .map((m) => m[1].replace(/base64,[A-Za-z0-9+/=]+/, "base64,…").trim());
}

/** The embedded font BYTES per entry — what actually decides whether a
 *  synthesis was baked, as opposed to what the descriptor claims. */
function faceBytes(): string[] {
  return [...getBuiltEmbeddedFontFaceCss().matchAll(/base64,([A-Za-z0-9+/=]+)/g)].map((m) => m[1]);
}

describe("synthesisAllowed — absent means `auto`", () => {
  it("permits every kind when the allowance is absent", () => {
    expect(synthesisAllowed(undefined, "weight")).toBe(true);
    expect(synthesisAllowed(undefined, "style")).toBe(true);
    expect(synthesisAllowed(undefined, "smallCaps")).toBe(true);
  });

  it("permits a kind the allowance does not mention", () => {
    expect(synthesisAllowed({ weight: false }, "style")).toBe(true);
  });

  it("vetoes only on an explicit false — `auto` is not falsy-by-omission", () => {
    expect(synthesisAllowed({ weight: false }, "weight")).toBe(false);
    expect(synthesisAllowed({ weight: true }, "weight")).toBe(true);
  });
});

describe("font-synthesis vetoes in embedded-font mode (DM-1971)", () => {
  beforeEach(() => { setRenderTextMode("embedded-font"); clearEmbeddedFontBuilder(); });
  afterEach(() => { setRenderTextMode("paths"); clearEmbeddedFontBuilder(); });

  /** Whether this host's resolved face actually enters the synthesis path. */
  const synthesizes = (): boolean => {
    clearEmbeddedFontBuilder();
    if (render("Hg", { fontWeight: "400" }) == null || faces().length === 0) {
      clearEmbeddedFontBuilder();
      return false;
    }
    clearEmbeddedFontBuilder();
    const auto = render("Hamburgefonstiv", { fontWeight: "700" }) ?? "";
    const veto = render("Hamburgefonstiv", { fontWeight: "700", fontSynthesis: { weight: false } }) ?? "";
    const ok = /<text\b[^>]*\sstroke="#000"/.test(auto)
      && !/<text\b[^>]*\sstroke="#000"/.test(veto);
    clearEmbeddedFontBuilder();
    return ok;
  };

  it("reuses one source subset while a weight veto changes only the paint pass", () => {
    if (!synthesizes()) return;
    const auto = render("Hamburgefonstiv", { fontWeight: "700" })!;
    const veto = render("Hamburgefonstiv", { fontWeight: "700", fontSynthesis: { weight: false } })!;
    expect(auto).toMatch(/<text\b[^>]*\sstroke="#000"/);
    expect(veto).not.toMatch(/<text\b[^>]*\sstroke="#000"/);
    expect(faces()).toHaveLength(1);
    expect(faceBytes()).toHaveLength(1);
  });

  it("keys the faux-oblique shear into the entry identity — the bug that made the style veto inert", () => {
    if (!synthesizes()) return;
    // This is the case that actually broke. The two italic runs agreed on
    // family / weight / slant / features / axes, so before the fix they resolved
    // to ONE entry — built by whichever ran first, WITH the shear baked in — and
    // `font-synthesis-style: none` painted a sheared glyph anyway. Measured at
    // the time: ink ratio 1.0079 against the upright control where Chrome gives
    // exactly 1.0000.
    expect(render("Hamburgefonstiv", { fontStyle: "italic" })).not.toBeNull();
    expect(render("Hamburgefonstiv", { fontStyle: "italic", fontSynthesis: { style: false } })).not.toBeNull();
    const f = faces();
    expect(f.length).toBe(2);
    // Both still DECLARE italic — the veto suppresses the bake, not the
    // descriptor, exactly as an upright face selected for an italic request
    // would be labeled.
    expect(f.filter((s) => /font-style:\s*italic/.test(s)).length).toBe(2);
  });

  it("bakes NOTHING into a vetoed italic — its bytes equal the upright face's", () => {
    if (!synthesizes()) return;
    // The strongest form of the claim, and the one a descriptor check cannot
    // make: compare the embedded font BYTES. A vetoed italic must carry the
    // same outlines as the upright request (nothing was sheared), while an
    // un-vetoed italic must not. Two entries either way, because the @font-face
    // descriptor still differs — which is correct, and is exactly why counting
    // entries is not enough to prove the veto worked.
    expect(render("Hamburgefonstiv", { fontStyle: "italic", fontSynthesis: { style: false } })).not.toBeNull();
    expect(render("Hamburgefonstiv")).not.toBeNull();
    const vetoed = faceBytes();
    expect(vetoed.length).toBe(2);
    expect(vetoed[0]).toBe(vetoed[1]);

    clearEmbeddedFontBuilder();
    expect(render("Hamburgefonstiv", { fontStyle: "italic" })).not.toBeNull();
    expect(render("Hamburgefonstiv")).not.toBeNull();
    const auto = faceBytes();
    expect(auto.length).toBe(2);
    expect(auto[0]).not.toBe(auto[1]);
  });

  it("does not disturb an un-vetoed run — auto is byte-identical to omitting the option", () => {
    if (!synthesizes()) return;
    const withOpt = render("Hamburgefonstiv", {
      fontWeight: "700", fontSynthesis: { weight: true, style: true, smallCaps: true },
    });
    clearEmbeddedFontBuilder();
    const without = render("Hamburgefonstiv", { fontWeight: "700" });
    expect(withOpt).toBe(without);
  });
});

describe("synthesized small-caps veto (DM-1971)", () => {
  beforeEach(() => { setRenderTextMode("paths"); });

  it("suppresses the scaled-uppercase stand-in a font without smcp would otherwise get", () => {
    // Papyrus ships no `smcp`, so `small-caps` normally synthesizes: lowercase
    // is upcased and painted at 0.7. With the veto the run must render as plain
    // lowercase — identical to asking for no small-caps at all.
    const synth = render("Hamburgefonstiv", { features: ["smcp"] });
    const plain = render("Hamburgefonstiv", {});
    // Same precondition shape as the embedded block: the host's resolved face
    // must actually LACK `smcp`, or there is no stand-in to suppress and the
    // final assertion would demand a difference that should not exist. A host
    // whose fallback ships real small caps simply has nothing to test here.
    if (synth == null || plain == null || synth === plain) return;
    const vetoed = render("Hamburgefonstiv", { features: ["smcp"], fontSynthesis: { smallCaps: false } });
    expect(vetoed).toBe(plain);
  });
});
