import { afterAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "@playwright/test";

// DM-1798: browser-side guard for the two UIs that use kerf's RUNTIME rather
// than just its SSR JSX — `tests/review-client.tsx` (signal / computed /
// effect / mount / delegate, plus `each`, the keyed list reconciler) and
// `src/scrubber/client.tsx` (the same minus `each`).
//
// Why this exists: the existing e2e for both surfaces is server-side only —
// `review-server-e2e.test.ts` and `scrubber-frame-attach.e2e.test.ts` assert
// HTTP responses. Nothing drove the rendered UI, so a kerfjs upgrade could
// break every interactive path with a fully green suite. That gap surfaced
// during the 2.0.1 → 3.0.0-beta.1 upgrade, whose changelog is dominated by
// list-reconciler and morph-pairing changes: exactly this code. Verifying it
// by hand once is not the same as keeping it verified.
//
// These assert BEHAVIOR through the reactive pipeline (delegate → signal →
// bound attribute/value, and each() reconcile across reorder + filter), not
// markup shape.

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

/** Spawn a server via tsx and resolve the URL it prints. */
async function startServer(script: string, args: string[]): Promise<{ proc: ChildProcess; url: string } | null> {
  const proc = spawn("npx", ["tsx", script, ...args], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  const url = await new Promise<string | null>((res) => {
    const timer = setTimeout(() => res(null), 60_000);
    const scan = (b: Buffer): void => {
      const m = /https?:\/\/(?:localhost|127\.0\.0\.1):\d+/.exec(b.toString());
      if (m != null) { clearTimeout(timer); res(m[0]); }
    };
    proc.stdout?.on("data", scan);
    proc.stderr?.on("data", scan);
    proc.on("exit", () => { clearTimeout(timer); res(null); });
  });
  if (url == null) { proc.kill(); return null; }
  return { proc, url };
}

/** Collect page errors so a silently-broken reactive path can't pass. */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console.error: ${m.text()}`); });
  return errors;
}

let browser: Browser | null = null;
const servers: ChildProcess[] = [];
afterAll(async () => {
  for (const p of servers) p.kill();
  await browser?.close();
}, 20_000);

try { browser = await chromium.launch(); } catch { browser = null; }
const describeBrowser = browser ? describe : describe.skip;

describeBrowser("kerf-driven client UIs (DM-1798)", () => {
  // The review UI needs a results manifest to have anything to render; it is
  // written by any visual-suite run. Skip rather than fail when absent.
  const haveResults = existsSync(resolve(ROOT, "tests/output/features-results.json"));

  it.runIf(haveResults)("review UI: each() reconciles across reorder and filter, preserving row identity", async () => {
    const started = await startServer("tests/review-server.tsx", []);
    expect(started, "review server failed to start").not.toBeNull();
    servers.push(started!.proc);
    const page = await browser!.newPage();
    const errors = watchErrors(page);
    try {
      await page.goto(started!.url, { waitUntil: "networkidle" });
      await page.waitForSelector("[data-key]", { timeout: 20_000 });
      const keys = (): Promise<string[]> => page.$$eval("[data-key]", (ns) => ns.map((n) => (n as HTMLElement).dataset.key!));
      const pick = async (id: string, i: number): Promise<void> => {
        const opts = await page.$$eval(`#${id} option`, (os) => os.map((o) => (o as HTMLOptionElement).value));
        await page.selectOption(`#${id}`, opts[i]);
        await page.waitForTimeout(350);
      };

      const before = await keys();
      expect(before.length, "review UI rendered no cards").toBeGreaterThan(1);
      expect(new Set(before).size, "duplicate data-keys on first render").toBe(before.length);

      // A card that survives a REORDER must keep its DOM node AND still be
      // showing its own data. We stamp the node, sort, then look for the stamp
      // and check which row now carries it.
      //
      // Two distinct regressions this catches, both verified to fail here:
      //   - stamp GONE (null): the list rebuilt its rows instead of moving
      //     them, so all row DOM state (focus, scroll, IME) is discarded.
      //     Reproduced by destroying row object identity — `each()` memoizes on
      //     it, so e.g. a `.map(x => ({...x}))` inside the `each()` argument
      //     re-creates every row on every render.
      //   - stamp on the WRONG row: the list reconciled by position, so rows
      //     swapped contents underneath their own DOM.
      // Note kerf keys rows by object identity, not by the `data-key`
      // attribute (that is the DOM diff's hint) — so making `data-key`
      // positional does NOT break this, and correctly still passes.
      const survivor = before[Math.min(3, before.length - 1)];
      await page.evaluate((k) => {
        const n = document.querySelector(`[data-key="${CSS.escape(k)}"]`) as HTMLElement | null;
        if (n != null) n.dataset.probe = "kept";
      }, survivor);
      await pick("sort", 1);
      const reordered = await keys();
      expect(reordered.length).toBe(before.length);
      const stampedKey = await page.evaluate(() =>
        (document.querySelector('[data-probe="kept"]') as HTMLElement | null)?.dataset.key ?? null);
      expect(
        stampedKey,
        "the stamped row did not survive the reorder intact: `null` means the list REBUILT its rows "
        + "(row focus/scroll/IME state is discarded); a different key means it reconciled by POSITION "
        + "(rows swapped contents under their own DOM)",
      ).toBe(survivor);

      // Widen then restore the filter: the list must round-trip to the same set.
      await pick("filter", 1);
      const widened = await keys();
      expect(widened.length, "widening the filter did not add rows").toBeGreaterThan(reordered.length);
      await pick("filter", 0);
      const restored = await keys();
      expect([...restored].sort()).toEqual([...reordered].sort());
      expect(new Set(restored).size, "duplicate data-keys after filter round-trip").toBe(restored.length);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 180_000);

  it("scrubber UI: delegate → signal → bound attribute/value round-trips", async () => {
    const svg = resolve(ROOT, "examples/animate/overlay-window/overlay-window.svg");
    const started = await startServer("src/cli/scrubber.ts", [svg]);
    expect(started, "scrubber failed to start").not.toBeNull();
    servers.push(started!.proc);
    const page = await browser!.newPage();
    const errors = watchErrors(page);
    try {
      await page.goto(started!.url, { waitUntil: "networkidle" });
      await page.waitForSelector('[data-action="scrub"]:not([disabled])', { timeout: 20_000 });

      // A bound attribute driven by a signal the click handler flips.
      const label = (): Promise<string | null> => page.locator('[data-action="play"]').getAttribute("aria-label");
      const paused = await label();
      await page.locator('[data-action="play"]').click();
      await page.waitForTimeout(400);
      expect(await label(), "play toggle did not update its bound aria-label").not.toBe(paused);
      await page.locator('[data-action="play"]').click();
      await page.waitForTimeout(200);

      // delegate() → signal → a DIFFERENT element's bound value: scrub to 60%,
      // then mark the in-point and read it back off the number input.
      await page.locator('[data-action="scrub"]').evaluate((el) => {
        (el as HTMLInputElement).value = "600";
        el.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await page.waitForTimeout(400);
      const inBefore = await page.locator('[data-action="inn"]').inputValue();
      await page.locator('[data-action="setin"]').click();
      await page.waitForTimeout(400);
      const inAfter = await page.locator('[data-action="inn"]').inputValue();
      expect(Number(inAfter), "marking In did not propagate to the bound range-start input").toBeGreaterThan(Number(inBefore));

      await page.locator('[data-action="resetrange"]').click();
      await page.waitForTimeout(400);
      expect(await page.locator('[data-action="inn"]').inputValue()).toBe(inBefore);

      // A structural re-render (the render function reads this signal's .value).
      const pressed = await page.locator('[data-action="croptoggle"]').getAttribute("aria-pressed");
      await page.locator('[data-action="croptoggle"]').click();
      await page.waitForTimeout(300);
      expect(await page.locator('[data-action="croptoggle"]').getAttribute("aria-pressed")).not.toBe(pressed);

      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 180_000);
});
