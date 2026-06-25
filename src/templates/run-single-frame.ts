import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Anims } from "../cli/animate.js";
import type { TemplateRenderContext, TemplateOutput } from "./types.js";

/**
 * Shared tail for the single-frame builtin generators. Writes the built HTML to
 * `<name>.html` in the work dir, runs it as ONE cut-transition frame with the
 * given animations, and returns the `TemplateOutput`. Extracted (DM-1371) from
 * the identical `writeFileSync` + `runAnimateConfig({ frames: [{ cut }] })` +
 * `return { svg, width, height, durationMs }` boilerplate that chat / subscribe /
 * lower-third / kinetic-text / chart / background-loop each repeated.
 */
export async function runSingleFrameGenerator(
  ctx: TemplateRenderContext,
  opts: { name: string; html: string; width: number; height: number; durationMs: number; animations: Anims },
): Promise<TemplateOutput> {
  const htmlPath = join(ctx.workDir, `${opts.name}.html`);
  writeFileSync(htmlPath, opts.html);
  const svg = await ctx.runAnimateConfig({
    width: opts.width,
    height: opts.height,
    frames: [
      {
        input: `${opts.name}.html`,
        duration: opts.durationMs,
        transition: { type: "cut", duration: 0 },
        animations: opts.animations,
      },
    ],
  });
  return { svg, width: opts.width, height: opts.height, durationMs: opts.durationMs };
}
