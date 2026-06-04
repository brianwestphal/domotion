// DM-1083 stage (d) gate: does the unified chain resolver cover MORE
// U+2F800–2FA1F (CJK Compatibility Ideographs Supplement) cells under a
// LATIN-ONLY stack than the shipped primary-only resolver? Any extra coverage is
// a candidate DM-1080 over-render — it must be validated against Chrome's actual
// paint (Chrome reaches the OS/CoreText system fallback; it does NOT reach our
// hand-rolled fallbackFontChain deep faces). Prints the divergent codepoints so a
// Playwright probe can check each against Chrome.
import { __resolveFontForCodepointForTest, setChainFontResolution } from "../dist/render/text-to-path.js";

const STACKS = {
  "Latin-only (Helvetica, Arial, sans-serif)": "Helvetica, Arial, sans-serif",
  "CJK fixture stack": `"Hiragino Sans","Arial Unicode MS","Apple Symbols","Apple Color Emoji","Noto Sans","Noto Serif",sans-serif`,
};

for (const [label, stack] of Object.entries(STACKS)) {
  const rows = [];
  for (let cp = 0x2f800; cp <= 0x2fa1f; cp++) {
    setChainFontResolution(false);
    const off = __resolveFontForCodepointForTest(cp, stack);
    setChainFontResolution(true);
    const on = __resolveFontForCodepointForTest(cp, stack);
    rows.push({ cp, off, on });
  }
  const offCov = rows.filter((r) => r.off?.covered).length;
  const onCov = rows.filter((r) => r.on?.covered).length;
  const newlyCovered = rows.filter((r) => !r.off?.covered && r.on?.covered);
  const newlyDecomp = rows.filter((r) => !(r.off?.decomposed) && r.on?.decomposed);
  console.log(`\n=== ${label} ===`);
  console.log(`covered: OFF ${offCov}  ON ${onCov}  (+${onCov - offCov})`);
  console.log(`newly-covered by chain: ${newlyCovered.length}`);
  console.log(`newly-decomposed by chain: ${newlyDecomp.length}`);
  for (const r of newlyCovered.slice(0, 30)) {
    console.log(`  U+${r.cp.toString(16).toUpperCase()}  ON key=${r.on.key} decomposed=${r.on.decomposed}`);
  }
  if (newlyCovered.length > 30) console.log(`  … +${newlyCovered.length - 30} more`);
}
