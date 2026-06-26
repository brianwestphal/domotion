import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// DM-1411: a scroll-landing demo shipped a fake placeholder "logo" (a `◐` glyph
// in a blue gradient box) instead of the official Domotion brand mark. Guard the
// example HTML fixtures so a non-official brand mark can't regress back in.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Every *.html under a directory (recursive), absolute paths. */
function htmlFiles(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === "output") continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...htmlFiles(p));
    else if (ent.name.endsWith(".html")) out.push(p);
  }
  return out;
}

describe("brand assets in example fixtures (DM-1411)", () => {
  const files = htmlFiles(resolve(ROOT, "examples"));

  it("finds example HTML fixtures to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("no example fixture uses the deprecated placeholder logo glyph (◐)", () => {
    const offenders = files.filter((f) => readFileSync(f, "utf8").includes("◐"));
    expect(offenders, `placeholder logo glyph found in: ${offenders.join(", ")}`).toEqual([]);
  });

  // A Domotion-branded mock page must carry the official brand mark, not a fake
  // box. scroll-landing is the one example styled as a Domotion landing page.
  it("the Domotion-branded scroll-landing fixture uses the official brand gradient mark", () => {
    const landing = readFileSync(resolve(ROOT, "examples/animate/scroll-landing/landing.html"), "utf8");
    const logoBlock = landing.slice(landing.indexOf('class="logo"'), landing.indexOf('class="logo"') + 600);
    expect(logoBlock).toContain("#8b5cf6");
    expect(logoBlock).toContain("#ec4899");
    expect(landing).not.toContain("#79b8ff");
  });
});
