/**
 * Decide the `@supports` conditions of every captured `<img>` SVG's own sheets
 * with the page's Chromium, while the page is alive.
 *
 * Runs Node-side after the tree is captured: the SVG source is resolved the
 * way the renderer resolves it (`resolveSvgSource`), its conditions are
 * collected, and one `page.evaluate` decides them all. The page answers as an
 * `@supports` rule would: the prelude must parse as an at-rule prelude
 * (`CSSParserImpl::ConsumeSupportsRule` drops a rule whose condition fails to
 * parse, core/css/parser/css_parser_impl.cc:1441-1451, chromium 7d859f27), and
 * a parsed condition is then evaluated by `CSS.supports(conditionText)`, which
 * runs the same `CSSSupportsParser::ConsumeSupportsCondition` on the
 * parenthesized text (`CSSParser::ParseSupportsCondition`,
 * core/css/parser/css_parser.cc:371-394). `CSS.supports` alone would accept a
 * bare declaration (`display: grid`) that an `@supports` prelude rejects,
 * which is why the at-rule parse comes first. A source that cannot be resolved
 * yet (a remote SVG not embedded) records nothing, and the renderer leaves its
 * `@supports` blocks undecided as before.
 */
import type { Page } from "@playwright/test";
import { resolveSvgSource } from "./embed.js";
import type { CapturedElement } from "./types.js";
import { collectImageSupportsConditions, type ImageSupportsCondition } from "../render/svg-image-supports.js";
import { resolveSvgImageCssImports } from "../render/svg-image-css-import.js";
import { forEachElement } from "../tree-ops/for-each-element.js";
import { captureImageSvgFonts } from "./image-svg-fonts.js";

export async function captureImageSvgSupports(page: Page, tree: CapturedElement[]): Promise<void> {
  const pending: Array<{ el: CapturedElement; conditions: ImageSupportsCondition[] }> = [];
  forEachElement(tree, (el) => {
    if (el.imageSrc == null || el.imageSvgSupports != null) return;
    const svg = resolveSvgSource(el.imageSrc);
    if (svg == null) return;
    const expanded = resolveSvgImageCssImports(svg, true);
    if (expanded == null) return;
    const conditions = collectImageSupportsConditions(expanded);
    if (conditions.length > 0) pending.push({ el, conditions });
  });
  await captureImageSvgFonts(page, tree);
  if (pending.length === 0) return;
  const texts = [...new Set(pending.flatMap(({ conditions }) => conditions.map((c) => c.condition)))];
  const answers = await page.evaluate(
    (list: string[]) =>
      list.map((condition) => {
        try {
          const sheet = new CSSStyleSheet();
          sheet.replaceSync(`@supports ${condition} {}`);
          return sheet.cssRules.length === 1 && CSS.supports(condition);
        } catch {
          return false;
        }
      }),
    texts,
  );
  const byText = new Map(texts.map((text, i) => [text, answers[i] === true]));
  for (const { el, conditions } of pending) {
    el.imageSvgSupports = Object.fromEntries(conditions.map((c) => [c.key, byText.get(c.condition) === true]));
  }
}
