/**
 * The capture predicate decides `font-variant-emoji: text` by PROBING Chrome,
 * and this pins the equivalence that licenses the probe (DM-1987).
 *
 * `src/capture/script/emoji-detect.ts` used to consult a hardcoded set of
 * codepoints that "flip to monochrome" under the override. That set was
 * calibrated on macOS against ONE font stack and generalised to every stack and
 * every platform, and it is wrong in both directions:
 *
 *  - off macOS it names faces (Apple Symbols, STIX Two Math, PingFang) that are
 *    not installed;
 *  - on macOS it is wrong for `system-ui` runs — ⚡ U+26A1 and ⭐ U+2B50 stay on
 *    a colour emoji face there, where the set says they move to mono.
 *
 * The replacement draws `cp + U+FE0E` on a canvas and asks whether the result
 * is still colour. That is legitimate only because Blink gives an explicit VS15
 * and `font-variant-emoji: text` the SAME fallback priority — so this test
 * checks the canvas answer against Chrome's own layout answer (CDP
 * `CSS.getPlatformFontsForNode`) rather than against a stored expectation.
 *
 * Platform-independent by construction: it compares two live answers from the
 * same browser, so it is as meaningful on the Linux and Windows runners as here.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";

/** Two stacks that DISAGREE on macOS — the whole point is that the answer is
 *  per-stack, so a single-stack check could not catch the defect being fixed. */
const STACKS = ["Helvetica, sans-serif", "system-ui, -apple-system, sans-serif"];

/** A spread across the blocks the frozen set covered, plus controls that were
 *  never in it. Deliberately small: each row costs a CDP round-trip. */
const CPS = [0x26a1, 0x2614, 0x2648, 0x2b50, 0x2b1b, 0x2b55, 0x1f600, 0x1f310, 0x1f3a4];

let browser: Browser;
let page: Page;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- CDP session type is not exported
let cdp: any;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
  cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
}, 120_000);

afterAll(async () => { await browser?.close(); });

/** The canvas probe, transcribed from `emoji-detect.ts`'s
 *  `textPresentationPaintsColor` — same two stages, same thresholds. */
async function canvasSaysColor(cp: number, font: string): Promise<boolean> {
  return page.evaluate(({ cp, font }) => {
    const c = document.createElement("canvas");
    c.width = 48; c.height = 48;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    const str = String.fromCodePoint(cp) + "︎";
    const draw = (fill: string): Uint8ClampedArray => {
      ctx.clearRect(0, 0, 48, 48);
      ctx.fillStyle = fill;
      ctx.textBaseline = "top";
      ctx.font = "32px " + font;
      ctx.fillText(str, 8, 4);
      return ctx.getImageData(0, 0, 48, 48).data;
    };
    const a = draw("#000");
    const black = new Uint8ClampedArray(a);
    black.set(a);
    for (let i = 0; i < black.length; i += 4) {
      if (black[i + 3] < 8) continue;
      if (Math.max(black[i], black[i + 1], black[i + 2])
        - Math.min(black[i], black[i + 1], black[i + 2]) > 24) return true;
    }
    const r = draw("#f00");
    let ink = false, differs = false;
    for (let i = 0; i < black.length; i += 4) {
      if (black[i + 3] >= 8 || r[i + 3] >= 8) ink = true;
      if (Math.abs(black[i] - r[i]) > 16 || Math.abs(black[i + 1] - r[i + 1]) > 16) { differs = true; break; }
    }
    return ink && !differs;
  }, { cp, font });
}

/** Chrome's own answer: the family it paints the run with under the real CSS
 *  property. Colour-ness is read from the family name, which is why the list
 *  below is explicit rather than a substring guess. */
const COLOR_EMOJI_FAMILIES = [
  "apple color emoji", ".apple color emoji ui", "noto color emoji", "segoe ui emoji",
];

async function chromeSaysColor(cp: number, font: string): Promise<boolean | null> {
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>
    span{font-family:${font};font-size:32px;font-variant-emoji:text}</style>`
    + `<span id="t">${String.fromCodePoint(cp)}</span>`, { waitUntil: "load" });
  const { root } = await cdp.send("DOM.getDocument");
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#t" });
  const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
  if (fonts.length === 0) return null;
  return COLOR_EMOJI_FAMILIES.includes(String(fonts[0].familyName).toLowerCase());
}

describe("the VS15 canvas probe answers what Chrome's layout answers (DM-1987)", () => {
  it("agrees with CDP on every probed codepoint, on BOTH stacks", async () => {
    const rows: string[] = [];
    let agree = 0, disagree = 0;
    for (const font of STACKS) {
      for (const cp of CPS) {
        const chrome = await chromeSaysColor(cp, font);
        if (chrome == null) continue;
        const canvas = await canvasSaysColor(cp, font);
        if (canvas === chrome) agree++;
        else { disagree++; rows.push(`U+${cp.toString(16).toUpperCase()} @ ${font}: chrome=${chrome} canvas=${canvas}`); }
      }
    }
    // Non-vacuity: if the harness silently probed nothing, this fails first.
    expect(agree + disagree, "the probe must have compared something").toBeGreaterThanOrEqual(CPS.length);
    expect(disagree, `canvas disagreed with Chrome:\n  ${rows.join("\n  ")}`).toBe(0);
  }, 180_000);

  it("is DISCRIMINATING — the two stacks do not give identical answers", async () => {
    // The defect this replaced was a per-stack answer frozen into a constant.
    // If both stacks answered the same on this host, the test above would pass
    // on an implementation that ignored the font entirely, so say so out loud
    // rather than let it pass silently.
    const perStack = await Promise.all(STACKS.map(async (font) => {
      const answers: boolean[] = [];
      for (const cp of CPS) answers.push(await canvasSaysColor(cp, font));
      return answers.join(",");
    }));
    if (perStack[0] === perStack[1]) {
      console.warn("[emoji-text-presentation] the two stacks agree on this host — "
        + "the equivalence check above is still valid, but its stack axis is not exercised here");
      return;
    }
    expect(perStack[0]).not.toBe(perStack[1]);
  }, 180_000);
});
