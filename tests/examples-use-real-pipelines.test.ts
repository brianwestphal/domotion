/**
 * Guards that the shipped example scripts actually exercise the real Domotion
 * pipelines they claim to demonstrate, rather than hand-faking the look.
 *
 * Background: `examples/terminal-demo.ts` once hand-authored absolutely-positioned
 * `<div>`s on a dark slab to imitate a terminal — it never touched the
 * `domotion term` (`castToAnimatedSvg`) code path, so the shipped demo looked
 * out of place and proved nothing about the feature. These source-level
 * assertions catch a regression back to a hand-faked demo: the example must
 * import the terminal pipeline and must NOT reconstruct a terminal out of raw
 * positioned divs.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = resolve(HERE, "..", "examples");

describe("examples use the real pipelines they demonstrate", () => {
  it("terminal-demo.ts drives the domotion term pipeline (castToAnimatedSvg)", () => {
    const src = readFileSync(resolve(EXAMPLES, "terminal-demo.ts"), "utf8");

    // Must go through the real terminal backend, not fake the look.
    expect(src).toMatch(/from\s+["']\.\.\/src\/terminal\/index\.js["']/);
    expect(src).toMatch(/castToAnimatedSvg|castToTermFrames/);

    // Must consume an asciinema-style cast (the term pipeline's input contract).
    expect(src).toMatch(/version["']?\s*:\s*2/);

    // Regression guard: the old hand-faked implementation built terminal "lines"
    // as absolutely-positioned divs and never invoked the term pipeline.
    expect(src).not.toMatch(/buildTerminalHtml/);
    expect(src).not.toMatch(/position:\s*absolute[^]*top:\s*\$\{/);
  });
});
