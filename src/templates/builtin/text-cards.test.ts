import { describe, it, expect } from "vitest";
import {
  resolveCardTheme, staggeredReveal, revealEndMs, cardHeadCss, CARD_FONT_STACK,
  cardScaleFactor, fs, fsNum, fitOdometerCell,
} from "./text-card-common.js";
import { titleCardTemplate, buildTitleCardHtml, titleCardParamsSchema } from "./title-card.js";
import { quoteTemplate, buildQuoteHtml, quoteParamsSchema } from "./quote.js";
import { captionTemplate, buildCaptionHtml, buildCaptionAnimations, captionParamsSchema } from "./caption.js";
import { ctaTemplate, buildCtaHtml, buildCtaAnimations, ctaParamsSchema } from "./cta.js";
import { resolveFormat } from "../formats.js";
import type { Brand } from "../brand.js";

const BRAND: Brand = {
  palette: { primary: "#2f6df6", accent: "#22d3ee", background: "#0b1020", text: "#e6edf3", muted: "#8b93a7" },
  font: { family: "Inter, sans-serif" },
  background: "linear-gradient(135deg,#1e293b,#0f172a)",
};

// Parse helper: apply a template's zod defaults to a partial input.
const parse = <T>(schema: { parse: (v: unknown) => T }, v: unknown): T => schema.parse(v);

describe("text-card-common (DM-1531)", () => {
  it("resolveCardTheme: dark/light defaults + overrides win; muted tracks foreground", () => {
    const dark = resolveCardTheme("dark");
    expect(dark.background).toBe("#0b1020");
    expect(dark.text).toBe("#f5f7fa");
    const light = resolveCardTheme("light");
    expect(light.background).toBe("#f6f8fa");
    expect(light.text).toBe("#0d1117");
    const over = resolveCardTheme("dark", { background: "#123", text: "#fff" });
    expect(over.background).toBe("#123");
    expect(over.text).toBe("#fff");
  });

  it("staggeredReveal: fade-up rises + fuses opacity, with a per-item stagger delay", () => {
    const a = staggeredReveal([".a", ".b", ".c"], { stagger: 100, duration: 500, rise: 30 });
    expect(a).toHaveLength(3);
    expect(a[0]).toMatchObject({ selector: ".a", property: "translateY", from: "30px", to: "0px", delay: 0 });
    expect(a[1].delay).toBe(100);
    expect(a[2].delay).toBe(200);
    expect(a[0].fuse).toEqual([{ property: "opacity", from: "0", to: "1" }]);
  });

  it("staggeredReveal: pop uses a center-origin scale overshoot", () => {
    const a = staggeredReveal([".x"], { style: "pop" });
    expect(a[0]).toMatchObject({ property: "scale", from: "0.8", to: "1", transformOrigin: "center" });
    expect(a[0].fuse?.[0]).toMatchObject({ property: "opacity" });
  });

  it("staggeredReveal: empty list → no animations", () => {
    expect(staggeredReveal([])).toEqual([]);
  });

  it("fs/fsNum/cardScaleFactor: sf===1 (no format) leaves authored px untouched", () => {
    expect(cardScaleFactor(1280, 720, undefined)).toBe(1);
    expect(fs(84, 1)).toBe("84px");
    expect(fsNum(200, 1)).toBe(200);
  });

  it("fs/fsNum: scale an authored px by a factor, rounded to 0.01", () => {
    expect(fs(84, 1.5)).toBe("126px");
    expect(fsNum(200, 1.25)).toBe(250);
    expect(fs(33, 1.333)).toBe("43.99px"); // 33 * 1.333 = 43.989 → 43.99
  });

  it("fitOdometerCell (DM-1541): caps a scaled number-cell so it fits the content width", () => {
    // 9 columns ("1,284,000") at 0.64 advance → a 298px cell would be 1716px wide,
    // far over a ~820px reel content width → clamped down to fit.
    const capped = fitOdometerCell(298, 9, 820);
    expect(capped).toBeLessThan(298);
    expect(capped * 9 * 0.64).toBeLessThanOrEqual(820 + 0.01);
    // Already-fitting cell is returned unchanged; a 0 width disables the clamp.
    expect(fitOdometerCell(100, 3, 5000)).toBe(100);
    expect(fitOdometerCell(298, 9, 0)).toBe(298);
  });

  it("revealEndMs: last item's start + duration", () => {
    expect(revealEndMs(3, { stagger: 100, duration: 500 })).toBe(700); // 200 + 500
    expect(revealEndMs(0)).toBe(0);
  });

  it("cardHeadCss: default padding when no inset; per-side max of default and inset", () => {
    expect(cardHeadCss({ width: 100, height: 100, fontFamily: "x" }, 40, undefined)).toContain("padding: 40px 40px 40px 40px");
    const css = cardHeadCss({ width: 100, height: 100, fontFamily: "x" }, 40, { top: 200, right: 10, bottom: 300, left: 10 });
    expect(css).toContain("padding: 200px 40px 300px 40px"); // top/bottom inset wins, sides keep 40
  });
});

