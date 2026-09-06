import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cursorOverlayMarkup, resolveCursorScript } from "../animation/cursor-overlay.js";
import { buildStudioCursorChoreography, inspectStudioCursorTargets } from "./cursor-choreography.js";
import { compileStudioSemanticTracks } from "./interactions.js";

describe("Studio cursor DOM/CSS inspection and renderer integration (DM-2686)", () => {
  let browser: Browser | null = null;
  let page: Page | null = null;
  let available = true;

  beforeAll(async () => {
    try {
      browser = await chromium.launch({ headless: true });
      page = await browser.newPage({ viewport: { width: 900, height: 600 } });
    } catch {
      available = false;
    }
  }, 60_000);

  afterAll(async () => browser?.close(), 15_000);

  it("uses rendered target boxes and computed cursor CSS for every visual action", async () => {
    if (!available || page == null) return;
    await page.setContent(`<!doctype html><style>
      body{margin:0}.grid{display:grid;grid-template-columns:1fr 1fr;gap:35px;padding:45px}
      button{width:150px;height:52px;cursor:pointer}input{width:240px;height:34px;cursor:text}
      #hover{width:190px;height:70px;cursor:help}.drag{width:90px;height:64px;cursor:grab}
      #drop{margin-left:620px;width:140px;height:90px}.spacer{height:900px}
    </style><div class="grid"><button aria-label="Launch">Launch</button><div id="hover">Inspect</div>
    <label>Name <input></label><div id="drag" class="drag">Drag</div></div><div class="spacer"></div>
    <div data-testid="scroll-end">End</div><div id="drop">Drop</div>`);
    const plan = compileStudioSemanticTracks([{ id: "demo", kind: "semantic-interactions", events: [
      { id: "click", atMs: 0, kind: "click", target: { role: "button", name: "Launch" }, button: "right", clickCount: 2 },
      { id: "hover", atMs: 100, kind: "hover", target: { domId: "hover" } },
      { id: "type", atMs: 200, kind: "type", target: { label: "Name" }, text: "Ada" },
      { id: "scroll", atMs: 300, kind: "scrollTo", target: { testId: "scroll-end" } },
      { id: "drag", atMs: 400, kind: "drag", target: { domId: "drag" }, to: { target: { domId: "drop" } } },
    ] }]);

    const evidence = await inspectStudioCursorTargets(page, plan);
    expect(evidence.map((item) => item.kind)).toEqual(["click", "hover", "type", "scrollTo", "drag"]);
    expect(evidence.map((item) => item.cursor)).toEqual(["pointer", "help", "text", "auto", "grab"]);
    expect(evidence[0].box).toMatchObject({ x: 45, y: 45, width: 150, height: 52 });
    expect(evidence[4].destinationBox?.x).toBeGreaterThan(600);

    const choreography = await buildStudioCursorChoreography(page, plan, { seed: "browser-render" });
    const resolved = resolveCursorScript(choreography.overlay, choreography.durationMs + 500, [0], null);
    const svg = cursorOverlayMarkup(resolved.positions, resolved.clicks, resolved.style, choreography.durationMs + 500);
    expect(resolved.positions.length).toBeGreaterThan(40);
    expect(resolved.clicks).toHaveLength(3);
    expect(resolved.clicks.slice(0, 2).map((click) => click.button)).toEqual(["secondary", "secondary"]);
    expect(svg).toContain('class="cursor-overlay"');
    expect(svg).toMatch(/@keyframes co-pos-[a-z0-9]+/);
    expect(choreography.interactions.find((item) => item.eventId === "drag")?.destinationPoint).toBeDefined();
  }, 60_000);
});
