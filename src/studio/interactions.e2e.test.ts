import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runStudioSemanticTracks, StudioInteractionError } from "./interactions.js";

const fixture = `<!doctype html>
<style>body{margin:0}.spacer{height:1100px}.drop{width:100px;height:60px;background:#ddd}</style>
<button aria-label="Launch demo">Launch</button>
<button class="duplicate">Duplicate</button><button class="duplicate">Duplicate</button>
<label>Name <input value="old"></label>
<div id="hover">Hover here</div>
<input id="agree" type="checkbox">
<div id="drag" draggable="true">Drag</div><div id="drop" class="drop">Drop here</div>
<div class="spacer"></div><div data-testid="scroll-destination">Destination</div>
<script>
  window.events=[];
  document.querySelector('[aria-label="Launch demo"]').addEventListener('click',e=>window.events.push('click:'+e.button+':'+e.detail));
  document.querySelector('#hover').addEventListener('mouseenter',()=>window.events.push('hover'));
  document.querySelector('#drop').addEventListener('dragover',e=>e.preventDefault());
  document.querySelector('#drop').addEventListener('drop',()=>window.events.push('drop'));
  setTimeout(()=>{document.querySelector('#agree').checked=true},30);
  setTimeout(()=>{document.querySelector('#drop').textContent='Ready to drop'},40);
</script>`;

describe("Studio semantic interaction browser execution (DM-2683)", () => {
  let browser: Browser | null = null;
  let page: Page | null = null;
  let available = true;

  beforeAll(async () => {
    try {
      browser = await chromium.launch({ headless: true });
      page = await browser.newPage({ viewport: { width: 800, height: 500 } });
    } catch {
      available = false;
    }
  }, 60_000);

  afterAll(async () => browser?.close(), 15_000);

  it("executes every semantic action kind with authored overrides and explicit hooks", async () => {
    if (!available || page == null) return;
    const testPage = page;
    await testPage.setContent(fixture);
    const hookCalls: string[] = [];
    await runStudioSemanticTracks(testPage, [{
      id: "demo",
      kind: "semantic-interactions",
      events: [
        { id: "click", atMs: 0, kind: "click", target: { role: "button", name: "Launch demo", selector: ".never-used" }, button: "right", clickCount: 2 },
        { id: "hover", atMs: 0, kind: "hover", target: { text: "Hover here" } },
        { id: "replace", atMs: 0, kind: "type", target: { label: "Name" }, text: "Ada" },
        { id: "append", atMs: 0, kind: "type", target: { label: "Name" }, text: " Lovelace", replace: false, durationMs: 10 },
        { id: "checked", atMs: 10, kind: "waitForState", target: { domId: "agree" }, state: "checked", timeoutMs: 1_000 },
        { id: "text", atMs: 10, kind: "waitForState", target: { domId: "drop" }, state: "text", value: "Ready", timeoutMs: 1_000 },
        { id: "drag", atMs: 10, kind: "drag", target: { domId: "drag" }, to: { target: { domId: "drop" } } },
        { id: "scroll", atMs: 10, kind: "scrollTo", target: { testId: "scroll-destination" }, behavior: "instant" },
        { id: "position", atMs: 10, kind: "scrollTo", position: { x: 0, y: 0 } },
        { id: "hook", atMs: 10, kind: "scriptHook", hookId: "seed-demo", input: { mode: "stable" } },
      ],
    }], {
      runHook: ({ hookId, input }) => {
        hookCalls.push(`${hookId}:${String(input?.mode)}`);
      },
    });

    expect(await testPage.locator("input").first().inputValue()).toBe("Ada Lovelace");
    expect(await testPage.evaluate(() => (window as unknown as { events: string[] }).events)).toEqual([
      "click:2:2",
      "hover",
      "drop",
    ]);
    expect(await testPage.evaluate(() => scrollY)).toBe(0);
    expect(hookCalls).toEqual(["seed-demo:stable"]);
    expect(await testPage.locator("[data-domotion-studio-target]").count()).toBe(0);
  }, 60_000);

  it("fails exact-match ambiguity and undeclared hook execution with authored paths", async () => {
    if (!available || page == null) return;
    await page.setContent(fixture);
    await expect(runStudioSemanticTracks(page, [{
      id: "bad",
      kind: "semantic-interactions",
      events: [{ id: "ambiguous", atMs: 0, kind: "click", target: { text: "Duplicate" } }],
    }])).rejects.toMatchObject({
      path: "$.tracks[0].events[0].target",
      eventId: "ambiguous",
      message: expect.stringContaining("ambiguous (2 matches)"),
    });

    await expect(runStudioSemanticTracks(page, [{
      id: "hook",
      kind: "semantic-interactions",
      events: [{ id: "script", atMs: 0, kind: "scriptHook", hookId: "unsafe" }],
    }])).rejects.toThrow('script hook "unsafe" requires an explicit runHook handler');
  });
});