describe("title-card (DM-1531)", () => {
  it("includes only the provided text blocks", () => {
    const full = buildTitleCardHtml(parse(titleCardParamsSchema, { title: "T", subtitle: "S", eyebrow: "E" }));
    expect(full).toContain('class="tc-eyebrow">E');
    expect(full).toContain('class="tc-title">T');
    expect(full).toContain('class="tc-sub">S');
    const bare = buildTitleCardHtml(parse(titleCardParamsSchema, { title: "T" }));
    // the CSS rule (`.tc-eyebrow {}`) is always present; assert the MARKUP is absent.
    expect(bare).not.toContain('class="tc-eyebrow"');
    expect(bare).not.toContain('class="tc-sub"');
  });

  it("escapes user text", () => {
    const html = buildTitleCardHtml(parse(titleCardParamsSchema, { title: "<b>x</b>" }));
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
  });

  it("adaptive scale (DM-1541): default (no format) keeps the authored 84px headline byte-for-byte", () => {
    const html = buildTitleCardHtml(parse(titleCardParamsSchema, { title: "T" }));
    // sf === 1 with no safeInset → the literal authored size is unchanged.
    expect(html).toContain(".tc-title { font-size: 84px;");
  });

  it("adaptive scale (DM-1541): a 9:16 reel enlarges the headline for legibility", () => {
    const reel = resolveFormat("reel");
    const html = buildTitleCardHtml(
      parse(titleCardParamsSchema, { title: "T", width: reel.width, height: reel.height }),
      reel.safeInset,
    );
    const sf = cardScaleFactor(reel.width, reel.height, reel.safeInset);
    expect(sf).toBeGreaterThan(1.3);
    // The headline is scaled up by the factor (bigger relative type at 9:16).
    expect(html).toContain(`.tc-title { font-size: ${fs(84, sf)};`);
    expect(html).not.toContain(".tc-title { font-size: 84px;");
  });

  it("brandDefaults maps background/text/accent/font", () => {
    expect(titleCardTemplate.brandDefaults!(BRAND)).toEqual({
      background: "linear-gradient(135deg,#1e293b,#0f172a)",
      textColor: "#e6edf3",
      accent: "#22d3ee",
      fontFamily: "Inter, sans-serif",
    });
  });
});

describe("quote (DM-1531)", () => {
  it("renders the quote + attribution and derives the avatar initial from the author", () => {
    const html = buildQuoteHtml(parse(quoteParamsSchema, { quote: "Great", author: "ada lovelace", role: "Engineer" }));
    expect(html).toContain('class="q-text">Great');
    expect(html).toContain('class="q-name">ada lovelace');
    expect(html).toContain('class="q-role">Engineer');
    expect(html).toContain('class="q-avatar">A'); // first letter of author, uppercased
  });

  it("omits the attribution row when there's no author or role", () => {
    const html = buildQuoteHtml(parse(quoteParamsSchema, { quote: "Solo" }));
    expect(html).not.toContain('class="q-attr"');
  });

  it("brandDefaults maps primary→accent", () => {
    expect(quoteTemplate.brandDefaults!(BRAND)).toMatchObject({ accent: "#2f6df6", fontFamily: "Inter, sans-serif" });
  });
});

