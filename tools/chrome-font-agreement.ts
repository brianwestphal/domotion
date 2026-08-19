/**
 * FONTAGREE — per-codepoint agreement between Chrome and our resolver.
 *
 * The only fidelity criterion that matters for font selection is that we paint
 * the face Chrome paints. Which fonts happen to be installed is not something
 * we get to assume: a machine with Apple's downloadable SF Pro / Noto families
 * resolves a stack completely differently from a stock macOS install, and both
 * are legitimate. So this asks the two questions side by side, on whatever
 * machine it runs on:
 *
 *   - Chrome: `CSS.getPlatformFontsForNode` over a span containing the
 *     codepoint — the face Chrome ACTUALLY used to paint it, not a guess.
 *   - Us: `resolveFontForCodepoint` against the same stack's key chain.
 *
 * Any row that disagrees is a real defect, and the disagreement is named rather
 * than inferred from pixels. (Two earlier attempts to identify a face from
 * rendered crops — a hand-rolled shape matcher and `tools/compare-glyphs.ts` on
 * upscaled 1x captures — both failed their controls. Asking the browser is
 * strictly better.)
 *
 * Motivation: a set of unicode fixtures pass on a developer Mac and fail on the
 * CI runner. Locally this reports 8/8 agreement on the failing codepoints, which
 * means the divergence only exists in the runner's font environment — so the
 * probe has to run THERE. It is wired into `visual-tests.yml` as a diagnostic
 * step (grep FONTAGREE in the job log) next to `font-env-probe`.
 *
 *   npx tsx tools/chrome-font-agreement.ts ['<css font stack>'] [cp,cp,...]
 *
 * Exit code is always 0 — this reports, it does not gate.
 */
import { chromium } from "@playwright/test";
import {
  resolveFontKeyChain,
  resolveFontForCodepoint,
  getFontInstance,
  resolveFontSpec,
  stackPrimaryIsSystemUi,
} from "../src/render/font-resolution.js";

const P = (s: string): void => console.log(`FONTAGREE: ${s}`);

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Does Chrome's reported family name denote the same face we resolved?
 *
 * Not string equality, and deliberately not just a substring test. Chrome
 * reports a DISPLAY name ("Noto Sans", "SF Pro Text"); we carry a key
 * ("sysfb:NotoSans-Regular") and a file ("NotoSans-Regular.ttf"). Worse, the
 * macOS system font is reported by Chrome as "SF Pro Text" / "SF Pro Display"
 * while it is painted from `SFNS.ttf`, whose own family name is "System Font" —
 * so neither the key, the filename, nor the font's internal name matches the
 * string Chrome hands back. That is expected behavior, not a defect: Chrome
 * paints the named family from the system optical cut. Treating it as a
 * mismatch would bury the real mismatches in false alarms.
 */
function sameFace(chrome: string, ourKey: string, ourFile: string): boolean {
  const c = norm(chrome);
  if (c.length < 3) return false;
  const mine = `${norm(ourKey)} ${norm(ourFile)}`;
  if (mine.includes(c)) return true;
  // The system-font aliases, the one case where the names genuinely can't line
  // up (see above). `sf-pro`/`sf-pro-italic` → SFNS.ttf / SFNSItalic.ttf.
  const systemFontNames = ["sfprotext", "sfprodisplay", "sfpro", "systemfont", "sfns"];
  if (systemFontNames.includes(c) && (norm(ourKey).startsWith("sfpro") || norm(ourFile).startsWith("sfns"))) {
    return true;
  }
  return false;
}

// Defaults mirror the html-test unicode fixtures' own stack and a spread of the
// codepoints whose blocks fail on CI (Cyrillic, phonetic extensions, currency,
// enclosed alphanumerics, Latin extended additional / B).
const STACK = process.argv[2]
  ?? `"SF Pro Text","Arial Unicode MS","Apple Symbols","Apple Color Emoji","Noto Sans","Noto Serif",sans-serif`;
const CPS = (process.argv[3] ?? "04FA,04FB,04FC,1D00,1D80,20A0,2460,1E00,0180,A720,FE00")
  .split(",")
  .map((h) => parseInt(h.trim(), 16))
  .filter((n) => Number.isFinite(n));

const FONT_PX = 32;

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 400 } });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");

  const spans = CPS
    .map((cp, i) =>
      `<span id="c${i}" style="font-family:${STACK.replace(/"/g, "'")};font-size:${FONT_PX}px">&#x${cp.toString(16)};</span>`)
    .join("");
  await page.setContent(`<!doctype html><body style="margin:0">${spans}</body>`);
  await page.evaluate(() => document.fonts.ready);

  const chain = resolveFontKeyChain(STACK);
  P(`stack = ${STACK}`);
  P(`chain = ${JSON.stringify(chain)}`);

  const primaryKey = chain[0];
  const primary = primaryKey != null ? getFontInstance(primaryKey, 400, FONT_PX) : null;
  if (primary == null) P(`WARNING: no primary instance for chain head ${String(primaryKey)}`);

  const { root } = await cdp.send("DOM.getDocument");
  let agree = 0;
  let compared = 0;

  for (let i = 0; i < CPS.length; i++) {
    const cp = CPS[i];
    const hex = `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: `#c${i}` });
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    // Chrome reports the faces it used, most-glyphs first; one span, one glyph.
    const chrome = fonts != null && fonts.length > 0 ? fonts[0].familyName : "(none)";

    let ours = "(unresolved)";
    let ourFile = "";
    if (primary != null && primaryKey != null) {
      const r = resolveFontForCodepoint(
        cp, primary, primaryKey, 400, FONT_PX, 0, undefined, undefined, chain,
        stackPrimaryIsSystemUi(STACK), 100, undefined, STACK,
      );
      if (r != null) {
        ours = r.key;
        const spec = resolveFontSpec(r.key);
        ourFile = spec?.path != null ? spec.path.split("/").pop() ?? "" : "";
      }
    }

    const painted = chrome !== "(none)";
    const ok = painted && sameFace(chrome, ours, ourFile);
    if (painted) {
      compared++;
      if (ok) agree++;
    }
    const verdict = !painted ? "n/a (not painted)" : ok ? "AGREE" : "MISMATCH";
    P(`${hex}  chrome="${chrome}"  ours="${ours}"${ourFile !== "" ? ` @ ${ourFile}` : ""}  ${verdict}`);
  }

  P(`${agree}/${compared} agree (${CPS.length - compared} not painted by Chrome)`);
} finally {
  await browser.close();
}
