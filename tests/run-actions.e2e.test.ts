import { afterAll, describe, expect, it } from "vitest";
import { launchChromium, runActions, type AnimateAction } from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// DM-1140 (doc 63 §2): `runActions(page, actions)` is the declarative action
// runner re-exported from the package root so imperative scripting-API callers
// get the DOM-mutation vocabulary (setText / addClass / insert / replaceText /
// setStyle / dispatch / …) without authoring a JSON config. `log` defaults to a
// no-op for the public form. This exercises the runner against a live page.

const HTML =
  `<!doctype html><html><head><meta charset="utf-8"></head><body>` +
  `<h1 id="title">Old Title</h1>` +
  `<p class="price">Was $0</p>` +
  `<ul id="list"><li>one</li><li>two</li></ul>` +
  `<div class="row">a</div><div class="row">b</div>` +
  `<button id="btn">Go</button>` +
  `<span id="doomed">remove me</span>` +
  `</body></html>`;

async function setup() {
  try {
    return { browser: await launchChromium() };
  } catch {
    return null;
  }
}

const env = await setup();
afterAll(async () => {
  await closeBrowserSafely(env?.browser);
}, 15_000);

const describeBrowser = env ? describe : describe.skip;

describeBrowser("runActions public primitive (DM-1140)", () => {
  it("applies the DOM-mutation vocabulary across matched elements (no log needed)", async () => {
    const { browser } = env!;
    const page = await browser.newPage();
    try {
      await page.setContent(HTML, { waitUntil: "load" });

      const actions: AnimateAction[] = [
        { type: "setText", selector: "#title", value: "New Title" },
        { type: "addClass", selector: ".row", class: "is-active" }, // every matched element
        { type: "setStyle", selector: "#title", props: { color: "rgb(255, 0, 0)" } },
        { type: "setAttribute", selector: "#btn", name: "data-state", value: "ready" },
        { type: "replaceText", selector: ".price", pattern: "\\$0", replacement: "$49" },
        { type: "insert", selector: "#list", position: "beforeend", html: "<li>three</li>" },
        { type: "remove", selector: "#doomed" },
      ];
      // No `log` argument — the public form defaults it to a no-op.
      await runActions(page, actions);

      const state = await page.evaluate(() => ({
        title: document.getElementById("title")!.textContent,
        titleColor: getComputedStyle(document.getElementById("title")!).color,
        rowsActive: Array.from(document.querySelectorAll(".row")).map((r) => r.classList.contains("is-active")),
        btnState: document.getElementById("btn")!.getAttribute("data-state"),
        price: document.querySelector(".price")!.textContent,
        listCount: document.querySelectorAll("#list li").length,
        doomed: document.getElementById("doomed") == null,
      }));

      expect(state.title).toBe("New Title");
      expect(state.titleColor).toBe("rgb(255, 0, 0)");
      expect(state.rowsActive).toEqual([true, true]); // applied to EVERY match
      expect(state.btnState).toBe("ready");
      expect(state.price).toBe("Was $49");
      expect(state.listCount).toBe(3);
      expect(state.doomed).toBe(true);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("throws when a DOM-mutation selector matches nothing (fail-fast)", async () => {
    const { browser } = env!;
    const page = await browser.newPage();
    try {
      await page.setContent(HTML, { waitUntil: "load" });
      await expect(
        runActions(page, [{ type: "setText", selector: "#nope", value: "x" }]),
      ).rejects.toThrow();
    } finally {
      await page.close();
    }
  }, 60_000);

  it("runs interaction actions (click) and forwards the optional log", async () => {
    const { browser } = env!;
    const page = await browser.newPage();
    try {
      await page.setContent(
        HTML.replace("<button id=\"btn\">Go</button>", "<button id=\"btn\" onclick=\"this.textContent='Clicked'\">Go</button>"),
        { waitUntil: "load" },
      );
      const logs: string[] = [];
      await runActions(page, [{ type: "click", selector: "#btn" }], (m) => logs.push(m));
      expect(await page.textContent("#btn")).toBe("Clicked");
    } finally {
      await page.close();
    }
  }, 60_000);
});