describe("caption (DM-1531)", () => {
  it("is transparent and wraps text in the in/out wrappers", () => {
    const html = buildCaptionHtml(parse(captionParamsSchema, { text: "Hi" }));
    expect(html).toContain("background: transparent");
    expect(html).toContain('class="cap-out"');
    expect(html).toContain('class="cap-in"');
    expect(html).toContain('class="cap-text">Hi');
  });

  it("fade motion: opacity in on .cap-in, opacity out on .cap-out near the end", () => {
    const p = parse(captionParamsSchema, { text: "Hi", motion: "fade", inMs: 400, outMs: 400, holdMs: 2000 });
    const a = buildCaptionAnimations(p);
    const cin = a.find((x) => x.selector === ".cap-in")!;
    const cout = a.find((x) => x.selector === ".cap-out")!;
    expect(cin).toMatchObject({ property: "opacity", from: "0", to: "1" });
    expect(cin.delay).toBeUndefined(); // enters immediately
    expect(cout).toMatchObject({ property: "opacity", from: "1", to: "0", delay: 1600 }); // holdMs - outMs
  });

  it("slide motion: translateY fused with opacity on both wrappers", () => {
    const p = parse(captionParamsSchema, { text: "Hi", motion: "slide", position: "bottom-center" });
    const a = buildCaptionAnimations(p);
    expect(a.find((x) => x.selector === ".cap-in")).toMatchObject({ property: "translateY", from: "24px", to: "0px" });
    expect(a.find((x) => x.selector === ".cap-out")).toMatchObject({ property: "translateY", from: "0px", to: "24px" });
  });

  it("brandDefaults maps only the font (color stays legibility-tuned)", () => {
    expect(captionTemplate.brandDefaults!(BRAND)).toEqual({ fontFamily: "Inter, sans-serif" });
  });
});

describe("cta (DM-1531)", () => {
  it("renders button + conditional headline/handles/url/logo", () => {
    const html = buildCtaHtml(parse(ctaParamsSchema, { cta: "Go", headline: "H", handles: "@a,@b", url: "x.dev", logo: "https://x/l.svg" }));
    expect(html).toContain('class="cta-btn">Go');
    expect(html).toContain('class="cta-headline">H');
    expect(html).toContain('class="cta-handles"');
    expect(html).toContain("<span>@a</span>");
    expect(html).toContain('class="cta-url">x.dev');
    expect(html).toContain('src="https://x/l.svg"');
    const bare = buildCtaHtml(parse(ctaParamsSchema, { cta: "Go" }));
    expect(bare).not.toContain('class="cta-headline"');
    expect(bare).not.toContain('class="cta-logo"');
    expect(bare).not.toContain('class="cta-handles"');
  });

  it("pulse adds an infinite alternate scale on the inner button; off omits it", () => {
    const p = parse(ctaParamsSchema, { cta: "Go", pulse: true });
    const withPulse = buildCtaAnimations(p, [".cta-btn-wrap"]);
    const pulse = withPulse.find((a) => a.selector === ".cta-btn");
    expect(pulse).toMatchObject({ property: "scale", repeat: "infinite", alternate: true });
    const off = buildCtaAnimations(parse(ctaParamsSchema, { cta: "Go", pulse: false }), [".cta-btn-wrap"]);
    expect(off.find((a) => a.selector === ".cta-btn")).toBeUndefined();
  });

  it("brandDefaults maps primary→ctaColor", () => {
    expect(ctaTemplate.brandDefaults!(BRAND)).toMatchObject({ ctaColor: "#2f6df6", fontFamily: "Inter, sans-serif" });
  });

  it("brandDefaults maps brand.logo→logo when set, and omits it otherwise (DM-1539)", () => {
    // With a logo token, it fills the end-card's logo slot.
    const withLogo = ctaTemplate.brandDefaults!({ ...BRAND, logo: "/opt/acme/logo.svg" });
    expect(withLogo).toMatchObject({ logo: "/opt/acme/logo.svg", ctaColor: "#2f6df6" });
    // BRAND has no logo → no `logo` key at all (must not shadow the param default with undefined).
    const noLogo = ctaTemplate.brandDefaults!(BRAND);
    expect("logo" in noLogo).toBe(false);
  });

  it("parses comma-separated handles into an array", () => {
    expect(parse(ctaParamsSchema, { cta: "Go", handles: "@a, @b , @c" }).handles).toEqual(["@a", "@b", "@c"]);
  });
});

describe("shared: every text card uses the shared font stack default", () => {
  it("default fontFamily is CARD_FONT_STACK", () => {
    expect(parse(titleCardParamsSchema, { title: "x" }).fontFamily).toBe(CARD_FONT_STACK);
    expect(parse(quoteParamsSchema, { quote: "x" }).fontFamily).toBe(CARD_FONT_STACK);
    expect(parse(captionParamsSchema, { text: "x" }).fontFamily).toBe(CARD_FONT_STACK);
    expect(parse(ctaParamsSchema, { cta: "x" }).fontFamily).toBe(CARD_FONT_STACK);
  });
});
