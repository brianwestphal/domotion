import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect as browserExpect, type Browser } from "@playwright/test";
import { expect, it } from "vitest";
import { launchChromium } from "../src/capture/index.js";
import { startStudioServer } from "../src/studio/server.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

it("keeps Studio counters and labels within their panel across responsive round trips", async () => {
  const server = await startStudioServer({
    workspaceRoot: process.cwd(),
    initialProjectPath: "tests/fixtures/studio/treatments-showcase.project.json",
    port: 0,
  });
  let browser: Browser | undefined;
  const output = resolve(process.env["DOMOTION_OUTPUT_DIR"] ?? "tests/output", "studio-responsive-metrics");
  try {
    mkdirSync(output, { recursive: true });
    browser = await launchChromium();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    await page.goto(server.url, { waitUntil: "networkidle" });
    const panel = page.getByRole("heading", { name: "Generation & review", exact: true }).locator("..");
    await browserExpect(panel.locator(".metric")).toHaveCount(3);
    const measurements = [];
    for (const [state, width] of [
      ["wide", 1440],
      ["medium", 900],
      ["narrow", 390],
      ["wide-return", 1440],
    ] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => window.scrollTo(0, 0));
      const geometry = await panel.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const bounds = (rect: DOMRect) => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
        return {
          panel: {
            left: box.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft),
            right: box.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight),
          },
          pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
          cards: [...element.querySelectorAll(".metric")].map((card) => ({
            ...bounds(card.getBoundingClientRect()),
            value: card.querySelector("strong")!.textContent,
            label: card.querySelector("span")!.textContent,
            text: [...card.querySelectorAll("strong,span")].map((node) => {
              const range = document.createRange();
              range.selectNodeContents(node);
              return bounds(range.getBoundingClientRect());
            }),
          })),
        };
      });
      measurements.push({ state, width, ...geometry });
      await page.screenshot({ path: resolve(output, `${state}.png`) });
      await panel.screenshot({ path: resolve(output, `${state}-panel.png`) });
    }
    writeFileSync(resolve(output, "geometry.json"), JSON.stringify(measurements, null, 2));
    for (const { state, cards, panel: owner, pageOverflow } of measurements) {
      expect(pageOverflow, state).toBe(false);
      expect(
        cards.map(({ label, value }) => [label, value]),
        state,
      ).toEqual([
        ["Scenes", "8"],
        ["Artifacts", "0"],
        ["Open notes", "0"],
      ]);
      for (const card of cards) {
        expect(card.left, `${state}: ${card.label} left`).toBeGreaterThanOrEqual(owner.left);
        expect(card.right, `${state}: ${card.label} right`).toBeLessThanOrEqual(owner.right);
        for (const text of card.text) {
          expect(text.left, `${state}: ${card.label} text left`).toBeGreaterThanOrEqual(card.left);
          expect(text.right, `${state}: ${card.label} text right`).toBeLessThanOrEqual(card.right);
          expect(text.top, `${state}: ${card.label} text top`).toBeGreaterThanOrEqual(card.top);
          expect(text.bottom, `${state}: ${card.label} text bottom`).toBeLessThanOrEqual(card.bottom);
        }
      }
      for (let i = 1; i < cards.length; i++) {
        const prior = cards[i - 1]!,
          current = cards[i]!;
        expect(current.left >= prior.right || current.top >= prior.bottom, `${state}: counter overlap`).toBe(true);
      }
    }
    expect(measurements[0]!.cards).toEqual(measurements[3]!.cards);
    expect(new Set(measurements[0]!.cards.map(({ top }) => top)).size).toBe(1);
    await browserExpect(panel.getByRole("button", { name: "Generate whole story", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Add scene", exact: true }).click();
    await browserExpect(panel.locator(".metric strong").first()).toHaveText("9");
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await browserExpect(panel.locator(".metric strong").first()).toHaveText("8");
  } finally {
    await closeBrowserSafely(browser);
    await server.close();
  }
}, 60_000);
