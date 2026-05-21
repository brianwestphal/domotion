/**
 * Feature test definitions.
 *
 * Each test is a minimal HTML snippet that exercises one rendering feature.
 * The test runner compares HTML→PNG with SVG→PNG for each.
 *
 * Usage: npx tsx tests/features.ts [--only feature-name]
 */

import { runFeatureTests, type FeatureTest } from "./runner.js";

const tests: FeatureTest[] = [
  // ── Text ──
  {
    name: "text-basic",
    html: `<div style="padding: 20px; color: #e6edf3; font-family: -apple-system, sans-serif; font-size: 16px;">Hello World</div>`,
  },
  {
    name: "text-bold",
    html: `<div style="padding: 20px; color: #e6edf3; font-family: -apple-system, sans-serif;"><span style="font-weight: 700; font-size: 24px;">Bold Heading</span><br/><span style="font-weight: 400; font-size: 14px; color: #8b949e;">Regular body text below</span></div>`,
  },
  {
    name: "text-center",
    html: `<div style="width: 400px; text-align: center; padding: 40px 20px; color: #e6edf3; font-family: -apple-system, sans-serif;"><div style="font-size: 28px; font-weight: 800;">Centered Title</div><div style="font-size: 14px; color: #8b949e; margin-top: 8px;">Centered subtitle text</div></div>`,
  },
  {
    name: "text-right",
    html: `<div style="width: 400px; text-align: right; padding: 20px; color: #e6edf3; font-family: -apple-system, sans-serif;"><div style="font-size: 16px;">Right-aligned text</div><div style="font-size: 12px; color: #8b949e;">Smaller right-aligned</div></div>`,
  },
  {
    name: "text-mono",
    html: `<div style="padding: 20px; font-family: 'SF Mono', Menlo, Monaco, monospace; font-size: 13px; color: #e6edf3;">sk install @community/error-handling</div>`,
  },
  {
    name: "text-multiline",
    html: `<div style="padding: 20px; color: #e6edf3; font-family: -apple-system, sans-serif; font-size: 14px; line-height: 1.6; width: 300px;"><div>First line of text</div><div>Second line of text</div><div style="color: #8b949e;">Third line dimmed</div></div>`,
  },
  {
    name: "text-small",
    html: `<div style="padding: 20px;"><div style="font-size: 11px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.05em; font-family: -apple-system, sans-serif;">LABEL TEXT</div><div style="font-size: 12px; color: #6e7681; font-family: -apple-system, sans-serif; margin-top: 4px;">Score: 42/100 · 1,234 downloads</div></div>`,
  },

  // ── Backgrounds & Colors ──
  {
    name: "bg-solid",
    html: `<div style="padding: 20px;"><div style="background: #161b22; padding: 16px; color: #e6edf3; font-family: -apple-system, sans-serif; font-size: 14px;">Dark surface background</div><div style="background: #238636; padding: 8px 16px; color: white; font-family: -apple-system, sans-serif; font-size: 14px; margin-top: 8px; display: inline-block;">Green button</div></div>`,
  },
  {
    name: "bg-transparent",
    html: `<div style="padding: 20px;"><div style="background: rgba(35,134,54,0.15); padding: 8px 12px; color: #3fb950; font-family: -apple-system, sans-serif; font-size: 12px; display: inline-block;">Semi-transparent green</div><div style="background: rgba(248,81,73,0.15); padding: 8px 12px; color: #f85149; font-family: -apple-system, sans-serif; font-size: 12px; display: inline-block; margin-left: 8px;">Semi-transparent red</div></div>`,
  },
  {
    name: "bg-nested",
    html: `<div style="padding: 20px; background: #161b22; width: 300px;"><div style="background: #0d1117; padding: 12px; margin: 8px; color: #e6edf3; font-family: -apple-system, sans-serif; font-size: 14px;">Nested darker box</div></div>`,
  },
  {
    // DM-547 / doc 28: smooth conic color wheel — 4-stop sweep covering the
    // full circle. Pre-rasterized via the DM-549 pre-pass; uses relaxedDiffPct
    // because Chromium's native conic compositor and our sharp lanczos pre-pass
    // disagree by sub-pixel AA at the rect boundary and along angular stops.
    name: "bg-conic-smooth",
    html: `<div style="padding: 20px;"><div style="width: 200px; height: 200px; background: conic-gradient(red, yellow, green, blue, red);"></div></div>`,
    relaxedDiffPct: 0.5,
  },
  {
    // Regression guard: repeating-linear-gradient with px-positioned stops.
    // The earlier emitter treated px positions as raw fractions, so the SVG
    // `<stop offset="8">` clamped to 1 and the stripe pattern collapsed to a
    // single solid color. Fixed by normalizing px positions to fractions of
    // the gradient line length and scaling the SVG gradient vector to span
    // exactly one tile period (`spreadMethod="repeat"` then tiles outward).
    name: "bg-repeating-linear-px-stops",
    html: `<div style="padding: 20px;"><div style="width: 160px; height: 160px; background: repeating-linear-gradient(45deg, #fef3c7 0 8px, #fde68a 8px 16px); border: 1px solid #b45309;"></div></div>`,
    relaxedDiffPct: 0.5,
  },
  {
    // DM-547 / doc 28 / canonical use case from 19-deep-color-mix:
    // hard-stop alpha checkerboard tile.
    name: "bg-conic-checkerboard",
    html: `<div style="padding: 20px;"><div style="width: 240px; height: 240px; background: repeating-conic-gradient(#ddd 0 25%, white 0 50%) 0/24px 24px;"></div></div>`,
    relaxedDiffPct: 0.5,
  },
  {
    // DM-547: from <angle> + at <position> — pie-meter-like sweep with off-center origin.
    name: "bg-conic-from-at",
    html: `<div style="padding: 20px;"><div style="width: 200px; height: 200px; background: conic-gradient(from 90deg at 30% 70%, #4f46e5 0% 25%, #ec4899 25% 75%, #4f46e5 75% 100%);"></div></div>`,
    relaxedDiffPct: 0.5,
  },
  {
    // DM-547: multi-layer composition. Conic on top, linear-gradient under,
    // solid color base. SVG paint-order should stack them top-to-bottom.
    name: "bg-conic-multilayer",
    html: `<div style="padding: 20px;"><div style="width: 220px; height: 220px; background: repeating-conic-gradient(rgba(255,255,255,0.15) 0 25%, transparent 0 50%) 0/40px 40px, linear-gradient(135deg, #4f46e5, #ec4899);"></div></div>`,
    relaxedDiffPct: 0.5,
  },

  // ── Borders ──
  {
    name: "border-solid",
    html: `<div style="padding: 20px;"><div style="border: 1px solid #30363d; padding: 12px; color: #e6edf3; font-family: -apple-system, sans-serif; font-size: 14px; width: 250px;">Box with border</div></div>`,
  },
  {
    name: "border-radius",
    html: `<div style="padding: 20px;"><div style="background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 12px; color: #e6edf3; font-family: -apple-system, sans-serif; font-size: 14px; width: 250px;">Rounded card</div></div>`,
  },
  {
    name: "border-radius-pill",
    html: `<div style="padding: 20px; display: flex; gap: 8px;"><div style="background: #161b22; border: 1px solid #30363d; border-radius: 20px; padding: 6px 14px; color: #8b949e; font-family: -apple-system, sans-serif; font-size: 12px; display: inline-block;">tag-one</div><div style="background: #161b22; border: 1px solid #30363d; border-radius: 20px; padding: 6px 14px; color: #8b949e; font-family: -apple-system, sans-serif; font-size: 12px; display: inline-block;">tag-two</div></div>`,
  },

  // ── Layout ──
  {
    name: "layout-flex-row",
    html: `<div style="padding: 20px; display: flex; gap: 12px; align-items: center;"><div style="background: #238636; padding: 8px 16px; border-radius: 6px; color: white; font-family: -apple-system, sans-serif; font-size: 14px;">Button A</div><div style="background: #161b22; border: 1px solid #30363d; padding: 8px 16px; border-radius: 6px; color: #e6edf3; font-family: -apple-system, sans-serif; font-size: 14px;">Button B</div></div>`,
  },
  {
    name: "layout-flex-col",
    html: `<div style="padding: 20px; display: flex; flex-direction: column; gap: 8px; width: 250px;"><div style="background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 12px; color: #e6edf3; font-family: -apple-system, sans-serif; font-size: 14px;">Item one</div><div style="background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 12px; color: #e6edf3; font-family: -apple-system, sans-serif; font-size: 14px;">Item two</div></div>`,
  },
  {
    name: "layout-flex-center",
    html: `<div style="width: 400px; height: 200px; display: flex; justify-content: center; align-items: center;"><div style="background: #238636; padding: 12px 24px; border-radius: 6px; color: white; font-family: -apple-system, sans-serif; font-size: 16px; font-weight: 600;">Centered Button</div></div>`,
  },
  {
    name: "layout-padding",
    html: `<div style="background: #161b22; padding: 24px; width: 300px; border: 1px solid #30363d; border-radius: 6px;"><div style="color: #e6edf3; font-family: -apple-system, sans-serif; font-size: 14px; font-weight: 600; margin-bottom: 4px;">Card Title</div><div style="color: #8b949e; font-family: -apple-system, sans-serif; font-size: 13px;">Card description with padding</div></div>`,
    width: 340,
    height: 120,
  },

  // ── Components ──
  {
    name: "comp-button",
    html: `<div style="padding: 20px; display: flex; gap: 8px;"><div style="background: #238636; border: 1px solid #238636; border-radius: 6px; padding: 8px 16px; color: white; font-family: -apple-system, sans-serif; font-size: 14px; font-weight: 500;">Primary</div><div style="background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 8px 16px; color: #e6edf3; font-family: -apple-system, sans-serif; font-size: 14px; font-weight: 500;">Secondary</div><div style="background: transparent; border: 1px solid #f85149; border-radius: 6px; padding: 8px 16px; color: #f85149; font-family: -apple-system, sans-serif; font-size: 14px; font-weight: 500;">Danger</div></div>`,
  },
  {
    name: "comp-badge",
    html: `<div style="padding: 20px; display: flex; gap: 8px;"><span style="background: rgba(35,134,54,0.15); color: #3fb950; border: 1px solid rgba(35,134,54,0.3); padding: 2px 8px; border-radius: 12px; font-size: 12px; font-weight: 600; font-family: -apple-system, sans-serif;">Published</span><span style="background: rgba(31,111,235,0.15); color: #58a6ff; border: 1px solid rgba(31,111,235,0.3); padding: 2px 8px; border-radius: 12px; font-size: 12px; font-weight: 600; font-family: -apple-system, sans-serif;">v1.2.0</span><span style="background: rgba(210,153,34,0.15); color: #d29922; border: 1px solid rgba(210,153,34,0.3); padding: 2px 8px; border-radius: 12px; font-size: 12px; font-weight: 600; font-family: -apple-system, sans-serif;">Stack</span></div>`,
  },
  {
    name: "comp-card",
    html: `<div style="padding: 20px;"><div style="background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 16px; width: 350px;"><div style="font-weight: 600; color: #58a6ff; font-size: 14px; font-family: -apple-system, sans-serif; margin-bottom: 4px;">@community/error-handling</div><div style="font-size: 13px; color: #8b949e; font-family: -apple-system, sans-serif; margin-bottom: 8px;">Structured error handling patterns</div><div style="font-size: 12px; color: #6e7681; font-family: -apple-system, sans-serif;">42/100 · 1,234 downloads · 92% positive</div></div></div>`,
    width: 400,
    height: 140,
  },
  {
    name: "comp-card-badge",
    html: `<div style="padding: 20px;"><div style="background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 16px; width: 380px;"><div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;"><span style="font-weight: 600; color: #58a6ff; font-size: 14px; font-family: -apple-system, sans-serif;">@community/typescript-strict</span><span style="background: rgba(31,111,235,0.15); color: #58a6ff; border: 1px solid rgba(31,111,235,0.3); display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 12px; font-weight: 600; font-family: -apple-system, sans-serif;">universal</span></div><div style="font-size: 13px; color: #8b949e; font-family: -apple-system, sans-serif;">TypeScript strict mode conventions and type safety rules</div><div style="font-size: 12px; color: #6e7681; font-family: -apple-system, sans-serif; margin-top: 8px;">Score: 42/100 · 1,234 downloads · 92% positive</div></div></div>`,
    width: 420,
    height: 150,
  },
  {
    name: "comp-code-block",
    html: `<div style="padding: 20px;"><div style="background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 12px 16px; font-family: 'SF Mono', Menlo, Monaco, monospace; font-size: 13px; color: #e6edf3; width: 350px;">sk install @community/error-handling</div></div>`,
  },
  {
    name: "comp-input",
    html: `<div style="padding: 20px;"><div style="font-size: 11px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.05em; font-family: -apple-system, sans-serif; margin-bottom: 4px;">NAME</div><div style="display: flex; align-items: center; gap: 4px;"><span style="color: #e6edf3; font-size: 14px; font-weight: 500; font-family: -apple-system, sans-serif;">@devuser/</span><div style="background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 8px 12px; color: #e6edf3; font-size: 14px; font-family: -apple-system, sans-serif; width: 200px;">error-handling</div></div></div>`,
  },
  // ── Regression: mixed content, inputs, multiline ──
  {
    name: "text-inline-mixed",
    html: `<div style="padding: 20px;"><p style="font-size: 14px; color: #8b949e; font-family: -apple-system, sans-serif;">Inline code: <code style="font-family: 'SF Mono', Menlo, monospace; font-size: 13px; background: #161b22; padding: 2px 6px; border-radius: 4px;">slicekit.json</code> and <code style="font-family: 'SF Mono', Menlo, monospace; font-size: 13px; background: #161b22; padding: 2px 6px; border-radius: 4px;">CLAUDE.md</code></p></div>`,
    width: 400,
    height: 80,
  },
  {
    name: "comp-input-value",
    html: `<div style="padding: 20px;"><div style="font-size: 11px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.05em; font-family: -apple-system, sans-serif; margin-bottom: 4px;">NAME</div><input style="background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 8px 12px; color: #e6edf3; font-size: 14px; font-family: -apple-system, sans-serif; width: 250px;" value="error-handling" /></div>`,
    width: 300,
    height: 100,
  },
  // DM-581: button-typed inputs (and buttons styled as flex with align-items:
  // center) center their value text vertically within the rect — not anchored
  // at content-box top like a plain text input. The framer-mobile-fold "Okay"
  // button surfaced this. Three variants: UA-default `<input type=button>`,
  // padded button-input, and a flex/centered button-input mirroring the framer
  // shape. Chrome paints all three with vertically-centered baselines.
  {
    name: "comp-input-button",
    html: `<div style="padding: 20px; display: flex; gap: 12px; align-items: flex-start; font-family: -apple-system, sans-serif;">
      <input type="button" value="Okay" style="font-size: 14px;" />
      <input type="button" value="Submit" style="font-size: 14px; padding: 12px 16px; background: #2563eb; color: white; border: 0; border-radius: 6px;" />
      <input type="button" value="Okay" style="display: flex; align-items: center; justify-content: center; width: 58px; height: 45px; font-size: 14px; background: white; border: 1px solid #d4d4d8; border-radius: 8px; color: #18181b;" />
    </div>`,
    width: 320,
    height: 80,
  },
  {
    name: "text-pre-multiline",
    html: `<div style="padding: 20px;"><pre style="background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 12px 16px; font-family: 'SF Mono', Menlo, Monaco, monospace; font-size: 13px; color: #e6edf3; width: 350px; margin: 0; white-space: pre;">## Error Handling

- Always use typed errors
- Use Result&lt;T, E&gt; pattern</pre></div>`,
    width: 400,
    height: 160,
  },
  // SK-1236: text-decoration placement uses font.underlinePosition / OS/2
  // strikeout metrics. SF Pro and SF Mono have noticeably different underline
  // positions (SF Mono sits ~0.75px higher at 14px), so the fixture mixes
  // both families plus a large heading and dashed/dotted styles to exercise
  // every code path.
  {
    name: "text-decorations",
    html: `<div style="padding: 20px; color: #e6edf3; font-family: -apple-system, sans-serif; font-size: 14px; line-height: 1.7;">
      <div><span style="text-decoration: underline">underlined</span> · <span style="text-decoration: line-through">struck</span> · <span style="text-decoration: overline">over</span></div>
      <div style="font-family: 'SF Mono', Menlo, monospace; font-size: 13px;"><span style="text-decoration: underline">mono underline</span></div>
      <div style="font-size: 22px;"><span style="text-decoration: underline">Large underline</span></div>
    </div>`,
    width: 420,
    height: 160,
  },
  // SK-1255: mixed-script line exercises the multi-font xOffsets path.
  // Fallback runs (Arabic, Devanagari, CJK) must shape as units so contextual
  // joining, cluster reordering, and ligatures survive — per-char shaping
  // would render Arabic letters as detached isolated forms, हिन्दी without
  // its क्ष-style ligatures, and split CJK ligatures.
  {
    name: "text-mixed-script",
    html: `<div style="padding: 20px; color: #e6edf3; font-family: -apple-system, sans-serif; font-size: 18px; line-height: 1.6;">
      <div>Hello مرحبا 你好 नमस्ते</div>
      <div>greet السلام and こんにちは and हिन्दी</div>
    </div>`,
    width: 460,
    height: 120,
  },

  // ── Regression: modern CSS color formats (SK-434) ──
  // Each swatch uses a different color notation. All must parse to the
  // same-looking rgb() via the capture-side canvas normalizer. If any drop
  // back to the fallback fill, the swatch shows a bright off-color or no fill.
  {
    name: "color-modern-formats",
    html: `<div style="padding: 12px; display: flex; gap: 4px;">
      <div style="background: hsl(200, 80%, 40%); width: 40px; height: 40px;"></div>
      <div style="background: hwb(200 20% 30%); width: 40px; height: 40px;"></div>
      <div style="background: oklch(60% 0.2 30); width: 40px; height: 40px;"></div>
      <div style="background: oklab(60% 0.1 -0.1); width: 40px; height: 40px;"></div>
      <div style="background: lab(60% 40 -20); width: 40px; height: 40px;"></div>
      <div style="background: lch(60% 50 180); width: 40px; height: 40px;"></div>
      <div style="background: color(srgb 0.2 0.5 0.8); width: 40px; height: 40px;"></div>
      <div style="background: color-mix(in srgb, #dc2626 50%, #0ea5e9); width: 40px; height: 40px;"></div>
      <div style="background: #0ea5e9c0; width: 40px; height: 40px;"></div>
    </div>`,
    width: 420,
    height: 70,
  },


  // ── Regression: z-index paint order for positioned siblings (SK-439) ──
  // Red (z:1) should paint behind blue (z:3) regardless of DOM order. Before
  // the fix the SVG painted in DOM order so red covered blue.
  {
    name: "z-index-order",
    html: `<div style="position: relative; width: 240px; height: 120px; background: #0d1117;">
      <div style="position: absolute; top: 10px; left: 10px; width: 100px; height: 80px; background: #dc2626; z-index: 1;"></div>
      <div style="position: absolute; top: 30px; left: 60px; width: 100px; height: 80px; background: #58a6ff; z-index: 3;"></div>
      <div style="position: absolute; top: 50px; left: 110px; width: 100px; height: 60px; background: #3fb950; z-index: 2;"></div>
    </div>`,
    width: 260,
    height: 140,
  },

  // ── DM-473: cross-stacking-context z-index ──
  // A positioned descendant whose nearest positioned ancestor has z-index:auto
  // does NOT join that ancestor's "fake" stacking context — it joins the
  // nearest REAL stacking-context ancestor (here, the root). So blue
  // (z-index:1) inside red (z-index:auto) must paint ABOVE green (z-index:auto)
  // even though red comes before green in DOM order, because blue's effective
  // stack key (1) > green's (auto/0).
  {
    name: "z-index-cross-parent-non-context",
    html: `<div style="position:relative;width:240px;height:160px;background:#0d1117;">
      <div style="position:absolute;left:10px;top:10px;width:120px;height:120px;background:#dc2626;">
        <div style="position:absolute;left:30px;top:30px;width:140px;height:90px;background:#58a6ff;z-index:1;"></div>
      </div>
      <div style="position:absolute;left:80px;top:50px;width:140px;height:80px;background:#3fb950;"></div>
    </div>`,
    width: 260,
    height: 180,
  },

  // ── DM-473: stacking-context boundary blocks escape ──
  // Red establishes a real stacking context (positioned + z-index:1). Blue
  // (z-index:5) inside red is trapped at red's z-level. Green (z-index:2)
  // in the root context paints ABOVE red and therefore above blue, even
  // though blue's nominal z-index is higher. Without context-aware sorting
  // we'd hoist blue above green, which is the opposite of correct.
  {
    name: "z-index-stacking-context-boundary",
    html: `<div style="position:relative;width:240px;height:160px;background:#0d1117;">
      <div style="position:absolute;left:10px;top:10px;width:120px;height:120px;background:#dc2626;z-index:1;">
        <div style="position:absolute;left:30px;top:30px;width:140px;height:90px;background:#58a6ff;z-index:5;"></div>
      </div>
      <div style="position:absolute;left:80px;top:50px;width:140px;height:80px;background:#3fb950;z-index:2;"></div>
    </div>`,
    width: 260,
    height: 180,
  },

  // ── DM-473: negative z-index escapes non-stacking-context parent ──
  // A z-index:-1 child of a positioned-but-z-auto parent paints BEHIND the
  // nearest stacking context's other content — it bubbles up. Here the gray
  // in-flow block paints first, blue (z:-1) escapes red and paints between
  // the gray block and red itself, so blue covers gray but red still sits
  // on top of blue.
  {
    name: "z-index-negative-escapes",
    html: `<div style="position:relative;width:240px;height:160px;background:#0d1117;">
      <div style="position:absolute;left:10px;top:10px;width:220px;height:50px;background:#94a3b8;"></div>
      <div style="position:absolute;left:60px;top:40px;width:120px;height:80px;background:#dc2626;">
        <div style="position:absolute;left:-30px;top:-20px;width:200px;height:120px;background:#58a6ff;z-index:-1;"></div>
      </div>
    </div>`,
    width: 260,
    height: 180,
  },

  // ── DM-473: transform creates a stacking context ──
  // `transform` ≠ none creates a stacking context even without z-index. So
  // blue (z-index:5) inside a transformed parent is trapped at the parent's
  // z-level (auto). Green (z-index:1) in the root context paints above the
  // transformed parent and therefore above blue. Uses `translate(0)` so the
  // transform has no visible position effect — only its SC-creating role
  // matters for this fixture.
  {
    name: "z-index-transform-stacking-context",
    html: `<div style="position:relative;width:240px;height:160px;background:#0d1117;">
      <div style="position:absolute;left:10px;top:10px;width:120px;height:120px;background:#dc2626;transform:translate(0);">
        <div style="position:absolute;left:30px;top:30px;width:140px;height:90px;background:#58a6ff;z-index:5;"></div>
      </div>
      <div style="position:absolute;left:80px;top:50px;width:140px;height:80px;background:#3fb950;z-index:1;"></div>
    </div>`,
    width: 260,
    height: 180,
  },

  // DM-587: Verifies that nested descendants of a scale-transformed parent
  // composite correctly. Mirrors the Stripe Payment Element pattern: outer
  // wrapper with `transform: scale(0.69)`, flex column of child rows, with
  // some rows carrying their own `transform: translateY(...)`. If the
  // renderer's <g transform> composition is right, the child rows should
  // appear at the same positions Chrome paints them; if descendants' rects
  // are treated as viewport-post-transform, rows will overlap.
  {
    name: "transform-scale-flex-descendants",
    html: `<div style="width:300px;height:400px;background:#0d1117;padding:20px;">
      <div style="width:200px;height:300px;background:#161b22;transform:scale(0.69);transform-origin:0 0;display:flex;flex-direction:column;gap:10px;padding:10px;">
        <div style="height:40px;background:#dc2626;"></div>
        <div style="height:40px;background:#3fb950;transform:translateY(-5px);"></div>
        <div style="height:40px;background:#58a6ff;"></div>
        <div style="height:40px;background:#d29922;transform:translateY(10px);"></div>
        <div style="height:40px;background:#a371f7;"></div>
      </div>
    </div>`,
    width: 320,
    height: 420,
    relaxedDiffPct: 0.05,
  },

  // DM-589: per CSS Transforms 2 §4, `transform-style` != `flat` creates a
  // stacking context. The outer card has `transform-style: preserve-3d`
  // (commonly applied to keep child cards in a 3D flip / parallax layout) and
  // a white background. A nested `position:relative; z-index:-1` child paints
  // at step 2 of the card's local SC — ABOVE the card's bg but below the
  // card's content. Without the preserve-3d SC, the z=-1 would hoist up to
  // the section-container SC and end up BEHIND the white card bg (hidden).
  // Real-world example: stripe.com's speaker-card uses preserve-3d to flip
  // the speaker photo on top of the card; our renderer missed the SC trigger
  // and rendered the photo behind the white bg.
  {
    name: "z-index-transform-style-preserve-3d-sc",
    html: `<div style="position:relative;width:300px;height:300px;background:#222;z-index:1;">
      <div>
        <div style="position:absolute;left:50px;top:50px;width:200px;height:200px;background:white;transform-style:preserve-3d;">
          <div style="position:relative;z-index:-1;width:120px;height:120px;left:40px;top:40px;background:#58a6ff;"></div>
        </div>
      </div>
    </div>`,
    width: 320,
    height: 320,
  },

  // DM-589: negative-z-index descendant of a non-SC parent inside a real SC
  // ancestor. The blue square has `position:relative; z-index:-1`, sitting
  // inside a `position:absolute; z-index:auto; background:white` card. Per
  // CSS 2.1 Appendix E, z-index:-1 paints at the parent stacking-context's
  // step 2 (negative z descendants), BELOW the SC's other content. The
  // closest SC ancestor here is the outer dark `position:relative; z-index:1`
  // box. Chrome paints: dark bg → blue at z=-1 → white card (z=auto) on top.
  // So in Chrome, blue is HIDDEN by the white card. The diff a viewer sees
  // is just the white card.
  //
  // This fixture pins the spec-compliant behavior in case anyone tries to
  // "make z=-1 always visible" by skipping the hoist or sort. It is also a
  // counter-example to a wrong hypothesis on Stripe DM-589: a negative-z
  // image whose card sibling has white bg ought to be hidden — Chrome's
  // expected showing the image must be due to a DIFFERENT mechanism than
  // a missing hoist (likely a transparency or clip on the card).
  {
    name: "z-index-negative-under-card-bg",
    html: `<div style="position:relative;width:300px;height:300px;background:#222;z-index:1;">
      <div>
        <div style="position:absolute;left:50px;top:50px;width:200px;height:200px;background:white;">
          <div style="position:relative;z-index:-1;width:120px;height:120px;left:40px;top:40px;background:#58a6ff;"></div>
        </div>
      </div>
    </div>`,
    width: 320,
    height: 320,
  },

  // DM-588: per CSS 2.1 Appendix E §6, positioned siblings with z-index:0 and
  // z-index:auto paint at the SAME stack level in tree order — z-index:0
  // does NOT paint above z-index:auto. The previous bucketing sorted z=0
  // into the "positive" group and painted it last, which caused stripe's
  // billing-plan-graphic background gradients (z-index:0 SC) to render ON
  // TOP of the sibling white card (z-index:auto) instead of underneath it.
  //
  // Fixture: red box (z-index:0) appears first in DOM; blue box (z-index:auto)
  // appears second. Both have position:absolute with the same coordinates.
  // Chrome paints blue on top (later in tree order); a correct renderer must
  // match. If z-index:0 is treated as "positive", red ends up on top.
  {
    name: "z-index-zero-equals-auto",
    html: `<div style="position:relative;width:200px;height:200px;background:#0d1117;">
      <div style="position:absolute;left:10px;top:10px;width:100px;height:100px;background:#dc2626;z-index:0;"></div>
      <div style="position:absolute;left:50px;top:50px;width:100px;height:100px;background:#58a6ff;"></div>
    </div>`,
    width: 220,
    height: 220,
  },

  // ── Regression: CSS gradients translated to SVG linear/radial gradients (SK-432) ──
  {
    name: "gradient-linear",
    html: `<div style="padding: 12px; display: flex; gap: 8px;">
      <div style="width: 80px; height: 80px; background: linear-gradient(#dc2626, #58a6ff);"></div>
      <div style="width: 80px; height: 80px; background: linear-gradient(to right, #dc2626, #58a6ff);"></div>
      <div style="width: 80px; height: 80px; background: linear-gradient(90deg, red 0%, yellow 50%, green 100%);"></div>
    </div>`,
    width: 300,
    height: 110,
  },
  {
    name: "gradient-radial",
    html: `<div style="padding: 12px; display: flex; gap: 8px;">
      <div style="width: 80px; height: 80px; background: radial-gradient(#dc2626, #58a6ff);"></div>
      <div style="width: 80px; height: 80px; background: radial-gradient(circle at center, red, yellow, green);"></div>
    </div>`,
    width: 220,
    height: 110,
  },

  // ── Regression: CSS clip-path translated to SVG <clipPath> (SK-436) ──
  // circle, inset, and polygon clip shapes on solid-colored boxes. Previously
  // clip-path was ignored; now shape is translated to absolute SVG coords.
  {
    name: "clip-path-shapes",
    html: `<div style="padding: 12px; display: flex; gap: 8px;">
      <div style="width: 60px; height: 60px; background: #dc2626; clip-path: circle(28px at 50% 50%);"></div>
      <div style="width: 60px; height: 60px; background: #3fb950; clip-path: inset(10px 5px 10px 5px);"></div>
      <div style="width: 60px; height: 60px; background: #58a6ff; clip-path: polygon(50% 0, 100% 100%, 0 100%);"></div>
    </div>`,
    width: 240,
    height: 90,
  },

  // ── Regression: CSS filter + mix-blend-mode pass through to SVG (SK-433) ──
  // Three colored boxes with filters applied. The browser's SVG renderer honors
  // CSS 'filter' and 'mix-blend-mode' in <img src=svg>, so we pass the value
  // through verbatim on a wrapping <g style=...>.
  {
    name: "filter-passthrough",
    html: `<div style="padding: 14px; display: flex; gap: 8px; background: #0d1117;">
      <div style="width: 60px; height: 60px; background: #dc2626; filter: blur(2px);"></div>
      <div style="width: 60px; height: 60px; background: #3fb950; filter: grayscale(1);"></div>
      <div style="width: 60px; height: 60px; background: #58a6ff; filter: brightness(0.5) contrast(1.5);"></div>
    </div>`,
    width: 260,
    height: 90,
  },
  // Blend mode passthrough: top-right quadrant of a colored box uses
  // mix-blend-mode: multiply against an underlying colored band.
  {
    name: "blend-mode-passthrough",
    html: `<div style="padding: 14px; background: #fef3c7;">
      <div style="position: relative; width: 180px; height: 80px; background: #dc2626;">
        <div style="position: absolute; inset: 10px; background: #58a6ff; mix-blend-mode: multiply;"></div>
      </div>
    </div>`,
    width: 240,
    height: 120,
  },

  // ── Regression: overflow:hidden clips children (SK-440) ──
  // The inner span is wider than the parent. With overflow:hidden the visible
  // portion should stop at the parent's padding edge. Before the fix, the
  // overflowing text continued past the parent's right edge in the SVG.
  {
    name: "overflow-hidden-clips",
    html: `<div style="padding: 20px;"><div style="width: 160px; height: 40px; background: #161b22; border: 1px solid #30363d; overflow: hidden; color: #e6edf3; font-family: -apple-system, sans-serif; font-size: 13px; white-space: nowrap; padding: 8px;"><span>This is a very long unbreakable string that should be clipped</span></div></div>`,
    width: 220,
    height: 80,
  },

  // ── Regression: native form control chrome (SK-467) ──
  // Checkbox/radio with checked + unchecked states, progress, meter.
  // Chrome's UA-default rendering is synthesized by form-controls.ts.
  {
    name: "form-controls",
    html: `<div style="padding: 16px; background: #fff; display: flex; gap: 12px; align-items: center;">
      <input type="checkbox" />
      <input type="checkbox" checked />
      <input type="radio" />
      <input type="radio" checked />
      <progress value="60" max="100" style="width: 80px; height: 8px;"></progress>
      <meter value="40" max="100" style="width: 80px; height: 8px;"></meter>
    </div>`,
    width: 360,
    height: 70,
  },

  // ── Regression: border-image 9-slice with url() source (SK-466) ──
  // Inline data-URI so the capture sees an image that loads synchronously.
  // 32x32 SVG with a red ring frame so the 9-slice corners/edges/center are visible.
  {
    name: "border-image-stretch",
    html: `<div style="padding: 20px; background: #0d1117;">
      <div style="width: 150px; height: 90px; background: #161b22; border: 16px solid transparent;
        border-image-source: url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22 width=%2232%22 height=%2232%22><rect x=%220%22 y=%220%22 width=%2232%22 height=%2232%22 fill=%22%23dc2626%22/><rect x=%228%22 y=%228%22 width=%2216%22 height=%2216%22 fill=%22%23161b22%22/></svg>');
        border-image-slice: 8; border-image-repeat: stretch;"></div>
    </div>`,
    width: 220,
    height: 160,
  },

  // ── Regression: 3D border styles - double/groove/ridge/inset/outset (SK-470) ──
  // Smoke test — double is the closest to Chromium (no shading heuristic).
  // The shaded styles (groove/ridge/inset/outset) land within ~3-4% of
  // Chromium because the exact L-delta Chromium uses isn't documented; they're
  // covered indirectly by the 18-border-styles html-test (now passes at <3%).
  {
    name: "border-style-double",
    html: `<div style="padding: 14px; display: flex; gap: 8px; background: #94a3b8;">
      <div style="width: 80px; height: 60px; border: 12px double #334155; background: #f1f5f9;"></div>
    </div>`,
    width: 140,
    height: 110,
  },

  // ── Regression: border styles + per-side borders (SK-437) ──
  // dashed/dotted uniform borders, plus a per-side box with 4 different widths
  // and colors. Before the fix these all collapsed to a single solid <rect>.
  {
    name: "border-styles-variants",
    html: `<div style="padding: 14px; display: flex; gap: 8px; background: #0d1117;">
      <div style="width: 80px; height: 50px; border: 3px dashed #58a6ff;"></div>
      <div style="width: 80px; height: 50px; border: 3px dotted #3fb950;"></div>
      <div style="width: 80px; height: 50px; border-top: 4px solid #f85149; border-right: 2px dashed #d29922; border-bottom: 6px dotted #8b949e; border-left: 8px solid #58a6ff;"></div>
    </div>`,
    width: 320,
    height: 90,
  },

  // ── Regression: element opacity applies to children (SK-434) ──
  // opacity: 0.5 on the parent should tint both its bg AND its text/child badge.
  // Before the fix, only the bg rect got the opacity attribute and text/children
  // stayed fully opaque, producing a visible mismatch.
  {
    name: "color-opacity-children",
    html: `<div style="padding: 20px; background: #30363d;"><div style="opacity: 0.5; background: #dc2626; padding: 10px; color: white; font-family: -apple-system, sans-serif;">Parent 50% opacity<span style="background: #fbbf24; color: #111; padding: 2px 6px; margin-left: 6px;">child badge</span></div></div>`,
    width: 360,
    height: 100,
  },

  // ── DM-457: replaced-element static snapshots ──
  // <canvas> / <video> / <iframe> / <object> / <embed> are captured as a
  // per-element page.screenshot under a hide-everything-else stylesheet, then
  // emitted as <image> at the element's content-box rect. See docs/17.
  {
    name: "replaced-canvas-shape",
    html: `<div style="padding:20px;"><canvas id="c1" width="200" height="100" style="display:block;background:#222;"></canvas></div><script>(function(){var c=document.getElementById('c1').getContext('2d');c.fillStyle='#fff';c.fillRect(40,20,120,60);c.fillStyle='#3fb950';c.beginPath();c.arc(100,50,15,0,Math.PI*2);c.fill();})();</script>`,
    width: 240,
    height: 140,
  },
  {
    name: "replaced-video-poster",
    html: `<div style="padding:20px;"><video poster="data:image/svg+xml;utf8,${encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 120'><rect width='200' height='120' fill='%23222'/><polygon points='80,40 80,80 120,60' fill='white'/></svg>")}" width="200" height="120" style="display:block;background:#000;"></video></div>`,
    width: 240,
    height: 160,
  },
  {
    name: "replaced-canvas-overlay",
    html: `<div style="padding:20px;"><div style="position:relative;width:200px;height:100px;"><canvas id="c3" width="200" height="100" style="display:block;background:#444;position:absolute;left:0;top:0;z-index:1;"></canvas><div style="position:absolute;left:60px;top:30px;width:80px;height:40px;background:rgba(220,38,38,0.7);z-index:10;"></div></div></div><script>(function(){var c=document.getElementById('c3').getContext('2d');c.fillStyle='#fff';c.fillRect(0,0,200,100);c.fillStyle='#000';c.fillRect(20,20,30,30);c.fillRect(150,50,30,30);})();</script>`,
    width: 240,
    height: 140,
  },
  {
    // Sibling div above canvas via a fixed-position ancestor — exercises the
    // hide-everything-else stylesheet's ability to suppress out-of-tree
    // overlays during the snapshot. Pseudo-element overlays (::before/::after
    // with content:"") are also suppressed by the same CSS visibility
    // inheritance but the renderer doesn't synthesize their backgrounds onto
    // the SVG, so a fixture that exercises them comparably is deferred — the
    // snapshot isolation itself is the same property as this test.
    name: "replaced-canvas-fixed-overlay",
    html: `<div style="padding:20px;position:relative;"><canvas id="c4" width="200" height="100" style="display:block;background:#888;"></canvas><div style="position:absolute;left:70px;top:50px;width:100px;height:40px;background:#22c55e;"></div></div><script>(function(){var c=document.getElementById('c4').getContext('2d');c.fillStyle='#1f6feb';c.fillRect(0,0,200,100);})();</script>`,
    width: 240,
    height: 140,
  },
  {
    // DM-462: background-clip:text + transparent text-fill-color → the
    // bg-image fills the glyph shapes (gradient headline pattern). Renderer
    // suppresses the bg rect for the text-clipped layer and routes the
    // gradient as fill on the text glyph group.
    name: "text-bg-clip-gradient",
    html: `<div style="padding:24px;background:#0d1117;font-family:-apple-system,sans-serif;"><h1 style="font-size:36px;font-weight:800;margin:0;background:linear-gradient(90deg,#22d3ee 0%,#a855f7 50%,#f97316 100%);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent;">Gradient Headline</h1></div>`,
    width: 360,
    height: 110,
  },
  {
    name: "replaced-iframe-same-origin",
    html: `<div style="padding:20px;"><iframe srcdoc="<html><body style='margin:0;background:#225;color:#fff;font-family:sans-serif;'><div style='padding:14px;font-size:18px;'>Hello iframe</div></body></html>" width="240" height="100" style="display:block;border:0;"></iframe></div>`,
    width: 280,
    height: 140,
  },
  {
    // DM-498: positioned button overlay must paint ABOVE preceding-sibling
    // artwork in the same stacking context. Mirrors apple.com's hero where a
    // <picture> (transform; position:absolute) appears before the button
    // overlay in DOM order, and the buttons should paint on top of the
    // artwork via positioned-on-top stacking. Domotion was emitting the
    // image AFTER the buttons in the SVG, causing it to overpaint them.
    name: "stacking-button-overlay-above-artwork",
    html: `<div style="position:relative;width:300px;height:160px;overflow:hidden;background:#0d1117;"><div style="position:absolute;inset:0;transform:translateX(0);"><div style="background:linear-gradient(135deg,#1d4ed8 0%,#312e81 100%);width:100%;height:100%;"></div></div><div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;"><a style="background:#0071e3;color:white;padding:8px 16px;border-radius:18px;font-family:-apple-system,sans-serif;font-size:14px;text-decoration:none;">Shop</a></div></div>`,
    width: 320,
    height: 180,
  },
  {
    // DM-498: same as above but the artwork wrapper uses `will-change:
    // transform` instead of (or in addition to) the actual `transform`.
    // Apple's carousel applies will-change for animation perf without an
    // initial transform value — Domotion previously didn't detect this as
    // an SC-creating signal, so positioned descendants of NON-will-change
    // siblings would hoist past the will-change wrapper and the overlay
    // button could end up emitted before the artwork. CSS spec: a
    // will-change listing any SC-creating property creates an SC.
    name: "stacking-will-change-creates-sc",
    html: `<div style="position:relative;width:300px;height:160px;overflow:hidden;background:#0d1117;"><div style="position:absolute;inset:0;will-change:transform;"><div style="background:linear-gradient(135deg,#7c3aed 0%,#1e3a8a 100%);width:100%;height:100%;"></div></div><div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;"><a style="background:#0071e3;color:white;padding:8px 16px;border-radius:18px;font-family:-apple-system,sans-serif;font-size:14px;text-decoration:none;">Shop</a></div></div>`,
    width: 320,
    height: 180,
  },
  {
    // DM-497: pseudo-element paint box. ::after with bg-color + border-radius
    // + padding (badge / pill pattern). Capture records the pseudo's own
    // bg-color and border-radius on the segment, the renderer emits a <rect>
    // behind the glyph paths so the red pill paints under the white text.
    // The pseudo is on a span whose own positioning is `position: relative`
    // with the pseudo `position: absolute`, so the box anchors directly off
    // the captured pcs.left / pcs.top and the pcs padding/border are added
    // to xPos at capture time (the cleanest path for box geometry — see
    // CAPTURE_SCRIPT line ~1486).
    name: "pseudo-after-badge",
    html: `<div style="padding:32px;background:#0d1117;width:200px;height:80px;font-family:-apple-system,sans-serif;"><span class="m" style="position:relative;display:inline-block;width:60px;height:30px;background:#1f6feb;"></span><style>.m::after{content:'X';position:absolute;top:0;right:-50px;background:#dc2626;width:40px;height:30px;line-height:30px;font-size:11px;color:transparent;text-align:center;}</style></div>`,
    width: 280,
    height: 160,
  },
  {
    // DM-783: CSS check-mark idiom — empty `::before` with a right + bottom
    // border, sized 6×12, rotated 45° around its centre. Before the pseudo's
    // own `transform` was captured + emitted as a `<g transform="…">` wrapper,
    // the L-shape painted axis-aligned, reading as a backwards-L instead of a
    // tick. Verifies (a) the per-side border emit for the empty-content
    // pseudoBox, (b) transform-origin centring on the pseudo's own box (not
    // the host's origin), (c) z-stacking — text + box wrap together so the
    // tick lands inside the green circle.
    name: "pseudo-before-checkmark-rotated",
    html: `<div style="padding:24px;background:#0d1117;font-family:-apple-system,sans-serif;display:flex;align-items:center;gap:10px;color:#e6edf3;font-size:13px;"><span style="display:inline-block;position:relative;width:18px;height:18px;background:#22c55e;border-radius:50%;"><span style="position:absolute;left:6px;top:2px;width:5px;height:10px;border-right:2px solid #fff;border-bottom:2px solid #fff;transform:rotate(45deg);transform-origin:50% 50%;display:block;"></span></span>Completed</div>`,
    width: 200,
    height: 80,
  },
  {
    // DM-782: text-content `::before` with `background: linear-gradient(...)`
    // and white glyph text — the "gradient badge / pill / chip" pattern
    // (`32-real-world-pricing-table` MOST POPULAR badge). Previously the
    // background-image was dropped at capture-inject and the box painted with
    // `fill="none"`, so only the white glyphs were visible. Verifies the
    // gradient layer reaches the renderer and paints under the text.
    name: "pseudo-before-gradient-badge",
    html: `<div style="padding:40px;background:#0d1117;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;"><span class="badge" style="position:relative;display:inline-block;padding:28px 18px;background:#161b22;color:#e6edf3;font-size:13px;border-radius:6px;width:160px;text-align:center;">Pro Tier<style>.badge::before{content:'NEW';position:absolute;top:-10px;right:-12px;background:linear-gradient(135deg,#f59e0b,#ef4444);color:#fff;font-size:11px;font-weight:700;padding:3px 10px;border-radius:999px;}</style></span></div>`,
    width: 280,
    height: 140,
  },
  {
    // DM-785: rotated gradient pill with `width: auto` absolute `::before`.
    // The pseudo's shrink-to-fit width is taken from the painted text, which
    // canvas.measureText drifted from by 1-3px on bold uppercase short strings
    // — the badge box ended up undersized vs Chrome's paint, and the rotation
    // amplified the visible mismatch (text overflowed the gradient on one
    // side). Swapping the canvas measurement for an off-screen <span>
    // getBoundingClientRect probe matches Chrome's HarfBuzz layout exactly.
    name: "pseudo-before-rotated-gradient-badge",
    html: `<div style="padding:40px;background:#0d1117;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;"><span class="ribbon" style="position:relative;display:inline-block;padding:30px 22px;background:#161b22;color:#e6edf3;font-size:13px;border-radius:6px;width:180px;text-align:center;">Premium<style>.ribbon::before{content:'MOST POPULAR';position:absolute;top:-14px;left:50%;transform:translateX(-50%) rotate(-8deg);background:linear-gradient(135deg,#7c3aed,#ec4899);color:#fff;font-size:11px;font-weight:700;letter-spacing:0.5px;padding:4px 12px;border-radius:999px;white-space:nowrap;}</style></span></div>`,
    width: 320,
    height: 160,
  },
  {
    // DM-768: static `display: inline-block` pseudo with `vertical-align: middle`
    // — the CSS-triangle down-caret idiom (`width: 0; height: 0; border-left:
    // transparent; border-right: transparent; border-top: solid currentColor`).
    // The pseudo lands inside the inline flow at `baseline − 0.5 × x-height`,
    // not at the line-box top, but the prior static-flow position formula used
    // `rect.top + hostBorT + hostPadT + pMarT` and pinned the pseudo 6-7 px too
    // high. Verifies that a sentinel-probed pseudo position correctly aligns
    // the caret with the surrounding text.
    name: "pseudo-after-down-caret-vertical-align",
    html: `<div style="padding:24px;background:#fff;font-family:-apple-system,sans-serif;font-size:14px;"><style>.menu{display:inline-block;padding:6px 12px;border:1px solid #cbd5e1;background:#fff;border-radius:4px;}.caret::after{content:'';display:inline-block;width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-top:5px solid #0f172a;margin-left:8px;vertical-align:middle;}</style><span class="menu">Sort: Newest <span class="caret"></span></span></div>`,
    width: 240,
    height: 80,
  },
  {
    // DM-754: multi-column block-level `box-decoration-break`. The middle
    // callout is tall enough to fragment at the column boundary. With slice
    // (default) the first fragment owns TOP + LEFT + RIGHT borders and the
    // second owns BOTTOM + LEFT + RIGHT (no border across the column gap);
    // without per-fragment paint the bbox path would paint a single rect
    // spanning both columns and bridging the gap.
    name: "multi-column-block-decoration-slice",
    html: `<div style="padding:16px;background:#0d1117;color:#e6edf3;font-family:-apple-system,sans-serif;font-size:12px;line-height:1.5;"><div style="column-count:2;column-gap:24px;padding:12px;background:#1e293b;border-radius:6px;"><div style="background:#312e81;border:2px solid #6366f1;border-radius:6px;padding:10px;margin-bottom:10px;">Short block in column 1.</div><div style="background:#312e81;border:2px solid #6366f1;border-radius:6px;padding:10px;margin-bottom:10px;">A tall block whose content runs past the bottom of the first column and continues into the second column — its border should not bridge the column gap. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt.</div><div style="background:#312e81;border:2px solid #6366f1;border-radius:6px;padding:10px;">Final block.</div></div></div>`,
    width: 480,
    height: 280,
  },
  {
    // DM-754 + DM-721: same multi-column container as the slice fixture but
    // with `box-decoration-break: clone` on the fragmented block. Each
    // fragment paints a complete bordered + rounded box (all four sides on
    // both column ends, all four corners rounded).
    name: "multi-column-block-decoration-clone",
    html: `<div style="padding:16px;background:#0d1117;color:#e6edf3;font-family:-apple-system,sans-serif;font-size:12px;line-height:1.5;"><div style="column-count:2;column-gap:24px;padding:12px;background:#1e293b;border-radius:6px;"><div style="background:#312e81;border:2px solid #6366f1;border-radius:6px;padding:10px;margin-bottom:10px;box-decoration-break:clone;-webkit-box-decoration-break:clone;">Short clone block.</div><div style="background:#312e81;border:2px solid #6366f1;border-radius:6px;padding:10px;margin-bottom:10px;box-decoration-break:clone;-webkit-box-decoration-break:clone;">A tall clone block whose content fragments at the column boundary — each fragment paints its own complete border + rounded corners. Lorem ipsum dolor sit amet, consectetur adipiscing elit.</div><div style="background:#312e81;border:2px solid #6366f1;border-radius:6px;padding:10px;box-decoration-break:clone;-webkit-box-decoration-break:clone;">Final clone block.</div></div></div>`,
    width: 480,
    height: 280,
  },
  {
    // DM-506: CSS sprite icon image-replacement idiom — `text-indent: -9999px`
    // hides the accessible label off-screen and the visible icon is a slice of
    // a sprite sheet selected via `background-position`. Capture detects the
    // pattern and rasterises the painted box (sprite slice) instead of trying
    // to slice the bg-image declaratively (which doesn't work because the
    // sync naturalWidth read in CAPTURE_SCRIPT often returns 0 for url()
    // backgrounds whose <img> cache hasn't loaded). See docs/23.
    name: "sprite-icon-text-indent",
    html: (() => {
      const sprite =
        "data:image/svg+xml;utf8," +
        encodeURIComponent(
          "<svg xmlns='http://www.w3.org/2000/svg' width='60' height='20' viewBox='0 0 60 20'>" +
            "<rect x='0' y='0' width='20' height='20' fill='%23f59e0b'/>" +
            "<rect x='20' y='0' width='20' height='20' fill='%231f6feb'/>" +
            "<rect x='40' y='0' width='20' height='20' fill='%2322c55e'/>" +
            "</svg>",
        );
      const a = (cls: string, label: string, posX: string) =>
        `<a class="${cls}" aria-label="${label}" href="#" style="background:url(${sprite}) ${posX} 0 no-repeat;width:20px;height:20px;display:inline-block;text-indent:-9999px;overflow:hidden;margin-right:8px;">${label}</a>`;
      return `<div style="padding:20px;background:#0d1117;font-family:-apple-system,sans-serif;">${a("rss", "RSS", "0")}${a("fb", "Facebook", "-20px")}${a("li", "LinkedIn", "-40px")}</div>`;
    })(),
    width: 140,
    height: 60,
  },
  {
    // DM-499: inline SVG `<use href="#sym">` referencing a `<symbol>` defined
    // in a sibling hidden defs SVG — the apple.com country-dropdown checkmark
    // pattern. Capture-time resolver inlines the symbol into the consumer's
    // outerHTML so the output is fully self-contained (no dangling fragment
    // refs that the re-embedded SVG can't resolve).
    name: "inline-svg-use-symbol",
    html: `<div style="padding:24px;background:#0d1117;color:#22d3ee;font-family:-apple-system,sans-serif;display:flex;align-items:center;gap:12px;"><svg style="position:absolute;width:0;height:0;overflow:hidden;" aria-hidden="true"><symbol id="dm-icon-check" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></symbol></svg><svg width="20" height="20"><use href="#dm-icon-check"/></svg><span style="font-size:14px;">Selected</span><svg width="32" height="32" style="color:#a855f7;"><use href="#dm-icon-check"/></svg></div>`,
    width: 220,
    height: 80,
  },
  {
    // DM-499: <use href="#group-id"> targeting a <g> (no symbol viewBox).
    // Resolver wraps the cloned target in <g transform="translate(x,y)">.
    name: "inline-svg-use-group",
    html: `<div style="padding:24px;background:#0d1117;color:#fff;font-family:-apple-system,sans-serif;display:flex;align-items:center;gap:12px;"><svg style="position:absolute;width:0;height:0;overflow:hidden;" aria-hidden="true"><g id="dm-grp-star"><circle cx="12" cy="12" r="10" fill="#f59e0b"/><circle cx="12" cy="12" r="4" fill="#fff"/></g></svg><svg width="32" height="32" viewBox="0 0 24 24"><use href="#dm-grp-star"/></svg><svg width="32" height="32" viewBox="0 0 24 24"><use href="#dm-grp-star" x="0" y="0"/></svg></div>`,
    width: 160,
    height: 80,
  },
  {
    // DM-508: <use href="#sym"> targeting a CSS-animated <symbol>. Domotion
    // bakes the t=0 computed transform / fill / opacity onto the inlined
    // subtree at capture time so the painted moment matches Chrome — even
    // though the animation itself doesn't survive into the output (frozen
    // at capture time, like every other Domotion capture).
    name: "inline-svg-use-symbol-animated",
    html: `<style>@keyframes dm-fixture-spin{from{transform:rotate(45deg);}to{transform:rotate(45deg);}}.dm-fixture-spin-target{animation:dm-fixture-spin 4s infinite linear;transform-box:fill-box;transform-origin:center;}</style><div style="padding:24px;background:#0d1117;color:#fff;font-family:-apple-system,sans-serif;display:flex;align-items:center;gap:12px;"><svg style="position:absolute;width:0;height:0;overflow:hidden;" aria-hidden="true"><symbol id="dm-anim-icon" viewBox="0 0 24 24"><rect class="dm-fixture-spin-target" x="6" y="6" width="12" height="12" fill="#3fb950"/></symbol></svg><svg width="32" height="32"><use href="#dm-anim-icon"/></svg></div>`,
    width: 120,
    height: 80,
  },
  {
    // DM-524: inline SVG with `var(--token)` / `calc()` / `env()` references
    // baked directly into presentation attributes (Stripe's nav-button
    // <rect fill="var(--hds-color-text-solid)"> idiom). Chrome resolves these
    // against the source page's custom-property cascade; outside that
    // cascade — i.e. in our extracted SVG — the var is unresolved and the
    // rect paints black/currentColor instead of the intended palette color.
    // Capture-time fix overwrites the literal with the resolved computed
    // value when the source attribute is a CSS function ref.
    name: "inline-svg-css-var-attr",
    html: `<div style="--btn-bg:#1f6feb;--btn-stroke:#22d3ee;--btn-thick:calc(2px + 1px);padding:24px;background:#0d1117;display:flex;gap:12px;align-items:center;"><svg width="60" height="40"><rect x="2" y="2" width="56" height="36" fill="var(--btn-bg)" stroke="var(--btn-stroke)" stroke-width="var(--btn-thick)" rx="6"/></svg><svg width="60" height="40"><circle cx="30" cy="20" r="14" fill="var(--btn-stroke)" opacity="0.5"/></svg></div>`,
    width: 180,
    height: 80,
  },
  {
    // DM-523: position:fixed inside a transformed ancestor pins to that
    // ancestor (CSS Transforms 2: any non-none transform creates a
    // containing block for fixed-positioned descendants). When capturing,
    // we used to clear the ancestor's inline transform to read its
    // un-transformed rect — but transform: none destroys the CB, letting
    // the fixed descendant escape to the viewport. The fix substitutes
    // transform: translate(0), preserving the CB while still producing the
    // un-rotated/un-scaled rect we need for the SVG group wrapper.
    //
    // The fixture: ancestor has transform: translate(0,0) (a no-op);
    // descendant pin is position: fixed with bottom/right offsets that
    // anchor it to the ancestor's bottom-right corner. If the CB-preserve
    // bug regressed, the pin would jump to viewport bottom-right.
    name: "fixed-in-transform-cb",
    html: `<div style="padding:24px;background:#0d1117;"><div style="position:relative;width:280px;height:140px;background:#1f2937;transform:translate(0,0);"><div style="position:fixed;bottom:8px;right:8px;width:40px;height:24px;background:#dc2626;"></div></div></div>`,
    width: 360,
    height: 200,
  },
  {
    // DM-522: `contain: paint` must clip descendants to the principal box
    // per the CSS Containment spec. Before the fix the renderer treated
    // contain:paint as stacking-context-only and emitted no clip, so
    // descendants leaked past the ancestor box (regression observable on
    // 13-deep-stacking-context-creators's contain:paint stage).
    //
    // Fixture: ancestor is contain:paint with width:120 / height:60. A
    // child rect at top:30 left:60 width:120 height:60 would overflow the
    // ancestor's right and bottom edges by 60px each in a non-clipping
    // context. With contain:paint clipping, only the top-left quadrant
    // (60x30) of the child should be visible.
    name: "contain-paint-clips",
    html: `<div style="padding:24px;background:#0d1117;"><div style="position:relative;width:120px;height:60px;background:#1f2937;contain:paint;"><div style="position:absolute;top:30px;left:60px;width:120px;height:60px;background:#2563eb;"></div></div></div>`,
    width: 240,
    height: 120,
  },
  {
    // DM-543: position:fixed paints in the viewport stacking context and
    // escapes ALL ancestor overflow clips. The bug: the renderer hoisted
    // fixed pins only up to the nearest stacking-context ancestor — and an
    // overflow:auto scroller IS an SC. So a pin captured at viewport
    // bottom-right got buried inside the section's <g clip-path> wrapper
    // and was clipped out (invisible).
    //
    // Fixture: a section with overflow:hidden and NO fixed-CB ancestor
    // contains a position:fixed pin at viewport bottom-right. The pin's
    // captured x/y are the viewport coordinates (bottom-right of the
    // 280x180 viewport here, anchored 8px in). With the fix, the pin is
    // hoisted to the root SC and renders at viewport bottom-right
    // regardless of the section's clip.
    //
    // Constraint check (covered by `fixed-in-transform-cb` above): when
    // the ancestor IS a fixed CB (transform / filter / will-change /
    // contain), the pin stays trapped — don't over-escape.
    name: "fixed-escapes-overflow",
    html: `<div style="padding:0;margin:0;"><section style="border:2px solid #475569;background:#f8fafc;height:120px;overflow:hidden;padding:8px;"><div style="border:2px dashed #94a3b8;padding:8px;height:200px;"><div style="position:fixed;bottom:8px;right:8px;background:#dc2626;color:#fff;padding:4px 8px;font:bold 12px sans-serif;">PIN</div></div></section></div>`,
    width: 280,
    height: 180,
  },
  {
    // DM-499 regression: plain self-contained inline SVG (paths declared
    // inline) must keep round-tripping via the existing DM-279 path.
    name: "inline-svg-self-contained",
    html: `<div style="padding:24px;background:#0d1117;color:#3fb950;font-family:-apple-system,sans-serif;display:flex;align-items:center;gap:12px;"><svg width="20" height="20" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg><span style="font-size:14px;">Inline</span></div>`,
    width: 180,
    height: 80,
  },
  {
    // DM-494: mask-image: element(#id) — paint-reference. The referenced
    // element's actual painted output is rasterized at capture time and
    // emitted as <image> inside <mask>. mask-mode: match-source → luminance
    // for element() refs (the RGB drives mask alpha). Source div has a
    // diagonal split (white on top-left half, black bottom-right) so the
    // luminance mask cuts the consumer rectangle along that diagonal.
    name: "mask-element-ref",
    html: `<div style="padding:20px;background:#0d1117;font-family:-apple-system,sans-serif;color:#e6edf3;"><div id="src" style="position:absolute;left:-9999px;top:-9999px;width:200px;height:120px;background:linear-gradient(135deg,#fff 0%,#fff 50%,#000 50%,#000 100%);"></div><div style="display:flex;gap:16px;"><div style="width:200px;height:120px;background:#22d3ee;mask-image:element(#src);-webkit-mask-image:element(#src);mask-mode:match-source;-webkit-mask-mode:match-source;"></div><div style="width:200px;height:120px;background:#a855f7;mask-image:element(#src);-webkit-mask-image:element(#src);mask-mode:match-source;-webkit-mask-mode:match-source;"></div></div></div>`,
    width: 480,
    height: 180,
  },
  {
    // DM-493: mask-image: url("#id") referencing an inline <mask> defined in
    // the same document. Capture resolves the fragment, serialises the mask's
    // outerHTML, and the renderer copies it into the output <defs> with id
    // rewriting. Two boxes share one mask def to exercise dedupe.
    name: "mask-fragment-url",
    html: `<div style="padding:20px;background:#0d1117;font-family:-apple-system,sans-serif;color:#e6edf3;"><svg width="0" height="0" style="position:absolute;"><defs><mask id="diag-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="200" height="120"><rect x="0" y="0" width="200" height="120" fill="white"/><polygon points="0,0 200,0 200,40 0,120" fill="black"/></mask></defs></svg><div style="display:flex;gap:16px;"><div style="width:200px;height:120px;background:linear-gradient(135deg,#22d3ee,#a855f7);mask-image:url(#diag-mask);-webkit-mask-image:url(#diag-mask);"></div><div style="width:200px;height:120px;background:#f97316;mask-image:url(#diag-mask);-webkit-mask-image:url(#diag-mask);"></div></div></div>`,
    width: 480,
    height: 180,
  },
  {
    // DM-580: accessibility "visually-hidden" / "sr-only" patterns paint
    // nothing in Chrome but the DOM still carries the text. Real-world
    // captures of nytimes.com / slashdot etc. were leaking stray skip-link /
    // section-abbreviation text into the SVG. Three patterns exercised:
    //   1. `clip: rect(0,0,0,0)` (legacy)
    //   2. `clip-path: inset(50%)` (modern, used by Tailwind's `sr-only`)
    //   3. `width:1px;height:1px;overflow:hidden;position:absolute` (1×1 sr-only)
    // The fixture wraps a normally-painted "Hello" so we can verify the box
    // around it is unchanged while the hidden text drops out.
    name: "visually-hidden-text",
    html: `<div style="padding:20px;background:#fff;font-family:-apple-system,sans-serif;font-size:16px;color:#111;">
      <a href="#main" style="position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;">Skip to content</a>
      <span style="position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;">Section: SK</span>
      <span style="position:absolute;width:1px;height:1px;overflow:hidden;">Tooltip label</span>
      <span>Hello</span>
    </div>`,
    width: 240,
    height: 80,
  },
  {
    // Inline elements that wrap across multiple line boxes need per-fragment
    // paint of background + border (CSS Backgrounds 3 §3.7
    // `box-decoration-break`). Without it the captured bbox covers the
    // union of every line and the single rect paint smears across the full
    // container width — text floats outside its highlight, and pill chips
    // lose their per-line rounded corners. This fixture exercises:
    //   1. slice (default): first fragment gets TL/BL + LEFT border,
    //      last gets TR/BR + RIGHT, middle fragments paint only top + bottom.
    //   2. clone: every fragment paints a full pill with all four corners,
    //      including a `border-radius: 999px` chip that should keep its
    //      rounded ends on every line.
    name: "inline-box-decoration-break",
    html: `<div style="font-family:-apple-system,sans-serif;font-size:14px;line-height:1.7;padding:20px;background:#fff;color:#111;">
      <div style="max-width:320px;padding:12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;margin-bottom:12px;">
        Default body text. <span style="background:#fef3c7;border:2px solid #b45309;padding:2px 8px;border-radius:6px;box-decoration-break:slice;-webkit-box-decoration-break:slice;">A highlighted span that wraps across multiple lines using slice.</span> After.
      </div>
      <div style="max-width:320px;padding:12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;margin-bottom:12px;">
        Default body text. <span style="background:#fef3c7;border:2px solid #b45309;padding:2px 8px;border-radius:6px;box-decoration-break:clone;-webkit-box-decoration-break:clone;">A highlighted span that wraps across multiple lines using clone.</span> After.
      </div>
      <div style="max-width:320px;padding:12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;">
        <span style="background:#1d4ed8;color:white;padding:2px 10px;border-radius:999px;box-decoration-break:clone;-webkit-box-decoration-break:clone;">A pill-shaped chip wrapping across lines keeps rounded corners.</span>
      </div>
    </div>`,
    width: 420,
    height: 360,
  },
];

void runFeatureTests(tests, "features");
