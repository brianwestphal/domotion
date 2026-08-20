import { afterAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
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
async function startServer(
  script: string, args: string[], env?: NodeJS.ProcessEnv,
): Promise<{ proc: ChildProcess; url: string } | null> {
  const proc = spawn("npx", ["tsx", script, ...args], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
    ...(env != null ? { env: { ...process.env, ...env } } : {}),
  });
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
  // DM-1870: this test used to be gated on `tests/output/features-results.json`
  // existing, and SKIP when it did not. That directory is gitignored, so in any
  // fresh clone, worktree, or CI job that had not already run a visual suite the
  // manifest was absent and this file reported "1 passed | 1 skipped" — green,
  // and easy to read as "the guard passed" when `each()`, the keyed list
  // reconciler this file exists to exercise, had never run at all.
  //
  // That is the same shape of gap the file was created to close: a kerfjs
  // upgrade breaking every interactive path while the suite stayed green.
  //
  // So the manifest is SYNTHESISED. The review server already honours
  // `REVIEW_OUTPUT_DIR`, so a temp root plus a hand-written manifest makes this
  // self-contained and fast — no dependency on an ~8-minute visual suite having
  // been run first, and no production code touched.
  //
  // The rows are shaped for what the test DRIVES rather than for realism: four
  // of them, two distinct verdicts, and a spread of diffPct / regionCount, so
  // the sort and filter dropdowns each have more than one option and a reorder
  // actually reorders. A single-row or uniform manifest would let this pass
  // without reconciling anything — the same failure mode one level down.
  const fixtureRoot = mkdtempSync(join(tmpdir(), "kerf-review-"));
  // A 1x1 transparent PNG. The rows must have real image files behind them:
  // the page requests expected/actual/diff per row, and this test asserts on an
  // EMPTY console-error list, so a missing file would fail it as a 404 rather
  // than as a reconciler bug — noise that looks like signal.
  const PNG_1X1 = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  );
  for (const n of ["alpha-fixture", "bravo-fixture", "charlie-fixture", "delta-fixture"]) {
    for (const kind of ["expected", "actual", "diff"]) {
      writeFileSync(join(fixtureRoot, `${n}-${kind}.png`), PNG_1X1);
    }
  }
  writeFileSync(
    join(fixtureRoot, "features-results.json"),
    JSON.stringify({
      suite: "features",
      generatedAt: new Date(0).toISOString(),
      results: [
        { name: "alpha-fixture",   pass: true,  diffPct: 0.01, worstTilePct: 0.1, regionCount: 0, verdict: "clean" },
        { name: "bravo-fixture",   pass: false, diffPct: 1.20, worstTilePct: 4.0, regionCount: 3, verdict: "major" },
        { name: "charlie-fixture", pass: true,  diffPct: 0.05, worstTilePct: 0.3, regionCount: 0, verdict: "clean" },
        { name: "delta-fixture",   pass: false, diffPct: 0.40, worstTilePct: 1.1, regionCount: 1, verdict: "minor" },
      ],
    }),
  );
  writeFileSync(join(fixtureRoot, "stage-evidence.json"), JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date(0).toISOString(),
    sourceRevision: "fixture-revision",
    platform: process.platform,
    environmentFingerprint: { platform: process.platform, fingerprint: "fixture-fingerprint" },
    reports: [{ area: "paint", oracle: "tools/paint-oracle.ts", status: "passed", passedRows: 4, totalRows: 4 }],
    rules: [{ suites: ["features"], fixture: "bravo-fixture", transitionIds: ["box.paint"], areas: ["paint"] }],
  }));

  it("review UI: each() reconciles across reorder and filter, preserving row identity", async () => {
    const started = await startServer("tests/review-server.tsx", [], { REVIEW_OUTPUT_DIR: fixtureRoot });
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

      // Pixel scores cannot establish which pipeline stage caused a residual.
      // Filing is therefore guarded in both the browser and the server: the
      // UI refuses an unclassified card, while a direct request cannot bypass
      // the same contract.
      const firstCard = page.locator(".card").first();
      await firstCard.locator(".file-btn").click();
      await expect.poll(() => firstCard.locator(".status-msg").textContent()).toContain(
        "Choose a logical-stage classification",
      );
      const rejected = await page.request.post(`${started!.url}/api/file-ticket`, {
        data: { source: "local", suite: "features", name: "bravo-fixture", comment: "evidence", regions: [] },
      });
      expect(rejected.status()).toBe(400);
      expect((await rejected.json() as { error: string }).error).toContain("Invalid logical-stage classification");

      await firstCard.locator(".logical-classification").selectOption("logical-defect");
      expect(await firstCard.locator(".logical-classification").inputValue()).toBe("logical-defect");
      const bravoCard = page.locator('.card[data-name="bravo-fixture"]');
      await expect.poll(() => bravoCard.locator(".stage-evidence").textContent()).toContain("box.paint");
      await bravoCard.locator(".logical-classification").selectOption("paint-compositing");
      await page.reload({ waitUntil: "networkidle" });
      await expect.poll(() => page.locator('.card[data-name="bravo-fixture"] .logical-classification').inputValue()).toBe("paint-compositing");

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
