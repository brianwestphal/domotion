/**
 * DM-2401: ordered macOS ideograph fallback-cache oracle.
 *
 * Records Chromium's selected PostScript face for U+4E9F in isolation, after
 * U+3400 in the same document, and after a same-page navigation. The Domotion
 * arm asks the production resolver in matching transient/named renderer scopes.
 * No expected font name is embedded: the host CoreText inventory owns it.
 */
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";

import {
  __resolveSystemFallbackKeyForCpForTest,
  beginCharacterFallbackDocument,
  clearCharacterFallbackRendererScopesForTest,
  createFontRendererSession,
  endCharacterFallbackDocument,
  resolveFontKey,
  resolveFontSpec,
  withFontRendererSession,
} from "../src/render/font-resolution.js";

const EXT_A = 0x3400;
const TARGET = 0x4e9f;
const DENSE_EXT_A = Array.from({ length: 32 }, (_, i) => EXT_A + i);
const CSS = "font-family:serif;font-size:16px;font-weight:800";

interface Row {
  scenario: string;
  chromiumPostScript: string | null;
  domotionKey: string | null;
  domotionPostScript: string | null;
}

async function selectedPostScript(page: Page, selector: string): Promise<string | null> {
  const session = await page.context().newCDPSession(page);
  try {
    await Promise.all([session.send("DOM.enable"), session.send("CSS.enable")]);
    const { root } = await session.send("DOM.getDocument");
    const { nodeId } = await session.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    const { fonts } = await session.send("CSS.getPlatformFontsForNode", { nodeId });
    return fonts.find((font: { glyphCount: number }) => font.glyphCount > 0)?.postScriptName ?? null;
  } finally {
    await session.detach();
  }
}

async function freshContext(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

function domotionAsk(cp: number): string | null {
  return __resolveSystemFallbackKeyForCpForTest(cp, 800, 0, 16, resolveFontKey("serif"));
}

function row(scenario: string, chromiumPostScript: string | null, domotionKey: string | null): Row {
  return {
    scenario,
    chromiumPostScript,
    domotionKey,
    domotionPostScript: domotionKey == null ? null : resolveFontSpec(domotionKey)?.postscriptName ?? null,
  };
}

async function main(): Promise<void> {
  const disabledArm = process.argv.includes("--disabled-arm");
  if (process.platform !== "darwin") throw new Error("This oracle targets Chromium/CoreText on macOS");
  const rows: Row[] = [];
  const isolatedBrowser = await chromium.launch({ headless: true });
  try {
    clearCharacterFallbackRendererScopesForTest();

    const isolated = await freshContext(isolatedBrowser);
    await isolated.page.setContent(`<span id="target" style="${CSS}">${String.fromCodePoint(TARGET)}</span>`);
    beginCharacterFallbackDocument();
    const isolatedKey = domotionAsk(TARGET);
    endCharacterFallbackDocument();
    rows.push(row("fresh-renderer isolated target", await selectedPostScript(isolated.page, "#target"), isolatedKey));
    await isolated.context.close();
    await isolatedBrowser.close();

    const browser = await chromium.launch({ headless: true });
    const ordered = await freshContext(browser);
    await ordered.page.setContent(`<span id="seed" style="${CSS}">${String.fromCodePoint(...DENSE_EXT_A)}</span><span id="target" style="${CSS}">${String.fromCodePoint(TARGET)}</span>`);
    const rendererSession = createFontRendererSession();
    const orderedKey = withFontRendererSession(rendererSession, () => {
      beginCharacterFallbackDocument();
      try {
        for (const cp of DENSE_EXT_A) domotionAsk(cp);
        return domotionAsk(TARGET);
      }
      finally { endCharacterFallbackDocument(); }
    });
    rows.push(row("same-renderer ordered sequence", await selectedPostScript(ordered.page, "#target"), orderedKey));

    // setContent navigates the same Page. Re-select the explicit renderer id;
    // production state must survive exactly this boundary.
    await ordered.page.setContent(`<span id="target" style="${CSS}">${String.fromCodePoint(TARGET)}</span>`);
    const navigationKey = withFontRendererSession(rendererSession, () => {
      beginCharacterFallbackDocument();
      try { return domotionAsk(TARGET); }
      finally { endCharacterFallbackDocument(); }
    });
    rows.push(row("same-renderer navigation", await selectedPostScript(ordered.page, "#target"), navigationKey));
    await ordered.context.close();
    await browser.close();

    const activation = {
      chromiumSequenceMoved: rows[0].chromiumPostScript !== rows[1].chromiumPostScript,
      domotionSequenceMoved: rows[0].domotionKey !== rows[1].domotionKey,
      domotionNavigationReused: rows[1].domotionKey === rows[2].domotionKey,
    };
    const enabledOkay = activation.chromiumSequenceMoved && activation.domotionSequenceMoved && activation.domotionNavigationReused;
    const disabledOkay = activation.chromiumSequenceMoved && !activation.domotionSequenceMoved && activation.domotionNavigationReused;
    if ((!disabledArm && !enabledOkay) || (disabledArm && !disabledOkay)) {
      throw new Error(`Ideograph fallback-cache oracle mismatch: ${JSON.stringify({ rows, activation })}`);
    }
    const result: Record<string, unknown> = {
      sourceRevision: "7d859f271cbda744098ac69f44978d4edfa62be3",
      platform: process.platform,
      rows,
      activation,
    };
    if (!disabledArm) {
      const child = spawnSync(process.execPath, ["--import", "tsx", import.meta.filename, "--disabled-arm"], {
        encoding: "utf8",
        env: { ...process.env, DOMOTION_MAC_CHAR_FALLBACK_CACHE: "0" },
      });
      if (child.status !== 0) throw new Error(`Disabled cache arm failed:\n${child.stderr}`);
      result.disabledArm = JSON.parse(child.stdout) as unknown;
    }
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await isolatedBrowser.close().catch(() => {});
  }
}

await main();
