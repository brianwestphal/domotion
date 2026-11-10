import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { chromium, expect as browserExpect, type Browser, type Page } from "@playwright/test";
import { startBrowserCoverage, writeBrowserCoverage } from "../src/test-support/browser-coverage.js";
import { startReviewServer } from "../src/review/server.js";
import { startStudioServer } from "../src/studio/server.js";
import { chooseKerfSelectOption, kerfSelectOptionValues, kerfSelectValue } from "../src/test-support/kerf-select.js";
import { startOwnedUiServer, type OwnedUiServer } from "./owned-ui-server.js";
import { expectedNativeClipboardText } from "./native-clipboard-text.js";

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

/** Keep the existing startup limit while owning the actual Node service. */
function startServer(script: string, args: string[], env?: NodeJS.ProcessEnv): Promise<OwnedUiServer> {
  return startOwnedUiServer(script, args, { cwd: ROOT, env });
}

/** Collect page errors so a silently-broken reactive path can't pass. */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
  });
  return errors;
}

/**
 * DM-QW1NMD: each UI renders `@kerfjs/ui` components whose stylesheet is
 * delivered out of band (inlined by the server, or prepended to `<head>` by
 * the pre-built bundle). Assert one package-owned computed style so a broken
 * CSS pipeline fails here instead of shipping unstyled markup, and that the
 * page pins the dark color scheme over the package's `light dark` default.
 */
async function expectKerfUiStyled(page: Page, selector: string, property: string, expected: string): Promise<void> {
  const actual = await page
    .locator(selector)
    .first()
    .evaluate((el, prop) => getComputedStyle(el).getPropertyValue(prop), property);
  expect(actual, `${selector} is missing @kerfjs/ui styling`).toBe(expected);
  const scheme = await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
  expect(scheme, "page must pin color-scheme: dark over the kerf-ui foundation").toBe("dark");
}

let browser: Browser | null = null;
const servers: OwnedUiServer[] = [];
afterAll(async () => {
  const owned = servers.splice(0);
  const results = await Promise.allSettled([...owned.map((server) => server.close()), browser?.close()]);
  const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
  try {
    const directory = resolve(process.env["DOMOTION_OUTPUT_DIR"] ?? "tests/output", "owned-ui-server");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "client-processes.json"),
      JSON.stringify(
        {
          node: process.version,
          platform: process.platform,
          servers: owned.map((server) => ({ url: server.url, diagnostics: server.diagnostics() })),
        },
        null,
        2,
      ),
    );
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) throw new AggregateError(errors, "Owned UI cleanup failed");
}, 20_000);

