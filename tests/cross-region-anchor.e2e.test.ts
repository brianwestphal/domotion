import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchChromium } from "../src/capture/index.js";
import { composeAnimateFrames, validateAnimateConfig } from "../src/cli/animate.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { PARITY_LAUNCH_OPTS } from "./flipbook-parity.js";

// DM-1799: a per-state overlay anchored into a region on a DIFFERENT `advances`
// schedule must resolve against that region's position in the state it belongs
// to — not the position it happened to hold in the capture round the state was
// driven in.
//
// Under per-region timing the live page never stands in a state's assembled
// configuration: states advancing disjoint regions share one whole-page capture,
// and each state's tree is assembled afterwards from the round holding each
// region's own state. Page-context anchoring therefore could not be exact here
// (DM-1793); the tree-side resolver runs against the assembled tree, which does
// hold every region at its own state.
//
// The scene: two panes on independent schedules. `#pv`'s marker moves 40 px per
// preview advance. States that advance the EDITOR anchor an overlay to the
// PREVIEW's marker — the cross-region case. Because the two schedules interleave,
// the round an editor state is driven in holds the preview at a DIFFERENT
// position than the assembled state does, so the two resolvers disagree by a
// known, checkable amount.

const W = 520;
const H = 260;

const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;width:${W}px;height:${H}px;background:#0d1117;color:#e6edf3;
       font:13px Menlo,monospace;overflow:hidden}
  #ed{position:absolute;left:0;top:0;width:260px;height:${H}px;background:#161b22;padding:10px;box-sizing:border-box}
  #pv{position:absolute;left:260px;top:0;width:260px;height:${H}px;background:#1c2128;padding:10px;box-sizing:border-box}
  /* The preview's marker moves 40px per advance — the anchor target. */
  #mk{position:absolute;left:24px;width:12px;height:12px;background:#f778ba;border-radius:2px}
</style></head><body>
  <div id="ed"><div id="edtext">editor 0</div></div>
  <div id="pv"><div id="mk"></div><div id="pvtext">preview 0</div></div>
<script>
  window.setEditor  = (k) => { document.getElementById('edtext').textContent = 'editor ' + k; };
  window.setPreview = (k) => {
    document.getElementById('pvtext').textContent = 'preview ' + k;
    document.getElementById('mk').style.top = (30 + k * 40) + 'px';
  };
  window.setPreview(0);
</script></body></html>`;

/** `#mk`'s viewport top for preview step k — mirrors the page's own formula. */
const MARKER_TOP = (k: number): number => 30 + k * 40;

async function setup() {
  try {
    const dir = mkdtempSync(join(tmpdir(), "dm-xregion-anchor-e2e-"));
    writeFileSync(join(dir, "panes.html"), PAGE_HTML);
    return { browser: await launchChromium(PARITY_LAUNCH_OPTS), dir };
  } catch {
    return null;
  }
}

const env = await setup();
afterAll(async () => {
  await closeBrowserSafely(env?.browser);
  if (env != null) rmSync(env.dir, { recursive: true, force: true });
}, 15_000);

const describeBrowser = env ? describe : describe.skip;

describeBrowser("cross-region per-state overlay anchors (DM-1799)", () => {
  it("resolves each state's anchor against that state's assembled tree, not its capture round", async () => {
    const { browser, dir } = env!;
    const cut = { type: "cut", duration: 0 } as const;
    // Editor advances at states 1 and 3; preview at states 2 and 4. Each EDITOR
    // state anchors an overlay to the preview's marker, so the expected y is the
    // preview's position IN THAT STATE: state 1 → preview still 0, state 3 →
    // preview at 1 (state 2 advanced it).
    const anchoredOverlay = {
      kind: "blink", width: 12, height: 12, color: "#39d353", periodMs: 100_000,
      anchor: { selector: "#mk", at: "top-left" },
    };
    const cfg = validateAnimateConfig({
      width: W, height: H,
      frames: [{
        input: "./panes.html",
        duration: 1500,
        transition: cut,
        regions: { editor: "#ed", preview: "#pv" },
        states: [
          { duration: 300 },
          { advances: ["editor"], actions: [{ type: "evaluate", script: "setEditor(1)" }], duration: 300, overlays: [anchoredOverlay] },
          { advances: ["preview"], actions: [{ type: "evaluate", script: "setPreview(1)" }], duration: 300 },
          { advances: ["editor"], actions: [{ type: "evaluate", script: "setEditor(2)" }], duration: 300, overlays: [anchoredOverlay] },
          { advances: ["preview"], actions: [{ type: "evaluate", script: "setPreview(2)" }], duration: 300 },
        ],
      }],
    });

    const logs: string[] = [];
    const config = await composeAnimateFrames(browser, cfg, { configDir: dir, log: (m) => logs.push(m) });
    // Per-region timing really engaged (fewer capture rounds than states).
    expect(logs.some((l) => /per-region timing/.test(l)), logs.join("\n")).toBe(true);

    const overlays = config.frames[0].overlays ?? [];
    expect(overlays, "expected one overlay per editor state").toHaveLength(2);
    const ys = overlays.map((o) => (o as { y: number }).y).sort((a, b) => a - b);

    // State 1's overlay must sit at the preview's step-0 marker, state 3's at
    // step 1 — 40 px apart. If the anchors had resolved against the live page in
    // the round each state was driven in, both would report the same y (the two
    // editor advances share their rounds with different preview positions, and
    // neither round holds the assembled pairing).
    expect(ys[0]).toBeCloseTo(MARKER_TOP(0), 0);
    expect(ys[1]).toBeCloseTo(MARKER_TOP(1), 0);
    expect(ys[1] - ys[0], "the two states' anchors must differ by exactly one marker step").toBeCloseTo(40, 0);
  }, 240_000);
});
