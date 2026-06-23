/**
 * Validate params against a template's schema and run its `render()` against a
 * fully wired `TemplateRenderContext`. `renderTemplateToSvg` is the convenience
 * entry the CLI uses: it owns a temp `workDir` + (optionally) the browser and
 * hands the template a `runAnimateConfig` bound to the existing pipeline.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "@playwright/test";
import {
  attachWebfontTracker,
  captureElementTree,
  discoverAndRegisterWebfonts,
  launchChromium,
} from "../capture/index.js";
import { clearEmbeddedFonts, clearWebfonts, elementTreeToSvgInner, wrapSvg } from "../render/index.js";
import { cullElementsOutsideViewBox } from "../tree-ops/index.js";
import { applyReadyWaits, loadInputIntoPage } from "../cli/common.js";
import { composeAnimateConfig, type AnimateConfig } from "../cli/animate.js";
import type { CaptureToSvgParams, Template, TemplateOutput, TemplateRenderContext } from "./types.js";

const MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)";

/** Plain single-frame capture of a page to a static SVG — the `domotion capture`
 *  recipe (load → settle → webfont registration → tree → glyph-path render),
 *  reused so a decorator template wraps real captured pixels. */
async function captureToSvg(
  browser: Browser,
  p: CaptureToSvgParams,
  log: (msg: string) => void,
): Promise<TemplateOutput> {
  const ctx = await browser.newContext({
    viewport: { width: p.width, height: p.height },
    isMobile: p.mobile === true,
    ...(p.mobile === true ? { userAgent: MOBILE_UA } : {}),
    ...(p.colorScheme != null ? { colorScheme: p.colorScheme } : {}),
  });
  try {
    const page = await ctx.newPage();
    page.setDefaultTimeout(90_000);
    page.setDefaultNavigationTimeout(90_000);
    const tracker = attachWebfontTracker(page);
    await loadInputIntoPage(page, p.input);
    await applyReadyWaits(page, { wait: p.wait ?? 200, waitFor: p.waitFor, fontsReady: true });
    clearWebfonts();
    await discoverAndRegisterWebfonts(page, tracker.urls);
    tracker.detach();
    const tree = await captureElementTree(page, p.selector ?? "body", {
      x: 0, y: 0, width: p.width, height: p.height,
    });
    cullElementsOutsideViewBox(tree, p.width, p.height, undefined, 0, 1);
    clearEmbeddedFonts();
    const inner = elementTreeToSvgInner(tree, p.width, p.height);
    log(`template capture: ${p.width}×${p.height} of ${p.input}`);
    return { svg: wrapSvg(inner, p.width, p.height), width: p.width, height: p.height };
  } finally {
    await ctx.close();
  }
}

/** Validate raw params against a template's zod schema, applying defaults. Throws
 *  a `template "<name>": …` error listing the offending paths on failure. */
export function validateTemplateParams<P>(template: Template<P>, raw: unknown): P {
  const result = template.paramsSchema.safeParse(raw);
  if (result.success) return result.data;
  const issues = result.error.issues
    .map((i) => `${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("; ");
  throw new Error(`template "${template.name}": invalid params — ${issues}`);
}

export interface RenderTemplateOptions {
  /** Reuse an existing browser (caller owns its lifecycle). When omitted, one is
   *  launched and closed around the render. */
  browser?: Browser;
  /** Progress logger. Default no-op. */
  log?: (msg: string) => void;
}

/**
 * Validate `rawParams`, then render `template` to an SVG. Sets up a throwaway
 * `workDir` (cleaned up afterward) and a `runAnimateConfig` bound to a shared
 * browser. The browser is launched/closed here unless one is passed in `opts`.
 */
export async function renderTemplateToSvg<P>(
  template: Template<P>,
  rawParams: unknown,
  opts: RenderTemplateOptions = {},
): Promise<TemplateOutput> {
  const params = validateTemplateParams(template, rawParams);
  const log = opts.log ?? ((): void => {});
  const ownsBrowser = opts.browser == null;
  const browser = opts.browser ?? (await launchChromium());
  const workDir = mkdtempSync(join(tmpdir(), `domotion-tmpl-${template.name}-`));
  try {
    const ctx: TemplateRenderContext = {
      browser,
      workDir,
      log,
      runAnimateConfig: (cfg: AnimateConfig, configDir?: string): Promise<string> =>
        composeAnimateConfig(browser, cfg, configDir ?? workDir, log),
      captureToSvg: (p: CaptureToSvgParams): Promise<TemplateOutput> => captureToSvg(browser, p, log),
    };
    return await template.render(params, ctx);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
    if (ownsBrowser) await browser.close();
  }
}