try {
  browser = await chromium.launch({ headless: true });
} catch {
  browser = null;
}
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
  // So the manifest is SYNTHESIZED. The review server already honors
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
    join(fixtureRoot, "alpha-fixture.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
  );
  writeFileSync(
    join(fixtureRoot, "features-results.json"),
    JSON.stringify({
      suite: "features",
      generatedAt: new Date(0).toISOString(),
      results: [
        { name: "alpha-fixture", pass: true, diffPct: 0.01, worstTilePct: 0.1, regionCount: 0, verdict: "clean" },
        { name: "bravo-fixture", pass: false, diffPct: 1.2, worstTilePct: 4.0, regionCount: 3, verdict: "major" },
        { name: "charlie-fixture", pass: true, diffPct: 0.05, worstTilePct: 0.3, regionCount: 0, verdict: "clean" },
        { name: "delta-fixture", pass: false, diffPct: 0.4, worstTilePct: 1.1, regionCount: 1, verdict: "minor" },
      ],
    }),
  );
  writeFileSync(
    join(fixtureRoot, "stage-evidence.json"),
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date(0).toISOString(),
      sourceRevision: "fixture-revision",
      platform: process.platform,
      environmentFingerprint: { platform: process.platform, fingerprint: "fixture-fingerprint" },
      reports: [{ area: "paint", oracle: "tools/paint-oracle.ts", status: "passed", passedRows: 4, totalRows: 4 }],
      rules: [{ suites: ["features"], fixture: "bravo-fixture", transitionIds: ["box.paint"], areas: ["paint"] }],
    }),
  );

  it("review UI: each() reconciles across reorder and filter, preserving row identity", async () => {
    const started = await startServer("tests/review-server.tsx", ["--port", "0"], {
      REVIEW_OUTPUT_DIR: fixtureRoot,
      REVIEW_NO_OPEN: "1",
    });
    expect(started, "review server failed to start").not.toBeNull();
    servers.push(started!);
    const page = await browser!.newPage();
    const coverage = await startBrowserCoverage(page);
    const errors = watchErrors(page);
    try {
      await page.goto(started!.url, { waitUntil: "networkidle" });
      await page.waitForSelector("[data-key]", { timeout: 20_000 });
      // The SSR'd @kerfjs/ui Toolbar must arrive with the package stylesheet
      // (inlined by the server), not as unstyled markup.
      await expectKerfUiStyled(page, ".kui-toolbar", "display", "grid");
      const keys = (): Promise<string[]> =>
        page.$$eval("[data-key]", (ns) => ns.map((n) => (n as HTMLElement).dataset.key!));
      // The filter / suite / sort controls are kerf-ui Selects (control →
      // state: choosing an option drives the list signals).
      const pick = async (name: string, i: number): Promise<void> => {
        const select = page.locator(`kui-select[name=${name}]`);
        const opts = await kerfSelectOptionValues(select);
        await chooseKerfSelectOption(select, opts[i]!);
        expect(await kerfSelectValue(select)).toBe(opts[i]);
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
      await expect
        .poll(() => firstCard.locator(".status-msg").textContent())
        .toContain("Choose a logical-stage classification");
      const rejected = await page.request.post(`${started!.url}/api/file-ticket`, {
        data: { source: "local", suite: "features", name: "bravo-fixture", comment: "evidence", regions: [] },
      });
      expect(rejected.status()).toBe(400);
      expect(((await rejected.json()) as { error: string }).error).toContain("Invalid logical-stage classification");

      await chooseKerfSelectOption(firstCard.locator("kui-select.logical-classification"), "logical-defect");
      expect(await kerfSelectValue(firstCard.locator("kui-select.logical-classification"))).toBe("logical-defect");
      const bravoCard = page.locator('.card[data-name="bravo-fixture"]');
      await expect.poll(() => bravoCard.locator(".stage-evidence").textContent()).toContain("box.paint");
      await chooseKerfSelectOption(bravoCard.locator("kui-select.logical-classification"), "paint-compositing");
      // State → control: the persisted classification is rendered back into
      // the Select after a reload.
      await page.reload({ waitUntil: "networkidle" });
      await expect
        .poll(() => kerfSelectValue(page.locator('.card[data-name="bravo-fixture"] kui-select.logical-classification')))
        .toBe("paint-compositing");

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
      const stampedKey = await page.evaluate(
        () => (document.querySelector('[data-probe="kept"]') as HTMLElement | null)?.dataset.key ?? null,
      );
      expect(
        stampedKey,
        "the stamped row did not survive the reorder intact: `null` means the list REBUILT its rows " +
          "(row focus/scroll/IME state is discarded); a different key means it reconciled by POSITION " +
          "(rows swapped contents under their own DOM)",
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
      await writeBrowserCoverage(page, "review-harness-client", coverage);
      await page.close();
    }
  }, 180_000);

  it("production review client executes through its source-mapped browser bundle", async () => {
    const server = await startReviewServer({
      expectedPng: join(fixtureRoot, "alpha-fixture-expected.png"),
      actualPng: join(fixtureRoot, "alpha-fixture-actual.png"),
      diffPng: join(fixtureRoot, "alpha-fixture-diff.png"),
      actualSvg: join(fixtureRoot, "alpha-fixture.svg"),
      label: "coverage-fixture",
    });
    const page = await browser!.newPage();
    const coverage = await startBrowserCoverage(page);
    try {
      await page.goto(server.url, { waitUntil: "networkidle" });
      await expect.poll(() => page.locator("#issue-text").inputValue()).toContain("coverage-fixture");
      // DM-964DQM: the visible heading must name the actual readonly editor.
      const editor = page.locator("#issue-text");
      await browserExpect(editor).toHaveAccessibleName("GitHub issue text");
      expect(await page.getByRole("textbox", { name: "GitHub issue text", exact: true }).count()).toBe(1);
      const markdown = await editor.inputValue();
      expect(await editor.isEditable()).toBe(false);
      await editor.focus();
      await page.keyboard.press("ControlOrMeta+A");
      expect(
        await editor.evaluate((element) => {
          const field = element as HTMLTextAreaElement;
          return field.selectionEnd - field.selectionStart;
        }),
      ).toBe(markdown.length);
      await page.keyboard.type("readonly content must stay unchanged");
      expect(await editor.inputValue()).toBe(markdown);
      await page
        .context()
        .grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(server.url).origin });
      await page.getByRole("button", { name: "Copy issue text", exact: true }).click();
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe(expectedNativeClipboardText(markdown, process.platform));
      // The empty region list is a client-rendered kerf-ui EmptyState whose
      // CSS arrives through the bundle's <head> prologue.
      await expectKerfUiStyled(page, ".region-list .kui-empty-state", "display", "grid");
      expect(await page.locator("style[data-kerf-ui]").count(), "one kerf-ui stylesheet").toBe(1);
    } finally {
      await writeBrowserCoverage(page, "review-client", coverage);
      await page.close();
      await server.close();
    }
  });

  it("scrubber UI: delegate → signal → bound attribute/value round-trips", async () => {
    const svg = resolve(ROOT, "examples/animate/overlay-window/overlay-window.svg");
    const started = await startServer("src/cli/scrubber.ts", [svg, "--no-open"]);
    expect(started, "scrubber failed to start").not.toBeNull();
    servers.push(started!);
    const page = await browser!.newPage();
    const coverage = await startBrowserCoverage(page);
    const errors = watchErrors(page);
    try {
      await page.goto(started!.url, { waitUntil: "networkidle" });
      await page.waitForSelector('[data-action="scrub"]:not([disabled])', { timeout: 20_000 });
      // The transport is a kerf-ui ToolbarControlGroup; its CSS rides in the
      // pre-built bundle's <head> prologue.
      // (Not `display`: as a flex item of the bar row it is blockified to `flex`.)
      await expectKerfUiStyled(page, ".transport.kui-toolbar-control-group", "border-top-left-radius", "22px");

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
      expect(Number(inAfter), "marking In did not propagate to the bound range-start input").toBeGreaterThan(
        Number(inBefore),
      );

      await page.locator('[data-action="resetrange"]').click();
      await page.waitForTimeout(400);
      expect(await page.locator('[data-action="inn"]').inputValue()).toBe(inBefore);

      // A structural re-render (the render function reads this signal's .value).
      const pressed = await page.locator('[data-action="croptoggle"]').getAttribute("aria-pressed");
      await page.locator('[data-action="croptoggle"]').click();
      await page.waitForTimeout(300);
      expect(await page.locator('[data-action="croptoggle"]').getAttribute("aria-pressed")).not.toBe(pressed);

      // kerf-ui Selects, in both directions.
      const zoomSelect = page.locator("kui-select[name=zoompreset]");
      const zoomText = (): Promise<string> => zoomSelect.locator("[role=combobox]").innerText();
      // Control → state: picking 100% then 200% doubles the rendered SVG.
      const svgWidth = async (): Promise<number> => (await page.locator(".svg-host > svg").boundingBox())!.width;
      await chooseKerfSelectOption(zoomSelect, "1");
      await page.waitForTimeout(200);
      const at100 = await svgWidth();
      await chooseKerfSelectOption(zoomSelect, "2");
      await page.waitForTimeout(200);
      expect(await kerfSelectValue(zoomSelect)).toBe("2");
      expect((await svgWidth()) / at100).toBeCloseTo(2, 1);
      // State → control: the zoom-in button (not the Select) sets 250%, which
      // is no preset, so the Select grows a "custom" choice and shows it.
      await page.locator('[data-action="zoomin"]').click();
      await expect.poll(() => kerfSelectValue(zoomSelect)).toBe("custom");
      expect(await zoomText()).toContain("250%");
      // "Fit" is an action, not a level: the Select then shows the level it chose.
      await chooseKerfSelectOption(zoomSelect, "fit");
      await page.waitForTimeout(200);
      expect(await kerfSelectValue(zoomSelect)).not.toBe("fit");
      expect(await zoomText()).toMatch(/\d+%/);

      // Crop aspect: control → state while crop mode is on, then the crop
      // toggle (state) resets the lock and disables the control.
      const aspectSelect = page.locator("kui-select[name=cropaspect]");
      if ((await page.locator('[data-action="croptoggle"]').getAttribute("aria-pressed")) !== "true") {
        await page.locator('[data-action="croptoggle"]').click();
      }
      await chooseKerfSelectOption(aspectSelect, "1");
      expect(await kerfSelectValue(aspectSelect)).toBe("1");
      await page.locator('[data-action="croptoggle"]').click();
      await expect.poll(() => kerfSelectValue(aspectSelect)).toBe("free");
      expect(await aspectSelect.locator("[role=combobox]").isDisabled()).toBe(true);

      // Speed: control → state → control (the render re-derives the value).
      const speedSelect = page.locator("kui-select[name=speed]");
      await chooseKerfSelectOption(speedSelect, "2");
      await page.locator('[data-action="play"]').click();
      await page.waitForTimeout(150);
      await page.locator('[data-action="play"]').click();
      expect(await kerfSelectValue(speedSelect)).toBe("2");
      expect(await speedSelect.locator("[role=combobox]").innerText()).toContain("2x");

      expect(errors).toEqual([]);
    } finally {
      await writeBrowserCoverage(page, "scrubber-client", coverage);
      await page.close();
    }
  }, 180_000);

  // Every tool page must stay self-contained and offline. kerf-ui Selects draw
  // their caret and check icons as inline SVG; Web Awesome (whose default icon
  // library fetches from the Font Awesome CDN) is not used. Load each UI, open
  // a Select and choose an option, and require that no request leaves the
  // local server.
  it("no UI makes a request off localhost while loading or using a Select", async () => {
    const offHost: string[] = [];
    const watchRequests = (page: Page, ui: string): void => {
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (["data:", "blob:", "about:"].includes(url.protocol)) return;
        if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) offHost.push(`${ui}: ${request.url()}`);
      });
    };
    const exercise = async (ui: string, url: string, ready: string, selectName: string | null): Promise<void> => {
      const page = await browser!.newPage();
      watchRequests(page, ui);
      try {
        await page.goto(url, { waitUntil: "networkidle" });
        await page.waitForSelector(ready, { timeout: 30_000 });
        if (selectName != null) {
          const select = page.locator(`kui-select[name=${selectName}]`).first();
          const values = await kerfSelectOptionValues(select);
          const target = values.find((v) => v !== "") ?? values[0]!;
          await chooseKerfSelectOption(select, target);
          await page.waitForLoadState("networkidle");
        }
      } finally {
        await page.close();
      }
    };

    const harness = await startServer("tests/review-server.tsx", ["--port", "0"], {
      REVIEW_OUTPUT_DIR: fixtureRoot,
      REVIEW_NO_OPEN: "1",
    });
    expect(harness, "review server failed to start").not.toBeNull();
    servers.push(harness!);
    await exercise("demos:review", harness!.url, "[data-key]", "sort");

    const svg = resolve(ROOT, "examples/animate/overlay-window/overlay-window.svg");
    const scrubber = await startServer("src/cli/scrubber.ts", [svg, "--no-open"]);
    expect(scrubber, "scrubber failed to start").not.toBeNull();
    servers.push(scrubber!);
    await exercise("svg-scrubber", scrubber!.url, '[data-action="scrub"]:not([disabled])', "speed");

    const review = await startReviewServer({
      expectedPng: join(fixtureRoot, "alpha-fixture-expected.png"),
      actualPng: join(fixtureRoot, "alpha-fixture-actual.png"),
      diffPng: join(fixtureRoot, "alpha-fixture-diff.png"),
      actualSvg: join(fixtureRoot, "alpha-fixture.svg"),
      label: "network-fixture",
    });
    try {
      // svg-review renders no Select; it is still held to the offline contract.
      await exercise("svg-review", review.url, "#issue-text", null);
    } finally {
      await review.close();
    }

    const studio = await startStudioServer({
      workspaceRoot: ROOT,
      initialProjectPath: "tests/fixtures/studio/treatments-showcase.project.json",
    });
    try {
      await exercise("Studio", studio.url, "[data-scene-id]", "scene-fit");
    } finally {
      await studio.close();
    }

    expect(offHost).toEqual([]);
  }, 240_000);

  it("Studio Select uses the viewport when its page is scrolled", async () => {
    const studio = await startStudioServer({
      workspaceRoot: ROOT,
      initialProjectPath: "tests/fixtures/studio/treatments-showcase.project.json",
    });
    const page = await browser!.newPage({ viewport: { width: 1440, height: 1300 } });
    try {
      await page.goto(studio.url, { waitUntil: "networkidle" });
      const select = page.locator("kui-select[name=scene-transition]").first();
      const trigger = select.getByRole("combobox");
      await expect.poll(() => trigger.isVisible()).toBe(true);

      for (const { height, scrollY } of [
        { height: 1300, scrollY: 600 },
        { height: 900, scrollY: 727 },
      ]) {
        await page.setViewportSize({ width: 1440, height });
        await page.evaluate((y) => window.scrollTo(0, y), scrollY);
        await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(scrollY);
        // A DOM click preserves the requested scroll position; Playwright's
        // locator click would scroll the trigger into view first.
        await trigger.evaluate((el) => (el as HTMLButtonElement).click());
        const popup = select.locator(".kui-select__popup");
        await expect.poll(() => popup.isVisible()).toBe(true);
        const geometry = await popup.evaluate((el) => {
          const rect = el.getBoundingClientRect();
          return {
            top: rect.top,
            bottom: rect.bottom,
            height: rect.height,
            placement: el.getAttribute("data-placement"),
          };
        });
        expect(geometry.placement).toBe("bottom");
        expect(geometry.top).toBeGreaterThanOrEqual(0);
        expect(geometry.bottom).toBeLessThanOrEqual(height);
        expect(geometry.height).toBeGreaterThan(height === 1300 ? 500 : 350);
        await trigger.evaluate((el) => (el as HTMLButtonElement).click());
        await expect.poll(() => popup.isVisible()).toBe(false);
      }
    } finally {
      await page.close();
      await studio.close();
    }
  }, 120_000);

  it("scrubber reports an export server error without a blocking dialog", async () => {
    const svg = resolve(ROOT, "examples/animate/overlay-window/overlay-window.svg");
    const started = await startServer("src/cli/scrubber.ts", [svg, "--no-open"]);
    expect(started, "scrubber failed to start").not.toBeNull();
    servers.push(started!);
    const page = await browser!.newPage();
    const dialogs: string[] = [];
    page.on("dialog", (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    try {
      await page.route("**/export-frame", (route) =>
        route.fulfill({ status: 413, contentType: "text/html", body: "<html>Request too large</html>" }),
      );
      await page.goto(started!.url, { waitUntil: "networkidle" });
      await page.locator('[data-action="exporttoggle"]').click();
      await page.locator('[data-action="export-frame"]').click();
      await expect.poll(() => page.locator(".operation-status").textContent()).toContain("Request failed (413)");
      expect(dialogs).toEqual([]);
    } finally {
      await page.close();
    }
  }, 180_000);
});
